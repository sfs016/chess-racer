// ─────────────────────────────────────────────────────────────────────────────
// Chess Race — SpacetimeDB server module
//
// Authoritative game server. All game state lives in tables; all mutations go
// through reducers (transactional, deterministic). Clients subscribe to tables
// and call reducers — there is no separate API server.
//
// Implemented: lobby (rooms/racers/lanes), authoritative slide movement with a
// cooldown, and a procedurally-generated track of walls + pawn mines.
// Still to come: quick-play + bots, items, deploy.
// ─────────────────────────────────────────────────────────────────────────────
import {
  schema,
  t,
  table,
  SenderError,
  type ReducerCtx,
  type InferSchema,
} from "spacetimedb/server";
import { Timestamp } from "spacetimedb";

// ── Constants ────────────────────────────────────────────────────────────────
// NOTE: a SpacetimeDB module may only export spacetime artifacts (reducers,
// lifecycle hooks, the default schema). Plain constants must stay un-exported.
const TRACK_COLS = 100; // race length; finish line is the last column
const TRACK_ROWS = 10; // lanes
const MAX_RACERS = 8; // human + bot cap per room
const VISION = 10; // how many columns ahead a racer can see / reach
const FINISH_COL = TRACK_COLS - 1; // landing here (or beyond) finishes the race
const MOVE_COOLDOWN_MICROS = 600_000n; // 0.6s between moves (PRD: 500–700ms)

const SAFE_COLS = 3; // columns near the start kept clear of hazards
const MINE_KNOCKBACK = 3; // tiles a triggered pawn mine knocks you back
const STUN_MICROS = 1_500_000n; // 1.5s stun after triggering a mine

const PIECES = ["rook", "knight", "bishop"] as const;
type Piece = (typeof PIECES)[number];

// Obstacle kinds (string `kind` column on `obstacle`):
//   "wall"      — blocks rook/bishop rays; knight jumps it; nobody lands on it
//   "pawn_mine" — landable (captured when landed on); threatens its two forward
//                 diagonals (mr±1, mc+1): landing there knocks you back + stuns

// Room lifecycle (string column on `room`): lobby -> countdown -> racing -> finished

// Room-code alphabet: no I/O/0/1 to avoid ambiguity when sharing codes.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

// ── Tables ───────────────────────────────────────────────────────────────────

// One row per active race room. `code` is the shareable room code.
const room = table(
  { name: "room", public: true },
  {
    code: t.string().primaryKey(),
    status: t.string(), // lobby | countdown | racing | finished
    seed: t.u32(), // PRNG seed for procedural track (used from M3 on)
    host: t.identity(), // who created the room (may start the race)
    createdAt: t.timestamp(),
    startedAt: t.timestamp().optional(),
  },
);

// One row per racer (human or, later, bot) currently in a room.
const racer = table(
  { name: "racer", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity().index("btree"), // owner; zero-identity for bots later
    roomCode: t.string().index("btree"),
    name: t.string(),
    piece: t.string(), // current piece (rook | knight | bishop | queen when promoted)
    row: t.u32(), // lane, 0..TRACK_ROWS-1
    col: t.u32(), // position along the track, 0..TRACK_COLS-1
    isBot: t.bool(),
    online: t.bool(),
    ready: t.bool(),
    finished: t.bool(),
    finishRank: t.u32(), // 0 until finished, then 1-based placement
    joinedAt: t.timestamp(),
    lastMoveAt: t.timestamp(), // for the per-move cooldown
    stunnedUntil: t.timestamp(), // mine stun; no moves until this time
  },
);

// One row per hazard tile on a room's procedurally-generated track.
const obstacle = table(
  { name: "obstacle", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    roomCode: t.string().index("btree"),
    row: t.u32(),
    col: t.u32(),
    kind: t.string(), // "wall" | "pawn_mine"
  },
);

const spacetimedb = schema({ room, racer, obstacle });
export default spacetimedb;

// Reducer context typed against this module's schema (gives us ctx.db.room etc).
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new SenderError("Name must not be empty");
  if (trimmed.length > 20)
    throw new SenderError("Name must be 20 characters or fewer");
  return trimmed;
}

function validatePiece(piece: string): Piece {
  if (!(PIECES as readonly string[]).includes(piece)) {
    throw new SenderError(`Invalid piece: ${piece}`);
  }
  return piece as Piece;
}

// Generate a room code that isn't currently in use. Reducers are deterministic,
// so randomness comes from ctx.random (seeded per call by the host).
function generateRoomCode(ctx: Ctx): string {
  for (let attempt = 0; attempt < 25; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code +=
        CODE_ALPHABET[ctx.random.integerInRange(0, CODE_ALPHABET.length - 1)];
    }
    if (!ctx.db.room.code.find(code)) return code;
  }
  throw new SenderError("Could not allocate a room code, please try again");
}

// Lowest unused lane in a room, or throw if the room is full.
function nextFreeLane(ctx: Ctx, code: string): number {
  const used = new Set(
    [...ctx.db.racer.roomCode.filter(code)].map((r) => r.row),
  );
  for (let row = 0; row < TRACK_ROWS; row++) {
    if (!used.has(row)) return row;
  }
  throw new SenderError("Room is full");
}

function racersInRoom(ctx: Ctx, code: string) {
  return [...ctx.db.racer.roomCode.filter(code)];
}

// Drop any racer rows the caller already owns (one active racer per identity).
function removeCallerRacers(ctx: Ctx) {
  for (const r of [...ctx.db.racer.identity.filter(ctx.sender)]) {
    ctx.db.racer.id.delete(r.id);
    cleanupRoomIfEmpty(ctx, r.roomCode);
  }
}

// Delete a room once nobody is left in it, so the lobby list stays tidy.
function cleanupRoomIfEmpty(ctx: Ctx, code: string) {
  if (racersInRoom(ctx, code).length === 0) {
    const r = ctx.db.room.code.find(code);
    if (r) ctx.db.room.code.delete(code);
  }
}

// ── Movement ─────────────────────────────────────────────────────────────────
// NOTE: keep legalTargets in sync with the client's src/game/moves.ts. The
// client uses it to highlight legal destinations; the server is the authority.

type Cell = { row: number; col: number };

// Per-tile blocker kind used by movement:
//   "wall"  — blocks a ray and cannot be landed on (knight jumps over it)
//   "racer" — blocks a ray and cannot be landed on (knight jumps over it)
//   "mine"  — can be landed on (captures it) but a ray cannot pass beyond it
type Blockers = Map<string, "wall" | "racer" | "mine">;

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

// All legal destination tiles for a piece given the blocker map. Movement is
// forward-only (col never decreases); rook/bishop slide along a ray until the
// first blocker or the edge of vision; knight jumps (only its landing matters).
function legalTargets(
  piece: string,
  fromRow: number,
  fromCol: number,
  blockers: Blockers,
): Cell[] {
  const targets: Cell[] = [];
  const maxCol = Math.min(fromCol + VISION, TRACK_COLS - 1);
  const inBounds = (r: number, c: number) =>
    r >= 0 && r < TRACK_ROWS && c >= 0 && c < TRACK_COLS;

  const slide = (dr: number, dc: number) => {
    let r = fromRow + dr;
    let c = fromCol + dc;
    while (inBounds(r, c) && c <= maxCol) {
      const blk = blockers.get(cellKey(r, c));
      if (blk === "mine") {
        targets.push({ row: r, col: c }); // can land (capture), but stops here
        break;
      }
      if (blk) break; // wall or racer: can't land, can't pass
      targets.push({ row: r, col: c });
      r += dr;
      c += dc;
    }
  };

  const isRook = piece === "rook" || piece === "queen";
  const isBishop = piece === "bishop" || piece === "queen";

  if (isRook) {
    slide(0, 1); // forward along the lane
    slide(1, 0); // vertical (same column, still within vision)
    slide(-1, 0);
  }
  if (isBishop) {
    slide(1, 1); // forward diagonals only (forward-only rule)
    slide(-1, 1);
  }
  if (piece === "knight") {
    // Forward L-jumps only (column delta > 0); jumps over blockers, so only the
    // landing tile matters — and you can't land on a wall or another racer.
    const ls = [
      { dr: 2, dc: 1 },
      { dr: -2, dc: 1 },
      { dr: 1, dc: 2 },
      { dr: -1, dc: 2 },
    ];
    for (const { dr, dc } of ls) {
      const r = fromRow + dr;
      const c = fromCol + dc;
      const blk = blockers.get(cellKey(r, c));
      if (inBounds(r, c) && c <= maxCol && blk !== "wall" && blk !== "racer") {
        targets.push({ row: r, col: c });
      }
    }
  }
  return targets;
}

// ── Procedural track ─────────────────────────────────────────────────────────

// Small deterministic PRNG so a room's stored `seed` always regenerates the
// same track (ctx.random can't be seeded by us).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate (or regenerate) the obstacle layout for a room from its seed. Phases
// follow the PRD: calm opening, contended midgame, high-pressure endgame. We
// never wall off more than (TRACK_ROWS - 4) lanes in a column, so every column
// stays passable.
function generateTrack(ctx: Ctx, code: string, seed: number) {
  for (const o of [...ctx.db.obstacle.roomCode.filter(code)]) {
    ctx.db.obstacle.id.delete(o.id);
  }

  const rng = mulberry32(seed);
  const used = new Set<string>();
  const place = (row: number, col: number, kind: string) => {
    const k = cellKey(row, col);
    if (used.has(k)) return;
    used.add(k);
    ctx.db.obstacle.insert({ id: 0n, roomCode: code, row, col, kind });
  };

  for (let col = SAFE_COLS; col < FINISH_COL; col++) {
    let wallChance: number, mineChance: number, maxWalls: number;
    if (col < 20) {
      wallChance = 0.12;
      mineChance = 0;
      maxWalls = 1;
    } else if (col < 65) {
      wallChance = 0.38;
      mineChance = 0.14;
      maxWalls = 2;
    } else {
      wallChance = 0.46;
      mineChance = 0.12;
      maxWalls = 3;
    }

    if (rng() < wallChance) {
      const count = 1 + Math.floor(rng() * maxWalls);
      for (let i = 0; i < count; i++) {
        if (countColumn(used, col) >= TRACK_ROWS - 4) break; // keep it passable
        place(Math.floor(rng() * TRACK_ROWS), col, "wall");
      }
    }
    if (rng() < mineChance) {
      place(Math.floor(rng() * TRACK_ROWS), col, "pawn_mine");
    }
  }
}

function countColumn(used: Set<string>, col: number): number {
  let n = 0;
  for (let row = 0; row < TRACK_ROWS; row++) {
    if (used.has(cellKey(row, col))) n++;
  }
  return n;
}

// ── Reducers ─────────────────────────────────────────────────────────────────

// Create a fresh room and seat the caller in it as host.
export const createRoom = spacetimedb.reducer(
  { name: t.string(), piece: t.string() },
  (ctx, { name, piece }) => {
    const cleanName = validateName(name);
    const cleanPiece = validatePiece(piece);

    // Leave any room the caller is already in before creating a new one.
    removeCallerRacers(ctx);

    const code = generateRoomCode(ctx);
    ctx.db.room.insert({
      code,
      status: "lobby",
      seed: ctx.random.integerInRange(1, 0x7fffffff),
      host: ctx.sender,
      createdAt: ctx.timestamp,
      startedAt: undefined,
    });

    ctx.db.racer.insert({
      id: 0n,
      identity: ctx.sender,
      roomCode: code,
      name: cleanName,
      piece: cleanPiece,
      row: 0,
      col: 0,
      isBot: false,
      online: true,
      ready: false,
      finished: false,
      finishRank: 0,
      joinedAt: ctx.timestamp,
      lastMoveAt: ctx.timestamp,
      stunnedUntil: ctx.timestamp,
    });
  },
);

// Join an existing room in its lobby phase.
export const joinRoom = spacetimedb.reducer(
  { code: t.string(), name: t.string(), piece: t.string() },
  (ctx, { code, name, piece }) => {
    const cleanName = validateName(name);
    const cleanPiece = validatePiece(piece);

    const room = ctx.db.room.code.find(code);
    if (!room) throw new SenderError(`No room with code ${code}`);
    if (room.status !== "lobby")
      throw new SenderError("Race has already started");
    if (racersInRoom(ctx, code).length >= MAX_RACERS)
      throw new SenderError("Room is full");

    removeCallerRacers(ctx);
    const lane = nextFreeLane(ctx, code);

    ctx.db.racer.insert({
      id: 0n,
      identity: ctx.sender,
      roomCode: code,
      name: cleanName,
      piece: cleanPiece,
      row: lane,
      col: 0,
      isBot: false,
      online: true,
      ready: false,
      finished: false,
      finishRank: 0,
      joinedAt: ctx.timestamp,
      lastMoveAt: ctx.timestamp,
      stunnedUntil: ctx.timestamp,
    });
  },
);

// Change piece while still in the lobby.
export const setPiece = spacetimedb.reducer(
  { piece: t.string() },
  (ctx, { piece }) => {
    const cleanPiece = validatePiece(piece);
    const mine = [...ctx.db.racer.identity.filter(ctx.sender)][0];
    if (!mine) throw new SenderError("You are not in a room");
    const room = ctx.db.room.code.find(mine.roomCode);
    if (room && room.status !== "lobby")
      throw new SenderError("Race already started");
    ctx.db.racer.id.update({ ...mine, piece: cleanPiece });
  },
);

// Toggle the caller's ready flag in the lobby.
export const setReady = spacetimedb.reducer(
  { ready: t.bool() },
  (ctx, { ready }) => {
    const mine = [...ctx.db.racer.identity.filter(ctx.sender)][0];
    if (!mine) throw new SenderError("You are not in a room");
    ctx.db.racer.id.update({ ...mine, ready });
  },
);

// Host starts the race. Resets everyone to the starting line.
export const startRace = spacetimedb.reducer(
  { code: t.string() },
  (ctx, { code }) => {
    const room = ctx.db.room.code.find(code);
    if (!room) throw new SenderError(`No room with code ${code}`);
    if (!room.host.equals(ctx.sender))
      throw new SenderError("Only the host can start the race");
    if (room.status !== "lobby") throw new SenderError("Race already started");

    generateTrack(ctx, code, room.seed);

    for (const r of racersInRoom(ctx, code)) {
      ctx.db.racer.id.update({
        ...r,
        col: 0,
        finished: false,
        finishRank: 0,
        lastMoveAt: ctx.timestamp, // cooldown counts from the start
        stunnedUntil: ctx.timestamp,
      });
    }
    ctx.db.room.code.update({
      ...room,
      status: "racing",
      startedAt: ctx.timestamp,
    });
  },
);

// Submit a move to a chosen destination tile. The server re-validates that the
// tile is a legal slide/jump target for the caller's piece (given walls, mines,
// and other racers), enforces the cooldown and mine stun, applies mine effects,
// and resolves contested tiles by reducer order (the second racer to claim a
// tile finds it occupied and is rejected).
export const submitMove = spacetimedb.reducer(
  { toRow: t.u32(), toCol: t.u32() },
  (ctx, { toRow, toCol }) => {
    const me = [...ctx.db.racer.identity.filter(ctx.sender)][0];
    if (!me) throw new SenderError("You are not in a room");
    const room = ctx.db.room.code.find(me.roomCode);
    if (!room) throw new SenderError("Room not found");
    if (room.status !== "racing")
      throw new SenderError("Race is not in progress");
    if (me.finished) throw new SenderError("You have already finished");

    const nowMicros = ctx.timestamp.microsSinceUnixEpoch;
    if (nowMicros < me.stunnedUntil.microsSinceUnixEpoch)
      throw new SenderError("You are stunned");
    if (nowMicros - me.lastMoveAt.microsSinceUnixEpoch < MOVE_COOLDOWN_MICROS)
      throw new SenderError("Move is on cooldown");

    // Build the blocker map: walls + mines from the track, plus other racers.
    const obstacles = [...ctx.db.obstacle.roomCode.filter(me.roomCode)];
    const blockers: Blockers = new Map();
    for (const o of obstacles) {
      blockers.set(cellKey(o.row, o.col), o.kind === "wall" ? "wall" : "mine");
    }
    for (const r of ctx.db.racer.roomCode.filter(me.roomCode)) {
      if (r.id !== me.id && !r.finished)
        blockers.set(cellKey(r.row, r.col), "racer");
    }

    const legal = legalTargets(me.piece, me.row, me.col, blockers);
    if (!legal.some((c) => c.row === toRow && c.col === toCol)) {
      throw new SenderError("Illegal move");
    }

    // Resolve mine interactions at the landing tile.
    let finalCol = toCol;
    let stunnedUntil = me.stunnedUntil;
    const minedHere = obstacles.find(
      (o) => o.kind === "pawn_mine" && o.row === toRow && o.col === toCol,
    );
    if (minedHere) {
      // Landed directly on a mine: capture (remove) it, no penalty.
      ctx.db.obstacle.id.delete(minedHere.id);
    } else {
      // A pawn mine threatens its two forward diagonals (mr±1, mc+1), so the
      // landing tile is threatened by a mine one column back, one row off.
      const threatened = obstacles.some(
        (o) =>
          o.kind === "pawn_mine" &&
          o.col === toCol - 1 &&
          (o.row === toRow - 1 || o.row === toRow + 1),
      );
      if (threatened) {
        finalCol = Math.max(0, toCol - MINE_KNOCKBACK);
        stunnedUntil = new Timestamp(nowMicros + STUN_MICROS);
      }
    }

    const finished = finalCol >= FINISH_COL;
    const finishRank = finished
      ? racersInRoom(ctx, me.roomCode).filter((r) => r.finished).length + 1
      : 0;

    ctx.db.racer.id.update({
      ...me,
      row: toRow,
      col: finalCol,
      lastMoveAt: ctx.timestamp,
      stunnedUntil,
      finished,
      finishRank,
    });

    // End the race once every racer has crossed the line.
    if (finished && racersInRoom(ctx, me.roomCode).every((r) => r.finished)) {
      ctx.db.room.code.update({ ...room, status: "finished" });
    }
  },
);

// Leave the current room.
export const leaveRoom = spacetimedb.reducer((ctx) => {
  removeCallerRacers(ctx);
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

export const init = spacetimedb.init(() => {});

// Mark the caller's racer online when they (re)connect.
export const onConnect = spacetimedb.clientConnected((ctx) => {
  for (const r of [...ctx.db.racer.identity.filter(ctx.sender)]) {
    ctx.db.racer.id.update({ ...r, online: true });
  }
});

// Mark offline on disconnect, but keep the seat: clients reconnect with the
// same identity (e.g. on a page refresh) and onConnect restores them. Seats are
// only freed by an explicit leaveRoom. (A reaper for abandoned rooms is M4.)
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  for (const r of [...ctx.db.racer.identity.filter(ctx.sender)]) {
    ctx.db.racer.id.update({ ...r, online: false });
  }
});
