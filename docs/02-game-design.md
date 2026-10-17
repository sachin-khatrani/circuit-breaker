# 02 — Game Design

## 1. Pitch

**CIRCUIT BREAKER** is a futuristic neon racer for 2–8 players. The circuit runs on
power from a central reactor, and every racer can tap into it. Collect **Energy** on the
track, then spend it: boost, or flip one of the circuit's **breakers** to open a shortcut,
reroute a junction, seal a gate or spark a hazard. The racing line changes while you drive
it.

> Racing skill + risk/reward decisions + player-controlled track changes.

This is not a combat game. Nothing destroys a car and nobody is eliminated. Abilities
change the *track*, and the track changes the race.

## 2. Player experience loop

```
Join room → pick a car, get ready → countdown (3·2·1, launch-boost window) → race
   ↑                                                                          ↓
Race again ← points and standings ← results ← finish ← laps ← spend Energy ← collect Energy
```

A race lasts about 2.5 minutes (3 laps of about 45 s). It is short enough for "one more race",
and a room plays a session of races scored on points (§5c).

## 3. Core design decisions (the 18 questions)

### 3.1 Camera model
A third-person chase camera, rigid in translation and smoothed in rotation, so it never
falls behind at 300+ km/h.
* The offset is about 8 m behind and 2.8 m above the car, aimed 5 m ahead of it.
* Yaw follows a blend of the car's heading and its velocity direction. Drifts read as a
  sideways slide instead of the camera swinging.
* The look target sits 5–9 m ahead of the car, further at speed.
* FOV runs from 64° to about 75° with speed, plus up to 5° on boost. Boost also pulls the
  camera back about 1.4 m. Distance stretches a little under acceleration and compresses under
  braking.
* While reversing, the camera stays behind the nose instead of following the velocity.
* **No clipping.** The camera never leaves a walled road corridor, so it never looks
  through a barrier or tunnel wall. It stays 1.1 m under tunnel roofs and above the road
  surface.
* Shake is small and capped (trauma model): wall hits, launch and mini-turbos only. A slight
  roll leans into turns.
* **Reduced motion.** With the OS "reduce motion" setting, shake, roll and speed streaks
  are off, chromatic aberration is off, and FOV changes shrink to about a third.
* Set pieces: a pre-race intro sweep from the front of the car to the chase position, a
  finish orbit, and attract-mode cinematic shots (trackside, orbit, low chase, helicopter)
  behind the main menu.

### 3.2 Vehicle movement model
An arcade car model in the 2D track plane. Height and tilt come from the road surface. The
model has:
* a speed-dependent engine curve with a short throttle ramp, a gentle lift-off, strong brakes
  that hold the car at a stop for a moment, then reverse
* yaw-rate steering whose authority peaks at mid speed and tapers at top speed
* exponential lateral grip, which is what makes a car carve or slide
* a button **drift** that lowers grip and turns the car tighter, blends smoothly back to grip
  when released, and rewards a sustained, controlled slide with a little Energy
* no rigid body: the car follows the road surface, so it cannot flip

Full equations are in `06-physics.md`.

### 3.3 Track representation
* **Authoring.** Each track is a closed loop of control points: position (x, y, z), width and
  bank. Checkpoints are listed by control-point index. Energy cells, boost pads and speed
  lanes are placed by control-point parameter and lateral offset.
* **Runtime.** A centripetal Catmull-Rom spline is resampled every ~2 m into typed arrays:
  position, tangent, right vector, half-width, bank and curvature. From those come:
  * physics projection (s, lateral offset)
  * checkpoint gate planes
  * grid slots
  * all render geometry (road, rails, barriers, arches)
* **Graph-ready.** Later tracks hold several route segments: a main loop, bypass shortcuts and
  alternate routes joined at junctions. Checkpoints become *groups*, one gate per route (see
  §3.8).

### 3.4 Checkpoint system
* Checkpoint 0 is the start/finish line. A lap has *K* ordered checkpoints (4 on Grid Zero).
* Each gate is a vertical plane across the road. The sim tests the segment from the previous
  tick's position to the current one against the plane. A crossing counts only if:
  * it is in the forward direction,
  * the crossing point lies within the road width plus 2 m, and
  * it is the racer's **next** checkpoint.

  Testing the segment, not the point, means no tunnelling at any speed. Missed or reversed
  crossings do nothing.
* Split time per checkpoint is stored. The HUD shows the delta to your best lap at the same
  checkpoint.

### 3.5 Lap system
* Cars start on the grid behind the line. The first crossing of the line starts lap 1 and
  does not complete a lap. The race clock starts at GO for everyone.
* Crossing the line after checkpoints 1…K−1 completes a lap. Lap and finish times are
  interpolated to the sub-tick crossing moment, so equal ticks still order fairly.
* Race progress for standings is (lap, next checkpoint, distance to it along the track).
  Projection is capped at the next unpassed checkpoint, so cutting can never rank you ahead.

### 3.6 Boost system
* **Energy boost (burst).** Each press of Boost fires one **burst**: it costs **20 Energy**,
  paid up front, lasts **1 s**, and is followed by a **0.5 s cooldown**. Top speed rises from
  72 to 90 m/s (259 → 324 km/h) and acceleration by 26 m/s². The thrust ramps in, then the first
  quarter-second pushes 1.6× harder (the "kick"), so a burst feels like a shove, never a jump.
  Overspeed bleeds off smoothly afterwards.
  * Holding the button or pressing again during a burst adds nothing; a press just before the
    cooldown ends is remembered. Mashing can never chain bursts faster than one per 1.5 s.
  * Without 20 Energy a press is refused: the BOOST meter shakes and the exhausts sputter.
  * The BOOST meter is split into one segment per burst and says **Ready ×N**, **Boosting**,
    **Cooling** or **Need 20**.
* **Drift boost (mini-turbo).** Release a drift held for ≥ 0.9 s to get a free 0.5 s
  impulse, or ≥ 2.0 s to get 0.9 s.
* **Launch boost.** Press throttle within the last 0.4 s before GO for a free 1.2 s impulse.
  Pressing earlier earns nothing.
* **Boost pads.** Glowing magenta plates on the road (with a post at each front corner). Driving
  over one forward gives a free 0.8 s impulse (top speed +14 m/s). A pad then stays inert for
  that car for 3 s, so sitting on it or crossing it again gives nothing. Grid Zero has three,
  each a line choice on a straight: the outside entry to T1, the right half of the
  barrier-free Skyway (beside the cells down the middle, nearer the open edge), and a push into
  the Ion Tunnel.
* **Speed lanes.** Cyan lanes painted along the exit line of the slowest corners (the Esses
  onto the Skyway climb, the Overload hairpin and the outside lane of its split, the
  Switchback). Inside one, the car pulls harder (+8 m/s²) and tops out 5 m/s higher: the
  reward for tracking out to the edge. Driving through most of a lane also pays Energy (§3.7).
* **Overdrive** (an ability, §3.8) is a bigger boost: 40 Energy for 3 s at a 98 m/s top speed
  (+30 m/s²), against a burst's 20 Energy, 1 s and 90 m/s. Starting it cancels a running
  burst, and no burst starts while it runs, so the two never stack. A 15 s cooldown stops
  chaining it.

Bonuses never stack: only the largest top-speed bonus counts. Boost competes with abilities
for the same Energy. That trade is the main decision in the game.

### 3.7 Energy collection
| Source         | Amount             | Notes                                                                 |
|----------------|--------------------|-----------------------------------------------------------------------|
| Energy cells   | +12 per cell       | Glowing crystals in clusters; some on the racing line, the richest on risky lines (hairpin apex, wall edges). Respawn 5 s after pickup |
| Drift          | +7 per second, max 8 per drift and 30 per lap | Only a sustained, controlled slide: after 0.5 s of drifting, with a real (not spinning) slip angle, still heading down the track. A rewarded drift is followed by a 1.5 s cooldown, so tapping or circling earns little |
| Speed lanes    | +5 per lane per lap | For driving 75 % of a lane's length inside it, moving forward      |
| Slipstream     | +5 per second      | Later (M4): inside a 30 m cone behind a rival; not built yet          |

Every car starts with 40 Energy, a testing value: two boost bursts. It is
`RACE_RULES.startEnergy`, and each race can override it with `RaceOptions.startEnergy`
(clamped to the bar). The client sets it in `RACE_CONFIG`, and `?energy=N` overrides it in
development, so balancing it changes one number. Energy is capped at 100, and the server is
the sole owner of the number. Cells are shared world objects in multiplayer: first to touch
one takes it.

Nothing can be farmed: a cell pays once and then respawns on its timer, a lane pays once per
lap and only for driving forward through it, and drifting stops paying after 30 Energy in a
lap.

### 3.8 Abilities and the changeable track
Energy buys three abilities as well as boost. Two of them change the track for **everyone**,
which is where the risk and the reward come from: a shortcut you open is open for the cars
behind you too. Every number below is in `RACE_RULES` (`packages/shared/src/sim/config.ts`).

| Ability        | Key / pad   | Cost | Cooldown | Effect                                                              |
|----------------|-------------|------|----------|---------------------------------------------------------------------|
| **Boost**      | Shift / X   | 20   | 0.5 s    | One 1 s burst (§3.6)                                                 |
| **Shortcut**   | Q / D-pad ← | 45   | 25 s     | Opens the Needle for everyone: it opens 0.75 s after the press and stays open 8 s (flashing for the last 2 s); once shut, nobody can reopen it for 2 s |
| **Gate Shift** | E / D-pad ↑ | 30   | 20 s     | Swaps the open lane of the Overload split 2.5 s after the press; the gate then stays put for 10 s |
| **Overdrive**  | F / D-pad → | 40   | 15 s     | A 3 s super-boost for your own car (98 m/s top speed, +30 m/s²)      |

Cooldowns belong to each player and start on use. The locks after a track change belong to the
track: they apply to everyone.

* **The Needle** (Shortcut). A narrow branch across the inside of the Switchback. It leaves
  the entry straight through a 35 m opening in the left edge, turns a tight hairpin of its own
  (about 17.5 m radius, against the Switchback's 29 m) and merges back on the left of the exit
  straight. It saves about 1.3 s on an autopilot lap, but its hairpin has to be taken slowly.
  Shut, a red energy barrier fills the opening and the branch glows a dim red. Opening or
  closing, it is amber and flashing. Open, it is green, with chevrons leading in. A gantry
  sign over the entrance counts it down.
* **The Overload split** (Gate Shift). A divider runs down the banked hairpin. The inside lane
  is shorter and holds four Energy cells; the outside lane carries a speed lane. One lane is
  open at a time, the inside one at the start. A fence across the 36 m funnel before the
  divider closes off the shut lane. Gantry boards over each lane show an arrow or a cross and
  count a change down.
* **Overdrive** changes nothing but your own car: a white-gold trail, a brighter underglow and
  stronger speed lines, then a falling tone when it ends.

Rules that keep it fair and readable:
* **The server decides.** A press is only a button in the input frame. The server checks it
  (race running, own cooldown, track not busy, enough Energy), takes the Energy and applies
  the ability in the same tick, so Energy can never be spent twice. Presses in the same tick
  resolve in grid order, the same way on every machine. A refusal is told to that player
  only.
* **Telegraph everything.** The Needle opens 0.75 s after the press, and the gate switches
  2.5 s after it. Each change is scheduled on a server tick, so every player sees it coming
  and it happens at the same tick for everyone. The race feed announces it ("Ace opened the
  shortcut!"), and the signs, arrows, barrier colours, minimap and sounds show it.
* **Never trap, never block.** Shutting the Needle closes only its entrance: a car already
  on the branch drives on and merges, and the merge is always open. A gate change never moves
  a barrier onto a car: a car that has entered the funnel keeps the lane it entered by. One
  lane of the split is always open.
* **No skipping.** No checkpoint lies on the stretch the Needle bypasses, and laps count the
  same way on either route.
* **No attacks.** Nothing stuns, damages or slows another car: abilities change routes or your
  own speed. The first design ("Breakers": Breach, Reroute, Seal, Surge, Insulate) was cut
  down to these three for Step 5. Seal and Surge were attacks, and Insulate only answered
  them. Breach became Shortcut and Reroute became Gate Shift.
* **No flicker.** The locks after each change stop players from toggling the track back and
  forth.

The HUD shows three ability slots above the BOOST meter: icon, key, cost, name and a state line
(Ready, Need +N, Cool Ns, Opening, Open Ns, Shift Ns, Lock Ns, or the reason a press was
refused). A slot is also a button for the mouse and for touch.

### 3.9 Race length
3 laps by default. A Grid Zero lap is 3.01 km. The autopilot laps it in about 46 s, or 43.5 s
with boost bursts and pads, and a good human line with drifts should beat that, so a race is
about 2.5 minutes. Room settings in multiplayer allow 1–5 laps. After the first finisher, the
others get 25 s to finish. Anyone still racing after that is ranked by progress (DNF time).

### 3.10 Player count
* 2–8 per room, on a 4 × 2 staggered grid.
* The solo vertical slice has 1 car.
* Bots that use the shared autopilot fill empty seats (M5).

### 3.11 Collision philosophy
Contact is **physical but non-destructive**:
* **Walls** are energy barriers. They remove the inward velocity, scrape speed in proportion
  to the impact, and rotate the car toward the track direction, so a hit costs time but never
  traps the car.
* **Car-to-car: ghost cars** (decided in Step 4). Cars pass through each other. There is no
  bumping, blocking or ramming, and no damage.
  * Every player's prediction stays exact, because no contact depends on another player's
    latency.
  * Lag never turns into an invisible wall.
  * A remote car fades as it nears your car, so the overlap reads as intended. See
    `04-networking.md` §8.

### 3.12 Respawn / off-track behaviour
Most of Grid Zero is walled by energy barriers. The two raised Skyway straights have **open
edges**: no barrier, amber hazard chevrons on the road edge and a 10–18 m drop.
* **Leaving the track.** A car that runs more than 0.6 m past an open edge leaves the road.
  * Over a drop it flies off ballistically, keeping its speed and the road's climb or fall
    rate.
  * Beside a ground-level road it ends up on the ground, off-road (weak engine, low grip,
    heavy drag).
  * The HUD shows **OFF TRACK**.
  * After 0.75 s in the air, or 0.5 s on the ground, the car is respawned automatically.
* **Respawn point.** The car goes back on the centre line at the last point where it was
  safely inside the road (1.5 m from the edge), facing the race direction, at 0 speed. It is
  frozen for 1.0 s ("REBOOTING"). The penalty makes falls cost time without ruining the race,
  and a respawn never counts as a checkpoint crossing.
* **Manual reset (R / Y)** works the same way, any time.
* **Stuck.** A car pressing throttle or brake without moving (under 1.5 m/s) for 3 s is
  respawned the same way. A car simply waiting is left alone.
* **WRONG WAY** appears after 1 s of driving against the track direction.

### 3.13 Network synchronization model
* The server runs an authoritative fixed-tick simulation. Clients send inputs only, each
  stamped with the tick it applies to, a few ticks ahead of the server.
* The local car uses client-side prediction. Every snapshot re-bases it on the server's state
  and replays the inputs since.
* Remote cars use snapshot interpolation.
* Track events (M3) will be scheduled for a future tick.

Details are in `04-networking.md`.

### 3.14 Server tick rate
The simulation runs at **60 Hz**. That is 1.6 m per tick at boost speed, which keeps wall and
gate tests precise. Snapshots go out at **20 Hz**, every 3rd tick (configurable with
`SNAPSHOT_RATE`). They are sent volatile, so a congested client drops stale ones instead of
queueing them.

### 3.15 Client interpolation
* Remote cars render about **110 ms** in the past (2.2 snapshot intervals plus measured
  jitter). Position uses cubic Hermite interpolation from the positions and velocities in the
  snapshots. Yaw uses shortest-arc interpolation.
* If snapshots stop, the client extrapolates for up to 150 ms, then holds the car.
* Locally, rendering interpolates between the previous and current sim tick
  (`alpha = accumulator / dt`).

### 3.16 Latency handling
* Prediction makes the local car respond instantly.
* Reconciliation errors are blended out (time constant 0.12 s). Errors larger than 6 m snap.
* RTT and clock offset come from pings, so countdown and GO line up on every screen.
* Abilities animate the button at once, but the effect waits for the server's scheduled
  event. The telegraph delay covers latency up to ~250 ms.
* The race view warns when the connection is lost or stalls (no snapshot for 0.7 s). A
  per-player ping display is not built yet.

### 3.17 Anti-cheat validation
* The server accepts inputs only: throttle, brake, steer, buttons, and ability requests.
  * Values are clamped and NaN is rejected.
  * Messages are rate-limited (token bucket) and size-capped.
  * Sequence numbers must increase.
* The server consumes **at most one input per tick** per player. A sped-up client cannot
  move faster than real time.
* Ability requests are re-checked on the server against phase, Energy, cooldown and a valid
  target in range.
* The server alone computes position, laps, finish order, Energy and results. Clients never
  submit any of them.

### 3.18 Mobile support strategy
Desktop first. Mobile is supported but not tuned in the first versions.
* On touch devices the game starts on the Low quality tier (DPR 1, no SMAA, half-res bloom,
  smaller city).
* Touch controls (M6):
  * left thumb: drag steering pad
  * right thumb: brake, drift and boost buttons
  * optional auto-accelerate and tilt steering
* The HUD layout is responsive. A landscape prompt appears in portrait.
* The Gamepad API works on mobile browsers that support it.
* Until the touch controls exist (Step 10): on a touch screen the title page says racing needs a
  keyboard or a gamepad, and in a race a note over the ability slots says the same (it goes
  when a gamepad is used). The ability slots already take taps.

## 4. Controls

The title screen has a **Practice solo** button, and W or ↑ is a quick start for it. To
prevent accidental starts, the quick start only fires when nothing else on the menu has focus,
and never while a nickname or room code is being typed. It never fires inside the Controls
overlay, or in the first 0.4 s after the menu appears or the overlay closes. While a menu
control has focus, ↑/↓ move between controls instead.

| Action          | Keyboard                | Gamepad (standard mapping) |
|-----------------|-------------------------|----------------------------|
| Accelerate      | W / ↑                   | RT                         |
| Brake / reverse | S / ↓                   | LT                         |
| Steer           | A D / ← →               | Left stick                 |
| Drift           | Space                   | A or RB                    |
| Boost burst     | Shift (one per press)   | X or LB                    |
| Reset car       | R                       | Y                          |
| Shortcut        | Q                       | D-pad ←                    |
| Gate Shift      | E                       | D-pad ↑                    |
| Overdrive       | F                       | D-pad →                    |
| Mute / unmute   | M                       | —                          |
| Pause           | Esc / P                 | Start                      |

Holding the brake at a standstill holds the car for 0.2 s, then reverses. The HUD's control
hint shows these keys (or the gamepad ones, whichever was used last).

In a player's first races (up to 3), a small hint over the ability slots explains the two
halves of the hook: charge Energy (cells, drifts, speed lanes; Shift spends 20 on a boost) and
change the track (Q, E, F). Each step ticks when the player does it; using an ability, or
closing the hint, ends it for good (Step 10, `ui/hud/FirstRaceHint.tsx`).

The ability keys were planned as Q, E and R. R is Reset, so Overdrive sits on F, beside it.
The ability slots on the HUD also take clicks and touch taps.

Keyboard safety:
* game keys never scroll the page or activate a focused button
* a key typed into a form control (the volume slider) belongs to that control
* the race pauses when the tab is hidden or the window loses focus (held keys are lost then),
  and keys pressed while paused never leak into the race
* a key tap shorter than a frame still reaches the simulation exactly once
* an ability press stays down for 6 ticks (100 ms), so online it still lands when one input
  frame arrives late; it fires once all the same

## 5. Visual identity

* **World.** A night megacity in purple fog. A reactor tower in the infield powers the
  circuit. Skyscrapers have procedural lit windows and neon crowns. Holographic billboards and
  searchlights fill the skyline.
* **Track.**
  * dark road with glowing edge lines and animated energy chevrons
  * sector-coloured neon rails with energy pulses racing along them
  * translucent hex-pattern barriers
  * hexagonal arches every ~70 m for speed sense, and big gates at checkpoints
  * the start gantry carries the countdown lights
  * Set pieces:
    * the raised **Skyway**: open edges, hazard chevrons, a SKYWAY warning gantry
    * the banked Overload hairpin
    * the **Ion Tunnel** on the Canyon straight: a hexagonal tube with glowing ribs every
      8 m and pulsing roof strips
    * the tight Switchback
* **Car.** A low dart-shaped electric racer on four open wheels:
  * neon rim rings; the front wheels steer and all four roll with ground speed (angle =
    distance ÷ radius)
  * three bright rim markers show the roll at low speed. From ~45 km/h they fade out (gone by
    ~85 km/h) while an additive blur disc fades in, so the wheels never strobe or seem to spin
    backwards
  * dark contact patches under each tyre and a soft shadow under the body ground the car;
    the body squats, dives and rolls on its suspension
  * fender pods, a glass canopy and a rear wing; three body kits change the wing, fin and
    roof (Dart, Apex, Brute, §5c)
  * LED headlights with soft beams and a real spotlight on the road
  * a brake light bar that flares on braking, and white reverse lamps
  * twin exhausts with flames and energy trails, which turn magenta and intensify on boost
  * cyan underglow, glowing drift tyre marks, and drift sparks
* **Boost feedback.** On a burst or a pad:
  * the underglow swells and turns magenta
  * the exhausts flare brighter with longer flames
  * a wide magenta streak trails the car, then fades
  * speed lines and chromatic aberration rise, and the camera pulls back with a small FOV lift
  * a magenta glow pulses at the screen edges (never over the centre of the view)
  * a pad also throws a ring of light off the road and flashes the pad itself
* **Race feedback.**
  * 3-2-1-GO with beeps
  * checkpoint gates flash, with a sector split banner and a chime
  * lap banners, and a distinct final-lap call: a magenta "FINAL" LAP panel, a banner, an
    edge glow and a rising five-note sound
  * Energy pickups burst into particles and pop a "+12" (or "+N drift") over the meter
  * the finish shows a big FINISH with the final time (and NEW RECORD) until the results open
* **HUD.** It holds:
  * LAP top-left, POSITION top-centre, TIME (`00:32.42`) top-right
  * BOOST, with a compact speed readout, bottom-right
  * a minimal control hint (keyboard or gamepad, whichever is in use) and a small track map
    bottom-left
  * It fits from 800×600 up: narrow windows shrink the top panels and wrap the hint.
* **Colour language.** Cyan is the player and the HUD. Magenta is secondary. Electric lime
  is Energy. Orange-red is danger. Sector colours are cyan, violet and amber.

### Step 6 presentation rules
* **The road reads first.** No effect may wash out the road, a gate or a car at speed. Bloom
  sources near the camera fade (the reactor, checkpoint curtains, road decals).
* **One colour language.** Route colours are green open, amber changing, red shut, on the
  track, the minimap, the HUD and the effects alike. Sector colours mark checkpoints and
  corner chevrons. Each player's colour marks their car's trim, underglow, rim light, lobby
  card, standings swatch and results.
* **Events in light.** Checkpoints, laps and the finish burst in the sector colour; track
  changes spark in the route colours where they happen; Overdrive in white-gold.
* **Reduced motion** keeps every piece of information and drops shake, roll, speed lines and
  the corner chase lights, and halves the race-moment particles.

## 5b. Audio and settings

All sound is synthesised in the browser with WebAudio (no audio files ship yet):
* an electric motor: a hum and a whine that rise with speed and throttle, wind noise at speed
* a boost hiss, a tyre skid while drifting
* one-shots for countdown, boost, a refused boost, boost pad, Energy pickup, drift reward,
  mini-turbo, checkpoint, lap, final lap, finish, wall hits and respawn

These are placeholders to be replaced by produced sounds (list in `05-rendering.md` §10).
Sound starts only after the first key press or click (browser autoplay rules) and is silent
behind the title screen.

Settings, on the title screen and in the pause menu, saved locally:
* **Sound**: on/off (also the M key) and a volume slider
* **Reduce motion**: follows the system setting until changed. It removes camera shake and
  roll, speed lines, chromatic aberration, screen-edge flashes, and the HUD's zooms, slides,
  shakes and pulses, while keeping every piece of information
* **Graphics**: Low / Medium / High

## 5c. Rooms, cars, results and session points (Step 7)

* **Landing page.** The way in: a nickname, checked the way the server checks it (with a hint
  when it would change), Create room, a room code with Join room, an invite link that fills
  in the code, and Practice solo. It explains the game (the three abilities and the keys) and
  shows nothing invented: no player counts, rankings or activity.
* **Lobby.** Everything shown is the server's room state:
  * the room code (Copy code) and the invite link (Copy invite link, and the link in full)
  * the players: car, host badge, ready or getting ready, and for a dropped player the seconds
    their seat is still held
  * the player count (4/8)
  * the car picker; the race length (host)
  * Start race (host) with the reason it cannot start yet
  * the session standings and the last race; New session (host); Leave room
* **Cars.** Eight colours, unique in a room, and three body styles on the same car: Dart (the
  low wing), Apex (a tall wing and a fin) and Brute (a ducktail, armour pods and a roof bar).
  * Styles are cosmetic: one physics model and one collision shape for all.
  * A car is picked in the lobby or on the results screen, checked by the server, shown to
    everyone, carried into the race, and remembered by the browser for the next room.
* **Race start.**
  * Everyone sees the ready check: who is ready and who is still getting ready. The host's
    Start counts as the host's ready.
  * The grid is the reverse of the session standings, so the leader starts at the back.
  * While the camera sweeps to the grid, a card shows the race's number in the session, the
    laps, the grid slot and the session standing going in.
  * The countdown runs on the server's tick, the same on every screen.
* **Results.**
  * Position, name, car, total time, best lap, Finished or DNF (left, or still racing when
    the race was called), race points and session total, the winner, your own line, race
    stats per player and the ability log.
  * Race stats per driver: boost bursts, Overdrives, drives through the shortcut, Energy
    collected, drift time and top speed. The ability log lists every Shortcut, Gate Shift and
    Overdrive press with its outcome. All of it is counted by the server's simulation; nothing
    is estimated, and nothing the game does not track is shown.
  * Order: finishers by finish time (sub-tick), then cars still racing by distance, then
    cars whose player left, by distance. Exact ties go to the lower grid slot.
* **Points.**

  | Place  | 1st | 2nd | 3rd | 4th | 5th | 6th | 7th | 8th | DNF |
  |--------|-----|-----|-----|-----|-----|-----|-----|-----|-----|
  | Points | 100 | 80  | 65  | 50  | 40  | 30  | 20  | 10  | 0   |

  * Only finishing places score. Nothing is awarded for drifting, boosting, abilities or
    anything else a player could farm.
  * Session standings: points, then wins, then join order.
  * A dropped player keeps their points while the seat is held (30 s). A player who leaves,
    or never comes back, loses the seat and its points: returning by code is a new player at
    0.
  * New session (host, from the lobby) puts everyone back to 0. Sessions are not stored:
    they last as long as the room.
  * The table is configuration (`packages/shared/src/session/scoring.ts`), separate from the
    race engine.
* **Race again.** On the results screen everyone says whether they are ready for the next
  race. The host starts it once at least 2 connected drivers are ready (the host counts).
  Players who are not ready follow it in the lobby's live standings and can join the one
  after. Names, cars and points carry over; everything about the race itself starts fresh.

## 5d. Global rating (Step 8)

Every player gets an anonymous profile on their first online race: no email, no password.
Rated online races (two or more players with profiles, one of them finishing) move a global
rating that starts at 1000, and the leaderboard ranks everyone by it. The rating is multiplayer
Elo (each race is a duel with every other rated player), kept apart from race points and
session points in every screen. The rules, the identity and the abuse limits are in
`08-ranking.md`.

## 6. Out of scope for the first versions
Accounts with email or passwords, social login, seasons, friends lists and chat, a track
editor, more than one track before M3, and car upgrades. Cars differ cosmetically only (colour
and body style). Any stat differences are deferred until the abilities are balanced.
