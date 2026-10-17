# 03 — Folder Structure

```
racing_game/
├─ package.json              npm workspaces root; scripts: dev, dev:server, typecheck, lint, test, build, start, check
├─ tsconfig.base.json        strict TS shared by every workspace (bundler resolution, noEmit)
├─ eslint.config.js          flat config: typescript-eslint (type-aware), react-hooks, react-refresh, prettier
├─ .prettierrc.json, .editorconfig, .gitattributes, .gitignore
├─ .env.example              every server setting, without values (.env itself is git-ignored)
├─ Dockerfile                production image: builds client and server, runs the server as `node`
├─ .dockerignore             only source goes into the build (never .env, node_modules or dist)
├─ render.yaml               Render Blueprint: one Docker web service and its PostgreSQL database
├─ README.md, DEMO.md        the submission README; the two-minute demo script and checklist
├─ docs/                     the design documents (this folder); step6/ holds before/after
│                            images, media/ the README screenshots
│
├─ packages/
│  └─ shared/                @circuit-breaker/shared: pure TypeScript, no DOM/three/Node APIs
│     ├─ src/
│     │  ├─ index.ts         public surface (re-exports)
│     │  ├─ math/
│     │  │  ├─ scalar.ts     clamp, lerp, damp (frame-rate independent), angle helpers, mod
│     │  │  └─ vec.ts        plain-data vector types
│     │  ├─ track/
│     │  │  ├─ types.ts      TrackDefinition (authoring, shortcuts and splits included) + runtime
│     │  │  │                frame/projection/gate/portal types
│     │  │  ├─ spline.ts     centripetal Catmull-Rom, uniform arc-length resampling
│     │  │  ├─ track.ts      Road (main loop or branch), BranchRoad, Track: typed-array samples,
│     │  │  │                frames, projection, portals, the split, gates, cells, grid
│     │  │  └─ tracks/
│     │  │     └─ gridZero.ts  the Grid Zero layout (3.01 km), checkpoints, Energy cells, pads,
│     │  │                     lanes, the Needle and the Overload split
│     │  ├─ sim/
│     │  │  ├─ config.ts     TICK_RATE, VEHICLE_TUNING, RACE_RULES: every tunable number
│     │  │  ├─ input.ts      PlayerInput, sanitizeInput (the only client → server payload)
│     │  │  ├─ course.ts     CourseState: the shortcut and gate timeline; ability ids, costs
│     │  │  ├─ vehicle.ts    VehicleState, stepVehicle (arcade physics), placeVehicle
│     │  │  ├─ race.ts       RaceSimulation: countdown, launch, gates, laps, finish ranking
│     │  │  │                (sub-tick), retirements, cells, standings, race end
│     │  │  ├─ events.ts     RaceEvent union (checkpoint, lap, finish, cell, wallHit, ability…)
│     │  │  └─ autopilot.ts  pure-pursuit driver + speed profile (attract mode, tests, bots);
│     │  │                   split lanes and the Needle
│     │  ├─ session/         rules of a session of races, shared by server and client
│     │  │  ├─ results.ts    classifyRacers (finishers, then racing, then left; ties by slot),
│     │  │  │                raceStats (the stats the results show)
│     │  │  └─ scoring.ts    POINTS_TABLE, DNF_POINTS, racePoints; session order and grid order
│     │  ├─ ranking/         the global rating, shared by server and client
│     │  │  ├─ rating.ts     RATING_RULES, rateRace: multiplayer Elo (pure; the server applies it)
│     │  │  └─ types.ts      ranking API answers, RaceRating, profile tags
│     │  └─ net/             the multiplayer protocol, shared by client and server
│     │     ├─ protocol.ts   constants, message types, event names, nickname/code validators,
│     │     │                colours and body styles (isVehicleChoice)
│     │     ├─ codec.ts      input frames and packets, snapshot rows, the predicted car state
│     │     ├─ clock.ts      ClockSync (server clock estimate), InputLead (how far ahead to run)
│     │     ├─ interpolation.ts  RemoteTrack: snapshot history and Hermite interpolation
│     │     └─ predictor.ts  Predictor: local-car prediction, re-base and replay
│     └─ test/               Vitest: track validity, projection, vehicle model, race rules,
│                            gameplay, netcode (net.test.ts: networked races over a fake link),
│                            abilities (abilities.test.ts), results and scoring (session.test.ts),
│                            the rating (rating.test.ts)
│
├─ apps/
│  ├─ client/                @circuit-breaker/client: React 19 + Vite 8 + React Three Fiber 9
│  │  ├─ index.html, vite.config.ts, tsconfig.{json,app.json,node.json}
│  │  ├─ public/favicon.svg
│  │  └─ src/
│  │     ├─ main.tsx         fonts, styles, React root
│  │     ├─ App.tsx          screen routing (menu / lobby / race / overlays / sheets),
│  │     │                   global key actions, seat resume and profile read on load
│  │     ├─ env.d.ts         VITE_SERVER_URL (only for a client on another origin)
│  │     ├─ styles.css       Tailwind 4 theme + HUD/menu component styles
│  │     ├─ net/
│  │     │  ├─ connection.ts NetClient: the Socket.IO connection, requests, inputs out,
│  │     │  │                snapshots in, clock sync, seat token, dev latency injector
│  │     │  └─ api.ts        the ranking API over fetch (the cookie travels by itself)
│  │     ├─ game/            non-visual client logic
│  │     │  ├─ session.ts    GameSession: solo fixed-step loop, or online prediction on the
│  │     │  │                server's timeline; interpolation, correction smoothing, UI publish
│  │     │  ├─ online.ts     OnlineRace: Predictor, input lead, remote cars, standings
│  │     │  ├─ multiplayer.ts  rooms and lobby actions, server messages → store and session
│  │     │  ├─ profile.ts    this browser's profile: read, made on the first online race, seat
│  │     │  │                tickets, rename, recovery; the leaderboard and profile sheets
│  │     │  ├─ input.ts      InputManager: keyboard + Gamepad API → PlayerInput; taps are held
│  │     │  │                until a simulation tick has read them, ability presses for 6 ticks
│  │     │  ├─ audio.ts      WebAudio synth: engine, wind, boost hiss, skid, race one-shots
│  │     │  ├─ config.ts     RACE_CONFIG: laps, starting Energy, dev URL switches
│  │     │  ├─ store.ts      zustand store for discrete UI state (screen, phase, lap, results…)
│  │     │  ├─ actions.ts    start race, pause/resume, menu, quality, sound, motion
│  │     │  ├─ settings.ts   quality presets, sound and reduced-motion settings, the last car
│  │     │  │                picked, persistence
│  │     │  ├─ records.ts    local personal bests
│  │     │  ├─ palette.ts    colour language shared by scene and HUD
│  │     │  └─ format.ts     time and speed formatting
│  │     ├─ scene/           everything inside the WebGL canvas
│  │     │  ├─ GameCanvas.tsx   <Canvas>, adaptive DPR, debug bridge (dev only)
│  │     │  ├─ SimDriver.tsx    useFrame(-3): advances the session, then the engine sound
│  │     │  ├─ World.tsx        lights, fog, reflection probe, all world components
│  │     │  ├─ CameraRig.tsx    intro / chase / finish / attract cameras, shake, FOV
│  │     │  ├─ PostFx.tsx       bloom, chromatic aberration, vignette, tone mapping, SMAA
│  │     │  ├─ DebugBridge.tsx  window.__cb in development (session, input, renderer stats, course)
│  │     │  ├─ ShaderWarmup.tsx compiles every material up front, so nothing compiles mid-race
│  │     │  ├─ track/           road/deck/rail/barrier geometry, road, barrier and pulse
│  │     │  │                   shaders, arches and gates (instanced boxes), start gantry,
│  │     │  │                   Energy cells, the tunnel (tunnelGeometry.ts), track signs,
│  │     │  │                   boost pads and speed lanes (TrackZones.tsx), the Needle and the
│  │     │  │                   split with their barriers, signs and arrows (RouteScene.tsx,
│  │     │  │                   routeMaterials.ts), corner chevron boards (TurnMarkers.tsx)
│  │     │  ├─ environment/     sky, ground grid, procedural city, reactor, billboards,
│  │     │  │                   searchlights, sky traffic, hologram material, city planner
│  │     │  ├─ vehicle/         procedural wheeled car (merged parts) with three body kits,
│  │     │  │                   PlayerCar (wheels, suspension, lights, exhausts, trails, drift FX),
│  │     │  │                   RemoteCars (other players from snapshots, name tags, ghost fade)
│  │     │  ├─ fx/              particle pool + renderer, light trails, drift marks, speed lines,
│  │     │  │                   race-moment effects (RaceFx.tsx), neon dust (Motes.tsx)
│  │     │  ├─ shaders/chunks.ts   shared GLSL (noise, hex grid, additive fog)
│  │     │  ├─ textures.ts      canvas-drawn glow/fade textures and the sign atlas
│  │     │  └─ random.ts        seeded PRNG for deterministic scenery
│  │     └─ ui/              DOM overlay
│  │        ├─ Hud.tsx       HUD layout
│  │        ├─ hud/          LapPanel, PositionPanel, TimePanel, BoostMeter, AbilityBar, RaceFeed,
│  │        │                ControlsHint, MiniMap, Countdown, Banners, Warnings, ScreenFlash,
│  │        │                FinishOverlay, Standings, ConnectionWarning, RaceIntro,
│  │        │                FirstRaceHint (a first-race coach over the ability slots),
│  │        │                TouchDrivingNote (touch screens: driving needs keys or a gamepad)
│  │        ├─ screens/      MainMenu (the landing page: nickname, create and join), PauseMenu,
│  │        │                ResultsScreen, ControlsOverlay, Lobby, OnlineResults, RaceMenu
│  │        ├─ online/       ResultsTable, RaceStatsTable, AbilityLog, AfterRaceControls,
│  │        │                VehiclePicker, CarGlyph, ConnectionStatus, PlayerSwatch
│  │        ├─ ranking/      Leaderboard, ProfileSheet, ProfileStrip (title screen),
│  │        │                RatingRules (how rating works; points vs rating), rankingFormat
│  │        ├─ SettingsControls.tsx   sound (on/off, volume) and reduce-motion controls
│  │        └─ useAnimationFrame.ts   per-frame DOM updates without React renders
│  │
│  └─ server/                @circuit-breaker/server: Node 22 + TypeScript + Socket.IO 4.8
│     ├─ build.mjs           esbuild bundle (workspace packages inlined, npm deps external)
│     ├─ vitest.config.mjs   test timeout 15 s (the first PGlite start in a file takes ~5 s)
│     ├─ src/
│     │  ├─ index.ts         HTTP server (/health, /ready, /metrics, /api, the built client in
│     │  │                   production), Socket.IO, room loop, ranking service, graceful
│     │  │                   shutdown, process error handlers
│     │  ├─ ops.ts           /health (liveness), /ready (dependencies), /metrics (loopback or
│     │  │                   METRICS_TOKEN)
│     │  ├─ log.ts           structured logs (JSON lines in production), error ids
│     │  ├─ metrics.ts       counters and 10-second histograms: ticks, snapshots, connections,
│     │  │                   messages, event loop, CPU, database and API timings
│     │  ├─ dbcli.ts         database chores: migrate, status, rollback --confirm
│     │  ├─ config.ts        PORT, HOST, SNAPSHOT_RATE, RECONNECT_GRACE, MAX_ROOMS, CORS_ORIGIN,
│     │  │                   MAX_CONNECTIONS(_PER_IP), LOG_FORMAT, METRICS_TOKEN, DATABASE_URL
│     │  │                   and the other database and cookie settings
│     │  ├─ static.ts        static file handler (hashed-asset caching, SPA fallback)
│     │  ├─ smoke.ts         headless autopilot lap through the shared sim on boot
│     │  ├─ api/
│     │  │  └─ http.ts       the ranking API: routes, cookies, CORS, origin checks, rate limits
│     │  ├─ db/
│     │  │  ├─ db.ts         Db interface; the pg pool with timeouts
│     │  │  ├─ pglite.ts     the same interface on PGlite (tests and the harness only)
│     │  │  ├─ migrations.ts the schema (SQL), the migration runner, rollback and status
│     │  │  └─ errors.ts     permanent or retryable failures; safe log lines
│     │  ├─ ranking/
│     │  │  ├─ identity.ts   profile ids, session tokens, recovery codes, tickets, hashing
│     │  │  ├─ store.ts      every SQL statement: profiles, sessions, leaderboard, rated races
│     │  │  ├─ service.ts    RankingService: identity, tickets, leaderboard, the rating queue
│     │  │  └─ types.ts      SeatProfile, CompletedRace, RaceRatingSink (what rooms see)
│     │  ├─ net/
│     │  │  ├─ socketServer.ts  admission (origin, connection caps), message budgets, payload
│     │  │  │                validation, seat binding, tickets, guarded handlers, snapshots
│     │  │  ├─ clientAddress.ts the client address and HTTPS behind trusted proxies
│     │  │  ├─ origin.ts     "from this site's own page" (WebSocket handshakes, API writes)
│     │  │  └─ rateLimit.ts  TokenBucket, BucketMap (per-address buckets, swept when full)
│     │  └─ rooms/
│     │     ├─ RoomManager.ts  rooms by code, seats by token, one seat per profile, the loop
│     │     │                over all rooms (a failing room is closed alone)
│     │     ├─ Room.ts       lobby rules, host, cars, authoritative race, snapshots, results,
│     │     │                session points
│     │     └─ ids.ts        room codes, seat tokens, player ids (node:crypto)
│     ├─ test/               Vitest: rooms and lobby rules, race rules, reconnects, abilities,
│     │                      sessions (cars, ready checks, results, points, race again; fake
│     │                      connections, manual clock); real Socket.IO on an ephemeral port;
│     │                      ranking (store, service, API, rooms and tickets) on PGlite, and
│     │                      on PostgreSQL with TEST_DATABASE_URL (db.ts); Step 9: security
│     │                      (abuse, authority, isolation over the wire), integrity (rooms side
│     │                      by side, race ends, profiles, database failure), ops, shutdown
│     └─ scripts/
│        ├─ bot.ts           the headless bot player (browser netcode + autopilot), shared
│        ├─ harness.ts       real-time multiplayer harness: 18 scenarios, network ones included
│        ├─ load.ts          load test: the built server, bot workers, /metrics, six levels
│        ├─ netem.ts         TCP proxy that degrades a link: latency, jitter, loss, outages, resets
│        └─ dbbench.ts       leaderboard queries on 100,000 seeded profiles
```

## Boundaries

| Package  | May import                         | Must not import                     |
|----------|------------------------------------|-------------------------------------|
| `shared` | nothing outside itself             | DOM, three.js, React, Node built-ins |
| `client` | `shared`, browser APIs, three, React | `server`                           |
| `server` | `shared`, Node built-ins           | `client`, DOM, three                 |

## Where things will go next

| Milestone | New folders                                                                          |
|-----------|--------------------------------------------------------------------------------------|
| M1        | `game/ghost.ts`; produced sounds replacing the synthesised placeholders in `game/audio.ts` |
| M3        | more route features beside the Needle and the split: `track/track.ts`, `sim/course.ts`, `scene/track/RouteScene.tsx` |
| M4        | slipstream Energy in `sim/race.ts`; bot ability use in `apps/server/src/bots/`      |
| M5        | `apps/server/src/bots/`, `apps/server/src/load/`                                      |
