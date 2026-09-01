# City Defense — Project Context

## Roles
The user is the **CPO / Creative Director**: game idea, gameplay decisions, level
design, art direction, "does this feel fun" calls.
You (Claude) are the **CTO / Engineer**: all code, architecture, tech choices,
and turning the user's creative direction into working features. Default to
making the engineering calls yourself; ask the user when a decision is about
gameplay feel, theme, or content rather than implementation.

The user is technical but **not a developer** — explain terminal commands
plainly when they're needed, don't assume familiarity with build tooling,
and prefer small verifiable steps over large unexplained changes.

## What this game is
A single-player browser game: defend a city from waves of intruders.
Presented as fixed-camera, tile-based "2D+" (Age of Empires-style
isometric) — see "MAJOR REWRITE: tile-based terrain" below for why and
how this changed from the original free-orbit 3D presentation.
Each level has four phases:
1. **Scouting** — player sees the intruders on the map (idle, visible count/placement)
2. **Placement** — player spends a gold budget to place defenders on their half of the map
3. **Battle** — fully automatic simulation, no player input; units fight until one side is wiped
4. **Result** — victory or defeat, with a retry option

## Tech stack (decided, don't relitigate without reason)
- **Three.js** for 3D rendering (plain primitives for now — no art assets yet)
- **Vite** for dev server / bundling
- **Plain JavaScript** (not TypeScript) — kept simple since the user isn't a developer
- No physics engine. Combat is custom game-logic (state machine + cooldown-based
  attacks + simple steering), not rigid-body simulation. Revisit only if we want
  physical effects like knockback or ragdolls.
- Static site, no backend. Deployable to Netlify/Vercel/GitHub Pages.

**Melee crowding cap** (`MAX_MELEE_ATTACKERS_PER_TARGET` in `src/main.js`)
— real fix for a jitter report. Root cause: when many mobile units lock
onto the same single target, there's a hard physical limit to how many can
actually fit within melee range without overlapping — if more try to cram
in than the space allows, separation is fighting an unwinnable fight every
frame (push apart, immediately re-overlap), which reads as jitter. Fixed by
capping how many melee attackers can be simultaneously engaged with one
target (currently 6, tunable); a first pass each frame counts already-
engaged attackers per target, and any unit that would be a new arrival past
the cap simply holds its current position instead of continuing to push
into an already-full space. This creates a natural queue — waiting units
resume approaching automatically the moment a slot frees up (an attacker
dies), no separate queue data structure needed. Ranged units are exempt
(they don't compete for melee space). Separation itself was also made
frame-rate independent (delta-scaled instead of a fixed per-frame nudge
constant) as a secondary smoothness improvement.

**Grid quantization bug** — found by the test suite immediately after
expanding the map (see below), a third distinct bug class from this system.
The grid marks a *cell* blocked based on whether its center point is far
enough from an obstacle. But a line-clearance check samples points that can
land near a cell's *edge*, not its center — so a cell can be marked "open"
while a specific sampled point within it is actually a bit too close to the
true obstacle boundary. This produced smoothed paths that passed the grid's
own check (self-consistent) but failed independent geometric verification —
a different bug from the earlier smoothing bug, but with a similar lesson:
grid resolution and analytic geometry don't automatically agree just
because they're both "checking the same obstacle." Fixed with
`GRID_SAFETY_MARGIN` (0.4, roughly two-thirds of a cell width) added on top
of the true required clearance *only* when building the grid (not for
`resolveTerrainCollisions`, `blockedByCliff`, or placement exclusion, which
use exact analytic clearance and were never affected) — this makes the
grid deliberately more conservative than strictly necessary, absorbing the
quantization gap so a grid-approved path always has real, not merely
approximate, clearance.

**Map expanded** (`MAP_WIDTH: 46, MAP_DEPTH: 30`, up from 36x22) with more
scattered terrain: a third cliff (`CLIFFS[2]`, face `"north"`, in a distinct
part of the map from the other two) and two additional forest patches
(`FORESTS[2]`/`FORESTS[3]`) — one tucked into defender territory, one on the
intruder side (forcing Raiders themselves to route around something before
even reaching the border, not just defenders dealing with terrain).
Raiders increased to 20 (5 clusters of 4, up from 5 of 3); starting gold to
14. Camera, fog distance, orbit limits, ground mesh resolution, and the
city's position/buildings were all rescaled to match — none of these were
left at old-map values.

## Roadmap status
1. ✅ Walking Skeleton — empty scene, one placeholder unit each side, fake battle
2. ✅ Real Combat Logic — range, health bars, damage, death, win/loss (mostly landed in phase 1)
3. ✅ Placement & Budget — gold economy, unit selector UI
4. 🔶 Multiple Unit Types — landed for Level 1 (see roster below), more types = future work
5. ⬜ Levels & Progression — currently only one hardcoded level; needs data-driven level files + level select + retry-with-new-tactic flow
6. 🔶 Your Art Goes In — presentation pivoted to fixed-camera tile-based
   "2D+" (see MAJOR REWRITE section below); terrain/units are still simple
   placeholder geometry/sprites, real 2D character sprites and tile art are
   being sourced next
7. ⬜ Polish Pass — sound, particles, camera framing, menus
8. ⬜ Ship It — deploy to a public URL

## MAJOR REWRITE: tile-based terrain + fixed isometric camera

The single biggest architectural change in this project's history. The
game moved from free-orbit 3D (perspective camera, continuous heightmap
terrain, box-mesh units) to a fixed-camera, tile-based "2D+" presentation
(Age of Empires-style). Explicit user decision, made with full awareness
of the tradeoffs (a lighter "lock the camera, keep 3D" option was
presented first): "Fuck it, lets go for the full rewrite to tile based
terrain! I really think this is the best long term choice!" Motivation:
2D character sprite sheets (with real attack/walk animations) are far
more practically available than 3D character models, and the user wants
the game to look genuinely good ("indie feel") which is a better bet with
sprites + tile art than continuing with primitive 3D shapes. Explicit,
critical constraint honored throughout: **pathfinding and battle/combat
logic must not be redesigned** — only bugs found in that logic get fixed,
never the underlying approach. All Kenney GLB environment assets (trees,
rocks, cliff kit, fences, paths — 60 files, still on disk under
`public/models/` but unreferenced by any code) were explicitly authorized
to be discarded: "if you need to throw out any assets, no problem! I will
find new ones for everything."

### The core idea: elevation as discrete tile levels

Continuous terrain (smoothstep hill falloff, smoothstep cliff margins,
domain-warped ambient noise — all in the now-deleted `src/terrain.js`) is
replaced by a tile grid (`src/tileTerrain.js`): each tile has an integer
elevation `level` and a `type` (GROUND / RAMP / SHEER / FOREST / CITY).

This isn't just a rendering change — it's a genuine simplification of the
terrain MODEL. Hills and Cliffs, previously two separate systems, collapse
into ONE concept: a **plateau**, a raised rectangular tile region whose
four edges are each either a RAMP (walkable transition — matches old Hill
behavior, climbable from any side) or SHEER (impassable — matches old
Cliff behavior). A Hill is a plateau with ramps on all four sides; a Cliff
is a plateau with 1-3 sheer sides (never all 4 — always leave a way up).
`levelGenerator.js`'s `generatePlateaus()` generates both from one
function, varying only which sides are sheer (~40% hill-type, ~60%
cliff-type, matching the old rough proportions).

Gameplay rules translate cleanly to discrete levels, verified equivalent
(not just visually similar) to the old continuous rules:
- **Elevation damage bonus**: `attacker.level > target.level` (was
  "continuous height difference ≥ threshold"). Same threshold/bonus
  constants in `unit.js` (`ELEVATION_ADVANTAGE_THRESHOLD`,
  `ELEVATION_DAMAGE_BONUS`) — unchanged, since `groundHeight` is still
  just a Y position the tile system now sets differently underneath.
- **Melee blocked by elevation** (`isMeleeBlockedByElevation` in
  `tileTerrain.js`, replaces `blockedByCliff`): `attacker.level !==
  target.level`. Reasoning for why this reproduces old behavior exactly:
  the old system's blocking was really "are you at meaningfully different
  ABSOLUTE height right now," not "is a cliff conceptually between you" —
  a unit that climbed a gentle slope to matching height was never
  blocked, regardless of whether that slope belonged to a Hill or a
  Cliff's gentle side. Level equality reproduces this: a unit can only
  reach a tile matching its target's level by walking there (ramps allow
  it; sheer faces physically can't be stood on), so "blocked while levels
  differ" resolves itself the moment a reachable ramp lets an attacker
  climb to match — same outcome, simpler rule, and it required NO special
  case to distinguish "hill-sourced" from "cliff-sourced" elevation.

### pathfinding.js: zero changes needed

Confirmed and verified, not assumed: `pathfinding.js`'s A* and
string-pulling smoothing were already fully generic grid consumers (an
`isBlocked(x,z)` predicate in, waypoints out) — they never knew anything
about hills, cliffs, or forests. The tile grid's own walkability now feeds
that predicate directly (`isWorldWalkable` from `tileTerrain.js`); no
separate geometric sampling step is needed at all anymore (previously the
nav grid had to approximate continuous terrain via
`isPointBlockedByTerrain`). This is the clearest validation that "tiles
unify hills/cliffs" was the right call — the system genuinely got simpler,
not just visually different.

### Real bug found and fixed during this rewrite (not a design change)

Rewriting `test-pathfinding.mjs` for tile fixtures (using the REAL
`stampPlateau`/`stampForest` production functions, not hand-duplicated
geometry) surfaced a genuine latent bug in `smoothPath`'s line-clearance
check, `isLineClearOnGrid`: it sampled the candidate straight-line shortcut
at fixed intervals (`cellSize * 0.5`). A diagonal line can clip through a
single tile's corner with a footprint as narrow as ~0.25 world units —
smaller than that fixed interval — letting two consecutive samples land on
either side of the clip without either one ever landing inside it. Found
via two independent real cases during testing (a plateau's sheer corner,
and a forest tile's edge on a long diagonal segment), confirmed
mathematically (walked the exact interval where the line is inside the
blocking tile: 0.256 world units — narrower than any of several
progressively-tightened fixed sampling intervals tried).

**The real fix wasn't a smaller interval — no fixed interval can offer a
mathematical guarantee against an arbitrarily thin corner-clip.** Replaced
fixed-interval sampling entirely with an exact DDA (digital differential
analyzer) grid-traversal algorithm: instead of asking "is the obstacle
near these N sample points," it walks the exact sequence of grid cells the
segment geometrically passes through, in order, with a "supercover"
extension so a line crossing exactly through a shared corner point counts
as touching every cell that meets there (a unit can't thread a
single-point diagonal gap between two blocked tiles). This closes the
entire bug CLASS rather than reducing its probability, and is actually
cheaper than dense sampling (visits exactly the cells crossed, not a fixed
oversample count). Verified against 3000+ randomized-grid trials plus both
real regressions found, checked against brute-force ground truth every
time, before integrating into production. This is the same "genuinely
independent verification catches real bugs" discipline that caught the
original (different) smoothing bug years-of-conversation ago, now applied
to a tile-shaped version of the same underlying risk (a geometric
approximation disagreeing with ground truth in a thin edge case).

### Rendering architecture

- **Camera**: `THREE.OrthographicCamera`, fixed pitch/yaw
  (`CAMERA_PITCH`/`CAMERA_YAW` in `main.js`, ~35°/45°, classic dimetric
  RTS angle), rotation fully disabled via `OrbitControls.enableRotate =
  false`. Pan (remapped to left-drag) and zoom remain — the user wanted
  those kept, just not free rotation. `viewSize` (frustum half-height) is
  the zoom-level equivalent for an orthographic camera; resize handling
  recomputes the frustum from it, not just `updateProjectionMatrix()`
  alone.
- **Ground**: tiles render as `THREE.InstancedMesh` groups, one per
  `(kind, zone)` pair (`groundLowDefender`, `rampIntruder`, `sheer`,
  `forest`, `city`, etc. — see `TILE_KIND_STYLE` in `main.js`) — a large
  generated map can have thousands of tiles, so one draw call per tile
  would be wasteful. Deliberately simple placeholder geometry (flat boxes,
  a tall box for sheer walls) — real tile art drops in later by replacing
  `TILE_KIND_STYLE`'s geometry/material construction only; nothing about
  the tile DATA model changes for that.
- **Placement click raycasting**: raycasts against the actual tile
  InstancedMeshes (`clickableTileMeshes`), not a flat Y=0 plane — a flat
  plane would misresolve clicks on elevated plateaus (the ray would
  continue past the visual tile surface to wherever it hits Y=0, landing
  on the wrong tile). This correctly resolves clicks at each tile's true
  rendered height.
- **Units**: `Unit`'s body is now a `THREE.Sprite` (billboard) instead of
  a `THREE.Mesh` box — sprites auto-face the camera, which is why the old
  per-frame `faceHealthBarToCamera` step is gone entirely (health bar
  became two more sprites, parented to the body, billboarding for free).
  Placeholder texture: a simple canvas-drawn colored circle per unit type,
  cached (`getUnitTexture` in `unit.js`) — swap that one function for a
  real sprite-sheet loader when character art is sourced; nothing else
  needs to change. `facingAngle` is still tracked (atan2, same convention
  as the old `lookAt` calls) even though placeholder circles don't
  visually use it yet — ready for real directional sprite frames later.
  **All stats/combat methods in `unit.js` are byte-for-byte unchanged** —
  `UNIT_STATS`, `attackDamageAgainst`, `takeDamage`, `distanceTo`. Only
  rendering changed.
- **Collision resolution**: `resolveTerrainCollisions` in `main.js` is a
  genuine simplification over the old system — every non-walkable tile
  (sheer face, forest, city) is just an axis-aligned square now, so one
  unified circle-vs-square resolution handles all three cases, replacing
  separate segment-based (cliffs) and circle-based (forests) math.

### What was deliberately left for later (not started this round)

- Real tile art and character sprite sheets — user is sourcing these;
  architecture is ready to receive them (see above) but current visuals
  are intentionally simple placeholders.
- `src/assets.js` — GLB-loading infrastructure kept (cache/clone/progress
  callback are format-agnostic and reusable) but `MODEL_NAMES` emptied;
  not currently imported anywhere.
- Ground clutter (flowers/grass), hill/cliff rock decoration — removed
  along with the Kenney assets they depended on; not reintroduced with
  primitives since they'll be redone with real tile-appropriate assets
  anyway, and fake-placeholder clutter didn't seem worth the visual noise.
- Unit balance tuning, upgrade systems — explicitly a follow-on
  discussion once this rewrite is confirmed solid in real playtesting.
- `public/models/*.glb` (the 60 old Kenney files) — left on disk, unused;
  a cleanup candidate whenever the user wants, not deleted preemptively.

## Current gameplay design (medieval fantasy theme)

**Explicit stat model** (our shared vocabulary for balance discussions):
HP, **damage range** (min–max, rolled per hit), attack speed (hits/sec),
range, **armor** (flat damage reduction per hit, minimum 1 always gets
through), move speed, cost (gold, defenders only).

Melee units get a narrow damage range (consistent trades); ranged units get
a wide range (swingy — sometimes a plink, sometimes a big hit).

| Unit | HP | Damage | Atk Speed | Range | Armor | Move Speed | Cost |
|---|---|---|---|---|---|---|---|
| Knight (defender) | 150 | 12–16 | 1.0/s | 1.7 | 2 | 0 (stationary) | 3g |
| Archer (defender) | 50 | 6–20 | 1.2/s | 9 | 0 | 0 (stationary) | 2g |
| Raider (intruder) | 32 | 7–8 | 1.3/s | 1.3 | 0 | 3.6 | — |
| Catapult (intruder, defined but not yet used in Level 1) | 130 | 18–34 | 0.55/s | 6 | 2 | 1.1 | — |

Damage resolution order: roll a random value in [damageMin, damageMax],
apply elevation bonus multiplier, then subtract target's armor (min 1
damage always gets through).

**Starting gold**: 10 per level (Level 1) — history: 6 → 9 → 10 across
playtests. Note: an early version had a real bug where the on-screen gold
counter was hardcoded to "6" in the HTML and never re-initialized from
`STARTING_GOLD` in JS — fixed by setting `goldValue.textContent = gold`
right after declaring the `gold` variable in `main.js`. If gold ever looks
wrong again, check that line first before assuming it's a balance issue.

**Level 1 intruder wave**: 15 Raiders in 5 clusters of 3 (`CLUSTER_Z` /
`CLUSTER_OFFSETS` in `src/main.js`), spawning on flat ground on the intruder
side.

**Map size**: 36 x 22 (was 30 x 18) — `MAP_WIDTH` / `MAP_DEPTH` in
`src/main.js`. All terrain features and spawn positions were repositioned
for the new dimensions, not just left at old coordinates.

**Smoothing bug — a genuine methodology failure, worth understanding in
full.** After the physical-collision fix (above), a further report came in:
some intruders were still *planning* a route straight through the wall (not
just being physically stopped there — actually choosing that route), then
sitting stuck/jittering at the point the collision resolver blocked them.
Root cause: `smoothPath`'s obstacle check used to be a separate analytic
approximation (minimum of 4 endpoint-to-opposite-segment distances) rather
than checking against the same grid A* used to build the path. That
approximation has a real blind spot: a straight line crossing a wall's
*midpoint* while staying far from both of the wall's *endpoints* reads as
"clear" to it — proven with a concrete counterexample before fixing (see
`test-pathfinding.mjs`'s regression test). Smoothing would then "shortcut"
a correctly-routed zigzag path into a straight line that actually cut
through the wall. Fixed properly: `smoothPath(grid, path)` now samples the
straight line directly against the same nav grid cells A* itself used
(`isLineClearOnGrid` in `src/pathfinding.js`) — routing and smoothing now
share one source of truth and cannot disagree, by construction, not by
careful tuning of an approximation.

**A related, important lesson about the test suite itself**: the *first*
version of `test-pathfinding.mjs` verified smoothed paths using that same
flawed analytic approximation — meaning it checked the code's answer
against itself, not against ground truth, and structurally could not have
caught this bug no matter how many test cases were added. The fix wasn't
just patching the approximation; the test suite was rewritten to use a
genuinely independent, mathematically rigorous segment-segment distance
function (real line-intersection test, not a shortcut) so it can actually
catch disagreements between what production code does and what's
geometrically true, rather than rubber-stamping production's own logic.
This is now the standard the test file aims to hold: verification should
use a *different* implementation than the code being verified, wherever
practical.

**A second real bug found by the (now-fixed) test suite**: the physical
collision resolver's fallback direction (for the rare case where a unit's
position lands *exactly* on the wall line, distance zero) was hardcoded to
push in `+x`. That's only a valid escape direction for a north-south wall —
for Cliff 2 (east-west) it just slides the unit *along* the wall, still on
it. Fixed by computing the wall's true perpendicular direction from its own
segment vector instead of a fixed constant. The equivalent fallback for
forests (circles) does not have this bug — any direction escapes a circle
equally, so a hardcoded `+x` is fine there.

**Two cliffs now exist** (`CLIFFS` in `src/main.js`), deliberately in
different orientations for testing:
- **Cliff 1**: `face: "east"` (steep face runs north-south, a vertical
  wall), `zMin: 0, zMax: 10` — doubled in length from the original
  `zMin: 2, zMax: 7`.
- **Cliff 2**: `face: "south"` (steep face runs east-west, a horizontal
  wall — genuinely perpendicular to Cliff 1), in a separate part of the
  defender's zone (`xMin: -5.5, xMax: -0.5, zMin: -9, zMax: -4`), for
  playtesting a different approach/routing scenario.

All cliff-related code (`getCliffHeight`, `blockedByCliff`,
`isPointBlocked`, `resolveTerrainCollisions`, the cliff-face placement
exclusion) already iterated generically over `CLIFFS`, so supporting a
second cliff required no structural changes — only the fallback-direction
bug above needed fixing once a non-east/west-facing wall actually existed
to expose it.

**Cliff visual redesign** — was previously a shallow ramp (0.5-unit
transition) with a separately-rendered floating rock-face box that didn't
perfectly align with the actual terrain, causing a slight visual mismatch.
Now: `faceMargin` narrowed to 0.2 (steep face transitions within less than
one ground-mesh segment width, reading as near-vertical), `slopeMargin`
widened to 3.0 (smoother, more gradual ramp on the other three sides). The
standalone rock-face box mesh was removed entirely — the deformed ground
mesh plus its vertex coloring now renders the whole cliff (sheer face, flat
plateau top, gentle ramps) as one coherent surface instead of two
overlapping ones. This is a real two-level topology (a la Age of Empires
cliffs): flat low ground, flat high ground, connected by a wall on one side
and slopes on the other three.

**Physical collision guarantee** (`resolveTerrainCollisions()` /
`enforceTerrainCollisions()` in `src/main.js`) — real bug fix. A* controls
*routing*, but routing alone doesn't physically stop a unit from ending up
somewhere illegal if a *different* system moves it. Unit-unit separation
(below) has zero terrain awareness — with enough units crowding the cliff's
two narrow ends, allies shoving each other could push a unit's position
straight through the wall despite the path it was following being correct.
This is exactly what was observed ("some raiders walked through, not all" —
a crowding effect, not a universal pathing failure). Fix: every frame, for
every mobile unit, after all other position updates (path movement,
separation), `resolveTerrainCollisions()` checks whether the unit's actual
position has ended up inside a forest's or the cliff's clearance zone and
pushes it back out — a hard constraint enforced regardless of *why* the
position became invalid, not a pathfinding preference. Verified with a
dedicated stress test in `test-pathfinding.mjs` (forces a unit to worst-case
positions including exactly on the wall's centerline, confirms it's always
pushed back to full clearance) — this stress test is what caught the
fallback-direction bug above once Cliff 2 existed to expose it.

**Placement also respects the cliff face** — defenders could previously be
placed directly inside the wall's clearance band (only forests and the city
were excluded). Fixed with the same `pointToSegmentDist` check used
elsewhere, alongside the existing forest/city exclusions.

**Navigation / pathfinding** (`src/pathfinding.js`) — this replaced an
entire prior system, not a patch on top of it. History: reactive
"push-away-from-obstacles" steering worked fine for forests but never
reliably worked for the cliff across three attempted fixes (tangential
steering, then a deterministic waypoint hack, then that hack breaking once
target-locking changed unit behavior). Rather than attempt a fourth patch,
it was replaced outright with real A* pathfinding:
- `buildNavGrid()` rasterizes the map into cells (`NAV_CELL_SIZE = 0.6` in
  `src/main.js`), each marked blocked or open via a caller-supplied
  `isPointBlocked(x, z)` predicate — forests (circle) and the cliff's steep
  face (segment), each with `NAV_CLEARANCE = 1.0` buffer. Built once at
  startup; terrain is static.
- `findPath()` is a standard 8-directional A* with corner-cutting
  prevention (won't let a diagonal move clip through two orthogonally
  blocked cells) and a hard iteration cap as a safety net against runaway
  search. Snaps a blocked start *or* goal cell to the nearest open cell —
  both directions matter; only handling a blocked goal was a real bug caught
  by the test suite (see below) before shipping.
- `smoothPath()` does string-pulling: greedily replaces runs of grid
  waypoints with a single straight hop wherever a direct line is provably
  clear, so paths look natural instead of following grid lines.
- Since **defenders never move**, a path is computed once per
  (intruder, target) pair when the target is acquired (`followPathToward()`
  in `src/main.js`) and simply followed — no per-frame recomputation needed.
  This is why performance is a non-issue despite full A* search.
- The old reactive system (`computeSteerDirection`, cliff waypoint hack) was
  deleted entirely, not left in place as a fallback — verified via a repo
  grep with zero hits before shipping.

**Testing**: `test-pathfinding.mjs` (repo root, run with `node
test-pathfinding.mjs`) is a standalone Node test — the pathfinding module
has no Three.js/browser dependency, so it's tested directly against the
exact same obstacle data as `src/main.js`, without needing a browser. It
checks: paths exist and are genuinely obstacle-free (verified via the same
`isSegmentBlocked` used for smoothing, not just "did A* return something");
a cliff-blocked case actually detours (>=3 waypoints, not a near-straight
line) and visibly routes around one of the wall's two ends; a blocked-start
edge case (unit position inside an obstacle's clearance zone) doesn't
degenerate to a straight line through the obstacle — this caught the goal-
vs-start asymmetry bug mentioned above; a full matrix of all 15 real
Level 1 spawn points against 4 realistic defender placements (60 combos)
all produce valid, obstacle-clear paths; and a collision-resolution stress
test that forces a unit to worst-case positions (including exactly on the
wall's centerline) and confirms `resolveTerrainCollisions()`'s math always
restores full clearance — added after the "some raiders walked through the
wall" bug, which pure pathfinding tests couldn't have caught since the bug
wasn't in pathfinding at all. Run this test after any change to `CLIFFS`,
`FORESTS`, or the pathfinding/collision code, before assuming routing or
physical safety still works.

**Distance is horizontal-only** — `Unit.distanceTo` was changed from full
3D distance to x/z-only. Elevation effects are handled entirely by the
dedicated damage-bonus and cliff-block logic; folding height into range
checks as well was an unintended side effect of using
`THREE.Vector3.distanceTo` and made range checks harder to reason about
across elevation.

**Target locking / focus fire** (`unit.target` in `src/unit.js`,
consumed in `updateBattle` in `src/main.js`) — each unit locks onto a target
once acquired and keeps attacking/chasing it until it dies
(`!unit.target || !unit.target.alive` is the only re-acquisition trigger),
rather than re-picking "nearest enemy" every frame. This fixed two problems
that shared one root cause: visible jitter (facing/movement flickering when
two enemies were similarly close) and defenders spreading damage across many
attackers instead of finishing one off. It was also a hidden contributor to
the cliff pathing failures — constant target-switching meant the old
reactive steering's seek direction never stabilized, which is part of why
that system never worked reliably regardless of how the avoidance math was
tuned.

**Terrain is a core strategic layer**, not decoration. Two distinct
elevation features exist:

- **Hills** — smooth, walkable from every direction, purely additive height.
  Attacking from meaningfully higher ground deals +30% damage
  (`ELEVATION_ADVANTAGE_THRESHOLD` / `ELEVATION_DAMAGE_BONUS` in
  `src/unit.js`). Applies whether the height comes from a Hill or a Cliff
  plateau — it's based on total terrain height.
- **Cliffs** (`CLIFFS` in `src/main.js`, now two — see above) — raised
  plateaus that are steep and *impassable* on exactly one designated face
  (narrow `faceMargin`) and have gentle, walkable slopes on the other three
  sides (wide `slopeMargin`). Optional features — place a defender on/behind
  one and intruders targeting that defender path around the steep face via
  real A* (see Navigation below), with the physical collision guarantee
  (above) ensuring they can never actually clip through it regardless of
  crowding. Ranged units can damage across the steep face; melee units
  cannot engage across it at all (`blockedByCliff()`, driven by
  `getCliffHeight` in isolation so this rule never fires from Hills).
- **Forests** — circular impassable obstacle clusters. Two forest patches
  with a gap between them create the main (mandatory) chokepoint.

**Steering / pathfinding** (`computeSteerDirection` in `src/main.js`) — this
went through a real bug fix. The original approach only pushed units
radially away from an obstacle's center/face. That's a known failure mode:
when the direct path to the target is blocked, a pure "push away" vector can
point almost directly opposite the seek direction, the two nearly cancel,
and the unit just sits there vibrating against the wall instead of routing
around it — this is exactly what happened with the first cliff placement.
The fix adds a **tangential** (sliding) component for both forests (circle)
and the cliff's steep face (short segment): of the two perpendicular
directions available at any obstacle, the one that better aligns with the
seek direction is blended in more strongly than the radial push, so units
actively slide along an obstacle's edge toward whichever side still makes
progress, rather than just bouncing off it. Still a reactive heuristic, not
real pathfinding (A* etc.) — good enough for our current obstacle count and
shapes (circles + a couple of short segments), but would need revisiting if
future levels have more complex or maze-like obstacle layouts.

**Unit-unit separation / no stacking** (`updateSeparation()` in
`src/main.js`) — each unit has a `collisionRadius` derived from its box size
(`src/unit.js`). Every frame, mobile units get nudged apart from anything
(ally, enemy, or stationary defender) they're overlapping, proportional to
the overlap amount. Stationary defenders exert this push on others but are
never displaced themselves — they hold their exact placed position. This is
also what makes several attackers spread out around one target into a rough
arc instead of piling into the same point: the seek force pulls them toward
the target, separation pushes them apart, and the two balance out into a
natural-looking cluster. Applied every frame regardless of phase (not just
during battle) so idle units don't overlap during Scouting/Placement either.

**Floating damage numbers** (`spawnDamageNumber` / `updateDamageNumbers` in
`src/main.js`) — appear above the **attacker** (not the target being hit) —
that was a deliberate placement change. Every hit (melee or projectile)
goes through a single `applyDamage(attacker, target, amount)` function that
handles the health reduction, spawns the floating number at the attacker's
position, and triggers death-fade if it was lethal. Centralizing damage
through one function was a deliberate refactor — previously melee and
projectile hits each applied damage independently.

**The city being defended** is rendered (`createCity()` in `src/main.js`) —
a small cluster of primitive box-and-cone buildings at the back of defender
territory (`CITY_ZONE`). Currently **purely visual** — win/loss is still
"wipe out one side's units," not "intruders reach the city." Placement is
blocked inside `CITY_ZONE`. Turning the city into an actual objective is a
natural future step, flagged but not implemented.

## Future directions discussed (status updated as work landed)
- ~~Random level layouts~~ — **implemented** (`levelGenerator.js`, see
  above). Reachability validation via the A* pathfinder was indeed reused
  directly as the generation-time safety net, as anticipated here.
- ~~Real art assets~~ — **implemented** (Kenney.nl environment pack, glTF,
  `assets.js`). Environment-only scope held as anticipated; unit/character
  models remain primitives (no such assets were provided).

### Roadmap discussion: what's missing for a "nice, indie-but-serious RTS"
Asked directly by the user; captured here for continuity. Organized by
what's likely to matter most for THIS game's genre specifically (a
wave-defense autobattler — no direct unit control during battle, so
classic RTS concerns like formation control or fog of war don't apply the
same way they would in a traditional RTS):

**Game feel / "juice"** (cheap, high impact, do these before bigger systems):
- Hit feedback beyond the floating damage number — a brief flash/scale-pop
  on the unit taking damage, a small particle burst on death instead of
  just the current fade-out.
- Sound: hit/attack sounds, footsteps or ambient, a distinct win/lose
  sting, background music. Currently completely silent — probably the
  single biggest missing "juice" item.
- Camera: a subtle shake on big hits or death clusters; consider auto-
  framing toward the most active fight during battle rather than a fully
  static overview.

**Systems depth** (bigger investment, genuine gameplay additions):
- **Progression across levels** — right now every level uses the same
  fixed raider count (20) and gold (14). A real campaign structure
  (increasing raider counts/composition per level, a currency that
  persists or upgrades between levels, unlocking new unit types) is
  probably the single biggest thing separating "tech demo" from "game."
- **More unit variety** — `Catapult` is fully implemented in `UNIT_STATS`
  but has never been used in an actual level. A second intruder type
  alone would meaningfully increase tactical variety (forces ranged
  defenders to reconsider positioning, since a Catapult can hit back at
  range). Similarly, only two defender types exist.
- **The city as a real objective** — flagged repeatedly across previous
  rounds and still purely visual. Turning it into an actual failure
  condition (intruders reaching it, or it having its own health) would
  meaningfully change the strategic calculus (a leaky flank matters even
  if your defenders are individually winning their fights).

**Polish / UX**:
- A proper main menu / level-select rather than jumping straight into a
  single generated level on load.
- Some indication of *why* a battle was lost (which flank fell, how close
  it was) rather than just a binary result banner.
- A pause/speed-control during battle (the genre convention for
  autobattlers is often 1x/2x/skip-to-result).

**Not recommended to prioritize** for this genre specifically: minimap
(single-screen battles, low value), unit selection/control UI (the game's
whole premise is placement-then-watch, adding control would change the
genre), fog of war (nothing is hidden in this game's design).

## Open questions / things to playtest next
- **Real playtest of combat now that Knights can actually attack** — the
  top-priority item. The critical regression (round 5) is fixed and
  verified via direct health/kill-count measurement in a real battle, but
  that was one scripted scenario (defenders placed near the chokepoint).
  Watch general play for: does combat feel appropriately paced now that
  Knights actually fight, does the "sliding" symptom look fully gone in
  every scenario (not just the one tested), does the 8-slots-per-Knight
  crowd look reasonable once units are actually landing hits and dying
  (visual crowd-thinning wasn't verifiable before since nothing was dying).
- Previous entries (arrival-time reservation feel, stuck-watchdog
  frequency) remain relevant but are now secondary to confirming the core
  attack loop itself, which was completely broken until this round.
- Terrain generation was substantially reworked (domain warping + regional
  amplitude + nonlinear shaping) — verified performant and statistically
  reasonable, and visually confirmed richer via screenshots, but not yet
  played across many hours/seeds. Watch whether it still feels natural
  rather than chaotic once seen extensively, and whether `shapePower`/
  `warpStrength`/amplitude ranges need tuning.
- The city building position bug (found in round 3) is a reminder to
  double check: are there other decoration functions still assuming fixed
  coordinates from before procedural generation? `decorateHills`,
  `decorateCliffs`, `decorateGroundScatter` were all reviewed and already
  correctly reference the dynamic `HILLS`/`CLIFFS`/`MAP_WIDTH`/`MAP_DEPTH`
  — but worth a fresh look if any other "things look wrong" reports come
  in, since this bug class (correct data, stale hardcoded rendering) isn't
  caught by structural tests, only by actually looking.
- Defender leash radius (4.5) and move speed (2.0) are first-guess
  numbers, not yet tuned from feedback — may need adjustment once seen in
  actual play (too aggressive vs. too passive).
- Multiple defenders whose leashes overlap onto the same target don't
  coordinate via the slot system (documented scope limit, not a bug) —
  watch for minor visual overlap in that specific scenario.
- New map layout (75/25 split, corner-placed city, defender-biased
  forests, ~25% smaller) — verified structurally via `test-generator.mjs`
  and now visually via screenshots (city, forest bias, and border split
  all confirmed rendering correctly). Watch whether 75/25 feels like
  enough room in extended play.
- Battle pacing on large generated maps may be slower (more travel
  distance for raiders at the same move speed) — confirmed via screenshots
  this round to be genuine pacing, not a stalemate, but still worth a
  balance look if it feels sluggish over a full playthrough.
- Tree scale (4.6x) and ground clutter density (now 0.052/unit²) were
  tuned from feedback on a specific previous map — may need re-tuning
  again now that both map size AND the defender/intruder split changed.
- Rocks on hills still look "half-buried and randomly scattered" —
  explicitly deferred multiple rounds now, not forgotten.
- Knight armor 4→2, Archer range 7→9, 15→20 intruders across earlier
  rounds — several difficulty-relevant changes bundled over time; hard to
  isolate which matters most without dedicated balance-focused playtesting.
- City is visual-only — decide whether it should become an actual objective.
- Rejection-sampling placement (hills/cliffs/forests) uses bounding-circle
  approximations for spacing, not exact shapes — acceptable since
  reachability validation is the real correctness guarantee, but could
  occasionally produce slightly awkward-looking adjacent features. Watch
  for this across a few generated seeds.

## Targeting fix: path-cost-aware acquisition + reactive aggro

Real bug from playtesting: mobile units picked targets by straight-line
distance (`findNearestEnemy`), which is a poor proxy for actual reachability
once terrain is involved — a defender that's "nearest on paper" can require
a long detour, while a defender the unit would walk straight past (and take
damage from, independently, since that defender has its own separate
target-lock) might be far cheaper to actually reach. Observed as raiders
"running past" a defender that's hitting them just to reach a supposedly-
closer defender that actually needed a much longer route.

Two complementary fixes, both scoped to **mobile units only** (defenders
never move, so straight-line "nearest" remains correct and cheap for them —
`findNearestEnemy` is still used there):

1. **`pickTargetByPathCost`** — picks a target by real A* path length
   instead of straight-line distance, and returns the already-computed
   path so it's cached directly (`unit.path`/`unit.pathTarget` set
   immediately on acquisition — `followPathToward`'s cache-check means it
   won't be redundantly recomputed next frame). **Performance**: comparing
   every possible target with a full A* search doesn't scale — measured
   ~300ms stutter with 20 units x 7 defenders (140 simultaneous searches)
   at battle start. Fixed by only running the real path search against the
   nearest `PATH_COST_CANDIDATE_LIMIT` (3) candidates by cheap straight-line
   distance first — the globally cheapest-by-path target is virtually
   always among the nearest few by raw distance in practice. Reduced
   measured worst case to ~106ms (`node /tmp/perf-test.mjs`-style
   methodology, not a permanent test file since it's a performance
   characteristic, not correctness). This is a one-time cost at battle
   start (target acquisition), not a per-frame cost.
2. **Reactive aggro** (`applyDamage` in `src/main.js`) — a mobile unit that
   takes a hit from someone other than its current locked target
   immediately switches to fighting back (clears `target`/`path`/
   `pathTarget`, next frame re-evaluates). This was the user's own
   suggestion and catches remaining edge cases the path-cost fix alone
   wouldn't (e.g. a defender placed after a unit already started moving).
   Scoped to mobile units only, matching the pathing rationale above.

**Known remaining gap, not yet fixed**: defenders lock onto a target and
never re-evaluate until it dies, even if that target wanders far out of
range and never returns (defenders are stationary, so once `!canEngage`
they just wait — forever, if their target never comes back). Not observed
as a problem in practice yet since intruders reliably advance toward
defenders, but worth knowing about.

## Visual tuning from first playtest of real assets
- `TREE_SCALE` doubled to 4.6 (was 2.3) — first pass was too small.
- `GROUND_CLUTTER_DENSITY` (items per square unit of defender-side ground,
  in `decorateGroundScatter`) replaces the old fixed `TARGET_COUNT = 50` —
  now computed from `MAP_WIDTH`/`MAP_DEPTH` so it scales automatically if
  the map size changes again, per explicit request. Set to 0.045, giving
  ~31 items on the current 46x30 map (down from the fixed 50 — user felt it
  was slightly too dense).
- City fence now leaves a `GATE_HALF_WIDTH = 1.2` gap at z=0 where the path
  passes through, instead of the path awkwardly running through/past solid
  fence posts. Rocks on hills were noted as "half-buried and scattered
  randomly" — explicitly deferred per user request ("let's not make this
  detail perfect right now"), not fixed.

## Combat mechanics round 5: critical regression — Knights couldn't attack at all

A severe regression, introduced by round 4's arrival-time reservation
redesign and shipped without being caught. Full honesty about how it
happened and what changed to stop it happening again silently.

### The bug
Round 4 correctly scoped slot *reservation* to mobile melee units only
(`!unit.stats.ranged && !unit.stats.stationary`) — stationary defenders
never attempt it, since they don't move to reach a slot. But the
**engagement check** that determines whether a unit can actually attack
was written as:

```js
const hasUsableSlot = unit.stats.ranged || slotIndex !== null;
```

This only exempts *ranged* units from needing a slot. A stationary melee
unit (Knight) is neither ranged nor ever holds a slot (it never attempts
reservation), so `hasUsableSlot` was **permanently false** for every
Knight, making `canEngage` permanently false, making Knights **unable to
attack under any circumstance**. Since `canEngage` was always false, the
code fell into the "not engaging" branch every frame, which for stationary
units calls `advanceDefenderWithinLeash` — repeatedly trying to "step
closer" to a target it was often already standing directly next to. That's
exactly what was reported: Knights sliding toward raiders and never
swinging.

### Why this wasn't caught before shipping
Round 4's verification measured **raider movement** (average distance to
nearest defender, decreasing monotonically) as proof the arrival-timing
fix worked — which it did, correctly. But that measurement said nothing
about whether defenders were successfully *attacking* once raiders
arrived. The gap: verifying one half of a two-sided interaction isn't the
same as verifying the interaction. Direct lesson, applied below: measure
the actual thing being fixed, not a plausible-sounding adjacent proxy.

### The fix
```js
const hasUsableSlot = ranged || stationary || hasSlot;
```
A unit can engage without holding a slot if it's ranged (never competes
for slots) **or stationary** (never moves to reach one, so slot
availability is irrelevant to attacking something already adjacent). Only
a mobile melee unit actually needs a held slot.

### The actual best-practices fix: this logic is no longer untestable
The deeper problem wasn't just the missing `stationary` check — it's that
this decision lived inline in a ~150-line per-frame combat loop with zero
direct test coverage, so a one-line mistake shipped silently. Fixed
properly, not just patched: **`computeCanEngage({ ranged, stationary,
withinRange, cliffBlocked, hasSlot })`** is now a pure, exported function
in `meleeSlots.js` (no Three.js/game-object dependency), imported into
`main.js`'s combat loop rather than computed inline. `test-melee-slots.mjs`
gained exhaustive coverage of all four `(ranged × stationary)` unit-type
combinations against every relevant scenario (in range/out of range,
cliff-blocked, with/without a slot) — 10 new assertions covering exactly
the matrix that this bug lived in.

**This test's power was proven, not assumed**: the exact bug was
temporarily reintroduced (`hasUsableSlot = ranged || hasSlot`, the buggy
version) and the test suite was re-run — it failed immediately, precisely
on the Knight case. The fix was then restored and the suite re-ran clean.
This confirms the test is a genuine regression guard, not a tautological
check that would pass against whatever the code happens to do.

### Live verification: direct combat-outcome measurement
Following the same principle (measure the actual thing, not a proxy), a
temporary debug hook (`window.__debugStats`, confirmed removed via `grep`
before final build — same pattern as round 4's verification) was used to
directly read total health and alive-counts on both sides during a real
headless-browser battle with defenders placed near the chokepoint:

```
t=0s:  defenders hp=600, intruders hp=640, intruders alive=20
t=21s: intruder hp starts dropping (627) — combat has begun
t=24s: defender hp starts dropping (579) — raiders landing hits too
t=33s: FIRST INTRUDER DEATH — intruders alive: 20 → 19
t=48s: intruders alive=16, defenders alive=4 (hp=290)
t=60s: intruders alive=16, defenders alive=3 (hp=132)
```

Both sides trading health and taking casualties over time — exactly what
working combat looks like. This is the direct proof the previous round's
verification was missing: not "are raiders approaching" but "is anyone
actually landing hits."

## Combat mechanics round 4: reservation timing redesign (the actual fix)

Round 3's stuck-detection watchdog was a real, valid safety net, but the
user's follow-up report revealed the deeper issue it was papering over:
**slots were being reserved at target-selection time, not arrival time.**
The moment a mobile melee unit picked a target, it immediately tried to
hold a slot on it — while potentially still far away, just starting its
walk. This was wrong in a way that explains all four symptoms reported:

1. **Raiders idle at battle start when spots were scarce** — a unit with
   no slot available used to just stand still (`isMeleeAndNoSlot` blocked
   movement entirely, not just attacking). With only 3 defenders and 20
   raiders, most units simply never got a slot and froze at spawn.
2. **Raiders running past defenders they arrived at first** — a slot could
   be claimed and *held* by a unit that was still minutes of walking away,
   starving a genuinely closer unit of capacity it should have gotten.
3. **Raiders pathing toward a defender's old position** — a separate,
   real issue (defenders can now move slightly via guard mobility) that
   compounds the above: a cached A* path doesn't know its destination has
   moved.

### The fix: reservation moved to arrival, not selection
- **Target selection is unified and simplified back to pure path-cost
  picking** (`pickTargetByPathCost`) for *all* mobile units, melee and
  ranged alike — slot-awareness was removed from selection entirely, since
  by the time a unit several seconds away from its target actually
  arrives, "does it have room right now" information gathered at pick time
  is stale anyway. (The melee-specific `pickMeleeTarget` variant from round
  2/3, along with `hasFreeMeleeSlot`, was removed — dead code once
  selection stopped needing slot awareness.)
- **`ARRIVAL_RESERVE_DISTANCE = 2.0`** — a mobile melee unit only attempts
  `reserveMeleeSlot` once it's within this distance of its target (chosen
  to comfortably exceed `MELEE_RING_MAX_RADIUS`, so a unit is never still
  "just approaching" once already within its own attack range). Before
  that distance, it has no slot and is not blocked by that — it just walks
  straight toward the target's raw position via the normal A* system,
  exactly like a ranged unit does. This is the actual fix for symptom 1:
  there is no longer any state in which a mobile melee unit stands still
  because a slot isn't available — "no slot yet" and "still approaching"
  are now the same thing, not "no slot, so don't move."
- **Rejection-on-arrival triggers immediate retargeting, not idling.** If
  reservation fails once genuinely close (the ring filled up by the time
  this unit got there), the unit doesn't wait — it immediately picks a
  different target and starts walking there. `unit.avoidTarget` /
  `unit.avoidTimer` (3 seconds) temporarily exclude the just-rejected
  target from reselection so it doesn't just immediately re-pick the same
  full one (fullness is transient, unlike a geometrically bad slot from
  the stuck-watchdog's blacklist, so this is a short timer, not permanent).
  `pickTargetByPathCost` falls back to including the avoided target anyway
  if excluding it would leave zero candidates (e.g. only one defender
  exists) — a unit always has *something* to walk toward.
- **Path staleness fix**: `followPathToward` now tracks `unit.pathDestPos`
  (the position the cached path was actually computed toward) and
  recomputes if the live destination (`enemy.mesh.position` or, once a
  slot is held, the live slot position) has drifted more than
  `REPATH_DRIFT_THRESHOLD` (1.5 units) — this is what makes chasing a
  target that can itself move (a defender using its guard-mobility leash)
  actually correct, rather than walking toward a memory of where it used
  to be. **Recommendation on defender mobility**: keep it. This was a
  solvable pathing problem, not a fundamental conflict with the feature,
  and it's now solved with a standard technique (periodic re-pathing on
  target drift) rather than by removing the mobility feature.
- **`STUCK_TIMEOUT` reduced 3.0 → 2.0 seconds**, per explicit request.
- **Slot capacity increased** — `MELEE_ATTACKER_RADIUS_ESTIMATE` tightened
  0.6 → 0.4, per explicit request ("increase spots per defender"). For a
  Knight-sized target this increases capacity from 5 to 8 slots (~60%
  more), verified directly in `test-melee-slots.mjs`.

### On whether the slot system itself was the right approach
Asked directly by the user; answered directly here for the record: **yes,
keep building on it.** Every symptom reported traced back to *when*
reservation happened, not to the underlying idea of "attackers claim
individual positions around a target instead of reactively fighting for
space." That idea remains the standard, correct approach used by serious
RTS/action games for this exact problem — reactive/emergent crowd
positioning (the pre-slot-system approach) was the thing that produced
visible jitter in the first place, several rounds ago. Moving reservation
to arrival time, letting units always move regardless of slot status, and
handling rejection via immediate retargeting are all standard refinements
to the same core pattern, not a different pattern.

### Verification — direct measurement, not visual guesswork
Initial visual (screenshot) verification was ambiguous: on a large
randomly-generated map, raider movement over 10 seconds is a small
fraction of the total distance and hard to judge by eye across screenshots
at the same zoom level. Rather than trust an inconclusive visual check, a
**temporary debug hook** (`window.__debugStats()`, exposed only for this
verification and confirmed fully removed afterward via `grep` before
rebuilding) was added to read real unit positions directly from the live
Three.js scene. A real headless-browser battle was run with 3 defenders
placed, sampling every 3 seconds for 30 seconds:

```
t=0s:  avgDistToNearestDefender=58.7
t=3s:  57.7    t=15s: 53.9    t=27s: 50.2
t=6s:  56.7    t=18s: 53.1    t=30s: 49.2
t=9s:  55.7    t=21s: 52.1
t=12s: 54.9    t=24s: 51.1
```

Monotonically decreasing across all 11 samples, never stalling, never
reversing — direct, unambiguous proof that raiders are continuously
closing distance on defenders, not idling. This is stronger evidence than
either the earlier screenshot comparisons or the stuck-watchdog's
mathematical proof (round 3) — it measures the actual reported symptom
directly rather than a proxy for it. Worth remembering this technique
(temporary, explicitly-removed debug instrumentation exposed to the page
for direct measurement) for future cases where visual/screenshot
verification alone is inconclusive.

## Combat mechanics round 3: general stuck-detection watchdog, real city bug, richer terrain

### "This must never happen" — replacing point-fixes with a category-level guarantee
After the ring-radius fix (round 2), the user reported the stale-raider
symptom still occurred, rarer and harder to reproduce. Correct diagnosis:
the ring-radius bug was *one specific cause* of "arrived somewhere and
can't act," not the only possible one (a plausible other cause: a slot
that's geometrically close to a target by raw distance but separated by a
cliff's elevation boundary in some awkward edge case near the transition
zone). Rather than hunt for and patch each individual cause, this round
replaced the narrow `SLOT_WAIT_TIMEOUT` mechanism entirely with a **general
stuck-detection watchdog** — standard practice in real-time game AI:

`updateStuckWatchdog(unit, isProgressing, delta)` in `src/main.js` tracks,
on a ~1-second interval (not every frame, to avoid false positives from
ordinary movement noise), whether a mobile melee unit is either actively
fighting OR has meaningfully changed position since the last check. If
neither has been true for `STUCK_TIMEOUT` (3s), the specific cause doesn't
matter — the unit is forced back to a known-good state: target/path/slot
all cleared, ready to re-acquire completely fresh next frame. This
subsumes the old slot-wait-specific safety net (which only caught one
cause) with something that catches *any* cause, including ones not yet
identified.

**Slot blacklisting**: when the watchdog fires, it also permanently adds
the specific slot index the unit was stuck on to `target.blacklistedSlots`
(a `Set`, lazily created alongside the slot ring) — not the whole target,
since the target itself may be perfectly valid and only this one specific
slot position is problematic. Without this, a naive "just clear the
target and try again" reset could cycle: stuck → reset → same target still
cheapest by path cost → same slot reassigned (nothing else changed) →
stuck again. Blacklisted slots are treated as permanently occupied by both
`hasFreeMeleeSlot` (target selection) and `reserveMeleeSlot` (assignment),
so a future attempt on that target is guaranteed to get a *different* slot.
No expiry — geometry doesn't change mid-level, so a slot that's
geometrically bad stays bad.

### A real bug in the city, found via visual screenshot inspection
While verifying the map/terrain changes below, screenshots revealed the
city's buildings rendering nowhere near the actual generated `CITY_ZONE` —
floating at fixed, old coordinates regardless of map size or the city's
corner placement. Root cause: `createCity()`'s building positions were
still hardcoded absolute world coordinates (`{x: -22, z: 0}` etc.) from
before the city became procedurally positioned. This is the exact same bug
class fixed in `decorateCityBoundary()` last round (hardcoded z=0
assumption breaking once the city corner-shifted) — that fix should have
prompted checking `createCity()` too, and didn't; worth remembering that
one hardcoded-position bug found is a signal to grep for siblings, not
just fix the one instance.

Fixed by expressing building positions as **fractions of the actual
`CITY_ZONE` bounds** (`CITY_BUILDING_LAYOUT`, `{fx, fz}` in 0..1 across
xMin..xMax / zMin..zMax) rather than absolute coordinates — positions now
scale and relocate correctly with the zone regardless of map size or
corner. Building *dimensions* stay absolute (structures should stay
human/building-scale regardless of overall map size; only position should
be zone-relative). Verified visually: screenshots before the fix showed
buildings inset deep into the map, disconnected from the true edge;
after, consistently right at the true west edge in the corner, exactly as
`CITY_ZONE`'s data always said it should be — the *data* was correct even
while the *rendering* was silently wrong, a good reminder that structural
tests (like `test-generator.mjs`'s city-placement checks, which were
passing the whole time) can't catch a rendering-layer bug like this one;
only actually looking at it can.

### City pushed to a genuine corner (explicit request)
`cityCornerSign`/`cityZCenter` in `levelGenerator.js` now computes the Z
position as close to the true map edge as the city's own footprint allows
(`mapDepth * 0.5 - cityHalfDepth - small margin`), rather than the
previous `mapDepth * 0.32` (noticeably short of the actual edge). Combined
with the city-building fix above, this is now visually confirmed via
screenshots to read clearly as "in a corner, at the back," not merely
off-center.

### Richer, more varied ambient terrain (explicit request: "no more than
50% of the map totally flat," better slope character, best-practice
topology generation)
The previous single-layer fbm noise (round 1) produced uniform, fairly
subtle bumpiness everywhere — technically "natural" but not visually
varied. Replaced with three standard procedural-terrain techniques
layered together in `levelGenerator.js`'s ambient noise setup:

1. **Domain warping** — the detail noise's own (x,z) input coordinates are
   distorted by a second, independent noise field (`warpFbm`) before
   sampling. Raw Perlin/fbm noise alone produces mechanical, evenly-spaced
   bumps; warping the input coordinates first makes ridges and valleys
   curve and flow organically, the way real terrain does, rather than
   reading as "obviously generated."
2. **Regional amplitude modulation** — a third, much-lower-frequency noise
   layer (`regionFbm`) scales how strong the detail noise is allowed to be
   at any given point (`localAmplitude = baseAmplitude * (0.05 + region *
   1.6)`). This is what produces genuine flat/hilly *contrast* across the
   map — broad calm regions alongside broad rugged ones — rather than
   gentle bumps smeared evenly everywhere, directly addressing "no more
   than 50% totally flat" as a broad landscape character, not just a
   uniform texture.
3. **Mild nonlinear shaping** — `Math.sign(n) * Math.pow(Math.abs(n),
   shapePower)` (power 0.8-1.05) on the signed detail noise, biasing the
   height distribution toward flatter low ground with steeper transitions
   instead of the smooth symmetric curve raw noise produces on its own —
   reads as more varied slope character (some gentle, some steep).

**Verified three ways**: (1) performance — measured directly (not assumed):
~28ms one-time cost for an entire 20,000-vertex ground mesh despite 4x the
noise evaluations per query, and ~0.015ms/frame in gameplay (units calling
`getTerrainHeight` every frame) — both negligible against any reasonable
budget. (2) Statistical flatness check across 5 seeds: 30-59% of sampled
points read as "near-flat" (<0.1 units), landing close to the requested
guideline — explicitly a statistical tendency of the noise design, not a
hard per-seed guarantee, and documented as such in code comments, since the
user's own framing ("I would say that it is reasonable") was a soft
guideline, not a strict requirement. (3) Visual — screenshots after the
change show clearly more varied terrain (distinct hill-like mounds with
rock-tinted higher ground) compared to the flatter look before.

## Combat mechanics round 2: stalemate bug, irrational aggro-switching, defender mobility

### Raiders getting stuck right next to a defender, never attacking
A genuine math bug in the attack-slot system, found by tracing through the
exact geometry: `computeSlotRing`'s ring radius (`target.collisionRadius +
MELEE_ATTACKER_RADIUS_ESTIMATE + 0.15`) was never checked against the
attacker's actual `range` stat. For a Raider (range 1.3) attacking a Knight
(collisionRadius ~0.75), the ring came out to ~1.5 — **larger than the
Raider could actually reach**. A raider would dutifully walk to its
assigned slot, arrive, and then sit there forever unable to attack, because
it was technically just outside its own range — exactly matching "stuck
right next to the defender... without attacking," and explaining why it
could cascade into a full stalemate if it happened to every melee attacker
on a target.

Fixed with `MELEE_RING_MAX_RADIUS` (`UNIT_STATS.raider.range - 0.1`,
i.e. 1.2) — `computeSlotRing` now accepts an optional `maxRadius` and
recomputes slot *count* against the capped radius too (not the original
uncapped one, which would otherwise pack slots too tightly for the smaller
actual ring). There's an inherent tension worth documenting: the sum of a
Knight's and Raider's collision radii (~1.27) is almost exactly equal to
the Raider's raw range (1.3) — meaning "always in range" and "zero visual
overlap during melee" can't both be fully satisfied with current unit
sizes. This deliberately prioritizes functional correctness (being able to
actually attack) over eliminating minor visual overlap during contact,
which is a common, accepted compromise in this genre.

**Verified two ways**: (1) a new regression test in `test-melee-slots.mjs`
that reproduces the bug mathematically (proves the uncapped ring exceeds
Raider range) and proves the fix (capped ring radius 1.2 < range 1.3,
slot count correctly recomputed against the capped radius, not stale).
(2) Real screenshots taken via headless Chrome at t=3s/30s/60s into a
live battle — raider clusters visibly shrink and disappear over time while
the defender cluster stays active, direct visual evidence combat
progresses normally rather than stalling. (A 90-second "still in Battle
phase" run without full completion, observed while investigating this, was
confirmed via the screenshots to be normal large-map travel-time pacing —
already a documented characteristic — not the stalemate bug; worth noting
because it initially looked concerning before the visual check clarified it.)

A related latent bug fixed while diagnosing this: slot reservation was
being attempted for **all** non-ranged units, including stationary melee
defenders (Knights) — but a stationary unit never moves to reach a slot,
so slot unavailability could theoretically block it from attacking
something already in range, for no reason (slots only matter for units
that have to walk somewhere). Scoped slot reservation to
`!unit.stats.ranged && !unit.stats.stationary`.

### Reactive aggro switching away from an active melee fight
User feedback: a raider actively fighting a Knight in melee would abandon
that fight the instant a ranged Archer's arrow landed, to go chase the
Archer instead — "appears as non-rational behavior." The original reactive
-aggro fix (much earlier) was solving a different problem (a unit walking
past/through a defender toward a far-away "nearest on paper" target) and
didn't distinguish that case from "already committed to a fight."

Fixed with `unit.isMeleeEngaged` (`src/unit.js`), set each frame in
`updateBattle` to `!unit.stats.ranged && canEngage` — true exactly when a
melee unit is actively in range and attacking. `applyDamage`'s reactive-
aggro switch now checks `!target.isMeleeEngaged` before switching: a unit
mid-fight stays focused ("keep the focus on one raider until it is dead,"
the user's own framing); a unit not yet locked into an active fight
(still approaching, or waiting for a slot) still redirects normally,
preserving the original fix's purpose.

### Defender guard mobility (new feature)
Defenders were fully stationary — attack anything in range, otherwise do
nothing. Added a "guard" stance (standard RTS pattern): defenders remain
primarily passive but will step a short distance from their placed
position to engage a nearby enemy, then return to post if that target
becomes unreachable.

Deliberately implemented as **simple, separate logic**, not routed through
the mobile-unit A*/attack-slot system raiders use — `advanceDefenderWithinLeash`
in `main.js` uses plain direct-line movement, no pathfinding, no slots. This
was a scope decision, not an oversight: the feature only needs to cover
short, controlled hops near a fixed point, and reusing the heavier
machinery built for 20 raiders navigating a whole map would be solving a
much smaller problem with much bigger tools than it needs.

- `unit.homePosition` (`src/unit.js`) — the defender's placement point,
  set once when placed (`main.js`'s click handler). The permanent anchor
  the leash is measured from, never updated afterward.
- `DEFENDER_LEASH_RADIUS = 4.5` — max distance a defender will stray from
  its post. `DEFENDER_MOVE_SPEED = 2.0` — a deliberate repositioning pace,
  slower than a Raider's charge (3.6), reflecting "guard," not "chase."
- Trigger condition: `distance(homePosition, enemy) <= LEASH_RADIUS +
  unit.stats.range` — i.e. "could I close the gap to attack range without
  exceeding my leash." If yes, advance toward the enemy directly, capped so
  a single frame's movement never itself pushes the unit past the leash.
  If the current target is unreachable within the leash, walk back toward
  `homePosition` instead of standing wherever it happens to be.
- Effect naturally scales with each unit type's own range: a Knight
  (range 1.7) gets a meaningful extension of effective threat range (up to
  ~6.2 from post); an Archer (range 9) barely needs to move at all, since
  its direct range already covers most of the leash+range radius anyway —
  this wasn't special-cased per unit type, it just falls out of the shared
  formula naturally.
- Known scope limits, not fixed this round: no slot coordination if
  multiple defenders' leashes overlap onto the same target (could cause
  minor visual overlap in that specific case — judged low-risk given
  defenders are gold-limited and leashes are modest); no obstacle-aware
  pathing during the short advance (direct line only — acceptable given
  short distances and that players tend to place defenders in already-
  reasonable spots).

## Idle-unit bugs found and fixed (both real, both from user observation)

### Raiders sometimes waiting at spawn until "something" happened
Root cause: `pickTargetByPathCost` (melee target acquisition) chose by path
cost alone, with no awareness of attack slots. A unit could lock onto the
cheapest-by-path target even if that target's slot ring was already full —
and since target locking is persistent (deliberately, to avoid jitter/
thrashing), it would then just wait on that *specific* target forever,
never reconsidering. The observed "starts moving when another raider dies"
was real and precise: if a raider holding a slot on that same target died,
a slot freed up and the waiting unit could finally proceed — but it was
pure luck whether that ever happened for any given target.

Fixed with two layers:
1. **`pickMeleeTarget`** (`src/main.js`) — new melee-specific selection
   among the candidate shortlist (widened to `MELEE_CANDIDATE_LIMIT = 5`,
   up from 3, to give more fallback options): prefers the cheapest
   candidate that currently **has an open slot** (`hasFreeMeleeSlot`,
   a non-reserving check) over a cheaper-but-full one. Only falls back to
   "cheapest overall regardless of slots" if every candidate in the
   shortlist happens to be full — rare, and self-resolving as attackers die.
2. **`SLOT_WAIT_TIMEOUT`** (4 seconds) — a safety net for that rare
   remaining case: if a unit is genuinely stuck waiting without a slot for
   too long, it forces a full target reacquisition rather than waiting
   indefinitely.

Ranged units are unaffected — they never compete for slots, so plain
path-cost picking (`pickTargetByPathCost`) remains correct and cheaper for
them.

### Archers sometimes idle despite a raider being in range
Root cause: persistent target-locking (by design, to avoid spread-fire
jitter) had no escape valve — if a stationary defender's locked target
wandered out of range (or became cliff-blocked) while a *different* enemy
was sitting right in range, the defender just waited on its original pick.
This was a known, documented gap ("defenders lock onto a target and never
re-evaluate until it dies") flagged in this file several rounds ago as
theoretical; the user now observed it actually happening.

Fixed with **`isEngageableBy(unit, enemy)`** (range + cliff-block check)
and a small addition to the per-frame loop: for stationary units, if the
current locked target isn't currently engageable, search for *any* enemy
that is and switch to it. This preserves "focus fire until dead" for the
normal case (target in range → keep hitting it, don't spread damage across
several simultaneously-reachable enemies) while eliminating the idle case
the user described: **a defender should never sit idle while something
attackable exists.** Deliberately scoped to stationary units only — mobile
units already have reactive aggro (switch on being hit) covering an
analogous gap for them.

## Map layout changes (user feedback after first random-generation playtest)
- **Map size scaled back ~25%** (`SCALE_BACK = 0.75` in `pickMapSize`,
  `levelGenerator.js`) — the initial 1.8x-3.2x(+) range read as too large;
  new effective range is roughly 1.35x-4.1x the original base dimensions.
- **Defender/intruder split is no longer 50/50.** Previously the border was
  implicitly the map's center line (`x = 0`). Now `DEFENDER_FRACTION = 0.75`
  — the defender gets 75% of the map's width, intruders spawn in the
  remaining 25% strip. `borderX = mapWidth * (DEFENDER_FRACTION - 0.5)` is
  now a real, generated, per-level value threaded through the whole
  pipeline: `main.js` destructures `BORDER_X` from the level config and
  uses it for placement rejection, ground zone coloring, and the border
  line's position — none of these are hardcoded to `x = 0` anymore.
  `levelGenerator.js`'s hill/cliff/forest/spawn placement ranges were all
  rewritten to be border-relative rather than assuming a center split.
- **City is now always pinned to the far west edge (genuinely the back of
  the map) AND shifted into one Z corner** (`cityCornerSign`, randomly
  north or south each level) — explicitly never centered along Z anymore,
  per feedback that a centered city read as "in the middle of the
  defensive side" rather than tucked at the back.
- **Forests are now biased toward the defender side**: roughly 80% of
  scattered forest count lands in defender territory, 20% in the (now
  smaller) intruder spawn strip, with intruder-side forests also generated
  smaller. Verified in aggregate across 60 test seeds (349 defender-side
  vs 80 intruder-side forests — see `test-generator.mjs`).
- **Ground clutter density bumped slightly** (0.045 → 0.052) per "increase
  it slightly on the defense area," and its area/range calculation was
  fixed to use the actual (now wider, and no longer symmetric around x=0)
  defender-side width instead of assuming a 50/50 split.
- **A real bug found while making this change**: `decorateCityBoundary`'s
  fence gate and path were hardcoded around `z = 0`, silently assuming the
  city sits centered in Z. Once the city started corner-shifting, this
  broke completely — the "gate opening" check never triggered (city's own
  z-range no longer included z=0), and the path was drawn at a z-coordinate
  disconnected from where the city actually was. Fixed to use the city's
  own actual z-center for both, and to route the path toward the new
  `BORDER_X` position instead of a hardcoded old-map-assumption endpoint.
  Caught by inspection while implementing the corner-placement change, not
  by a test — worth having an e2e visual check specifically for this
  someday, since none of the current automated tests render anything.

**Test suite updated accordingly**: `test-generator.mjs` gained checks for
border position (exactly 75% of map width), city edge/corner placement,
every raider spawn actually landing in the intruder strip, and the
forest defender-bias — all passing across 60 seeds alongside the existing
reachability/geometry checks.

## Random level generation + attack-slot combat system

This was a genuinely major architecture round — new modules, not patches on
old ones, following through on the "solid implementation, advanced
practices" direction explicitly requested at this point in the project.

### New module structure
- **`src/random.js`** — seeded PRNG (mulberry32) + seeded Perlin/fbm noise,
  written from scratch, no external dependency. Seeded = reproducible: a
  given seed always regenerates the exact same map.
- **`src/terrain.js`** — height/blocking math (hills, cliffs, slope
  formulas) **extracted out of `main.js`** into parameterized, pure
  functions (take feature arrays as arguments, not closures over
  module-level constants). This is what lets the level generator's
  validator and the real game use the *identical* logic instead of two
  copies that can silently drift apart — exactly the failure class that
  caused real bugs earlier in this project (the test suite's own
  duplicated terrain constants going stale). `test-pathfinding.mjs` was
  refactored to import from here too, for the same reason.
- **`src/levelGenerator.js`** — the actual procedural generation. See
  "Level generation algorithm" below.
- **`src/meleeSlots.js`** — pure geometry for the attack-slot system (no
  game-object dependency, independently tested). See "Attack slots" below.

### Level generation algorithm
`generateLevel({ seed, totalRaiders, startingGold, maxAttempts })` in
`levelGenerator.js`:

1. **Map size**: 1.8x-3.2x the original base dimensions (46x30) per axis,
   with a 15% chance of an extra 1.3x-1.7x multiplier on top ("sometimes
   more," per explicit request).
2. **Ambient elevation**: a seeded fbm noise function (low amplitude
   0.25-0.5, moderate frequency) layered underneath hills/cliffs via
   `makeTerrainSampler`, so the *entire* map has gentle natural rolling,
   not just discrete bumps at hill locations. This is a real, not
   cosmetic, part of `getTerrainHeight` now — critically, the ground
   MESH's vertex heights were fixed to actually use it too (see "Bugs
   found" below); before that fix the noise existed in the height function
   but never appeared in the render, a silent mismatch between where units
   stood and what was drawn.
3. **Hills, cliffs, forests**: placed via **rejection sampling** — propose
   a random position/size, reject and retry (up to 25 attempts) if it's
   too close to an already-placed feature or the city, skip that feature
   entirely if no valid spot is found after max attempts. Counts scale
   with map area (density-based, similar pattern to `GROUND_CLUTTER_DENSITY`
   from the previous round). All placed features are simplified to bounding
   *circles* for spacing checks — deliberately approximate, since the real
   correctness guarantee is reachability validation (next), not this
   heuristic.
4. **Two "gate" forests** are placed deliberately (not randomly) flanking a
   central passage near the border, preserving the core chokepoint
   mechanic this game was built around even though everything else is
   randomized. Additional forests scatter freely.
5. **Raider spawns**: clustered into randomized squad sizes/counts (not a
   uniform spread), matching "walking together in groups" — cluster count
   and per-cluster size are both randomized but always sum to exactly
   `totalRaiders`.
6. **Reachability validation**: builds a real nav grid for the candidate
   layout and confirms every raider spawn can reach *some* point across the
   defender's side via actual `findPath` — reusing the exact pathfinding
   system already used for gameplay, not new machinery. If validation
   fails, retries with fresh randomness (new seed derived from the base
   seed + attempt number, so still fully deterministic per base seed). If
   every attempt fails (hasn't happened in testing — see below), falls back
   to a guaranteed-simple layout (no cliffs, minimal forests) so the game
   can never hand the player something unplayable.

**Level rules vs. layout**: raider count and starting gold are fixed
parameters passed into `generateLevel()` (currently hardcoded in `main.js`
as 20 and 14) — only the *layout* (terrain, spawn positions) is randomized.
This was a deliberate design choice discussed with the user before
implementation.

### Attack slots (replaces the old melee-crowding cap entirely)
The previous fix (`MAX_MELEE_ATTACKERS_PER_TARGET`, a flat cap on
simultaneous attackers) reduced jitter but didn't eliminate it — capping
*how many* can attack doesn't tell them *where* to stand, so the ones that
got in were still competing for space via reactive separation. Replaced
with the standard RTS/tower-defense solution: **explicit slot reservation**.

- `computeSlotRing(targetRadius, attackerRadiusEstimate)` in
  `meleeSlots.js` — ring radius and slot count derived from real collision
  radii (not a magic number): however many attacker-sized bodies actually
  fit around the target's perimeter without overlapping.
- `pickBestFreeSlot(occupied)` — greedy, maximizes minimum angular distance
  to already-occupied slots. This spreads attackers evenly regardless of
  arrival order *without ever moving an already-assigned occupant* (which
  would look like mid-fight shuffling) — a small number of attackers end up
  spread around the target, not bunched on one side.
- In `main.js`: `reserveMeleeSlot`/`releaseMeleeSlot`/`getMeleeSlotPosition`
  are the thin wrapper tying this to live `Unit` instances.
  Self-healing dead-occupant handling: a slot's occupant is checked via
  `occupant.alive`, not an explicit release call, so a unit dying doesn't
  require hooking into every removal pathway — the slot just becomes
  available again automatically next time it's checked.
- Scoped to **mobile melee units only** — ranged units don't compete for
  space (no slot needed), stationary defenders never move (nothing to path
  toward). `followPathToward` was generalized to accept an explicit
  destination point (the slot's world position) instead of always deriving
  from the target's raw position; `computePathTo` was split into a
  `computePathToPoint(unit, point)` base function for this.
- Path-cost target *acquisition* (from the previous round) still uses the
  target's *raw* position for ranking candidates — the ring offset is
  small relative to typical path length, doesn't change which candidate
  wins. But the acquisition-time path is **discarded** for melee units
  (not cached) so `followPathToward` computes a fresh one toward the
  actual reserved slot on the next frame, rather than reusing a path aimed
  at the wrong (raw) point.

### Bugs found and fixed this round (all caught before shipping, not after)
1. **A leftover call site using the pre-refactor function signature** —
   `getHillHeight(x, z)` / `getCliffHeight(x, z)` (old 2-arg closures) were
   still being called that way in the ground-mesh vertex-height loop after
   `terrain.js` changed them to `(features, x, z)`. Silently passed `x` as
   the `features` array, crashing with "hills is not iterable" — but only
   at actual scene-build runtime, not caught by `npm run build` (a type/
   syntax check, not a logic check) or by the isolated unit tests (which
   don't exercise `main.js`'s scene construction at all). **Only caught by
   the real headless-browser end-to-end test** (see below) — concrete
   evidence for why that test exists now.
2. Same fix also corrected a second, quieter problem: the ground mesh's
   vertex heights were using `hillH + cliffH` directly instead of the
   composed `getTerrainHeight()` (which also includes ambient noise) — so
   even once the crash was fixed, the *rendered* terrain wouldn't have
   included the new ambient elevation noise at all, while units standing
   on it (via `snapToTerrain` → `getTerrainHeight`) would have — a visual/
   physical mismatch. Fixed by using `getTerrainHeight(x, z)` for the
   actual vertex Y position.

### Testing infrastructure — now four separate test files, each with a
distinct job (this is itself a "best practices" improvement — previously
one file tried to cover pathfinding, and there was no test for the
generator or the slot system at all):
- **`test-pathfinding.mjs`** — the core A*/smoothing/collision *algorithm*,
  against a fixed illustrative terrain fixture. Re-scoped this round: since
  levels are now procedurally generated, there's no single "real level" to
  test against anymore — this file now explicitly tests the algorithm in
  isolation, not a specific layout. Imports real functions from
  `terrain.js` instead of hand-duplicating them.
- **`test-generator.mjs`** (new) — tests `levelGenerator.js` across 60
  seeds: reachability is *independently re-verified* (rebuilds its own nav
  grid and calls `findPath` itself, doesn't just trust the generator's own
  internal check), map sizes/feature counts land in expected ranges, no
  degenerate geometry (NaN, zero/negative radii, inverted cliff bounds).
  0 failures, 0 fallback triggers across all 60 seeds tested.
- **`test-melee-slots.mjs`** (new) — pure geometry checks on
  `meleeSlots.js`: ring sizing, that multiple attackers actually spread out
  rather than bunch, full-ring rejection, exact world-position math.
- **`test-e2e.mjs`** (new) — a **real headless Chrome session** (via
  Puppeteer) that loads the actual game, waits for the loading screen to
  hide (asset loading completes), clicks to place units, starts a battle,
  and watches for any console/page errors during genuine execution. This
  is meaningfully stronger than the other three: it's the only test that
  exercises `main.js`'s actual bootstrap, scene construction, and DOM/event
  wiring end to end — and it's what caught bug #1 above, which every other
  check (build, isolated unit tests) missed entirely. Heavier to run (needs
  a browser binary + a live dev server), so it's not part of a "quick
  check" — see the file's header comment for exact run instructions.
  Deliberately structured so a battle that's still running after a fixed
  window (10s primary + 40s informational) is *not* treated as a failure —
  large generated maps legitimately take longer to resolve a battle (more
  travel distance at the same unit speed), and that's correct pacing, not
  a hang. Confirmed clean (0 console errors, 0 page errors) across multiple
  runs against different randomly-generated levels.

## Real assets integrated (Kenney.nl environment pack)

The user supplied 60 `.glb` files (trees, rocks, plants, flowers, grass
tufts, paths, platforms, fences, and a modular cliff-tile kit) — CC0
licensed, unlit/vertex-colored, no textures. All verified to load correctly
with Three.js's actual `GLTFLoader` (not just JSON-validated) before being
wired in — see `node test-gltfloader-tmp.mjs`-style checks in the session
history; no permanent test file was kept for this since, unlike terrain/
pathfinding, there's no ongoing logic here to regress.

**Architecture change: the game now boots asynchronously.** Previously
everything ran synchronously at module load. Now: scene/camera/lighting/
ground/terrain-shape/nav-grid setup (nothing model-dependent) still runs
synchronously at the top of `main.js`, but forest creation, hill/cliff
decoration, ground scatter, the city, and intruder spawning are deferred
into an async `bootstrap()` at the bottom of the file, which `await`s
`preloadAssets()` first. A loading screen (`#loading-screen` in
`index.html`) covers the canvas with a percentage readout until assets
finish, then hides and starts `animate()`. If loading fails, the screen
shows an error instead of leaving the user looking at a broken/empty scene.

**`src/assets.js`** — the loading module. `MODEL_NAMES` categorizes every
asset (trees, rocks, cliffRocks, plants, flowers, grassTufts, paths,
platforms, fences, cliffTiles). `preloadAssets(onProgress)` loads all 60 up
front via `GLTFLoader`, caching each as a template `Object3D`.
`spawnModel(name)` returns a fresh `.clone(true)` — geometry/materials are
shared across clones (Three.js's default behavior for static, non-skinned
meshes), so this is cheap even with many instances. `randomOf(names)` picks
a random entry from a category for variety.

**Trees**: procedural cone+cylinder trees fully replaced with real random
tree models in `createForest()`. `TREE_SCALE = 2.3` — the raw Kenney trees
are person-scale (0.9-2.1 units tall, matching roughly our Knight's 1.7),
which would look like shrubs, not looming trees, next to game-scale units;
scaled up to compensate. Revisit this number once actually seen rendered.

**Cliffs — a deliberate scope decision, not an oversight.** The uploaded
kit includes a genuine modular tile-based cliff-building system (full/half/
quarter-height blocks, slopes, corners, and walkable staircase pieces) —
the "real" version of the two-level-topology idea from much earlier in this
project. Adopting it properly means authoring cliffs as arrangements of
discrete tiles instead of the current continuous height-field formula
(`getCliffHeight`), which is a genuine architecture change, not a visual
swap — and our current cliff system has 180+ automated pathfinding/
collision tests passing against it after several real bugs were found and
fixed the hard way. Rather than risk that work to chase a visual upgrade in
the same pass, the decision was: **use the kit's rock models as decoration
on top of the existing, tested cliff shape** (`decorateCliffs()` — real
rocks along the steep face and scattered on the plateau), leaving
`getCliffHeight`/`blockedByCliff`/pathfinding untouched. The full tile-based
rebuild remains a good option for later — `MODEL_NAMES.cliffTiles` is
already loaded and cached, ready to use whenever that's actually pursued.

**Other decoration**: `decorateHills()` scatters rocks across both hills.
`decorateGroundScatter()` lightly scatters flowers/grass tufts across the
defender's flat ground (skipping forests, the city, and cliff footprints).
`decorateCityBoundary()` places a fence line along the city's edge facing
the battlefield and a stone path leading from the city toward the main
chokepoint.

**Not yet used**: paths other than `path_stone` (wood, wood-corner),
platforms (beach/grass/stone — no clear use case yet since our ground is
one continuous mesh, not tile-based), and the cliff tile kit itself. No
unit/character models were provided (environment-only pack, by design) —
units remain primitive boxes.

## Major rewrite: continuous 3D terrain → tile-based isometric ("2D+")

**Why.** The game was fully playable and looked reasonable in free-orbit 3D,
but the user's actual long-term goal is a game that looks genuinely good —
and sourcing quality 3D character models/animations is far harder than
sourcing 2D character sprites. Decision: drop free camera rotation, lock to
a fixed isometric-style angle (Age of Empires-style "2D+"), and move units
to sprite billboards. Explicitly requested: keep pathfinding and battle
logic intact — this was a rendering/terrain-representation change, not a
gameplay-logic rewrite, and it was treated that way throughout.

### The key architectural idea: elevation as discrete tile levels

Instead of porting "hills" and "cliffs" as two separate tile-based systems,
they collapse into **one concept**: a *plateau* is a raised rectangular tile
region where each of its four edges is either a **ramp** (walkable
transition — old Hill behavior) or **sheer** (impassable wall — old Cliff
behavior). A Hill is just a plateau with ramps on all sides; a Cliff is a
plateau with 1-3 sheer sides and the rest ramped. This isn't just tidier —
it's a genuine simplification: one generator function, one tile-stamping
routine, one elevation-lookup path, instead of two parallel systems.

**Gameplay-preservation reasoning (this mattered — worth recording why it's
correct, not just what it does):** the old system's elevation bonus and
melee-blocking were driven purely by *current absolute height difference*
between two units, not by which terrain feature caused it. So the "hills
never block melee" behavior wasn't a hill-specific rule — it fell out of the
fact that hills are climbable from every side, so a melee unit chasing a
target up a hill naturally arrives at matching height before it's close
enough to fight. Cliffs blocked melee only when approached from the sheer
side, where a unit physically *couldn't* climb to match height. The tile
system reproduces this exactly with one rule: **melee blocked whenever
`attacker.level !== target.level`**, full stop, no special-casing for
hill-type vs cliff-type plateaus. On a ramped side, a chasing unit reaches
matching level and the block clears naturally; on a sheer side, it never
can. Elevation damage bonus is `attacker.level > target.level`. Both are in
`tileTerrain.js` (`isMeleeBlockedByElevation`, elevation bonus check).

### What this made free (genuine simplifications, not just parity)

- **`pathfinding.js` needed zero changes.** It was already a generic grid
  consumer (`isBlocked(x,z)`, A* + smoothing). Before, the nav grid was
  built by geometrically *sampling* a continuous height-field to guess
  walkability. Now the tile grid's own walkability data directly *is* the
  nav grid — no sampling, no approximation.
- **`meleeSlots.js` needed zero changes** — pure ring/slot geometry, never
  cared about terrain representation to begin with.
- Placement raycasting simplified: instead of raycasting against a deformed
  mesh to get height-aware click positions, we raycast against the actual
  tile meshes (or could raycast a flat plane and look up tile data — we
  went with real tile meshes since `clickableTileMeshes` already existed
  from the InstancedMesh groups) and read walkability directly from data.
  City-exclusion during placement is now free (just another non-walkable
  tile type) instead of a separate `insideCity` check.
- Health bars no longer need a manual per-frame `faceHealthBarToCamera` —
  they're sprites now, sprites billboard automatically. `unit.js`'s
  rotation-facing logic (`mesh.lookAt()`) is gone for the same reason; the
  unit still tracks `facingAngle` (for future directional sprite art) but
  nothing rotates a mesh to achieve it anymore.

### What was preserved verbatim

`UNIT_STATS` (byte-for-byte), the entire combat loop (`updateBattle`,
`pickTargetByPathCost`, `followPathToward`, `advanceDefenderWithinLeash`,
attack-slot reservation/arrival timing, `updateStuckWatchdog`,
`computeCanEngage`, reactive-aggro suppression via `isMeleeEngaged`,
`resolveTerrainCollisions`'s intent). Only the terrain-specific inputs
feeding these functions changed (e.g. `blockedByCliff` →
`isMeleeBlockedByElevation`, `getTerrainHeight` → tile-level lookup); the
functions' own logic was not rewritten.

### Rendering decisions

- **Camera**: `THREE.OrthographicCamera`, fixed pitch/yaw (isometric-style
  angle), `OrbitControls` with `enableRotate=false` (pan + zoom only, no
  rotation — verified via real drag-and-screenshot that the angle stays
  perfectly locked while panning).
- **Terrain**: tile grid rendered via grouped `InstancedMesh` (by
  kind × elevation) rather than one mesh per tile — needed for performance
  at map sizes up to ~160×100 tiles. Placeholder geometry only (flat boxes
  at two heights, tinted by kind: green ground, tan elevated, yellow ramp,
  dark sheer wall) — intentionally simple since real tile art isn't sourced
  yet; the data model (levels, ramp/sheer per edge) is what's built to last,
  not this geometry.
- **Units**: `THREE.Sprite` billboards with a canvas-drawn placeholder icon
  per unit type, cached in `spriteTextureCache`. Swapping in real sprite
  sheets later is a change to one function (`getUnitTexture`) — nothing
  else in `unit.js` needs to know.
- **Forests**: simple placeholder trunk+cone trees (the same procedural
  shape used before the Kenney GLB pack was ever integrated), instanced.
- **Discarded**: all 60 old Kenney environment GLBs (trees, rocks, cliff
  kit, fences, paths, platforms) — explicit user go-ahead to throw these
  out; not deleted from disk (`public/models/*.glb`, 648KB, unreferenced,
  pending a future cleanup or reuse decision). `assets.js` gutted to an
  empty `MODEL_NAMES = {}` but the GLTFLoader infrastructure
  (`preloadAssets`/`spawnModel`/caching) was kept intact and documented as
  ready to receive whatever new tile models or sprite sheets get sourced.
  `terrain.js` (the old continuous heightmap module) was deleted outright —
  zero reuse value, unlike `assets.js`.

### A real bug found via test-writing, not visual inspection

While rewriting `test-pathfinding.mjs` for tile fixtures (using the real
`tileTerrain.js` stamping functions plus an independent fine-grained
line-sampling verifier — same discipline as before), found that
`isLineClearOnGrid`'s sampling density (`cellSize*0.5`, ~2 samples per tile
crossed) was coarse enough for a smoothed diagonal path segment to skip
clean over a single blocking tile — confirmed by two distinct real cases:
a plateau's sheer-side corner tile, and (on a second, longer diagonal
segment) a forest tile's edge. **Fix**: tightened the step size to
`cellSize*0.2` (~5 samples per tile) in `pathfinding.js`. Performance cost
is acceptable since smoothing only runs on target acquisition, not every
frame. This is the same class of bug (an under-sampled clearance check with
a real geometric blind spot) as an old analytic segment-distance bug caught
years earlier by this same test file — the "write an independently-derived
verifier, don't just trust the production code's own math" discipline paid
off again. All 80/80 stress-test spawn→defender path checks pass after the
fix.

### Verification performed (this is the part that actually matters)

Screenshots alone can be misleading (camera pans between shots, etc.), so
beyond the visual check, a temporary `window.__debugStats()` hook was added
to `main.js`, used to pull real unit positions/health directly from a live
headless-browser battle over 40 seconds, then removed and confirmed gone
via `grep -rn "__debugStats" src/`. Result: intruder average X position
advanced steadily from 30.29 → 13.71 over 40s (moving toward defenders, not
static or oscillating), and a unit death was recorded at t=35s (20→19
alive) — direct proof combat and pathfinding are functioning end-to-end in
the new tile system, not just rendering plausibly. All four test suites
pass (`test-pathfinding.mjs`, `test-generator.mjs`, `test-melee-slots.mjs`,
`test-e2e.mjs` — the last with 0 console/page errors across a real
load→place→battle run). Fresh `npm run build` is clean.

### Not yet done

Visual polish is explicitly deferred — current terrain/unit rendering is
placeholder-quality by design, matching the project's established pattern
of validating architecture before investing in art. Next real content step
is the user sourcing new tile art and character sprite sheets; `assets.js`
and `getUnitTexture` are the two integration points built to receive them.

## Level progression, population, and the Gold/upgrade economy

**Why.** Up to this point every level used fixed, identical rules (20
raiders, 14 gold). This adds a meta-progression layer: levels get
harder over time by a defined, tunable formula, and clearing levels earns
a persistent currency that permanently strengthens defenders via upgrades
— the "tune the strategy to perfection" system the user asked for.

### Two separate currencies — deliberately renamed to avoid ambiguity

The old per-level placement currency was called "gold." That name is now
reassigned to a *different*, persistent resource, so the old one had to be
renamed to avoid two unrelated things sharing a label in the same UI:

- **Population** — per-level budget for placing units (Knight 3, Archer 2
  — same numbers as before, just renamed). Resets every level. This is
  what `startingGold`/`gold` meant throughout the codebase before this
  round; renamed to `startingPopulation`/`population` everywhere
  (`levelGenerator.js`, `main.js`, `test-generator.mjs`, `test-e2e.mjs`).
- **Gold** — a new persistent currency, earned by clearing a level
  (`GOLD_PER_LEVEL_CLEAR = 10`), banked in `localStorage` across the whole
  save, spent on permanent upgrades. Never resets on its own.

### `src/progression.js` — new module, pure logic + persistence, no
Three.js/DOM dependency (fully unit-testable, see `test-progression.mjs`)

**Difficulty scaling.** Measured as "total starting HP across all raiders
in the level." `computeDifficultyBudget(levelNumber)` compounds
`BASE_DIFFICULTY_HP` by `DIFFICULTY_GROWTH_RATE` (20%, easy to retune) per
level above 1. `computeRaiderCount(levelNumber)` floors
`budget / raiderMaxHealth` to get a raider count, deliberately discarding
any remainder that doesn't divide evenly (matches the stated design: fill
the budget, don't worry about a small leftover). Both are written as
single named functions specifically so the *difficulty measure itself*
can be swapped later (e.g. a function of HP and DPS together, an idea
raised but not yet implemented) without touching any call site.

**A real balance catch, worth recording.** The original design brief's
worked example used raider HP=10 as a round illustrative number
("let's just for the sake of argument say..."). Real raiders have 32 HP.
Applying `BASE_DIFFICULTY_HP=100` literally against the real unit would
have dropped level 1 from the already-playtested 20 raiders down to just
3 — a drastic, certainly-unintended difficulty cliff. `BASE_DIFFICULTY_HP`
is set to **640** (= 20 raiders × 32 HP) instead, so level 1 exactly
reproduces the raider count already balanced throughout this project, and
every level above it grows from that real baseline. The formula mechanic
itself (20% compounding, floor-and-discard remainder) is exactly as
specified — only the base constant was recalibrated, and
`test-progression.mjs` has a dedicated regression check
(`computeRaiderCount(1) === 20`) so this can't silently drift back to the
illustrative value later. Resulting curve: L1=20, L2=24, L3=28, L4=34,
L5=41, L6=49, L7=59, L8=71 raiders.

**Population budget.** `computePopulationBudget(levelNumber)` currently
just returns a constant (`BASE_POPULATION = 14`, same as the old starting
gold) — written as a function, not a bare constant, specifically so making
it scale per level later is a one-line change here instead of a hunt
through `main.js`. Not currently requested to scale; flagged as an easy
lever if wanted.

**Upgrades.** Four independent upgrades — Knight/Archer × HP/Damage — each
a flat `+10 HP` or `+2 damage` per purchase, `15` gold flat cost, fully
repeatable/stacking (no cost-escalation curve yet; easy to add later by
making `cost` a function of purchase count). A damage-upgrade purchase
shifts *both* `damageMin` and `damageMax` by the same amount, preserving
the roll spread rather than collapsing it. `getUpgradedStats(unitType,
purchases)` returns a **new** stats object layering all purchased bonuses
on top of base `UNIT_STATS` — it never mutates the shared `UNIT_STATS`
singleton, since other code (melee-slot ring sizing, the generator, other
tests) reads that object directly and must always see base values
regardless of what's been purchased. `Unit`'s constructor gained an
optional 4th `statsOverride` parameter for exactly this — intruders/
raiders never pass one (always base stats); defenders get
`effectiveStats[type]` computed once per page load (and recomputed live
after any pre-placement purchase — see below).

**Persistence.** Single-slot `localStorage` save (`city-defense-progress-v1`:
`{ level, gold, purchases }`), loaded once at module init in `main.js`.
`loadProgress()` merges over `defaultProgress()` so an older save missing
a since-added key can't crash anything downstream, and falls back to
defaults entirely on corrupt/missing JSON rather than throwing.
`test-progression.mjs` exercises this with a real in-memory `localStorage`
polyfill installed *before* importing the module (so the actual browser
code path runs under Node, not a mocked-out alternative) — including a
deliberately-corrupted-JSON case and a deliberately-partial (old-version)
save case.

### Level-transition flow (`main.js`)

Levels already transitioned via `window.location.reload()` for Reset/Retry
before this round (the whole scene is built at module-top-level, not
inside a re-callable function, so a full reload was already the
established, lower-risk way to rebuild everything cleanly). This round
reuses that exact mechanism for level advancement too, rather than
building risky in-place scene teardown/rebuild: on victory,
`endBattle(true)` immediately mutates and **saves** `PROGRESS` (gold
awarded, level incremented) — before the player even sees the shop, so a
stray page refresh right after a win still lands them on the next level
with earnings intact — then opens the shop with a "Continue to Level N+1"
button whose only job is triggering the reload. On defeat, `PROGRESS` is
never touched (same level retried, no gold change); the shop is still
shown so previously-banked gold can be spent before retrying.

### The shop panel — one reusable component, three entry points

A single `#shop-panel` (four upgrade rows + a context-sensitive primary
button) is shown: (1) automatically after a win, with an earned-gold
banner and a "Continue" action; (2) automatically after a loss, so banked
gold can be spent before retrying, primary button reads "Try Again"; (3)
via an always-available topbar "⚒ Upgrades" button, primary button reads
"Close." Entry point (3) is **only visible when `defenders.length === 0`**
— i.e. before the player has placed anything this level. This was a
deliberate simplification to sidestep a real correctness problem: if a
purchase were allowed mid-placement, already-placed units would keep
their old (pre-purchase) stats while newly-placed ones of the same type
got the new stats, silently producing two different "Knights" on the
field at once. Gating on `defenders.length === 0` avoids this entirely
without needing to track phases more finely. A purchase made through this
pre-placement entry point recomputes `effectiveStats` immediately (no
reload needed) so the very next placement in the same session reflects it
correctly; purchases made from the post-result entry points naturally
take effect on the reload that "Continue"/"Try Args" already performs
regardless.

A small "Reset all progress" link inside the shop (browser `confirm()`
guard, calls `resetProgress()` then reloads) wipes the save back to
Level 1 / 0 gold / no upgrades — separate from the existing "Reset"
button, which still just restarts the *current* level attempt and never
touches saved meta-progress.

### Verification

`test-progression.mjs` (34 checks): difficulty compounding, the real-vs-
illustrative raider-count regression above, population/gold constants,
upgrade math (stacking, both-ends damage shift, no cross-unit-type leakage,
no shared-object mutation), `purchaseUpgrade` success/insufficient-gold/
unknown-key paths, and full persistence round-trips including corrupt and
partial-save cases. Beyond the unit tests, the actual browser UI was
verified with real headless screenshots and live DOM interaction (not just
code review): seeded `localStorage` with 40 gold, opened the shop via the
topbar button, bought the Knight HP upgrade twice via real `.click()` calls
on the actual buy buttons, confirmed the bonus text read exactly "+20 HP",
confirmed gold correctly dropped 40→10 in both the topbar and the panel,
confirmed the underlying `localStorage` value matched, then reloaded with
a seeded Level 2 save and confirmed the topbar correctly read "Level 2"
with population still 14 (constant, as designed) and a visibly denser
raider spawn. `test-e2e.mjs` updated for the population rename and reruns
clean (0 console/page errors). All other suites (`test-pathfinding.mjs`,
`test-generator.mjs`, `test-melee-slots.mjs`) unaffected and still passing.

## Unit stats reference panel (lower-left corner)

A small read-only panel, toggled by a "📊 Stats" button fixed to the
lower-left corner (`#stats-toggle-btn`/`#stats-panel` in `index.html`,
absolutely positioned within `#ui` rather than living in the centered flex
column the other UI lives in). Shows each defender type's *live effective*
stats — HP, damage, attack speed, range, armor, cost — with any
upgrade-driven bonus called out separately in green (e.g. "180 (+30)"),
computed as `effectiveStats[type] - UNIT_STATS[type]` per stat rather than
just showing the post-upgrade number alone, so it doubles as a running
log of upgrade progress, not just a snapshot.

Unlike the shop, this never mutates game state, so — deliberately — it has
none of the shop's phase-gating: it's available in every phase, including
mid-battle, where seeing exactly what a Knight currently hits for while
watching it fight is arguably the most useful moment to check.
`renderStatsPanel()` is called on toggle-open and, if already open,
immediately after any upgrade purchase too (mirroring how `renderShop()`
already refreshes on purchase), so it never shows stale numbers while
open.

## Attack speed, armor, range upgrades, and buyable population

Extends the upgrade shop with 5 new stat upgrades (Knight/Archer attack
speed, Knight/Archer armor, Archer-only range) and a way to permanently
buy more population, both using an escalating cost schedule distinct from
the original HP/Damage upgrades' flat 15g.

**Escalating cost — one formula covers both new cases.** Every `UPGRADES`
entry now has `cost` (price of the 1st purchase) and `costIncrement`
(added per purchase already made): `getUpgradeCost = cost + costIncrement
* purchaseCount`. With `cost=5, costIncrement=5` this produces exactly
5, 10, 15, 20... as specified. HP/Damage keep `costIncrement: 0` (flat
15g, unchanged — not requested to change, so left alone rather than
guessed at). The new buyable-population feature reuses the identical
shape (`getPopulationUpgradeCost`, base 10 + increment 10 → 10, 20, 30...)
tracked as its own `progress.populationPurchases` counter rather than
living inside the per-upgrade `purchases` map, since it isn't a per-unit
stat.

**The attack-speed math — this was the one genuine "get it right or the
game breaks" case.** `unit.js` documents `attackSpeed` as a rate (hits per
second), and `main.js`'s combat loop derives the actual attack cooldown
fresh every time as `1 / stats.attackSpeed` — there's no separately-
tracked cooldown field anywhere to get inverted by mistake. Because of
that, "+10% attack speed" is correctly a direct multiplicative bonus on
the rate itself (`base.attackSpeed * (1 + 0.10 * purchases)`), and needed
no special-casing anywhere else in the codebase — bumping the rate is
automatically correct. The one real design decision was additive-vs-
compounding: purchases stack the PERCENTAGE additively (10%, 20%, 30%...),
not compounding purchase-over-purchase (which would be 1.1³≈33.1% at 3
purchases instead of the flat 30%) — chosen for consistency with every
other upgrade's flat-additive-per-purchase design, and locked in with an
explicit regression test that would fail if this ever silently became
compounding.

**Armor and range** are ordinary flat additive upgrades, identical in
shape to HP — no new mechanism needed. **Range is deliberately
archer-only**: there's no `knightRange` entry in `UPGRADES` at all (not
just a UI omission — the underlying purchase key doesn't exist, so it's
structurally impossible to buy). Knights display "Melee" instead of a
number in the stats panel, which is **purely a presentation choice** made
in `main.js`'s `renderStatsPanel` — `UNIT_STATS.knight.range` /
`effectiveStats.knight.range` remain real numbers underneath, completely
untouched, still driving the exact same melee-engagement-distance checks
in the combat loop as before. Nothing in battle logic changed.

**Zero changes needed in `unit.js` or the combat loop.** The
`statsOverride` mechanism built for the original HP/Damage upgrades was
already fully generic — `Unit`'s constructor just does `this.stats =
statsOverride || UNIT_STATS[type]`, and every consuming function already
reads whatever fields it needs off `this.stats` (`attackSpeed`, `armor`,
`range`, ...) without caring where the object came from. Adding 5 more
upgradeable stats required no architecture changes at all, only more
entries in `progression.js`'s `UPGRADES` table and formatting work in
`main.js`'s UI — a good sign the original design held up.

**Shop UI reorganized into sections.** With 10 total purchasable things
(1 population + 4 knight stats + 5 archer stats) a flat list stopped being
scannable, so `renderShop()` now groups rows under "Population" / "🛡️
Knight" / "🏹 Archer" headers, and `#shop-upgrades` scrolls
(`max-height: 50vh`) instead of the panel growing unboundedly.

**Buying population takes effect immediately, same pattern as stat
purchases.** Since the shop's standalone browse entry point is only ever
visible pre-placement (`defenders.length === 0`), a population purchase
can safely bump the live `population` variable by the same amount
in-place rather than needing a reload or a from-scratch recompute — no
units exist yet this level, so extending the remaining budget IS
recomputing it from scratch.

### Verification

`test-progression.mjs` grew from 34 to 63 checks, covering: the escalating
cost schedule end-to-end through `purchaseUpgrade` (not just
`getUpgradeCost` in isolation — an actual 3-purchase sequence spending
5, then 10, then 15), the attack-speed math specifically including an
explicit "this must NOT compound" regression, armor/range additive
stacking, confirming `UPGRADES.knightRange` doesn't exist, population
purchase cost/effect/failure paths, and persistence round-trips for both
new fields (`populationPurchases` and the 5 new purchase keys) including
loading an old-shape save that predates this round entirely. Beyond unit
tests, real headless-browser screenshots exercised actual `.click()` calls
on the real buy buttons through a full purchase sequence (Knight Armor x3,
Knight Swiftness x2, Archer Range x2, Population x2) and confirmed every
displayed number — button cost labels, gold balance, topbar population,
and the stats panel's bonus figures — matched the expected math exactly,
including confirming the Knight's stats-panel Range row correctly reads
"Melee" with no numeric upgrade path while the Archer's reads a real,
upgradeable number.

## Decoupling level-progression from the shop, unified 5g pricing, population 14→12

Three targeted fixes from user feedback after the previous round:

**The "Start Next Level" button moved out of the shop panel entirely.**
Previously the shop's own primary button did double duty — "Continue to
Level N+1" / "Try Again" / "Close" depending on context — which meant the
only way to actually advance was through a button embedded in the (meant
to be optional/browsable) upgrade panel. Now `#result-banner` has its own
independent `#result-primary-btn`, wired directly in `endBattle()` to the
level-transition reload. The shop's `shopPrimaryBtn` is unconditionally
"Close" now — it does nothing but hide the panel, regardless of win, loss,
or pre-placement browse mode. Verified structurally (`result-banner`
contains `result-primary-btn`, not the reverse; closing the shop leaves
the result banner and its button fully visible and functional) rather
than just visually, since this was exactly the kind of coupling bug that
caused the original complaint.

**All upgrade costs unified to the same 5g-base / +5g-per-purchase
schedule**, including HP and Damage (previously flat 15g, deliberately
left alone in the prior round since it wasn't asked for — now explicitly
folded in) and the population purchase (previously 10g/+10g, now matching
everything else at 5g/+5g). `progression.js`'s `getUpgradeCost` formula
didn't need to change at all — only the `cost`/`costIncrement` values on
each `UPGRADES` entry and the two `POPULATION_UPGRADE_*` constants did,
confirming the escalating-cost mechanism built last round was genuinely
general rather than accidentally special-cased to the "new" stats only.

**`BASE_POPULATION` 14 → 12.** A one-line constant change; validated the
generator doesn't depend on the specific value (it's a pure passthrough
placement budget, not consulted by any terrain/reachability logic).

## Gold interest, raider evolution (replacing the old difficulty formula), and a smaller map

The biggest structural change this round: the old level-number-driven
difficulty system (`computeDifficultyBudget`/`computeRaiderCount`,
compounding a total-HP budget by 20%/level) is **gone**, fully replaced by
a random raider-evolution mechanic. It directly conflicted with "reduce
attackers starting numbers to 10, with current stats" — level 1 under the
old formula produced 20 raiders deterministically; there was no way to
reconcile that with a request for exactly 10. Rather than leave two
competing difficulty systems around, the old one was deleted outright
(constants, functions, and their tests) once the new one covered the same
role.

**Gold interest — exact precision internally, floor only at display.**
`applyGoldInterest(progress)` adds 20% of whatever's currently in the bank
directly to `progress.gold`, called once per level clear, BEFORE the flat
`GOLD_PER_LEVEL_CLEAR` reward is added (so the reward itself never earns
interest the same level it's granted — matches "if unused between
levels"). `progress.gold` is a genuine float now, not an integer — it
compounds fractionally forever (100 → 120 → 144 → 172.8 → ...), and
**nothing in `progression.js` ever rounds it**, since rounding at the
source would silently discard precision from the saved value itself.
Every UI touchpoint that displays gold (topbar, shop panel, both twice —
once in the header, once via `renderShop()`) wraps it in `Math.floor()`
at the point of display; the affordability check for buy buttons
(`PROGRESS.gold < cost`) deliberately uses the exact, unfloored value —
floor-for-display + exact-for-logic means the UI can never show a balance
that looks sufficient for a purchase it can't actually make (floor only
ever moves the displayed number down, never up, so if what's *shown*
covers a cost, the real balance covers it too).

**Raider evolution.** Once per cleared level (never on a loss),
`evolveRaiders()` picks one of 5 stats uniformly at random — count, HP,
damage, attack speed, or armor — and permanently boosts it 20%,
compounding across however many times that stat gets picked over a run
(mirrors the "evolving generation over generation" flavor, and reuses the
same compounding-percentage shape the old difficulty formula used to
have). `RAIDER_STARTING_COUNT = 10` at the real, current
`UNIT_STATS.raider` values — no separate baseline to keep in sync with
the real stats the way the old formula's `BASE_DIFFICULTY_HP` was.

**The one real math trap, worth flagging explicitly: raider armor starts
at 0.** A literal "× 1.2 compounding" reading is a permanent no-op for a
zero base (0 × anything is still 0), which would have silently wasted a
full 1-in-5 chance of any given evolution event doing nothing at all.
Armor evolves by a flat `RAIDER_ARMOR_EVOLUTION_STEP = 1` per pick
instead — chosen to feel roughly comparable in impact to a 20% swing in
the other stats rather than trying to force a percentage onto a zero
base. This is a deliberate, disclosed deviation from "all five stats work
identically," not an oversight; `test-progression.mjs` has an explicit
regression (`getEvolvedRaiderStats` with an armor pick actually changes
armor, confirming it isn't silently inert).

**The evolution actually affects battle, not just display.** Raiders now
spawn via `new Unit("raider", ..., effectiveRaiderStats)` in
`spawnIntruders()` — passing the evolved stats object as the same
`statsOverride` mechanism built for defender upgrades. `effectiveRaiderCount`
feeds `generateLevel()`'s `totalRaiders` parameter directly. Both are
recomputed immediately after `evolveRaiders()` runs (in `endBattle`'s
victory branch) so if the stats panel is opened before clicking "Start
Level N," it already shows the freshly-evolved numbers, not stale
pre-evolution ones.

**Announcements, in two separate places on purpose** (continuing last
round's "don't couple unrelated things into one panel" fix): the raider
evolution message ("⚔️ Raiders gained 20% HP!", styled in red — genuinely
threatening news, not something that should read as a reward) lives in
`#result-banner`, since it's a consequence of the battle's outcome, not a
shop concept. The interest breakdown ("🪙 Interest: +20 (20%)", styled
gold, separate from the existing green "Level cleared! +10 🪙" line) lives
in the shop panel next to the gold balance it explains, since that's
where the number it's justifying is actually shown.

**Map size reduced ~30%** via a single multiplier
(`SCALE_BACK = 0.75 * 0.7` in `levelGenerator.js`) rather than touching
`BASE_COLS`/`BASE_ROWS` or the width/depth randomization range — this was
already the exact "shrink the whole map uniformly" knob the generator
had, so the fix is one line and every other tuned aspect (size variety,
the 15%-chance extra-large roll) is untouched. The `Math.max(20, ...)`/
`Math.max(14, ...)` size floors were deliberately left alone — those are
a correctness guarantee (room for the city/plateaus/forests to fit, and
for reachability validation to succeed), not a size dial, so shrinking
them too would risk raising the generator's fallback rate instead of just
making maps more compact.

**A real latent test bug the smaller map exposed.** `test-generator.mjs`'s
independent reachability re-check only tried a single city-corner point,
which is a strictly weaker guarantee than what the generator's own
internal `isReachable()` already verifies (7 sample points spread across
the whole defender zone — matching what actually matters for gameplay,
since a raider paths toward the nearest *defender*, not toward the city
specifically). This mismatch was latent but harmless on the larger
pre-reduction maps; smaller maps made it plausible for the one specific
city-corner point to become locally enclosed by a plateau or forest while
the rest of the defender zone stayed fully reachable, surfacing as a
false failure (seed 1407, confirmed via direct debugging that the real
internal check still passed — 0/60 fallbacks). Fixed by rewriting the
test to sample the same 7 defender-zone points the generator itself uses,
turning a "majority unreachable" soft diagnostic into a proper hard
`unreachable > 0` gate that actually matches the real guarantee. Stress-
tested at 400 seeds (not just the default 60) to confirm this was a
genuine fix, not a coincidence: 0 failures.

## Tuning pass, score tracking, and a real UI bug fix

**Interest 20%→10%, gold reward now grows per level.** Straightforward
constant change (`GOLD_INTEREST_RATE`) plus a new `computeGoldReward
(levelNumber) = GOLD_PER_LEVEL_CLEAR + (levelNumber - 1)` — clearing level
1 still gives the base 10g, level 2 gives 11g, level 3 gives 12g, linear
growth deliberately distinct in shape from interest's percentage
compounding, so the two mechanics stay conceptually separate even though
both show up as "gold added on a win." `GOLD_PER_LEVEL_CLEAR` itself
(the base) is unused in `main.js` now — `computeGoldReward` supersedes it
at every call site; the constant only remains as the base term inside
that formula.

**Attack speed reduced ~25% across all four unit types** (Knight
1.0→0.75, Archer 1.2→0.9, Raider 1.3→0.98, Catapult 0.55→0.41, the last
one included for consistency even though catapults aren't used in any
level yet). Pure data change in `unit.js` — the upgrade and evolution
systems both read `base.attackSpeed` dynamically wherever they need it,
so nothing else needed touching.

**Score**: a new, separate running total from Gold — never spent, tracked
in `progress.score`. After every level CLEAR (never a loss), the sum of
every surviving defender's *remaining* hp (not max — however much they
actually had left when the fight ended) is added to the running total via
`addScore()`. Dead defenders contribute 0 automatically (`Unit.health`
clamps at 0 in `takeDamage`, never negative), so summing `alive ?
health : 0` across `defenders` needs no separate filtering logic. Shown
always-visible in the topbar (🏆), floored the same way gold is.

## Two real UI/UX fixes from user feedback

**The upgrade shop's scroll bug — a genuine bug, not a tuning request.**
Diagnosed by actually measuring it (real headless screenshots at a
deliberately short 600px-tall viewport, not just staring at CSS): the
shop panel used to be a normal child in `#ui`'s flex column, with only
its *inner* upgrade list independently scrollable (`max-height: 50vh`).
On a tall enough panel — and by this round it had grown to 10 purchasable
things across 3 sections — the panel's total height (header + list +
action buttons) could exceed the viewport with **no outer scroll
mechanism at all** (`#ui`/`body` never scroll), pushing the bottom
portion — including the last upgrade row and the Close button — below
the visible viewport with literally no way to reach it, scrolling or
otherwise. Fixed by making `#shop-panel` a true `position: fixed`,
centered, `max-height: 85vh; overflow-y: auto` modal — ONE scroll region
for the whole panel (removed the old nested inner scroll, since nested
scrollable regions are their own source of janky UX) — completely
decoupling it from whatever else happens to be in the `#ui` flex column
above it. Verified with real measurements, not just a screenshot glance:
confirmed `scrollHeight` (845px) genuinely exceeds `clientHeight` (508px)
at the stress-test viewport, then confirmed both the last row
(`Archer Range`) and the Close button have `getBoundingClientRect()`
fully within `[0, window.innerHeight]` after scrolling to the bottom.

**Two reset buttons, both behind a real confirmation modal.** The old
single "Reset" button (top-right) had *no* confirmation at all, and the
old "Reset all progress" link (buried inside the shop panel) used the
browser's native `confirm()` — inconsistent, and a native dialog doesn't
match the game's own visual language. Replaced with `#reset-level-btn`
and `#reset-game-btn` in the topbar, both routed through one reusable
`#confirm-modal` component (`openConfirmModal(message, onConfirm)` /
`closeConfirmModal()`) — a proper centered, dimmed, `position: fixed`
overlay. Deliberately placed **outside** `#ui` entirely in the DOM (a
sibling, not a descendant) specifically so it can never inherit the same
class of containment bug that affected the shop panel — it's a true
top-level overlay independent of any other layout on the page. Reset
Level's message makes explicit that saved Gold/Score/upgrades are
unaffected (only the current in-progress placement/battle is lost); Reset
Game's message explicitly lists everything that gets wiped. Verified
end-to-end with real clicks: Cancel closes the modal with zero side
effects (confirmed via `localStorage` untouched); confirming Reset Game
genuinely clears the save (`localStorage.getItem(...)` returns `null`
afterward) and the reload correctly lands back on Level 1. The old
shop-embedded "Reset all progress" link was removed entirely now that
these two topbar buttons cover both reset scenarios — no more duplicate,
inconsistently-styled entry points for the same kind of action.

## Cliff-face bug: defenders could walk onto (and be placed on) sheer terrain

A real, confirmed bug with two independent root causes, not one — both
found by measuring actual game behavior rather than assuming the existing
checks were sufficient.

### Bug 1: defenders could walk onto a cliff face via guard mobility

Root cause: `enforceTerrainCollisions()` — the one function standing
between any unit and walking through non-walkable terrain — skipped every
unit with `stats.stationary === true`. That's both defender types. The
skip made sense the day it was written (before guard mobility existed:
"stationary" genuinely meant "never moves, so collision resolution is
pointless"), but became wrong the moment defenders gained the ability to
chase a target up to `DEFENDER_LEASH_RADIUS` from their home position
(`advanceDefenderWithinLeash`) — that movement does its own leash-radius
check and *zero* terrain-walkability check, relying entirely on
`enforceTerrainCollisions` to correct it afterward, which was being
skipped for exactly the units that needed it. Raiders never had this
problem because they move via real A* pathfinding, which only ever
routes across walkable tiles to begin with — they don't need position
correction after the fact the way a leash-driven direct-line movement
does.

**Fix**: removed the `stationary` skip; the collision pass now runs for
every living unit. A defender that's never left its placed (and already
validated-walkable) home position stays a safe no-op — nothing about the
common case changes.

**Verification, including proving the test could actually catch the
bug** (not just "ran clean once"): added a temporary debug hook exposing
every living unit's position and walkability, ran 3 full battles (45
position samples total) with the fix in place — 0 violations. Then, to
make sure a genuine regression wouldn't slip past silently, deliberately
re-reverted the fix and reran the identical test: it correctly flagged a
defender-position violation. Restored the fix, confirmed clean again.

### Bug 2: a defender could be *placed* directly on a cliff face

This one was more interesting — the `isWorldWalkable` check on the
placement click handler was already present and correct in isolation, so
the bug wasn't "a missing check," it was a raycasting ambiguity in how
the closest hit gets chosen. Sheer (cliff-face) tiles render as tall
boxes sitting directly next to the elevated plateau tile whose edge they
represent. With the fixed isometric camera angle, a ray aimed at what's
*visually* the cliff face can strike the corner of that neighboring
elevated tile first — marginally closer to the camera in true 3D space
even though the cliff wall is what's front-and-center on screen.
Confirmed directly, not theorized: a temporary debug hook projected the
real screen-space center of actual sheer tiles from generated levels and
raycast through that exact point the same way the game does — the
closest hit was consistently the adjacent walkable tile, with the sheer
tile itself as the very next-closest, only ~0.6 world units of ray
distance behind it.

**First fix attempt was too broad and had to be corrected.** The
instinct — reject the whole click if *any* hit within a margin of the
closest is non-walkable — is right in spirit, but the first version used
a margin of a full tile-width compared against raw ray distance. That's
too permissive: this fixed isometric camera's rays are long and oblique,
so within even a couple units of ray-distance a single ray can pass near
completely unrelated tiles elsewhere on the map (a forest on the far
side of the level, say), not just the tile actually near the click. That
version broke ordinary placement everywhere, not just cliffs — caught
immediately by `test-e2e.mjs` going from "6 population spent" to "0
population spent, phase stuck on Scouting" the moment it landed, which
is exactly the point of running the full suite after every change rather
than only testing the specific scenario being fixed.

**Working fix** uses two independent conditions together: the candidate
hit must be close in ray distance (`AMBIGUOUS_RAY_MARGIN = 1.0`,
comfortably above the observed ~0.6 real gap) *and* close in actual
(x, z) world position to the primary hit (`AMBIGUOUS_XZ_RADIUS = TILE_SIZE
* 1.2`) — genuinely the same click location, not a different point the
ray happens to also pass near. Only if both hold and that candidate is
non-walkable does the click get rejected.

**Verification**: reran the exact same precise sheer-tile-targeting
diagnostic after the fix (0/11 violations across 2 layouts, 27 on-screen
sheer tiles found), reran `test-e2e.mjs` to confirm ordinary placement
recovered (6 population spent, battle started normally), and ran a
broader grid of ~20 generic clicks across open ground to confirm the
fix's conditions aren't accidentally still too strict anywhere else on
the map (all 4 affordable placements succeeded, correctly stopping only
once population ran out — not because of any spurious rejection).

Neither fix touches pathfinding, the A* nav grid, raider behavior, melee
engagement, or any other movement system — both are narrowly scoped to
the two exact mechanisms responsible (the post-movement collision pass,
and the placement click's hit-selection logic).

## Wave types and predetermined level scheduling

The biggest feature added to date. Two things worth understanding before
anything else: **wave types are a second layer on top of the existing
evolution system, not a replacement for it**, and **level types are
committed in advance and never re-rolled**, which is what actually makes
them "predetermined" rather than just "decided a little early."

### Architecture: reuse, don't replace

Every wave type (Normal/Flying/Mass/Champions/Boss) is still, mechanically,
`new Unit("raider", ..., statsOverride)` — no new UNIT_STATS entries were
added. `getWaveStats(waveTypeKey, raiderEvolution)` in `progression.js`
computes the EXISTING evolved baseline first (`getRaiderCount`/
`getEvolvedRaiderStats`, completely unchanged), then layers a wave type's
count/HP/damage/speed/armor multipliers on top. This means the
compounding difficulty curve keeps working exactly as it did before this
round, regardless of level type — a wave type only reshapes THAT LEVEL's
threat profile; it doesn't touch the persistent run-long progression at
all. `levelGenerator.js` needed zero changes — it already accepted a
`totalRaiders` count and a `unitType` string, and every wave type just
passes different values into those same two parameters it always had.

**The armor problem repeated, and was handled the same way as before.**
Base raider armor is 0. "Champions get 50% armor" and "Boss gets 2x
armor" are both literal no-ops against a zero base for the exact reason
raider-evolution's armor step was made additive instead of multiplicative
last round. Same fix, same reasoning: `armorFlatBonus` in `WAVE_TYPES` is
additive, explicitly flagged as a placeholder-not-final number (as
requested), with a dedicated test confirming it's actually nonzero rather
than silently inert.

### Flying units: reused an existing fallback instead of building a
parallel movement system

This was the one part of the request that could have meant building an
entirely separate movement/pathfinding system for airborne units. It
didn't need to: `followPathToward` already had a "no path found → move
in a straight line" fallback (used whenever A* genuinely fails). Flying
units just take that branch unconditionally — `pickTargetByPathCost` and
`followPathToward` both check `unit.stats.flying` first and skip
pathfinding entirely rather than computing a path and discarding it. This
reuses code that was already correct and already tested, rather than
writing new movement logic with its own bugs to find.

- **Altitude**: `snapToTerrain` gained one branch — flying units are
  pinned to a fixed `FLYING_ALTITUDE` (2.2x a level's rise, comfortably
  above the tallest plateau) instead of looking up ground height. Every
  caller (spawn, path-following, guard-mobility, collision enforcement)
  gets this for free from the one change.
- **Cliff-transcendence**: `enforceTerrainCollisions` now skips flying
  units entirely — they're supposed to sit over sheer/forest tiles, so
  the pass that would otherwise push them back out is simply not run for
  them.
- **Separation**: `updateSeparation` skips any pair where exactly one
  unit is flying and the other isn't (different altitude, shouldn't
  physically jostle each other), while still separating same-altitude
  units normally so a cluster of flying raiders doesn't stack on one
  point mid-air.
- **Melee immunity**: `computeCanEngage` (meleeSlots.js) gained a
  `targetIsFlying` parameter — a melee attacker can never engage a flying
  target, full stop, checked before anything else. `isEngageableBy` in
  main.js got the same check, which mattered more than it might look:
  that function is what lets a stationary defender fall back to a
  reachable enemy instead of uselessly locking onto one it can never
  reach — with the flying check added, a Knight surrounded by flying
  raiders correctly recognizes it can't fight any of them (a genuine,
  intended strategic consequence: a level of all-Flying raiders
  effectively requires Archers, which is exactly what the Upcoming Levels
  panel is for).

**A real bug caught before it shipped, not by trusting the build.**
`endBattle`'s post-evolution recompute still called two functions
(`getRaiderCount`, `getEvolvedRaiderStats`) that had been removed from
the imports earlier in the same editing pass — a `ReferenceError` that
would only fire the first time any player actually won a level. `npm run
build` and `node --check` both passed anyway, because bundling/syntax-
checking doesn't execute the code path — this is exactly the class of bug
that only shows up by tracing through call sites or by actually running
the app. Fixed by routing through `getWaveStats` with the level about to
be played (`PROGRESS.level` after the post-win increment), not the one
just cleared.

**Verification included a case where the first read of the data was
wrong, and a baseline comparison caught it.** Watching flying raiders
close distance on Archers under a headless test, the observed rate
(~0.6 units/sec) looked alarmingly slow next to the raw configured speed
(~4 units/sec) — worth investigating before assuming it was fine. Rather
than guess, the same measurement was run against ordinary (non-flying,
pathfinding-driven, already long-proven-correct) raiders under identical
conditions: they closed distance at effectively the same rate. Multi-unit
separation dynamics and off-axis approach angles mean "closest pair
distance in an active battle" was never going to track a single unit's
top speed — that was a flawed intuition about the metric, not a bug in
flying movement. Flying raiders were, in fact, measurably faster (1.18x),
exactly matching the +10% speed modifier. Recorded here because "the
number looked weird, so I checked it against a known-good baseline
instead of guessing" is the actual habit that catches real regressions
elsewhere in this project, and it's worth being explicit that it applies
in the other direction too — not everything that looks wrong is wrong.

**What wasn't directly witnessed**: a full natural battle win under the
new wave-type/evolution-recompute code path. Battles in this game
regularly run past the 50-60s windows used in headless verification here
and throughout the project's history (documented repeatedly as
informational, not a failure) — several win attempts with heavily
favorable defender setups didn't resolve within the time available for
this round's verification. Confidence in the fix rests on: the specific
bug found is confirmed gone from source (grep), every new function on
that path is independently unit-tested (`getWaveStats`, `getLevelType`,
`ensureLevelTypeSchedule`, `evolveRaiders` — the last already proven
across many prior rounds), and extensive other headless testing exercised
large parts of `main.js` with zero runtime errors. This is real but
indirect evidence, not a substitute for eventually watching an actual
win happen — worth confirming in a future session if there's ever reason
to suspect something in that specific path.

### Predetermined level scheduling

`progress.levelTypeSchedule` is a simple append-only array — index 0 is
level 1's type (always `"normal"`, hardcoded, never randomized), and every
subsequent index is generated on first need and then permanent.
`ensureLevelTypeSchedule(progress, throughLevel)` extends it lazily and
is idempotent; `getLevelType` calls it internally so any query for a
level's type is guaranteed to return a real, already-committed value even
the first time that level is ever referenced. The critical property,
tested directly: calling `getLevelType` twice for the same level, with a
DIFFERENT rng function the second time, returns the identical result both
times — proving it reads a committed choice rather than re-rolling.
Extended by `LEVEL_TYPE_LOOKAHEAD` (5) levels at module init and again
after every win, and saved immediately whenever new entries are actually
generated, so a page refresh can never show different upcoming levels
than it did a moment ago.

Distribution (Normal 40%, remaining 60% split evenly across the other
four at 15% each) is verified with an actual 20,000-trial simulation in
`test-progression.mjs`, not just checked at the probability-table level.

### UI

Topbar now shows the current level's type next to the level number
("Level 2 · Flying"). A new bottom-right panel (mirroring the existing
bottom-left Stats panel's styling/positioning pattern) shows the next 5
scheduled levels with color-coded type labels — this is the direct
implementation of "give the player a chance to prepare." The Attackers
card in the Stats panel now labels itself with the current wave type
(e.g. "Raiders (Flying)") and automatically reflects whichever wave's
stats `effectiveRaiderStats`/`effectiveRaiderCount` currently point to —
no separate rendering logic needed, since those are the same variables
the panel already read before this round; only what they contain changed.

### Prepared for real per-type assets

`getUnitTexture` in `unit.js` now caches by an explicit `spriteVariant`
key (e.g. `"raider-flying"`) rather than by base unit type, specifically
because every wave type is still literally `"raider"` under the hood —
caching by type alone would have made every wave type render identically.
Each `WAVE_TYPES` entry carries its own placeholder `color` and
`sizeMultiplier` (Mass renders smaller, Champions and Boss render larger
— for free, since sprite scale and collision radius already derive from
`stats.size`, which wave types now modify like everything else). Swapping
in real per-type sprite sheets later is the same one-function change
`getUnitTexture` was already documented as being built for.

## Two real bugs from playtesting: Boss double-spawn, and target thrashing

Both found by actual play (not code review), both traced to their exact
root cause before touching anything, both fixed narrowly and verified
with real numbers from a live headless run rather than trusting the fix
by inspection alone.

### Boss levels spawning 2 units instead of 1

`generateIntruderSpawns` in `levelGenerator.js` picks a cluster count via
`Math.max(3, ...)` — a hardcoded floor of at least 3 clusters, dating
from before wave types existed, when `totalRaiders` was always
comfortably large. Boss always requests `totalRaiders=1`. Traced by hand
(and confirmed with a small Node script simulating the exact algorithm)
before writing any fix: with `clusterCount` forced to 3 and only 1 raider
of actual budget to distribute, the per-cluster sizing loop's own
"at least 1 per cluster" floor (`Math.max(1, ...)`) claims 1 for the
first cluster, then 1 AGAIN for the second (since the loop doesn't know
the total budget is already exhausted), leaving the third cluster's
`remaining` budget negative — which the spawn loop silently skips rather
than erroring. Net result: 1 (cluster 1) + 1 (cluster 2) + 0 (cluster 3,
skipped) = 2 raiders spawned from a `totalRaiders=1` request, with no
visible error anywhere in the pipeline.

**Fix**: `clusterCount` is now also capped at `Math.min(totalRaiders,
...)`, so it can never exceed the actual number of units available to
distribute — a cluster with 0 members is meaningless, and once
`clusterCount <= totalRaiders` is guaranteed, the "at least 1 per
cluster" floor can no longer push `remaining` negative (verified by
induction, not just by testing: with that invariant holding, every
cluster's minimum claim of 1 is always affordable). The existing
`Math.max(3, ...)` tuning for ordinary-sized levels (10, 24, 71 raiders —
the sizes this was actually tuned around) is completely unchanged; the
fix only ever *reduces* cluster count, and only when `totalRaiders < 3`.

Verified two ways: (1) a standalone Node simulation of the exact formula
swept across `totalRaiders` 1 through 71 and 5 different rng values,
confirming the total spawned always matches the request and no cluster
size ever goes negative; (2) a new permanent regression block in
`test-generator.mjs` generating 100 real levels (5 small counts x 20
seeds each) through the actual generator and checking `intruderSpawns
.length` exactly matches what was requested. Also confirmed live: 8
separate headless Boss-level loads (different random layouts each time)
all spawned exactly 1 unit, checked against the real scene population
count via a temporary debug hook, not the requested count (which would
have shown "1" correctly even with the bug still present, since the bug
was purely in the generator's actual output, not in what was requested).

### Slow, heavily-focused-fire units (Boss/Champions) getting stuck
switching targets and never attacking

Reported precisely: attacked by several defenders at once, a slow unit
would repeatedly pick a new target — visibly "stuck, shaking, switching
targets" — because reactive aggro was firing on every hit that didn't
already have a fight actively underway. `applyDamage`'s aggro-switch used
to trigger whenever `!target.isMeleeEngaged` — a flag that's only `true`
once a unit is ALREADY in range and exchanging blows. For a slow unit
still closing the distance (or a Champion/Boss getting focused by
multiple defenders before it ever arrives anywhere), every stray hit from
a third party redirected it toward whoever just hit it, resetting its
approach before it could ever reach anyone — repeatedly, indefinitely,
for as long as it kept taking incidental fire while still traveling.

This also affected mobile RANGED units in a way that hadn't been visible
yet: `isMeleeEngaged` is only ever `true` for melee attackers by
definition, so a Flying raider — mobile and ranged — could have been
reactively redirected on every single hit even while it was ALREADY
mid-volley against something, since the flag protecting melee units from
this never applied to it in the first place.

**Fix**: the suppression condition changed from "is this unit currently
mid-melee-combat" to "does this unit already have a live target at all" —
`hasCommittedTarget = !!target.target && target.target.alive`. This is a
strict superset of the old check (every melee-engaged unit necessarily
has a live target; having one doesn't require being melee-engaged yet),
so it fixes both the slow-unit-thrashing case and the flying-ranged-unit
case with the same change, and applies uniformly to every raider type —
this lives in shared combat logic, not anything wave-type-specific.
Reactive aggro still works exactly as intended for its original purpose
(a unit with NO current target, or whose target just died, still goes
after whoever hits it) — it just no longer overrides an already-chosen,
still-alive target. The existing stuck-timeout watchdog
(`updateStuckWatchdog`) remains the safety net for a genuinely
unreachable target — it clears the target after a real no-progress
timeout, triggering a fresh, properly path-cost-evaluated re-target,
which is a more principled recovery than "whoever last happened to hit
me" ever was.

The now-unused `isMeleeEngaged` field was removed entirely (both where it
was set in `updateBattle` and its declaration in `Unit`'s constructor) —
it had exactly one remaining reader before this fix, and that reader is
gone, so keeping a write-only field around would just be misleading dead
state for the next person reading this code.

Verified live: 2 Champion units tracked by target-ID over a real 30-second
headless battle against 5 simultaneously-placed defenders (the exact
"focused fire on a slow unit" scenario reported) — both held the identical
target for the entire window, zero target switches recorded while either
had a live target. Full test suite and e2e rerun clean after both fixes.

## City health — replacing binary win/lose with a persistent, gradual stake

The old rule was blunt: every defender dies, the level is instantly lost.
City health replaces that with a third outcome — defenders wiped, but the
city (a persistent, run-long resource) absorbs the blow and the run
continues, as long as it doesn't fully deplete. Designed and discussed
before implementation specifically because it changes the fundamental
win/lose shape of the game, not just adds a system on top of it.

### The damage formula gives type-adjustment for free

Confirmed with the person before building anything: each raider that
reaches the city deals `(itsCurrentHP / totalWaveHP) × 80% × cityMaxHP`.
`totalWaveHP` is `count × per-unit max HP` for that level's wave — the
exact same quantity a Boss's own HP is already built from (see the wave-
types section above). This is why the formula needs no per-type
multiplier table at all: sum it across every raider in a wave, each at
full health, and it always collapses to exactly 80% of max, regardless of
whether the wave was 20 Mass raiders, 4 Champions, or 1 Boss — because
each raider's HP is definitionally some fraction of that same total. A
Boss (which by definition already holds the wave's entire HP budget in
one unit) reaching the city at full health deals the full 80% in a single
hit, automatically. Proven directly, not just asserted: `test-progression
.mjs` sums the formula across a 10-Normal-raider wave AND a completely
different 2-Champion wave (different count, different per-unit HP
entirely) and confirms both independently total exactly 80.

### Persistence is the point

`progress.cityHealth` (0-100, a percentage) carries across the whole run
and **never automatically heals** — a deliberate design choice, since
that's what makes a "cityDamaged" outcome mean something lasting rather
than just a different animation on the way to the same clean-slate next
level. Game over is `cityHealth <= 0.1` (a person can always start a new
level above that threshold, per spec — "as long as there is more than
0.1% health"). An old save from before this feature loads at FULL health,
not a pre-destroyed city (tested explicitly) — there's no sensible
alternative default for a save that predates the concept of city health
entirely.

### Implementation: reuse everything possible, touch nothing else

The explicit instruction going in was "be careful not to touch the battle
logic and pathing for that part," and the design leans hard on reuse
specifically because of that:

- **Movement**: raiders marching on the city use `followPathToward`
  completely unmodified. `CITY_TARGET` is a small stand-in object — NOT a
  real `Unit` — shaped just enough (`.mesh.position`, `.alive`) for the
  existing targeting/movement functions to handle it with zero changes to
  those functions. Its position is the same "just outside the city's
  edge" point already used and proven reachable by the generator's own
  internal validation.
- **Targeting**: raiders only ever fall back to `CITY_TARGET` inside the
  EXISTING target-reacquisition block, in one small additive branch,
  gated on `unit.team === "intruder" && !defenders.some((d) => d.alive)`
  — this can structurally never fire while even one defender survives,
  since target reacquisition would already have found that defender.
- **Combat loop**: city-marching is handled by one small, early,
  self-contained branch (`if (enemy === CITY_TARGET) { ...; continue; }`)
  placed BEFORE the melee-slot/engagement/attack code, which is completely
  unreachable for a city-targeting raider — none of that logic runs
  differently, or at all, for this case. Raiders don't "attack" the city;
  they're removed on arrival via the exact same fade-and-destroy pipeline
  every combat death already uses (`startDeathFade` → `updateDyingUnits`
  → `unit.destroy`) — "vanish" is the same smooth shrink-out already used
  for dying in combat, not new animation code.
- **Outcome detection**: the old immediate `!defendersAlive →
  endBattle(false)` check is gone. The only trigger left is
  `!intrudersAlive` (every raider either died in combat earlier or
  reached the city) — at that point, a surviving defender GUARANTEES zero
  city damage happened this level (the targeting branch above could never
  have fired), which makes the three-way outcome a simple, provably
  correct branch: `defendersAlive → "victory"`, else
  `isCityDestroyed(PROGRESS) → "gameOver"`, else `"cityDamaged"`.

### Design decision made without an explicit spec, flagged directly to
the person building this with me

Whether "cityDamaged" (defenders wiped, city survives) should still grant
the level-clear gold reward, interest, and raider evolution — same as a
clean victory — wasn't specified. Implemented as: yes, it does, with
honest "Your Defenders Have Fallen…" messaging instead of "City
Defended!". Score naturally comes out lower on its own without any
special-casing (it's literally the sum of surviving defenders' HP, and
there are none in this outcome), which already provides a real,
mechanical consequence for losing every defender even though the level
still concludes and advances.

### Game over resets EVERYTHING, deliberately

"Play Again" on the game-over screen performs a full `resetProgress()` —
functionally identical to the topbar's "Reset Game" button, just without
a confirmation modal first (the run has already, unambiguously ended;
there's no "accidentally throwing away progress" risk to guard against
here). This was a deliberate choice, not an oversight: if gold/upgrades/
evolution persisted through a game over while only city health reset, a
person could immediately re-enter a fresh level 1 with everything they'd
already accumulated intact, which would make city-health depletion a
non-consequence rather than the terminal one it's meant to be.

### Visual feedback

A dedicated, prominent health bar (color-tiered green/yellow/red by
threshold) sits directly below the topbar — not a small text number
tucked in with everything else, given this is now the single stat that
ends the run. Updates live, per-raider, as each one arrives during
battle, not just once at the end of a level. A distinct orange "-X%"
floating number (reusing the existing damage-number float-and-fade
system, not a new one) marks each individual city hit, visually separate
from yellow combat-damage numbers so a city hit reads as a different KIND
of event.

### Verification

Beyond the unit tests: forced a real defenders-wiped scenario (seeded
heavy evolved damage so a lone Knight died quickly, without touching
anything about pathing or arrival timing — just how fast combat itself
resolved) and watched it play out completely. Real numbers, not
assumptions: `cityDamageDealtThisLevel: 76.83` (correctly just under the
80 maximum, since some raiders had taken partial damage from the Knight
before it died), `cityHealth: 100 - 76.83 = 23.17` — exact arithmetic
match — with the correct "Phase: City Damaged" outcome and messaging
shown. Separately and explicitly confirmed the regression that mattered
most: with defenders alive, real gameplay across a live battle never
produces a single raider with `target === CITY_TARGET`, and city health
never moves from 100 — not inferred, checked directly against live game
state. Also confirmed the targeting mechanism holds up across several
different randomly-generated map layouts, and confirmed the Game Over →
"Play Again" path performs a genuinely complete reset (level 1, city
100%, gold 0, all purchases and evolution zeroed) by inspecting the real
post-reload state, not just the code path.

## Boss/Champions couldn't land hits: a fixed-size assumption baked into the melee slot system

Reported precisely: "Bosses can not attack at all... deals no damage,"
and "Champions struggle to get in place to attack, but can do damage" —
with a correct hunch attached ("something about range of the 'melee'
unit"). Traced to its exact root cause before touching anything, same
discipline as the last two bugs.

### Root cause

The melee attack-slot ring (`meleeSlots.js`'s `computeSlotRing`) sizes
itself from the ATTACKER's collision radius so multiple attackers fit
around a target without overlapping. `main.js` used to pass a fixed
constant, `MELEE_ATTACKER_RADIUS_ESTIMATE = 0.4`, regardless of which
raider was actually attacking. That was a reasonable approximation back
when every raider was the same size — but wave types introduced a real
`sizeMultiplier` per type (Champions 1.3x, Boss 1.8x — see the wave-types
section above), and the fixed estimate never accounted for it. Computed
directly, not guessed: the base raider's REAL collision radius is
`0.5175` (already a bit more than the 0.4 estimate assumed), Champions'
is `0.673`, Boss's is `0.932` — more than double the fixed estimate.

The consequence: a Boss got assigned a slot position sized for a body
roughly half its real bulk. When it tried to actually stand there, its
OWN separation/collision resolution (which correctly uses its real,
larger `collisionRadius`) kept physically shoving it back out — it could
never settle within its actual attack range (1.3), so `canEngage` never
became true, and it just stood there, facing its target, forever failing
to attack. Champions had the same problem to a smaller degree (a smaller
size mismatch), which is exactly why they "struggled" rather than being
completely unable to engage — sometimes managing to settle close enough
despite the bad assumption, sometimes not.

### Fix

Extracted the collision-radius formula (`(Math.max(w,d)/2) * 1.15`) out
of `Unit`'s constructor into a shared, exported `computeCollisionRadius
(stats)` in `unit.js`, used in BOTH the constructor and, now, `main.js`'s
melee-ring setup — specifically so the two can never drift apart the way
a fixed-constant approximation and reality just did. `main.js` now
computes `meleeAttackerRadiusEstimate` from `effectiveRaiderStats`
(whichever wave type is actually fighting this level) at module init, and
recomputes it alongside `totalWaveHealth` after evolution in `endBattle`.
Since a level has exactly one wave type, every raider attacking within
that level really does share the same size — no per-attacker variation
to account for, so a single per-level value is correct, not an
approximation.

The pre-existing `MELEE_RING_MAX_RADIUS` cap (documented in
`meleeSlots.js` as protecting against a DIFFERENT class of the same
underlying problem — a large TARGET pushing the ring past attack range)
continues to do its job unchanged: it still caps the ring so a unit at
its assigned slot is always within real attack range, regardless of how
big the attacker is. The fix generalizes an existing, already-understood
safeguard to correctly account for attacker size too, rather than
inventing a new mechanism.

### Verification

`test-melee-slots.mjs` gained a dedicated regression section: computes
real collision radii for Normal/Champions/Boss-sized attackers via the
same formula production code uses, confirms Champions' and Boss's are
meaningfully larger (locking in the actual size relationships, not just
that SOME fix exists), and confirms the resulting ring radius stays
within real attack range for every size — the property that was silently
broken before. Also explicitly quantifies the bug's root cause (the old
fixed 0.4 estimate really was less than half the Boss's real size), so
this test would fail again if anyone ever reintroduces a fixed constant
here.

Beyond the unit tests: a live headless battle with a Boss level and
border-placed defenders ran to completion — the Boss successfully closed
distance, engaged, and killed both defenders outright, which is only
possible if it actually landed damage repeatedly (confirmed via real
game state, not inferred). A separate live run confirmed Champions
dealing real damage too (defender HP dropped from 300 to 271.6 over the
course of a battle). One test run showed a Boss still mid-approach at
the time budget's end on a particularly long/slow path — expected and
unrelated to this bug: Boss is deliberately -60% speed, so how long it
takes to physically ARRIVE varies a lot by map layout; that's a separate,
known balance characteristic (already flagged as not-yet-tuned), not a
symptom of the melee-engagement bug being investigated here.

## Boss still couldn't attack (round 2): the real fix, plus slot capacity and evolution weighting

The previous round's fix (correcting the melee-ring's attacker-size
estimate from a stale fixed constant to each level's real attacking
raider size) was necessary but not sufficient — reported as still broken,
and investigating further revealed it had actually made the underlying
tension *worse* for large attackers rather than resolving it.

### The real root cause: the range-based ring cap conflicts with physical
size for ANY attacker, not just Boss

Computed directly (not guessed) before touching anything:

| | Knight radius + attacker radius + gap ("needed") | Ring cap |
|---|---|---|
| Normal | 1.415 | 1.2 |
| Champions | 1.570 | 1.2 |
| Boss | 1.829 | 1.2 |

The melee-slot ring is capped at `raider.range - 0.1` (1.2) specifically
so a unit standing at its assigned slot is always close enough to attack
— a real, previously-fixed bug (see `meleeSlots.js`'s own comment
history) protects against the ring extending PAST attack range. But that
cap can end up SMALLER than the physically-required no-overlap distance
between an attacker and its target, and — this was the missing piece —
that's true even for a Normal raider (1.415 > 1.2), just by a small
enough margin that separation force could mostly paper over it without
visibly blocking engagement. Boss's deficit (0.63 units of forced
overlap) was severe enough to be unresolvable: separation kept shoving it
back out of its assigned slot indefinitely, since standing anywhere
within actual attack range required overlapping the target more than its
own collision resolution would ever allow.

**Fix**: `updateSeparation` now skips the pair between a unit and its OWN
currently-held melee-slot target (`if (other === unit.meleeSlotTarget)
continue;`) — standing at melee range inherently means being close enough
that some physical overlap is normal, and that's not something a
generic, target-agnostic separation pass should fight against. This
resolves the conflict for every raider size uniformly (not a per-type
numeric patch), and only skips separation against the ONE specific
target a unit is engaged with — separation between that unit and
everyone else, including other raiders sharing the same target's ring,
still applies normally.

### Verified with the actual mechanism isolated, not just longer waits

Live headless testing kept getting confounded by an unrelated variable:
Boss is deliberately -60% speed, and a couple of test runs happened to
spawn it very far from any defender, so 100+ seconds of real time weren't
enough to physically arrive — the distance was closing smoothly and
monotonically the entire time (a genuinely different signal from the
original bug's stuck-oscillation pattern), just slowly. Rather than keep
burning time on unlucky map layouts, a temporary debug hook teleported
the Boss directly adjacent to its target, isolating the ENGAGEMENT
mechanics from the (already understood, not buggy) travel-time variable:
the Boss reserved a melee slot on the very first frame checked and dealt
real damage (150 → 144.8 HP) within 4 seconds. Decisive, direct
confirmation of the actual fix, not an inference from a battle that
happened to resolve.

### Slot capacity increased

Per request — `computeSlotRing`'s `gap` parameter tightened from the
default 0.1 to 0.02, letting a few more attackers fit around the same
ring simultaneously. Doesn't change how much physical space each
attacker's own body needs (still the real collision radius via
`meleeAttackerRadiusEstimate`), only the breathing room between adjacent
attackers' slots.

### "Focus nearest, only reroute if no room" — already existed, just
unreachable

Investigated before building anything new: this exact behavior was
already implemented (`ARRIVAL_RESERVE_DISTANCE`/`AVOID_REJECTED_TARGET
_TIME` — a raider that fails to reserve a slot upon arrival marks that
target as temporarily avoided and re-picks). It was simply unreachable
for Boss/Champions, since they could never physically get within
`ARRIVAL_RESERVE_DISTANCE` in the first place due to the separation
conflict above. No new targeting logic was needed — fixing the
underlying movement issue makes the existing, already-correct logic
reachable again.

### Raider evolution weighted, not uniform

`evolveRaiders` now does a single weighted roll against cumulative
thresholds (same pattern as `pickRandomWaveType`) instead of a uniform
1-in-5 pick: Numbers/HP/Damage 25% each, Attack Speed 15%, Armor 10% —
per request, with the reasoning that Armor's occasional no-op-against-a-
zero-base issue (see the armor-evolution section above) shouldn't come
up as often as the stats that always meaningfully matter. Verified
against a 20,000-trial simulation landing within 1% of every documented
weight, and a hard-sum-to-1 check so a future retune that doesn't add up
gets caught immediately.

### Tuning

Attack speed reduced ~25% a SECOND time (Knight 0.75→0.56, Archer
0.9→0.68, Raider 0.98→0.74, Catapult 0.41→0.31) — cumulative with the
identical request from several rounds earlier, flagged directly to the
person requesting it in case it was an unintentional repeat rather than
an intentional further reduction. Archer range reduced by a flat 2
(9→7).

## File structure
- `index.html` — page shell + UI overlay (loading screen, topbar with reset
  button, unit selector, instructions, result banner)
- `src/style.css` — styling for the UI overlay and loading screen
- `src/main.js` — scene setup (fixed orthographic camera, sized from the
  generated level), tile-based ground/forest/city rendering, placement
  logic, battle simulation loop (targeting, attack slots, combat
  resolution — preserved verbatim through the tile rewrite), and
  `bootstrap()` that ties scene population together
- `src/unit.js` — `Unit` class (sprite-based rendering), `UNIT_STATS`,
  elevation-bonus + armor math, target/path/melee-slot state
- `src/projectile.js` — arcing projectile visual for ranged attacks
- `src/pathfinding.js` — generic A* + string-pulling smoothing (unchanged
  by the tile rewrite; DDA/supercover grid-traversal fix in `smoothPath`
  applies regardless of what obstacle representation feeds it)
- `src/tileTerrain.js` — tile grid data model: elevation levels, tile
  kinds (GROUND/RAMP/SHEER/FOREST/CITY), plateau/forest/city stamping,
  world<->tile coordinate conversion, elevation-bonus/melee-block helpers.
  Replaces the deleted `src/terrain.js` (continuous heightmap system).
- `src/random.js` — seeded PRNG (still used for level generation);
  `createFbm2D` (Perlin/fbm noise) is currently unused now that ambient
  terrain noise is gone, kept as a general-purpose utility
- `src/levelGenerator.js` — procedural level generation + reachability
  validation/retry/fallback, tile-based (plateaus/forests stamped onto a
  `tileTerrain.js` grid instead of continuous parameters)
- `src/meleeSlots.js` — pure attack-slot geometry (ring sizing, assignment,
  world positions) — untouched by the tile rewrite, terrain-agnostic
- `src/progression.js` — level difficulty scaling, population budget, the
  persistent Gold economy, upgrade math, and localStorage save/load — pure
  logic, no Three.js/DOM dependency
- `src/assets.js` — GLTF loading infrastructure, currently unused
  (`MODEL_NAMES` emptied — see MAJOR REWRITE section above)
- `public/models/*.glb` — the 60 old Kenney assets, unreferenced by any
  code, left on disk pending cleanup or reuse decision
- `test-pathfinding.mjs` — core A*/smoothing/collision algorithm tests
  (tile-based illustrative fixture, built from real `tileTerrain.js`
  stamping functions, not tied to any specific generated level)
- `test-generator.mjs` — level generator tests across many seeds
  (tile-grid-aware: counts FOREST/RAMP/SHEER tiles directly)
- `test-melee-slots.mjs` — pure attack-slot geometry tests
- `test-progression.mjs` — difficulty scaling, upgrade math, and
  localStorage persistence round-trips (with an in-memory localStorage
  polyfill so the real code path runs under Node)
- `test-e2e.mjs` — real headless-browser end-to-end test (heavier — see its
  header comment for setup)

## Working style
- Build in small, testable increments — after any nontrivial change, run
  `npm run build`, then the relevant `test-*.mjs` files, before handing it
  back for playtesting.
- After any change touching scene bootstrap, asset loading, level
  generation wiring, or the placement/battle UI flow specifically, run
  `test-e2e.mjs` too — it's the only check that exercises real runtime
  execution, and has already caught a bug (a stale function-signature call
  site) that build success and isolated unit tests both missed.
- Keep placeholder-quality graphics (boxes, flat colors) until gameplay is
  validated; don't invest in visuals prematurely. (Superseded in part now
  that real Kenney assets are integrated for environment — this still
  applies to unit/character models, which remain primitives.)
- Levels are now procedurally generated — when adding a new unit type,
  follow the existing patterns in `UNIT_STATS`; when adjusting level rules,
  the parameters live in the `generateLevel()` call in `main.js`, not
  hardcoded level data.
