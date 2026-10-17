# 04 — Networking

Status: **implemented in Step 4** (real-time multiplayer, 2–8 players), extended in Step 5
(abilities), Step 7 (car choices, race ids on every message, results and session points) and
Step 8 (profiles on seats, and each race's global rating; the HTTP side is in
`08-ranking.md`).
This document describes the netcode as built. The numbers in it come from the code and from
measurements, and each section names the file that owns the behaviour.

## 1. Model in one paragraph

The server runs the authoritative `RaceSimulation` of each room at a fixed 60 Hz. Clients send
only **intent**: lobby requests, and input frames stamped with the tick they apply to. Each
client runs a few ticks **ahead** of the server, so its inputs arrive before their tick runs.
It **predicts** its own car with the same shared simulation and **re-bases** on every
snapshot. Other cars are drawn from snapshot history, **interpolated** about 110 ms in the
past. Race outcomes are computed only on the server: checkpoints, laps, Energy, boosts, finish
order and results. They reach clients as reliable events and snapshot rows. Cars are
**ghosts**: they never touch each other.

## 2. Transport

* Socket.IO 4.8, WebSocket only on both ends (Step 9: the server refuses long-polling, which
  the client never used and which would only add surface).
* Same origin everywhere. One Node process serves the built client, Socket.IO and the ranking
  API (`/api/`) on one port. In development, Vite proxies `/socket.io` (with `ws: true`) and
  `/api` to the game server on `127.0.0.1:3001`, and `vite preview` does the same.
* Delivery:
  * A snapshot is skipped only when that player's connection already has 8 messages waiting to
    be written (really behind); a newer one follows 50 ms later. (Until Step 9 snapshots used
    Socket.IO's `volatile` flag, which also dropped one whenever the previous message was
    still being written: about 3% of snapshots in an 8-car race.)
  * Everything else is reliable and ordered: room state, race start, events, results.
* Messages over 4 KB close the connection (the largest real one is a few hundred bytes);
  `pingInterval` 5 s, `pingTimeout` 8 s; a connection must finish the Socket.IO handshake
  within 10 s.
* Admission (Step 9): the handshake must come from this site's page (Origin host = Host) or
  `CORS_ORIGIN`; at most `MAX_CONNECTIONS` (1000) open, `MAX_CONNECTIONS_PER_IP` (32) from one
  address, and as many new connections per address at once as that cap, then twice the cap a
  minute. Every message, whatever its event, counts against a per-connection budget (120 at
  once, 60 a second; a playing client sends about 31); 300 refused drop the connection.
* The client reconnects automatically: 400 ms backoff rising to 2 s, 6 s connect timeout.
  After a reconnect it resumes its seat with its token (§9).

Files: `apps/server/src/net/socketServer.ts`, `apps/client/src/net/connection.ts`,
`packages/shared/src/net/protocol.ts`.

## 3. Clocks and ticks

* `TICK_RATE = 60`. The server tick is the only clock that matters.
  * The suggested rates were 30 Hz simulation and 15–20 Hz snapshots. The simulation stays at
    60 Hz because the vehicle model and the race rules were tuned at 60 Hz, and the client
    must replay at the server's rate. The cost is about 10 µs per car-tick (`/health`
    reports it).
  * Snapshots go out at 20 Hz (`SNAPSHOT_RATE`, 5–60).
* **Server loop.** `RoomManager.start()` runs every 4 ms. Each room steps as many ticks as real
  time requires, from its race's start timestamp: `due = floor((now − startTime) / 16.67 ms)`.
  A stall catches up at most 600 ticks.
* **Start timestamp.** The host's Start schedules tick 0 at server time `now + 600 ms`.
  Every client receives that same `startTime` and `goTick` (300, i.e. 5 s), so everyone's
  countdown ends on the same server tick, whatever their latency.
* **Clock sync** (`ClockSync`, `packages/shared/src/net/clock.ts`).
  * The client sends `clock:ping t0`, and the server answers `{t0, now}`.
  * Each sample gives `offset = serverNow + rtt/2 − received`. The estimate averages the three
    lowest-RTT samples of the last ten, because the fastest round trips queued least.
  * Pings: a burst of 5 at connect, then one per second.
  * Corrections over 120 ms snap. Smaller ones slew at 5 % of real time, so time never runs
    backwards on screen.
  * Test: exact under symmetric delay with any jitter; within half the asymmetry otherwise.

## 4. Messages

Client → server (every request is acknowledged with `{ok, data}` or `{ok: false, error}`):

| Event          | Payload                                         | Who                                   |
|----------------|-------------------------------------------------|---------------------------------------|
| `room:create`  | `{name, version, color?, style?, ticket?}` → seat grant | anyone not seated (6 rooms/min per IP) |
| `room:join`    | `{code, name, version, color?, style?, ticket?}` → seat grant | anyone not seated          |
| `room:resume`  | `{token, version}` → seat grant                 | the holder of the seat token          |
| `room:leave`   | `{}`                                            | seated                                |
| `room:ready`   | `{ready, raceId}`                               | seated, lobby or results              |
| `room:vehicle` | `{color, style}`                                | seated, between races, free colour only |
| `room:laps`    | `{laps}` 1–5                                    | host, lobby only                      |
| `room:start`   | `{raceId}`                                      | host, lobby, ≥ 2 connected ready (host counts) |
| `race:restart` | `{raceId}`                                      | host, results, ≥ 2 connected ready (host counts) |
| `race:lobby`   | `{raceId}`                                      | host, results only                    |
| `session:new`  | `{}`                                            | host, lobby only                      |
| `input`        | `[raceId, firstTick, t, b, s, buttons, …]`      | seated racers in a running race       |
| `clock:ping`   | `t0` → `{t0, now}`                              | anyone                                |

A seat grant is `{playerId, token, room}`. `playerId` is public. The token is a 192-bit
secret that only the owner holds. `color` and `style` on create and join are the car the
player last chose (kept in the browser); an invalid one is ignored, and a colour already taken
in the room is replaced by the first free one. `ticket` is a single-use pass from
`POST /api/me/ticket` that binds the seat to the browser's persistent profile (`08-ranking.md`
§4); without a valid one the seat has no profile and its races are unrated. Every request made
from a lobby or results screen names the `raceId` that screen showed (§9b).

Server → client:

| Event          | Payload                                                                      | Delivery |
|----------------|------------------------------------------------------------------------------|----------|
| `room:state`   | code, phase, hostId, laps, raceId, sessionId, sessionRaces, ranking, players `[{id, name, color, style, ready, connected, host, racing, graceUntil, points, races, wins, rank, profileId, tag, rating}]` | reliable |
| `race:start`   | `{raceId, trackId, laps, tickRate, startTime, goTick, startEnergy, snapshotRate, racers: [{id, name, color, style, slot}]}` | reliable |
| `race:snap`    | `{id, t, r: rows[], c: inactive cells, k: track state, me?, b?, m?}` (§6, §6b) | volatile |
| `race:events`  | `{id, t, e: RaceEvent[]}`: public events, plus the recipient's own refused abilities | reliable |
| `race:results` | `{raceId, sessionId, raceNumber, laps, winnerId, entries: [{id, name, color, style, slot, position, finished, dnf, dnfReason, totalTime, bestLap, lapTimes, points, sessionPoints, sessionRank, stats}], abilities: [{time, racerId, name, ability, ok, reason, from, until, lane}]}` | reliable |
| `race:rating`  | `{raceId, status, reason, entries: [{id, profileId, before, delta, after, rank}], unrated: [{id, reason}]}` | reliable |
| `room:closed`  | `{reason}`: the seat was resumed elsewhere, or expired                       | reliable |

`race:rating` follows `race:results`: first `pending` (or `unrated` with the reason), then
`rated` once the database has committed the race (or `retrying`, then `rated` or `failed`).
A player who joins or comes back while the results are shown gets the latest one. `ranking`
in the room state says whether the server rates races at all; `profileId`, `tag` and `rating`
are null for a seat without a profile.

`graceUntil` is the server time at which a disconnected seat is given up (null while
connected); the lobby counts it down. `stats` is `{boosts, overdrives, shortcuts, gateShifts,
shortcutRuns, energy, driftSeconds, topSpeed, wallHits}`, all counted by the server's
simulation (§9b).

Step 5 raised `PROTOCOL_VERSION` to 2: the input buttons, the snapshot row and `k` changed.
Step 7 raised it to 3: input packets and lobby requests name their race, snapshots and events
carry the race id, and the room state and results gained the car and session fields. Step 8
raised it to 4: seat tickets, the profile fields, `ranking` and `race:rating`. A client of
another version is refused at the door.

**Measured sizes** (JSON payload before Socket.IO framing, autopilot race, Step 4; Step 5
adds the track state, about 35 bytes, and 2 bytes per car):

| Field      | Snapshot     | Downstream per player | Upstream per player       |
|------------|--------------|-----------------------|---------------------------|
| 2 players  | 590 bytes    | ≈ 12 KB/s             | ≈ 2 KB/s (72-byte packets, 30/s) |
| 8 players  | 1,020 bytes  | ≈ 20 KB/s             | ≈ 2 KB/s                  |

## 5. Inputs: tick-stamped, ahead of the server

* **Frames.** A frame is four small integers:
  * throttle 0–100, brake 0–100, steer −100–100
  * buttons: boost 1, drift 2, reset 4, shortcut 8, gate 16, overdrive 32 (any higher bit
    makes the packet malformed)
* **Packets.** A packet is `[raceId, firstTick, ...frames]`. The client sends one every 2
  ticks, and each repeats the last 6 frames, so a lost or late packet costs nothing. A packet
  for another race (one sent just before a race ended) is dropped whole.
* **Prediction uses the quantised input.** The client predicts with the frame exactly as it
  will be applied, quantised the same way. This makes prediction bit-identical to the server
  when frames arrive in time.
* **Input lead** (`InputLead`). The client simulates tick `serverTick + lead`.
  * The lead starts at one-way latency plus twice the jitter, plus a 2-tick cushion
    (2–40 ticks).
  * Each snapshot carries feedback for its recipient:
    * `b`: how many ticks ahead the newest received frame was
    * `m`: ticks the server had to guess since the last snapshot
  * A short cushion or a guessed tick raises the lead by 1–6 ticks, at most once per
    round trip.
  * A cushion above 4 ticks lets the lead drift down by 0.05 per snapshot.
  * Measured lead: 6–7 ticks at 50 ms round trip, about 11 at 200 ms.
* **On the server** (`Room.receiveInput`, `Room.stepRace`).
  * A frame is stored for its tick. Tick *t* applies exactly the frame stamped *t*.
  * Refused:
    * frames for ticks that already ran (late)
    * frames more than 120 ticks ahead
    * duplicates: the first copy wins
    * malformed packets (§10)
  * A missing frame repeats the last frame for up to 15 ticks; after that the car coasts on
    neutral input. Inputs are held state, so a repeat is the right guess.
  * Press-triggered actions (boost, reset, the three abilities) fire on a press edge in the
    simulation, so a repeated frame never fires them twice.
* **Ability presses on the client.** A tap would fill one frame, and one late frame would lose
  it, so the client takes three precautions:
  * a press stays down for 6 ticks (100 ms); the press edge still fires it once
  * the tick holding a fresh press is sent at once, not with the next packet, so a slow frame
    that follows cannot hold it back
  * after a stall the client first catches up through ticks the server has already played;
    presses wait for the first tick still ahead of the server instead of being spent on those
  On a frozen client the press lands as soon as it runs again: late, but never lost.

A client cannot gain by sending frames early or late. Early frames are capped, and late ones
are discarded. Timing is the server's tick, never the client's clock.

## 6. Snapshots and the local car

A snapshot carries:

* `r`: one row of 21 integers per racer:
  * slot
  * position (cm), yaw (mrad), velocity (cm/s), yaw rate
  * flags: boosting, drifting and its side, pad, launch impulse, frozen, braking, lane, air,
    ground, finished, retired, offline, wrong way, Overdrive
  * steer, throttle, Energy, laps, next gate, position
  * track distance, finish time and best lap (ms), drift ticks
  * road: 0 the main loop, 1 the Needle
* `c`: the Energy cells currently taken, with their respawn ticks.
* `k`: the track state (§6b).
* `me`, `b` and `m`, sent only to a player with a car in the race:
  * `me` is the player's own car in full: every vehicle field at full precision, plus the race
    bookkeeping that feeds back into driving (laps, gates, launch window, reset edge, timers,
    pad cooldowns, ability cooldowns and held ability buttons, speed-lane progress, the
    road and the split lane)
  * `b` and `m` are the input feedback (§5)

The local car runs in the shared `Predictor` (`packages/shared/src/net/predictor.ts`). This
is a `RaceSimulation` holding only this player's car, with a 256-tick history of the inputs it
applied. On each snapshot:

1. **Re-base.** Restore the car from `me` at tick *t*, apply the cells and the track state,
   then replay the recorded inputs *t+1…now*.
   * When the server applied the same inputs, the replay lands exactly where the prediction
     was: the correction is 0.
   * Lap times the replay re-records are trimmed first.
2. **Hide what moved** (`GameSession.updateOnline`).
   * A correction above 6 m snaps, as after a respawn or a resume.
   * Anything smaller stays where it was drawn, and the difference fades out with a 0.12 s
     time constant. Small errors correct gradually, large ones at once.
3. **Feedback timing.** Events of a tick are reported once, the first time it is simulated.
   * Immediate feedback comes from the prediction: countdown beeps, GO, boost, denied boost,
     pads, cells, drifts, wall hits, respawns, and an ability's own use or refusal.
   * Checkpoints, laps, finishes and retirements come only from the server's events, and so
     does the race feed: who used which ability, and how the track changed.
4. **Link checks.**
   * With no snapshot for `lead + 60` ticks, the car stops instead of driving on blind. The
     HUD shows "Connection unstable" after 700 ms without one.
   * The server keeps simulating, so the car coasts there.

The HUD's lap, position and best lap come from the server's row, never from the prediction.

## 6b. The changeable track

The shortcut and the gate are seven integers of race state (`CourseState`,
`packages/shared/src/sim/course.ts`). They are server ticks, not flags:

* the Needle: when it opens, when it closes, and when it may be opened again
* the gate: the open lane, the lane it is switching to, the switch tick, and when it may be
  shifted again

An ability writes the future: Shortcut sets an opening tick 45 ticks ahead, and Gate Shift a
switch tick 150 ticks ahead. Whether the Needle is open, or which lane is, follows from the
tick (`shortcutOpenAt`, `gateLaneAt`). Two machines at the same tick therefore always agree,
and nothing needs a "now" update.

* **Delivery.** Every snapshot carries the state as `k`, and the client's re-base restores it
  before replaying, like the car. A player who joins late or reconnects has the current state
  from the first snapshot, a change in progress included.
* **Ahead of time.** A change is scheduled 0.75 s or 2.5 s ahead, so every client learns of it
  before it acts, even at 200 ms round trip. The prediction never has to guess one.
* **Events.**
  * `ability`: who used what, and their Energy after it (public)
  * `abilityDenied`: the reason (`phase`, `cooldown`, `busy`, `energy`, `unavailable`), to
    that player only
  * `shortcut` (opening, open, closing, closed) and `gate` (warning, switched)
  * `overdriveEnd`
* **Record.** The server logs every request: time, player, ability, success or refusal, and the
  track state it produced (the Needle's open window, the gate's new lane and switch time). The
  log goes out with the results.

## 7. Remote cars

`RemoteTrack` (`packages/shared/src/net/interpolation.ts`) keeps 48 snapshots per car.

* **Render time.** Cars are drawn at `serverNow − (max(100 ms, 2.2 × snapshot interval +
  jitter) + rtt / 2)` (`remoteDelayMs`): a snapshot arrives about half a round trip after the
  server made it, so the delay counts from there, and one almost always exists on both sides
  of the drawn moment (100% of frames at 50, 100 and 200 ms in the Step 9 harness; before the
  `rtt / 2` term, 7% at 200 ms). The delay eases toward each new value at a tenth of real time
  (`RemoteDelay`), so the drawn moment never jumps when the round-trip estimate changes. The
  server announces its snapshot rate in `race:start`, so a server run at another
  `SNAPSHOT_RATE` gets a matching delay.
* **Interpolation.**
  * Position: cubic Hermite through position and velocity. Through 20 Hz samples this follows
    braking and acceleration without the corner-cutting and speed wobble of linear
    interpolation.
  * Yaw: the shortest arc.
  * Steer and throttle: blended.
  * Flags and discrete fields: taken from the nearer sample.
* **Respawns** are recognised (a jump speed cannot explain, or a newly frozen car). The car
  snaps instead of sliding across the map.
* **Late packets.** With no newer snapshot, the car extrapolates from velocity for up to
  9 ticks (150 ms), then holds. Delays never freeze the race. After the race ends there is no
  extrapolation.
* **Event timing.** Other cars' events (boosts, pads, cells, wall hits, finishes) wait until
  the car is drawn at that tick. A pad flashes as the car crosses it on screen, not 110 ms
  earlier.
* **Cells.** A cell another player takes is removed from the local prediction as soon as the
  event arrives. The local car does not "collect" it too and then get corrected.

Visuals: `apps/client/src/scene/vehicle/RemoteCars.tsx`. Each car has:

* the same car model in its seat colour
* wheels that roll and steer
* brake and reverse lights
* exhaust flames and two trails that switch to magenta while boosting
* underglow, drift sparks
* a name tag (constant on-screen size, shrinking and fading out by 170 m)

There is no spotlight or point light per remote car. The local car keeps those, which also
sets it apart.

## 8. Collisions: ghost cars

Cars do not collide with each other. Each car still obeys the track: barriers, off-track
respawns, gates and pads.

* **Prediction stays exact.** A contact the client cannot know about in advance would
  otherwise force a correction on every touch.
* **Fairness.** With ghosts, latency cannot decide a collision, and blocking or ramming cannot
  work. There is no damage or combat by design.

The cost is realism: a car can drive through another. To make that read as intended, a remote
car fades as it nears the local car: from full opacity at 8 m to 30 % at 3.5 m.

## 9. Rooms, lifecycle, disconnects

```
WAITING ──≥2 connected and ready (host counts)──► READY ──host Start──► COUNTDOWN
COUNTDOWN ──server tick 300──► RACING ──first finisher──► FINISHED (others get 25 s)
FINISHED ──all done, or time up──► RESULTS (scored once, ready flags cleared)
RESULTS ──host: Race again, ≥2 connected ready (host counts)──► COUNTDOWN (same room)
        └─host: Return to lobby──► WAITING (ready cleared)
WAITING / READY ──host: New session──► the same phase, every player's points back to 0
```

* **Rooms.**
  * Codes are 6 characters from an unambiguous alphabet (no 0/O, 1/I/L), from
    `crypto.randomInt`, roughly 887 million combinations.
  * Joining is case-insensitive and ignores spaces and dashes. An invite link is
    `/?room=CODE`.
  * Each new player gets the colour they asked for if it is free, else the lowest free one,
    and the body style they asked for. Colours stay unique in the room. Duplicate names gain
    a number ("Ace 2").
  * A room holds at most 8 seats and is deleted when the last one goes.
* **Grid.** The reverse of the session standings: fewest points at the front, then fewer
  wins, then join order, so a session's first race starts in join order (`compareGrid`). A
  race takes the connected players who are ready, the host's Start or Race again counting as
  the host's ready; the others follow it in the lobby's live standings.
* **Joining mid-race.** The player watches the live standings from the lobby and races the
  next one.
* **Disconnect.** The seat and the car stay for 30 s (`RECONNECT_GRACE`). Others see the player
  as offline: the lobby counts down the seconds the seat is held, and the race feed says who
  dropped and who is back. A disconnected player is never put on a new grid, and keeps their
  session points while the seat is held.
  * The car repeats its last input for 15 ticks, then coasts.
  * The token (sessionStorage, one seat per browser tab) resumes the seat on a new connection.
    The car, laps, gates, Energy and timers are untouched, because they never left the server.
    The client receives the race again and re-bases on the next snapshot.
  * A second connection resuming the same seat closes the first.
  * There is never a duplicate seat or car.
* **Permanent disconnect** (grace expired, or Leave).
  * The seat is removed, and its session points with it: coming back by code is a new player
    at 0.
  * A car still racing retires: it stops, is no longer simulated, and ranks last as DNF.
  * The host role passes to the longest-standing connected player. A host who only
    disconnected keeps the role while the seat is held.
* **Race end.** The race ends when every car has finished or retired, or 25 s after the first
  finisher. It also ends if a 3-minutes-per-lap cap runs out. Cars still running are DNF.

## 9b. Race ids, results and the session (Step 7)

Shared rules: `packages/shared/src/session/` (`results.ts`, `scoring.ts`). Server:
`Room.finishRace`, `classify` and `score`.

* **Race ids.** Each race started in a room takes the next `raceId`.
  * Input packets name it, and the server drops a packet for any other race (counted per
    seat as stale, never applied).
  * Snapshots and events carry it as `id`. The client drops anything from a race other than
    the one it shows, so a message from the previous race can never move a car or a
    standings line of the next.
  * Lobby and results requests carry the `raceId` their screen showed. If the room has raced
    since, the server answers "That was for an earlier race. Try again." and changes nothing.
    A request without a valid id is refused as malformed.
* **Classification** (`classifyRacers`, deterministic, never the client's): finishers by
  sub-tick finish time, then cars still racing when the race was called, by distance covered,
  then cars whose player left, by distance covered. Exactly equal results are ordered by grid
  slot. The sort never depends on the input order, and it agrees with the simulation's own
  standings.
* **Points** (`racePoints`, table in `scoring.ts`): 100, 80, 65, 50, 40, 30, 20, 10 for
  1st–8th among finishers. A DNF scores `DNF_POINTS` (0), whatever its place.
* **Once only.** Results are made once, on the server, when the race ends. The race is marked
  scored before its points are added, and points go only to the session the race started in,
  and only to seats still in the room. Results reach everyone in the room, and anyone who
  joins or comes back while they are shown.
* **Session standings** (`compareSession`): points, then wins, then join order. Every rank
  is distinct, and each `room:state` carries points, races, wins and rank per player.
* **Leaving.** A player who leaves mid-race is DNF (`dnfReason: 'left'`) with 0 points. A
  disconnected seat keeps its points for the 30 s grace; once the seat is removed, its points
  go with it.
* **New session** (host, lobby only): `sessionId` + 1, every player's points, races and wins
  back to 0. Sessions live in server memory only: nothing is stored, and a new room starts
  a new session.
* **Race again** keeps the room, the seats, their cars and their points, and starts a new
  `RaceSimulation`: positions, laps, timers, Energy, abilities, the track state and the input
  queues all start from nothing.
* **Coming back late.** A seat that resumes gets the room state, then the running race (to
  drive or watch) or the results being shown.

## 10. Validation and security

| Threat                                | Defence                                                                 |
|---------------------------------------|-------------------------------------------------------------------------|
| Teleport, speed or position edits     | Clients never send state. The server simulates every car              |
| Fake laps, checkpoints, finish, results | Only the server's simulation produces them (gates in order, sub-tick finish times); client-sent events are ignored |
| Unlimited Energy or boost             | Energy, burst cost, cooldown and pickups exist only in the server's simulation; one burst per press |
| Duplicate pickups                     | A cell is taken once on the server and respawns on its timer           |
| Controlling another car               | The seat comes from the connection that created, joined or resumed it, never from a client-sent id |
| Fake player ids                       | Ids are public names, not credentials. Only the 192-bit token resumes a seat |
| Unauthorised start, restart, laps, new session | Host and phase checked for every request                     |
| Two starts, overlapping races         | Start and Race again are refused while a race runs; a second quick press gets "A race is already running." |
| Duplicate ready                       | A repeated ready request changes nothing and is not broadcast          |
| Stale requests, packets and messages  | Race ids on requests, input packets, snapshots and events (§9b)        |
| Duplicate scoring                     | A race's points are added once, to the session it started in (§9b)     |
| Forged results, positions, times or points | No message carries them from a client; the server derives them all from its simulation |
| Invalid cars, or another player's colour | Car choices are checked indices; a colour another seat holds is refused; a request changes only its own seat's car |
| A seat claiming a profile             | Only a server-issued ticket (single use, 60 s) binds one; a profile id in the payload is ignored |
| Rating a race twice, or from a client | The room hands its own results over once; the race's UUID is the database key (`08-ranking.md` §6) |
| Malformed or extreme input            | Strict packet decoding: integers in range, at most 12 frames, otherwise the whole packet is refused |
| Input flooding                        | 45 packets/s per seat (burst 40); a connection with 400 refused or malformed packets is dropped |
| Message flooding, any event (Step 9)  | 60 messages/s per connection (burst 120), unknown events included; 300 refused drop it; over 4 KB closes it |
| Request flooding                      | 10 requests/s per connection (burst 20); 6 room creations per minute per address |
| Connection flooding (Step 9)          | 1000 open in total, 32 per address, new ones per address limited; handshake within 10 s |
| Other sites using visitors' browsers (Step 9) | WebSocket handshakes only from this site's page (or `CORS_ORIGIN`) |
| A failing handler or room (Step 9)    | Every listener guarded (the player gets an error id); a failing room is closed alone |
| Bloated results (Step 9)              | At most 20 refused ability presses recorded per car |
| One profile in several seats (Step 9) | One seat per profile: a second, while the first is connected, races unrated |
| Invalid codes, names, versions        | Codes normalised and checked against the alphabet; nicknames NFKC-normalised, stripped to letters, numbers and simple punctuation, 16 characters; protocol version checked |
| Joining twice                         | A seated connection cannot create or join again                         |
| Full rooms                            | The ninth join is refused                                              |
| Cross-room leakage                    | Every message is sent per seat of one room; tested with two rooms racing at once |
| Spending Energy twice, or below zero  | The ability is checked, paid and applied in one simulation step; Energy stays within 0–100 |
| Ability spam, held or repeated buttons | Abilities fire on a press edge only; per-player cooldowns and track-wide locks; presses during the countdown are swallowed |
| Simultaneous requests                 | Racers resolve in grid order within a tick: the first valid press wins and the next is refused as busy, the same on every machine |
| Fake ability messages                 | There are none to send: an ability is a bit in an input frame. The feed online shows only the server's events |
| Abilities for someone else, or while watching | The press is part of the seat's own input; a player without a car in the race has none |

## 11. Testing

* **Unit tests.**
  * `packages/shared/test/net.test.ts`:
    * codec, clock and interpolation
    * networked races through a simulated link at 0, 50, 100 and 200 ms with jitter: identical
      finish time and no visible corrections, with and without abilities in use
    * a full 8-car field, same-tick finish ranking, retirement
  * `packages/shared/test/abilities.test.ts`: costs, refusals, cooldowns, held buttons,
    simultaneous presses, farming limits, the Needle (timeline, never trapped, a lap through
    it meeting every checkpoint), the gate (warning, lock, no barrier onto a committed car),
    Overdrive (length, cooldown, no stacking with bursts)
  * `apps/server/test/abilities.test.ts`: the server's own checks with real inputs: the same
    Energy and track state for every peer, private refusals, duplicates and held buttons,
    simultaneous presses, a watcher, a malformed button, a reconnect during a gate change,
    room isolation, the results log
  * `apps/server/test`:
    * rooms, capacity, ready and host rules, start timestamp and grid
    * input validation, own-car-only control, Energy and boost rules, laps through gates only
    * disconnect, resume and expiry, joining mid-race
    * real-socket tests on an ephemeral port, including race ids, car choices and a client
      trying to send results
  * `packages/shared/test/session.test.ts`: the points table and DNF, session ranking, the
    reverse grid, classification groups and ties, agreement with the simulation's standings
    in a real race, car choices
  * `apps/server/test/session.test.ts`: car selection, duplicate and stale ready, a single
    start, a disconnected ready player left off the grid, DNF for leaving and for running out
    of time, best laps, points added once, Race again resetting the race but keeping players, cars and
    points, three races in a row, new sessions, host leaving after a race, points of a
    disconnected seat, reconnecting between races, stale input, two rooms apart
  * Step 8 (`08-ranking.md` §9): `rating.test.ts` in shared; `ranking.store.test.ts`,
    `ranking.service.test.ts`, `api.test.ts` and `ranking.room.test.ts` in the server, the
    last including seat tickets over real sockets
* **Harness** (`npm run harness -w @circuit-breaker/server`, about 3 minutes). It starts an
  in-process server and real Socket.IO bot clients, each with simulated latency. The bots run
  the browser's netcode and the autopilot. Scenarios:

  | Scenario    | What it covers                                                        |
  |-------------|-----------------------------------------------------------------------|
  | `2p`, `4p`, `8p` | 50–200 ms round trip with jitter                                 |
  | `two-rooms` | two rooms racing at once                                              |
  | `drop`      | the host disconnects for good mid-race                                |
  | `rejoin`    | a player drops and resumes mid-race                                   |
  | `photo`     | a finish about 5 ms apart                                             |
  | `abilities` | each bot uses one ability; every client must see the same track state at every tick |
  | `session`   | three races in a row: car choices, refused stale and repeated restarts, the points table, cumulative points, the reverse grid, no stale messages, a new session |
  | `ranking`   | three rated races: profiles made over HTTP, seats from tickets, one car without a profile; every player hears `pending` then the same saved rating; the leaderboard and profiles agree, each race stored once |

  The harness keeps its ratings in a throwaway database: PostgreSQL when `TEST_DATABASE_URL`
  is set, else PGlite.

  Every race checks:
  * identical start info and identical results on every client
  * distinct grid slots
  * results ranked by finish time, DNF last

  It also checks prediction corrections. When the server never had to guess an input, it
  compares the server's results with an offline replay of the same inputs.

  `-- --join CODE --bots N` fills a browser's room with bots (`--profiles`: rated bots).
* **Measured** (this machine, harness):
  * 2, 4 and 8 players at 20–200 ms round trip: zero prediction corrections.
  * Every race was bit-identical to the offline replay.
  * The photo finish was ranked by its gap (13 ms in Step 4; about 5 ms since Step 5, whose
    track changes meant the pair had to be found again: neither car boosts now, so neither
    depends on cells the other took first).
  * Abilities (Step 5): each ability worked once and was announced to every bot at the same
    tick; about 2,000 snapshot pairs compared, the track state never differed.
  * Sessions (Step 7): three races in one room, every car finishing each; points 300, 240
    and 195 after the three races, the same in every bot's room state; grids Ana, Ben, Cy,
    then Cy, Ben, Ana twice (reversed standings); no snapshot or event from another race
    reached a bot.
  * In a browser at 100 ms and 200 ms simulated round trip with 7 bots: zero corrections, and
    the frame rate was the same as solo.
* **Dev latency injector.** `?lag=120&jitter=30` on a development page delays every message
  in both directions, in order.

## 12. Scaling notes

* **Server cost.** About 10 µs per car-tick. An 8-car room costs about 5 ms of CPU per second
  of simulation, so serialisation dominates.
* **Bandwidth.** About 20 KB/s down and 2 KB/s up per player with 8 cars (§4).
* **Limits.** One process holds up to `MAX_ROOMS` (500) rooms. Horizontal scaling would need
  sticky sessions and a room-code → process map. This is not needed for the competition.
