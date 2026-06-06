import { useMemo, useRef, type CSSProperties } from "react";
import type { Racer, Room, Obstacle, ItemSpawn } from "./module_bindings/types";
import {
  legalTargets,
  cellKey,
  type Blockers,
  TRACK_COLS,
  TRACK_ROWS,
  VISION,
  FINISH_COL,
} from "./game/moves";
import { colorFor } from "./colors";

const GLYPHS: Record<string, string> = {
  rook: "♜",
  knight: "♞",
  bishop: "♝",
  queen: "♛",
};

const ITEM_GLYPH: Record<string, string> = {
  promotion: "♛",
  freeze: "❄",
  mine: "💣",
};
const ITEM_LABEL: Record<string, string> = {
  promotion: "Promote to Queen",
  freeze: "Freeze the leader",
  mine: "Drop a mine",
};

// A few columns of context behind the player; the rest of the window is vision
// ahead. The board never re-lays-out: the whole track is rendered and slid via
// a CSS transform, so it glides smoothly instead of jumping on each move.
const BEHIND = 3;
const WINDOW = VISION + BEHIND + 1;
const ALL_COLS = Array.from({ length: TRACK_COLS }, (_, c) => c);

type Props = {
  me: Racer;
  racers: Racer[];
  obstacles: Obstacle[];
  items: ItemSpawn[];
  room: Room;
  now: number; // ms, for promotion/freeze timers
  cooldownRemaining: number; // ms until the next move is allowed (0 = ready)
  stunned: boolean;
  onMove: (row: number, col: number) => void;
  onUseItem: () => void;
};

function formatTime(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
  }
  return `${s.toFixed(1)}s`;
}

export default function Board({
  me,
  racers,
  obstacles,
  items,
  room,
  now,
  cooldownRemaining,
  stunned,
  onMove,
  onUseItem,
}: Props) {
  const ready =
    cooldownRemaining <= 0 && !me.finished && room.status === "racing";

  // Keep a stable handle to onMove so it isn't a cell-memo dependency.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // A racer moves as a Queen while promotion is active.
  const effPiece = (r: Racer) =>
    r.promotedUntil.toDate().getTime() > now ? "queen" : r.piece;
  const iAmQueen = effPiece(me) === "queen";

  const laneColor = (r: Racer) => colorFor(r.colorIndex);

  // Blockers + legal moves + hazards + items mirror the server authority.
  const { legalSet, racersByCell, wallSet, mineSet, threatSet, itemByCell } =
    useMemo(() => {
      const blockers: Blockers = new Map();
      const walls = new Set<string>();
      const mines = new Set<string>();
      const threats = new Set<string>();
      const byCell = new Map<string, Racer>();
      const itemCell = new Map<string, ItemSpawn>();

      for (const o of obstacles) {
        const k = cellKey(o.row, o.col);
        if (o.kind === "wall") {
          walls.add(k);
          blockers.set(k, "wall");
        } else {
          mines.add(k);
          blockers.set(k, "mine");
          threats.add(cellKey(o.row - 1, o.col + 1));
          threats.add(cellKey(o.row + 1, o.col + 1));
        }
      }
      for (const it of items) itemCell.set(cellKey(it.row, it.col), it);
      for (const r of racers) {
        byCell.set(cellKey(r.row, r.col), r);
        if (r.id !== me.id && !r.finished)
          blockers.set(cellKey(r.row, r.col), "racer");
      }
      const legal = new Set(
        legalTargets(effPiece(me), me.row, me.col, blockers).map((c) =>
          cellKey(c.row, c.col),
        ),
      );
      return {
        legalSet: legal,
        racersByCell: byCell,
        wallSet: walls,
        mineSet: mines,
        threatSet: threats,
        itemByCell: itemCell,
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [obstacles, items, racers, me.id, me.piece, me.row, me.col, iAmQueen]);

  // Camera follows the player but the strip only re-renders cells when the board
  // state changes (not on every 80ms HUD tick). The transform is applied to the
  // wrapper, so following the player is a cheap, smooth glide.
  const cameraCol = Math.max(0, Math.min(me.col - BEHIND, TRACK_COLS - WINDOW));

  // Refresh promoted glyphs ~2x/sec without re-rendering 1000 cells every tick.
  const effBucket = Math.floor(now / 500);

  const cells = useMemo(
    () =>
      Array.from({ length: TRACK_ROWS }).map((_, row) =>
        ALL_COLS.map((col) => {
          const key = cellKey(row, col);
          const occupant = racersByCell.get(key);
          const item = itemByCell.get(key);
          const isLegal = legalSet.has(key);
          const isMe = occupant?.id === me.id;
          const isWall = wallSet.has(key);
          const isMine = mineSet.has(key);
          const isThreat = threatSet.has(key);
          const isFinish = col >= FINISH_COL;
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
              onClick={() => clickable && onMoveRef.current(row, col)}
            >
              {occupant ? (
                <span
                  className={`piece ${isMe ? "piece-me" : ""} ${
                    effPiece(occupant) === "queen" ? "piece-queen" : ""
                  }`}
                  style={{ "--lane": laneColor(occupant) } as CSSProperties}
                  title={occupant.name}
                >
                  {GLYPHS[effPiece(occupant)] ?? "♟"}
                </span>
              ) : isWall ? (
                <span className="wall-mark" />
              ) : isMine ? (
                <span className="pawn-mark">♟</span>
              ) : item ? (
                item.kind === "mine" ? (
                  <span className="bomb item-mark" />
                ) : item.kind === "promotion" ? (
                  <span className="item-mark item-promotion">♛</span>
                ) : (
                  <span className="item-mark item-freeze">❄</span>
                )
              ) : clickable ? (
                <span className="legal-dot" />
              ) : null}
            </div>
          );
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      legalSet,
      racersByCell,
      wallSet,
      mineSet,
      threatSet,
      itemByCell,
      ready,
      me.id,
      effBucket,
    ],
  );

  const startedMs = room.startedAt ? room.startedAt.toDate().getTime() : 0;
  const finishTime = (r: Racer) =>
    r.finished ? formatTime(r.finishedAt.toDate().getTime() - startedMs) : "";

  const finishers = [...racers]
    .filter((r) => r.finished)
    .sort((a, b) => a.finishRank - b.finishRank);

  const status = me.finished
    ? `finished #${me.finishRank}`
    : stunned
      ? "frozen"
      : ready
        ? "ready"
        : "…";

  return (
    <div className="board-wrap">
      <div className="hud">
        <span className="hud-piece" style={{ color: laneColor(me) }}>
          {GLYPHS[effPiece(me)] ?? "♟"} {me.name}
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

      {/* Held item + use control. */}
      <div className="item-bar">
        {me.heldItem ? (
          <button className="item-btn" onClick={onUseItem}>
            <span className="item-glyph">{ITEM_GLYPH[me.heldItem]}</span>
            Use: {ITEM_LABEL[me.heldItem]}
          </button>
        ) : (
          <span className="muted item-hint">
            Grab an item ({Object.values(ITEM_GLYPH).join(" ")}) by landing on
            it
          </span>
        )}
        {iAmQueen && <span className="queen-badge">♛ Queen!</span>}
      </div>

      {/* Fixed viewport; the track strip slides smoothly via transform. */}
      <div className="track-viewport">
        <div
          className="track-strip"
          style={{
            width: `${(TRACK_COLS / WINDOW) * 100}%`,
            gridTemplateColumns: `repeat(${TRACK_COLS}, 1fr)`,
            transform: `translateX(-${cameraCol}%)`,
          }}
        >
          {cells}
        </div>
      </div>

      <p className="muted fog-note">
        Fog: you see {VISION} ahead. <span className="legend-wall" /> wall ·{" "}
        <span className="pawn-mark mini">♟</span> pawn-mine (
        <span className="threat-text">red = danger</span>) ·{" "}
        <span className="item-promotion">♛</span>
        <span className="item-freeze">❄</span>💣 power-ups
      </p>

      {/* Full-track ladder so you can read the whole field's progress. */}
      <div className="ladder">
        {[...racers]
          .sort((a, b) => b.col - a.col)
          .map((r) => (
            <div className="ladder-row" key={r.id.toString()}>
              <span className="ladder-name" style={{ color: laneColor(r) }}>
                {GLYPHS[effPiece(r)] ?? "♟"} {r.name}
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
                  {GLYPHS[effPiece(r)] ?? "♟"}
                </span>
              </div>
              <span className="ladder-time">{finishTime(r)}</span>
            </div>
          ))}
      </div>

      {room.status === "finished" && (
        <div className="results">
          <h2>🏁 Results</h2>
          {finishers.map((r) => (
            <div className="result-row" key={r.id.toString()}>
              <span className="rank">#{r.finishRank}</span>
              <span className="result-name" style={{ color: laneColor(r) }}>
                {GLYPHS[r.piece] ?? "♟"} {r.name}
              </span>
              <span className="result-time">{finishTime(r)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
