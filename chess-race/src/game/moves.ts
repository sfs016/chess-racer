// Legal-move rules for Chess Race.
//
// IMPORTANT: this mirrors `legalTargets` in spacetimedb/src/index.ts. The server
// is the authority (it re-validates every move); the client uses this only to
// highlight destinations. Keep the two in sync.

export const TRACK_COLS = 100;
export const TRACK_ROWS = 10;
export const VISION = 10; // columns ahead a racer can see / reach
export const FINISH_COL = TRACK_COLS - 1;

export type Cell = { row: number; col: number };

// Per-tile blocker kind:
//   "wall"  — blocks a ray and cannot be landed on (knight jumps over it)
//   "racer" — blocks a ray and cannot be landed on (knight jumps over it)
//   "mine"  — can be landed on (captures it) but a ray cannot pass beyond it
export type Blockers = Map<string, "wall" | "racer" | "mine">;

export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

// All legal destination tiles for a piece given the blocker map. Forward-only
// (col never decreases); rook/bishop slide along a ray until the first blocker
// or the edge of vision; knight jumps (only its landing tile matters).
export function legalTargets(
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
        targets.push({ row: r, col: c });
        break;
      }
      if (blk) break;
      targets.push({ row: r, col: c });
      r += dr;
      c += dc;
    }
  };

  const isRook = piece === "rook" || piece === "queen";
  const isBishop = piece === "bishop" || piece === "queen";

  if (isRook) {
    slide(0, 1);
    slide(1, 0);
    slide(-1, 0);
  }
  if (isBishop) {
    slide(1, 1);
    slide(-1, 1);
  }
  if (piece === "knight") {
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
