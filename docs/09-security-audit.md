# 09 — Security Audit, Stress Tests and Performance (Step 9)

Status: **done (Step 9, 2026-10-15)**. This document is the audit record. It holds the baseline,
the prioritised checklist, every finding (with the evidence before the fix and the check
after it), the network, load and database results, and the risks that remain. A result is
"verified" only when a test, the harness, a load run or a browser run measured it. Anything
else is marked as an assumption.

## 1. Method

1. Read the whole stack: shared simulation and protocol, the Socket.IO front door, rooms and
   the room manager, identity, the ranking service and store, the HTTP API, static serving,
   configuration and shutdown, and the client's network, prediction and session code.
2. Record a baseline (section 2) before changing anything.
3. Write down every control the docs claim, and test it instead of trusting it. Suspected
   weaknesses were first reproduced against the unchanged code (scratch experiments, then
   regression tests), then fixed, then measured again.
4. Rank by impact: anything one client can do to every room, or to stored ratings, first.

## 2. Baseline (2026-10-15, before any Step 9 change)

Machine: AMD Ryzen 7 6800H (8 cores, 16 threads), 15.2 GB RAM, Radeon 680M, Windows 11,
Node 22.18.0, PostgreSQL 17.11 in Docker.

| Check                                          | Result                                             |
|------------------------------------------------|----------------------------------------------------|
| `npm run check` (typecheck, lint, tests, build) | pass, 128 s                                        |
| Shared tests                                   | 108 pass                                           |
| Server tests (PGlite)                          | 86 pass                                            |
| Server tests with `TEST_DATABASE_URL` (PostgreSQL 17) | 107 pass, 8.9 s                             |
| Prettier                                       | clean                                              |
| Client bundle                                  | JS 1,724.60 kB (518.50 kB gzip), CSS 52.93 kB      |
| Server bundle                                  | `index.js` 180.9 kB, `dbcli.js` 10.9 kB            |
| Harness, 10 scenarios (ratings in PostgreSQL)  | all pass, 163.5 s                                  |

## 3. Prioritised audit checklist

Priority 1 is anything one client can do to every room on the server, or to stored data.

| #  | Pri | Area                | What is checked                                                              | Outcome |
|----|-----|---------------------|------------------------------------------------------------------------------|---------|
| 1  | 1   | Resource exhaustion | One connection flooding messages (any event, any size)                       | F1 fixed |
| 2  | 1   | Stability           | An exception in a socket handler or in one room's update                     | F5 fixed |
| 3  | 1   | Resource exhaustion | Connections per address and in total; connection churn                       | F2 fixed |
| 4  | 1   | Unbounded state     | Per-race histories (ability log, inputs), queues, maps, client buffers       | F3, F8, F14 fixed |
| 5  | 1   | Rating integrity    | One profile in several seats or rooms; ratings applied once; reconnects      | F9, F11 fixed; once-only holds |
| 6  | 1   | Origin              | Socket.IO used from another site's page (visitors' browsers as a botnet)    | F4 fixed |
| 7  | 1   | Input path          | Input outside a race; input rate; malformed and oversized packets            | F12 fixed (via F1), F19 fixed |
| 8  | 2   | Server authority    | Every client-to-server event: permission, payload and phase checks           | holds (§4.2) |
| 9  | 2   | Identity            | Seat tokens after leaving or expiry; private data in messages and API answers | holds (§4.2) |
| 10 | 2   | Room isolation      | 2, 4 and 8 players, rooms side by side: events, snapshots, results, ratings  | holds (§4.2) |
| 11 | 2   | Stale messages      | Race ids on inputs, requests, snapshots and events; restart with messages in flight | holds (§4.3) |
| 12 | 2   | Reconnection        | During a race, a track change, after finishing; host drops in lobby and race | holds (§6) |
| 13 | 2   | Network conditions  | 50, 100, 200 ms; loss; short outage; background tab                          | F7, F8 fixed (§6) |
| 14 | 2   | Database            | Once-only rating, concurrency, rollback, constraints, outage, private fields | holds; F10 fixed (§7) |
| 15 | 2   | Clean-up            | Rooms, seat sessions, tickets, rate-limit maps, timers, pool, shutdown       | F14, F15 fixed |
| 16 | 3   | Race rules          | Boundary cases                                                               | holds (§4.3) |
| 17 | 3   | Diagnostics         | Health, readiness, metrics, structured logs, error ids                       | F17 added |
| 18 | 3   | Performance         | Server tick and snapshot cost under load; client renders, allocations, draw calls; query plans | F6, F10, F18 fixed (§8) |

## 4. Findings

Severity: **Critical** (exploitable now, compromises stored data or takes the whole service
down trivially), **High** (one ordinary client degrades the service for others, or breaks the
integrity of results), **Medium** (needs unusual conditions, or harms one room or one player),
**Low** (hygiene, defence in depth). Every "before" figure was measured on the unchanged code;
every "after" figure is from the fixed code.

No Critical finding. Nothing found lets a client move another car, write a position, a lap, a
result, points or a rating, read another player's secrets, or rate a race twice; the checks in
section 4.2 confirmed the existing controls.

### 4.1 Found and fixed

| #  | Sev    | Finding (before)                                                                 | Fix                                                                 | Verified after |
|----|--------|-----------------------------------------------------------------------------------|---------------------------------------------------------------------|----------------|
| F1 | High   | One connection could flood messages of any event, known or not, with no budget. A separate process sending tiny messages drove the server to 89% CPU; 15 KB messages to 101% CPU with every race's ticks up to 115 ms late and the event loop's p50 delay at 112 ms. | Every message counts against a per-connection budget (120 burst, 60/s; a playing client sends ~31/s); 300 refused within 10 s drop the connection (F19). Messages over 4 KB close it (the largest real one is a few hundred bytes). WebSocket only (no long-polling sessions). | The same floods: the attacker is dropped after ~600 messages, server CPU 2.7–11.7%, ticks on time. Tests: `security.test.ts` |
| F2 | High   | No limit on connections: 500 from one address were all accepted. Each can hold a seat, so one address could, over time, hold every room (`MAX_ROOMS`) and lock everyone else out. | `MAX_CONNECTIONS` (1000) and `MAX_CONNECTIONS_PER_IP` (32) at the handshake, and new connections per address (as many at once as the cap, then twice the cap a minute). The Socket.IO handshake must finish within 10 s. | Tests: per address, total, rate; refusals counted in `/metrics` |
| F3 | Medium | A player tapping an ability key on cooldown had every refusal recorded in the race's ability log, which every player receives with the results and the results screen lists. One client in a 158 s race: 4,742 entries, results of 645 KB (a 5-lap race would reach several MB: an estimate). | At most 20 refused presses recorded per car (every press that worked is still listed; cooldowns bound those). The presser is still told about each refusal. | 3.6 KB for the same race. Test: `integrity.test.ts` |
| F4 | Medium | A cross-site page could open the game's WebSocket and create rooms: browsers send no CORS preflight for WebSockets. A popular page could make its visitors' browsers fill the server from thousands of addresses, past every per-address limit. | The handshake must come from this site's page (Origin host = Host) or the configured `CORS_ORIGIN`. Non-browser clients send no Origin and are still let in (they carry no visitor's authority). | Tests: foreign and `null` origins refused, own page, configured origin and no origin accepted |
| F5 | Medium | A throwing Socket.IO listener ends the whole process: Socket.IO calls listeners from `process.nextTick` (verified: the error reached `uncaughtException`). The input, ping and disconnect listeners had no guard, and an exception in one room's update would also have stopped every room. No trigger was found; the impact would be every race on the server. | Every listener is guarded; a failing request is answered "Something went wrong on the server (error K7Q2M4XZ)" and logged with that id. A room whose update throws is closed alone (its players get the error id), the loop goes on. `uncaughtException` is logged and shuts the server down cleanly (exit 1, so the host restarts it); an unhandled rejection is logged. | Tests: a throwing `join` and a throwing `receiveInput` over real sockets; a failing room beside a racing one |
| F6 | Medium | Snapshots were sent with Socket.IO's `volatile` flag, which drops a message whenever the connection is still writing the previous one, not only when it is congested. 8-player race: 4.5 snapshots/s discarded (about 3%), client gaps up to 156 ms, longer than the 110 ms the client buffers for remote cars. | Snapshots are sent like other messages unless that connection already has 8 messages waiting (really behind); only then is one skipped (and counted). | 0 discarded; client gap p99 138.5 → 63.9 ms, max 155.8 → 65.0 ms; CPU 4.9 → 5.3%. A regression test sends an event then a snapshot twenty times: 0 of 20 arrived before, 20 of 20 after |
| F7 | Medium | Remote cars were drawn a fixed ~110 ms in the past, but a snapshot arrives about half a round trip after the server made it. Measured (harness bots drawing like the browser): frames with a snapshot on both sides of the drawn moment 99.8% at 50 ms, 91.0% at 100 ms, **7.2% at 200 ms**, the rest guessed ahead (rubber-banding at corners). | The delay is `max(100, 2.2 × interval + jitter) + rtt / 2` (shared `remoteDelayMs`), eased toward each new value at a tenth of real time (`RemoteDelay`), so the drawn moment never jumps. | 100% at 50, 100 and 200 ms (harness); browsers at 50/100/200 ms: 0 stalled frames. Under 3% packet stalls, cars stopped in 0–0.5% of frames (was 1.2–1.7%). Unit tests: `remote.test.ts` |
| F8 | Medium | A tab drawing no frames (minimized or in the background) still receives 20 snapshots a second, and the client queued every one for the next frame: unbounded memory for as long as the tab stays away. | The queue keeps the newest 20 (only the newest re-bases the car; remote cars are drawn from recent history). | A browser drawing no frames for 15 s mid-race: 303 snapshots arrived, the queue stopped at exactly 20; driving again 155 ms after frames resumed (§6.2) |
| F9 | Medium | One profile could hold several seats at once (two tabs, two rooms) and be rated in two rooms simultaneously; within one room it made both seats unrated. | One seat per profile: while the profile is seated and connected elsewhere, a new seat is unrated (the lobby says why); a seat it left behind (dropped, in its grace period) is given up for the new one, in any room. | `integrity.test.ts` |
| F10 | Medium | Name search at scale (100,000 profiles): the planner walked the whole leaderboard testing every name, then counted each result's rank separately: 45–174 ms per request (p99), with a pool of 5 connections. | Migration 2: a `players_rank` index holding the leaderboard order as one ascending row, so "profiles ahead of me" is one index range; search takes its matches from the name index, then ranks them in one walk. | Same database, Step 8 SQL vs now: no match 44.7 → 2.1 ms (p50); 10% match 66.8 → 21.2 ms (p99 173.5 → 23.9); scattered matches 111.6 → 61.7 ms |
| F18 | Medium | Frames of 200–600 ms at every race start (in the countdown) and at the first boost, on this Windows machine. Not shader compiles (the program count never changed): the first time three.js draws with a program it reads its uniforms and checks its link log, and on ANGLE over Direct3D that call waits for the driver to finish the shader. The warm-up compiled programs but never used them. Online, such a frame also holds back inputs (an ability press among them). | The warm-up also does that first use for every program (`getUniforms()`), so the wait happens while the world loads or behind the menu. | Solo race, countdown to 33 s in: longest frame 421–592 ms (three runs) → 73 ms (two runs) |
| F19 | Medium | The abuse limits counted refusals over a connection's whole life (400 refused input packets since Step 4; the new message budget at first too). A real player who stalls for a few seconds (a long frame, a quick alt-tab) catches up in a burst, some of it over the budget: over a long session those add up, and an honest player would eventually be dropped. | Both limits count within a 10 s window (refusals use up "strikes" that come back over 10 s): a flood still runs out in well under a second. | Test with a moving clock: six catch-up bursts (660 refused in all) keep the connection, the old counting dropped it; a 3,000-packet flood is still dropped |
| F11 | Low    | When the last players left a race in which someone had already finished, the room was deleted before the race was finalised: the finish was never rated. | The race is finalised (results, scoring, rating) when the last seat goes, if every car has finished or retired. | `integrity.test.ts` fails without the fix |
| F12 | Low    | Input packets sent outside a race were neither rate-limited nor counted: 20,000 in a lobby, no disconnect. | Covered by the per-connection message budget (F1). | Test: lobby input flood dropped |
| F13 | Low    | `/api/players/%E0%A4%A` (bad percent-encoding) answered 500 and logged the error. | 404. Unexpected API failures answer 500 with an error id; the details stay in the log. | `api.test.ts` |
| F14 | Low    | Per-address rate-limit maps were cleared wholesale when large (busy addresses got a fresh burst); expired seat tickets were swept only when 20,000 had piled up. | Only refilled buckets are forgotten; tickets are swept once a minute. | `ops.test.ts`, `ranking.service.test.ts` |
| F15 | Low    | Shutdown could run twice (a second signal), sent players no reason, and kept accepting players while closing. | Runs once: refuses new connections and seats, tells every player "The server is restarting…", lets rating writes finish (5 s), exits. | `shutdown.test.ts` against the real server process |
| F16 | Low    | A failure in the room's rating callback would have been taken for a database failure, so a stored race would be retried. | The callback is guarded and logged separately. | Code review (no trigger) |
| F17 | Low    | Operations: `/health` only, plain-text logs, no error ids, no metrics. | `/ready` (dependencies; 503 while draining), `/metrics` (loopback or `METRICS_TOKEN`), JSON logs in production, error ids. | `ops.test.ts` |

Found by the new tests in this step's own new code (fixed before the end of the step): the abuse
drop logged once per message still in flight (1,580 log lines for one attacker; now once), and
the test network emulator delivered chunks out of order (a timer rounding issue; the harness
results quoted here are from the corrected emulator).

### 4.2 Checked and holding (no change needed)

| Check                                              | How it was checked                                                                    |
|----------------------------------------------------|---------------------------------------------------------------------------------------|
| Start, restart, laps, return to lobby, new session by a non-host | Real sockets: every host request from a guest refused (`security.test.ts`) |
| Requests without a seat                            | Every seated event from an unseated connection: "You are not in a room."               |
| Malformed payloads                                 | 17 kinds of junk on 7 events over real sockets: well-formed refusals, room unchanged   |
| Oversized messages                                 | 5 KB message closes the connection                                                     |
| Controlling another car                            | Existing tests; inputs bind to the connection's own seat                               |
| Abilities without Energy, cooldowns, same tick     | Shared boundary tests: three presses in one tick paid in a fixed order until Energy runs out; presses on the closing tick refused, on the ready tick accepted |
| Skipped checkpoints, fake laps, positions, results | Existing tests; no client message carries them                                         |
| Duplicate result events, ratings                   | Race UUID key; a player coming back after the results changes nothing (`integrity.test.ts`) |
| Expired seat tokens                                | After Leave and after the grace period: refused, the room keeps its other seats         |
| Private data                                       | A guest's every received message never contains the host's token; room state has no token field; `/metrics` contains none |
| Duplicate connections                              | Two connections resuming one token at once: one seat, two closed connections, one live |
| Impersonation by room code                         | Same name joins as "Nova 2" with its own id and token, cannot start                    |
| Stale race ids                                     | An ability press for the previous race after a restart: dropped, counted as stale      |
| Room isolation                                     | Rooms of 2, 4 and 8 side by side over real sockets and in whole races in process: no foreign id in any message, snapshots carry only the room's cars, a shortcut opened in one room only |

### 4.3 Race rules at their boundaries

Each case ends in one documented, deterministic state (tests run on every `npm test`):

| Case                                              | Outcome                                                                  | Test |
|---------------------------------------------------|--------------------------------------------------------------------------|------|
| Two cars crossing the line within one tick        | Ranked by sub-tick crossing time; an exact tie by grid slot              | `net.test.ts`, `session.test.ts`, harness `photo` |
| A car crossing the line on the last tick of the finish grace | It finishes (second); the race ends in the same tick          | `boundary.test.ts` |
| Checkpoints skipped, or a gate crossed backwards  | No lap, no checkpoint                                                    | `race.test.ts` |
| Leaving the track and respawning                  | Respawn at the last safe point, frozen briefly, nothing crossed          | `offtrack.test.ts`, `race.test.ts` |
| A player dropping just before the line            | The car repeats its last input 15 ticks, then coasts; it crosses and finishes | `integrity.test.ts` |
| Two cars reaching one Energy cell in one tick     | One pickup (the first in racer order), paid once                         | `boundary.test.ts` |
| The shortcut pressed on the tick it closes; a gate shift on the tick the last one lands | Refused (`busy`); accepted from the exact ready tick | `boundary.test.ts` |
| Three abilities pressed in one tick by one car    | Paid in a fixed order until Energy runs out (shortcut, gate; Overdrive refused for Energy) | `boundary.test.ts` |
| Race again while old inputs are still in flight   | Stale race id: dropped and counted; old lobby requests refused           | `integrity.test.ts`, `session.test.ts` |
| Every player disconnects                          | The race runs on and ends by its rules; seats expire; the race is rated once | `integrity.test.ts` |
| Every player leaves after someone finished        | Results made and rated before the room closes (F11)                      | `integrity.test.ts` |
| The database fails just before the finish         | `pending`, `retrying`, then `rated` once it is back; one stored race      | `integrity.test.ts` (PGlite and PostgreSQL) |

## 5. Load tests

`npm run load -w @circuit-breaker/server` (needs `npm run build` first). For each level it
starts the built server (`dist/index.js`, production mode) as its own process, connects bot
players from four worker processes, lets the rooms race back to back (1 lap, next race as soon
as everyone is ready), and polls the server's `/metrics` every 5 s. The bots are the harness's:
real Socket.IO clients running the browser's netcode and the shared simulation; half of them
use abilities, two per room have profiles (every race rated in PostgreSQL, profiles and the
leaderboard reloaded after each). Every bot claims its own address and the server trusts one
proxy hop, so the per-address limits apply exactly as to real players. A level runs only after
the one before it was stable (no disconnect, no error, tick lateness p99 under 50 ms, CPU
under 90%).

Environment: the machine of section 2, server, bots and PostgreSQL (Docker) all on it; no
simulated latency; 15 s warm-up, then 95 s measured per level; 2026-10-15. (The run came
before F18 and F19: F18 is client-only, and F19 changes nothing while no message is refused,
as at every level here.)

| Level            | Clients | Rooms | Server CPU mean / max | RSS max | Event-loop delay p99 | Tick lateness p50 / p99 / max | Ticks/s | Snapshots/s (discarded) | Snapshot size | Data out |
|------------------|---------|-------|------------------------|---------|----------------------|-------------------------------|---------|--------------------------|---------------|----------|
| 1 room           | 2       | 1     | 4.2% / 8.3%            | 114 MB  | 0.7 ms               | 7.8 / 16.0 / 16.5 ms          | 58      | 39 (0)                   | 688 B         | 27 KB/s  |
| 1 room           | 8       | 1     | 4.5% / 9.6%            | 182 MB  | 1.5 ms               | 7.8 / 15.9 / 16.8 ms          | 59      | 157 (0)                  | 1,135 B       | 179 KB/s |
| 5 rooms          | 20      | 5     | 9.7% / 14.2%           | 201 MB  | 2.0 ms               | 7.8 / 15.9 / 18.0 ms          | 294     | 392 (0)                  | 838 B         | 327 KB/s |
| 10 rooms         | 40      | 10    | 13.5% / 21.1%          | 198 MB  | 3.6 ms               | 6.9 / 16.7 / 25.7 ms          | 589     | 785 (0)                  | 836 B         | 654 KB/s |
| about 50         | 50      | 7     | 22.1% / 28.4%          | 203 MB  | 7.8 ms               | 6.5 / 25.6 / 75.7 ms          | 412     | 982 (0)                  | 1,135 B       | 1.1 MB/s |
| 100              | 100     | 13    | 39.3% / 51.9%          | 206 MB  | 13.4 ms              | 5.5 / 20.5 / 36.6 ms          | 760     | 1,948 (0)                | 1,135 B       | 2.1 MB/s |

| Level   | Client snapshot gap p50 / p99 / max | Snapshot age p50 / p99 | Clock-ping round trip p99 | Race results | Corrections | Disconnects | DB queries (p50 / p99) | Errors |
|---------|-------------------------------------|------------------------|---------------------------|--------------|-------------|-------------|------------------------|--------|
| 2       | 47.0 / 63.9 / 64.8 ms               | 8.2 / 16.6 ms          | 1.1 ms                    | 2            | 0           | 0           | 14 (2.2 / 22.6 ms)     | 0      |
| 8       | 47.1 / 64.4 / 65.2 ms               | 8.9 / 18.5 ms          | 3.2 ms                    | 8            | 0           | 0           | 14 (2.3 / 21.8 ms)     | 0      |
| 20      | 47.0 / 64.6 / 68.1 ms               | 8.4 / 17.2 ms          | 3.1 ms                    | 20           | 0           | 0           | 58 (1.6 / 19.7 ms)     | 0      |
| 40      | 48.1 / 68.2 / 70.7 ms               | 7.7 / 23.5 ms          | 6.9 ms                    | 40           | 0           | 0           | 113 (2.1 / 28.3 ms)    | 0      |
| 50      | 48.1 / 67.3 / 82.8 ms               | 8.1 / 27.5 ms          | 13.1 ms                   | 50           | 0           | 0           | 80 (2.3 / 99.7 ms)     | 0      |
| 100     | 49.0 / 69.5 / 88.3 ms               | 7.2 / 27.2 ms          | 32.9 ms                   | 100          | 0           | 0           | 146 (3.4 / 106 ms)     | 0      |

Every level was stable; every bot finished every race it started. "Snapshot age" is the time
from a tick's due time on the server to the snapshot's arrival at a bot (server lateness,
serialisation, loopback network); the bots' own CPU peaked at 28% per worker, so they were
not the bottleneck.

What the numbers mean, and what they do not:
* **Tick lateness.** Windows wakes Node's timers on a ~15.6 ms grid, so a tick waits up to one
  grid step before it runs: p50 ≈ 7.8 ms and p99 ≈ 16 ms even with one room. That is this
  machine, not the server; on Linux (the deploy target) timers are ~1 ms. Under load the rare
  maximum grows (75.7 ms once at 50 clients, most likely a garbage-collection pause).
* **Capacity.** 100 clients used 39% of one core on average. Node runs the simulation on one
  thread, so a rough ceiling on this CPU is 200 clients; a shared cloud vCPU is slower, so plan
  for less. This is an estimate, not a measurement: nothing above 100 clients was run.
* **Database.** p99 around 100 ms at 50 and 100 clients is the rated-race transaction
  (several statements) with PostgreSQL in Docker on the same, busy machine; p50 stays 2–3 ms.
  Ratings are written off the race loop, so this never delays a tick.
* **Snapshots discarded: 0** at every level (see F6).

## 6. Network instability

### 6.1 Harness (bots through a TCP proxy)

`scripts/netem.ts` is a TCP proxy between a client and the server that adds latency and
jitter per direction, stalls standing in for lost packets (TCP resends: everything behind
waits, then arrives at once), outages (nothing moves, the connection stays open) and resets.
The harness's eight network scenarios put every bot behind its own proxy. The server runs
with a 4 s reconnect grace in the harness (30 s in production). Final run: all 18 harness
scenarios passed in 163.4 s (ratings in PostgreSQL).

| Scenario         | What happens                                                    | Result |
|------------------|-----------------------------------------------------------------|--------|
| `net-latency`    | 50, 100 and 200 ms round trips (+10 ms jitter) on the wire (measured 78, 137, 232 ms) | Results identical, one correction of 1 cm in all, remote cars drawn between two snapshots in 100% of frames at all three (7.2% at 200 ms before F7) |
| `net-loss`       | 3% of chunks stalled ~250 ms, both ways, 60 ms round trip       | Every car finished, no connection dropped, corrections at most 0.07–2.3 m (under the 6 m snap, so smoothed), remote cars stopped in 0–0.5% of frames, guessed ahead in 3–7% |
| `net-outage`     | 3 s with nothing on the wire, mid-race                          | Not a disconnect; the server repeated the last input 15 ticks then coasted the car; no lap lost; the player re-based and finished |
| `net-reset`      | The connection reset mid-race                                   | Reconnected, resumed the same seat and car with its token; laps kept; finished |
| `net-timeout`    | 20 s with nothing on the wire                                   | The server noticed by its ping timeout (11.1 s), held the seat for the grace period, then retired the car (DNF, left, last); the old token no longer resumes; the others finished |
| `net-gate`       | A reset while a Gate Shift warning was pending                  | Resumed before the switch; afterwards the same track state as everyone at every tick (1,708 snapshot pairs, 0 different) |
| `net-finished`   | A reset just after finishing first                              | Resumed while the others raced on; the finish (time and place) stood |
| `net-host-lobby` | The host's connection reset in the lobby                        | Others saw the host dropped at once; nobody else could start; after the grace period the longest-standing player hosted and started a race |


### 6.2 Real browsers

Three headless Chrome processes (separate profiles, real GPU, 960×540), the dev build, each
behind its own `netem` proxy: A at 50 ms round trip, B at 100 ms, C at 200 ms, each with
10 ms of jitter (the round trips the clients measured: 79, 126 and 230 ms). Two 2-lap races,
autopilot driving. 14/14 checks passed (the run with nothing else on the machine; an earlier
run during which a test suite ran beside it showed a 634 ms stall in all three browsers at
once and is not counted).

| Check (race 1: latency only)                      | A, 50 ms        | B, 100 ms       | C, 200 ms       |
|---------------------------------------------------|-----------------|-----------------|-----------------|
| Frames p50 / p99 (racing)                         | 8.3 / 9.0 ms    | 8.3 / 8.9 ms    | 8.3 / 8.9 ms    |
| Own-car corrections (count / largest)             | 1 / 0.04 m      | 0               | 0               |
| Remote-car frames stalled / jumps (of ~21,000)    | 0 / 0           | 0 / 0           | 0 / 0           |
| Input lead                                        | 6.8 ticks       | 7.8 ticks       | 11.1 ticks      |
| Results                                           | identical in all three browsers; every car finished |

Race 2 added trouble on purpose:
* **B: 3 s outage** (nothing crosses the link). The connection survived (B "online", A saw B
  connected throughout). The server repeated B's last input for 15 ticks, then coasted the
  car; when the link came back B re-based on the server's car (a 37.8 m snap, which is the
  designed behaviour after the car stopped receiving input) and drove on to finish second.
  While the link was down B's view of the others froze (666 stalled remote-car frames) and
  then caught up at once.
* **C: connection reset** (only the game's socket; resetting Vite's dev socket too made Vite
  reload the page, which the game also survived by resuming the seat after the reload).
  Socket.IO reconnected and resumed the same car in the same race 1.3 s after the reset; C won.
* **A: window minimized 20 s.** The window drew about one frame a second; 404 snapshots
  arrived; the connection stayed up; A drew and predicted again 335 ms after restoring, and
  finished third (it had coasted while away).
* **Results identical in all three browsers.**

A tab that draws no frames at all (`requestAnimationFrame` held for 15 s, as Chrome does for a
hidden tab; a separate two-browser run): 303 snapshots arrived, the client's queue stopped at
exactly 20 (F8), and the car was driving again 155 ms after frames resumed.

## 7. Database and leaderboard integrity

| Check                                                        | Evidence                                                             |
|--------------------------------------------------------------|----------------------------------------------------------------------|
| A race affects ratings at most once                          | The race's UUID is the primary key of `rated_races`; a second write finds it and changes nothing (store and service tests, both databases); a player resuming after the results three times: still one submission (`integrity.test.ts`) |
| Concurrent results cannot lose or duplicate updates          | 12 overlapping races, each sent twice at once, on PostgreSQL 17: every profile's counts and rating chain exact (players locked in id order) |
| Rollback on failure                                          | A failure just before COMMIT leaves no trace (store test)            |
| Unique constraints                                           | `race_results` keyed by (race, player); constraints on counts and on `after = before + delta` |
| No client can write ratings or wins                          | No endpoint or socket event carries them; forged events ignored (socket tests) |
| Pagination exposes no private fields                         | Leaderboard and profile answers checked field by field (`api.test.ts`) |
| Database down: nothing claimed, nothing lost silently        | The database failing just before the last car finishes: the room hears `pending`, then `retrying`, then `rated` once it is back, one stored race (`integrity.test.ts`, both databases); past the retry window `failed`, nothing stored; at shutdown the unsaved race ids are logged |
| Nickname changes do not create identities                    | Renames update the same row (store and API tests)                   |
| Query cost at scale                                          | Below                                                                |

`npm run dbbench -w @circuit-breaker/server` seeds a throwaway schema in `TEST_DATABASE_URL`
with 100,000 profiles, 50,000 rated races and 200,000 result rows (vacuumed, as autovacuum
would leave a live database), times every store call 40 times, prints the plans, and drops
the schema. PostgreSQL 17.11 in Docker on the machine of section 2:

| Call                                         | p50       | p99       |
|----------------------------------------------|-----------|-----------|
| Leaderboard page 1 (count + 25 rows)         | 10.9 ms   | 13.1 ms   |
| Leaderboard at offset 10,000 (the deepest)   | 15.1 ms   | 16.7 ms   |
| Rank of the leader / median / last profile   | 5.3 / 10.5 / 14.4 ms | 7.1 / 11.8 / 15.7 ms |
| Search, 10% of names match                   | 21.2 ms (Step 8 SQL: 66.8) | 23.9 ms (173.5) |
| Search, a few scattered matches              | 61.7 ms (111.6) | 79.9 ms (133.3) |
| Search, nothing matches                      | 2.1 ms (44.7)   | 2.8 ms (60.7)   |
| Profile by id / by session cookie / history  | 0.9 / 1.3 / 1.2 ms | 1.4 / 2.1 / 2.2 ms |
| Rate a 4-player race (one transaction)       | 18.3 ms   | 20.6 ms   |

Ranks are counted (a profile's rank is the number of profiles ahead of it), so they cost more
the further down the board: ~10 ms in the middle of 100,000. PostgreSQL cannot answer that
count from the expression index alone (it still visits the table), so a much larger board
would want a stored rank or a materialised view; at this game's size it is not needed.

## 8. Performance

Each change below was made because a measurement showed a problem, and each was measured
again after it. Everything else was profiled and left alone.

| Area                | Measured                                                                | Change |
|---------------------|-------------------------------------------------------------------------|--------|
| Snapshot delivery   | 3% of snapshots discarded in an 8-car race; client gaps up to 156 ms (F6) | Skip only for a real backlog: 0 discarded, gap p99 63.9 ms |
| Remote cars         | 93% of frames guessed ahead at 200 ms (F7)                              | Delay counts from the snapshot's arrival: 100% interpolated |
| Background tab      | Unbounded snapshot queue (F8)                                           | Newest 20 kept |
| Shader first use    | 200–600 ms frames at every race start and first boost (F18)             | Warm-up also does the first use: longest frame 63.5 ms |
| Leaderboard search  | 45–174 ms at 100,000 profiles (F10)                                     | Name index first, one ranking walk: 2–62 ms |
| Abuse resistance    | One client could take a CPU core (F1)                                   | Message budget: the attacker costs 3–12% before it is dropped |

**Client profile** (dev build, 1920×1080, frame rate uncapped, the Radeon 680M; Chrome
DevTools protocol: a React commit hook counting which components rendered, the sampling heap
profiler, the CPU profiler, the renderer's draw-call counters; 15 s per measurement):

| Scene                     | FPS   | Frame p50 / p99 / max (after F18) | Draw calls | Triangles | React commits/s | Allocations (live after 15 s) | Garbage collection |
|---------------------------|-------|-----------------------------------|------------|-----------|-----------------|-------------------------------|--------------------|
| Menu (attract race)       | 148   | 6.6 / 11.7 / 15.2 ms              | 101        | 83,000    | 0               | 0.13 MB                       | 0.1% of CPU        |
| Solo race                 | 130   | 7.0 / 28.3 / 63.5 ms              | 107        | 83,000    | 0.1             | 0.12 MB                       | 0.1%               |
| Online, 8 cars (7 bots)   | 94.5  | 9.9 / 30.8 / 33.8 ms              | 125        | 84,000    | 0.4             | 0.37 MB                       | 0.1%               |

* **React re-renders: none to remove.** The HUD writes its per-frame numbers straight into the
  DOM (`useAnimationFrame`); React commits under once a second in a race (the ability icons,
  the position panel, the standings when they change).
* **Per-frame allocations: none worth removing.** 0.1–0.4 MB live after 15 s, garbage
  collection 0.1% of the main thread, the heap stable.
* **Where the frame goes:** WebGL calls, uniform uploads above all (`uniformMatrix4fv` ~27–29%
  of main-thread time: one model matrix per drawn object). Fewer draws would mean merging the
  car and scenery meshes further. With 94–148 fps at 1080p on an integrated GPU, that was
  not worth the risk to the visuals in this step, and no visual feature was removed.
* **Network messages:** a snapshot is 0.7–1.1 KB (8 cars), 20 a second per player: about
  22 KB/s down per player at 8 cars (180 KB/s for an 8-player room), as designed. Inputs:
  31 messages a second per player. No change.
* **Database queries per request:** one to three short indexed queries per API call (§7); the
  rating write is one transaction off the race loop. No change.
* The 8-car online figure was taken with the server, Vite and seven bot players running on
  the same machine as the browser.

## 9. What is still open

Nothing Critical or High is known to be open. Medium and Low items that remain, all by design
or by scope:

| Sev    | Item                                                                                      |
|--------|-------------------------------------------------------------------------------------------|
| Medium | One person with several profiles can still feed a main profile some rating; only the rematch damping and Elo's expectations limit it (Step 8). No collusion detection. |
| Medium | Ratings waiting for the database are lost if the process restarts during an outage (they were never shown as saved; the shutdown log names them). |
| Medium | One process holds every room in memory: a restart or deploy ends every race (players are told "The server is restarting"). No horizontal scaling (it would need sticky sessions and a room → process map). |
| Low    | A player whose network silently dies keeps a "connected" seat until the server's ping timeout (11–13 s; 11.1 s measured); a new seat for the same profile in that time is unrated. |
| Low    | Rank counts grow with the leaderboard (about 10 ms at 100,000 profiles).                 |
| Low    | Load figures come from one Windows machine (section 5); production hardware, Linux timers and a real network will differ. |
| Low    | `/metrics` without `METRICS_TOKEN` answers only on the server's own machine; set the token to read it from outside. |

### Production deployment risks

1. **`TRUST_PROXY` must be set behind the host's proxy** (Render, Railway: `1`). Without it,
   every player has the proxy's address, so the per-address limits apply to everyone at once:
   the 33rd connection, the 7th room in a minute, the 21st profile made at once would be
   refused. The server logs a warning the first time a request carries `X-Forwarded-For` while
   `TRUST_PROXY` is 0.
2. **No production database exists yet** (Step 8): set `DATABASE_URL` and check `/ready`
   (`checks.database: "ok"`). Migration 2 (an index) runs at boot.
3. **Capacity is estimated, not measured, on the host**: 100 clients took 39% of one core here.
   Watch `/metrics` (`process.cpuPercent`, `simulation.tickLateMs`) after launch; set
   `MAX_CONNECTIONS` to what the host's CPU actually carries.
4. **Deploys end live races**: deploy between sessions.
5. **The client and server deploy together** (protocol 4; one build).

## 10. Running the checks

```bash
npm run check
```

Typecheck, lint, every test (database tests on PGlite) and the production build.

```bash
npx prettier --check .
```

```bash
npm test -w @circuit-breaker/server
```

With `TEST_DATABASE_URL` set (a database the tests may add schemas to; never `DATABASE_URL`),
the database tests also run on PostgreSQL.

```bash
npm run harness -w @circuit-breaker/server
```

All 18 scenarios (about 3 minutes); name some to run only those, e.g. `-- net-latency net-loss`.

```bash
npm run build && npm run load -w @circuit-breaker/server
```

The load levels (about 13 minutes; `-- --levels 2p,8p --seconds 60` for fewer). Results print
and go to `load-results.json`.

```bash
npm run dbbench -w @circuit-breaker/server
```

Leaderboard queries on 100,000 profiles (needs `TEST_DATABASE_URL`; about 1 minute).

```bash
npx tsx apps/server/scripts/netem.ts --listen 4400 --target localhost:5173 --latency 50 --jitter 10
```

A bad link for a real browser: open `http://127.0.0.1:4400` (the dev client behind it), then
type `outage 3000`, `cut /socket.io/`, `latency 100` or `loss 0.03` into the terminal.

## 11. Results after Step 9

| Check                                          | Before (§2)        | After                                         |
|------------------------------------------------|--------------------|-----------------------------------------------|
| `npm run check`                                | pass               | pass (86 s)                                   |
| Shared tests                                   | 108                | 116                                           |
| Server tests (PGlite)                          | 86                 | 124                                           |
| Server tests with PostgreSQL 17                | 107                | 146                                           |
| Prettier                                       | clean              | clean                                         |
| Harness                                        | 10 scenarios pass  | 18 pass (163.4 s), 8 of them on bad links     |
| Load test                                      | none               | 6 levels, 2 to 100 clients, all stable (§5)   |
| Browsers on bad links                          | none               | 14/14 checks; the no-frames check passed (§6.2) |
| Production smoke (built server, browser, rated race) | 10/10 in Step 8 | 12/12                                     |
| Client bundle                                  | 1,724.60 kB (518.50 kB gzip) | 1,725.19 kB (518.66 kB gzip)        |
| Server bundle                                  | 180.9 kB           | 206.7 kB                                      |

New test files: `packages/shared/test/boundary.test.ts` and `remote.test.ts`;
`apps/server/test/security.test.ts`, `integrity.test.ts`, `ops.test.ts` and
`shutdown.test.ts`; more cases in `api.test.ts`, `ranking.service.test.ts` and
`ranking.store.test.ts`.
