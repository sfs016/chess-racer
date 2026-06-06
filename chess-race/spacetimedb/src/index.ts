// ─────────────────────────────────────────────────────────────────────────────
// Chess Race - SpacetimeDB server module
//
// Authoritative game server. All game state lives in tables; all mutations go
// through reducers (transactional, deterministic). Clients subscribe to tables
// and call reducers - there is no separate API server.
//
// Implemented: lobby (rooms/racers/lanes), authoritative slide movement with a
// cooldown, a procedurally-generated track of walls + pawn mines, quick-play,
// rule-based bots driven by a scheduled tick, and items (promotion/freeze/mine).
// Still to come: deploy.
// ─────────────────────────────────────────────────────────────────────────────
import {
  schema,
  t,
  table,
  SenderError,
  type ReducerCtx,
  type InferSchema,
} from "spacetimedb/server";
import { Timestamp, Identity, ScheduleAt } from "spacetimedb";

// ── Constants ────────────────────────────────────────────────────────────────
// NOTE: a SpacetimeDB module may only export spacetime artifacts (reducers,
// lifecycle hooks, the default schema). Plain constants must stay un-exported.
const TRACK_COLS = 100; // race length; finish line is the last column
const TRACK_ROWS = 10; // lanes
const MAX_RACERS = 10; // human + bot cap per room (one per lane)
const VISION = 10; // how many columns ahead a racer can see / reach
const FINISH_COL = TRACK_COLS - 1; // landing here (or beyond) finishes the race
const MOVE_COOLDOWN_MICROS = 600_000n; // 0.6s between moves (PRD: 500–700ms)
const COUNTDOWN_MICROS = 5_000_000n; // 5s countdown before racing begins

const SAFE_COLS = 3; // columns near the start kept clear of hazards
const MINE_KNOCKBACK = 3; // tiles a triggered pawn mine knocks you back
const STUN_MICROS = 1_500_000n; // 1.5s stun after triggering a mine

// Items (string `kind` on item_spawn, and racer.heldItem):
//   "promotion" - become a Queen for PROMOTION_MICROS
//   "freeze"    - freeze the current leader for FREEZE_MICROS
//   "mine"      - drop a pawn mine one tile behind you
const PROMOTION_MICROS = 8_000_000n; // 8s as a Queen
const FREEZE_MICROS = 3_000_000n; // 3s frozen

// Bots tick slower than the human move cooldown (0.6s) so an attentive human
// keeps an edge; bots stay competitive but beatable.
const BOT_TICK_MICROS = 950_000n;
const BOT_NAMES = [
  "Garry",
  "Magnus",
  "Bobby",
  "Judit",
  "Hikaru",
  "Vishy",
  "Mikhail",
  "Anatoly",
];
const BOT_KINDS = ["greedy", "cautious", "wild"] as const; // simple bot AIs

const PIECES = ["rook", "knight", "bishop", "queen"] as const;
type Piece = (typeof PIECES)[number];

// Obstacle kinds (string `kind` column on `obstacle`):
//   "wall"      - blocks rook/bishop rays; knight jumps it; nobody lands on it
//   "pawn_mine" - landable (captured when landed on); threatens its two forward
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
    seed: t.u32(), // PRNG seed for procedural track
    piece: t.string(), // the single piece everyone races (host's choice)
    botCount: t.u32(), // bots the host wants added at start (0 = human-only)
    host: t.identity(), // who created the room (may start the race)
    createdAt: t.timestamp(),
    startedAt: t.timestamp().optional(), // when racing begins (end of countdown)
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
    piece: t.string(), // the race piece (== room.piece; queen while promoted)
    colorIndex: t.u32(), // stable per-racer colour (does not change when moving)
    row: t.u32(), // lane, 0..TRACK_ROWS-1
    col: t.u32(), // position along the track, 0..TRACK_COLS-1
    isBot: t.bool(),
    botKind: t.string(), // "" for humans; one of BOT_KINDS for bots
    online: t.bool(),
    ready: t.bool(),
    finished: t.bool(),
    finishRank: t.u32(), // 0 until finished, then 1-based placement
    joinedAt: t.timestamp(),
    lastMoveAt: t.timestamp(), // for the per-move cooldown
    stunnedUntil: t.timestamp(), // mine stun / freeze; no moves until this time
    heldItem: t.string(), // "" or one of the item kinds
    promotedUntil: t.timestamp(), // Queen movement until this time (promotion)
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

// One row per item pickup on a room's track.
const itemSpawn = table(
  { name: "item_spawn", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    roomCode: t.string().index("btree"),
    row: t.u32(),
    col: t.u32(),
    kind: t.string(), // "promotion" | "freeze" | "mine"
  },
);

// A repeating scheduled timer that drives bot moves. One row, inserted at init;
// SpacetimeDB calls `botTick` every BOT_TICK_MICROS.
const botTimer = table(
  { name: "bot_timer", scheduled: (): any => botTick }, // eslint-disable-line @typescript-eslint/no-explicit-any
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  },
);

const spacetimedb = schema({ room, racer, obstacle, itemSpawn, botTimer });
export default spacetimedb;

// Reducer context typed against this module's schema (gives us ctx.db.room etc).
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
// Table rows (insert returns the row, so this infers each row's shape).
type RacerRow = ReturnType<Ctx["db"]["racer"]["insert"]>;
type RoomRow = ReturnType<Ctx["db"]["room"]["insert"]>;

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
    cleanupRoomIfNoHumans(ctx, r.roomCode);
  }
}

// Tear a room down once no humans remain (bots can't keep a room alive): delete
// its bots, obstacles, and the room itself, so the lobby and bot tick stay tidy.
function cleanupRoomIfNoHumans(ctx: Ctx, code: string) {
  const racers = racersInRoom(ctx, code);
  if (racers.some((r) => !r.isBot)) return;
  for (const r of racers) ctx.db.racer.id.delete(r.id);
  for (const o of [...ctx.db.obstacle.roomCode.filter(code)]) {
    ctx.db.obstacle.id.delete(o.id);
  }
  for (const s of [...ctx.db.itemSpawn.roomCode.filter(code)]) {
    ctx.db.itemSpawn.id.delete(s.id);
  }
  const room = ctx.db.room.code.find(code);
  if (room) ctx.db.room.code.delete(code);
}

// Insert a human racer for the caller at a given lane.
function seatHuman(
  ctx: Ctx,
  code: string,
  name: string,
  piece: string,
  lane: number,
) {
  ctx.db.racer.insert({
    id: 0n,
    identity: ctx.sender,
    roomCode: code,
    name,
    piece,
    colorIndex: lane,
    row: lane,
    col: 0,
    isBot: false,
    botKind: "",
    online: true,
    ready: false,
    finished: false,
    finishRank: 0,
    joinedAt: ctx.timestamp,
    lastMoveAt: ctx.timestamp,
    stunnedUntil: ctx.timestamp,
    heldItem: "",
    promotedUntil: ctx.timestamp,
  });
}

// ── Movement ─────────────────────────────────────────────────────────────────
// NOTE: keep legalTargets in sync with the client's src/game/moves.ts. The
// client uses it to highlight legal destinations; the server is the authority.

type Cell = { row: number; col: number };

// Per-tile blocker kind used by movement:
//   "wall"  - blocks a ray and cannot be landed on (knight jumps over it)
//   "racer" - blocks a ray and cannot be landed on (knight jumps over it)
//   "mine"  - can be landed on (captures it) but a ray cannot pass beyond it
type Blockers = Map<string, "wall" | "racer" | "mine">;

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

// A racer moves as a Queen while promotion is active, otherwise as its piece.
function effectivePiece(r: RacerRow, nowMicros: bigint): string {
  return nowMicros < r.promotedUntil.microsSinceUnixEpoch ? "queen" : r.piece;
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
    // landing tile matters - and you can't land on a wall or another racer.
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
function generateTrack(
  ctx: Ctx,
  code: string,
  seed: number,
  allowPromotion: boolean,
) {
  for (const o of [...ctx.db.obstacle.roomCode.filter(code)]) {
    ctx.db.obstacle.id.delete(o.id);
  }
  for (const s of [...ctx.db.itemSpawn.roomCode.filter(code)]) {
    ctx.db.itemSpawn.id.delete(s.id);
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

    // Item pickups (midgame onward): mostly mines, some freeze, rare promotion.
    if (col >= 20 && rng() < 0.07) {
      const row = Math.floor(rng() * TRACK_ROWS);
      if (!used.has(cellKey(row, col))) {
        used.add(cellKey(row, col));
        const roll = rng();
        let kind = roll < 0.55 ? "mine" : roll < 0.85 ? "freeze" : "promotion";
        if (kind === "promotion" && !allowPromotion) kind = "freeze";
        ctx.db.itemSpawn.insert({ id: 0n, roomCode: code, row, col, kind });
      }
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

// Build the blocker map for a room (walls/mines + other racers), excluding the
// mover. Shared by human moves, bot moves, and legal-target generation.
function buildBlockers(ctx: Ctx, code: string, moverId: bigint): Blockers {
  const blockers: Blockers = new Map();
  for (const o of ctx.db.obstacle.roomCode.filter(code)) {
    blockers.set(cellKey(o.row, o.col), o.kind === "wall" ? "wall" : "mine");
  }
  for (const r of ctx.db.racer.roomCode.filter(code)) {
    if (r.id !== moverId && !r.finished) {
      blockers.set(cellKey(r.row, r.col), "racer");
    }
  }
  return blockers;
}

// Apply a move that has already been validated as legal and ready: resolve mine
// capture / knockback + stun, write the new position, and end the race once
// everyone has finished. Shared by submit_move (humans) and botTick (bots).
function applyMove(ctx: Ctx, mover: RacerRow, toRow: number, toCol: number) {
  let finalCol = toCol;
  let stunnedUntil = mover.stunnedUntil;

  const minedHere = [...ctx.db.obstacle.roomCode.filter(mover.roomCode)].find(
    (o) => o.kind === "pawn_mine" && o.row === toRow && o.col === toCol,
  );
  if (minedHere) {
    ctx.db.obstacle.id.delete(minedHere.id); // landed on the mine: defuse it
  } else {
    const threatened = [
      ...ctx.db.obstacle.roomCode.filter(mover.roomCode),
    ].some(
      (o) =>
        o.kind === "pawn_mine" &&
        o.col === toCol - 1 &&
        (o.row === toRow - 1 || o.row === toRow + 1),
    );
    if (threatened) {
      finalCol = Math.max(0, toCol - MINE_KNOCKBACK);
      stunnedUntil = new Timestamp(
        ctx.timestamp.microsSinceUnixEpoch + STUN_MICROS,
      );
    }
  }

  // Pick up an item on the landed tile (one held item at a time).
  let heldItem = mover.heldItem;
  if (heldItem === "") {
    const spawn = [...ctx.db.itemSpawn.roomCode.filter(mover.roomCode)].find(
      (s) => s.row === toRow && s.col === toCol,
    );
    if (spawn) {
      heldItem = spawn.kind;
      ctx.db.itemSpawn.id.delete(spawn.id);
    }
  }

  const finished = finalCol >= FINISH_COL;
  const finishRank = finished
    ? racersInRoom(ctx, mover.roomCode).filter((r) => r.finished).length + 1
    : 0;

  ctx.db.racer.id.update({
    ...mover,
    row: toRow,
    col: finalCol,
    lastMoveAt: ctx.timestamp,
    stunnedUntil,
    heldItem,
    finished,
    finishRank,
  });

  const room = ctx.db.room.code.find(mover.roomCode);
  if (
    room &&
    finished &&
    racersInRoom(ctx, mover.roomCode).every((r) => r.finished)
  ) {
    ctx.db.room.code.update({ ...room, status: "finished" });
  }
}

// Use the racer's held item. Shared by the useItem reducer (humans) and botTick.
function applyItem(ctx: Ctx, user: RacerRow) {
  const now = ctx.timestamp.microsSinceUnixEpoch;

  if (user.heldItem === "promotion") {
    ctx.db.racer.id.update({
      ...user,
      heldItem: "",
      promotedUntil: new Timestamp(now + PROMOTION_MICROS),
    });
  } else if (user.heldItem === "freeze") {
    // Freeze the current leader (furthest ahead, not the user, not finished).
    let leader: RacerRow | undefined;
    for (const r of ctx.db.racer.roomCode.filter(user.roomCode)) {
      if (r.id === user.id || r.finished) continue;
      if (!leader || r.col > leader.col) leader = r;
    }
    if (leader) {
      ctx.db.racer.id.update({
        ...leader,
        stunnedUntil: new Timestamp(now + FREEZE_MICROS),
      });
    }
    ctx.db.racer.id.update({ ...user, heldItem: "" });
  } else if (user.heldItem === "mine") {
    // Drop a pawn mine one tile behind, if that tile is free.
    const dropCol = Math.max(0, user.col - 1);
    const blocked = [...ctx.db.obstacle.roomCode.filter(user.roomCode)].some(
      (o) => o.row === user.row && o.col === dropCol,
    );
    if (!blocked) {
      ctx.db.obstacle.insert({
        id: 0n,
        roomCode: user.roomCode,
        row: user.row,
        col: dropCol,
        kind: "pawn_mine",
      });
    }
    ctx.db.racer.id.update({ ...user, heldItem: "" });
  }
}

// ── Bots ─────────────────────────────────────────────────────────────────────

// Pick a bot's destination from its legal targets, by personality.
function chooseBotMove(ctx: Ctx, bot: RacerRow, legal: Cell[]): Cell {
  const mineTiles = new Set<string>();
  const threatTiles = new Set<string>();
  for (const o of ctx.db.obstacle.roomCode.filter(bot.roomCode)) {
    if (o.kind !== "pawn_mine") continue;
    mineTiles.add(cellKey(o.row, o.col));
    threatTiles.add(cellKey(o.row - 1, o.col + 1));
    threatTiles.add(cellKey(o.row + 1, o.col + 1));
  }

  if (bot.botKind === "wild") {
    return legal[Math.floor(ctx.random() * legal.length)];
  }

  const scoreOf = (c: Cell): number => {
    const k = cellKey(c.row, c.col);
    let s = c.col; // forward progress is the main driver
    if (threatTiles.has(k) && !mineTiles.has(k)) {
      s -= bot.botKind === "cautious" ? 1000 : 30; // avoid getting knocked back
    }
    if (mineTiles.has(k)) {
      s += bot.botKind === "cautious" ? -8 : 6; // capturing clears the lane
    }
    return s + ctx.random() * 1.5; // tie-break noise so bots vary
  };

  let best = legal[0];
  let bestScore = -Infinity;
  for (const c of legal) {
    const s = scoreOf(c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

// Add `count` bots to a room (capped by available lanes). Bots race the same
// piece as everyone else (room.piece).
function fillBots(ctx: Ctx, code: string, piece: string, count: number) {
  for (let added = 0; added < count; added++) {
    if (racersInRoom(ctx, code).length >= MAX_RACERS) break;
    const lane = nextFreeLane(ctx, code);
    const name = BOT_NAMES[ctx.random.integerInRange(0, BOT_NAMES.length - 1)];
    const kind = BOT_KINDS[ctx.random.integerInRange(0, BOT_KINDS.length - 1)];
    ctx.db.racer.insert({
      id: 0n,
      identity: Identity.zero(),
      roomCode: code,
      name,
      piece,
      colorIndex: lane,
      row: lane,
      col: 0,
      isBot: true,
      botKind: kind,
      online: true,
      ready: true,
      finished: false,
      finishRank: 0,
      joinedAt: ctx.timestamp,
      lastMoveAt: ctx.timestamp,
      stunnedUntil: ctx.timestamp,
      heldItem: "",
      promotedUntil: ctx.timestamp,
    });
  }
}

// Make sure the repeating bot scheduler exists (idempotent).
function ensureBotTimer(ctx: Ctx) {
  if ([...ctx.db.botTimer.iter()].length === 0) {
    ctx.db.botTimer.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.interval(BOT_TICK_MICROS),
    });
  }
}

// ── Reducers ─────────────────────────────────────────────────────────────────

// Create a fresh room and seat the caller in it as host. The host's chosen
// piece becomes the single piece everyone in the room races.
export const createRoom = spacetimedb.reducer(
  { name: t.string(), piece: t.string(), bots: t.u32() },
  (ctx, { name, piece, bots }) => {
    const cleanName = validateName(name);
    const cleanPiece = validatePiece(piece);

    // Leave any room the caller is already in before creating a new one.
    removeCallerRacers(ctx);

    const code = generateRoomCode(ctx);
    ctx.db.room.insert({
      code,
      status: "lobby",
      seed: ctx.random.integerInRange(1, 0x7fffffff),
      piece: cleanPiece,
      botCount: Math.min(bots, MAX_RACERS - 1),
      host: ctx.sender,
      createdAt: ctx.timestamp,
      startedAt: undefined,
    });
    seatHuman(ctx, code, cleanName, cleanPiece, 0);
  },
);

// Host sets how many bots to add at race start (0 = human-only race). Capped so
// humans + bots can never exceed MAX_RACERS.
export const setBotCount = spacetimedb.reducer(
  { count: t.u32() },
  (ctx, { count }) => {
    const mine = [...ctx.db.racer.identity.filter(ctx.sender)][0];
    if (!mine) throw new SenderError("You are not in a room");
    const room = ctx.db.room.code.find(mine.roomCode);
    if (!room) throw new SenderError("Room not found");
    if (!room.host.equals(ctx.sender))
      throw new SenderError("Only the host can set bots");
    if (room.status !== "lobby") throw new SenderError("Race already started");
    const humans = racersInRoom(ctx, mine.roomCode).filter(
      (r) => !r.isBot,
    ).length;
    ctx.db.room.code.update({
      ...room,
      botCount: Math.min(count, MAX_RACERS - humans),
    });
  },
);

// Join an existing room in its lobby phase. The joiner races the room's piece.
export const joinRoom = spacetimedb.reducer(
  { code: t.string(), name: t.string() },
  (ctx, { code, name }) => {
    const cleanName = validateName(name);

    const room = ctx.db.room.code.find(code);
    if (!room) throw new SenderError(`No room with code ${code}`);
    if (room.status !== "lobby")
      throw new SenderError("Race has already started");
    if (racersInRoom(ctx, code).length >= MAX_RACERS)
      throw new SenderError("Room is full");

    removeCallerRacers(ctx);
    seatHuman(ctx, code, cleanName, room.piece, nextFreeLane(ctx, code));
  },
);

// Host changes the race piece in the lobby; everyone in the room switches to it.
export const setRoomPiece = spacetimedb.reducer(
  { piece: t.string() },
  (ctx, { piece }) => {
    const cleanPiece = validatePiece(piece);
    const mine = [...ctx.db.racer.identity.filter(ctx.sender)][0];
    if (!mine) throw new SenderError("You are not in a room");
    const room = ctx.db.room.code.find(mine.roomCode);
    if (!room) throw new SenderError("Room not found");
    if (!room.host.equals(ctx.sender))
      throw new SenderError("Only the host can choose the piece");
    if (room.status !== "lobby") throw new SenderError("Race already started");

    ctx.db.room.code.update({ ...room, piece: cleanPiece });
    for (const r of racersInRoom(ctx, mine.roomCode)) {
      ctx.db.racer.id.update({ ...r, piece: cleanPiece });
    }
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

// Host starts the race: generate the track, fill bots, and begin a 5s countdown
// (the bot scheduler flips the room to "racing" when the countdown elapses).
export const startRace = spacetimedb.reducer(
  { code: t.string() },
  (ctx, { code }) => {
    const room = ctx.db.room.code.find(code);
    if (!room) throw new SenderError(`No room with code ${code}`);
    if (!room.host.equals(ctx.sender))
      throw new SenderError("Only the host can start the race");
    if (room.status !== "lobby") throw new SenderError("Race already started");

    // Promotion (→ Queen) items only make sense when not already racing Queens.
    generateTrack(ctx, code, room.seed, room.piece !== "queen");
    // Add the host's requested bots, capped so the field never exceeds MAX_RACERS.
    const humans = racersInRoom(ctx, code).length;
    fillBots(
      ctx,
      code,
      room.piece,
      Math.min(room.botCount, MAX_RACERS - humans),
    );
    ensureBotTimer(ctx); // make sure the bot scheduler is running

    // Racing starts when the countdown ends; cooldowns are measured from then.
    const raceStart = new Timestamp(
      ctx.timestamp.microsSinceUnixEpoch + COUNTDOWN_MICROS,
    );

    // Randomize starting lanes (rows) via a shuffle. Everyone still starts at
    // col 0, so the distance to the finish is equal and fair; only the lane
    // (and visual order) is randomized. colorIndex is left untouched, so each
    // racer keeps its stable colour.
    const lanes = Array.from({ length: TRACK_ROWS }, (_, i) => i);
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = ctx.random.integerInRange(0, i);
      [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
    }
    let laneIdx = 0;
    for (const r of racersInRoom(ctx, code)) {
      ctx.db.racer.id.update({
        ...r,
        piece: room.piece, // everyone races the same piece
        row: lanes[laneIdx++],
        col: 0,
        finished: false,
        finishRank: 0,
        lastMoveAt: raceStart,
        stunnedUntil: raceStart,
        heldItem: "",
        promotedUntil: ctx.timestamp,
      });
    }
    ctx.db.room.code.update({
      ...room,
      status: "countdown",
      startedAt: raceStart,
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

    const blockers = buildBlockers(ctx, me.roomCode, me.id);
    const piece = effectivePiece(me, nowMicros);
    const legal = legalTargets(piece, me.row, me.col, blockers);
    if (!legal.some((c) => c.row === toRow && c.col === toCol)) {
      throw new SenderError("Illegal move");
    }

    applyMove(ctx, me, toRow, toCol);
  },
);

// Use the caller's held item (promotion / freeze / mine).
export const useItem = spacetimedb.reducer((ctx) => {
  const me = [...ctx.db.racer.identity.filter(ctx.sender)][0];
  if (!me) throw new SenderError("You are not in a room");
  const room = ctx.db.room.code.find(me.roomCode);
  if (!room || room.status !== "racing")
    throw new SenderError("Race is not in progress");
  if (me.finished) throw new SenderError("You have already finished");
  if (me.heldItem === "") throw new SenderError("You have no item");
  applyItem(ctx, me);
});

// Quick Play: seat the caller in the newest joinable lobby, or open a fresh room
// if none is available.
export const quickPlay = spacetimedb.reducer(
  { name: t.string(), piece: t.string(), bots: t.u32() },
  (ctx, { name, piece, bots }) => {
    const cleanName = validateName(name);
    const cleanPiece = validatePiece(piece);
    removeCallerRacers(ctx);

    let target: RoomRow | undefined;
    for (const room of ctx.db.room.iter()) {
      if (room.status !== "lobby") continue;
      const inRoom = racersInRoom(ctx, room.code);
      if (inRoom.length >= MAX_RACERS) continue;
      // Skip dead lobbies whose humans have all disconnected.
      if (!inRoom.some((r) => r.online && !r.isBot)) continue;
      if (
        !target ||
        room.createdAt.microsSinceUnixEpoch >
          target.createdAt.microsSinceUnixEpoch
      ) {
        target = room;
      }
    }

    if (target) {
      // Joining an existing room: race that room's piece, not the requested one.
      seatHuman(
        ctx,
        target.code,
        cleanName,
        target.piece,
        nextFreeLane(ctx, target.code),
      );
    } else {
      const code = generateRoomCode(ctx);
      ctx.db.room.insert({
        code,
        status: "lobby",
        seed: ctx.random.integerInRange(1, 0x7fffffff),
        piece: cleanPiece,
        botCount: Math.min(bots, MAX_RACERS - 1),
        host: ctx.sender,
        createdAt: ctx.timestamp,
        startedAt: undefined,
      });
      seatHuman(ctx, code, cleanName, cleanPiece, 0);
    }
  },
);

// Scheduled: advances every bot one move. Fires on the bot_timer interval; only
// the scheduler (the module identity) may invoke it.
export const botTick = spacetimedb.reducer(
  { timer: botTimer.rowType },
  (ctx) => {
    if (!ctx.sender.equals(ctx.databaseIdentity)) return;

    const now = ctx.timestamp.microsSinceUnixEpoch;
    for (const room of ctx.db.room.iter()) {
      // End the pre-race countdown.
      if (room.status === "countdown") {
        if (room.startedAt && now >= room.startedAt.microsSinceUnixEpoch) {
          ctx.db.room.code.update({ ...room, status: "racing" });
        }
        continue;
      }
      if (room.status !== "racing") continue;
      for (const bot of [...ctx.db.racer.roomCode.filter(room.code)]) {
        if (!bot.isBot || bot.finished) continue;
        if (now < bot.stunnedUntil.microsSinceUnixEpoch) continue;
        if (now - bot.lastMoveAt.microsSinceUnixEpoch < MOVE_COOLDOWN_MICROS)
          continue;

        // Bots use a held item immediately (re-read afterwards since it mutates).
        if (bot.heldItem !== "") applyItem(ctx, bot);

        // Re-read in case an earlier bot in this tick (or the item) changed state.
        const current = ctx.db.racer.id.find(bot.id);
        if (!current) continue;
        const blockers = buildBlockers(ctx, room.code, current.id);
        const legal = legalTargets(
          effectivePiece(current, now),
          current.row,
          current.col,
          blockers,
        );
        if (legal.length === 0) continue;
        const target = chooseBotMove(ctx, current, legal);
        applyMove(ctx, current, target.row, target.col);
      }
    }
  },
);

// Leave the current room.
export const leaveRoom = spacetimedb.reducer((ctx) => {
  removeCallerRacers(ctx);
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

export const init = spacetimedb.init((ctx) => {
  ensureBotTimer(ctx);
});

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
