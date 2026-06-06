import { useMemo, type CSSProperties } from "react";
import type { Racer, Room, Obstacle } from "./module_bindings/types";
import {
  legalTargets,
  cellKey,
  type Blockers,
  TRACK_COLS,
  TRACK_ROWS,
  VISION,
  FINISH_COL,
} from "./game/moves";

const GLYPHS: Record<string, string> = {
  rook: "♜",
  knight: "♞",
  bishop: "♝",
  queen: "♛",
};

// Stable per-lane colours so each racer reads as one identity.
const LANE_COLORS = [
  "#6ea8ff",
  "#56d68a",
  "#ff8f6b",
  "#c98bff",
  "#ffd166",
  "#4dd0e1",
  "#f06292",
  "#a3e635",
  "#ff6b6b",
  "#9b7bff",
];

type Props = {
  me: Racer;
  racers: Racer[];
  obstacles: Obstacle[];
  room: Room;
  cooldownRemaining: number; // ms until the next move is allowed (0 = ready)
  stunned: boolean;
  onMove: (row: number, col: number) => void;
};

export default function Board({
  me,
  racers,
  obstacles,
  room,
  cooldownRemaining,
  stunned,
  onMove,
}: Props) {
  const ready =
    cooldownRemaining <= 0 && !me.finished && room.status === "racing";

  // Blockers + legal moves + threatened tiles mirror the server authority.
  const { legalSet, racersByCell, wallSet, mineSet, threatSet } =
    useMemo(() => {
      const blockers: Blockers = new Map();
      const walls = new Set<string>();
      const mines = new Set<string>();
      const threats = new Set<string>();
      const byCell = new Map<string, Racer>();

      for (const o of obstacles) {
        const k = cellKey(o.row, o.col);
        if (o.kind === "wall") {
          walls.add(k);
          blockers.set(k, "wall");
        } else {
          mines.add(k);
          blockers.set(k, "mine");
          // Pawn mine threatens its two forward diagonals.
          threats.add(cellKey(o.row - 1, o.col + 1));
          threats.add(cellKey(o.row + 1, o.col + 1));
        }
      }
      for (const r of racers) {
        byCell.set(cellKey(r.row, r.col), r);
        if (r.id !== me.id && !r.finished)
          blockers.set(cellKey(r.row, r.col), "racer");
      }
      const legal = new Set(
        legalTargets(me.piece, me.row, me.col, blockers).map((c) =>
          cellKey(c.row, c.col),
        ),
      );
      return {
        legalSet: legal,
        racersByCell: byCell,
        wallSet: walls,
        mineSet: mines,
        threatSet: threats,
      };
    }, [obstacles, racers, me.id, me.piece, me.row, me.col]);

  // Fixed-size camera: always show the same number of columns (a few behind +
  // full vision ahead) so the cell size never changes — no zoom near the finish
  // — and clamp at the track ends so it scrolls smoothly instead of resizing.
  const BEHIND = 3;
  const WINDOW = VISION + BEHIND + 1; // constant column count
  const startCol = Math.max(0, Math.min(me.col - BEHIND, TRACK_COLS - WINDOW));
  const cols: number[] = [];
  for (let i = 0; i < WINDOW; i++) cols.push(startCol + i);

  const laneColor = (r: Racer) => LANE_COLORS[r.row % LANE_COLORS.length];
  const finishers = [...racers]
    .filter((r) => r.finished)
    .sort((a, b) => a.finishRank - b.finishRank);

  const status = me.finished
    ? `finished #${me.finishRank}`
    : stunned
      ? "stunned"
      : ready
        ? "ready"
        : "…";

  return (
    <div className="board-wrap">
      <div className="hud">
        <span className="hud-piece" style={{ color: laneColor(me) }}>
          {GLYPHS[me.piece] ?? "♟"} {me.name}
        </span>
        <span className="muted">
          col {me.col} / {FINISH_COL}
        </span>
        <div className="cooldown">
          <div
            className="cooldown-fill"
            style={{
              width: `${Math.max(0, Math.min(1, 1 - cooldownRemaining / 600)) * 100}%`,
              background: stunned
                ? "var(--bad)"
                : ready
                  ? "var(--good)"
                  : "var(--accent)",
            }}
          />
        </div>
        <span className={`muted ${stunned ? "stun-label" : ""}`}>{status}</span>
      </div>

      <div
        className="board"
        style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)` }}
      >
        {Array.from({ length: TRACK_ROWS }).map((_, row) =>
          cols.map((col) => {
            const key = cellKey(row, col);
            const occupant = racersByCell.get(key);
            const isLegal = legalSet.has(key);
            const isMe = occupant?.id === me.id;
            const isWall = wallSet.has(key);
            const isMine = mineSet.has(key);
            const isThreat = threatSet.has(key);
            const isFinish = col === FINISH_COL;
            const clickable = isLegal && ready;
            return (
              <div
                key={key}
                className={[
                  "cell",
                  (row + col) % 2 === 0 ? "cell-a" : "cell-b",
                  isFinish ? "cell-finish" : "",
                  isWall ? "cell-wall" : "",
                  isThreat && !isWall ? "cell-threat" : "",
                  clickable ? "cell-legal" : "",
                ].join(" ")}
                onClick={() => clickable && onMove(row, col)}
              >
                {occupant ? (
                  <span
                    className={`piece ${isMe ? "piece-me" : ""}`}
                    style={{ "--lane": laneColor(occupant) } as CSSProperties}
                    title={occupant.name}
                  >
                    {GLYPHS[occupant.piece] ?? "♟"}
                  </span>
                ) : isWall ? (
                  <span className="wall-mark" />
                ) : isMine ? (
                  <span className="mine-mark">✸</span>
                ) : clickable ? (
                  <span className="legal-dot" />
                ) : null}
              </div>
            );
          }),
        )}
      </div>

      <p className="muted fog-note">
        Fog: you see {VISION} tiles ahead. <span className="legend-wall" /> wall
        · <span className="legend-mine">✸</span> mine (land on it to defuse; its
        diagonals knock you back)
      </p>

      {/* Full-track ladder so you can read the whole field's progress. */}
      <div className="ladder">
        {[...racers]
          .sort((a, b) => b.col - a.col)
          .map((r) => (
            <div className="ladder-row" key={r.id.toString()}>
              <span className="ladder-name" style={{ color: laneColor(r) }}>
                {GLYPHS[r.piece] ?? "♟"} {r.name}
                {r.id === me.id && <span className="you">you</span>}
                {r.finished && <span className="rank">#{r.finishRank}</span>}
              </span>
              <div className="ladder-bar">
                <span
                  className="ladder-piece"
                  style={{
                    left: `${(r.col / FINISH_COL) * 100}%`,
                    color: laneColor(r),
                  }}
                >
                  {GLYPHS[r.piece] ?? "♟"}
                </span>
              </div>
            </div>
          ))}
      </div>

      {room.status === "finished" && (
        <div className="results">
          <h2>🏁 Results</h2>
          {finishers.map((r) => (
            <div className="result-row" key={r.id.toString()}>
              <span className="rank">#{r.finishRank}</span>
              <span style={{ color: laneColor(r) }}>
                {GLYPHS[r.piece] ?? "♟"} {r.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
