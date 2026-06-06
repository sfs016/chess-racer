import { useEffect, useRef, useState } from "react";
import "./App.css";
import Board from "./Board";
import HowToPlay from "./HowToPlay";
import { tables, reducers } from "./module_bindings";
import type { Racer, Room } from "./module_bindings/types";
import { useSpacetimeDB, useTable, useReducer } from "spacetimedb/react";
import {
  playCountdownBeep,
  playGo,
  playPowerup,
  playWin,
  playMove,
  setMuted,
  getMuted,
} from "./sound";
import { colorFor, colorName } from "./colors";

const PIECES = [
  { id: "rook", glyph: "♜", label: "Rook" },
  { id: "knight", glyph: "♞", label: "Knight" },
  { id: "bishop", glyph: "♝", label: "Bishop" },
  { id: "queen", glyph: "♛", label: "Queen" },
] as const;

const MOVE_COOLDOWN_MS = 600;
const NAME_KEY = "chess_race_name";

function glyphFor(piece: string): string {
  return PIECES.find((p) => p.id === piece)?.glyph ?? "♟";
}

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

function roomCodeFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("r") ?? "").toUpperCase();
}

function App() {
  const { identity, isActive: connected } = useSpacetimeDB();

  const [rooms] = useTable(tables.room);
  const [racers] = useTable(tables.racer);
  const [obstacles] = useTable(tables.obstacle);
  const [items] = useTable(tables.itemSpawn);

  const [name, setName] = useState(() => safeGet(NAME_KEY));
  const [piece, setPiece] = useState<string>("rook");
  const [bots, setBots] = useState(3);
  const [joinCode, setJoinCode] = useState(() => roomCodeFromUrl());
  const [error, setError] = useState<string | null>(null);
  const [showHowTo, setShowHowTo] = useState(false);
  const [muted, setMutedState] = useState(() => getMuted());

  const createRoom = useReducer(reducers.createRoom);
  const quickPlay = useReducer(reducers.quickPlay);
  const joinRoom = useReducer(reducers.joinRoom);
  const setRoomPiece = useReducer(reducers.setRoomPiece);
  const setBotCount = useReducer(reducers.setBotCount);
  const setReady = useReducer(reducers.setReady);
  const startRace = useReducer(reducers.startRace);
  const leaveRoom = useReducer(reducers.leaveRoom);
  const submitMove = useReducer(reducers.submitMove);
  const activateItem = useReducer(reducers.useItem);

  // A ticking clock so cooldown / countdown timers update smoothly.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (name) safeSet(NAME_KEY, name);
  }, [name]);

  const myRacer: Racer | undefined =
    identity && racers.find((r) => r.identity.isEqual(identity));
  const myRoom: Room | undefined = myRacer
    ? rooms.find((r) => r.code === myRacer.roomCode)
    : undefined;
  const status = myRoom?.status;
  const startsAtMs = myRoom?.startedAt?.toDate().getTime();

  // ── Sound effects (hooks must run before any early return) ──────────────────
  const beepSecRef = useRef<number | null>(null);
  useEffect(() => {
    if (status === "countdown" && startsAtMs) {
      const sec = Math.ceil((startsAtMs - now) / 1000);
      if (sec >= 1 && sec <= 5 && beepSecRef.current !== sec) {
        beepSecRef.current = sec;
        playCountdownBeep();
      }
    } else {
      beepSecRef.current = null;
    }
  }, [now, status, startsAtMs]);

  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevStatusRef.current === "countdown" && status === "racing") playGo();
    prevStatusRef.current = status;
  }, [status]);

  const wonRef = useRef(false);
  useEffect(() => {
    if (myRacer?.finished && !wonRef.current) playWin();
    wonRef.current = !!myRacer?.finished;
  }, [myRacer?.finished]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  };
  const muteBtn = (
    <button className="ghost mute-btn" onClick={toggleMute} title="Sound">
      {muted ? "🔇" : "🔊"}
    </button>
  );

  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  if (!connected || !identity) {
    return (
      <div className="screen center">
        <div className="logo">♞ Chess Racer</div>
        <p className="muted">Connecting…</p>
      </div>
    );
  }

  // ── Home: not in a room yet ────────────────────────────────────────────────
  if (!myRacer || !myRoom) {
    const canSubmit = name.trim().length > 0;
    return (
      <div className="screen center">
        {showHowTo && <HowToPlay onClose={() => setShowHowTo(false)} />}
        <div className="topbar">{muteBtn}</div>
        <div className="logo">♞ Chess Racer</div>
        <p className="tagline">
          Up to 10 players race the same chess piece down a 100-tile track. Move
          by its rules, dodge mines and walls, grab power-ups, reach the flag
          first.
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
            <span>Piece (host's pick is used by everyone)</span>
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

          <div className="field">
            <span>Bots (0 for a human-only race, max 9)</span>
            <div className="stepper">
              <button
                className="step-btn"
                onClick={() => setBots((b) => Math.max(0, b - 1))}
              >
                −
              </button>
              <span className="step-val">{bots}</span>
              <button
                className="step-btn"
                onClick={() => setBots((b) => Math.min(9, b + 1))}
              >
                +
              </button>
            </div>
          </div>

          <div className="home-actions">
            <button
              className="primary"
              disabled={!canSubmit}
              onClick={() => run(quickPlay({ name: name.trim(), piece, bots }))}
            >
              ⚡ Quick Play
            </button>
            <button
              className="secondary"
              disabled={!canSubmit}
              onClick={() =>
                run(createRoom({ name: name.trim(), piece, bots }))
              }
            >
              Create Room
            </button>
          </div>

          <button className="link-btn" onClick={() => setShowHowTo(true)}>
            How to play?
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
                run(joinRoom({ code: joinCode, name: name.trim() }))
              }
            >
              Join
            </button>
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="stdb-badge" tabIndex={0}>
          <span className="stdb-dot" /> Built with SpacetimeDB
          <span className="stdb-tip">
            Every move is a SpacetimeDB reducer; the database runs the game
            logic and syncs one authoritative board to all players live, so
            there is no separate game server and no desync on contested tiles.
          </span>
        </div>
      </div>
    );
  }

  // ── In a room ──────────────────────────────────────────────────────────────
  const roomRacers = racers
    .filter((r) => r.roomCode === myRoom.code)
    .sort((a, b) => (a.joinedAt.toDate() > b.joinedAt.toDate() ? 1 : -1));
  const humanCount = roomRacers.filter((r) => !r.isBot).length;
  const isHost = myRoom.host.isEqual(identity);
  const shareUrl = `${window.location.origin}${window.location.pathname}?r=${myRoom.code}`;

  // Racing / countdown / results view.
  if (status === "racing" || status === "finished" || status === "countdown") {
    const sinceLastMove = now - myRacer.lastMoveAt.toDate().getTime();
    const stunRemaining = myRacer.stunnedUntil.toDate().getTime() - now;
    const cooldownRemaining = Math.max(
      0,
      MOVE_COOLDOWN_MS - sinceLastMove,
      stunRemaining,
    );
    const roomObstacles = obstacles.filter((o) => o.roomCode === myRoom.code);
    const roomItems = items.filter((i) => i.roomCode === myRoom.code);
    const countdown =
      status === "countdown" && startsAtMs
        ? Math.max(0, Math.ceil((startsAtMs - now) / 1000))
        : 0;
    return (
      <div className="screen">
        {showHowTo && <HowToPlay onClose={() => setShowHowTo(false)} />}
        <div className="race-header">
          <div className="logo small">♞ Chess Racer</div>
          <span className="muted">Room {myRoom.code}</span>
          <button className="ghost" onClick={() => setShowHowTo(true)}>
            ?
          </button>
          {muteBtn}
          <button className="ghost" onClick={() => run(leaveRoom())}>
            Leave
          </button>
        </div>
        <div className="board-stage">
          <Board
            me={myRacer}
            racers={roomRacers}
            obstacles={roomObstacles}
            items={roomItems}
            room={myRoom}
            now={now}
            cooldownRemaining={cooldownRemaining}
            stunned={stunRemaining > 0}
            onMove={(row, col) => {
              playMove();
              run(submitMove({ toRow: row, toCol: col }));
            }}
            onUseItem={() => {
              playPowerup();
              run(activateItem());
            }}
          />
          {status === "countdown" && (
            <div className="countdown-overlay">
              <div className="countdown-num">{countdown || "GO!"}</div>
              <div className="countdown-sub">
                You are the{" "}
                <b style={{ color: colorFor(myRacer.colorIndex) }}>
                  {colorName(myRacer.colorIndex)} {glyphFor(myRoom.piece)}{" "}
                  {PIECES.find((p) => p.id === myRoom.piece)?.label}
                </b>
              </div>
            </div>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  // Lobby view.
  return (
    <div className="screen center">
      {showHowTo && <HowToPlay onClose={() => setShowHowTo(false)} />}
      <div className="topbar">
        <button className="ghost" onClick={() => setShowHowTo(true)}>
          How to play?
        </button>
        {muteBtn}
      </div>
      <div className="logo small">♞ Chess Racer</div>
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
              <span className="glyph">{glyphFor(myRoom.piece)}</span>
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
          <span>
            {isHost ? "Piece (everyone races this)" : "Piece - host chooses"}
          </span>
          <div className="piece-row">
            {PIECES.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={!isHost}
                className={`piece-btn ${myRoom.piece === p.id ? "selected" : ""}`}
                onClick={() => isHost && run(setRoomPiece({ piece: p.id }))}
              >
                <span className="glyph">{p.glyph}</span>
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>
            Bots {isHost ? "(0 for a human-only race)" : "(set by host)"}
          </span>
          <div className="stepper">
            <button
              className="step-btn"
              disabled={!isHost || myRoom.botCount <= 0}
              onClick={() => run(setBotCount({ count: myRoom.botCount - 1 }))}
            >
              −
            </button>
            <span className="step-val">{myRoom.botCount}</span>
            <button
              className="step-btn"
              disabled={!isHost || humanCount + myRoom.botCount >= 10}
              onClick={() => run(setBotCount({ count: myRoom.botCount + 1 }))}
            >
              +
            </button>
          </div>
          <p className="muted hint-sm">
            {humanCount} player{humanCount === 1 ? "" : "s"} +{" "}
            {Math.min(myRoom.botCount, 10 - humanCount)} bots ={" "}
            {humanCount + Math.min(myRoom.botCount, 10 - humanCount)} racers
          </p>
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
