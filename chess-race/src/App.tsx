import React, { useEffect, useState } from "react";
import "./App.css";
import { tables, reducers } from "./module_bindings";
import type { Racer, Room } from "./module_bindings/types";
import { useSpacetimeDB, useTable, useReducer } from "spacetimedb/react";

const PIECES = [
  { id: "rook", glyph: "♜", label: "Rook" },
  { id: "knight", glyph: "♞", label: "Knight" },
  { id: "bishop", glyph: "♝", label: "Bishop" },
] as const;

const TRACK_COLS = 100;
const NAME_KEY = "chess_race_name";

function glyphFor(piece: string): string {
  return PIECES.find((p) => p.id === piece)?.glyph ?? "♟";
}

// localStorage can throw (private mode, opaque origins in tests) — guard it.
function safeGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// Read a room code from the share URL (?r=CODE), if present.
function roomCodeFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("r") ?? "").toUpperCase();
}

function App() {
  const { identity, isActive: connected } = useSpacetimeDB();

  // useTable auto-subscribes; for the lobby the row counts are tiny.
  const [rooms] = useTable(tables.room);
  const [racers] = useTable(tables.racer);

  const [name, setName] = useState(() => safeGet(NAME_KEY));
  const [piece, setPiece] = useState<string>("rook");
  const [joinCode, setJoinCode] = useState(() => roomCodeFromUrl());
  const [error, setError] = useState<string | null>(null);

  const createRoom = useReducer(reducers.createRoom);
  const joinRoom = useReducer(reducers.joinRoom);
  const setPieceReducer = useReducer(reducers.setPiece);
  const setReady = useReducer(reducers.setReady);
  const startRace = useReducer(reducers.startRace);
  const leaveRoom = useReducer(reducers.leaveRoom);

  useEffect(() => {
    if (name) safeSet(NAME_KEY, name);
  }, [name]);

  // Surface reducer errors briefly.
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  if (!connected || !identity) {
    return (
      <div className="screen center">
        <div className="logo">♞ Chess Race</div>
        <p className="muted">Connecting…</p>
      </div>
    );
  }

  const myRacer: Racer | undefined = racers.find((r) =>
    r.identity.isEqual(identity),
  );
  const myRoom: Room | undefined = myRacer
    ? rooms.find((r) => r.code === myRacer.roomCode)
    : undefined;

  // ── Home: not in a room yet ────────────────────────────────────────────────
  if (!myRacer || !myRoom) {
    const canSubmit = name.trim().length > 0;
    return (
      <div className="screen center">
        <div className="logo">♞ Chess Race</div>
        <p className="tagline">
          Race a chess piece down a 100-tile track. Move by your piece's rules.
          Block, dodge, win.
        </p>

        <div className="card">
          <label className="field">
            <span>Display name</span>
            <input
              value={name}
              maxLength={20}
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="field">
            <span>Piece</span>
            <div className="piece-row">
              {PIECES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`piece-btn ${piece === p.id ? "selected" : ""}`}
                  onClick={() => setPiece(p.id)}
                >
                  <span className="glyph">{p.glyph}</span>
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          <button
            className="primary"
            disabled={!canSubmit}
            onClick={() => run(createRoom({ name: name.trim(), piece }))}
          >
            Create Room
          </button>

          <div className="divider">or join with a code</div>

          <div className="join-row">
            <input
              className="code-input"
              value={joinCode}
              maxLength={4}
              placeholder="ABCD"
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            />
            <button
              className="secondary"
              disabled={!canSubmit || joinCode.length < 4}
              onClick={() =>
                run(joinRoom({ code: joinCode, name: name.trim(), piece }))
              }
            >
              Join
            </button>
          </div>
        </div>

        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  // ── In a room ──────────────────────────────────────────────────────────────
  const roomRacers = racers
    .filter((r) => r.roomCode === myRoom.code)
    .sort((a, b) => (a.joinedAt.toDate() > b.joinedAt.toDate() ? 1 : -1));
  const isHost = myRoom.host.isEqual(identity);
  const shareUrl = `${window.location.origin}${window.location.pathname}?r=${myRoom.code}`;

  // Racing view (placeholder board — full canvas board lands in M2).
  if (myRoom.status === "racing" || myRoom.status === "finished") {
    const ladder = [...roomRacers].sort((a, b) => b.col - a.col);
    return (
      <div className="screen">
        <div className="race-header">
          <div className="logo small">♞ Chess Race</div>
          <span className="muted">Room {myRoom.code}</span>
          <button className="ghost" onClick={() => run(leaveRoom())}>
            Leave
          </button>
        </div>
        <div className="track-list">
          {ladder.map((r) => (
            <div className="track-row" key={r.id.toString()}>
              <div className="track-label">
                <span className="glyph">{glyphFor(r.piece)}</span>
                {r.name}
                {r.identity.isEqual(identity) && (
                  <span className="you">you</span>
                )}
              </div>
              <div className="track-bar">
                <div
                  className="track-fill"
                  style={{ width: `${(r.col / (TRACK_COLS - 1)) * 100}%` }}
                />
                <span
                  className="track-piece"
                  style={{ left: `${(r.col / (TRACK_COLS - 1)) * 100}%` }}
                >
                  {glyphFor(r.piece)}
                </span>
              </div>
              <div className="track-col">{r.col}</div>
            </div>
          ))}
        </div>
        <p className="muted center-text">
          Movement arrives in M2 — this is the live position ladder, synced from
          the server.
        </p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  // Lobby view.
  return (
    <div className="screen center">
      <div className="logo small">♞ Chess Race</div>
      <div className="card">
        <div className="room-code">
          <span className="muted">Room code</span>
          <div className="code-big">{myRoom.code}</div>
          <button
            className="ghost"
            onClick={() => navigator.clipboard?.writeText(shareUrl)}
          >
            Copy invite link
          </button>
        </div>

        <div className="roster">
          {roomRacers.map((r) => (
            <div className="roster-row" key={r.id.toString()}>
              <span className="glyph">{glyphFor(r.piece)}</span>
              <span className="roster-name">
                {r.name}
                {r.identity.isEqual(identity) && (
                  <span className="you">you</span>
                )}
                {r.identity.isEqual(myRoom.host) && (
                  <span className="host">host</span>
                )}
              </span>
              <span className={`dot ${r.online ? "on" : "off"}`} />
              <span className={`ready ${r.ready ? "is-ready" : ""}`}>
                {r.ready ? "Ready" : "…"}
              </span>
            </div>
          ))}
        </div>

        <div className="field">
          <span>Your piece</span>
          <div className="piece-row">
            {PIECES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`piece-btn ${
                  myRacer.piece === p.id ? "selected" : ""
                }`}
                onClick={() => run(setPieceReducer({ piece: p.id }))}
              >
                <span className="glyph">{p.glyph}</span>
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="lobby-actions">
          <button
            className={myRacer.ready ? "secondary" : "primary"}
            onClick={() => run(setReady({ ready: !myRacer.ready }))}
          >
            {myRacer.ready ? "Not ready" : "Ready"}
          </button>
          {isHost && (
            <button
              className="primary"
              disabled={roomRacers.length < 1}
              onClick={() => run(startRace({ code: myRoom.code }))}
            >
              Start Race
            </button>
          )}
          <button className="ghost" onClick={() => run(leaveRoom())}>
            Leave
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default App;
