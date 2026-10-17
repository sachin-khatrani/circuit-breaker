# 01 — Architecture

CIRCUIT BREAKER is a browser racing game for 2–8 players. Players race anti-gravity cars
around a neon circuit and spend **Energy** to change the track while they race. This document
covers the system architecture. The other documents in `docs/` cover design, networking,
rendering, physics, the milestone plan, and persistent profiles and ranking (`08-ranking.md`).

## 1. Guiding principles

1. **The server is the referee.** Identity, race state, start, checkpoints, laps, finish order,
   Energy, abilities, track events, results and ratings are decided by the server. Clients send
   *intent* (input), never *outcomes*.
2. **One simulation, two hosts.** The race rules and vehicle physics live in a pure TypeScript
   package (`@circuit-breaker/shared`) with no DOM, three.js or Node dependencies. The server
   runs it authoritatively. The client runs the same code to predict its own car. In solo mode
   it runs the whole race locally.
3. **Fixed timestep, integer ticks.** The simulation advances in 1/60 s ticks. All timers are tick
   counts. Rendering is decoupled and interpolates between ticks, so frame rate never changes
   gameplay.
4. **The renderer is a view.** React Three Fiber components read simulation state and draw it.
   They never own gameplay state. Per-frame data does not go through React state.
5. **Procedural over downloaded.** The track, city, car, signage and effects are generated at
   load time from code and data. No 3D asset pipeline, no CDN fetches, fast first load.

## 2. System overview

```
                         ┌──────────────────────────────────────────────────────────┐
                         │                @circuit-breaker/shared (pure TS)         │
                         │  track/  spline → sampled Track, projection, gates, grid │
                         │  sim/    stepVehicle, RaceSimulation, rules, autopilot   │
                         │  math/   scalar + vector helpers                         │
                         └───────────────▲───────────────────────────▲──────────────┘
                                         │ imports                    │ imports
  ┌──────────────────────────────────────┴──────┐        ┌───────────┴─────────────────────────────┐
  │ apps/client  (browser)                       │        │ apps/server  (Node)                     │
  │                                              │        │                                         │
  │  InputManager ──► Session ──► RaceSimulation │ Socket │  Socket.IO ──► RoomManager ──► Room     │
  │  (keys, pad)     (solo | online: Predictor)  │  .IO   │   fixed 60 Hz loop: inputs → sim.step   │
  │       │                │                     │◄──────►│   snapshots 20 Hz, events (reliable)    │
  │       ▼                ▼                     │ inputs │   validation, rate limits, results      │
  │  zustand store    R3F scene (three.js)       │ snaps  │                                         │
  │  (screens, HUD)   track · cars · city · FX   │ events │  HTTP /health, static client, smoke run │
  │                                              │  HTTP  │  /api: profiles, leaderboard ──┐        │
  │  profile, leaderboard (fetch /api) ◄─────────┼───────►│  RankingService ◄── finished races     │
  └──────────────────────────────────────────────┘        └──────────────────────│──────────────────┘
                                                                                  ▼
                                                                PostgreSQL: profiles, sessions,
                                                                rated races (08-ranking.md)
```

### 2.1 Responsibilities

| Concern                         | Server (authoritative)                    | Client                                          |
|---------------------------------|-------------------------------------------|-------------------------------------------------|
| Player identity, room seat      | Assigns ids, validates names              | Displays                                        |
| Car (colour and body style)     | Checks the choice exists and the colour is free | Picker and preview; remembers the last pick |
| Race start / countdown          | Schedules `goTick`                        | Shows countdown from the server clock           |
| Vehicle state                   | Simulates from inputs                     | Predicts own car, interpolates others           |
| Checkpoints, laps, finish order | Gate crossings in the sim                 | Shows the server's events and standings         |
| Energy                          | Pickups, drift charge, spend              | Shows; never sends an Energy value              |
| Abilities and track events      | Validates cost, cooldown, target; schedules activation tick | Sends a request; renders the scheduled event |
| Results and session points      | Classifies, scores each race once, keeps the session standings | Renders them; ready check for the next race; the host races again or returns to the lobby |
| Profile and global rating       | Makes anonymous profiles, binds seats by single-use ticket, rates each race once in a transaction | Shows the profile, the leaderboard and confirmed rating changes; holds only an HTTP-only cookie |
| Camera, effects, audio, UI      | —                                         | All of it                                       |

The client never sends position, lap, finish, Energy, ability outcomes, results, points or
ratings. The server ignores any field it does not expect (see `04-networking.md` §10 and §9b,
and `08-ranking.md` §7).

## 3. The session abstraction

The renderer and HUD talk to a **session**, never to the network or the simulation directly.

```
interface RaceSessionView {          // what rendering and HUD consume
  track: Track
  phase / countdown / race clock
  racers: interpolated render state per racer (pos, yaw, speed, boost, drift, energy…)
  local racer: lap, checkpoint, timers, Energy, standings
  events: subscribe(listener)         // checkpoint, lap, cell, wall hit, finish…
}
```

| Mode                  | Since  | Simulation owner | Local car                                  | Other cars                          |
|-----------------------|--------|------------------|--------------------------------------------|-------------------------------------|
| `GameSession`, solo   | Step 1 | Client           | Simulated locally                          | —                                   |
| `GameSession`, online | Step 4 | Server           | Predicted (`Predictor`), re-based on every snapshot | Interpolated from snapshots (`RemoteTrack`) |

One `GameSession` runs both modes. Online, it holds an `OnlineRace` (`game/online.ts`): the
shared `Predictor` for the local car, the input lead, and the remote cars' snapshot history.
The scene and HUD read the same surface either way:

* `render`, `racer` and `remotes`
* the event channels: `onEvent` for the local car and the race, `onRemoteEvent` for everyone
  else, and `onFeed` for announcements (ability uses and track changes; online, only the
  server's events)
* the track state, `sim.course` (the shortcut and the gate), read by the scene and the HUD on
  the local car's timeline
* the store

Online, the server's numbers (position, laps, best lap, standings) replace the local ones.

## 4. Client architecture

```
main.tsx
 └─ App                       screens: menu (landing page over the attract mode), lobby, race;
     │                        overlays: pause (solo), race menu (online), results, controls
     ├─ GameCanvas            <Canvas> stays mounted for the whole app lifetime
     │   ├─ SimDriver         useFrame(-3): session.update(dt) (solo accumulator, or online
     │   │                    prediction on the server's timeline)
     │   ├─ CameraRig         useFrame(-1): intro / chase / finish / attract cameras
     │   ├─ World             sky, fog, lights, city, reactor, track, gates, cells, the
     │   │                    Needle and the split (RouteScene)
     │   ├─ PlayerCar         procedural car in the player's colour and body style, trails,
     │   │                    thruster, drift FX
     │   ├─ RemoteCars        other players' cars from snapshots, name tags, ghost fade
     │   ├─ PostFx            bloom, chromatic aberration (boost), vignette, tone mapping
     │   └─ ShaderWarmup      compiles every material at load and at each race start
     └─ HUD (DOM)             speed, Energy, ability slots, race feed, laps, position, timers,
                              minimap, standings, race-start card, countdown, banners,
                              connection warning
```

* **Frame order.** R3F `useFrame` priorities run the simulation first (`-3`), then the
  visual objects (`-2`), then the camera (`-1`). The effect composer renders last (`1`).
* **State channels.**
  * *Per-frame values* (speed, Energy, timers, minimap dot) are read from the session in
    `requestAnimationFrame` hooks and written straight to DOM refs. No React re-render.
  * *Discrete UI state* (screen, phase, lap, countdown number, banners, results, settings)
    lives in a small zustand store. The session updates it only when a value changes.
* **Input.** `InputManager` merges keyboard and Gamepad API state into one `PlayerInput`
  per tick. It smooths keyboard steering, applies stick dead zones and detects edge actions
  (pause, reset, mute). A key tap is held until a simulation tick has read it, so a tap shorter
  than a frame is never lost; boost bursts and abilities fire on such press edges inside the
  sim. An ability press (key or HUD tap) stays down for 6 ticks, so online a late input frame
  cannot lose it (see `04-networking.md` §5). Touch driving controls plug in here later.
* **Audio.** `game/audio.ts` synthesises the engine and all effects with WebAudio from the
  interpolated car state and the race events. It is created on the first user gesture and
  reads volume and mute from the store.
* **Quality tiers.** Low, Medium and High set the DPR cap, SMAA, bloom resolution, city
  density and particle budgets. drei's `PerformanceMonitor` drops the canvas to DPR 1 while the
  frame rate stays low and restores the tier's cap when it recovers.
* **Network.** `net/connection.ts` owns the one Socket.IO connection. It handles:
  * requests with acknowledgements
  * input packets
  * clock sync
  * the seat token (sessionStorage), which resumes a seat after a drop or a reload

  `game/multiplayer.ts` turns server messages into store state and session calls. It only ever
  asks the server, and shows what the server answers.

## 5. Server architecture

```
index.ts             HTTP server (/health, /ready, /metrics, /api, the built client in production)
                     + Socket.IO; one-time graceful shutdown; process error handlers
ops.ts               liveness, readiness (dependencies), metrics (loopback or METRICS_TOKEN)
log.ts, metrics.ts   JSON-line logs with error ids; counters and 10 s timing histograms
config.ts            port, host, snapshot rate, reconnect grace, room and connection caps,
                     database, logs (environment)
api/http.ts          the ranking API: cookies, CORS, origin checks, body limits, rate limits
db/                  the pg pool, migrations (with a CLI: dbcli.ts), error classification
ranking/             profiles and tickets (identity.ts, service.ts), SQL (store.ts), the race
                     rating queue: one transaction per race, retried while the database is away
static.ts            static files with hashed-asset caching and an SPA fallback
net/socketServer.ts  admits connections (own page only, per-address and total caps), budgets
                     every message, validates every payload, binds each connection to its own
                     seat, guards every handler
net/rateLimit.ts     token buckets (messages, requests, inputs, connections, room creation)
rooms/RoomManager.ts rooms by code, seats by token, one seat per profile, the 4 ms loop over
                     all rooms (a room that throws is closed alone)
rooms/Room.ts        lobby rules, host, the race: tick-stamped inputs → RaceSimulation,
                     snapshots, public events, results, grace periods
rooms/ids.ts         room codes, seat tokens and player ids from node:crypto
smoke.ts             the headless autopilot lap run on boot
scripts/             harness.ts (18 scenarios over real sockets, bad links included), load.ts
                     (load levels against the built server), netem.ts (a TCP proxy that
                     degrades a link), dbbench.ts (leaderboard queries at 100,000 profiles)
```

One Node process hosts many rooms. Each room steps its own `RaceSimulation` from its race's
start timestamp, so a room never drifts from the server clock. Rooms stay in memory; only
profiles and rated races go to PostgreSQL, and a room never waits for it: a finished race is
handed to the ranking service, whose answer reaches the room later (`08-ranking.md`). On boot
the server runs a headless smoke race, in which the shared autopilot drives a lap, and reports
its cost per tick on `/health`.

Operations (Step 9, `09-security-audit.md`): `/health` answers while the process runs;
`/ready` reports the simulation, the database, rooms and connections against their caps, and
answers 503 while the server shuts down; `/metrics` gives counts and timings of the last 10 s
(CPU, event loop, tick lateness, snapshots, connections and refusals, database and API
latency) to the server's own machine or with `METRICS_TOKEN`. Logs are one JSON object per
line in production; a failure a player sees carries an error id that matches its log line,
and no log line or answer carries a token, a cookie, a recovery code or the database URL.

## 6. Technology choices

| Area              | Choice                                    | Why                                                                                  |
|-------------------|-------------------------------------------|--------------------------------------------------------------------------------------|
| UI framework      | React 19 + TypeScript                     | Menus, HUD and screens are UI; one language end to end                               |
| Build             | Vite 8                                    | Fast HMR, first-class TS, handles the TS-source workspace package                    |
| 3D                | three.js r186 via React Three Fiber 9     | Declarative scene composition, the `useFrame` loop, drei helpers; raw three.js where performance matters |
| Helpers           | drei (Environment/Lightformer, PerformanceMonitor) | Local reflection probe with no HDR download; adaptive DPR                   |
| Post-processing   | `@react-three/postprocessing`             | Mipmap bloom is what makes the neon read; merged effect passes                       |
| UI styling        | Tailwind CSS 4 + a small HUD stylesheet   | Utility layout plus hand-tuned glow, clip-path panels                                |
| UI state          | zustand                                   | Tiny; usable from outside React (the session writes to it)                           |
| Fonts             | Orbitron + Rajdhani via `@fontsource`     | Bundled locally; also used to draw the in-world holographic signs                    |
| Physics           | Custom arcade model in `shared`           | Deterministic, server-runnable, tunable feel. A rigid-body engine adds cost and nondeterminism without helping an arcade racer |
| Multiplayer       | Socket.IO 4.8                             | Rooms, acks, reconnection; the browser uses the WebSocket transport only            |
| Server            | Node 22 + TypeScript; esbuild bundle      | Same language as the sim; `tsx watch` in development                                 |
| Tests             | Vitest                                    | Simulation rules, netcode, rooms and real sockets; plus a real-time bot harness      |

**No heavy engine.** Babylon, PlayCanvas or Unity WebGL would duplicate what three.js already
does. They would also hide the render loop that the network session needs to control. A
rigid-body engine (Rapier, cannon-es) makes an arcade racer harder to tune. Its results also
depend on float details that the server and client would have to match.

## 7. Monorepo and build

* **npm workspaces**: `packages/shared`, `apps/client`, `apps/server`.
* **Internal TS-source package.** `@circuit-breaker/shared` exports `src/index.ts` directly.
  Vite compiles it for the client, `tsx` runs it in server development, and esbuild bundles it
  into `apps/server/dist/index.js` for production. No build step or watcher for shared.
* **Dependency rule.** `shared` imports nothing from the apps and has no runtime dependencies.
  The client and server import `shared` but never each other.
* **Commands** (repository root):

| Command             | What it does                                                    |
|---------------------|-----------------------------------------------------------------|
| `npm run dev`       | Vite dev server for the client (http://localhost:5173); proxies `/socket.io` to the game server |
| `npm run dev:server`| Game server with `tsx watch` (http://127.0.0.1:3001/health)     |
| `npm run typecheck` | `tsc` on every workspace                                        |
| `npm run lint`      | ESLint (type-aware typescript-eslint, React hooks rules)        |
| `npm test`          | Vitest: shared simulation and netcode, server rooms and sockets |
| `npm run build`     | Typecheck shared, build the client (Vite) and server (esbuild)  |
| `npm start`         | The built server: client and Socket.IO on one port              |
| `npm run harness -w @circuit-breaker/server` | Real-time multiplayer harness (`04-networking.md` §11) |
| `npm run check`     | Typecheck, lint, tests and build                                |

TypeScript is pinned to `~6.0.3` because typescript-eslint 8.71 supports TypeScript below
6.1. `noUncheckedIndexedAccess` is off on purpose: the simulation indexes typed arrays in hot
loops, and the flag would put a non-null assertion on every sample read.

## 8. Deployment

One Node process serves the built client as static files plus Socket.IO on a single port:
`npm run build`, then `npm start`. `PORT` and `HOST` come from the environment, and production
listens on `0.0.0.0` by default. A Render or Railway web service is enough, with no database
or Redis. Rooms live in memory, and a restart ends live races. That is acceptable for a
competition build. Scaling out later means sticky sessions and routing rooms to processes (see
`04-networking.md` §12).

## 9. Risks and mitigations

| Risk                                   | Mitigation                                                                    |
|----------------------------------------|-------------------------------------------------------------------------------|
| Arcade physics feels floaty or twitchy | Every constant lives in `shared/src/sim/config.ts`; tests report 0–100 time and corner speeds |
| Neon look costs too much GPU           | Instancing, emissive + bloom instead of real lights, quality tiers, adaptive DPR |
| Prediction errors in multiplayer       | Same sim code on both sides; inputs predicted exactly as quantised; ghost cars (no contact); smoothed corrections |
| Track edits feel unfair under latency  | Every track event is scheduled for a future tick and telegraphed (≥ 0.75 s)   |
| Scope creep                            | Milestones with acceptance criteria (`07-milestones.md`), stop after each step |
