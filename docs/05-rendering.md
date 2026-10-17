# 05 — Rendering Strategy

Goal: a neon megacity circuit that looks premium in screenshots and holds **60 fps on an
ordinary desktop GPU**, with graceful degradation on integrated GPUs.

## 1. Pipeline

```
three.js WebGL2 renderer  (R3F <Canvas flat>, antialias off, stencil off, high-performance GPU)
  └─ EffectComposer (HalfFloat HDR buffer, no multisampling)
       RenderPass  →  Bloom (mipmap blur, threshold 0.95)
                   →  ChromaticAberration (driven by boost; Medium/High)
                   →  Vignette
                   →  ToneMapping (Khronos PBR Neutral)
                   →  SMAA (Medium/High)  →  sRGB output
```

Emissive surfaces are written with HDR intensities (2–8×). Only those exceed the bloom
threshold, so the neon glows and the dark city stays crisp. Tone mapping runs last, in the
composer. Since three r153, materials no longer tone-map into render targets.

Two decisions came from looking at real frames in Step 1:
* **Neutral tone mapping, not AgX or ACES.** AgX washed the neon into pastels and ACES shifted
  cyan and magenta hues. PBR Neutral keeps saturated emissive colours and deep blacks.
* **SMAA, not MSAA.** With three r186 and postprocessing 6.39 on ANGLE/D3D11, a multisampled
  composer outputs a black frame. SMAA gives clean edges without multisampled targets.
  `?fx=0` renders with no post chain at all (debugging and very weak GPUs).

## 2. Light and atmosphere

* **Real lights are minimal.** One hemisphere light plus one cool "moonlight" directional.
  Neon is emissive and bloom does the rest, so there is no per-light shading cost for hundreds
  of light sources.
* **Reflections without HDR downloads.** drei `<Environment frames={1}>` renders a 256 px cube
  map once from coloured `<Lightformer>` panels (magenta, cyan, violet). Glossy surfaces such as
  the car hull and the road pick up neon reflections.
* **Fog.** `FogExp2` in deep violet matches the sky's horizon colour, so distant towers
  dissolve into haze. It adds depth and also limits how far the eye can see geometry.
* **No real-time shadows.** The car gets a soft additive underglow decal that reads as both
  shadow and hover light.

## 3. Scene inventory and draw-call budget

| Element                     | Technique                                                                 | Draw calls |
|-----------------------------|---------------------------------------------------------------------------|-----------:|
| Sky dome                    | Gradient + procedural stars shader, `fog: false`                          | 1          |
| Ground                      | Shader grid (major/minor lines) fading with fog                           | 1          |
| Road surface                | One ribbon mesh; `MeshStandardMaterial` patched via `onBeforeCompile`: edge lines, kerbs, start grid, chequered line, animated chevrons, hex micro-pattern | 1 |
| Road deck sides / underside | Extruded skirt mesh                                                        | 1          |
| Neon rails                  | Box-section strips along both edges, vertex colours per sector            | 1          |
| Energy barriers             | Translucent ribbons, additive hex/scan shader, `depthWrite: false`        | 1          |
| Barrier posts               | `InstancedMesh`                                                            | 2          |
| Arches + checkpoint gates   | One instanced unit-box batch for structure, one for neon                  | 2          |
| Gate curtains               | Additive animated planes (next gate brightest)                            | 1          |
| Support pillars (elevated)  | Instanced                                                                  | 1          |
| City                        | ~700–1200 instanced boxes; shader windows, neon edges, roof crowns from instance attributes | 1–2 |
| Billboards                  | Instanced quads sampling one canvas texture atlas, hologram shader        | 1          |
| Reactor landmark            | Core + 3 rings + beam                                                     | ~6         |
| Searchlights                | Additive cones                                                            | 1          |
| Energy cells                | Instanced crystals + one `Points` halo layer                              | 2          |
| Boost pads                  | Road-hugging strips (one per pad) with an additive chevron shader that flashes on activation; corner posts instanced | 3 + 1 |
| Speed lanes                 | Road-hugging strips with an additive band shader (solid edges, arrows, flowing pulses), brighter while the player is inside | 3 |
| Car                         | Parts merged per material (`mergeGeometries`): body, trim, neon, lamps, exhausts; 4 wheels of tyre+rim+spokes and a neon rim ring; canopy, flames, beams, underglow | ~22 |
| Headlights                  | One SpotLight (no shadows) on the road + two additive beam cones          | 2          |
| Light trails                | 2 dynamic ribbons from the exhausts, faded near the lens, plus a wide magenta boost streak shown only while boosting | 3 |
| Drift marks                 | Instanced flat quads in a 640-slot ring buffer; fade from birth time in the shader | 1   |
| Ion Tunnel                  | Shell (inner, outer, portals) as one mesh; ribs and portal outlines in the neon batch; roof strips with the pulse shader | 2 |
| Track signs                 | Hologram panels (shared atlas) + an instanced gantry                      | ~4         |
| Sky traffic                 | 168 head/tail lights moving in the vertex shader (`uTime`), one `Points`  | 1          |
| Particles (sparks, bursts)  | One `Points` pool, CPU-updated (≤ 512)                                    | 1          |
| Speed lines                 | Camera-parented line streaks, opacity follows speed and boost             | 1          |
| Corner chevrons (Step 6)    | Instanced boards on the outside barrier of tight corners; a light chases along them (off with reduced motion) | 1 |
| Neon dust (Step 6)          | `Points` around the camera, drift and wrap computed in the vertex shader; Medium 260, High 520, Low none | 1 |
| The Needle (Step 5)         | Its own road, deck, rails and barriers, tinted by route state; a barrier curtain in the opening (rise/sink shader); lead-in chevrons; a cantilever gantry with light strips and a canvas sign | ~9 |
| Overload split (Step 5)     | Divider, two funnel fences (rise/sink shader), two lane chevron strips, a gantry with two lane boards and a title board, a lit nose post | ~10 |
| Post-processing             | Merged effect passes                                                       | ~5         |

**Budget:** about 50–60 draw calls and under 250 k triangles per frame. Simulation plus scene
updates should stay under 1.5 ms of CPU.

**Measured in Step 1** (menu view, scene pass without post): 60 draw calls, about 75 k triangles.
Step 2 adds the wheeled car, the tunnel, drift marks, signs and sky traffic (about 25 more draw
calls). In Chrome on the development machine, Medium at 1280×720 still runs at about 120 fps,
inside the tunnel too.

**Animated energy.** Neon rails and tunnel strips use one pulse shader: the sector colour
breathes, and bright pulses race along the track in the driving direction (uv.x = arc length).
Open Skyway edges swap the kerb pattern for amber hazard chevrons in the road shader.
At Medium, 1280×720 runs at about 120 fps in Chrome on the development machine's GPU.
Screenshots were checked at 1280×720 and 844×390 (phone landscape).

**Step 3** adds the pads, lanes, posts and the boost streak: 8 more geometries and 2 more shader
programs (105 and 41 in a race). At 1920×1080 Medium on the development machine (AMD Radeon
680M) a race still holds 120 fps, with a p99 frame time of 8.6 ms and no frame over 33 ms in
20 s. Across 10 restarts the heap stays at 62–63 MB after forced garbage collection, with
geometry, program and listener counts unchanged.

At 1.5× display scaling (2880×1620) Medium and High measure about 70–73 fps uncapped. A/B
tests show no measurable cost from any Step 3 addition (pads, lanes, posts, trails and streak,
screen flash). Hiding the whole DOM HUD gains about 15 fps there: the browser composites it over
a 4.7-megapixel canvas every frame. The HUD's own style and layout work is about 0.5 ms a frame.
The BOOST meter's "ready" pulse animates the opacity of a pre-blurred glow, not `box-shadow`,
so it never repaints.

## 4. Procedural content

* **Track geometry** comes from the shared `Track` samples. Physics and visuals therefore use
  exactly the same surface (centre + right·d − d·tan(bank)·up). Every mesh is built once at
  load as a typed-array `BufferGeometry`.
* **City.** Candidate lots on a jittered grid. The track is rasterised into a clearance grid
  so nothing spawns on or beside the road. The canyon blocks near the track stay low to mid
  height. The skyline ring further out is taller and denser. The tower shader derives
  per-instance size from `instanceMatrix`:
  * floors (3.5 m) and window bays (4 m) in metres
  * hashed lit and unlit windows with a warm/cool palette and a slow flicker
  * neon corner strips and roof crowns on some towers
  * distant facades fade to an averaged glow (`fwidth`-based anti-aliasing) to avoid
    shimmer
* **Signage.** One 2048 px canvas atlas is drawn at runtime with the bundled Orbitron and
  Rajdhani fonts. It holds holo ads and the gantry sign. No text library, no font fetch.
* **Car.** Built from extruded shapes and primitives. A metal hull reflects the environment.
  Accent strips are HDR emissive. Thruster glow follows throttle and boost.
* **Determinism.** Environment placement uses a seeded RNG, so every client sees the same
  skyline.

**Step 5** adds the Needle and the split (about 19 draw calls, when in view). Their materials
take the track state as uniforms every frame: barrier levels, flashes, arrow brightness, route
tints. Sign boards are canvas textures redrawn only when their text changes.
`ShaderWarmup` compiles every material in the scene, hidden and off-screen ones included, once
the world is up and at every race start, into the same kind of target the effect composer
draws into. Before it, the first Overdrive compiled a new shader mid-race (an effect first
shown then); with a busy GPU that stalled a frame for 350 ms.

**Step 6** (visual polish):
* **Bloom budget.** No surface may light up a large part of the screen at the chase camera's
  distance. The reactor beam's height term was broken (it used the vertex position instead of
  `uv`, so a 1.6 km cylinder glowed at full strength): fixed. The reactor dims as the camera
  approaches, checkpoint curtains fade within 24 m of it, and lane and pad decals soften right
  under it. A whole lap was measured frame by frame: the brightest frame fell from 171/255 to
  84 (mean 57).
* **New per-frame cost.** Corner chevron boards (one instanced mesh), neon dust (one `Points`,
  Medium and High; positions computed in the vertex shader), race-moment effects (the
  existing particle pool), a fresnel rim on car bodies (an `onBeforeCompile` patch, one shared
  program). Whole-frame draw calls at Medium: 113 solo, 140 with eight cars.
* **Measured.** Uncapped at 1920×1080 DPR 1: Low 129 fps, Medium 101, High 100. At DPR 2
  (1440×900): Low 159, Medium 83, High 60. Eight cars online: 128–130 fps against 145 solo at
  1280×720 Medium.

## 5. React Three Fiber rules

1. **No React state in the frame loop.** `useFrame` mutates refs, uniforms, instance matrices
   and DOM refs directly. The HUD reads the session in `requestAnimationFrame`.
2. **Priorities.**
   * `-3` simulation step
   * `-2` world objects (car, cells, trails)
   * `-1` camera
   * the composer renders at `1`
3. **Allocate once.** Vectors, matrices and colours used per frame are module or `useMemo`
   scratch objects. Geometry is built in `useMemo` and disposed on unmount.
4. **Instancing first.** Anything that repeats more than ~5 times is an `InstancedMesh`, or
   animates in a shader from `uTime`.
5. **The Canvas never unmounts.** Menu, race and results reuse the same scene. Starting a race
   resets the session, not the GPU resources.
6. **Lint exemption, scoped.** The React Compiler rule `react-hooks/immutability` flags these
   per-frame mutations of memoised three.js objects. The project does not use the compiler, so
   that one rule is off for `src/scene/**` only (see `eslint.config.js`).

## 6. Quality tiers

| Setting              | Low (touch default) | Medium (desktop default) | High            |
|----------------------|---------------------|--------------------------|-----------------|
| DPR cap              | 1.0                 | 1.5                      | 2.0             |
| SMAA                 | off                 | on                       | on              |
| Bloom                | half-res, 5 levels  | full, 7 levels           | full, 8 levels  |
| City towers          | ~450                | ~900                     | ~1300           |
| Particles            | 128                 | 384                      | 512             |
| Chromatic aberration | off                 | on                       | on              |

**Adaptive resolution.** drei's `PerformanceMonitor` samples the frame rate in 250 ms windows.
* When 8 of 10 windows fall below 40 fps (60 fps on displays above 100 Hz), the canvas drops to
  DPR 1.
* When they hold the display rate, the tier's DPR cap comes back.
* After three real changes it stays at DPR 1.

`GameCanvas` counts the changes itself. drei's own flip-flop limit also counts every "still
fast" check, which dropped every machine to DPR 1 after about 10 s.

The player's quality choice is saved locally. Measured frame rates are in the Step 2
validation record ([07-milestones.md](07-milestones.md)).

## 7. Speed sensation toolkit

* FOV widens with speed and boost. The camera pulls back under acceleration.
* High-frequency repeating structures (posts every 12 m, arches every ~70 m, kerbs every 2 m)
  sweep through the view.
* Road chevrons flow toward the player at a fixed world speed, so faster driving makes them
  stream faster.
* Speed lines and chromatic aberration appear only near top speed and during a boost burst or
  a pad impulse.
* A boost or pad pulses a glow around the screen edges (the centre stays clear) and spawns the
  magenta streak; the underglow swells and the exhaust flames lengthen.
* Overdrive does the same in white-gold, stronger: a wider streak, a bigger underglow, a longer
  camera pull and embers at ignition.
* Light trails stretch with speed. Tall buildings close to the road on the back straight make
  a canyon.

## 8. Mobile rendering

Low tier by default: DPR 1, no SMAA, half-resolution bloom, fewer towers and particles, no
chromatic aberration. The HUD uses relative units and safe-area insets.

## 9. Reduced motion

The **Reduce motion** setting (title screen and pause menu) defaults to the system's
`prefers-reduced-motion` and can be overridden. When on:
* the camera has no shake and no roll, and FOV changes are cut to about a third
* speed lines, chromatic aberration and the screen-edge flashes are off
* HUD text fades instead of zooming or sliding; the meter does not shake or pulse

The resolved choice is set as `data-motion` on the root element, so CSS and the scene read the
same switch.

## 10. Audio (placeholder sound)

`apps/client/src/game/audio.ts` synthesises everything with WebAudio; nothing is downloaded.
Created on the first key press or click (autoplay rules), suspended while the tab is hidden,
silent behind the title screen. Master gain is `volume²` (0 when muted), into a compressor.

| Sound | Now (synthesised) | Replace with |
|---|---|---|
| Engine | sawtooth body + square sub-octave through a lowpass that opens with throttle; triangle whine; pitch from speed | a recorded or produced electric-motor loop set with pitch/filter layers |
| Wind | looped noise through a bandpass that rises with speed | wind/air-rush loop |
| Boost hiss | high-passed noise while a burst or pad runs | boost roar loop |
| Tyre skid | narrow bandpass noise while drifting, louder with slip | tyre squeal loop |
| Countdown / GO | square beeps (C5, then C6 + G6) | countdown voice or stingers |
| Boost burst | noise sweep + falling sine thump + rising saw | boost ignition whoosh |
| Boost refused | two low square blips | UI "denied" |
| Boost pad | rising saw zap + high noise | pad zap |
| Energy pickup / drift reward | two sine / triangle chime notes | pickup chimes |
| Mini-turbo | rising square blip + small whoosh | mini-turbo whoosh |
| Checkpoint / lap / final lap / finish | two-note blip, three-note and five-note arpeggios, a fanfare chord | race stingers |
| Wall hit | falling sine thump + low-passed noise, scaled by impact | impact |
| Respawn | sine sweep down, then up | reboot effect |
| Overdrive | long noise sweep + deep sine thump + rising saw; a falling tone when it ends | Overdrive ignition and wind-down |
| Shortcut / Gate Shift | three rising triangle notes / two square notes | ability stingers |
| Ability refused | two low square blips | UI "denied" |
| Speed-lane Energy | two high triangle chimes | pickup chime |
| Gate warning / Needle closing | square pips over the warning | warning klaxon |
| Gate switched / Needle shut | low-passed noise clunk | heavy mechanism |

## 11. Later

* Remote cars reuse the car model with per-player accent colours, an instanced trail pool, and
  name tags drawn in the canvas atlas.
* More track-manipulation visuals as more route features arrive (Step 5 drives its barriers,
  arrows and tints with per-material uniforms; a shared `uTrackState` texture pays off once
  there are many nodes).
* Music: a synthwave loop.
