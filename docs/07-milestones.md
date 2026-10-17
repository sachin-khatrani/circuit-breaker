# 07 — Milestone Plan

Each milestone ends with typecheck, lint, tests and build green, then a short report and a
**stop** for review. Later milestones may be re-ordered after playtests.

## Step 1 / M0 — Foundation + single-player vertical slice  ✅ done (2026-10-09)

Scope:
* All seven design documents.
* npm-workspaces monorepo: `shared`, `client`, `server`. TypeScript, ESLint, Prettier, Vitest.
* Shared simulation:
  * spline track builder and the Grid Zero layout
  * projection, gates, grid
  * vehicle physics: throttle, brake, reverse, steering, drift, boost, walls, slope
  * race rules: countdown, launch boost, checkpoints, laps, finish, Energy cells, respawn
  * autopilot
* Client:
  * procedural track: road shader, rails, barriers, arches, gates, start gantry
  * city, reactor, sky, fog
  * procedural car with trails and particles
  * chase camera and intro, finish and attract cameras
  * post-processing
  * HUD: speed, Energy, laps, timers, minimap, countdown, banners
  * menu with attract mode, pause, results with local best times
  * keyboard and gamepad
* Server skeleton: `/health` and a headless autopilot smoke race on boot.

Acceptance:
* `npm run typecheck`, `npm run lint` and `npm run build` pass.
* `npm test` covers the track and race rules.
* In the browser: start a race, see the countdown, drive 3 laps with checkpoints and lap times,
  drift, boost, collect Energy, finish, see results, race again.

Out of scope: multiplayer, abilities, audio, mobile controls, ranking, accounts, database.

Verification record:
* Typecheck, ESLint and the production build all pass. Vitest: 22 tests pass. They cover:
  * track validity and projection
  * the vehicle model: acceleration, top speed, boost, braking, walls, drift
  * the countdown and launch rules
  * checkpoint skipping, reverse gates, respawn and cells
  * an autopilot 3-lap race
* The real client was driven in Chrome through the DevTools protocol:
  * a full race (1 lap via `?autopilot=1&laps=1`): countdown, perfect launch, all gates in
    order, finish 45.90 s, results with a new record
  * keyboard input: launch, throttle to 223 km/h, drift with sparks and Energy charge, boost,
    reset (1 s reboot), pause and resume
* Screenshots were reviewed at 1280×720 on Medium and 844×390 on Low.
* Not yet done: a human playtest of a full 3-lap race on a real display.

## Step 2 — Single-player 3D racing vertical slice  ✅ done (2026-10-09)

Scope (from the Step 2 brief, on top of Step 1):
* **Track.**
  * The Ion Tunnel on the Canyon straight.
  * Open-edged raised Skyway straights with hazard markings and a warning gantry.
  * Deck shoulders, so barriers and arches stand on the deck instead of floating.
  * Animated energy pulses on the rails.
  * Sky traffic.
* **Vehicle.**
  * Rebuilt on four wheels with neon rims: the front wheels steer and all four spin.
  * Headlights (spotlight + beams), brake and reverse lights.
  * Exhaust flames and trails, underglow, glowing drift marks.
  * A boost ignition burst.
* **Respawn when leaving the track.**
  * Airborne and ground physics, an OFF TRACK warning.
  * Automatic respawn at the last safe point.
* **Camera.**
  * Boost pull-back and a subtle FOV lift.
  * Look-ahead grows with speed.
  * Smaller, capped shake.
  * Corridor and roof clipping guards.
  * A stable camera while reversing.
  * `prefers-reduced-motion` support.
* **HUD.** Rebuilt to the requested layout: LAP / POSITION / TIME (`00:32.42`) / BOOST /
  control hint.
* **Boost.**
  * A kick on ignition, top speed 324 km/h.
  * Trail flash, particles and streaks.
* Pressing throttle on the title screen starts a race.

Verification record (real client, headless Chrome on the GPU, DevTools-protocol input):
* **Movement:**
  * 203 km/h after 2.5 s of throttle
  * braking to 58 km/h in 0.9 s
  * reverse to −14 m/s
* **Camera:** boost moves it back from 8.6 m to 10.4 m and widens the FOV from 71° to 79°.
* **Respawn.**
  * Steering off the open Skyway puts the car in the air at 11.8 m lateral and shows OFF
    TRACK.
  * It then respawns on the centre line (falls 1).
  * Manual reset works too.
* **Checkpoints, laps and finish** (3-lap race):
  * countdown 3-2-1-GO
  * checkpoints 1:1 … 3:3 in order
  * laps of 45.68 / 44.03 / 44.04 s
  * finish 2:13.75, with the results screen matching
* **Restart:** both Pause → Restart and Results → Race again reset to a fresh countdown.
* **Checks:** typecheck, lint and build are green; 27 Vitest tests pass.

### Step 2 validation pass (2026-10-09)

Decisions kept:
* the speed readout and the small track map
* 40 starting Energy, now configurable
* the wheeled car
* the W / ↑ quick start, plus a Start racing button

Changes:
* **Starting Energy.** It is a race option (`RaceOptions.startEnergy`, clamped to 0–100). The
  client sets it from `RACE_CONFIG`, and `?energy=N` overrides it in development.
* **Title screen.**
  * A **Start racing** button, with focus on arrival, showing the W and ↑ keys.
  * The quick start is ignored while another menu control has focus, inside the Controls
    overlay, and for 0.4 s after the menu appears or the overlay closes.
  * ↑/↓ move focus between menu controls.
* **Wheels.**
  * Three rim markers make the roll readable at low speed. From ~45 km/h they fade out and an
    additive blur disc takes over.
  * Tyre contact patches and a soft body shadow ground the car.
* **Adaptive resolution fix.** drei's `PerformanceMonitor` counts every "still fast" check
  toward its flip-flop limit. As a result, any machine holding its refresh rate dropped to
  DPR 1 after ~10 s; at DPR 1.5 the canvas fell from 2880×1620 to 1920×1080 on the menu.
  Now only real changes count. Under an 8× CPU throttle it still drops to DPR 1 within ~4 s.

Verification record. Real client in headless Chrome on an AMD Radeon 680M (integrated GPU),
with DevTools-protocol input:
* **Title screen.**
  * W does nothing while the Controls button has focus, while the overlay is open, and right
    after it closes.
  * ↑ on a quality chip moves focus.
  * W from the idle screen or from the Start racing button starts the countdown.
* **Race loop.**
  * Countdown 3-2-1-GO!
  * Throttle reaches 202 km/h, and the HUD speed matches.
  * D steers right and A steers left.
  * Braking takes the car from 213 to 82 km/h.
  * Boost drains Energy from 40 to 17.5, and the bar matches.
  * Off-track auto-respawn shows OFF TRACK, then REBOOTING. Manual reset works.
* **Full 3-lap race.**
  * LAP goes 1/3 → 3/3, and BEST updates.
  * TIME changes at every sample and freezes at 02:13.74.
  * Events: 9 checkpoints, 3 laps, 1 finish.
  * Results: 2:13.747 (45.680 / 44.028 / 44.038).
* **Track map.**
  * The marker stays within 0.07 m of the car for the whole race.
  * A straight-down render of the track matches the map's shape, orientation and colours.
* **HUD.** At 1920×1080 and 1366×768 no panels overlap, and the centre of the screen stays
  clear.
* **Wheels.** Each wheel turns by distance ÷ radius. Over 2.04 m the 0.36 m fronts turned 5.68
  rad (expected 5.67).
* **Production build** (`vite preview`):
  * There is no dev hook, and `?autopilot`, `?laps` and `?energy` are ignored.
  * The start guard and countdown work.
  * Throttle reaches 220 km/h. Boost reaches 305 km/h and takes Energy from 40 to 2 in 1.5 s.
  * Pause freezes TIME, and quit returns to the menu.
  * The only console message is three.js's `THREE.Clock` deprecation warning, raised inside
    React Three Fiber.
* **Checks:** typecheck, ESLint, 28 Vitest tests, build and Prettier are green.

Performance (fps; Chrome on Windows, AMD Radeon 680M integrated GPU):

| Canvas              | Low                          | Medium                    | High                      |
|---------------------|------------------------------|---------------------------|---------------------------|
| 1920×1080 (DPR 1)   | 120 capped, 145–203 uncapped | 120 capped, ~110 uncapped | 120 capped, ~110 uncapped |
| 2880×1620 (DPR 1.5) | DPR 1 (as above)             | 78–92                     | 80–83                     |

* Racing frame time at DPR 1: p99 8.5 ms, with no frame over 33 ms in 20 s.
* Racing frame time at DPR 1.5: p99 19.6 ms, with one 47 ms frame in 20 s.
* No growth after 5 restarts: 97 geometries, 39 shader programs, 62–64 MB heap.

## Step 3 — Racing physics, driving feel and gameplay polish  ✅ done (2026-10-09)

Scope (from the Step 3 brief): single-player feel only; no multiplayer, no accounts.

Changes:
* **Driving feel** (measured before and after with the shared sim):
  * a 0.11 s throttle ramp and a lighter lift-off (250 → 150 km/h off-throttle in 2.9 s, was
    1.3 s)
  * braking stops the car dead, holds it 0.2 s, then reverses
  * a drift now costs speed (engine ×0.85, more scrub: a held slide settles near 190 km/h) and
    blends back to grip over 0.35 s; the slide no longer snaps straight
  * speed bonuses (boost, pad, impulse, lane) no longer stack: the largest one counts
* **Boost bursts.** 20 Energy per press, 1 s, 0.5 s cooldown, a press buffer, a ramped kick.
  The BOOST meter has one segment per burst and four states: Ready ×N, Boosting, Cooling,
  Need 20 (it shakes on a refused press). 40 starting Energy, still configurable, buys two.
* **Track elements.** Three boost pads (per-car 3 s cooldown, forward crossings only) and three
  speed lanes on corner exits, rendered from the same shared zones the rules use.
* **Drift Energy** only for a sustained, controlled slide heading down the track: after 0.5 s,
  at most 8 per drift, then a 1.5 s cooldown.
* **Stuck cars** (pressing throttle or brake without moving for 3 s) respawn.
* **Feedback.**
  * Boosts: a magenta streak, swelling underglow, brighter flames, a screen-edge glow and
    speed lines.
  * Pads flash and throw a ring of light.
  * Pickups show "+12" or "+N drift" popups.
  * The final lap gets its own LAP panel colour, banner, glow and sound.
  * The finish holds a big FINISH with the time until the results.
  * The "Perfect launch" banner no longer sits on top of "GO!".
* **Audio.** A WebAudio synth: engine, wind, boost hiss, skid, and one-shots for every race
  event. All are placeholders to replace (list in `05-rendering.md` §10). It starts only
  after a key press or click; M mutes.
* **Settings.** Sound on/off and volume, and a Reduce motion option that defaults to the
  system setting. Both sit on the title screen and in the pause menu and are saved.
* **Input safety.** A tap shorter than a frame now always reaches the simulation (it was lost
  on frames without a tick); keys pressed while paused never leak into the race; the race
  pauses when the window loses focus.
* **Fixes found in testing.**
  * The brake never reversed on Grid Zero's grid: slopes leave a tiny forward speed every
    tick, which the brake kept stopping. "Stopped" is now < 0.05 m/s.
  * A Skyway pad sat where the autopilot runs wide at boost speed; it moved to the straight.
  * The HUD now fits 800×600: the top panels shrink, the hint wraps.

Verification record. 49 Vitest tests, plus the real client in headless Chrome on an AMD
Radeon 680M with DevTools-protocol keyboard input:
* **Full 3-lap race (autopilot).**
  * Countdown 3-2-1-GO, then LAP 1/3 → 3/3 with the final-lap panel.
  * 9 checkpoints, 9 pad crossings, 19 bursts, 34 cells, 3 laps, 1 finish.
  * Laps of 45.627 / 43.548 / 43.558 s, finishing in 2:12.733. The results match the events.
  * 0 wall hits, 0 respawns, and the HUD's Energy matches the sim.
* **Keyboard.**
  * Shift fires a burst (Energy 40 → 20); a second press during the burst changes nothing.
  * A third burst at 0 Energy is refused, and the meter shakes.
  * A drift through T1 earns 5.5 Energy, pays a tier-1 mini-turbo and shows "+5 drift".
  * Holding S reverses after the hold (−10.4 m/s after 1 s).
* **Audio.** There is no audio context before the first key press; after it, the context
  runs at volume². M mutes (master gain 0, "Sound off" in the hint) and unmutes.
* **Settings and focus.**
  * Reduce motion sets `data-motion`, removes the speed lines, and is saved.
  * A window blur pauses the race; Resume continues it.
* **Layout.** At 800×600, 1024×640, 1366×768 and 1920×1080 no HUD clusters overlap.
* **Production build (`vite preview`).**
  * The dev switches are ignored.
  * The bursts, the refused press, the mute key and the pause settings all work.
  * The only console message is three.js's `THREE.Clock` deprecation warning from inside R3F.
* **Performance (1920×1080, Medium).** 120 fps capped while racing, with a p99 frame time of
  8.6 ms and no frame over 33 ms in 20 s. After forced GC across 10 restarts, the heap stays
  at 62–63 MB, with 105 geometries, 41 programs and 9 event listeners throughout.
* **Performance (1.5× scaling, 2880×1620, uncapped).** Low 170, Medium about 72, High about 71
  fps (Step 2 measured 78–92 under different conditions). A/B tests show no measurable cost
  from the Step 3 additions; compositing the DOM HUD costs about 15 fps at that resolution.
* **Checks:** typecheck, ESLint, 49 tests, build and Prettier are green.

## Step 4 — Real-time multiplayer racing (2–8 players)  ✅ done (2026-10-09)

Scope (from the Step 4 brief): real multiplayer on the existing game, with an authoritative
server. No leaderboards, database, accounts, abilities, new tracks or customisation.

Delivered:
* **Rooms.**
  * Create a room (6-character code) or join by code or invite link, with a nickname and no
    account.
  * Lobby actions: ready, host start (needs 2 connected and ready; the host counts), laps 1–5
    (host), leave.
  * Rules: up to 8 seats, numbered duplicate names, a colour per seat, automatic host transfer.
* **Lifecycle.** WAITING → READY → COUNTDOWN → RACING → FINISHED → RESULTS on the server.
  * Every client gets the same start timestamp and GO tick.
  * Distinct grid slots.
  * After the race the host chooses Race again (same room) or Return to lobby.
* **Netcode** (`04-networking.md`).
  * 60 Hz server simulation, 20 Hz snapshots.
  * Tick-stamped inputs that run ahead of the server by an adaptive lead, predicted exactly as
    the server will apply them.
  * The local car is re-based on every snapshot, and corrections fade (snap above 6 m).
  * Remote cars are Hermite-interpolated about 110 ms in the past, with short extrapolation,
    and their events are timed to the moment they are drawn.
  * Clock sync from the best of ten pings.
* **Collisions.** Ghost cars: no car-to-car contact, track rules unchanged. A nearby remote car
  fades so the overlap reads as intended.
* **Visuals and HUD.**
  * Remote cars: each player's colour, with wheels, lights, flames, trails, underglow, drift
    sparks and a name tag.
  * The local car in its seat colour.
  * HUD: position as "2ND /6", live standings, coloured minimap dots, rival finish and
    departure banners.
  * A connection warning, and an Esc race menu (an online race cannot pause).
* **Lobby and results screens.**
  * Lobby: code, Copy invite link, players with colours, ready states, host badge, Start, Leave
    and waiting messages.
  * Results: position, driver, time, best lap, Finished or DNF, winner highlighted, and host
    controls.
* **Disconnects.**
  * A seat (and its car) survives 30 s.
  * The tab's token resumes it after a dropped connection or a page reload, keeping laps,
    Energy and position.
  * After the grace period, or on Leave, the car retires as DNF and the host role moves on.
  * A player who joins mid-race watches the standings from the lobby and races the next one.
* **Security.**
  * Every payload is validated, and the seat comes from the connection.
  * Rate limits for requests, inputs and room creation.
  * Secure codes, tokens and ids.
  * Host and phase checks.
  * The client sends nothing but inputs.
* **Testing tools.**
  * `npm run harness -w @circuit-breaker/server`: real-time bots over real sockets.
  * `-- --join CODE --bots N` fills a browser's room.
  * `?lag=&jitter=` latency injector in development.

Verification record:
* **Unit tests.** 94 Vitest tests pass:
  * 69 in shared, including 20 netcode tests: networked races identical at 0, 50, 100 and
    200 ms with jitter
  * 25 in the server: rooms, lobby, race rules, input validation, reconnects, real sockets
* **Harness.** All 7 scenarios pass in about 55 s:
  * **2p, 4p, 8p.** 20–200 ms round trip with ±20 ms jitter. Zero prediction corrections, no
    input tick ever guessed by the server, and every race bit-identical to an offline replay of
    the same inputs. The input lead settled at 6–7 ticks at 50 ms and about 11 at 200 ms.
  * **two-rooms.** No id, row or event crossed rooms.
  * **drop.** The host dropped mid-race. Others saw the drop at once. After the grace period
    the host role passed on, and the car was DNF and last. The new host restarted with the two
    remaining players.
  * **rejoin.** A player dropped for 1.5 s and resumed. Same seat and id, no duplicate, lap,
    gate and Energy unchanged by the resume, and the player finished.
  * **photo.** The finish was ranked by a 13.3 ms gap (0.8 of a tick).
* **Browsers.** Headless Chrome through the DevTools protocol, separate browser processes and
  profiles, AMD Radeon 680M.
  * **2 browsers, local link.** Create, then join through the invite link, ready, a 1-lap race,
    and identical server results (45.627 / 46.351 s). Zero corrections.
  * **1 browser at 100 ± 20 ms with 7 bots (8 cars).** 119 fps uncapped at 1280×720 Medium,
    the same as solo. Zero corrections at about 120 ms measured round trip.
  * **1 browser at 200 ± 30 ms with 7 bots, 2 laps.** The browser car worked from 8th to 3rd.
    Remote cars, tags, the ghost overlap and the standings were checked in screenshots. Zero
    corrections at about 224 ms.
  * **2 browsers at 50 and 150 ms.**
    * A typed lower-case code with spaces joined.
    * A duplicate nickname became "Ace 2".
    * A reload mid-race returned to the race in 1.2 s with the same player id.
    * The race menu opened over the running race.
    * Race again worked.
    * The host left mid-race: the host role passed, and the leaver was DNF.
    * Race again alone is disabled; Return to lobby worked.
  * **Production build** (`npm start`, one port). Two browsers raced with correct positions and
    standings. The debug handle is absent.
  * **Server outage.** The game server was killed mid-race.
    * The HUD showed "Connection lost · reconnecting".
    * A fresh server has no rooms, so both players were told the session had expired and
      returned to the multiplayer screen.
* **Fixed during verification.**
  * Game keys (W, A, S, D, Space, M, P) were swallowed by the game's key capture in the
    nickname field. They now type, with real key events verified.
  * The final standings missed the last snapshot once the results arrived.
  * The client assumed 20 Hz snapshots: the server now announces its rate.
  * A resume's first re-base was counted as a 490 m "correction" in the debug stats.
  * Lobby and results polish: the host row said "Host" twice, "1 laps", tag sizes, a compact
    8-player list.

Known limitations:
* Remote cars are drawn about 110 ms in the past, while the local car runs ahead of the
  server. A side-by-side moment can look a few metres different on two screens, so the
  standings shown are the server's.
* When the results arrive, the scene stops behind the results screen (no cool-down lap
  online).
* A player who joins mid-race sees standings, not the race itself.
* Seats are per browser tab (sessionStorage): a second tab is a second player.
* Rooms live in memory: a server restart ends them.
* Tested in Chrome only, on one machine. LAN play needs `HOST=0.0.0.0` (the production
  default) and was not tried on other devices.
* No touch controls yet (M6).
* While the link is down, the local car holds still but its engine note keeps playing.

## Step 5 — Dynamic track and strategic abilities  ✅ done (2026-10-12)

Scope (from the Step 5 brief): an Energy economy and three abilities on the existing game, with
the server authoritative for every activation, cost, cooldown and track change. No
leaderboards, accounts, new tracks, combat or weapons. The vehicle controller and the
networking were extended, not replaced.

Delivered:
* **Energy economy.**
  * Earned from cells (+12), speed lanes (+5 per lane per lap, new) and controlled drifts
    (+7/s, at most 8 a drift and, new, 30 a lap).
  * Range 0–100, 40 at the start. Boost (20) and the three abilities spend the same bar.
  * Every cost, cooldown and timing is in `RACE_RULES`.
* **Shortcut: the Needle.**
  * A real branch road (an open spline) across the inside of the Switchback, entered through a
    35 m portal in the left edge of the main road.
  * Opens 0.75 s after the press for 8 s, flashes its last 2 s, then locks for 2 s.
  * Closing shuts only the entrance, so nobody is trapped. No checkpoint is skipped.
  * About 1.3 s faster per lap.
* **Gate Shift: the Overload split.**
  * A divider down the banked hairpin, with a funnel. The inside lane (shorter, four cells) is
    open at the start; the outside lane has a speed lane.
  * The switch comes 2.5 s after the press; then the gate locks for 10 s.
  * A car keeps the lane it entered by, so no barrier ever closes on it.
* **Overdrive.** 3 s at 98 m/s for 40 Energy, 15 s cooldown. It cancels and blocks bursts, so
  it never stacks with them. A white-gold trail, a brighter underglow, stronger speed effects.
* **Sync.**
  * Abilities are buttons in the tick-stamped input. The server validates and pays in one
    step, in grid order.
  * The track state (seven server ticks) is in every snapshot, and the client's re-base
    restores it, so players who join late or reconnect have it at once.
  * `PROTOCOL_VERSION` 2.
* **Track visuals.**
  * The Needle: barrier curtains that rise and sink, a gantry sign, lead-in chevrons, and the
    whole branch tinted by its state (green open, amber changing, red shut).
  * The split: divider, funnel fences, lane chevrons, gate boards and a lit nose post.
  * Minimap routes coloured by state.
* **HUD.**
  * Three ability slots: icon, key, cost, name, state line and progress; click and touch.
  * A race feed under the clock, from server events only ("Ace opened the shortcut!").
  * An Overdrive state on the BOOST meter, and refusal feedback in the slot.
* **Results.** Online: ability counts per player and a timed log with each outcome or refusal
  reason. Solo: abilities used and shortcut runs.
* **Sound.** An ignition cue per ability, a refusal blip, gate warning pips, Needle closing
  pips, and a clunk when the gate switches or the Needle shuts.

Verification record:
* **Unit tests.** 125 pass.
  * 91 in shared: 21 new ability tests, and networked races with abilities that finish
    identically at 0, 100 and 200 ms with no visible corrections.
  * 34 in the server: 9 new ability tests through the real input path.
* **Harness.** All 8 scenarios pass in about 55 s. In the new `abilities` scenario each ability
  worked once, every bot was told about every ability at the same tick, the opener drove
  through the Needle, and 2,064 snapshot pairs had identical track state.
* **Browsers.** Headless Chrome through the DevTools protocol, separate processes and
  profiles, on one machine (AMD Radeon 680M).
  * **Solo.** Overdrive, Gate Shift and the Needle in one lap under the dev autopilot, with
    screenshots of every state. The results show 3 abilities and 1 shortcut run.
  * **Three browsers, two rooms.** Room 1: Ace and Bee, 2 laps, at 50 and 120 ms simulated
    round trip. Room 2: Cyd and a harness bot, 1 lap. 21 of 21 checks passed:
    * the same track; Bee's Overdrive seen by Ace, and its expiry; a repeat press refused for
      its cooldown
    * Ace's Gate Shift; Bee reloaded during the warning and was back 1.9 s later with the same
      track state as Ace, then saw the same switch
    * Ace opened the Needle on both laps; Bee's press while it was open was refused as busy;
      Ace drove the Needle on lap 1 and Bee on lap 2; both finished both laps
    * identical results and ability logs on both, each press logged exactly once
    * 1,647 snapshot pairs with identical rows (Energy included) and track state
    * room 2 untouched by room 1's changes; Cyd fired Overdrive with a touch tap
  * **Production build** (`npm start`). Two browsers: the feed, slot states, a refusal and
    the gate switch matched on both, with no console errors and no debug handle.
* **Fixed during verification.**
  * Online, an ability press could be lost when a long frame came right after it: a first-use
    shader compile, the audio start-up, a busy GPU. A press now stays down 6 ticks, its tick
    is sent at once, and after a stall it waits for the first tick the server has not played.
    A shader warm-up at race start removes the first-use compiles.
  * The Needle's gantry post stood on the main road. It is a cantilever now.
  * The Needle was amber, like the main road beside it. It now takes its route colour.
  * The autopilot could clip the wall just before the Needle's opening. It lines up along the
    edge and turns in only inside the opening, which grew from 19.5 to 35 m.
  * HUD: slot text wrapped or overflowed (the `.label` rule overrode the size utilities),
    Energy popups covered the slots, the online results panel could not scroll to its top, and
    the ability log's times ran into the names.
  * The dev autopilot dropped the player's ability keys.
  * The harness `photo` pair had drifted to 0.9 s apart after the track changes. It was found
    again (about 5 ms).

Known limitations:
* One feature of each kind, on one track: the Needle and the Overload split on Grid Zero.
* Balance uses first values, not tuned with human players: costs, cooldowns, durations, and
  the Needle's 1.3 s gain.
* Bots do not decide to use abilities on their own; the harness scripts them (M5).
* Touch works for the ability slots only. There are still no touch driving controls (M6).
* After a long client freeze, an ability fires when the client runs again, late by the length
  of the freeze, and the prediction corrects.
* Remote cars are drawn about 110 ms in the past. A rival who slipped into the Needle just
  before it shut can look, on another screen, as if it passed through the rising barrier. The
  server's version is the real one.
* Tested in headless Chrome on one machine, not on phones or separate devices.

## Step 6 — Visual polish and racing atmosphere  ✅ done (2026-10-12)

Scope (from the Step 6 brief): make the existing game look and feel like a finished arcade
racer, without changing gameplay, sync, track rules or the server. Everything below is
client-side presentation; no shared simulation, protocol or server file changed.

Delivered:
* **Readability first.** Before Step 6, the bloom washed the whole screen out for about 170 m
  on the run to the Switchback (frame brightness 171/255 against a lap mean of 62).
  * The cause was the reactor's 1.6 km sky beam, whose shader took its height from the
    vertex position instead of `uv`, so the beam glowed at full strength along its length.
  * Fixed, the reactor's core and rings also dim when the camera is near them.
  * The lap's brightest frame is now 84.
  * Checkpoint curtains fade out close to the camera; speed-lane and pad decals soften
    right under it.
* **Track.**
  * Chevron boards on the outside barrier of every tight corner (radius under 75 m), lit in
    the sector colour, with light chasing along them in the driving direction. They are
    one instanced draw call, placed only on walled edges (never on an opening, an open edge,
    in the tunnel or on the split), and sit behind the barrier.
  * Boost pads breathe while they wait.
* **Effects** (`scene/fx/RaceFx.tsx`, all from the existing particle pool).
  * A checkpoint throws a sheet of sparks in the sector colour, travelling with the car; a lap
    does the same, bigger.
  * The finish sets off fireworks where the finish camera looks.
  * Track changes spark where they happen, in the route colours: the Needle's opening (amber
    opening or closing, green open, red shut) and the split's lanes (amber warning, then
    green and red).
  * Overdrive ignites in white-gold sparks.
  * Neon dust in the air around the camera (Medium and High only), drifting and wrapped in
    the vertex shader: one draw call, no CPU work.
* **Cars.** A fresnel rim light in each car's own colour on the body. It keeps every car's
  silhouette readable against the dark city, and flares with a boost (more in Overdrive).
* **Camera.**
  * After a respawn, the chase camera settles in from further back over 0.7 s instead of
    cutting straight to it.
  * Overdrive adds a brief extra FOV punch.
  * The finish camera glides from the chase view into its orbit over 1.2 s.
  * Reduced motion still removes shake and roll and cuts FOV changes.
* **Landing page.**
  * The pitch, "Race the grid. Rewire the track."
  * Start racing, plus separate Create room and Join room actions (Join focuses the code
    field).
  * Three ability cards with key, cost and what each does.
  * Graphics, sound and motion settings, and the personal best.
  * It fits a 1280×720 screen without scrolling.
* **Lobby.**
  * Player cards with a car glyph in the player's neon colour, ready state (the card lights
    up), and the host badge.
  * Copy code and Copy invite link.
  * An empty slot explains that a race needs 2 drivers.
* **Results.** Online: a winner card in the winner's colour, with race time and best lap,
  and "You finished 2nd of 2 in 00:46.548" for everyone else. Every value comes from the
  server's results.
* **Layout.**
  * The HUD on a phone held upright: POSITION moves under LAP so it never covers TIME.
  * The controls overlay is two columns and scrolls from its top on short screens; so does
    the solo results panel.
* **Development stats.** The dev bridge's `renderer()` now counts a whole frame (scene plus
  post passes), so draw calls can be compared across presets.

Verification record:
* **Unit tests.** 125 pass (91 shared, 34 server); typecheck, lint, Prettier and the
  production build are green.
* **Harness.** All 8 scenarios pass (55 s).
* **Browsers** (headless Chrome, AMD Radeon 680M):
  * **Solo.** A full lap with screenshots at fixed moments, and a lap with Gate Shift and the
    Needle pressed in view, with shots of every checkpoint, track change and the finish.
  * **A full 3-lap solo race** at the default length: laps of 45.208, 43.701 and 43.699 s,
    no wall hits or respawns, exactly the Step 5 autopilot lap times (the driving is
    unchanged). The final-lap alert and lap effects fired, and a live window resize to
    844×390 and back kept the canvas and HUD in step.
  * **Three browsers, two rooms.** The Step 5 ability scenario passed 21/21 on the Step 6
    build: abilities, server cooldowns, the reload during a gate change, both routes, room
    isolation, a touch tap, and 1,641 snapshot pairs with identical rows and track state.
  * **Two browsers through the new lobby.** Create, Copy code, Join, Ready, a one-lap race,
    and the new results on both screens.
  * **Eight cars.** One browser and seven bots at about 130 ms round trip: 128–130 fps
    uncapped at 1280×720 Medium, against 145 solo. Corrections stayed under 1 m.
  * **Production build** (`npm start`). Two browsers: feed, slots and the gate switch matched,
    no console errors, no debug handle.
* **Performance** (uncapped, 1920×1080, DPR 1):

  | Preset | fps | p95 frame | Draw calls |
  |--------|-----|-----------|------------|
  | Low    | 129 | 14.7 ms   | 106        |
  | Medium | 101 | 23.9 ms   | 113        |
  | High   | 100 | 23.0 ms   | 115        |

  At DPR 2 (1440×900), Low, Medium and High measured 159, 83 and 60 fps, so the presets
  change the cost where it matters: on high-density screens.
* **Settings.** Reduced motion turns off speed lines, the corner chase lights, shake and roll,
  and halves the race-moment particles (checkpoints, finish, track changes). Mute sets the
  master gain to 0.
* **Leaks.** Ten race restarts: geometries 112 → 112, shader programs 48 → 48, heap +0.4 MB.
* **Small screens.** Title, race HUD and results at 390×844 and 844×390.

Known limitations:
* The car model is the Step 2 procedural car with a rim light added. There is no new body
  shape, and all players share one silhouette (colours tell them apart).
* No new architecture (bridges, elevated highways): the track geometry was kept as is.
* The fireworks and the gate sparks were checked in screenshots, not by people playing.
* No vehicle selection: the game has no customisation system to extend.
* Audio is unchanged from Step 5: engine pitch, boost, pickups, checkpoints, ability cues and
  countdown were already in place, and mute and volume were re-checked.
* High costs about 40 % of the frame rate at DPR 2 on the development machine's integrated
  GPU; Medium is the default on desktop, Low on touch devices.
* The JS bundle is 1.68 MB (508 KB gzipped).
* Tested in headless Chrome only, on one machine.

## Step 7 — Lobby, results and session points  ✅ done (2026-10-12)

Scope (from the Step 7 brief): a landing page and a lobby that show the server's room state,
car selection, a visible ready check, full results with the statistics the game tracks, points
over a session of races, and Race again, all decided by the server. No accounts, stored
rankings, database, new tracks or new abilities: a session lasts as long as its room
(persistent identity and ranking are Step 8). The race engine, netcode and track were
extended, not replaced.

Delivered:
* **Landing page** (`ui/screens/MainMenu.tsx`). The separate Multiplayer screen is gone, and
  the title screen is the way in.
  * The logo, the tagline "Race your friends. Rewire the track." and a short pitch.
  * Online: a nickname, checked the way the server checks it (a hint for a name it cannot use
    or would change), Create room, a room code with its own hint, Join room, and the server's
    answer as it comes.
  * An invite link (`/?room=CODE`) fills in the code and says which room it is.
  * The three abilities with key and cost, a small keys guide, All controls, Practice solo
    (W / ↑), the personal best, graphics and sound settings.
  * Nothing invented: no player counts, rankings or activity.
* **Lobby** (`ui/screens/Lobby.tsx`), all from the server's room state:
  * the room code, Copy code, Copy invite link and the link in full
  * player cards: the car in its colour and style, the host badge, and Ready, Getting
    ready…, Racing or Watching; a dropped player shows "Disconnected · seat held N s",
    counting down
  * the player count (2/8), the ready count and who is still getting ready
  * Start race (host) with the reason it cannot start yet ("Needs 2 connected, ready drivers
    (1 now).")
  * the car picker, laps (host), the session standings and the last race, New session (host,
    confirmed), Leave room
* **Room rules on the server** (`apps/server/src/rooms/Room.ts`).
  * Membership, host, readiness, capacity and the start are the server's. A start needs 2
    connected, ready players (the host's Start counts). Disconnected players are left off the
    grid; a dropped seat is released after 30 s, and the host role passes on.
  * Race ids. Input packets, snapshots, events and every lobby or results request name their
    race; anything for another race is dropped, or refused with "That was for an earlier race.
    Try again." `PROTOCOL_VERSION` 3.
  * A repeated ready request changes nothing. A second Start or Race again while a race runs
    is refused.
* **Cars.** Eight colours, unique in a room, and three body styles on the same car: Dart (the
  original wing and stripe), Apex (a tall wing with end plates, a dorsal fin, twin stripes) and
  Brute (a ducktail, armour pods, a roof bar, a wide stripe).
  * Picked in the lobby or on the results screen (`room:vehicle`). The server checks that the
    choice exists, that the colour is free and that no race is running, and tells everyone.
  * Carried into `race:start` and drawn on every screen, remote cars included; the browser
    remembers the last pick for the next room.
  * Preview: an outline of each style in the picker, and the 3D car behind the lobby wears
    the pick.
  * Cosmetic only: one physics model and one collision shape for all.
* **Race start.** While the camera sweeps to the grid, a card shows the race's number in the
  session, the laps, the grid slot and the session standing going in. The grid is the reverse
  of the session standings. The countdown is the server's.
* **Results** (`ui/screens/OnlineResults.tsx`, `ui/online/ResultsTable.tsx`,
  `ui/online/RaceStatsTable.tsx`).
  * The race and session number, a winner card, your own line, then every driver: position,
    car, name, total time, best lap, Finished or DNF (left, or still racing), race points,
    session total and rank.
  * Race stats per driver: boost bursts, Overdrives, drives through the shortcut, Energy
    collected, drift time and top speed, all counted by the server's simulation. The ability
    log keeps every press and its outcome.
  * The order is shared code (`classifyRacers`): finishers by sub-tick finish time, then cars
    still racing by distance, then cars that left; exact ties go to the lower grid slot.
* **Session points** (`packages/shared/src/session/scoring.ts`, configuration separate from
  the engine).
  * 100, 80, 65, 50, 40, 30, 20, 10; DNF 0. Only finishing places score.
  * Scored once per race, on the server. Standings: points, then wins, then join order, the
    same on every screen.
  * A dropped seat keeps its points for 30 s; leaving loses them; New session resets everyone.
* **Race again.** A ready check on the results screen, with every player's state. The host
  starts once 2 connected drivers are ready; players who are not ready follow the race in the
  lobby's live standings. A new simulation each race; names, cars and points carry over. A
  reload between races brings back the results and the session.
* **Small screens and touch.** No sideways scrolling on the landing page, lobby or results at
  390 px wide. Buttons, chips, swatches and the volume slider are at least 44 px tall on touch
  screens. The results table and the stats change layout on narrow screens.

Verification record:
* **Unit tests.** 151 pass: 98 in shared (7 new in `session.test.ts`) and 53 in the server
  (18 new in `session.test.ts`, 1 new real-socket test). Typecheck, lint, Prettier and the
  production build are green.
* **Harness.** All 9 scenarios pass in 161.4 s, and the new `session` scenario passed twice
  more on its own. In it:
  * three races in one room, every car finishing each one
  * car choices checked: a taken colour and an unknown style refused
  * a stale and a repeated Race again refused before races 2 and 3
  * points by the table, 300, 240 and 195 after three races, the same in every bot's room state
  * grids Ana, Ben, Cy, then Cy, Ben, Ana twice
  * no snapshot or event from another race reached a bot
  * a new session put everyone back to 0
* **Browsers.** Headless Chrome through the DevTools protocol, a separate process and profile
  per player (separate browsers as far as the game can tell), on one machine.
  * **Two browsers, the whole flow** (17/17 checks, 0 console errors):
    * landing: an unusable nickname explained and Create room blocked, the cleaned name
      shown, a malformed code explained
    * lobby: a colour another player has cannot be picked, both see both cars, the 3D preview
      wears the pick
    * three races: the same grid and cars and identical results on both, each race numbered
    * a reload between races brought back the results and the points
    * points added once: 280 and 260. After race 2 both had 180 and one win, and join order
      decided the rank, as documented
    * the lobby standings on both; New session put both back to 0
  * **Three browsers, drops.** One player dropped in the lobby: the host saw "Disconnected ·
    seat held 30 s" and a disabled Start with its reason, and the race started without them.
    Another dropped mid-race: the feed said so, and the results showed "DNF · left" with 0
    points.
  * **Three browsers, the Step 5 ability scenario** on this build: 21/21, with 1,646 snapshot
    pairs identical.
  * **A phone** (390×844, touch emulation) **and a desktop**: no sideways overflow and no
    control under 44 px on the landing page, lobby and results.
  * **Production build** (the built server, `NODE_ENV=production`), two browsers, 18/18: no
    debug handle, the landing page, the invite link, a car pick seen by the other player, the
    ready check, the race card on both, and `/health` at protocol 3.
* **Fixed during verification.**
  * In one harness run a bot did not finish race 2. A snapshot from race 1, still queued when
    race 2 started, moved the new prediction to race 1's last tick, and the bot stopped
    sending inputs. The bot now drops queued snapshots when a race starts, and the scenario
    checks that every car finishes. The browser client was not affected: it builds a new
    `OnlineRace` for each race and drops other races' messages.
  * A dropped player's status was cut off at 960 px, hiding the seconds; it wraps now.
  * Lobby cards said "Watching" on the results screen; colour swatches wrapped onto a second
    row; on phones, result names were cut and the stats headers ran together, and the volume
    slider was a 16 px touch target.

Known limitations:
* A car is a colour and one of three body kits on the same car: no separate models, liveries
  or stats (cosmetic by design).
* Sessions live in server memory: a restart or an empty room ends them. Leaving loses your
  points, and coming back by code is a new player. Stored identity and rankings are Step 8.
* A host who only disconnected keeps the role for the 30 s grace, so nobody can start a race
  until they come back or the seat is released.
* Equal points are separated by wins, then join order: fixed and documented, but join order
  favours whoever joined first.
* Players who are not ready for Race again watch the lobby's live standings, not the race.
* On phones the invite field shows the start of the link (Copy invite link copies all of it).
* Tested in headless Chrome on one machine, with separate browser processes; the phone layout
  with device emulation, not on real phones or separate networks.
* Still no touch driving controls (M6). The JS bundle is 1.69 MB (511 KB gzipped).

## Step 8 — Persistent profiles, global rating and leaderboard  ✅ done (2026-10-13)

Scope (from the Step 8 brief): anonymous identity that survives visits, lifetime statistics, a
server-calculated rating from completed races, a real global leaderboard, and race history,
all in a persistent database, with the race server still authoritative. No email or password
accounts, social login, payments, seasons, friends, chat or matchmaking. The design, schema,
rules and deployment are in `08-ranking.md`.

Delivered:
* **Persistence: PostgreSQL** through `pg`, chosen because the deploy target (one Render or
  Railway service) loses its disk on every deploy. Four tables (profiles, browser sessions,
  rated races, per-player race results) with constraints that check the counts and the rating
  arithmetic; indexes for the leaderboard order, prefix search, session lookup and history.
  Migrations run in one transaction under an advisory lock, with checksums, a down migration
  and a CLI (`dbcli.js migrate | status | rollback --confirm`). Without `DATABASE_URL` the
  game runs as in Step 7, unrated.
* **Anonymous identity.** A random public profile id (its first four characters are the tag
  beside every name), a 256-bit session token in an HTTP-only `SameSite=Lax` cookie (stored
  hashed), made on the first online race. Seats get their profile from a single-use, 60 s
  ticket, never from anything the client claims. A 100-bit recovery code, shown once and
  stored hashed, moves the profile to another browser; a new code locks out the old one and
  every other browser. Names follow the typed room name, 5 changes a day.
* **Profiles:** rating and peak, rank, rated races, finished, wins, podiums, best lap, member
  since, last active (owner only), and the 10 most recent rated races with each rating change.
* **Rating:** multiplayer Elo in `packages/shared/src/ranking/rating.ts`. Start 1000, floor
  100; a duel with every other rated player (finishing beats a DNF, a leaver loses to a car
  still racing, equal times draw); K 48 for the first 10 races, then 32; at most K a race;
  rematches with one opponent damped after 5 races in 24 hours and ignored after 20. A race is
  rated with 2 or more profiles (each in one car) and at least one of them finishing.
* **Once, completely, or not at all.** Each race has a UUID from its start; one transaction
  inserts it (a duplicate stops there), locks the players in id order, computes and writes the
  ratings, statistics and result rows. Writes run in finishing order through one queue,
  retried for 10 minutes while the database is away; the room hears `pending`, then `rated`
  (or `retrying`, then `rated` or `failed`), and nothing is shown as saved before the commit.
* **Leaderboard:** a panel over any screen: your standing (with Show me), search by name,
  pages of 25 from the server (the top 100 as page buttons, then one page at a time), loading,
  empty, error and ranking-off states, Refresh, and How rating works (with race points vs
  session points vs rating). Ties: rating, wins, the older profile, the id.
* **In the game:**
  * the landing page's profile line (name, tag, rating, rank) with Leaderboard and Profile
    (or Restore) buttons
  * lobby cards show each global rating ("unrated" without a profile), and a line says whether
    the next race is rated and why not
  * the results show the rating's status, your new rating and global rank, every car's change
    (narrow screens: under the name), a Leaderboard button, and a note on points vs rating
* **Abuse limits:** per-address token buckets on every endpoint (profiles 20 at once and 60 an
  hour; recovery 10 tries an hour), JSON-only writes with an Origin check, 2 KB bodies,
  credentialed CORS only for a configured origin, the client address read behind trusted
  proxies only (`TRUST_PROXY`), which also fixes room-creation limits behind a host's proxy.
* **Reliability:** pool limits and timeouts (5 s connect, 5 s statements), idle errors logged
  not thrown, background retries of the first connection, `/health` with the database state
  and the waiting races, and a shutdown that waits 5 s for a write in flight and names any race
  it could not save.

Verification record:
* **Unit and integration tests.** Shared: 108 pass (10 new rating tests). Server: 86 pass on
  PGlite, the default (33 new); 107 with `TEST_DATABASE_URL` set, which also runs the
  store, service and room tests on PostgreSQL 17.11 (in Docker). Typecheck, lint, Prettier and
  the production build are green. The tests cover identity creation, persistence across
  requests and a restarted service, forged cookies and tickets, names and their limit,
  recovery, the rating maths, wins and podiums, DNFs, two- and many-player races, draws, ties
  and the leaderboard order, duplicate and concurrent race writes (12 races over overlapping
  players, each sent twice at once), a rollback before COMMIT, pages and search, an outage
  (retrying, then saved; or given up with nothing applied), shutdown, cookies, CORS, rate
  limits and isolation between players.
* **Harness.** All 10 scenarios pass in 163.4 s with the ratings in PostgreSQL. The new
  `ranking` scenario: three profiles and one car without a profile race three times; every
  player hears `pending` then the same saved rating; the leaderboard lists three profiles with
  three races each; each profile's history chains and matches what the rooms were told.
* **Browsers** (headless Chrome, a separate process and profile per player, one machine; the
  dev build against PostgreSQL in Docker), 23/23 checks:
  * profiles made on the first online race; both seats rated in the lobby
  * two rated races, the same saved rating on both screens, race 2 starting from race 1's
  * the leaderboard (order, your standing, search) and the profile (stats, two races)
  * a recovery code made, then used in a third browser: the same profile and rating there
  * the server restarted (a new process): the profile, rating and leaderboard unchanged
  * the database stopped during a race: the race finished, the results said "Rating pending",
    `/health` showed it waiting; with the database back, the race was rated once, from the
    right ratings, and every profile had three races
* **A phone** (390×844, touch emulation): landing (with and without a profile), lobby,
  profile and leaderboard: no sideways overflow, no control under 44 px, no console errors.
* **Production build** (`NODE_ENV=production`, a fresh database): migrated at boot,
  `dbcli.js status` correct, the cookie `HttpOnly; SameSite=Lax` (no Secure over plain HTTP).
  A browser host and two harness bots with profiles (`--join --profiles`) raced: 10/10 checks,
  the race rated (the parked host a DNF, −24), the leaderboard right, no console errors.
* **Fixed during verification.**
  * The rating queue stopped for good after any idle start: the worker's promise was assigned
    after its own `finally` had already run. The reset is now chained after the assignment.
  * Closing the pool twice threw (shutdown racing clean-up); closing is idempotent now.
  * 3 profiles at once and 6 an hour per address would have blocked a LAN party behind one
    address: 20 and 60 now.
  * Rounding can make a change exactly K: the bound is "at most K" in tests and docs.
  * The leaderboard and profile panels were translucent over the results: solid now; plurals
    and line wrapping fixed.
  * The dev and preview servers did not proxy `/api`.
  * The test helper now drops its PostgreSQL schema even when closing the pool fails (an
    earlier failed run had left 9 behind; removed).
  * Outside the project: Docker Desktop's engine stopped mid-session (its WSL VM stopped) and
    was restarted; the database container came back with its data.

Known limitations:
* No production database exists yet: the code is verified against PostgreSQL 17.11 in local
  Docker (a real server, a persistent volume, restarts and outages), not against a managed
  provider. A database and `DATABASE_URL` must be set up (`08-ranking.md` §10) before the
  leaderboard is live.
* Anonymous identity: clearing site data, a private window or a new device starts a new
  profile unless the recovery code is used; a lost code is a lost profile; whoever holds the
  code can take the profile until a new one is made.
* Several profiles run by one person can still feed a main profile a little; only the rematch
  damping and Elo's expectation limit it. No collusion detection, reserved names or moderation.
* Ratings waiting for the database are lost if the server restarts during an outage (they were
  never shown as saved; the shutdown log names them).
* Rating constants (K, the floor, the damping steps) are first values, not tuned with players.
* Search matches the start of a name only.
* Protocol 4: a Step 7 client cannot join a Step 8 server, so the client and server deploy
  together (they are one build today).
* A client on another origin depends on third-party cookies, which some browsers block; one
  origin is the supported setup.
* The JS bundle is 1.72 MB (518 KB gzipped).

## Step 9 — Security audit, stress tests and performance  ✅ done (2026-10-15)

Scope (from the Step 9 brief): audit the whole application, find real weaknesses, fix them and
verify the fixes; stress the server with simulated players; test bad networks; profile before
optimising. No new gameplay, no new tracks, no new dependencies. The full record (baseline,
checklist, every finding with before and after figures, load, network, database and client
results, open risks) is `09-security-audit.md`.

Fixed (each reproduced on the unchanged code first, then measured again):
* **High:** one connection could flood messages of any event (a core at 100%, every race's
  ticks up to 115 ms late): per-connection message budget, 4 KB message cap, WebSocket only.
  Unlimited connections (500 from one address accepted): caps in total and per address, a
  connection rate per address, a 10 s handshake limit.
* **Medium:**
  * ability refusals bloated the results (645 KB from one player): 20 per car;
  * other sites could use visitors' browsers (no Origin check on WebSockets): own page only;
  * a throwing socket listener or room update would end the process: every handler guarded
    with error ids, a failing room closed alone, process-level handlers;
  * Socket.IO's volatile flag dropped 3% of snapshots on a fast link: skip only when a
    connection is really behind;
  * remote cars ignored the link's latency (93% of frames guessed ahead at 200 ms): the
    delay now counts from a snapshot's arrival, eased so it never jumps;
  * a tab drawing no frames queued snapshots without limit: newest 20;
  * one profile could race in several seats: one rated seat per profile;
  * name search walked the whole leaderboard (up to 174 ms at 100,000 profiles):
    migration 2 (`players_rank` index) and a name-index-first search;
  * 200–600 ms frames at every race start and first boost (three.js's first use of a shader
    waiting for the Windows driver): the warm-up now does that first use;
  * abuse limits counted over a connection's whole life, so long sessions could drop honest
    players: counted per 10 s window.
* **Low:** a race whose last players left after a finish was never rated; lobby input not
  limited; a bad URL answered 500; rate-limit maps cleared wholesale; tickets swept only when
  full; shutdown not one-time and silent; a rating callback failure mistaken for a database
  failure; no readiness, metrics, structured logs or error ids.
* **Added for operations:** `/ready`, `/metrics` (loopback or `METRICS_TOKEN`), JSON logs in
  production with error ids, `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`, a warning when
  `X-Forwarded-For` arrives without `TRUST_PROXY`, a one-time graceful shutdown.
* **Tooling:** `scripts/bot.ts` (the harness bot, shared), `load.ts` (load levels against the
  built server, reading `/metrics`), `netem.ts` (a TCP proxy that degrades a link),
  `dbbench.ts` (queries at 100,000 profiles); 8 network scenarios in the harness.

Verification record:
* **Baseline** (before any change): check green, 108 shared + 86 server tests (107 on
  PostgreSQL), harness 10/10 in 163.5 s.
* **After:** check green; 116 shared + 124 server tests (146 on PostgreSQL 17); Prettier clean;
  harness 18/18 in 163.4 s.
* **Load** (the built server, bots in four worker processes, every level 95 s measured):
  2, 8, 20, 40, 50 and 100 clients all stable; at 100 clients (13 rooms) 39% of one core,
  206 MB, tick lateness p99 20.5 ms (Windows timers: p50 ≈ 7.8 ms at every level), 1,948
  snapshots/s, none discarded, no disconnects or errors, 100 race results.
* **Networks:** harness at 50/100/200 ms, 3% loss stalls, a 3 s outage, a reset, a 20 s
  outage past the ping timeout, a reset during a gate shift, after finishing, and the host
  dropping in the lobby: all pass. Three real browsers at 50/100/200 ms with an outage, a reset
  and a minimized window: 14/14; a tab drawing no frames for 15 s: the queue held at 20.
* **Database** (100,000 profiles): every call 1–21 ms at p50 except a search with scattered
  matches (62 ms) and a deep rank count (14 ms); Step 8's search took up to 174 ms.
* **Client profile** (1080p, uncapped): menu 148 fps, solo race 130, online with 8 cars 94.5;
  React commits under 1 a second, garbage collection 0.1% of the main thread: no re-render or
  allocation work needed.
* **Production smoke:** the built server with a fresh schema (migrations 1 and 2 at boot, JSON
  logs), a real browser hosting a rated race with two bots: 12/12.

Known limitations:
* Load was measured on one Windows machine with everything on it; a cloud host will differ
  (capacity per process estimated at about 200 clients here, not tested above 100).
* Several profiles run by one person can still feed a main profile some rating (Step 8).
* A restart or deploy ends every live race; ratings waiting for the database during an outage
  are lost on restart (logged).
* `TRUST_PROXY` must be set behind a hosting proxy, or the per-address limits apply to all
  players at once.
* No production database exists yet (Step 8).

## Step 10 — Competition polish, demo and submission readiness  ✅ done (2026-10-16)

Scope (from the Step 10 brief): judge the game as a competition judge would, fix the issues
that matter most without rebuilding anything, verify the multiplayer demo, the leaderboard and
the deployment as far as they can be tested, write the demo script and the submission README.
No new gameplay.

The five biggest weaknesses found (fresh audit: tests and builds first, then a two-browser
tour of every screen, a full online race, a phone-size pass and a production container):
1. **No playable address.** No deployment configuration at all; a judge had to clone the
   repository, install, and run PostgreSQL to try it.
2. **The hook was not taught where it is played.** The title page explained the abilities, but
   the race never said where Energy comes from, the in-race key strip listed no ability keys,
   and a new player's first Q at the start was refused (40 Energy, the Shortcut costs 45).
3. **A dead end on phones.** A tap started a race whose car could not be driven (there are no
   touch driving controls) and nothing said so.
4. **First-impression copy.** The title page showed a grey `● OFFLINE` before any connection
   (it read as "the server is down"), and the hook sentence did not say "shortcuts" or
   "routes".
5. **Submission material.** The README opened with a step log and had no screenshots, and there
   was no demo script.

Fixed:
* **First-race hint** (`ui/hud/FirstRaceHint.tsx`): over the ability slots, from the countdown
  of a player's first races: "Charge Energy" (cells, drifts, speed lanes; Shift spends 20) and
  "Change the track" (Q, E, F). Each step ticks when the player does it (Energy rises; one of
  their abilities goes off, as the race confirms it); an ability used, or ×, ends it for good;
  otherwise it stops after 3 races. Gamepad wording follows the active device. Progress in
  local storage (`circuit-breaker.first-race-hint`), read once per visit so a dismissal sticks
  without storage. The × never takes keyboard focus. Hidden on touch screens.
* **Key strip:** `Q E F Abilities` added to the in-race keyboard hint.
* **Touch screens:** a note on the title page and one over the ability slots in a race ("No
  touch driving yet: connect a keyboard or a gamepad"); it goes when a gamepad is used.
* **Title page:** the hook now reads "Collect Energy as you drive, then choose: burn it on
  boosts, or open shortcuts and switch routes for everyone in the race"; the connection
  indicator shows nothing until a connection is tried (its live region stays mounted).
* **Results:** the race-stats column "Shortcut" counted runs through the Needle, not openings,
  so the player who opened it read 0: renamed "Needle runs". The leaderboard's "—" win rate
  explains itself (shown after 5 rated races).
* **Leaderboard without a database:** one message ("not set up on this server; races still
  run, unrated"), no search box and no request (it used to fail with a 503 in the console).
* **BOOST meter:** "Ready ×5 · Shift" beside a full 100 wrapped onto two lines; now one.
* **Deployment:** `Dockerfile` (two stages, production dependencies only, runs as `node`),
  `.dockerignore` (never `.env`), `render.yaml` (a Docker web service with `/ready` as its
  health check and `TRUST_PROXY=1`, and a PostgreSQL database whose URL Render fills in).
  `TRUST_PROXY` is a hop count here: the `'true'` used elsewhere would have been read as 0.
* **Tests:** five server tests (the first PGlite start in each file) timed out at Vitest's
  default 5 s when the files ran in parallel on a busy machine (4.5–5.7 s; they passed alone):
  `apps/server/vitest.config.mjs` sets 15 s. No assertion changed.
* **Documentation:** the README rewritten for a first-time reader (pitch, what is different,
  screenshots, the mechanic, deployment and its verification status, tests and results, known
  limitations); `DEMO.md` (the two-minute script and setup checklist); `docs/media/` (six
  screenshots from real online races).

Verification record:
* **Baseline** (before any change): check green (140 s), 116 shared + 124 server tests.
* **After:** check green (96 s); 116 shared + 124 server tests (146 on PostgreSQL 17); Prettier
  clean; harness 18/18 in 163 s; load test levels 2, 8 and 100 clients all stable (100: 20% of
  a core, 161 MB, nothing dropped, 100 rated results).
* **Two real browsers, one online race** (dev build, autopilot, a real Q press): 10/10: invite
  link join, one race id, the shortcut on the same tick on both screens (477), identical
  results, rated in PostgreSQL, the rematch resets lap, Energy, finish and the track.
* **First-race hint:** 20/20 browser checks (shown from the countdown, both ticks, saved, gone
  next race, × without focus loss, 3-race cap, malformed storage, reduced motion).
* **Production container** (Docker Desktop, a fresh database): migrations 1 and 2 at boot,
  `/ready` ok, deep links and invite links load on refresh, `/metrics` 404 from outside, no
  secret in the 29 served files, WebSocket only and foreign origins refused, two browsers and a
  bot race (ability sync, reload mid-race, rated results, rematch: 12/12), profiles kept across
  a restart, graceful SIGTERM.
* **Phone size** (390×844 and 844×390, touch emulation): no sideways scrolling, both touch notes
  shown, the hint hidden.
* **Client frames** (1080p, Radeon 680M): at the display's 120 Hz a solo race holds 118–119
  fps, frames p50 8.3 / p99 9–13 ms (Step 9: 8.3 / 8.9). Uncapped figures were lower than in
  Step 9 for every scene, the unchanged menu included (126 against 148 fps); an A/B with the
  hint shown and hidden, alternated, showed no difference, so the machine's state is the likely
  cause.

Known limitations:
* **Not deployed:** no public URL; `render.yaml` has not been through Render. The container is
  verified on this machine only.
* No touch driving controls (M6); only the ability slots take taps.
* One track; no AI opponents; tested in headless Chrome on one machine only.
* Starting Energy (40) is still below the Shortcut's cost (45); the hint and the slot explain
  it, and balance was left alone.

## M1 — Feel & juice (single-player polish)

Step 3 already delivered the first tuning pass, placeholder audio (engine synth, boost,
drift, pickups, walls, countdown), volume and mute, and reduced motion. Still open:
* A tuning pass with human playtests: steering curve, drift window, wall response, boost and
  Energy balance.
* Produced sounds replacing the synthesised placeholders, and a synthwave loop.
* Ghost of your best lap: deterministic replay of recorded inputs, shown as a translucent
  car.
* Settings: camera distance and FOV, invert or remap keys.
* Accept when: blind playtesters can finish 3 laps without reading instructions, and the
  median lap is within 10 % of the autopilot's.

## M2 — Multiplayer foundation (2–8 players)  ✅ delivered by Step 4

Step 4 built this milestone, with these changes from the plan:
* Room codes have 6 characters.
* Snapshots run at 20 Hz.
* Inputs are stamped with their tick, instead of queued.
* Cars are ghosts instead of having soft contacts.

The acceptance run had 1 browser and 7 bots at about 120 ms. It showed no corrections at all,
and the finish order came from the server's gate crossings. The checks of the remaining
browsers ran with 2 browsers.

## M3 — Track manipulation systems

Step 5 delivered a first version: the Needle (a branch road with portals) and the Overload split
(a lane gate), with a server-scheduled track state, warnings 0.75–2.5 s ahead and route
visuals. Junctions, hazard nodes, a second layout and a test over every combination of states
are still open.

* A track graph: main loop, bypass segments, junction routes, lane gates and hazard nodes.
  Checkpoint groups with a gate per route.
* A second layout (or a Grid Zero revision) with one bypass, one junction, one lane gate and
  two hazard nodes.
* Server-scheduled `trackEvent`s with telegraphs: the gate wipe animation, the bypass bridge
  rising, junction arrows and EMP domes.
* A track-state uniform texture drives the visuals with no extra draw calls per node.
* Accept when: every track change is visible at least 0.75 s before it acts, and no state of
  the track graph leaves zero valid routes. A test enumerates all node states.

## M4 — Abilities & Energy economy

Step 5 delivered Shortcut, Gate Shift and Overdrive (in place of Breach, Reroute, Seal, Surge
and Insulate: no attacks), the race feed, per-lap Energy limits and the ability log.
Slipstream Energy, ability use by bots and the balance pass are still open.

* Breach, Reroute, Seal, Surge and Insulate, with costs and cooldowns. The ability bar shows
  target-in-range indicators.
* Slipstream Energy. Ability events in the race feed ("NOVA breached the bypass").
* Balance pass from simulated races (bots using simple ability heuristics). Target: Energy is
  spent about evenly between boost and abilities.
* Accept when: in 20 simulated races, no single ability or pure-boost strategy wins over 40 % of
  the time.

## M5 — Bots & robustness

* Bots fill empty seats. They use the autopilot with lane offsets, mistakes and simple ability
  use.
* Reconnect with the seat token, AFK handling, host migration.
* Load test: N rooms × 8 bot clients; measure CPU, bandwidth and event-loop utilisation.
* Accept when: a 30-minute soak with 20 rooms runs without errors, memory growth or tick
  overruns.

## M6 — Presentation & competition polish

* Car selection: Step 7 delivered 8 colours and 3 body styles; liveries are still open.
  Results podium scene. Spectator camera for finished players and for players sitting out a
  race.
* Mobile: touch controls (steer pad, brake, drift and boost buttons), auto-accelerate option,
  landscape prompt.
* Performance pass on integrated GPUs and phones. A loading screen (a shader warm-up at race
  start exists since Step 5).
* Deployment: a single Render/Railway service. README demo script and submission notes.
  Step 10 delivered the Dockerfile, `render.yaml`, `DEMO.md` and the README; not deployed yet.
* Accept when: the live URL works on desktop Chrome, Firefox and Safari plus a mid-range phone,
  and a 4-player room can be joined from a shared link in under 20 s.
