# CIRCUIT BREAKER

**Race your friends. Rewire the track.**

A futuristic browser racing game for 2–8 players on one neon circuit. You collect **Energy** as
you drive, then choose how to spend it: a boost for yourself, or a change to the track for
everyone. Open the Needle shortcut, swap the open lane of the Overload hairpin, and then race
whoever is on the route you just made.

![Opening the Needle shortcut in an online race](docs/media/shortcut-open.jpg)

> Racing skill + risk/reward Energy decisions + player-controlled track changes, refereed by an
> authoritative server.

**Status (Step 10, 2026-10-16): complete and tested end to end on this machine, including the
production Docker image with PostgreSQL. Not deployed: there is no public URL yet.** The exact
steps are under [Deployment](#deployment). The two-minute demo script and its checklist are in
[DEMO.md](DEMO.md).

## What makes it different

- **The track is shared and contested.** Two abilities change the circuit for every car in the
  race, on the same tick on every screen:
  - **Shortcut** (Q, 45 Energy) opens the Needle, a tight branch across the Switchback, for
    8 seconds. The cars behind you can use it too.
  - **Gate Shift** (E, 30 Energy) swaps which lane of the split Overload hairpin is open, after
    a 2.5 s warning.
- **Every spend is a choice.** The same Energy pays for boost bursts (Shift, 20) and for
  **Overdrive** (F, 40: three seconds of super-boost for you alone). Boost now, or keep 45 for
  the shortcut?
- **One authoritative server.** Laps, positions, Energy, ability checks, finish order, results,
  points and ratings are all decided by the server; each browser predicts its own car and
  smooths the others.
- **A reason to race again.** Sessions of races scored on points (with a reversed grid), and a
  global Elo-style rating with a leaderboard, stored in PostgreSQL.

## Screenshots

| Title page                                         | Lobby                                              |
| -------------------------------------------------- | -------------------------------------------------- |
| ![Title page](docs/media/landing.jpg)              | ![Lobby](docs/media/lobby.jpg)                     |
| **First race: tips over the ability slots**        | **Inside the Needle shortcut**                     |
| ![First race tips](docs/media/first-race-hint.jpg) | ![Inside the Needle](docs/media/in-the-needle.jpg) |
| **Results: server times, points and ratings**      |                                                    |
| ![Results](docs/media/results.jpg)                 |                                                    |

Captured at 1600×900 from real online races between two browsers on this machine: the
development autopilot drove, and the ability presses were real key presses.

## How the track changes

**Charging Energy** (the bar holds 100; every car starts with 40):

| Source                              | Energy                                                    |
| ----------------------------------- | --------------------------------------------------------- |
| Green Energy cells                  | +12 each (shared: the first car takes it; back after 5 s) |
| Drifting (hold Space)               | +7 a second, at most 8 a drift and 30 a lap               |
| Glowing speed lanes on corner exits | +5 for riding most of a lane, once a lap                  |

**Spending it:**

| Key   | Spend      | Cost | What happens                                                                                            | Cooldown |
| ----- | ---------- | ---- | ------------------------------------------------------------------------------------------------------- | -------- |
| Shift | Boost      | 20   | A 1 s burst for your car                                                                                | 0.5 s    |
| Q     | Shortcut   | 45   | The Needle opens 0.75 s later, for everyone, for 8 s (it flashes for the last 2 s), then stays shut 2 s | 25 s     |
| E     | Gate Shift | 30   | The other lane of the Overload split opens 2.5 s later, for everyone; the gate then holds 10 s          | 20 s     |
| F     | Overdrive  | 40   | 3 s of super-boost for your car (no bursts while it runs)                                               | 15 s     |

The server checks every press against the race phase, the Energy, the cooldowns and the track
state, and refuses what does not fit; the ability slot says why (`Need +5`, `Cool`, `Lock`).
On the track, the Needle's sign reads `LOCKED · Q OPENS IT` until someone opens it, and the
split's boards count down which lane opens and which shuts. In a player's first races, a small
hint over the ability slots explains both halves (charge, then change the track); it goes away
once they use an ability or close it.

## Features

- One track, Grid Zero (3.01 km): the Ion Tunnel, a raised Skyway with barrier-free edges, a
  banked split hairpin and a tight drift hairpin.
- One car with neon-rimmed wheels, lights and exhaust trails, in 8 colours and 3 body styles
  (cosmetic only).
- Countdown with a launch boost, drift with mini-turbos, boost bursts, Energy cells, boost pads
  and speed lanes; checkpoints, laps, sector times, finish and results.
- Online races for 2–8 players: rooms with a 6-character code and an invite link, nicknames (no
  accounts), a car picker, ready checks and a host start; live standings; results with times,
  best laps, DNF reasons, race stats and an ability log; Race again and New session;
  reconnecting after a dropped connection or a page reload.
- Practice solo against the clock (no server needed), with local personal bests.
- Profiles without accounts: an anonymous profile per browser, made on the first online race,
  with a recovery code to take it to another browser; a global rating shown on the results only
  after the database confirms it; a leaderboard with search, pages and your own rank.
- Synthesised engine and effect sounds, three graphics levels, a reduced-motion option, and
  keyboard or gamepad controls.

## Quick start

Requires Node 22.13+.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173 and click **Practice solo**, or press **W** / **↑** on the title
screen. Solo races need only the client.

| Command                                         | What it does                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                                   | Client dev server; forwards `/socket.io` and `/api` to the game server     |
| `npm run dev:server`                            | Game server with hot reload: http://127.0.0.1:3001/ready                   |
| `npm run typecheck`                             | TypeScript on every workspace                                              |
| `npm run lint`                                  | ESLint                                                                     |
| `npm run format:check`                          | Prettier                                                                   |
| `npm test`                                      | Vitest: simulation, netcode, rooms, real sockets, ranking (PGlite)         |
| `npm run harness -w @circuit-breaker/server`    | Multiplayer harness: 18 bot scenarios over real sockets, about 3 minutes   |
| `npm run load -w @circuit-breaker/server`       | Load test of the built server: 2 to 100 bot players, about 13 minutes      |
| `npm run dbbench -w @circuit-breaker/server`    | Leaderboard queries on 100,000 seeded profiles (needs `TEST_DATABASE_URL`) |
| `npm run build`                                 | Production build of client (Vite) and server (esbuild)                     |
| `npm run check`                                 | Typecheck, lint, tests and build                                           |
| `npm start`                                     | Run the built server: the game, Socket.IO and the API on one port          |
| `npm run db:migrate -w @circuit-breaker/server` | Apply pending database migrations (`db:status`, `db:rollback` too)         |

## Multiplayer

### Run the frontend and backend locally

Run the two servers in two terminals.

The game server:

```bash
npm run dev:server
```

The client:

```bash
npm run dev
```

Open http://localhost:5173. The client talks to the game server through Vite's proxy, so
there is only one address to open.

### Test with two browsers

1. In the first browser, open http://localhost:5173, enter a nickname and click **Create
   room**.
2. Click **Copy invite link**. The link is `http://localhost:5173/?room=CODE`.
3. Open the link in a second browser, or a private window (or type the code next to **Join
   room**). Enter a nickname and click **Join room**.
4. Each player can pick a body style and a free colour. The second player presses **Ready**.
   The host picks the laps and presses **Start race**.
5. After the race, the results show times, points and race stats. Players press **Ready for
   the next race**, and the host presses **Race again** (or **Return to lobby**). Points add up
   over the session; the host can start a **New session** from the lobby.

A seat belongs to a browser tab, so two tabs of one browser are two players too. Reloading a
tab during a race puts you back in your car. To try latency, add `&lag=120&jitter=30` to a
development page's address. To fill a room with bots, give the harness its code:

```bash
npm run harness -w @circuit-breaker/server -- --join CODE --bots 6
```

### Profiles and the leaderboard (PostgreSQL)

Profiles, ratings and the leaderboard need a PostgreSQL database; the race itself does not.
For local development, Docker is the quickest (pick any password and any free port):

```bash
docker run -d --name cb-pg -e POSTGRES_USER=cb -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=circuit_breaker -p 127.0.0.1:54329:5432 -v cb-pg-data:/var/lib/postgresql/data postgres:17-alpine
```

Copy `.env.example` to `.env` (git ignores it) and set
`DATABASE_URL=postgres://cb:change-me@127.0.0.1:54329/circuit_breaker`. `npm run dev:server`
reads it and creates the tables on start. The landing page then shows your profile and the
**Leaderboard**; after an online race between two browsers, the results show each rating
change.

The tests run every database test on PGlite (PostgreSQL in WebAssembly, no server needed).
To run them on a real PostgreSQL as well, create a separate database and set
`TEST_DATABASE_URL` to it (never the same as `DATABASE_URL`); each test works in a throwaway
schema. The rating rules, the anonymous identity, what happens when the database is down, and
deployment and rollback are in [docs/08-ranking.md](docs/08-ranking.md).

## Deployment

The production build is one Node process: it serves the built client, Socket.IO, the race
server, `/api/` and the health endpoints on one port and one origin, so there is no CORS to set
up and no API URL to configure in the client. Rooms and races live in its memory: run exactly
one instance. Profiles and ratings live in PostgreSQL.

### Run the production build

```bash
npm run build
```

```bash
npm start
```

It listens on port 3001 on every interface in production. Other devices on the network open
`http://<this computer's IP>:3001` (the firewall must allow the port).

### Docker

The `Dockerfile` builds the client and the server and runs the server as the unprivileged
`node` user (the image is about 270 MB):

```bash
docker build -t circuit-breaker .
```

```bash
docker run -p 3001:3001 -e DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE circuit-breaker
```

Without `DATABASE_URL` the game runs with ranking off (races are unrated and the leaderboard
says it is unavailable). Behind a hosting proxy, add `-e TRUST_PROXY=1`.

### Render (Blueprint)

`render.yaml` describes one Docker web service and one PostgreSQL database; Render fills in
`DATABASE_URL` itself, so no secret is in the repository. The manual steps:

1. Push the repository to GitHub (a private repository works).
2. In the Render dashboard: **New** → **Blueprint**, pick the repository, and apply the plan it
   reads from `render.yaml` (the `circuit-breaker` web service and the `circuit-breaker-db`
   database).
3. Wait for the Docker build and the health check on `/ready`. The service log shows
   `"msg":"migrations: applied 1, 2"` on the first boot.
4. Open the service's `https://….onrender.com` address. `/ready` should show `"ready":true` and
   `"database":"ok"`.
5. Check it like a player: create a room on one device, join by the invite link on another,
   race, and check that the results say the ratings were saved. Restart the service from the
   dashboard and check that the leaderboard still lists both players.

Free plans have limits: a free web service sleeps when idle (the first visit then waits for it
to wake), and Render's free PostgreSQL is time-limited. Check the provider's current terms,
and use a paid database for data that must last. Other hosts that run a Dockerfile (Railway,
Fly.io) need the same three things: one instance, `DATABASE_URL`, and `TRUST_PROXY=1`.

### Deployment verification status

| Check                                                                                                        | Status                                     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Public URL, HTTPS, the host's proxy and WebSockets through it                                                | **Not verified: not deployed**             |
| Docker image builds; the container boots; migrations run on a fresh database                                 | Verified locally (Docker Desktop)          |
| `/health`, `/ready` (database ok), `/metrics` hidden from other machines (404)                               | Verified against the container             |
| Deep links and invite links (`/?room=CODE`, any path) load the game on refresh                               | Verified against the container             |
| No secrets in the 29 files the server sends (database password, URLs, token names)                           | Verified against the container             |
| WebSocket only; a page from another origin is refused                                                        | Verified against the container             |
| Two browsers and a bot race in production mode: lobby, ability sync, reload mid-race, rated results, rematch | Verified against the container (12/12)     |
| Profiles and ratings survive a restart; graceful shutdown on SIGTERM                                         | Verified against the container             |
| `render.yaml` accepted by Render                                                                             | **Not verified: needs the Render account** |

### Environment variables

`.env.example` lists them all. In production they come from the host's settings; the database
password never goes into the repository or the client.

- `PORT`, `HOST`
- `SNAPSHOT_RATE`: snapshots per second, 5–60, default 20
- `RECONNECT_GRACE`: seconds a dropped player keeps their seat, default 30
- `MAX_ROOMS`, `MAX_CONNECTIONS` (default 1000), `MAX_CONNECTIONS_PER_IP` (default 32)
- `CORS_ORIGIN`: only for a client served from another origin
- `DATABASE_URL` (and `DATABASE_SSL`, `DB_POOL_MAX`, `DB_MIGRATE`): profiles and the leaderboard
- `TRUST_PROXY=1` behind a hosting proxy (Render, Railway): without it every player shares the
  proxy's address and the per-address limits hit everyone at once; `COOKIE_SECURE`
- `LOG_FORMAT` (`json`, the production default, or `text`), `METRICS_TOKEN` (to read
  `/metrics` from another machine)

`/health` answers while the server runs, `/ready` reports its dependencies (503 while it shuts
down), and `/metrics` gives load figures (see [docs/09-security-audit.md](docs/09-security-audit.md)).

## Controls

| Action          | Keyboard  | Gamepad    |
| --------------- | --------- | ---------- |
| Accelerate      | W / ↑     | RT         |
| Brake / reverse | S / ↓     | LT         |
| Steer           | A D / ← → | Left stick |
| Drift           | Space     | A / RB     |
| Boost burst     | Shift     | X / LB     |
| Reset car       | R         | Y          |
| Shortcut        | Q         | D-pad ←    |
| Gate Shift      | E         | D-pad ↑    |
| Overdrive       | F         | D-pad →    |
| Mute / unmute   | M         | —          |
| Pause           | Esc / P   | Start      |

Online races cannot pause: Esc opens a race menu while the race goes on.

The abilities sit on Q, E and F. R was the suggested key for the third one, but R is Reset, so
Overdrive moved next to it, to F. The three ability slots above the BOOST meter also work with
a mouse click or a touch tap. Ability keys do nothing while a menu or a text field has focus.

Each Shift press fires one 1 s boost burst for 20 Energy (the BOOST bar shows one segment per
burst). Hold the brake at a standstill to reverse. Sound starts after your first key press or
click; volume, mute and Reduce motion are on the title screen and in the pause menu.

There are no touch driving controls yet: on a phone or tablet the game needs a keyboard or a
gamepad, and the title page and the race say so.

## Tests and results

Run on 2026-10-16 (Windows 11, Node 22, after the Step 10 changes):

| What                                                                      | Result                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run check` (typecheck, lint, tests, both production builds)          | Pass, 96 s                                                                                                         |
| Shared tests (simulation, netcode)                                        | 116 / 116                                                                                                          |
| Server tests on PGlite (rooms, sockets, security, ranking, API, shutdown) | 124 / 124                                                                                                          |
| Server tests on PostgreSQL 17 (`TEST_DATABASE_URL`)                       | 146 / 146                                                                                                          |
| Multiplayer harness (18 bot scenarios, 8 of them on degraded links)       | 18 / 18 (163 s)                                                                                                    |
| Load test, 3 of its 6 levels: 2, 8 and 100 clients, 60 s each             | All stable; at 100 clients (13 rooms) 20% of a core, 161 MB, no snapshot dropped, no disconnect, 100 rated results |
| Prettier                                                                  | Clean                                                                                                              |
| Client bundle                                                             | 1,729.09 kB (519.76 kB gzip)                                                                                       |
| Server bundle                                                             | 206.7 kB                                                                                                           |

Browser checks (headless Chrome driven over the DevTools protocol by scripts that are not part
of this repository):

| Check                                                                                                                                                                                                                                           | Result   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Two browsers, one online race (development build, autopilot driving, real Q press): invite link join, the shortcut opens on the same tick on both screens, identical results, rated in PostgreSQL, rematch resets lap, Energy, finish and track | 10 / 10  |
| First-race hint: shown from the countdown, ticks on Energy and on an ability, saved, gone next race; × closes it without taking focus; stops after 3 races; malformed storage; reduced motion                                                   | 20 / 20  |
| Production Docker image, two browsers and a harness bot (see Deployment)                                                                                                                                                                        | 12 / 12  |
| Phone size (390×844 and 844×390, touch emulation): no sideways scrolling; the touch notes show; the hint hides                                                                                                                                  | Pass     |
| Production build without a database: `/ready` says the database is off, the title page and the leaderboard say ranking is off on this server, no request fails in the console                                                                   | Pass     |
| Client frame times at 1920×1080 on an integrated GPU (Radeon 680M): at the display's rate (120 Hz), a solo race runs at 118–119 fps with frames p50 8.3 / p99 9–13 ms; uncapped, solo 96–102 fps and an online race with 8 cars 90 fps          | Measured |

Not verified: a deployed instance, real phones and tablets, Safari and Firefox, and separate
computers on a real network (all browser checks ran on one machine).

## Architecture

```
 Browser (React 19, React Three Fiber, three.js)       Node 22 server (one process)
 ┌──────────────────────────────────────────────┐      ┌─────────────────────────────────────┐
 │ menus, lobby, HUD (React, zustand)           │  WS  │ rooms, lobby, ready checks          │
 │ own car predicted with the shared simulation │ ───▶ │ input frames per tick, 30 sends/s   │
 │ other cars interpolated from snapshots       │ ◀─── │ snapshots (20 Hz), events, results  │
 │ 3D scene, effects, synthesised audio         │      │ authoritative RaceSimulation, 60 Hz │
 └──────────────────────────────────────────────┘      │ ratings -> PostgreSQL               │
                                                       └─────────────────────────────────────┘
   packages/shared: the same deterministic track, physics and race rules on both sides
```

- **Client:** TypeScript 6, React 19, Vite 8, React Three Fiber 9 with three.js 0.186 and
  postprocessing, zustand, Tailwind CSS 4, Socket.IO client.
- **Server:** Node 22, Socket.IO 4.8 (WebSocket only), the same simulation as the client, `pg`
  for PostgreSQL, esbuild bundle.
- **Tests:** Vitest, PGlite for the database tests, a bot harness and a load generator.
- Design documents: [architecture](docs/01-architecture.md), [networking](docs/04-networking.md),
  [ranking](docs/08-ranking.md), [security audit](docs/09-security-audit.md).

## Known limitations

- **Not deployed.** No public URL; the deployment files are verified only as a local Docker
  container.
- **No touch driving.** Phones and tablets need a keyboard or a gamepad; only the ability slots
  take taps.
- **One track and one mode.** Grid Zero, races and sessions; no AI opponents (solo is a time
  trial).
- **One server instance.** Rooms live in memory: a restart or a deploy ends the races in
  progress, and the game cannot be spread over several instances.
- **Starting Energy is 40,** a testing value: the Shortcut (45) needs one pickup first. The
  first-race hint explains this; the ability slot says `Need +5`.
- **Rating abuse:** one person with several browser profiles can still feed a main profile some
  rating ([docs/08-ranking.md](docs/08-ranking.md)).
- **Tested on one machine:** load up to 100 bot clients on one Windows computer (a cloud host
  will differ); browsers were headless Chrome only.
- **Console warnings from dependencies:** React Three Fiber uses the deprecated `THREE.Clock`,
  and on Windows the Direct3D shader compiler prints precision warnings for one of three.js's
  shaders. Both are harmless.

## Development switches

| URL parameter        | Effect                                                          | Builds   |
| -------------------- | --------------------------------------------------------------- | -------- |
| `?fx=0`              | Render without post-processing (debugging, very weak GPUs)      | all      |
| `?autopilot=1`       | The autopilot drives your car in a race (demos, testing)        | dev only |
| `?boost=0`           | With `?autopilot=1`: no bursts, so Energy is kept for abilities | dev only |
| `?laps=N`            | Override the lap count                                          | dev only |
| `?energy=N`          | Override the starting Energy (0–100)                            | dev only |
| `?lag=120&jitter=30` | Add round-trip latency and jitter (ms) to the online link       | dev only |

Starting Energy is 40 while testing. To balance it, change `RACE_RULES.startEnergy` in
`packages/shared/src/sim/config.ts`. The client passes it to each race through `RACE_CONFIG`
(`apps/client/src/game/config.ts`), and `RaceOptions.startEnergy` overrides it for a single
race.

In development, `window.__cb` exposes the session, input state, UI store, renderer stats, the
online link (`__cb.net()`: round trip, input lead, corrections) and the track state
(`__cb.course()`: the shortcut and the gate) in the console. Ability keys work while the
autopilot drives. The first-race hint's progress is kept in the browser's local storage
(`circuit-breaker.first-race-hint`); remove it to see the hint again.

## Repository layout

```
packages/shared   deterministic simulation: track model, vehicle physics, race rules, autopilot
apps/client       React + Vite + React Three Fiber client (scene, HUD, menus, input)
apps/server       authoritative race server: rooms, Socket.IO, the shared simulation at 60 Hz
docs/             design documents and README images (docs/media)
Dockerfile        production image; render.yaml: Render Blueprint (web service + PostgreSQL)
DEMO.md           the two-minute demo script and its setup checklist
```

## Design documents

1. [Architecture](docs/01-architecture.md)
2. [Game design](docs/02-game-design.md): includes answers to the 18 core design questions
3. [Folder structure](docs/03-folder-structure.md)
4. [Networking](docs/04-networking.md)
5. [Rendering strategy](docs/05-rendering.md)
6. [Physics strategy](docs/06-physics.md)
7. [Milestone plan](docs/07-milestones.md): what each step delivered, and what is still open
8. [Profiles, rating and the leaderboard](docs/08-ranking.md): database, identity, rules, deployment
9. [Security audit, stress tests and performance](docs/09-security-audit.md): findings, fixes, measurements
