# Chess Race PRD

## Product Summary
Chess Race is a real-time multiplayer racing game where each player controls a chess piece on a long horizontal track and can only move using that piece’s legal movement vectors. The game is designed around server-authoritative movement, blocking, fog-of-war, and a small set of readable hazards and items, which fits SpacetimeDB’s real-time shared-state model well.[cite:116][cite:19][cite:81]

## Goal
Build a polished, beautiful, playable web game for the SpacetimeDB hackathon that is:
- Immediately understandable in one sentence.
- Fun in a room with 4–8 players.
- Playable solo with bots.
- Fast enough for a 2–4 minute race.
- Small enough to ship in a hackathon window.

## Core Pitch
A real-time multiplayer chess race where each player is a chess piece, can only move with legal piece vectors, can only see 10 tiles ahead, and must navigate around walls, mines, fog, and other players who physically block occupied tiles.

## Audience
- Hackathon judges who want a clear SpacetimeDB use case.
- Casual players who can understand the game in under 20 seconds.
- Friends joining through a room code on laptops or phones.

## Success Criteria
- A first-time player can join a room and understand movement in under 30 seconds.
- A race with 4–8 players feels readable and competitive.
- The game avoids heavy grief loops or permanent losing states.
- The architecture clearly demonstrates server-side collision resolution and synchronized state.[cite:175][cite:116]

## Platform and Hosting
- Frontend: Next.js or React app deployed on Vercel with a custom domain.[cite:147][cite:150]
- Realtime backend: SpacetimeDB deployed separately as the authoritative game server and database, since Vercel is best used here for frontend hosting rather than long-lived realtime state coordination.[cite:165][cite:19]
- Shareable rooms: URL format like `/r/ABCD`.

## Match Format
| Element | Decision |
|---|---|
| Human players | 4–8 target |
| Total racers | Up to 8, with bots filling empty seats |
| Race duration | 2–4 minutes |
| Track size | 100 columns x 10 rows |
| Vision | 10 tiles ahead only |
| Join flow | Quick Play or room code |
| Input | Click highlighted move destination or keyboard cycle + confirm |

The game should cap at 8 total racers because readability and lane interaction are more important than raw concurrency in this design, even though SpacetimeDB can support much higher simultaneous real-time workloads.[cite:21][cite:175]

## Core Rules
### Pieces
Players choose one piece in the lobby:
- **Rook**: moves horizontally forward or vertically within the visible window; best on open lanes.
- **Knight**: moves in legal L-shapes; jumps over walls and other racers.
- **Bishop**: moves diagonally; strongest at weaving through staggered obstacles.

Movement should be derived from race-specific legal vectors rather than full orthodox chess state. `chess.js` is useful as a reference for move semantics and validation patterns, but the race should implement its own simpler forward-only vector rules in reducers.[cite:123][cite:126]

### Movement
- Only legal destinations within the next 10 visible columns are shown.
- Players cannot move backward.
- Occupied tiles are blocked; if a tile contains another racer, it is not a valid destination.
- If two players attempt the same open tile at the same time, the server accepts one move and rejects the other based on reducer order, preserving consistency.[cite:175][cite:178]
- A move triggers a short cooldown, targeted around 500–700ms.

### Visibility
- Each racer sees 10 tiles ahead of their current column.
- Tiles beyond that are hidden by hard fog.
- Hazards and obstacles outside vision are unknown.
- Fog is meant to create risk/reward without requiring complex blur states, which aligns with good fog-of-war design where hidden information should still leave room for meaningful decisions.[cite:115][cite:118][cite:122]

## Track Design
The track is procedurally seeded per room.

### Race phases
| Phase | Range | Purpose |
|---|---|---|
| Opening | 0–20 | Learn movement, low chaos |
| Midgame | 20–65 | Items, walls, and mines create contention |
| Endgame | 65–100 | More fog pressure, fewer freebies, tense finish |

This structure keeps the race from feeling flat and supports comeback moments without forcing nonstop punishment.[cite:111][cite:113]

## Hazards
MVP hazards are limited to two types for readability.

### 1. Wall
- Occupies a tile.
- Blocks rook and bishop pathing.
- Knight can jump over it.
- Cannot be landed on.

### 2. Pawn Mine
- Occupies one tile.
- Threatens its two forward-diagonal squares.
- If a racer lands on a threatened square, they are stunned briefly and knocked back 3 tiles.
- If a racer lands directly on the mine tile, the mine is captured and removed.
- Pawn Mines are common and readable.

### Optional hazard: Knight Mine
- Rare pickup or rare track hazard.
- Occupies one tile and threatens a small set of L-shaped landing squares within the visible region.
- If triggered, it causes a stronger setback than a Pawn Mine.
- Should be visually loud and limited in frequency to avoid clutter.

No bishop mines should be in v1 because long diagonal threat zones are too hard to read at race speed.

## Items
Keep item count small and distinct.

| Item | Effect | Notes |
|---|---|---|
| Promotion | Transform into a Queen temporarily | Most exciting power-up |
| Freeze | Briefly lock one target racer | Simple, readable interrupt |
| Mine | Drop a Pawn Mine behind or near current lane | Strategic area denial |

### Promotion
- Temporarily grants Queen movement for 6–10 seconds.
- Strongest comeback / overtaking tool.
- Very rare.

Item distribution should slightly favor trailing racers, following standard comeback-mechanic design where assistance narrows blowouts without making leading skill irrelevant.[cite:111][cite:112][cite:113]

## Bots
When fewer than 4 humans are present, fill with bots up to a minimum fun density.

### Bot types
- **Greedy bot**: maximize forward progress.
- **Cautious bot**: avoid fog-risky routes and mines.
- **Troll bot**: uses items opportunistically against leaders.

Bots do not need LLMs. Rule-based behavior is faster to build and more reliable for a hackathon game.

## Multiplayer and Rooms
- Quick Play joins the latest available public room.
- Create Room generates a short code.
- Shareable links go directly into the room.
- No login required.
- A player provides a display name and picks a piece.

A full server browser is out of scope for v1.

## UX and Visual Design
The game should look premium even with simple mechanics.

### Board and rendering
- Use Canvas for the race board and piece motion.
- Use a dark, polished board style with subtle gradients and glow.
- Use SVG piece art for crisp scaling.

OpenGameArt provides CC0 SVG chess pieces suitable for adaptation, and Lichess’s Chessground is a good source of interaction inspiration even though it is built for standard chessboard UI rather than a racing track.[cite:143][cite:146][cite:128]

### Pieces
- Use stylized SVG silhouettes for rook, knight, bishop, queen.
- Color-code player identity with outlines, glows, and badges rather than different piece designs per player.
- Ensure hazards visually differ from racers.

### Animation
- Canvas tweens for piece movement, impacts, and pickups.
- Motion for React for HUD transitions, lobby panels, countdowns, and result screens.[cite:161][cite:158][cite:167]
- Movement should feel snappy, not floaty: around 150–250ms translation with easing.

### Sound
- Use short, punchy interaction sounds for move confirm, blocked move, pickup, freeze, finish, and countdown.
- Use Howler.js for browser-safe audio playback and mixing.[cite:153][cite:155]
- Use Kenney UI Audio or related Kenney packs for safe, fast-start audio assets.[cite:132][cite:129][cite:135]

## Technical Architecture
### Frontend
- React or Next.js app.
- Canvas board renderer.
- Local prediction is optional; authoritative state comes from SpacetimeDB.

### Backend
- SpacetimeDB tables for rooms, racers, obstacles, items, and race state.
- Reducers for join room, start race, submit move, use item, bot tick, and finish race.
- Reducers validate legal vectors, fog constraints, occupancy, mine triggers, and item use.

SpacetimeDB is specifically built to keep application state in tables and mirror relevant state to connected clients in real time, which matches this game’s need for synchronized racer positions, hazards, and contested movement.[cite:175][cite:116][cite:81]

## Data Model (High Level)
| Table | Purpose |
|---|---|
| Room | Room code, seed, status, countdown |
| Racer | Player identity, piece type, position, cooldown, held item, bot flag |
| Obstacle | Walls and mines |
| ItemSpawn | Track item boxes / spawn points |
| RaceEvent | Optional feed of pickups, triggers, finish order |

## Out of Scope for v1
- Server browser
- Voice chat
- Spectator mode beyond simple watch state
- Bishop mines
- Full chess engine rules like check, checkmate, castling
- Multiple game modes
- Matchmaking rating

## Build Order
1. Room creation and join flow.
2. Core board render and fog window.
3. Piece selection and legal move highlighting.
4. Reducer-based movement with occupancy blocking.
5. Walls and Pawn Mines.
6. Quick Play and bots.
7. Items: Mine, Freeze, Promotion.
8. Sound, animations, HUD polish.
9. Deployment and custom domain.

## Launch Checklist
- Stable room creation and sharing.
- Smooth sync for 4–8 players.
- No desync on contested tiles.
- Track seed generates playable routes for all three piece types.
- Distinct audio/visual feedback for blocked move, trigger, item, and finish.
- Deployed frontend + live SpacetimeDB backend.

## Final Product Definition
Chess Race is a polished real-time web game where 4–8 players race across a foggy 100-tile chess track using authentic piece movement rules, physically blocking each other while navigating walls, mines, and a small set of high-impact power-ups. The game should feel fast, readable, replayable, and obviously powered by synchronized shared state.[cite:116][cite:19][cite:81]
