import { useMemo } from "react";
import type { Racer, Room } from "./module_bindings/types";
import {
  legalTargets,
  cellKey,
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
  room: Room;
  cooldownRemaining: number; // ms until the next move is allowed (0 = ready)
  onMove: (row: number, col: number) => void;
};

export default function Board({
  me,
  racers,
  room,
  cooldownRemaining,
  onMove,
}: Props) {
  const ready =
    cooldownRemaining <= 0 && !me.finished && room.status === "racing";

  // Occupancy + legal moves mirror the server authority.
  const { legalSet, racersByCell } = useMemo(() => {
    const occupied = new Set<string>();
    const byCell = new Map<string, Racer>();
    for (const r of racers) {
      byCell.set(cellKey(r.row, r.col), r);
      if (r.id !== me.id && !r.finished) occupied.add(cellKey(r.row, r.col));
    }
    const legal = new Set(
      legalTargets(me.piece, me.row, me.col, occupied).map((c) =>
        cellKey(c.row, c.col),
      ),
    );
    return { legalSet: legal, racersByCell: byCell };
  }, [racers, me.id, me.piece, me.row, me.col]);

  // Player-centric window: a little behind, full vision ahead.
  const startCol = Math.max(0, me.col - 2);
  const endCol = Math.min(TRACK_COLS - 1, me.col + VISION);
  const cols: number[] = [];
  for (let c = startCol; c <= endCol; c++) cols.push(c);

  const laneColor = (r: Racer) => LANE_COLORS[r.row % LANE_COLORS.length];
  const finishers = [...racers]
    .filter((r) => r.finished)
    .sort((a, b) => a.finishRank - b.finishRank);

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
              background: ready ? "var(--good)" : "var(--accent)",
            }}
          />
        </div>
        <span className="muted">{ready ? "ready" : "…"}</span>
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
            const isFinish = col === FINISH_COL;
            return (
              <div
                key={key}
                className={[
                  "cell",
                  (row + col) % 2 === 0 ? "cell-a" : "cell-b",
                  isFinish ? "cell-finish" : "",
                  isLegal && ready ? "cell-legal" : "",
                ].join(" ")}
                onClick={() => isLegal && ready && onMove(row, col)}
              >
                {occupant ? (
                  <span
                    className={`piece ${isMe ? "piece-me" : ""}`}
                    style={{ color: laneColor(occupant) }}
                    title={occupant.name}
                  >
                    {GLYPHS[occupant.piece] ?? "♟"}
                  </span>
                ) : isLegal && ready ? (
                  <span className="legal-dot" />
                ) : null}
              </div>
            );
          }),
        )}
      </div>

      <p className="muted fog-note">
        Fog: you can see and move up to {VISION} tiles ahead.
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
          <h2>Results</h2>
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
