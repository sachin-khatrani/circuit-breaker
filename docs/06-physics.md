# 06 — Physics Strategy

## 1. Choice: custom arcade model, no physics engine

CIRCUIT BREAKER needs physics that is **fun, predictable, cheap and identical on client and
server**. A rigid-body engine (Rapier, cannon-es, Ammo) would bring:

* tyre and suspension behaviour we would spend weeks fighting to feel arcade-like
* a WASM or large JS dependency on the server
* solver details that make client prediction harder to match

The model is instead a few hundred lines of TypeScript in `packages/shared/src/sim/`. It runs
on a **fixed 60 Hz tick**, uses **no randomness**, and keeps all tuning in one table
(`sim/config.ts`).

## 2. Coordinate system

* World units are metres, with three.js axes: **Y up**, the track in the **XZ plane**.
* `yaw` is the heading. Forward is `(sin yaw, 0, cos yaw)` and right is `(−cos yaw, 0, sin yaw)`,
  which matches three's `rotation.y`. Positive steer turns right, meaning yaw decreases.
* The physics is **2.5D**. Cars move in XZ. Height, pitch and roll come from the road surface
  under the car.

## 3. Track surface model

The track is a closed centripetal Catmull-Rom spline, resampled every ~2 m into typed arrays.
Each sample stores position, unit tangent, flat right vector, half-width, bank and signed
curvature. The surface point at arc length `s` and lateral offset `d` is:

```
P(s, d) = C(s) + R(s)·d + Y·(−d·tan(bank(s)))
```

The road mesh is built with the same formula, so the car always sits exactly on the visible
surface.

**Projection.** `track.project(x, z, hint)` searches ±16 samples around the car's last sample
index for the closest centre-line segment. It returns `s`, signed lateral offset, interpolated
half-width and surface height. The search is O(1) per car per tick. The hint also keeps a car
on its own level where roads pass close together. If the best match lands on the window edge,
it falls back to a global search.

**Roads and portals** (Step 5). The main loop is road 0, and the Needle is road 1: an open
spline of its own (`Road`, `BranchRoad` in `track.ts`). A car knows the road it is on and is
projected on that road only.
* Where the branch runs alongside the main road, their shared edge is a **portal**. A car
  crosses it when its centre passes the edge; one crossing per tick at most.
* The entrance (main → Needle) is open only while the shortcut is open; otherwise it is an
  ordinary wall. Every other way across is always open: from the branch back to the main road,
  and the merge. Running off either end of the branch puts the car back on the main road. So
  nothing can trap a car on the branch.
* Laps and checkpoints work in the main road's arc length. A position on the branch maps to it
  (`track.mainS`): one to one along the openings, evenly spread in between.

**The split** (Step 5). The Overload split is a 3 m divider down the banked hairpin, after a
36 m funnel. In the funnel a fence closes off the shut lane diagonally. The lane a car must
keep to is fixed when it enters the funnel, and again at the divider's nose. A gate change
therefore never moves a barrier onto a car: only cars entering afterwards meet the new
fence.

## 4. Vehicle model (per tick, dt = 1/60 s)

State: `x, z, yaw, vx, vz, yawRate, throttleLevel, energy`, the boost burst
(`boostLeft, boostCooldown, boostQueued, boostHeld`), impulses (`impulseTicks, padTicks`),
`inLane`, the drift (`drifting, driftDir, driftTicks, driftEarned, recoverTicks`), plus track
association (`trackIndex, s, lateral`).

```
1. Steering (yaw rate)
   authority(v) = min(1, |v|/12) · lerp(1, 0.5, clamp((|v|−12)/(vmax−12)))
   target = −steer · 1.9 rad/s · authority · sign(vF)       (reverse steers like a real car)
   drifting: target = −driftDir · 1.8 · authority · (1 + 0.4·steer·driftDir)
   yawRate → target at 12 /s (3.6 → 12 /s over the 0.35 s after a drift);   yaw += yawRate·dt

2. Decompose the world velocity in the NEW heading frame:  vF (forward), vR (lateral)

3. Longitudinal
   vmaxEff = 72 m/s + the LARGEST active bonus (they never stack):
             boost +18 (90), boost pad +14, drift/launch impulse +10, speed lane +5
   headroom  = max(0, 1 − (vF/vmaxEff)²)
   throttle:   level → throttle at 9 /s (0.11 s to full: smooth, still instant-feeling)
               vF += 30 · level · headroom · dt        (×0.85 while drifting)
   boost:      vF += 26 · kick · ramp · headroom · dt  (kick 1.6 for 15 ticks, ramp-in 4 ticks)
   impulse:    vF += 18 · headroom · dt;   pad: vF += 30 · headroom · dt
   lane:       vF += 8 · headroom · dt while throttling inside a speed lane
   brake:      vF −= 45·brake·dt (to exactly 0); held at a standstill for 0.2 s, then
               reverse at 12 m/s² up to −14 m/s
   coast:      vF −= sign(vF)·(2 + 0.15·|vF|)·dt         (no throttle, brake, boost or impulse)
   overspeed:  vF above vmaxEff decays toward it at 0.9 /s (boost bleeds off smoothly)
   slope:      vF −= 9.81 · 0.6 · slopeAlongHeading · dt (a held brake keeps the car still)

4. Grip (the heart of the handling)
   speed = |(vF, vR)|,  slip = angle of the velocity from the nose (or tail when reversing)
   scrub:  speed −= (drifting ? 0.42 : 0.6) · speed · |sin slip| · dt
   grip:   slip  ← slip · exp(−grip·dt),  grip = 7.5 /s normally, 2.2 /s while drifting,
           blending back from 2.2 to 7.5 over 0.35 s after a drift ends
   (vF, vR) = speed · (cos slip, sin slip)

5. Recompose the world velocity; integrate position.
```

Why this feels right:
* Grip swings the velocity toward the heading exponentially while **keeping its magnitude**.
  Cars carve at high grip and slide at low grip, and the slip angle settles near
  `atan(yawRate/grip)` without a tyre model. Speed is lost only through the explicit slip
  scrub, so cornering costs and drift costs are separate, tunable numbers.
* The first version damped the sideways component instead (`vR ← vR·e^(−grip·dt)`). That
  silently bleeds speed at a rate of `yawRate²/grip`. A low-grip drift lost more than its own
  speed every second and stalled within half a second. A unit test now guards this: a 1.2 s
  drift keeps going, charges Energy and pays a mini-turbo.
* Steering authority tapers at top speed (0.95 rad/s at 72 m/s, about a 76 m radius). Long
  sweepers are flat-out. The Switchback hairpin (22 m) needs braking to about 110–120 km/h,
  or a drift.
* Overspeed decays instead of being clamped, so the end of a boost does not feel like hitting
  a wall.
* The throttle ramp and the lighter coast drag (Step 3) make lifting off a smooth ease rather
  than a brake: 250 → 150 km/h now takes 2.9 s off-throttle (1.3 s before).
* "Stopped" means under 0.05 m/s. Slopes leave a tiny residual speed every tick; counting it
  as motion once stopped the brake from ever turning into reverse on Grid Zero's grid.

## 5. Drift and mini-turbo

* **Enter.** Drift button (Space) + |steer| > 0.25 + vF > 22 m/s. The direction locks to the
  steer side, and a 0.5 rad/s yaw kick gives the "flick".
* **Hold.** Steering modulates the drift's yaw rate from 0.6× (counter-steer) to 1.4× (into
  the turn). Grip drops to 2.2 /s, so the slip angle settles around 30–35°. The engine runs at
  0.85× and the slide scrubs 0.42·speed·|sin slip|, so a held drift settles near 190 km/h
  (top speed is 259).
* **Balance.** A drift turns about 25% tighter than grip at the same speed: in a hairpin the
  car carries more speed sliding than braking to the grip limit. It is slower everywhere else:
  a held slide cannot reach top speed, and weaving down a straight for mini-turbos loses to
  driving straight (both are tested).
* **Charge.** +7 Energy/s, but only for a sustained, controlled slide:
  * after the drift has lasted 0.5 s
  * slip angle between 0.15 and 0.8 rad, speed above 22 m/s
  * velocity still heading down the track (at least half the speed along the race direction),
    so spinning in circles earns nothing
  * at most 8 Energy per drift, then a 1.5 s cooldown before another drift can earn
* **Exit.** Button released, speed below 15 m/s, or a wall hit. Hold time ≥ 0.9 s grants a
  0.5 s impulse, and ≥ 2.0 s grants 0.9 s. Grip and steering response then blend back over
  0.35 s: the slide straightens from 35° to 5° in about 0.4 s instead of snapping straight in
  0.2 s.

## 6. Wall collisions

After integration, if `|lateral| > halfWidth − 1.1 m` (car half-width):

1. Push the car back inside along the track's flat right vector.
2. With `n` the outward normal and `vn = v·n > 0`:
   * remove the normal velocity with restitution 0.25
   * cut tangential speed by `0.35·vn`
3. Rotate yaw toward the wall tangent in the car's travel direction, by
   `clamp(vn/20, 0.12, 0.55)` of the angle, and damp `yawRate`. The car deflects instead of
   sticking nose-first.
4. While scraping, apply a 0.4 /s drag to the tangential speed, end any drift, and emit a
   `wallHit` event when `vn > 3 m/s` (camera shake, sparks).

## 6b. Open edges, flying off and the ground

Barrier-free stretches (`openEdges` in the track definition; Grid Zero's two Skyway straights)
let the car leave the road. Each car is on one of three surfaces:

| Surface  | Entered when                                                   | Behaviour                                                         |
|----------|----------------------------------------------------------------|-------------------------------------------------------------------|
| `road`   | normal                                                         | the model above; height is snapped to the road surface             |
| `air`    | more than 0.6 m past an open edge where the road is > 1 m up   | ballistic: keeps its velocity, starts with the road's climb or fall rate (`vy = v·along · slope`), gravity ×1.8, light air drag, no traction, no boost |
| `ground` | past an open edge at ground level, or landing below            | engine ×0.4, grip 2.5 /s, drag 1.4 /s; climbs back where the road sits at ground level and the edge is open |

A car that comes down over the road surface lands on it again. The race respawns a car that
stays in the air for 45 ticks (0.75 s) or on the ground for 30 ticks (0.5 s). It goes back to
`safeS`, the last arc length where the car was at least 1.5 m inside the road, on the centre
line, frozen for 1 s. Tests cover:
* flying off and respawning
* a half-open stretch still walling its other side
* respawning a stranded car
* the autopilot never falling over 3 laps

## 6c. Boost bursts

Boost is a burst, not something you hold:

* A **fresh press** of Boost starts a burst if the car has at least **20 Energy**, paid up
  front. The burst lasts **1 s**, then a **0.5 s cooldown** follows.
* Holding the button, or pressing again during a burst, adds nothing. A press in the last
  0.25 s before a burst may start is remembered and fires on time, so a slightly early press
  is not lost.
* A press without enough Energy is reported (`boostDenied`): the HUD shakes and the exhausts
  sputter.
* Thrust ramps in over 4 ticks, then the first 15 ticks push 1.6× harder (the "kick"). It is a
  shove, never a jump: the largest speed change in one tick is under 0.5 m/s (tested).
* Leaving the road or a respawn cancels a running burst; the Energy is not refunded.

The 90 m/s cap keeps it controllable: steering authority at 90 m/s still gives a ~95 m turn
radius. The barrier and gate checks hold at that speed: a car boosting non-stop for two laps
never ends a tick past a barrier and meets every checkpoint (tested).

## 6d. Boost pads and speed lanes

Both are zones on the road: an arc-length range and a lateral band, looked up in O(1) per tick
from a per-sample table.

* **Boost pad.** The race fires a pad for a car on the road whose centre is within the pad
  (plus 0.6 m) while it moves forward along the track at 3 m/s or more. The car gets a 0.8 s
  impulse (+30 m/s², top speed +14 m/s). That pad then stays inert for that car for 3 s, so
  sitting on it or crossing it again does nothing.
* **Speed lane.** While the car is inside a lane it gets +8 m/s² under throttle and +5 m/s top
  speed. Lanes run along the exit line of slow corners, rewarding the line that tracks out to
  the outside edge. Covering 75 % of a lane's length inside it, moving forward, pays 5 Energy,
  once per lane per lap.

## 6e. Overdrive

Overdrive (an ability) runs 3 s: top speed 98 m/s and +30 m/s² of thrust, against a burst's
90 m/s and +26 m/s². Starting it cancels a running burst, and no burst can start while it runs.
Pads and lanes do not add to it: only the largest top-speed bonus counts.

## 7. Race rules on top of the vehicle

* **Gates.** A checkpoint is a vertical plane with forward normal `T` at centre `C`. It is
  crossed when `(P_prev−C)·T < 0 ≤ (P_cur−C)·T` and the crossing point lies within
  `halfWidth + 2 m` laterally.
* **Sub-tick timing.** `t = d0/(d0−d1)` gives the crossing moment inside the tick, and lap and
  finish times use it.
* **Energy cells.** A cell is picked up within 3.0 m (2D) and 4 m vertically. That stays
  tunnel-free at 1.6 m per tick. Respawn after 300 ticks.
* **Respawn.** On reset, the car is placed on the centre line at its projected `s`, facing the
  tangent. Velocity is zeroed, it is frozen for 60 ticks, and `prev = cur`, so no gate can
  register.
* **Stuck.** A car on the road pressing throttle or brake while moving slower than 1.5 m/s for
  3 s is respawned the same way (reason `stuck`). A car simply waiting is left alone.
* **Countdown and launch.** Cars are held during the countdown. A throttle press inside the
  last 24 ticks before GO, still held at GO, grants a 72-tick impulse.
* **Abilities.** Each tick, before the car moves:
  * the track state advances (a scheduled opening, closing or switch)
  * each racer's ability cooldowns count down, and a fresh press (a press edge) is checked in
    the order phase → cooldown → track busy → Energy, then paid and applied
  * racers resolve in grid order, so two presses in one tick always resolve the same way
  * presses during the countdown are swallowed, so nothing fires at GO
* **Energy caps.** Drifting pays at most 30 Energy a lap; lanes pay once per lap; Energy stays
  within 0–100. A new lap resets the lap counters.

## 8. Car-to-car contact: none (ghost cars)

Step 4 chose ghost cars: cars never collide with each other, and each one still obeys walls,
open edges, respawns, gates and pads.

The planned soft contact (equal-mass circles, restitution 0.2) was dropped for two reasons:
* **Prediction.** A contact depends on another player's car. The client only knows that car
  from about 110 ms ago, so every touch would correct the local car.
* **Fairness.** With ghosts, latency cannot decide a collision, and blocking or ramming cannot
  work.

The simulation has no car-pair code at all. See `04-networking.md` §8.

## 9. Autopilot (attract mode now, bots in M5)

Pure pursuit on the centre line:
* **Steering.** Target point at `s + 10 + 0.45·v` m. Steer is proportional to the heading
  error.
* **Speed.** A corner-speed profile is precomputed per sample from the steering-authority
  curve, `v ≤ yawMax(v)/|κ|`, solved by bisection. A backward braking pass at 32 m/s² turns it
  into the speed the car must hold at every point.
* **Boost.** It presses Boost (a fresh press, released while the burst runs) when the next
  160 m are flat-out and a burst is affordable, but not within about 150 m before a boost pad,
  since bonuses do not stack.
* **Pads.** It lines up with a boost pad from 110 m out and holds that line until it is across.
* **The split.** It reads the open lane from the track state 120 m ahead, eases across to that
  lane, plans its speed for the lane's own line (curvature `k/(1+k·d)`) at 95 % pace, and
  steers with a curvature feed-forward plus a correction toward the lane's centre. Pads on the
  far side of the lane are skipped.
* **The Needle** (only when asked, and only when it will be open on arrival). From 160 m out
  it eases over to 1.6 m inside the left edge, lined up 50 m before the opening. It aims into
  the branch only once inside the 35 m opening, so it never clips the wall before it. A car
  more than 5 m short of that line (the shortcut opened too late) lets the shortcut go.
* The autopilot never presses an ability itself; bots and tests decide when.
* The autopilot only produces a `PlayerInput`, like a player would, so bots cannot cheat.

## 10. Determinism and testing

* Same code, same inputs and same tick produce the same result on the same JS engine. Across
  engines, `Math.sin`/`exp` can differ in the last bit. That is harmless here because the
  server is authoritative and the client reconciles.
* Vitest suites in `packages/shared/test` (49 tests):
  * the track is valid: closed, no self-intersection, minimum corner radius, sane grades
  * projection round-trips
  * gate logic: a forward pass counts, reverse does not, skipping a gate does not
  * an autopilot completes a 3-lap race in a plausible time, hits every pad, never leaves the
    road surface, and finishes exactly once, right after the last lap
  * the vehicle reaches its documented top speed, eases off gently, brakes to a dead stop,
    holds, then reverses (also on the real, slightly sloped grid)
  * boost bursts: fixed length and cost, one per press, never stacked when mashed, denied
    without Energy, an early press remembered, a smooth shove
  * pads fire once per crossing with a per-car cooldown, never in reverse or when missed;
    lanes raise top speed
  * drift balance (tighter than grip, slower in a held slide, weaving loses) and drift Energy
    (delay, cap, cooldown, nothing against the race direction)
  * a car boosting non-stop stays inside the barriers and meets every checkpoint; resets
    mid-race keep laps correct; a cell never pays twice before it respawns; stuck cars respawn
* `abilities.test.ts` (21 tests, Step 5): the branch and split geometry; ability costs,
  refusals, held buttons and simultaneous presses; farming limits; the Needle's timeline, its
  barrier, the way through and the merge, never trapped, and a lap through it that meets every
  checkpoint and is faster; the gate's warning and lock, with no barrier moved onto a committed
  car; Overdrive's length, top speed, end event, burst blocking and cooldown

## 11. Tuning table (Step 3; Step 5 rows added)

| Parameter              | Value                          | Feel                                   |
|------------------------|--------------------------------|----------------------------------------|
| Top speed / boost      | 72 / 90 m/s (259 / 324 km/h)   | Fast, readable on a 20–26 m road       |
| Engine accel           | 30 m/s², throttle ramp 0.11 s  | 0–100 km/h in 1.02 s, 0–200 in 2.48 s  |
| Coast                  | 2 + 0.15·v m/s²                | Lifting off eases (250 → 150 in 2.9 s) |
| Brake                  | 45 m/s², 0.2 s hold at a stop  | 259 km/h to 0 in 57 m / 1.6 s          |
| Reverse                | 12 m/s² up to 14 m/s           | Engages after the hold                 |
| Grip / drift grip      | 7.5 / 2.2 /s, 0.35 s blend back | Carve vs. slide, no snap on exit      |
| Max yaw rate           | 1.9 rad/s (0.5× at top speed)  | Hairpins need braking or a drift       |
| Drift yaw rate         | 1.8 rad/s × 0.6–1.4 modulation | A held slide settles near 190 km/h     |
| Boost burst            | 20 Energy, 1 s, 0.5 s cooldown; +26 m/s² (×1.6 kick) | 40 Energy = 2 bursts |
| Boost pad              | +30 m/s², +14 m/s for 0.8 s; 3 s per-car cooldown |                     |
| Speed lane             | +8 m/s², +5 m/s while inside   | Rewards the exit line                  |
| Start / cell / drift Energy | 40 / +12 / +7 per s (max 8 per drift, 30 per lap) |          |
| Speed-lane Energy      | +5 per lane per lap (75 % of it) | Once per lap, forward only           |
| Overdrive              | 40 Energy, 3 s, 15 s cooldown; 98 m/s, +30 m/s² | Cancels and blocks bursts |
| Shortcut / Gate Shift  | 45 / 30 Energy; 25 s / 20 s cooldowns | Track locks after: 2 s / 10 s   |
| Off-track respawn      | 0.75 s in the air / 0.5 s on the ground; 3 s stuck | then 1 s reboot freeze |
| Wall restitution       | 0.25                           |                                        |

Measured on Grid Zero (3.01 km) with the shared autopilot, which never drifts:
* with bursts and pads: laps of 46.1 s, then 43.5 s twice (Step 2: 46.1, then 44.0 twice)
* 19 bursts and all 9 pad crossings over 3 laps, top 318 km/h
* no wall hits, no falls, never off the road surface
* 9 µs per simulation tick for one car under Node
