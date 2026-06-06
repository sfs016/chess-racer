// ─────────────────────────────────────────────────────────────────────────────
// Chess Race — SpacetimeDB server module
//
// Authoritative game server. All game state lives in tables; all mutations go
// through reducers (transactional, deterministic). Clients subscribe to tables
// and call reducers — there is no separate API server.
//
// Milestone M1: lobby only — create/join rooms, pick a piece, assign lanes.
// Movement, hazards, items, and bots arrive in later milestones.
// ─────────────────────────────────────────────────────────────────────────────
import {
  schema,
  t,
  table,
  SenderError,
  type ReducerCtx,
  type InferSchema,
} from "spacetimedb/server";

// ── Constants ────────────────────────────────────────────────────────────────
// NOTE: a SpacetimeDB module may only export spacetime artifacts (reducers,
// lifecycle hooks, the default schema). Plain constants must stay un-exported.
const TRACK_COLS = 100; // race length; finish line is the last column
const TRACK_ROWS = 10; // lanes
const MAX_RACERS = 8; // human + bot cap per room
const VISION = 10; // how many columns ahead a racer can see / reach
const FINISH_COL = TRACK_COLS - 1; // landing here (or beyond) finishes the race
const MOVE_COOLDOWN_MICROS = 600_000n; // 0.6s between moves (PRD: 500–700ms)

const PIECES = ["rook", "knight", "bishop"] as const;
type Piece = (typeof PIECES)[number];

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
    status: t.string(), // one of ROOM_STATUSES
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
  },
);

const spacetimedb = schema({ room, racer });
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
// NOTE: keep this in sync with the client's src/game/moves.ts. The client uses
// it to highlight legal destinations; the server uses it as the authority.

type Cell = { row: number; col: number };

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

// All legal destination tiles for a piece, given the tiles occupied by other
// racers. Movement is forward-only (col never decreases); rook/bishop slide
// along a ray until the first blocker or the edge of vision; knight jumps.
function legalTargets(
  piece: string,
  fromRow: number,
  fromCol: number,
  occupied: Set<string>,
): Cell[] {
  const targets: Cell[] = [];
  const maxCol = Math.min(fromCol + VISION, TRACK_COLS - 1);
  const inBounds = (r: number, c: number) =>
    r >= 0 && r < TRACK_ROWS && c >= 0 && c < TRACK_COLS;

  // Slide along (dr, dc), landing on any empty tile up to the first blocker.
  const slide = (dr: number, dc: number) => {
    let r = fromRow + dr;
    let c = fromCol + dc;
    while (inBounds(r, c) && c <= maxCol) {
      if (occupied.has(cellKey(r, c))) break; // blocked: can't pass or land
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
    // Forward L-jumps only (column delta > 0); jumps over occupied tiles, so
    // only the landing square must be empty.
    const ls = [
      { dr: 2, dc: 1 },
      { dr: -2, dc: 1 },
      { dr: 1, dc: 2 },
      { dr: -1, dc: 2 },
    ];
    for (const { dr, dc } of ls) {
      const r = fromRow + dr;
      const c = fromCol + dc;
      if (inBounds(r, c) && c <= maxCol && !occupied.has(cellKey(r, c))) {
        targets.push({ row: r, col: c });
      }
    }
  }
  return targets;
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

    for (const r of racersInRoom(ctx, code)) {
      ctx.db.racer.id.update({
        ...r,
        col: 0,
        finished: false,
        finishRank: 0,
        lastMoveAt: ctx.timestamp, // cooldown counts from the start
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
// tile is a legal slide/jump target for the caller's piece, enforces the move
// cooldown, and resolves contested tiles by reducer order (the second racer to
// claim a tile finds it occupied and is rejected).
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

    const elapsed =
      ctx.timestamp.microsSinceUnixEpoch - me.lastMoveAt.microsSinceUnixEpoch;
    if (elapsed < MOVE_COOLDOWN_MICROS)
      throw new SenderError("Move is on cooldown");

    // Tiles occupied by other (still-racing) racers block sliding and landing.
    const occupied = new Set<string>();
    for (const r of ctx.db.racer.roomCode.filter(me.roomCode)) {
      if (r.id !== me.id && !r.finished) occupied.add(cellKey(r.row, r.col));
    }

    const legal = legalTargets(me.piece, me.row, me.col, occupied);
    if (!legal.some((c) => c.row === toRow && c.col === toCol)) {
      throw new SenderError("Illegal move");
    }

    const finished = toCol >= FINISH_COL;
    const finishRank = finished
      ? racersInRoom(ctx, me.roomCode).filter((r) => r.finished).length + 1
      : 0;

    ctx.db.racer.id.update({
      ...me,
      row: toRow,
      col: toCol,
      lastMoveAt: ctx.timestamp,
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
