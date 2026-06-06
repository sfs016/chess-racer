# ♞ Chess Race

A real-time multiplayer racing game where each player is a chess piece racing
down a 100-tile track, moving only by that piece's legal vectors — blocking,
dodging hazards, and navigating fog. Built on **SpacetimeDB** as the
authoritative real-time backend for the SpacetimeDB hackathon.

See [`../chess_race_prd.md`](../chess_race_prd.md) for the full product spec.

## Architecture

- **`spacetimedb/src/index.ts`** — the SpacetimeDB server module (WebAssembly,
  TypeScript). All game state lives in tables; all mutations go through reducers
  (transactional, deterministic, server-authoritative). There is no separate API
  server — the client subscribes to tables and calls reducers directly.
- **`src/`** — React + Vite client. `main.tsx` builds the `DbConnection`;
  `App.tsx` renders the lobby/race and drives reducers via `useReducer` /
  `useTable`.
- **`src/module_bindings/`** — generated client bindings. **Do not edit**;
  regenerate with `pnpm spacetime:generate`.

## Local development

```bash
pnpm install                     # once

# Terminal 1: local SpacetimeDB
spacetime start

# Terminal 2: publish the module + run the client
pnpm spacetime:publish:local     # build + publish module to local server
pnpm dev                         # Vite client at http://localhost:5173
```

`.env.local` points the client at `ws://localhost:3000` for development. After
changing the server module, re-run `pnpm spacetime:publish:local` and (if tables
or reducers changed) `pnpm spacetime:generate`.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server (client) |
| `pnpm build` | Typecheck + production client build |
| `pnpm test` | Vitest (render smoke test; no live DB needed) |
| `pnpm lint` | ESLint + Prettier check |
| `pnpm spacetime:build` | Build the server module |
| `pnpm spacetime:generate` | Regenerate client bindings from the module |
| `pnpm spacetime:publish:local` | Publish module to the local server |
| `pnpm spacetime:publish` | Publish module to Maincloud |

## Milestones

- [x] **M1** — Lobby: create/join rooms, piece select, lanes, presence, ready,
      host-start. Live room state synced across clients.
- [ ] **M2** — Board + server-authoritative movement (legal vectors, occupancy
      blocking, contested-tile resolution), finish detection.
- [ ] **M3** — Procedural seeded track: walls + pawn mines.
- [ ] **M4** — Quick Play + bots (scheduled tick), abandoned-room reaper.
- [ ] **M5** — Items (promotion / freeze / mine), fog polish, sound, animation.
- [ ] **M6** — Deploy: Maincloud backend + static frontend.
