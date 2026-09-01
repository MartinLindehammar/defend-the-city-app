import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Unit, UNIT_STATS, computeCollisionRadius } from "./unit.js";
import { Projectile } from "./projectile.js";
import { buildNavGrid, findPath, smoothPath } from "./pathfinding.js";
import { generateLevel } from "./levelGenerator.js";
import { computeSlotRing, pickBestFreeSlot, slotWorldPosition, computeCanEngage } from "./meleeSlots.js";
import { MODEL_NAMES, preloadAssets, spawnModel, randomOf, getModelParts } from "./assets.js";
import {
  computePopulationBudget,
  BASE_POPULATION,
  POPULATION_PER_PURCHASE,
  getPopulationUpgradeCost,
  purchasePopulation,
  GOLD_INTEREST_RATE,
  applyGoldInterest,
  computeGoldReward,
  addScore,
  CITY_MAX_HEALTH,
  CITY_DAMAGE_FRACTION_PER_FULL_WAVE,
  applyCityDamage,
  computeCityDamage,
  isCityDestroyed,
  RAIDER_EVOLUTION_LABELS,
  evolveRaiders,
  LEVEL_TYPES,
  LEVEL_SPECS,
  LEVEL_TYPE_LOOKAHEAD,
  ensureLevelSchedule,
  getLevelType,
  getLevelSpec,
  getWaveStats,
  UPGRADES,
  getUpgradedStats,
  getUpgradeCost,
  purchaseUpgrade,
  loadProgress,
  saveProgress,
  resetProgress,
} from "./progression.js";
import {
  TileType,
  TILE_SIZE,
  LEVEL_HEIGHT,
  getTileType,
  getTileLevel,
  isRampEdge,
  isTileWalkable,
  isWorldWalkable,
  getWorldLevel,
  worldToTile,
  tileToWorldCenter,
  isMeleeBlockedByElevation,
  inBounds,
} from "./tileTerrain.js";
import {
  ITEM_TIERS,
  ITEMS,
  MAX_ACTIVE_ITEMS,
  rollItemDrop,
  addDroppedItem,
  countActiveItems,
  setItemActive,
  getActiveItemKeys,
  applyItemBonuses,
  computeGlobalItemBonuses,
} from "./items.js";
import {
  isBackendConfigured,
  loadPlayerName,
  submitScore,
  fetchTopScores,
  submitFeedback,
  MAX_NAME_LENGTH,
} from "./backend.js";
import { initAnalytics, track, EVENTS } from "./analytics.js";
import "./style.css";

// ---------- Meta-progression: which level, banked Gold, upgrades ----------
// Loaded once at module init from localStorage — see progression.js for
// the persistence format and the reasoning behind when saves happen.
const PROGRESS = loadProgress();
const CURRENT_LEVEL = PROGRESS.level;

// Analytics is initialised before anything else that might report an
// event, and is a complete no-op when no project key is configured (see
// analytics.js) — so this line is safe in local dev with no .env file.
initAnalytics();

// Levels are predetermined well in advance (see progression.js) so the
// player can see what's coming and prepare — this call is what actually
// locks in any not-yet-generated upcoming levels the first time they'd
// be needed. Saved immediately if anything new was generated, so the
// choice is genuinely permanent from this point on, not just "decided a
// little early" — a page refresh right now must show the exact same
// upcoming levels as before.
if (ensureLevelSchedule(PROGRESS, CURRENT_LEVEL + LEVEL_TYPE_LOOKAHEAD)) {
  saveProgress(PROGRESS);
}
const CURRENT_LEVEL_TYPE = getLevelType(PROGRESS, CURRENT_LEVEL);
const CURRENT_LEVEL_SPEC = getLevelSpec(PROGRESS, CURRENT_LEVEL);

// Raiders no longer scale off the level number directly — their strength
// comes from raiderEvolution (a random stat permanently boosted 20% once
// per CLEARED level, regardless of level type/spec — see progression.js)
// layered with THIS level's type (Normal/Mass/Champions/Boss — count and
// tankiness) AND spec (None/Flying/Evasion/Pierce Resistance/Rush — a
// special ability, independent of type). Computed once per page load
// here; recomputed live after a fresh evolution event on victory (see
// endBattle) so the stats panel can preview next level's numbers without
// needing a reload.
let effectiveRaiderWave = getWaveStats(CURRENT_LEVEL_TYPE, CURRENT_LEVEL_SPEC, PROGRESS.raiderEvolution);
let effectiveRaiderCount = effectiveRaiderWave.count;
let effectiveRaiderStats = effectiveRaiderWave.stats;
// The whole wave's HP budget (count x per-unit max HP) — what a Boss's
// own single HP is already built from, and what the city-damage formula
// below (see applyCityArrival) divides each raider's remaining HP by to
// get its proportional, automatically-type-adjusted contribution.
let totalWaveHealth = effectiveRaiderCount * effectiveRaiderStats.maxHealth;
// How much physical space THIS level's actual attacking raiders need —
// used to size the melee attack-slot ring around a defender (see
// MELEE_ATTACKER_RADIUS_ESTIMATE below). Level types with a size
// multiplier (Champions, Boss) need a meaningfully bigger ring than the
// base raider; this is what makes that correct instead of assuming every
// raider is the same small size. Specs never change size.
let meleeAttackerRadiusEstimate = computeCollisionRadius(effectiveRaiderStats);
// Tracks whichever level's type/spec the variables above currently
// reflect — CURRENT_LEVEL_TYPE/CURRENT_LEVEL_SPEC at first load, the NEXT
// level's after a win (see endBattle) — purely for labeling the
// Attackers card in the stats panel.
let displayedLevelType = CURRENT_LEVEL_TYPE;
let displayedLevelSpec = CURRENT_LEVEL_SPEC;

// ---------- Level generation ----------
// The whole map — dimensions, terrain tiles, and where raiders spawn — is
// procedurally generated and validated (every spawn point is confirmed
// reachable via real A* before this level is accepted; see
// levelGenerator.js for the retry/fallback logic). Raider count comes
// from the evolution+wave-type system above; starting population from
// the population upgrade below. The LAYOUT is randomized fresh every
// attempt regardless. Every wave type still spawns as the plain "raider"
// archetype (unitType stays "raider" always) — a wave type only changes
// HOW MANY spawn and what statsOverride they're given at spawn time (see
// spawnIntruders), not the generator's own logic at all.
const LEVEL = generateLevel({
  seed: Date.now(),
  totalRaiders: effectiveRaiderCount,
  startingPopulation: computePopulationBudget(CURRENT_LEVEL, PROGRESS.populationPurchases),
});

const MAP_WIDTH = LEVEL.mapWidth;
const MAP_DEPTH = LEVEL.mapDepth;
const STARTING_POPULATION = LEVEL.startingPopulation;
const TILE_GRID = LEVEL.grid;
const LEVEL_1_INTRUDERS = LEVEL.intruderSpawns;
const CITY_ZONE = LEVEL.cityZone;
const BORDER_X = LEVEL.borderX;

// A lightweight, stable stand-in for "the city" as a combat-loop target —
// deliberately NOT a Unit, just an object shaped enough like one
// (`.mesh.position`, `.alive`) for the EXISTING targeting/movement
// functions (faceToward, distanceTo, followPathToward) to treat it
// exactly like any other target with zero changes to those functions.
// `.alive` is permanently true so a raider marching toward it is never
// mistaken for "my target died, go find a new one." Position is the same
// "just outside the city's edge" point already used and proven reachable
// by the generator's own internal validation (see levelGenerator.js's
// isReachable) — raiders converge on one fixed gate point rather than
// scattering across the whole city footprint.
const CITY_TARGET = {
  mesh: { position: new THREE.Vector3(CITY_ZONE.xMax + TILE_SIZE, 0, (CITY_ZONE.zMin + CITY_ZONE.zMax) / 2) },
  alive: true,
  id: -1,
};
const CITY_ARRIVAL_DISTANCE = 1.5;

// Base UNIT_STATS plus any permanently-purchased upgrades AND any
// currently-ACTIVE backpack items, computed once per page load from the
// loaded save. Recomputed live (see the shop's buy handler and the
// backpack panel's activate/deactivate handler below) if a purchase or an
// item toggle happens before any unit has been placed this level, so a
// pre-placement visit to either panel takes effect immediately without
// needing a reload. Raiders always use base UNIT_STATS directly (plus
// wave-type/evolution — see effectiveRaiderStats) — upgrades and items
// only ever apply to defenders. Upgrades and items are two independent,
// multiplicatively-combined power layers — see items.js's
// applyItemBonuses for why this mirrors getWaveStats' own
// evolution-x-wave-type layering.
function computeEffectiveStats() {
  const activeItemKeys = getActiveItemKeys(PROGRESS);
  return {
    knight: applyItemBonuses(getUpgradedStats("knight", PROGRESS.purchases), "knight", activeItemKeys),
    archer: applyItemBonuses(getUpgradedStats("archer", PROGRESS.purchases), "archer", activeItemKeys),
    mage: applyItemBonuses(getUpgradedStats("mage", PROGRESS.purchases), "mage", activeItemKeys),
  };
}
let effectiveStats = computeEffectiveStats();
// The two account-wide item effects that aren't about any one defender
// type (Aegis of the City's cityDamageReductionPercent, Midas' Hoard's
// goldGainPercent) — recomputed alongside effectiveStats, at the same
// call sites, since both only ever change when active items change.
let globalItemBonuses = computeGlobalItemBonuses(getActiveItemKeys(PROGRESS));

// Upgrades and item activation are now allowed any time a level isn't
// actively running (see refreshShopVisibility/canModifyBackpack), rather
// than only before the first unit is placed — so a purchase or item
// toggle can legitimately happen after some defenders are already on the
// field. Without this, those already-placed units would keep stale stats
// while newly-placed ones of the same type used the new numbers: two
// different "Knights" simultaneously. Called right after `effectiveStats`
// is recomputed (both the shop's buy handler and afterItemActivationChange)
// to push the new numbers onto every currently-placed defender immediately.
// Safe to reset health straight to the new max: this only ever runs
// outside phase "battle", and a defender can only take damage during
// battle, so every placed defender is guaranteed to still be at full
// health when this fires.
function resyncPlacedDefenderStats() {
  for (const unit of defenders) {
    if (!unit.alive) continue;
    unit.stats = effectiveStats[unit.type];
    unit.health = unit.stats.maxHealth;
    unit._refreshHealthBar();
  }
}

if (LEVEL.fallback) {
  console.warn(
    `Level generation fell back to the guaranteed-safe layout after ${LEVEL.attempt} failed attempts (seed ${LEVEL.seed}). This should be rare — worth investigating if it happens often.`
  );
}

// ---------- Terrain height ----------
// Elevation is now a tile lookup, not a continuous sample — a unit's
// height is just its tile's level times the world-unit rise per level.
function getTerrainHeight(x, z) {
  return getWorldLevel(TILE_GRID, x, z) * LEVEL_HEIGHT;
}

// Comfortably above the tallest sheer wall/plateau (LEVEL_HEIGHT is one
// level's rise; 2.2x that clears even a unit standing right at a
// plateau's edge) — a flying unit's whole point is that terrain doesn't
// apply to it, so it always renders at this fixed altitude regardless of
// what's underneath, never looked up from the tile grid at all.
const FLYING_ALTITUDE = LEVEL_HEIGHT * 2.2;

function snapToTerrain(unit) {
  if (unit.stats.flying) {
    unit.mesh.position.y = FLYING_ALTITUDE + unit.halfHeight;
    return;
  }
  const h = getTerrainHeight(unit.mesh.position.x, unit.mesh.position.z);
  unit.mesh.position.y = h + unit.halfHeight;
}

// ---------- Navigation (A* pathfinding) ----------
// pathfinding.js is completely unchanged from the pre-tile system — it
// was always a generic grid consumer. The tile grid's own walkability IS
// the nav grid's obstacle data now; no separate geometric sampling step
// needed (previously the nav grid had to approximate continuous terrain).
const navGrid = buildNavGrid({
  mapWidth: MAP_WIDTH,
  mapDepth: MAP_DEPTH,
  cellSize: TILE_SIZE,
  isBlocked: (x, z) => !isWorldWalkable(TILE_GRID, x, z),
});

function computePathToPoint(unit, point) {
  const raw = findPath(navGrid, unit.mesh.position, point);
  if (!raw) return null;
  return smoothPath(navGrid, raw);
}

function computePathTo(unit, target) {
  return computePathToPoint(unit, target.mesh.position);
}

// ---------- Scene setup ----------
const mapDiagonal = Math.hypot(MAP_WIDTH, MAP_DEPTH);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050505);

// Fixed-angle orthographic camera — the core of the move to a 2D+, fixed-
// camera presentation. No rotation is possible at all (see controls
// below); pan and zoom remain, since the user wanted to keep those, just
// not full 3D free-look. Angle is a classic ~35°/45° dimetric view,
// similar to Age of Empires and most indie tactics/RTS games in this genre.
const CAMERA_PITCH = THREE.MathUtils.degToRad(35);
const CAMERA_YAW = THREE.MathUtils.degToRad(45);
let viewSize = mapDiagonal * 0.34; // half-height of the visible frustum — this IS the zoom level for an orthographic camera

// window.innerWidth/innerHeight can genuinely read 0 the instant this
// module evaluates (observed in an embedded/iframe preview before its
// first layout pass) — dividing by 0 silently produces a NaN aspect, which
// poisons camera.left/right (and therefore the whole projection matrix,
// and therefore all raycasting — including placement clicks — with no
// visible symptom other than "nothing happens"). A 16:9 fallback keeps the
// very first frame sane; applyViewportSize() below runs again as soon as
// real dimensions are known, correcting it either way.
function currentAspect() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return w > 0 && h > 0 ? w / h : 16 / 9;
}

const camera = new THREE.OrthographicCamera(-viewSize * currentAspect(), viewSize * currentAspect(), viewSize, -viewSize, 0.1, mapDiagonal * 3);
const camDist = mapDiagonal * 1.3;
camera.position.set(
  Math.sin(CAMERA_YAW) * Math.cos(CAMERA_PITCH) * camDist,
  Math.sin(CAMERA_PITCH) * camDist,
  Math.cos(CAMERA_YAW) * Math.cos(CAMERA_PITCH) * camDist
);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.getElementById("app").appendChild(renderer.domElement);

// Pan + zoom only — rotation disabled entirely. Left-drag pans (remapped
// from its default of rotate, which is off anyway) since that's the only
// camera interaction left worth a full mouse button.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableRotate = false;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.enableDamping = true;
controls.screenSpacePanning = true;
controls.minZoom = 0.4;
controls.maxZoom = 3.0;

function applyViewportSize() {
  const aspect = currentAspect();
  camera.left = -viewSize * aspect;
  camera.right = viewSize * aspect;
  camera.top = viewSize;
  camera.bottom = -viewSize;
  camera.updateProjectionMatrix();
  if (window.innerWidth > 0 && window.innerHeight > 0) {
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

window.addEventListener("resize", applyViewportSize);
// A ResizeObserver fires immediately on observe() with the CURRENT size,
// not just on subsequent changes — this is what actually fixes the 0x0
// startup case, since an embedded preview that never dispatches a real
// `resize` DOM event during that 0->real transition would otherwise leave
// the broken initial projection matrix in place forever.
new ResizeObserver(applyViewportSize).observe(document.body);

// ---------- Lighting ----------
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x445533, 0.8);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(-mapDiagonal * 0.35, mapDiagonal * 0.55, mapDiagonal * 0.24);
sunLight.castShadow = true;
sunLight.shadow.camera.left = -mapDiagonal * 0.6;
sunLight.shadow.camera.right = mapDiagonal * 0.6;
sunLight.shadow.camera.top = mapDiagonal * 0.6;
sunLight.shadow.camera.bottom = -mapDiagonal * 0.6;
sunLight.shadow.camera.far = mapDiagonal * 1.5;
scene.add(sunLight);

// ---------- Ground (tile-based) ----------
// Real Kenney "Nature Kit" models (see assets.js) replace the old flat
// colored boxes. Ground and forest tiles share the same flat "ground_grass"
// tile model (forest tiles just get trees added on top of it separately);
// ramps and sheer cliff faces use the kit's own modular cliff pieces.
//
// The tile grid stores only level+type per tile, no per-tile facing data
// (see tileTerrain.js), so a ramp/sheer tile's outward-facing direction(s)
// are inferred at render time by comparing its level against its 4
// immediate neighbors — the direction(s) with a lower (or off-grid)
// neighbor are where the wall/slope needs to face. A corner tile (two
// lower neighbors on adjacent sides) gets two overlapping wall or slope
// instances, one per outward direction, rather than trying to align the
// kit's separately-pivoted dedicated corner piece blind — simpler and
// more robust, at the cost of a visible seam that reads fine at this scale.
//
// Every tile is still one InstancedMesh-covered instance (grouped per
// model part, not per tile) — a large generated map can have several
// thousand tiles, and one draw call per tile would be wasteful.

// `angle` must rotate a model's local -Z (the face every cliff/ramp piece
// in this kit presents outward: the rock bulge on cliff_large_rock, the
// descending/low end of cliff_steps_rock's staircase) onto this
// direction — verified from each model's own vertex data. Rotating
// local -Z about Y by θ yields world (-sinθ, -cosθ), so:
//   north (0,-1) -> θ=0      east (1,0)  -> θ=-π/2
//   south (0,1)  -> θ=π      west (-1,0) -> θ=+π/2
// The east/west pair is easy to get backwards (they were swapped here at
// first, which flipped the rock face inward on exactly those two sides
// while north/south looked perfectly fine — a partial symptom that reads
// as a rendering glitch rather than a rotation bug).
const OUTWARD_DIRS = [
  { dx: 0, dz: -1, angle: 0 }, // north
  { dx: 1, dz: 0, angle: -Math.PI / 2 }, // east
  { dx: 0, dz: 1, angle: Math.PI }, // south
  { dx: -1, dz: 0, angle: Math.PI / 2 }, // west
];

// Returns the outward direction(s) a wall/slope piece on this tile should
// face, one per side where the neighbor is lower (or off-grid) than this
// tile — empty only if genuinely landlocked, which real plateau geometry
// never produces, so that case falls back to a single default direction
// rather than rendering nothing. Each entry carries both the world-Y
// rotation AND the raw (dx, dz) — the rotation alone orients a model, but
// callers that need to nudge a placement toward or away from the tile's
// true edge (see the backstop inset below) need the direction vector too.
function getOutwardDirs(tx, tz) {
  const level = getTileLevel(TILE_GRID, tx, tz);
  const out = [];
  for (const d of OUTWARD_DIRS) {
    const ntx = tx + d.dx;
    const ntz = tz + d.dz;
    if (!inBounds(TILE_GRID, ntx, ntz) || getTileLevel(TILE_GRID, ntx, ntz) < level) {
      out.push(d);
    }
  }
  // Deliberately returns EMPTY for a tile with nothing lower beside it (a
  // plateau's interior). It must not fall back to an arbitrary direction:
  // callers use "has outward sides" to mean "is exposed and needs a wall",
  // and a fallback silently turns every interior tile into an exposed one.
  return out;
}

// Subtle per-zone tint multiplied onto each model's own base color —
// keeps the "which side is whose" gameplay readability the old flat boxes
// carried (defender = cooler/green, intruder = warmer/red) without
// fighting the kit's natural stylized coloring the way a strong flat tint
// would.
const DEFENDER_TINT = new THREE.Color(0xd7ffd9);
const INTRUDER_TINT = new THREE.Color(0xffd0c8);

function zoneTint(worldX) {
  return worldX < BORDER_X ? DEFENDER_TINT : INTRUDER_TINT;
}

// Walkable-vs-impassable elevation is carried by the models' own shape and
// native materials, not by a recolor: a ramp is the kit's genuine 45° wedge
// with its grass surface running down the slope, while a cliff is a solid
// grass-topped block wearing a bare rock face on its outward side. Those
// read differently from every angle, so no artificial tinting is layered on
// top — only the subtle per-zone tint above.

// Instances one GLTF model (every mesh "part" it has — typically 1-2,
// e.g. a grass-top material and a rock/wood-base material) across many
// placements as InstancedMesh groups, one per part (sharing that part's
// geometry/material across every placement, since InstancedMesh requires
// one geometry+material per mesh). Returns the created meshes so callers
// can fold them into the placement-click raycast target list.
function createInstancedGroup(modelName, placements) {
  if (placements.length === 0) return [];
  const parts = getModelParts(modelName);
  const dummy = new THREE.Object3D();
  const meshes = [];
  for (const part of parts) {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    placements.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rotationY, 0);
      // p.scale is normally a uniform number; a corner filler (see
      // buildGroundTiles) instead passes {x, y, z} to stay full-height
      // while shrinking its footprint down to just the small notch it's
      // plugging, rather than a tile-sized block.
      if (typeof p.scale === "number") dummy.scale.setScalar(p.scale);
      else dummy.scale.set(p.scale.x, p.scale.y, p.scale.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix.clone().multiply(part.matrix));
      mesh.setColorAt(i, p.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // InstancedMesh computes its OWN bounding sphere (distinct from — and
    // not derived from — its shared geometry's bounding sphere), and
    // doesn't do it automatically after setMatrixAt() calls. Skipping this
    // leaves it null, which silently breaks both frustum culling and
    // raycasting (placement clicks) for every instance outside a tiny
    // sphere around local origin — the render happens to still work here
    // only because these meshes stay in view regardless, but raycasting
    // against them does not degrade gracefully the same way.
    mesh.computeBoundingSphere();
    scene.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

// Returns the meshes worth raycasting against for placement clicks — every
// tile a player could legally (or almost-legally) click, at its true
// rendered height, so clicks on elevated ground resolve correctly instead
// of assuming a flat plane.
// Shift (world units, along the tile's outward direction) applied to the
// cliff_large_rock face decoration so its flat back lands just inside the
// solid block's outward face instead of buried in the block's far half
// where the model's own pivot would otherwise put it. TILE_SIZE would sit
// it exactly flush; a slightly smaller value embeds the back edge a touch
// so the two never render coplanar (which z-fights).
const CLIFF_FACE_OFFSET = TILE_SIZE - 0.1;

// Rotation that carries cliff_cornerLarge_rock's own corner (which points
// toward +X/-Z, i.e. N+E, at rotation 0) onto each of the four corners.
// Derived, not guessed: rotating (1,-1) about Y by t gives
// (cos t - sin t, -sin t - cos t), which lands on NE/NW/SW/SE at
// t = 0, PI/2, PI, -PI/2 respectively.
const CORNER_ANGLE_BY_QUADRANT = {
  "1,-1": 0, // outward N + E
  "-1,-1": Math.PI / 2, // outward N + W
  "-1,1": Math.PI, // outward S + W
  "1,1": -Math.PI / 2, // outward S + E
};

// Given a tile's outward directions, returns the corner it forms — but only
// for a genuine OUTER corner: exactly two sides, and perpendicular ones. Two
// opposite sides (a one-tile-wide ridge) is not a corner and must keep its
// two independent straight faces.
function cornerOf(dirs) {
  if (dirs.length !== 2) return null;
  const cx = dirs[0].dx + dirs[1].dx;
  const cz = dirs[0].dz + dirs[1].dz;
  if (cx === 0 || cz === 0) return null;
  return { cx, cz, angle: CORNER_ANGLE_BY_QUADRANT[`${cx},${cz}`] };
}

function buildGroundTiles() {
  const groundPlacements = [];
  // A flat grass quad laid at the LOWER level underneath every raised,
  // exposed tile, so the level-0 ground plane is continuous across the
  // whole map instead of stopping at each plateau's foot. Belt-and-braces
  // against see-through gaps: a staircase piece is not a solid block (its
  // underside follows the treads), and where any raised piece's outward
  // face meets the neighbouring ground quad they touch exactly edge-to-
  // edge, which a camera ray grazing that shared edge can slip straight
  // through. Measured before adding this: ~0.5% of rays escaped the map,
  // every one of them within 0.1 world units of a tile boundary and only
  // ever one ray wide — hairline seams rather than real holes, but they
  // can still shimmer. With ground under everything there is simply
  // nothing left for a ray to slip through.
  // Deliberately NOT returned as a clickable/raycastable mesh: these sit
  // under cliffs and stairs, and placement clicks must keep resolving
  // against the real tile surfaces only.
  const baseFillPlacements = [];
  const stepsPlacements = [];
  const stepsCornerPlacements = [];
  const sheerPlacements = [];
  const sheerFacePlacements = [];
  const sheerCornerPlacements = [];
  const cityPlacements = [];

  for (let tz = 0; tz < TILE_GRID.rows; tz++) {
    for (let tx = 0; tx < TILE_GRID.cols; tx++) {
      const type = getTileType(TILE_GRID, tx, tz);
      const level = getTileLevel(TILE_GRID, tx, tz);
      const center = tileToWorldCenter(TILE_GRID, tx, tz);
      const color = zoneTint(center.x);
      const y = level * LEVEL_HEIGHT;

      // Any tile standing above a lower neighbour needs a skirt closing
      // its exposed vertical side — NOT just RAMP/SHEER ones. stampForest
      // (and stampCity) overwrite a plateau's edge tiles, replacing the
      // RAMP/SHEER type while keeping the raised level, so an elevated
      // forest can sit right on a plateau rim. Rendering those as the
      // usual flat, zero-thickness ground plane left their vertical face
      // completely open — a real see-through hole in the map, and one a
      // top-down check can never detect because the gap is vertical.
      // Driving the skirt off elevation alone makes that impossible by
      // construction, whatever a tile's type happens to be.
      // getOutwardDirs never returns empty for an elevated tile, so this is
      // exactly "is this tile raised above anything next to it". A degenerate
      // SHEER/RAMP tile sitting at level 0 correctly falls through to flat
      // ground rather than emitting a zero-sided skirt (which would itself
      // be a hole).
      const exposed = level > 0 ? getOutwardDirs(tx, tz) : [];
      // A tile the generator explicitly marked as a plateau edge always
      // renders as one even in the degenerate case where nothing beside it
      // is actually lower; anything else needs a real exposed side.
      const isEdgeType = type === TileType.SHEER || type === TileType.RAMP;
      const dirs = exposed.length > 0 ? exposed : isEdgeType && level > 0 ? [OUTWARD_DIRS[0]] : [];

      if (dirs.length > 0) {
        // Ramp-vs-sheer comes from the grid's own ramp mask, NOT from
        // `type`: forest stamping overwrites a plateau edge tile's type
        // while leaving it raised, and reading `type === RAMP` therefore
        // drew rock cliff faces on what are meant to be pure grass slopes
        // (see tileTerrain.js's createTileGrid note).
        const isRamp = isRampEdge(TILE_GRID, tx, tz);
        // Base at the level below (a wall/slope spans one full level's
        // rise, from the lower neighbor's height up to this tile's own).
        const baseY = (level - 1) * LEVEL_HEIGHT;
        // baseY is exactly the lower neighbour's surface height, so this
        // continues the ground plane under the piece rather than adding a
        // visible ledge.
        baseFillPlacements.push({ x: center.x, y: baseY, z: center.z, rotationY: 0, scale: TILE_SIZE, color });
        // An OUTER corner (two adjacent open sides) is a single dedicated
        // piece for BOTH ramps and cliffs — two straight pieces butted
        // into each other at 90 degrees is exactly what leaves a visible
        // notch/seam at the corner.
        const corner = cornerOf(dirs);
        if (isRamp) {
          // Walkable plateau edges are the kit's real staircases. Both
          // pieces descend toward local -Z (measured from vertex data,
          // same convention the old wedge used, so OUTWARD_DIRS' angles
          // carry over unchanged), and their stepped edge profiles are
          // identical, so a straight run flows into a corner seamlessly.
          //
          // Neither piece is a solid block — the underside follows the
          // stair treads, leaving a void beneath. That's fine, and stays
          // fine, only because every side of that void is closed by
          // something: the lowest step's own front face seals downhill,
          // the plateau seals uphill, and sideways each piece butts
          // against an identically-profiled neighbour (another staircase,
          // the matching corner piece, or — where a ramp edge meets a
          // sheer one — a solid full-height cliff block, since
          // stampPlateau always makes a mixed corner sheer).
          if (corner) {
            stepsCornerPlacements.push({ x: center.x, y: baseY, z: center.z, rotationY: corner.angle, scale: TILE_SIZE, color });
          } else {
            // One staircase per open side. A census over 200 generated
            // levels found ONLY straight (1 side) and outer-corner (2
            // adjacent) shapes on elevated tiles — never a ridge or spur —
            // so the loop body effectively runs once. It's written to
            // handle several anyway, and deliberately emits another
            // staircase rather than a rock face for the extra sides:
            // overlapping meshes union to the MAX height, which at worst
            // reads as a bump, never as a hole, and it keeps a pure-slope
            // plateau completely free of cliff geometry.
            for (const dir of dirs) {
              stepsPlacements.push({ x: center.x, y: baseY, z: center.z, rotationY: dir.angle, scale: TILE_SIZE, color });
            }
          }
        } else {
          // A sheer cliff is TWO pieces: the solid grass-topped cube that
          // actually fills the tile, plus the kit's rock-face decoration
          // laid against its outward side. cliff_large_rock is NOT a tile
          // — it's a dirt-only face slab (no grass top, 0.42 deep) whose
          // flat back sits at local +Z and whose irregular rocky front
          // bulges toward local -Z. Using it alone as the tile was the
          // original bug: it left most of the tile empty, which is what
          // all the earlier backstop patching was compensating for.
          // The cube is symmetric, so one is enough no matter how many
          // sides are exposed — its rotation is irrelevant.
          sheerPlacements.push({ x: center.x, y: baseY, z: center.z, rotationY: 0, scale: TILE_SIZE, color });

          // Rock-face decoration, cliffs only — a ramp is now entirely the
          // staircase pieces above, with no rock dressing at all, so a
          // plateau with no sheer sides emits zero cliff geometry.
          // Straight faces run the full length of every exposed edge, so a
          // corner tile keeps the same rock relief as its neighbours
          // rather than going bare along most of its edge.
          for (const dir of dirs) {
            sheerFacePlacements.push({
              x: center.x + dir.dx * CLIFF_FACE_OFFSET,
              y: baseY,
              z: center.z + dir.dz * CLIFF_FACE_OFFSET,
              rotationY: dir.angle,
              scale: TILE_SIZE,
              color,
            });
          }
          // The corner piece is ADDITIVE here: two straight rock faces
          // meeting at 90 degrees leave a V-shaped notch at the outer
          // corner (their irregular silhouettes don't join), and this
          // fills exactly that junction so the rock reads as one
          // continuous mass. cliff_cornerLarge_rock's flat backs sit at
          // local x=-0.5 and z=+0.5 with its rocky mass bulging toward +X
          // and -Z, so at rotation 0 it serves the N+E corner —
          // CORNER_ANGLE_BY_QUADRANT rotates that onto this tile's corner.
          if (corner) {
            sheerCornerPlacements.push({
              x: center.x + corner.cx * CLIFF_FACE_OFFSET,
              y: baseY,
              z: center.z + corner.cz * CLIFF_FACE_OFFSET,
              rotationY: corner.angle,
              scale: TILE_SIZE,
              color,
            });
          }
        }
        continue;
      }
      if (type === TileType.CITY) {
        cityPlacements.push({ x: center.x, y, z: center.z, rotationY: 0, scale: TILE_SIZE, color });
        continue;
      }
      // GROUND and FOREST tiles share the same flat grass base.
      groundPlacements.push({ x: center.x, y, z: center.z, rotationY: 0, scale: TILE_SIZE, color });
    }
  }

  // Decoration/backing only — not part of the clickable/raycastable tile set.
  createInstancedGroup("ground_grass", baseFillPlacements);
  createInstancedGroup("cliff_large_rock", sheerFacePlacements);
  createInstancedGroup("cliff_cornerLarge_rock", sheerCornerPlacements);
  return [
    ...createInstancedGroup("ground_grass", groundPlacements),
    ...createInstancedGroup("cliff_steps_rock", stepsPlacements),
    ...createInstancedGroup("cliff_stepsCorner_rock", stepsCornerPlacements),
    ...createInstancedGroup("cliff_block_rock", sheerPlacements),
    // City tiles use the same full-coverage grass tile as ordinary ground:
    // platform_stone is smaller than a tile (0.89 x 0.72) and left real
    // holes. The city reads as "city" from its buildings, fence, and path,
    // which are placed separately — it doesn't need its own base texture.
    ...createInstancedGroup("ground_grass", cityPlacements),
  ];
}

let clickableTileMeshes = [];

const borderGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(BORDER_X, LEVEL_HEIGHT + 0.4, -MAP_DEPTH / 2),
  new THREE.Vector3(BORDER_X, LEVEL_HEIGHT + 0.4, MAP_DEPTH / 2),
]);
scene.add(new THREE.Line(borderGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })));

// ---------- Forest decoration ----------
// Real Kenney tree models, individually spawned per tree (not instanced —
// forest tree counts are in the hundreds, not the thousands the ground
// tiles are, so per-tree Object3D clones are cheap enough at this scale).
// Ground base under forest tiles is handled by buildGroundTiles() (forest
// tiles share the same grass tile as ordinary ground).
function buildForestTrees() {
  for (let tz = 0; tz < TILE_GRID.rows; tz++) {
    for (let tx = 0; tx < TILE_GRID.cols; tx++) {
      if (getTileType(TILE_GRID, tx, tz) !== TileType.FOREST) continue;
      const c = tileToWorldCenter(TILE_GRID, tx, tz);
      const baseY = getTerrainHeight(c.x, c.z);
      const treeCount = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < treeCount; i++) {
        const tree = spawnModel(randomOf(MODEL_NAMES.trees));
        tree.position.set(c.x + (Math.random() - 0.5) * TILE_SIZE * 0.7, baseY, c.z + (Math.random() - 0.5) * TILE_SIZE * 0.7);
        tree.scale.setScalar((1.4 + Math.random() * 0.7) * 2);
        tree.rotation.y = Math.random() * Math.PI * 2;
        scene.add(tree);
      }
      // Sparse understory clutter for visual richness — not every forest
      // tile, so it reads as scattered undergrowth rather than a uniform
      // carpet.
      if (Math.random() < 0.35) {
        const clutter = spawnModel(randomOf(MODEL_NAMES.forestClutter));
        clutter.position.set(c.x + (Math.random() - 0.5) * TILE_SIZE * 0.8, baseY, c.z + (Math.random() - 0.5) * TILE_SIZE * 0.8);
        clutter.scale.setScalar(0.8 + Math.random() * 0.5);
        clutter.rotation.y = Math.random() * Math.PI * 2;
        scene.add(clutter);
      }
    }
  }
}

// ---------- Ground clutter ----------
// Light scattering of flowers/grass/bushes across ordinary ground tiles
// (forest, city, ramp, and sheer tiles are skipped by construction — only
// GROUND-typed tiles reach this loop). Density-based so it scales
// automatically with map size, matching this project's established
// pattern for ground decoration.
const GROUND_CLUTTER_DENSITY = 0.05; // items per square world-unit of open ground

function decorateGroundScatter() {
  for (let tz = 0; tz < TILE_GRID.rows; tz++) {
    for (let tx = 0; tx < TILE_GRID.cols; tx++) {
      if (getTileType(TILE_GRID, tx, tz) !== TileType.GROUND) continue;
      const expected = TILE_SIZE * TILE_SIZE * GROUND_CLUTTER_DENSITY;
      const count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
      if (count === 0) continue;
      const c = tileToWorldCenter(TILE_GRID, tx, tz);
      const baseY = getTerrainHeight(c.x, c.z);
      for (let i = 0; i < count; i++) {
        const item = spawnModel(randomOf(MODEL_NAMES.groundClutter));
        item.position.set(c.x + (Math.random() - 0.5) * TILE_SIZE * 0.85, baseY, c.z + (Math.random() - 0.5) * TILE_SIZE * 0.85);
        item.scale.setScalar(0.7 + Math.random() * 0.6);
        item.rotation.y = Math.random() * Math.PI * 2;
        scene.add(item);
      }
    }
  }
}

// ---------- The city being defended ----------
// Building layout expressed as FRACTIONS of the city zone's own bounds —
// unaffected by the tile rewrite, this was already correctly dynamic.
const CITY_BUILDING_LAYOUT = [
  { fx: 0.17, fz: 0.5, w: 3, d: 3, h: 5 }, // central keep, tallest
  { fx: 0.47, fz: 0.18, w: 2, d: 2, h: 3 },
  { fx: 0.53, fz: 0.8, w: 2.4, d: 2.4, h: 3.6 },
  { fx: 0.2, fz: 0.05, w: 1.6, d: 1.6, h: 2.2 },
  { fx: 0.25, fz: 0.97, w: 1.8, d: 1.8, h: 2.6 },
  { fx: 0.75, fz: 0.55, w: 1.6, d: 1.6, h: 2.4 },
];

function createCity() {
  const group = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xcabb92 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a3a3a });

  const cityWidth = CITY_ZONE.xMax - CITY_ZONE.xMin;
  const cityDepth = CITY_ZONE.zMax - CITY_ZONE.zMin;

  CITY_BUILDING_LAYOUT.forEach((b) => {
    const x = CITY_ZONE.xMin + b.fx * cityWidth;
    const z = CITY_ZONE.zMin + b.fz * cityDepth;
    const y = getTerrainHeight(x, z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), wallMat);
    body.position.set(x, y + b.h / 2, z);
    body.castShadow = true;
    body.receiveShadow = true;

    const roof = new THREE.Mesh(new THREE.ConeGeometry(b.w * 0.75, 1.4, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.set(x, y + b.h + 0.7, z);
    roof.castShadow = true;

    group.add(body, roof);
  });

  scene.add(group);
}

// A low fence marking the city's perimeter facing the battlefield, and a
// path leading from the city out toward the border — simple primitives
// now instead of Kenney fence/path models.
function decorateCityBoundary() {
  const cityZCenter = (CITY_ZONE.zMin + CITY_ZONE.zMax) / 2;
  const fenceX = CITY_ZONE.xMax + 0.3;
  const GATE_HALF_WIDTH = 1.2;
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x6b5335 });
  const postGeo = new THREE.BoxGeometry(0.15, 0.9, 0.15);
  for (let z = CITY_ZONE.zMin; z <= CITY_ZONE.zMax; z += 1.0) {
    if (Math.abs(z - cityZCenter) < GATE_HALF_WIDTH) continue;
    const y = getTerrainHeight(fenceX, z);
    const post = new THREE.Mesh(postGeo, fenceMat);
    post.position.set(fenceX, y + 0.45, z);
    post.castShadow = true;
    scene.add(post);
  }

  const startX = CITY_ZONE.xMax + 0.5;
  const endX = Math.min(BORDER_X - 1, startX + MAP_WIDTH * 0.3);
  const pathMat = new THREE.MeshStandardMaterial({ color: 0xa89a7a });
  const steps = Math.max(1, Math.round(Math.abs(endX - startX) / 1.2));
  for (let i = 0; i <= steps; i++) {
    const x = startX + (endX - startX) * (i / steps);
    const y = getTerrainHeight(x, cityZCenter);
    const tile = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 1.0), pathMat);
    tile.position.set(x, y + 0.03, cityZCenter);
    scene.add(tile);
  }
}

// ---------- Floating damage numbers ----------
const damageNumbers = [];

// `blockedReason` (see applyDamage): null for an ordinary hit — shows the
// usual yellow whole-number. "evaded"/"resisted" show a distinct pale-blue
// word instead of "0", since a raw "0" reads as a rounding artifact or a
// bug, not as "this hit specifically failed to land" — the Evasion/Pierce
// Resistance specs' whole point is being visibly hard to damage.
function spawnDamageNumber(position, amount, blockedReason) {
  const text = blockedReason === "evaded" ? "Evaded" : blockedReason === "resisted" ? "Resisted" : Math.max(1, Math.round(amount)).toString();
  const canvas = document.createElement("canvas");
  canvas.width = blockedReason ? 200 : 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = blockedReason ? "bold 30px system-ui, sans-serif" : "bold 42px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.strokeText(text, canvas.width / 2, 32);
  ctx.fillStyle = blockedReason ? "#9fd8ff" : "#fff176";
  ctx.fillText(text, canvas.width / 2, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(blockedReason ? 2.0 : 1.3, 0.65, 1);
  sprite.position.copy(position);
  sprite.position.y += 1.6;
  sprite.position.x += (Math.random() - 0.5) * 0.4;
  sprite.position.z += (Math.random() - 0.5) * 0.4;
  scene.add(sprite);
  damageNumbers.push({ sprite, t: 0 });
}

// Same float-and-fade treatment as spawnDamageNumber (reuses the exact
// same damageNumbers array/updateDamageNumbers loop — no separate
// tracking needed), but visually distinct: a "-X%" reading in orange/red
// rather than combat damage's yellow whole-number, so a city hit reads
// unambiguously as a different KIND of event, not just another attack.
function spawnCityDamageNumber(position, percentAmount) {
  const text = `-${Math.max(0.1, Math.round(percentAmount * 10) / 10).toFixed(1)}%`;
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 38px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.strokeText(text, 80, 32);
  ctx.fillStyle = "#ff6b4a";
  ctx.fillText(text, 80, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.8, 0.72, 1);
  sprite.position.copy(position);
  sprite.position.y += 2.2;
  sprite.position.x += (Math.random() - 0.5) * 0.6;
  sprite.position.z += (Math.random() - 0.5) * 0.6;
  scene.add(sprite);
  damageNumbers.push({ sprite, t: 0 });
}

// Lifesteal (see items.js's lifestealPercent) — a green "+X" reading
// above the ATTACKER (same anchor point as spawnDamageNumber, and for the
// same reason: this is about what the attacker just did, not the
// target), visually distinct from combat damage's yellow so a heal reads
// unambiguously as a different kind of event.
function spawnHealNumber(position, amount) {
  const text = `+${Math.max(1, Math.round(amount))}`;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 38px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.strokeText(text, 64, 32);
  ctx.fillStyle = "#7ed957";
  ctx.fillText(text, 64, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.3, 0.65, 1);
  sprite.position.copy(position);
  sprite.position.y += 2.1;
  sprite.position.x += (Math.random() - 0.5) * 0.4;
  sprite.position.z += (Math.random() - 0.5) * 0.4;
  scene.add(sprite);
  damageNumbers.push({ sprite, t: 0 });
}

function updateDamageNumbers(delta) {
  const duration = 1.0;
  const fadeStart = 0.55;
  for (let i = damageNumbers.length - 1; i >= 0; i--) {
    const d = damageNumbers[i];
    d.t += delta;
    d.sprite.position.y += 0.7 * delta;
    if (d.t > fadeStart) {
      d.sprite.material.opacity = Math.max(0, 1 - (d.t - fadeStart) / (duration - fadeStart));
    }
    if (d.t >= duration) {
      scene.remove(d.sprite);
      d.sprite.material.map.dispose();
      d.sprite.material.dispose();
      damageNumbers.splice(i, 1);
    }
  }
}

// ---------- Game state ----------
let phase = "placement"; // "placement" | "battle" | "result"
let population = STARTING_POPULATION;
let selectedType = "knight";
const defenders = [];
const intruders = [];
const projectiles = [];
const dyingUnits = []; // { unit, t } - fading out after death





// Sum of city damage dealt THIS level (0 unless every defender died and
// at least one raider reached the city) — used purely to pick the right
// result messaging/outcome in endBattle, not to compute the damage
// itself (that's already been applied live, per-raider, in
// applyCityArrival, for real-time visual feedback as it happens).
let cityDamageDealtThisLevel = 0;

const levelValue = document.getElementById("level-value");
const levelTypeValue = document.getElementById("level-type-value");
const populationValue = document.getElementById("population-value");
const bankedGoldValue = document.getElementById("banked-gold-value");
const scoreValue = document.getElementById("score-value");
const cityHealthValue = document.getElementById("city-health-value");
const cityHealthFill = document.getElementById("city-health-fill");
const defenderHealthValue = document.getElementById("defender-health-value");
const defenderHealthFill = document.getElementById("defender-health-fill");
const raiderHealthValue = document.getElementById("raider-health-value");
const raiderHealthFill = document.getElementById("raider-health-fill");
const instructions = document.getElementById("instructions");
const startBtn = document.getElementById("start-battle-btn");
const resultBanner = document.getElementById("result-banner");
const resultText = document.getElementById("result-text");
const resultEvolutionLine = document.getElementById("result-evolution-line");
const resultSummaryLine = document.getElementById("result-summary-line");
const resultPrimaryBtn = document.getElementById("result-primary-btn");
const resetLevelBtn = document.getElementById("reset-level-btn");
const resetGameBtn = document.getElementById("reset-game-btn");
const unitButtons = document.querySelectorAll(".unit-btn");

const shopToggleBtn = document.getElementById("shop-toggle-btn");
const shopPanel = document.getElementById("shop-panel");
const shopRewardLine = document.getElementById("shop-reward-line");
const shopInterestLine = document.getElementById("shop-interest-line");
const shopGoldValue = document.getElementById("shop-gold-value");
const shopUpgradesEl = document.getElementById("shop-upgrades");
const shopPrimaryBtn = document.getElementById("shop-primary-btn");

const backpackToggleBtn = document.getElementById("backpack-toggle-btn");
const backpackCountEl = document.getElementById("backpack-count");
const backpackPanel = document.getElementById("backpack-panel");
const backpackActiveCountEl = document.getElementById("backpack-active-count");
const backpackLockNote = document.getElementById("backpack-lock-note");
const backpackBodyEl = document.getElementById("backpack-body");
const backpackCloseBtn = document.getElementById("backpack-close-btn");
const itemDropToast = document.getElementById("item-drop-toast");

const defenderStatsToggleBtn = document.getElementById("defender-stats-toggle-btn");
const defenderStatsPanel = document.getElementById("defender-stats-panel");
const defenderStatsBodyEl = document.getElementById("defender-stats-body");
const attackerStatsToggleBtn = document.getElementById("attacker-stats-toggle-btn");
const attackerStatsPanel = document.getElementById("attacker-stats-panel");
const attackerStatsBodyEl = document.getElementById("attacker-stats-body");

const upcomingToggleBtn = document.getElementById("upcoming-toggle-btn");
const upcomingPanel = document.getElementById("upcoming-panel");
const upcomingBodyEl = document.getElementById("upcoming-body");

const confirmModal = document.getElementById("confirm-modal");
const confirmModalMessage = document.getElementById("confirm-modal-message");
const confirmModalCancelBtn = document.getElementById("confirm-modal-cancel-btn");
const confirmModalConfirmBtn = document.getElementById("confirm-modal-confirm-btn");

// ---------- How-to-play intro modal ----------
// Plain, literal instructions — not flavor text — shown once automatically
// (tracked in its own localStorage flag, separate from PROGRESS, since
// "has this browser seen the instructions" has nothing to do with a save
// slot and shouldn't be wiped by Reset Game) and reachable afterward via
// the topbar button for anyone who wants a reminder.
const INTRO_SEEN_KEY = "defend-the-city-intro-seen-v1";
const introModal = document.getElementById("intro-modal");
const introModalCloseBtn = document.getElementById("intro-modal-close-btn");
const howToPlayBtn = document.getElementById("how-to-play-btn");

function openIntroModal() {
  introModal.classList.remove("hidden");
}
function closeIntroModal() {
  introModal.classList.add("hidden");
  try {
    localStorage.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    // Private browsing / storage disabled — non-fatal, just means it
    // shows again next load, which is a harmless fallback.
  }
}
introModalCloseBtn.addEventListener("click", closeIntroModal);
howToPlayBtn.addEventListener("click", openIntroModal);

// Combines a level's TYPE and SPEC into one display label — "Boss" alone
// when the spec is "none" (the common case, and the only spec possible
// for the first 5 levels), "Boss · Flying" once a spec is actually in
// play, so a boring "· None" suffix never clutters every ordinary level.
function formatLevelLabel(levelType, levelSpec) {
  const typeLabel = LEVEL_TYPES[levelType].label;
  if (levelSpec === "none") return typeLabel;
  return `${typeLabel} · ${LEVEL_SPECS[levelSpec].label}`;
}

levelValue.textContent = CURRENT_LEVEL;
levelTypeValue.textContent = formatLevelLabel(CURRENT_LEVEL_TYPE, CURRENT_LEVEL_SPEC);
populationValue.textContent = population;
// Gold is kept as an exact float internally (interest — see below — earns
// fractional amounts that compound level over level), but every display
// point floors it. Never rounds up: a displayed value must never suggest
// more gold is available than genuinely is.
bankedGoldValue.textContent = Math.floor(PROGRESS.gold);
scoreValue.textContent = Math.floor(PROGRESS.score);

// Live visual feedback: bar fill width + color tier + precise percentage
// (1 decimal place, since the game-over threshold is itself fractional —
// "0.1%" — a whole-number display would hide exactly the information
// that matters most in a close game). Called once here to show whatever
// was already persisted, and again every time a raider reaches the city
// (see applyCityArrival) so the bar visibly drains in real time during
// battle, not just jumps at the end of a level.
function updateCityHealthDisplay() {
  const pct = Math.max(0, Math.min(CITY_MAX_HEALTH, PROGRESS.cityHealth));
  cityHealthValue.textContent = `${pct.toFixed(1)}%`;
  cityHealthFill.style.width = `${pct}%`;
  cityHealthFill.style.background = pct > 50 ? "#5ec95e" : pct > 20 ? "#e0b83a" : "#e05a3a";
}
updateCityHealthDisplay();

// Total-army health bars — sum of every unit's CURRENT health over the sum
// of every unit's MAX health, per side. Deliberately summed over the whole
// array (not just currently-alive units) so a unit dying still visibly
// drains the bar rather than shrinking both numerator and denominator by
// the same amount and leaving the percentage untouched — `defenders`/
// `intruders` are append-only (dead units stay in the array with health
// clamped to 0 by Unit.takeDamage), and defenders only grow during
// placement, before battle starts, so there's no need to snapshot a
// separate "starting total" anywhere; live-summing each frame is already
// correct and cheap enough at this unit count. `max === 0` (no defenders
// placed yet) reads as a full, neutral bar rather than a division by zero.
function sumArmyHealth(units) {
  let cur = 0;
  let max = 0;
  for (const u of units) {
    if (u.alive) cur += u.health;
    max += u.stats.maxHealth;
  }
  return max > 0 ? (cur / max) * 100 : 100;
}

function updateArmyHealthDisplay() {
  const defPct = sumArmyHealth(defenders);
  const raidPct = sumArmyHealth(intruders);
  defenderHealthValue.textContent = `${Math.round(defPct)}%`;
  defenderHealthFill.style.width = `${defPct}%`;
  raiderHealthValue.textContent = `${Math.round(raidPct)}%`;
  raiderHealthFill.style.width = `${raidPct}%`;
}
updateArmyHealthDisplay();

// ---------- Confirmation modal ----------
// A single reusable in-page modal (not the browser's native confirm())
// for anything destructive — currently the two reset buttons below.
// Styled consistently with the rest of the UI and, importantly, an
// actual centered/fixed overlay outside the #ui flex column entirely, so
// it can never suffer the same "pushed off-screen with no way to scroll
// back to it" issue the shop panel had (see the #shop-panel CSS notes).
let confirmModalCallback = null;

function openConfirmModal(message, onConfirm) {
  confirmModalMessage.textContent = message;
  confirmModalCallback = onConfirm;
  confirmModal.classList.remove("hidden");
}

function closeConfirmModal() {
  confirmModal.classList.add("hidden");
  confirmModalCallback = null;
}

confirmModalCancelBtn.addEventListener("click", closeConfirmModal);
confirmModalConfirmBtn.addEventListener("click", () => {
  const callback = confirmModalCallback;
  closeConfirmModal();
  if (callback) callback();
});

resetLevelBtn.addEventListener("click", () => {
  openConfirmModal(
    "Restart this level? Your current placement and any battle progress will be lost. Your saved Gold, Score, and upgrades are unaffected.",
    () => {
      track(EVENTS.PROGRESS_RESET, { scope: "level", level: CURRENT_LEVEL });
      window.location.reload();
    }
  );
});

resetGameBtn.addEventListener("click", () => {
  openConfirmModal(
    "Reset ALL saved progress? This wipes your banked Gold, Score, purchased upgrades, and raider evolution, and takes you back to Level 1. This can't be undone.",
    () => {
      track(EVENTS.PROGRESS_RESET, {
        scope: "game",
        level: CURRENT_LEVEL,
        score: Math.floor(PROGRESS.score),
      });
      resetProgress();
      window.location.reload();
    }
  );
});

// ---------- Leaderboard ----------
// Read-only, global, and entirely optional: a run is submitted by hand at
// the end (see endBattle's gameOver branch), never automatically, and the
// whole feature disappears cleanly if Supabase isn't configured — the
// button is simply not shown, rather than being present and failing when
// clicked. See backend.js for why every call here returns { ok, error }
// instead of throwing: nothing about a network hiccup should be able to
// reach the render loop.
const leaderboardBtn = document.getElementById("leaderboard-btn");
const leaderboardModal = document.getElementById("leaderboard-modal");
const leaderboardBodyEl = document.getElementById("leaderboard-body");
const leaderboardCloseBtn = document.getElementById("leaderboard-close-btn");

const feedbackBtn = document.getElementById("feedback-btn");
const feedbackModal = document.getElementById("feedback-modal");
const feedbackMessageEl = document.getElementById("feedback-message");
const feedbackContactEl = document.getElementById("feedback-contact");
const feedbackStatusEl = document.getElementById("feedback-status");
const feedbackCancelBtn = document.getElementById("feedback-cancel-btn");
const feedbackSendBtn = document.getElementById("feedback-send-btn");

const scoreSubmitEl = document.getElementById("score-submit");
const scoreSubmitNameEl = document.getElementById("score-submit-name");
const scoreSubmitBtn = document.getElementById("score-submit-btn");
const scoreSubmitStatusEl = document.getElementById("score-submit-status");

// Without a backend these two features can't work at all, so hide their
// entry points rather than leaving dead buttons that error on click.
if (!isBackendConfigured) {
  leaderboardBtn.style.display = "none";
  feedbackBtn.style.display = "none";
}

// One helper for all three status lines (score submit, feedback, and any
// future one), so "pending" / "worked" / "failed" always look the same.
function setStatus(el, message, kind) {
  el.textContent = message;
  el.className = kind ? `status-${kind}` : "";
  el.classList.toggle("hidden", !message);
}

function renderLeaderboardMessage(text) {
  leaderboardBodyEl.replaceChildren();
  const el = document.createElement("div");
  el.className = "leaderboard-message";
  el.textContent = text;
  leaderboardBodyEl.appendChild(el);
}

function renderLeaderboardRows(rows) {
  leaderboardBodyEl.replaceChildren();
  if (rows.length === 0) {
    renderLeaderboardMessage("No runs yet — be the first.");
    return;
  }
  rows.forEach((row, index) => {
    const rowEl = document.createElement("div");
    rowEl.className = "leaderboard-row";

    const rank = document.createElement("span");
    rank.className = "leaderboard-rank";
    rank.textContent = `${index + 1}.`;

    // textContent, never innerHTML: player_name is text typed by other
    // people and arrives here straight from the database. Building the
    // row as real DOM nodes means a name containing markup is displayed
    // as characters, never parsed — the one genuine security concern in
    // rendering a public leaderboard.
    const name = document.createElement("span");
    name.className = "leaderboard-name";
    name.textContent = row.player_name;

    const level = document.createElement("span");
    level.className = "leaderboard-level";
    level.textContent = `Lv ${row.level_reached}`;

    const score = document.createElement("span");
    score.className = "leaderboard-score";
    score.textContent = Number(row.score).toLocaleString();

    rowEl.append(rank, name, level, score);
    leaderboardBodyEl.appendChild(rowEl);
  });
}

async function openLeaderboard() {
  leaderboardModal.classList.remove("hidden");
  renderLeaderboardMessage("Loading\u2026");
  track(EVENTS.LEADERBOARD_OPENED, { level: PROGRESS.level });

  const result = await fetchTopScores();
  // The player may well have closed the panel while this was in flight —
  // rendering into a hidden panel is harmless, but bailing keeps the next
  // open from briefly showing a stale result before its own load.
  if (leaderboardModal.classList.contains("hidden")) return;

  if (!result.ok) {
    renderLeaderboardMessage(result.error);
    return;
  }
  renderLeaderboardRows(result.rows);
}

function closeLeaderboard() {
  leaderboardModal.classList.add("hidden");
}

leaderboardBtn.addEventListener("click", openLeaderboard);
leaderboardCloseBtn.addEventListener("click", closeLeaderboard);

// ---------- Score submission (shown only when a run has actually ended) ----------
// Revealed by endBattle's gameOver branch, which is the only point at
// which a final Score exists — a run still in progress has no result
// worth putting on a public board.
function prepareScoreSubmission() {
  if (!isBackendConfigured) {
    scoreSubmitEl.classList.add("hidden");
    return;
  }
  scoreSubmitEl.classList.remove("hidden");
  scoreSubmitBtn.disabled = false;
  scoreSubmitNameEl.disabled = false;
  scoreSubmitNameEl.value = loadPlayerName();
  scoreSubmitNameEl.maxLength = MAX_NAME_LENGTH;
  setStatus(scoreSubmitStatusEl, "", null);
}

async function handleScoreSubmit() {
  const name = scoreSubmitNameEl.value.trim();
  if (!name) {
    setStatus(scoreSubmitStatusEl, "Enter a name first.", "error");
    return;
  }

  // Disabled for the whole round trip, so an impatient double-click can't
  // put the same run on the board twice.
  scoreSubmitBtn.disabled = true;
  setStatus(scoreSubmitStatusEl, "Submitting\u2026", "pending");

  const score = Math.floor(PROGRESS.score);
  const levelReached = PROGRESS.level;
  const result = await submitScore({ playerName: name, score, levelReached });

  if (!result.ok) {
    // Re-enabled on failure only — a genuine retry is the right move
    // after a dropped connection.
    scoreSubmitBtn.disabled = false;
    setStatus(scoreSubmitStatusEl, result.error, "error");
    return;
  }

  scoreSubmitNameEl.disabled = true;
  setStatus(scoreSubmitStatusEl, "You're on the board. Check Leaderboard up top.", "ok");
  track(EVENTS.SCORE_SUBMITTED, { score, level_reached: levelReached });
}

scoreSubmitBtn.addEventListener("click", handleScoreSubmit);
scoreSubmitNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleScoreSubmit();
});

// ---------- Feedback form ----------
// Available in every phase on purpose, including mid-battle: the moment
// something feels wrong is exactly when a player is willing to say so,
// and making them wait for the level to end loses most of that.
function openFeedback() {
  feedbackModal.classList.remove("hidden");
  feedbackSendBtn.disabled = false;
  setStatus(feedbackStatusEl, "", null);
  feedbackMessageEl.focus();
}

function closeFeedback() {
  feedbackModal.classList.add("hidden");
}

async function handleFeedbackSend() {
  const message = feedbackMessageEl.value.trim();
  if (!message) {
    setStatus(feedbackStatusEl, "Write something first.", "error");
    return;
  }

  feedbackSendBtn.disabled = true;
  setStatus(feedbackStatusEl, "Sending\u2026", "pending");

  const result = await submitFeedback({
    message,
    contact: feedbackContactEl.value,
    // Context the player shouldn't have to type out themselves — "this
    // level is impossible" is far more actionable with the level attached.
    levelReached: PROGRESS.level,
    score: Math.floor(PROGRESS.score),
  });

  if (!result.ok) {
    feedbackSendBtn.disabled = false;
    setStatus(feedbackStatusEl, result.error, "error");
    return;
  }

  // Cleared on success so a reopened form is blank rather than showing a
  // message that's already been sent (and inviting a duplicate).
  feedbackMessageEl.value = "";
  setStatus(feedbackStatusEl, "Thanks — that's been sent.", "ok");
  track(EVENTS.FEEDBACK_SUBMITTED, { level: PROGRESS.level });
}

feedbackBtn.addEventListener("click", openFeedback);
feedbackCancelBtn.addEventListener("click", closeFeedback);
feedbackSendBtn.addEventListener("click", handleFeedbackSend);

// Escape closes whichever overlay is open — standard for a modal, and
// worth having here specifically because these two are the only panels a
// player might open mid-battle and want out of quickly.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeLeaderboard();
  closeFeedback();
});

function spawnIntruders() {
  LEVEL_1_INTRUDERS.forEach(({ type, pos }) => {
    const [x, z] = pos;
    // Raiders spawn with their EVOLVED stats (see effectiveRaiderStats at
    // module init) — this is what actually makes evolution matter in
    // battle, not just in the display. Catapults (defined but unused) are
    // deliberately excluded from evolution and would fall back to base
    // stats here, since only "raider" is evolved.
    const statsOverride = type === "raider" ? effectiveRaiderStats : null;
    const unit = new Unit(type, new THREE.Vector3(x, 0, z), scene, statsOverride);
    snapToTerrain(unit);
    intruders.push(unit);
  });
}

function startDeathFade(unit) {
  dyingUnits.push({ unit, t: 0 });
}

// Single place where damage actually gets applied to a unit — handles the
// health reduction, the floating number (shown above the attacker, not the
// target), triggering the death fade, and reactive aggro. Both melee hits
// and projectile impacts route through here. Also the single chokepoint
// for the two level-spec damage-negation abilities (Pierce Resistance,
// Evasion) — routing them through here, rather than special-casing them
// in the melee/ranged attack code that CALLS this function, is what makes
// them apply uniformly to every source of damage (a Knight's melee swing,
// an Archer's arrow, a Mage's splash) with no risk of one attack path
// forgetting the check.
function applyDamage(attacker, target, amount) {
  // Pierce Resistance: takes 0 damage from Archers specifically (not
  // Knights, not Mages) — deterministic, not a chance roll, so it's
  // checked first and short-circuits the (also possible) Evasion roll
  // below entirely when it applies.
  let actualAmount = amount;
  let blockedReason = null;
  if (target.stats.pierceRes && attacker.type === "archer") {
    actualAmount = 0;
    blockedReason = "resisted";
  } else if (target.stats.evasionChance && Math.random() < target.stats.evasionChance) {
    actualAmount = 0;
    blockedReason = "evaded";
  }

  const killed = target.takeDamage(actualAmount);
  spawnDamageNumber(attacker.mesh.position, actualAmount, blockedReason);

  // Lifesteal (see items.js's lifestealPercent) — heals the ATTACKER for
  // a fraction of whatever damage actually landed. Uses actualAmount
  // (post evasion/pierce-res reduction, and after any crit multiplier
  // already baked into `amount` by attackDamageAgainst) — no stealing
  // life from a hit that didn't land. Only defenders can ever have this
  // stat (raiders never do — see items.js, it's a defender-only item
  // effect), so this is always a no-op for a raider's attack.
  if (attacker.stats.lifestealPercent && actualAmount > 0) {
    const healed = actualAmount * attacker.stats.lifestealPercent;
    attacker.heal(healed);
    spawnHealNumber(attacker.mesh.position, healed);
  }

  // Reactive aggro: if a mobile unit has NOTHING it's already committed to
  // (no target, or its previous one just died), getting hit is a
  // reasonable trigger to go after whoever attacked. But once it's
  // already chasing — or fighting — something ALIVE, a stray hit from a
  // THIRD party must NOT redirect it. A real bug here: a slow, high-HP
  // unit (Boss/Champions) getting hit by several defenders in the same
  // stretch would re-target on every single hit, before ever actually
  // reaching whichever target it most recently switched to — visibly
  // "stuck, shaking, switching targets forever," reported directly. The
  // OLD condition (`!target.isMeleeEngaged`) only suppressed switching
  // once ALREADY in melee range and actively fighting, which never
  // protects a unit still closing the distance, and never protects a
  // MOBILE RANGED unit at all (isMeleeEngaged is only ever true for melee
  // — a Flying raider, already ranged, could get reactively redirected
  // on every hit even while mid-volley against something). "Has a live
  // target" is a strict superset of "isMeleeEngaged" (every melee-engaged
  // unit has a live target; having one doesn't require being melee-
  // engaged yet), so checking that instead fixes the slow-unit thrashing
  // and the flying-unit case in the same change, for every raider type —
  // this is shared, unconditional logic, not something that needs
  // per-wave-type special-casing.
  const hasCommittedTarget = !!target.target && target.target.alive;
  if (!killed && target.alive && !target.stats.stationary && !hasCommittedTarget && target.target !== attacker) {
    releaseMeleeSlot(target);
    target.target = attacker;
    target.path = null;
    target.pathTarget = null;
  }

  if (killed) {
    startDeathFade(target);
    // Item drops only for raiders actually defeated in combat — a raider
    // that reaches the city (applyCityArrival, a bad outcome for the
    // player) is removed through a completely separate code path and
    // deliberately never calls applyDamage, so it can never roll a drop.
    if (target.team === "intruder") rollAndCollectItemDrop();
  }
  return killed;
}

// Rolls a drop against the CURRENT LEVEL's type (every raider in a battle
// shares one level type — see CURRENT_LEVEL_TYPE at module init; drop
// rate is deliberately type-only, unaffected by spec — see items.js's
// DROP_TABLES) — not `displayedLevelType`, which can already point at the
// NEXT level's type once a result banner is showing. Adds any resulting
// item straight to the persistent backpack and saves immediately, so a
// drop survives an accidental refresh mid-battle exactly like every other
// persisted fact in this game.
function rollAndCollectItemDrop() {
  const itemKey = rollItemDrop(CURRENT_LEVEL_TYPE);
  if (!itemKey) return;
  addDroppedItem(PROGRESS, itemKey);
  saveProgress(PROGRESS);
  showItemDropToast(itemKey);
  refreshBackpackBadge();
  if (!backpackPanel.classList.contains("hidden")) renderBackpackPanel();
}

// Applies (or refreshes) the freeze/slow status on `unit` — see
// unit.js's freezeTimer/freezeSlowAmount fields for what this actually
// does to move speed and (via the attackCooldown reset in updateBattle)
// attack speed. A fresh application REFRESHES the timer rather than
// stacking it, and simply overwrites the slow amount — there's only ever
// one source of freeze right now (the Mage), so there's no need for
// max()-style "strongest source wins" logic yet.
function applyFreeze(unit, freeze) {
  if (!freeze) return;
  unit.freezeTimer = freeze.duration;
  unit.freezeSlowAmount = freeze.slowPercent;
}

// Splash damage for a ranged attacker whose stats declare a splashRadius
// (currently only the Mage) — every living enemy within splashRadius of
// the impact point takes the SAME damage the primary target took (no
// falloff), routed through the normal applyDamage so damage numbers,
// reactive aggro, and death-fade all behave exactly like an ordinary hit.
// The Mage's freeze effect is deliberately applied here too, not as a
// separate mechanic — "freezing effect included in splash radius effect"
// means every unit caught in the blast gets frozen, not just the one
// that was directly targeted.
//
// Reuses the existing Projectile class completely unmodified: this is
// just a different onImpact callback, swapped in at the projectile's
// creation site in updateBattle. One consequence worth knowing, inherited
// from Projectile's own (pre-existing, unrelated to this feature) impact
// check: if the primary target itself dies from another source mid-flight,
// the projectile's onImpact never fires at all (Projectile only calls it
// `if (this.targetUnit.alive)`), so a splash hit is skipped entirely in
// that rare case rather than still landing on nearby survivors.
function applySplashImpact(attacker, primaryTarget, damage, impactPos, stats) {
  const enemyList = attacker.team === "defender" ? intruders : defenders;
  for (const u of enemyList) {
    if (!u.alive) continue;
    if (flatDist(u.mesh.position, impactPos) > stats.splashRadius) continue;
    applyDamage(attacker, u, damage);
    applyFreeze(u, stats.freeze);
  }
}

// Called once, when a raider physically reaches the city gate point
// (CITY_TARGET) — only possible once every defender is dead (see the
// targeting branch in updateBattle). Deliberately NOT routed through
// applyDamage/takeDamage: this isn't combat damage taken BY the raider,
// it's the raider reaching an objective, and the amount here reduces
// CITY health, not the raider's own. The raider is removed via the exact
// same fade-and-destroy pipeline every other death already uses
// (startDeathFade -> updateDyingUnits -> unit.destroy) — "vanish" reads
// naturally as the same smooth shrink-out already used for combat deaths,
// not a new animation.
function applyCityArrival(raider) {
  const rawDamage = computeCityDamage(raider.health, totalWaveHealth);
  // Aegis of the City (see items.js's cityDamageReductionPercent) — a
  // flat percentage taken off every raider's city-arrival damage,
  // clamped so stacking several copies can never push the multiplier
  // negative (i.e. never turn city damage into city healing).
  const damage = rawDamage * Math.max(0, 1 - globalItemBonuses.cityDamageReductionPercent);
  applyCityDamage(PROGRESS, damage);
  cityDamageDealtThisLevel += damage;
  updateCityHealthDisplay();
  spawnCityDamageNumber(raider.mesh.position, damage);

  raider.alive = false;
  startDeathFade(raider);
}

// ---------- Unit type selector ----------
unitButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    selectedType = btn.dataset.type;
    unitButtons.forEach((b) => b.classList.toggle("selected", b === btn));
  });
});

// A still-locked unit type (currently just the Mage) is hidden outright
// rather than shown disabled with a "🔒 Lv N" note — it should simply
// reveal itself once the level requirement is met, not advertise a
// not-yet-available feature in the meantime.
function refreshAffordability() {
  unitButtons.forEach((btn) => {
    const stats = UNIT_STATS[btn.dataset.type];
    const locked = !!stats.unlockLevel && CURRENT_LEVEL < stats.unlockLevel;
    btn.classList.toggle("hidden", locked);
    btn.disabled = locked || stats.cost > population;
  });
}
refreshAffordability();

// ---------- Upgrade shop ----------
// A single reusable panel with three entry points: (1) a topbar button,
// visible any time a level isn't actively running (i.e. NOT phase
// "battle" — see refreshShopVisibility), per explicit request; (2)
// automatically after a win, alongside the earned-Gold banner, with a
// "Continue" action that starts the next (harder) level; (3) automatically
// after a loss, so previously-banked Gold can be spent before retrying.
// Every purchase saves immediately — the shop's own buttons never need a
// separate "confirm" step. Buying an upgrade after some defenders are
// already placed this level immediately resyncs their live stats (see
// resyncPlacedDefenderStats) rather than leaving them on stale numbers.
function refreshShopVisibility() {
  shopToggleBtn.style.display = phase !== "battle" ? "" : "none";
}

// Both attack speed and freeze-slow are stored/returned as a FRACTION of
// base (see progression.js), so both display as a percentage here.
function isPercentStat(stat) {
  return stat === "attackSpeedPercent" || stat === "freezeSlowPercent";
}
function formatUpgradeAmount(upg) {
  return isPercentStat(upg.stat) ? `${Math.round(upg.amount * 100)}%` : `${upg.amount}`;
}

// Upgrade matrix: one row per stat, one column per unit type. Replaces the
// old layout of three long stacked per-unit sections (Knight's four rows,
// then Archer's five, then Mage's five) — that read fine but forced a lot
// of vertical scrolling to compare anything. A grid puts every number in
// view at once and makes "which unit is ahead on X" a glance instead of a
// scroll. Row labels are the plain stat name ONLY (no more "Knight
// Vitality" / "Archer Sharpening" / "Mage Frostbite") — the unit is
// already the column, so naming it again per-cell was pure noise.
const SHOP_MATRIX_ROWS = [
  { stat: "health", label: "Health" },
  { stat: "damage", label: "Damage" },
  { stat: "attackSpeedPercent", label: "Attack Speed" },
  { stat: "armor", label: "Armor" },
  { stat: "range", label: "Range" },
  { stat: "freezeSlowPercent", label: "Freeze" },
];
const SHOP_MATRIX_UNIT_TYPES = ["knight", "archer", "mage"];

// Not every unit has every stat (only Archer/Mage upgrade Range, only Mage
// upgrades Freeze) — this just finds whichever UPGRADES entry matches, or
// null if that unit/stat combination has no upgrade at all.
function findUpgradeKey(unitType, stat) {
  for (const key in UPGRADES) {
    const upg = UPGRADES[key];
    if (upg.unitType === unitType && upg.stat === stat) return key;
  }
  return null;
}

// The CURRENT live value for one (unit type, stat) pair — includes upgrades
// and active items, same source `effectiveStats` the Defender Stats panel
// reads. Returns null when the stat genuinely doesn't exist on this unit at
// all (only Mage has a `freeze` object), as opposed to merely not being
// purchasable — Knight's melee Range, for instance, is real and shown as
// "Melee" even though there's no knightRange upgrade to buy for it.
function getCurrentStatDisplay(unitType, stat) {
  const eff = effectiveStats[unitType];
  switch (stat) {
    case "health":
      return formatStatNumber(eff.maxHealth);
    case "damage":
      return `${formatStatNumber(eff.damageMin)}–${formatStatNumber(eff.damageMax)}`;
    case "attackSpeedPercent":
      return `${eff.attackSpeed.toFixed(2)}/s`;
    case "armor":
      return formatStatNumber(eff.armor);
    case "range":
      return unitType === "knight" ? "Melee" : formatStatNumber(eff.range);
    case "freezeSlowPercent":
      return eff.freeze ? `${Math.round(eff.freeze.slowPercent * 100)}%` : null;
    default:
      return null;
  }
}

// Each cell is split left/right: the unit's current value for this stat on
// the left (so a purchase's effect is visible in place, not just implied by
// a separate delta line), and — only when this stat is actually purchasable
// for this unit — a buy button on the right, boost on its own line above
// price so neither gets cramped at this cell size.
function buildShopMatrixCell(unitType, stat) {
  const currentDisplay = getCurrentStatDisplay(unitType, stat);
  const key = findUpgradeKey(unitType, stat);

  const cell = document.createElement("div");
  cell.className = "shop-cell";

  if (currentDisplay === null) {
    cell.classList.add("shop-cell-empty");
    cell.textContent = "—";
    return cell;
  }

  const currentEl = document.createElement("div");
  currentEl.className = "shop-cell-current";
  currentEl.textContent = currentDisplay;
  cell.appendChild(currentEl);

  if (!key) {
    const none = document.createElement("div");
    none.className = "shop-cell-no-upgrade";
    none.textContent = "—";
    cell.appendChild(none);
    return cell;
  }

  const upg = UPGRADES[key];
  const cost = getUpgradeCost(key, PROGRESS.purchases);

  const buyBtn = document.createElement("button");
  buyBtn.className = "shop-cell-buy";
  buyBtn.title = `Spend ${cost} Gold for +${formatUpgradeAmount(upg)}`;
  buyBtn.disabled = PROGRESS.gold < cost;

  const boostEl = document.createElement("div");
  boostEl.className = "shop-cell-buy-boost";
  boostEl.textContent = `+${formatUpgradeAmount(upg)}`;
  buyBtn.appendChild(boostEl);

  const priceEl = document.createElement("div");
  priceEl.className = "shop-cell-buy-price";
  priceEl.textContent = `${cost} \u{1FA99}`;
  buyBtn.appendChild(priceEl);

  buyBtn.addEventListener("click", () => {
    const result = purchaseUpgrade(PROGRESS, key);
    if (!result.ok) return;
    saveProgress(PROGRESS);
    track(EVENTS.UPGRADE_PURCHASED, {
      upgrade: key,
      cost,
      // Post-purchase count, so "how deep do people stack this one"
      // reads directly off the event without needing a running total.
      purchase_count: PROGRESS.purchases[key],
      level: CURRENT_LEVEL,
    });
    effectiveStats = computeEffectiveStats();
    resyncPlacedDefenderStats();
    renderShop();
    if (!defenderStatsPanel.classList.contains("hidden")) renderDefenderStatsPanel();
  });
  cell.appendChild(buyBtn);

  return cell;
}

function buildShopMatrix() {
  const matrix = document.createElement("div");
  matrix.className = "shop-matrix";

  matrix.appendChild(document.createElement("div")); // blank corner cell
  for (const unitType of SHOP_MATRIX_UNIT_TYPES) {
    const stats = UNIT_STATS[unitType];
    const header = document.createElement("div");
    header.className = "shop-matrix-col-header";
    header.textContent = stats.label;
    // Purchasing upgrades ahead of unlocking a unit is harmless (the
    // bonus just sits banked until it's actually placeable), so the
    // column isn't hidden or disabled while locked — just labeled, same
    // spirit as the Upcoming Levels panel letting players plan ahead.
    if (stats.unlockLevel && CURRENT_LEVEL < stats.unlockLevel) {
      const lock = document.createElement("span");
      lock.className = "lock-note";
      lock.textContent = `Level ${stats.unlockLevel}`;
      header.appendChild(lock);
    }
    matrix.appendChild(header);
  }

  for (const row of SHOP_MATRIX_ROWS) {
    const label = document.createElement("div");
    label.className = "shop-matrix-row-label";
    label.textContent = row.label;
    matrix.appendChild(label);
    for (const unitType of SHOP_MATRIX_UNIT_TYPES) {
      matrix.appendChild(buildShopMatrixCell(unitType, row.stat));
    }
  }

  return matrix;
}

function buildPopulationRow() {
  const cost = getPopulationUpgradeCost(PROGRESS.populationPurchases);
  const currentTotal = BASE_POPULATION + PROGRESS.populationPurchases * POPULATION_PER_PURCHASE;

  const row = document.createElement("div");
  row.className = "shop-row";

  const info = document.createElement("div");
  info.className = "shop-row-info";
  const title = document.createElement("div");
  title.className = "shop-row-title";
  title.textContent = "Population";
  const current = document.createElement("div");
  current.className = "shop-row-bonus";
  current.textContent = `Current: +${PROGRESS.populationPurchases} (total ${currentTotal} per level)`;
  info.appendChild(title);
  info.appendChild(current);

  const buyBtn = document.createElement("button");
  buyBtn.className = "shop-buy-btn";
  buyBtn.textContent = `+${POPULATION_PER_PURCHASE} · ${cost}`;
  buyBtn.title = `Spend ${cost} Gold for +${POPULATION_PER_PURCHASE} Population`;
  buyBtn.disabled = PROGRESS.gold < cost;
  buyBtn.addEventListener("click", () => {
    const result = purchasePopulation(PROGRESS);
    if (!result.ok) return;
    saveProgress(PROGRESS);
    track(EVENTS.POPULATION_PURCHASED, {
      cost,
      purchase_count: PROGRESS.populationPurchases,
      level: CURRENT_LEVEL,
    });
    // Extends the live REMAINING budget by the purchase amount — correct
    // whether this happens before anything's been placed this level or
    // after (see refreshShopVisibility, which now allows either), since
    // "remaining" already accounts for whatever's already been spent.
    // Takes effect immediately, no reload needed.
    population += POPULATION_PER_PURCHASE;
    populationValue.textContent = population;
    refreshAffordability();
    renderShop();
  });

  row.appendChild(info);
  row.appendChild(buyBtn);
  return row;
}

function renderShop() {
  shopGoldValue.textContent = Math.floor(PROGRESS.gold);
  bankedGoldValue.textContent = Math.floor(PROGRESS.gold);

  shopUpgradesEl.innerHTML = "";

  const popSection = document.createElement("div");
  popSection.className = "shop-section";
  const popTitle = document.createElement("div");
  popTitle.className = "shop-section-title";
  popTitle.textContent = "Population";
  popSection.appendChild(popTitle);
  popSection.appendChild(buildPopulationRow());
  shopUpgradesEl.appendChild(popSection);

  shopUpgradesEl.appendChild(buildShopMatrix());
}

function openShop(mode) {
  // Purely for the reward-line banner now — proceeding to the next level
  // or retrying lives entirely in #result-primary-btn (see endBattle),
  // deliberately separate from this panel so closing/browsing the shop
  // never gets confused with actually starting the next level. Text
  // content for "win" mode (reward + interest lines) is set by endBattle
  // BEFORE this is called, since it needs the actual computed reward
  // amount — this only controls visibility.
  shopRewardLine.classList.toggle("hidden", mode !== "win");
  shopPrimaryBtn.textContent = "Close";
  renderShop();
  shopPanel.classList.remove("hidden");
}

function closeShop() {
  shopPanel.classList.add("hidden");
}

shopToggleBtn.addEventListener("click", () => {
  if (phase === "battle") return;
  openShop("browse");
});

shopPrimaryBtn.addEventListener("click", closeShop);

refreshShopVisibility();

// ---------- Item drops & backpack ----------
// Dropped items are ALWAYS viewable (see backpackToggleBtn's click
// handler below — no phase check, unlike the shop's toggle button) so a
// player can immediately look at what a kill just dropped mid-battle. But
// ACTIVATING/DEACTIVATING an item follows the exact same rule as the
// upgrade shop (`canModifyBackpack`, mirroring shopToggleBtn's own guard)
// — allowed any time a level isn't actively running, per explicit request.
// Doing so after some defenders are already placed this level immediately
// resyncs their live stats (see resyncPlacedDefenderStats) rather than
// leaving them on stale numbers.
function canModifyBackpack() {
  return phase !== "battle";
}

function refreshBackpackBadge() {
  backpackCountEl.textContent = `(${PROGRESS.backpack.length})`;
  backpackActiveCountEl.textContent = `Active: ${countActiveItems(PROGRESS)}/${MAX_ACTIVE_ITEMS}`;
}
refreshBackpackBadge();

function refreshBackpackIfOpen() {
  if (!backpackPanel.classList.contains("hidden")) renderBackpackPanel();
}

// Rarity is communicated by color (tier-common/rare/legendary — see
// style.css) via the CSS classes below, not by an icon prefix, so it
// doesn't need its own glyph on top of the text label.
const TIER_LABELS = { common: "Common", rare: "Rare", legendary: "Legendary" };

function showItemDropToast(itemKey) {
  const item = ITEMS[itemKey];
  itemDropToast.textContent = `${TIER_LABELS[item.tier]} item: ${item.label}`;
  itemDropToast.className = `tier-${item.tier}`;
  // Force a reflow before adding "visible" so the fade-in transition
  // actually plays even if a toast is already mid-fade (re-triggering the
  // transition on a class that's already applied is otherwise a no-op).
  void itemDropToast.offsetWidth;
  itemDropToast.classList.add("visible");
  clearTimeout(showItemDropToast._timer);
  showItemDropToast._timer = setTimeout(() => itemDropToast.classList.remove("visible"), 3000);
}

// Applies the shared side effects of any single activate/deactivate
// action — saving, recomputing both per-defender and global item
// bonuses, and refreshing every panel that could be showing stale
// numbers. Every stepper button (see buildItemStackRow) funnels through
// this so there's exactly one place that has to get the refresh list
// right, regardless of which instance in a stack actually changed.
function afterItemActivationChange() {
  saveProgress(PROGRESS);
  effectiveStats = computeEffectiveStats();
  globalItemBonuses = computeGlobalItemBonuses(getActiveItemKeys(PROGRESS));
  resyncPlacedDefenderStats();
  refreshBackpackBadge();
  renderBackpackPanel();
  // Items only ever affect defenders (per-unit bonuses) or global bonuses
  // (city damage reduction, gold gain) — never raiders — so only the
  // Defender panel can be showing stale numbers here.
  if (!defenderStatsPanel.classList.contains("hidden")) renderDefenderStatsPanel();
}

// One row per item TYPE, not per instance — `instances` is every copy of
// this exact item currently in the backpack (1 or more). Duplicate drops
// stack into a single "Swift Tonic ×3" row with a compact +/− stepper
// instead of N separate rows with their own Activate buttons, while the
// underlying data model still tracks and activates/deactivates ONE
// instance at a time (see items.js's doc comment on why instances stay
// individual) — the stepper's "+" just finds the next INACTIVE instance
// in the stack and activates that one specific instanceId, and "−" finds
// the next ACTIVE one and deactivates it. Which physical instance gets
// picked never matters since every instance of the same item has an
// identical effect.
function buildItemStackRow(itemKey, instances) {
  const item = ITEMS[itemKey];
  const activeCount = instances.filter((i) => i.active).length;
  const totalCount = instances.length;
  const modifiable = canModifyBackpack();

  const row = document.createElement("div");
  row.className = `item-row tier-${item.tier}${activeCount > 0 ? " active" : ""}`;

  const top = document.createElement("div");
  top.className = "item-row-top";

  const info = document.createElement("div");
  info.className = "item-row-info";
  const title = document.createElement("div");
  title.className = "item-row-title";
  title.textContent = totalCount > 1 ? `${item.label} ×${totalCount}` : item.label;
  const tierLabel = document.createElement("div");
  tierLabel.className = `item-row-tier tier-${item.tier}`;
  tierLabel.textContent = TIER_LABELS[item.tier];
  info.appendChild(title);
  info.appendChild(tierLabel);

  const stepper = document.createElement("div");
  stepper.className = "item-stepper";

  const minusBtn = document.createElement("button");
  minusBtn.className = "item-stepper-btn";
  minusBtn.textContent = "−";
  minusBtn.disabled = !modifiable || activeCount === 0;
  minusBtn.title = !modifiable ? "Activate or deactivate items before placing your first defender this level" : "Deactivate one";
  minusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (minusBtn.disabled) return;
    const toDeactivate = instances.find((i) => i.active);
    if (!toDeactivate) return;
    const result = setItemActive(PROGRESS, toDeactivate.instanceId, false);
    if (!result.ok) return;
    afterItemActivationChange();
  });

  const countEl = document.createElement("span");
  countEl.className = "item-stepper-count";
  countEl.textContent = totalCount > 1 ? `${activeCount}/${totalCount}` : activeCount > 0 ? "Active" : "Inactive";

  const plusBtn = document.createElement("button");
  plusBtn.className = "item-stepper-btn";
  plusBtn.textContent = "+";
  const atCapacity = countActiveItems(PROGRESS) >= MAX_ACTIVE_ITEMS;
  plusBtn.disabled = !modifiable || activeCount === totalCount || atCapacity;
  plusBtn.title = !modifiable
    ? "Activate or deactivate items before placing your first defender this level"
    : activeCount === totalCount
      ? "All copies of this item are already active"
      : atCapacity
        ? `Only ${MAX_ACTIVE_ITEMS} items can be active at once — deactivate one first`
        : "Activate one";
  plusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (plusBtn.disabled) return;
    const toActivate = instances.find((i) => !i.active);
    if (!toActivate) return;
    const result = setItemActive(PROGRESS, toActivate.instanceId, true);
    if (!result.ok) return;
    afterItemActivationChange();
  });

  stepper.appendChild(minusBtn);
  stepper.appendChild(countEl);
  stepper.appendChild(plusBtn);

  top.appendChild(info);
  top.appendChild(stepper);

  const desc = document.createElement("div");
  desc.className = "item-row-description hidden";
  desc.textContent = item.description;

  // Clicking anywhere on the row EXCEPT the stepper buttons (which call
  // stopPropagation above) expands/collapses the description — a
  // deliberately separate interaction from activating, per spec ("player
  // must be able to click item to read its effect" is its own
  // requirement, not the same click as switching one on/off).
  row.addEventListener("click", () => desc.classList.toggle("hidden"));

  row.appendChild(top);
  row.appendChild(desc);
  return row;
}

function renderBackpackPanel() {
  refreshBackpackBadge();
  backpackLockNote.classList.toggle("hidden", canModifyBackpack());
  backpackBodyEl.innerHTML = "";

  if (PROGRESS.backpack.length === 0) {
    const note = document.createElement("div");
    note.className = "backpack-empty-note";
    note.textContent = "No items collected yet — defeated raiders have a chance to drop loot.";
    backpackBodyEl.appendChild(note);
    return;
  }

  for (const tier of ITEM_TIERS.slice().reverse()) {
    const tierInstances = PROGRESS.backpack.filter((i) => ITEMS[i.itemKey].tier === tier);
    if (tierInstances.length === 0) continue;
    // Group same-item instances into one stack, in first-dropped order.
    const groups = new Map();
    for (const instance of tierInstances) {
      if (!groups.has(instance.itemKey)) groups.set(instance.itemKey, []);
      groups.get(instance.itemKey).push(instance);
    }
    const section = document.createElement("div");
    section.className = "shop-section";
    const title = document.createElement("div");
    title.className = `shop-section-title tier-${tier}`;
    title.textContent = TIER_LABELS[tier];
    section.appendChild(title);
    for (const [itemKey, instances] of groups) section.appendChild(buildItemStackRow(itemKey, instances));
    backpackBodyEl.appendChild(section);
  }
}

function openBackpackPanel() {
  renderBackpackPanel();
  backpackPanel.classList.remove("hidden");
}

function closeBackpackPanel() {
  backpackPanel.classList.add("hidden");
}

backpackToggleBtn.addEventListener("click", openBackpackPanel);
backpackCloseBtn.addEventListener("click", closeBackpackPanel);

// ---------- Unit stats reference panel ----------
// Read-only — unlike the shop, this never mutates game state, so it's
// available in every phase (including mid-battle, where seeing exactly
// what a Knight currently hits for is arguably most useful). Shows each
// defender's live effective stats (base + any purchased upgrades), with
// the upgrade portion called out in green so it doubles as a quick way to
// track upgrade progress across a run.
// Item bonuses are PERCENTAGE multipliers (see items.js's applyItemBonuses),
// unlike upgrades' clean integer-additive math — multiplying a base stat by
// e.g. 1.05 routinely lands on an ordinary binary-floating-point value like
// 16.799999999999997 or, worse, a subtraction like 21 - 20.2 producing
// 0.8000000000000007. Every stats-panel number (not just item-affected
// ones, for consistency) is rounded to 1 decimal place for display through
// this one formatter — and drops the trailing ".0" for a stat that landed
// on a whole number, so an un-itemized "150" still reads as "150", not
// "150.0". The underlying numeric stats themselves are never touched;
// this only affects what gets rendered.
function formatStatNumber(n) {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function appendStatsRow(card, label, value, bonus, bonusSuffix) {
  const row = document.createElement("div");
  row.className = "stats-row";
  const labelEl = document.createElement("span");
  labelEl.className = "stats-row-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.textContent = value;
  if (bonus > 0) {
    const bonusEl = document.createElement("span");
    bonusEl.className = "stats-row-bonus";
    bonusEl.textContent = `(+${formatStatNumber(bonus)}${bonusSuffix || ""})`;
    valueEl.appendChild(bonusEl);
  }
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  card.appendChild(row);
}

// Attacker rows deliberately never take a bonus/delta argument (unlike
// appendStatsRow above) — per explicit request, raider stats are shown as
// plain current values ("what it is right now"), not as a base+delta
// breakdown the way defender upgrade progress is. Evolution still changes
// these numbers over a run; this just stops narrating the change inline.
function appendStatsRowPlain(card, label, value) {
  const row = document.createElement("div");
  row.className = "stats-row";
  const labelEl = document.createElement("span");
  labelEl.className = "stats-row-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  card.appendChild(row);
}

// Defender and Attacker stats used to be one panel with two independently
// collapsible sections inside it — that read as unintuitive (a toggle
// button that opens a panel you then have to expand again) and was still
// heavy enough to need scrolling. Split into two entirely separate
// buttons/panels instead: each one is a plain, single-purpose popover with
// no internal collapse state to manage, and each is naturally about half
// the length the combined panel was.
function renderDefenderStatsPanel() {
  defenderStatsBodyEl.innerHTML = "";

  for (const type of ["knight", "archer", "mage"]) {
    const base = UNIT_STATS[type];
    const eff = effectiveStats[type];
    const hpBonus = eff.maxHealth - base.maxHealth;
    const dmgBonus = eff.damageMin - base.damageMin; // same delta on both ends
    const armorBonus = eff.armor - base.armor;
    // Attack speed is a rate (see progression.js) — the bonus is
    // expressed as a % of base rather than a raw delta, matching the
    // shop's own display.
    const atkSpdBonusPct = Math.round(((eff.attackSpeed / base.attackSpeed) - 1) * 100);

    const card = document.createElement("div");
    card.className = "stats-unit-card";

    const title = document.createElement("div");
    title.className = "stats-unit-title";
    title.textContent = base.label;
    if (base.unlockLevel && CURRENT_LEVEL < base.unlockLevel) {
      title.textContent += ` (Lv ${base.unlockLevel})`;
    }
    card.appendChild(title);

    // Knights fight in melee — their range is an engagement-distance
    // constant used by battle logic, not something a player strategizes
    // over the way an archer's is (there's no upgrade for it either — see
    // progression.js). Shown as "Melee" here purely for display; the
    // underlying numeric range is untouched and still drives combat
    // exactly as before.
    const rangeRow =
      type === "knight"
        ? ["Range", "Melee", 0]
        : ["Range", formatStatNumber(eff.range), eff.range - base.range];

    appendStatsRow(card, "HP", formatStatNumber(eff.maxHealth), hpBonus);
    appendStatsRow(card, "Damage", `${formatStatNumber(eff.damageMin)}-${formatStatNumber(eff.damageMax)}`, dmgBonus);
    appendStatsRow(card, "Attack Speed", `${eff.attackSpeed.toFixed(2)}/s`, atkSpdBonusPct, "%");
    appendStatsRow(card, "Armor", formatStatNumber(eff.armor), armorBonus);
    appendStatsRow(card, ...rangeRow);
    appendStatsRow(card, "Cost", `${base.cost} pop`, 0);
    if (type === "mage") {
      const freezePctBonus = Math.round((eff.freeze.slowPercent - base.freeze.slowPercent) * 100);
      appendStatsRow(card, "Splash Radius", formatStatNumber(eff.splashRadius), 0);
      appendStatsRow(card, "Freeze Slow", `${Math.round(eff.freeze.slowPercent * 100)}%`, freezePctBonus, "%");
      appendStatsRow(card, "Freeze Duration", `${eff.freeze.duration}s`, 0);
    }

    defenderStatsBodyEl.appendChild(card);
  }
}

// Values are shown PLAIN (appendStatsRowPlain, no "(+X%)" delta) — raider
// evolution (progression.js) still changes these numbers over a run, this
// just states the current number rather than narrating the change.
function renderAttackerStatsPanel() {
  attackerStatsBodyEl.innerHTML = "";

  const raiderEff = effectiveRaiderStats;

  const raiderCard = document.createElement("div");
  raiderCard.className = "stats-unit-card stats-attacker-card";
  const raiderTitle = document.createElement("div");
  raiderTitle.className = "stats-unit-title";
  raiderTitle.textContent = `Raiders (${formatLevelLabel(displayedLevelType, displayedLevelSpec)})`;
  raiderCard.appendChild(raiderTitle);

  appendStatsRowPlain(raiderCard, "Number", `${effectiveRaiderCount}`);
  appendStatsRowPlain(raiderCard, "HP", `${Math.round(raiderEff.maxHealth)}`);
  appendStatsRowPlain(raiderCard, "Attack Damage", `${Math.round(raiderEff.damageMin)}-${Math.round(raiderEff.damageMax)}`);
  appendStatsRowPlain(raiderCard, "Attack Speed", `${raiderEff.attackSpeed.toFixed(2)}/s`);
  appendStatsRowPlain(raiderCard, "Armor", `${raiderEff.armor}`);

  attackerStatsBodyEl.appendChild(raiderCard);
}

// Opening one closes the other — they're alternate views of the same kind
// of information (unit stats), so treating them like a tab pair avoids two
// popovers stacking on top of each other at the same bottom-left corner.
defenderStatsToggleBtn.addEventListener("click", () => {
  if (defenderStatsPanel.classList.contains("hidden")) {
    attackerStatsPanel.classList.add("hidden");
    renderDefenderStatsPanel();
    defenderStatsPanel.classList.remove("hidden");
  } else {
    defenderStatsPanel.classList.add("hidden");
  }
});

attackerStatsToggleBtn.addEventListener("click", () => {
  if (attackerStatsPanel.classList.contains("hidden")) {
    defenderStatsPanel.classList.add("hidden");
    renderAttackerStatsPanel();
    attackerStatsPanel.classList.remove("hidden");
  } else {
    attackerStatsPanel.classList.add("hidden");
  }
});

// LEVEL_TYPES/LEVEL_SPECS colors (progression.js) were picked as 3D-scene
// unit tint colors, not for text-on-dark-panel contrast — Boss's near-black
// purple (0x4a1a4a) is a real case of that mismatch, unreadable against the
// Upcoming panel's own near-black background. Rather than hand-pick an
// override for Boss alone (the next added type could hit the same problem),
// this lightens ANY color that falls below a minimum perceived luminance,
// blending it toward white just enough to clear that floor — brighter, but
// still recognizably the same hue, so color-coding between level types
// still works. Luminance is linear in the blend fraction t (standard sRGB
// perceptual weights, since 0.299+0.587+0.114 = 1), so the blend needed to
// exactly reach minLuminance solves in closed form rather than a search.
function ensureReadableTextColor(hex, minLuminance = 0.55) {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (luminance >= minLuminance) return hex;
  const t = Math.min(1, (minLuminance - luminance) / (1 - luminance));
  const lerp = (c) => Math.round(c + (255 - c) * t);
  return (lerp(r) << 16) | (lerp(g) << 8) | lerp(b);
}

// ---------- Upcoming levels panel ----------
// Read-only, same reasoning as the stats panel (never mutates game
// state, so it's fine to show in any phase). Levels are predetermined —
// see progression.js's ensureLevelSchedule — so this always shows
// the SAME committed types/specs every time it's opened, not a fresh roll.
function renderUpcomingPanel() {
  upcomingBodyEl.innerHTML = "";
  for (let i = 1; i <= LEVEL_TYPE_LOOKAHEAD; i++) {
    const lvl = CURRENT_LEVEL + i;
    const typeKey = getLevelType(PROGRESS, lvl);
    const specKey = getLevelSpec(PROGRESS, lvl);
    const levelType = LEVEL_TYPES[typeKey];

    const row = document.createElement("div");
    row.className = "upcoming-row";

    const levelEl = document.createElement("span");
    levelEl.className = "upcoming-row-level";
    levelEl.textContent = `Lvl ${lvl}`;

    const typeEl = document.createElement("span");
    typeEl.className = "upcoming-row-type";
    typeEl.textContent = formatLevelLabel(typeKey, specKey);
    typeEl.style.color = "#" + ensureReadableTextColor(levelType.color).toString(16).padStart(6, "0");

    row.appendChild(levelEl);
    row.appendChild(typeEl);
    upcomingBodyEl.appendChild(row);
  }
}

upcomingToggleBtn.addEventListener("click", () => {
  if (upcomingPanel.classList.contains("hidden")) {
    renderUpcomingPanel();
    upcomingPanel.classList.remove("hidden");
  } else {
    upcomingPanel.classList.add("hidden");
  }
});


const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener("click", (event) => {
  if (phase !== "placement") return;

  const cost = UNIT_STATS[selectedType].cost;
  if (cost > population) return;

  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  // Raycasts against the actual tile meshes (at their true elevated
  // height), not a flat plane — a click on a raised plateau needs to
  // resolve to that plateau's (x,z), not wherever a flat-Y=0 ray would
  // have landed instead.
  const hits = raycaster.intersectObjects(clickableTileMeshes);
  if (hits.length === 0) return;
  const hit = hits[0];
  if (hit.point.x >= BORDER_X) return;
  // Walkability alone now covers forest/sheer/city exclusion — city tiles
  // are non-walkable in the tile grid, so no separate insideCity check is
  // needed (a small correctness improvement: previously the city wasn't
  // actually a pathfinding obstacle, just a placement-exclusion zone).
  if (!isWorldWalkable(TILE_GRID, hit.point.x, hit.point.z)) return;
  // A tall sheer (cliff-face) box sits directly adjacent to the elevated
  // plateau tile above it, and with the fixed isometric camera angle, a
  // ray aimed at what's VISUALLY the cliff face can end up striking the
  // corner of that neighboring elevated tile first — it's marginally
  // closer to the camera in actual 3D space even though the cliff wall
  // is what's front-and-center on screen. Confirmed directly: clicking
  // the true screen-projected center of a sheer tile resolved to an
  // adjacent walkable tile as the closest hit, with the sheer tile
  // itself as the very next-closest, only ~0.6 world units of ray
  // distance further away.
  //
  // Trusting hits[0] alone isn't safe near a cliff edge, but a naive
  // "any hit within one tile-width of ray distance" check is too broad —
  // an oblique ray from this fixed isometric angle travels a long way
  // through the map, and can rack up dozens of hits against completely
  // unrelated tiles (a forest on the far side of the level, say) within
  // a couple units of ray distance purely by coincidence of the ray's
  // geometry, nowhere near where the player actually clicked. (This is
  // exactly what broke on the first attempt at this fix — it started
  // rejecting ordinary, nowhere-near-a-cliff placements too.) So a
  // second, independent condition is required: the candidate must also
  // be spatially close to the primary hit in actual (x,z) world
  // position, not just close along the ray — genuinely the same click
  // location, not a different point the ray happens to also pass near.
  const AMBIGUOUS_RAY_MARGIN = 1.0; // world units of ray distance — comfortably above the observed ~0.6 real gap
  const AMBIGUOUS_XZ_RADIUS = TILE_SIZE * 1.2; // must also be spatially near the clicked point, not just close along the ray
  for (const other of hits) {
    if (other.distance > hit.distance + AMBIGUOUS_RAY_MARGIN) break;
    const dx = other.point.x - hit.point.x;
    const dz = other.point.z - hit.point.z;
    if (Math.hypot(dx, dz) > AMBIGUOUS_XZ_RADIUS) continue;
    if (!isWorldWalkable(TILE_GRID, other.point.x, other.point.z)) return;
  }

  const unit = new Unit(selectedType, new THREE.Vector3(hit.point.x, 0, hit.point.z), scene, effectiveStats[selectedType]);
  snapToTerrain(unit);
  unit.homePosition = { x: hit.point.x, z: hit.point.z };
  defenders.push(unit);

  population -= cost;
  populationValue.textContent = population;
  refreshAffordability();
  refreshShopVisibility();
  refreshBackpackIfOpen();

  startBtn.disabled = defenders.length === 0;
  if (population === 0) {
    instructions.textContent = "Out of population. Start the battle when ready.";
  }
});

startBtn.addEventListener("click", () => {
  if (defenders.length === 0) return;
  track(EVENTS.LEVEL_STARTED, {
    level: CURRENT_LEVEL,
    level_type: CURRENT_LEVEL_TYPE,
    level_spec: CURRENT_LEVEL_SPEC,
    // What the player actually built, which is the interesting half of
    // any "why does everyone lose level 7" question.
    defenders_placed: defenders.length,
    population_remaining: population,
    raider_count: effectiveRaiderCount,
  });
  phase = "battle";
  instructions.textContent = "Battle in progress — sit back and watch.";
  startBtn.style.display = "none";
  refreshShopVisibility();
  refreshBackpackIfOpen();
});

// ---------- Battle simulation ----------
// Everything from here through the end of updateBattle() is the
// hard-won combat/pathfinding/targeting system, preserved exactly as it
// was — the entire point of this rewrite was to change how the game
// LOOKS, not how it PLAYS. The only edits in this whole section are
// swapping terrain-specific calls (elevation lookups, cliff-blocking) for
// their tile-based equivalents; every algorithm, every constant, every
// piece of reasoning in the comments is unchanged.
function findNearestEnemy(unit, enemyList) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const enemy of enemyList) {
    if (!enemy.alive) continue;
    const d = unit.distanceTo(enemy);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = enemy;
    }
  }
  return nearest;
}

function flatDist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// True if `unit` could actually attack `enemy` right now — in range, not
// separated by an elevation difference (melee only), and not a melee
// attacker facing a flying target (melee can never reach flying at all,
// regardless of range — see computeCanEngage in meleeSlots.js, the
// authoritative version of this same rule; this is the "am I even worth
// switching to" pre-check stationary defenders use to prefer an
// attackable enemy over a locked-but-unreachable one). Used to let
// stationary defenders prefer an attackable enemy over a locked-but-
// unreachable one.
function isEngageableBy(unit, enemy) {
  if (!unit.stats.ranged && enemy.stats.flying) return false;
  if (unit.distanceTo(enemy) > unit.stats.range) return false;
  if (!unit.stats.ranged && isMeleeBlockedByElevation(TILE_GRID, unit.mesh.position, enemy.mesh.position)) return false;
  return true;
}

// Among enemies `unit` can ACTUALLY engage right now, picks the nearest —
// not just the first one found in array order. A stationary defender's
// engagement range/leash is small enough that this rarely matters in
// practice, but when two engageable enemies ARE both in range (e.g. a
// defender's leash brought it within reach of more than one), attacking
// whichever happens to be first in `enemyList` instead of whichever is
// genuinely closest was an easy, low-cost thing to get right.
function findNearestEngageableEnemy(unit, enemyList) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const enemy of enemyList) {
    if (!enemy.alive || !isEngageableBy(unit, enemy)) continue;
    const d = unit.distanceTo(enemy);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = enemy;
    }
  }
  return nearest;
}

function pathLength(path) {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += flatDist(path[i], path[i + 1]);
  return total;
}

// A mobile unit's enemyList is always the DEFENDERS (see updateBattle:
// `enemyList = unit.team === "defender" ? intruders : defenders` — a
// raider's enemyList is defenders), which is naturally small — bounded by
// the population economy, not by however many raiders are in the wave.
// So "how many candidates get a real A* search" only ever needs to scale
// with defender count, never with raider count.
//
// PATH_COST_FULL_SEARCH_LIMIT: below this many living defenders, evaluate
// EVERY one of them by real path cost — no straight-line pre-filtering at
// all. This is what actually fixes raiders (including Boss/Champions)
// locking onto a defender that reads as closest by straight-line distance
// but requires a long detour around a cliff or forest, while ignoring a
// defender that's farther in a straight line but genuinely cheaper to
// actually reach — a real, reported bug: capping the search to the
// nearest-3-by-raw-distance can (and does) exclude the true cheapest
// option whenever terrain makes straight-line a bad proxy and there are
// more than 3 defenders on the field, which is an entirely ordinary
// player setup (population comfortably supports 4-6+ placed defenders).
// 8 was picked as comfortably above what population upgrades realistically
// support in one level, so this covers the overwhelming majority of real
// battles with an exact answer, not an approximation.
//
// PATH_COST_CANDIDATE_LIMIT: only kicks in as a fallback once defender
// count exceeds that threshold — preserves the original performance
// safeguard (a real measured ~300ms stutter at battle start scaled with
// unit-count x defender-count) for the rare case of a very large defender
// count, without degrading accuracy for the common case.
const PATH_COST_FULL_SEARCH_LIMIT = 8;
const PATH_COST_CANDIDATE_LIMIT = 3;

function pickTargetByPathCost(unit, enemyList, avoidTarget) {
  let alive = enemyList.filter((e) => e.alive);
  if (avoidTarget) {
    const withoutAvoided = alive.filter((e) => e !== avoidTarget);
    if (withoutAvoided.length > 0) alive = withoutAvoided;
  }
  if (alive.length === 0) return { enemy: null, path: null };
  alive.sort((a, b) => unit.distanceTo(a) - unit.distanceTo(b));

  // Flying units ignore terrain entirely and move in a straight line
  // (see followPathToward's direct-line fallback) — there's no path to
  // cost out, so "closest by straight-line distance" is the whole
  // targeting decision. Skips computePathTo entirely rather than calling
  // it and discarding the result, since a flying unit crossing a cliff
  // could easily have no valid A* path at all even though it can
  // obviously still reach the target directly.
  if (unit.stats.flying) {
    return { enemy: alive[0], path: null };
  }

  const candidates = alive.length <= PATH_COST_FULL_SEARCH_LIMIT ? alive : alive.slice(0, PATH_COST_CANDIDATE_LIMIT);

  let best = null;
  let bestPath = null;
  let bestCost = Infinity;
  for (const enemy of candidates) {
    const path = computePathTo(unit, enemy);
    if (!path) continue;
    const cost = pathLength(path);
    if (cost < bestCost) {
      bestCost = cost;
      best = enemy;
      bestPath = path;
    }
  }
  return { enemy: best, path: bestPath };
}

function normalizeDir(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, y: dz / len };
}

const WAYPOINT_ARRIVAL_DIST = 0.5;
const REPATH_DRIFT_THRESHOLD = 1.5;

function followPathToward(unit, enemy, delta, destPoint) {
  const dest = destPoint || enemy.mesh.position;

  // Flying units never pathfind — straight line toward the destination
  // every frame, terrain (including cliffs) entirely ignored. This reuses
  // the exact same direct-line movement the "no path found" case below
  // already does for ground units; flying units just always take this
  // branch instead of only falling into it as a fallback.
  if (unit.stats.flying) {
    const dir = normalizeDir(unit.mesh.position, dest);
    unit.stepInDirection(dir, delta);
    snapToTerrain(unit);
    return;
  }

  const drifted = unit.pathDestPos && flatDist(unit.pathDestPos, dest) > REPATH_DRIFT_THRESHOLD;
  if (!unit.path || unit.pathTarget !== enemy || drifted) {
    unit.path = computePathToPoint(unit, dest);
    unit.pathIndex = 0;
    unit.pathTarget = enemy;
    unit.pathDestPos = { x: dest.x, z: dest.z };
  }

  if (!unit.path || unit.path.length === 0) {
    const dir = normalizeDir(unit.mesh.position, dest);
    unit.stepInDirection(dir, delta);
    snapToTerrain(unit);
    return;
  }

  let waypoint = unit.path[unit.pathIndex];
  while (flatDist(unit.mesh.position, waypoint) < WAYPOINT_ARRIVAL_DIST && unit.pathIndex < unit.path.length - 1) {
    unit.pathIndex++;
    waypoint = unit.path[unit.pathIndex];
  }

  const dir = normalizeDir(unit.mesh.position, waypoint);
  unit.stepInDirection(dir, delta);
  snapToTerrain(unit);
}

// ---------- Defender guard mobility ----------
const DEFENDER_LEASH_RADIUS = 4.5;
const DEFENDER_MOVE_SPEED = 2.0;
const DEFENDER_RETURN_THRESHOLD = 0.2;

function advanceDefenderWithinLeash(unit, enemy, delta) {
  if (!unit.homePosition) return;

  const distHomeToEnemy = flatDist(unit.homePosition, enemy.mesh.position);
  const canReach = distHomeToEnemy <= DEFENDER_LEASH_RADIUS + unit.stats.range;

  if (canReach) {
    const dir = normalizeDir(unit.mesh.position, enemy.mesh.position);
    const nextX = unit.mesh.position.x + dir.x * DEFENDER_MOVE_SPEED * delta;
    const nextZ = unit.mesh.position.z + dir.y * DEFENDER_MOVE_SPEED * delta;
    if (flatDist(unit.homePosition, { x: nextX, z: nextZ }) <= DEFENDER_LEASH_RADIUS) {
      unit.mesh.position.x = nextX;
      unit.mesh.position.z = nextZ;
      unit.facingAngle = Math.atan2(dir.x, dir.y);
      snapToTerrain(unit);
    }
    return;
  }

  const distFromHome = flatDist(unit.mesh.position, unit.homePosition);
  if (distFromHome > DEFENDER_RETURN_THRESHOLD) {
    const dir = normalizeDir(unit.mesh.position, unit.homePosition);
    unit.mesh.position.x += dir.x * DEFENDER_MOVE_SPEED * delta;
    unit.mesh.position.z += dir.y * DEFENDER_MOVE_SPEED * delta;
    unit.facingAngle = Math.atan2(dir.x, dir.y);
    snapToTerrain(unit);
  }
}

// ---------- Melee attack slots ----------
const MELEE_RING_MAX_RADIUS = UNIT_STATS.raider.range - 0.1;

function getOrCreateSlotRing(target) {
  if (!target.slotRing) {
    // Ring is cached per-target and computed once — every raider
    // attacking a defender within a single level is the same wave type
    // (a level has exactly one wave type), so meleeAttackerRadiusEstimate
    // is already correct for the whole battle by the time this first
    // runs; no per-attacker variation to account for.
    //
    // gap tightened from the default 0.1 to 0.02 — a small, explicit
    // tuning knob to let slightly more attackers fit around the same
    // ring simultaneously, per request. Doesn't change how much physical
    // space each attacker's OWN body needs (still based on its real
    // collision radius via meleeAttackerRadiusEstimate), just how much
    // breathing room is left between adjacent attackers' slots.
    target.slotRing = computeSlotRing(target.collisionRadius, meleeAttackerRadiusEstimate, {
      maxRadius: MELEE_RING_MAX_RADIUS,
      gap: 0.02,
    });
    target.slotOccupants = new Array(target.slotRing.count).fill(null);
    target.blacklistedSlots = new Set();
  }
  return target.slotRing;
}

function releaseMeleeSlot(unit) {
  const target = unit.meleeSlotTarget;
  if (target && target.slotOccupants && target.slotOccupants[unit.meleeSlotIndex] === unit) {
    target.slotOccupants[unit.meleeSlotIndex] = null;
  }
  unit.meleeSlotTarget = null;
  unit.meleeSlotIndex = null;
}

function reserveMeleeSlot(unit, target) {
  if (unit.meleeSlotTarget === target && target.slotOccupants && target.slotOccupants[unit.meleeSlotIndex] === unit) {
    return unit.meleeSlotIndex;
  }
  releaseMeleeSlot(unit);
  getOrCreateSlotRing(target);
  const occupiedBool = target.slotOccupants.map((o, i) => (o !== null && o.alive) || target.blacklistedSlots.has(i));
  const index = pickBestFreeSlot(occupiedBool);
  if (index === -1) return null;
  target.slotOccupants[index] = unit;
  unit.meleeSlotTarget = target;
  unit.meleeSlotIndex = index;
  return index;
}

function getMeleeSlotPosition(unit) {
  const target = unit.meleeSlotTarget;
  return slotWorldPosition(target.mesh.position, target.slotRing.ringRadius, unit.meleeSlotIndex, target.slotRing.count);
}

// ---------- Stuck-detection watchdog ----------
const STUCK_CHECK_INTERVAL = 1.0;
const STUCK_MIN_PROGRESS = 0.3;
const STUCK_TIMEOUT = 2.0;

const ARRIVAL_RESERVE_DISTANCE = 2.0;
const AVOID_REJECTED_TARGET_TIME = 3.0;

function updateStuckWatchdog(unit, isProgressing, delta) {
  unit.stuckCheckElapsed += delta;
  if (unit.stuckCheckElapsed < STUCK_CHECK_INTERVAL) return false;

  const posNow = { x: unit.mesh.position.x, z: unit.mesh.position.z };
  const moved = unit.stuckCheckPos ? flatDist(unit.stuckCheckPos, posNow) : Infinity;
  const madeProgress = isProgressing || moved > STUCK_MIN_PROGRESS;
  const intervalElapsed = unit.stuckCheckElapsed;

  unit.stuckCheckPos = posNow;
  unit.stuckCheckElapsed = 0;

  if (madeProgress) {
    unit.stuckTimer = 0;
    return false;
  }

  unit.stuckTimer += intervalElapsed;
  if (unit.stuckTimer < STUCK_TIMEOUT) return false;

  if (unit.meleeSlotTarget && unit.meleeSlotIndex !== null) {
    getOrCreateSlotRing(unit.meleeSlotTarget);
    unit.meleeSlotTarget.blacklistedSlots.add(unit.meleeSlotIndex);
  }
  releaseMeleeSlot(unit);
  unit.target = null;
  unit.path = null;
  unit.pathIndex = 0;
  unit.pathTarget = null;
  unit.stuckTimer = 0;
  return true;
}

function updateBattle(delta) {
  const allUnits = [...defenders, ...intruders];

  for (const unit of allUnits) {
    if (!unit.alive) continue;
    if (unit.freezeTimer > 0) unit.freezeTimer = Math.max(0, unit.freezeTimer - delta);
    const enemyList = unit.team === "defender" ? intruders : defenders;

    if (!unit.target || !unit.target.alive) {
      releaseMeleeSlot(unit);
      // Rush spec: heads straight for the city from the very first target
      // acquisition, unconditionally — never picks a defender at all, no
      // matter how many are alive. This is checked BEFORE the normal
      // stationary/path-cost branches specifically so no A* search against
      // defenders is ever wasted on a unit that was never going to use the
      // result. Once set, CITY_TARGET.alive is permanently true, so this
      // branch never re-runs for this unit — and since CITY_TARGET counts
      // as an already-"committed" target, applyDamage's reactive-aggro
      // switch (see there) also never fires for it: a Rush raider that
      // takes a hit from a defender in its path still doesn't stop or
      // turn to fight back, exactly per spec ("ignore the defenders and
      // run to the city").
      if (unit.team === "intruder" && unit.stats.rushToCity) {
        unit.target = CITY_TARGET;
      } else if (unit.stats.stationary) {
        unit.target = findNearestEnemy(unit, enemyList);
      } else {
        const avoid = unit.avoidTimer > 0 ? unit.avoidTarget : null;
        const picked = pickTargetByPathCost(unit, enemyList, avoid);
        unit.target = picked.enemy;
        unit.path = picked.path;
        unit.pathIndex = 0;
        unit.pathTarget = picked.enemy;
        unit.pathDestPos = picked.enemy ? { x: picked.enemy.mesh.position.x, z: picked.enemy.mesh.position.z } : null;
      }
      // Intruders with nothing left to fight march on the city instead of
      // standing idle — but ONLY once every defender is confirmed dead.
      // This can never fire while even one defender survives: enemyList
      // here IS `defenders` for an intruder (see its definition above),
      // and findNearestEnemy/pickTargetByPathCost would already have
      // found a living one if any existed, so unit.target would already
      // be set and this whole block wouldn't have run.
      if (!unit.target && unit.team === "intruder" && !defenders.some((d) => d.alive)) {
        unit.target = CITY_TARGET;
      }
      if (!unit.target) {
        unit.path = null;
        unit.pathTarget = null;
        unit.pathDestPos = null;
      }
    }
    if (unit.avoidTimer > 0) unit.avoidTimer -= delta;

    let enemy = unit.target;
    if (!enemy) continue;

    // Marching on the city is a small, self-contained branch, deliberately
    // separate from (and never falling through into) the melee-slot/
    // engagement/attack logic below, which stays exactly as it was for
    // actual combat — raiders don't "attack" the city, they just vanish on
    // arrival (see applyCityArrival), so none of that logic applies here
    // at all. Movement reuses followPathToward exactly as-is (the same
    // A*-then-direct-line logic already proven for chasing a defender) —
    // CITY_TARGET is just a stable stand-in object shaped enough like a
    // real target (.mesh.position, .alive) for that function to need zero
    // changes to handle it.
    if (enemy === CITY_TARGET) {
      unit.faceToward(enemy);
      if (unit.distanceTo(enemy) <= CITY_ARRIVAL_DISTANCE) {
        applyCityArrival(unit);
      } else {
        followPathToward(unit, enemy, delta, enemy.mesh.position);
      }
      continue;
    }

    if (unit.stats.stationary && !isEngageableBy(unit, enemy)) {
      const reachable = findNearestEngageableEnemy(unit, enemyList);
      if (reachable) {
        unit.target = reachable;
        enemy = reachable;
      }
    }

    unit.faceToward(enemy);

    const dist = unit.distanceTo(enemy);
    const elevationBlocked = !unit.stats.ranged && isMeleeBlockedByElevation(TILE_GRID, unit.mesh.position, enemy.mesh.position);

    let slotIndex = unit.meleeSlotTarget === enemy ? unit.meleeSlotIndex : null;
    if (!unit.stats.ranged && !unit.stats.stationary && slotIndex === null && dist <= ARRIVAL_RESERVE_DISTANCE) {
      slotIndex = reserveMeleeSlot(unit, enemy);
      if (slotIndex === null) {
        unit.avoidTarget = enemy;
        unit.avoidTimer = AVOID_REJECTED_TARGET_TIME;
        unit.target = null;
        unit.path = null;
        unit.pathTarget = null;
        unit.pathDestPos = null;
        continue;
      }
    }

    const withinRange = dist <= unit.stats.range;
    const canEngage = computeCanEngage({
      ranged: unit.stats.ranged,
      stationary: unit.stats.stationary,
      withinRange,
      cliffBlocked: elevationBlocked,
      hasSlot: slotIndex !== null,
      targetIsFlying: !!enemy.stats.flying,
    });

    if (!unit.stats.ranged && !unit.stats.stationary) {
      if (updateStuckWatchdog(unit, canEngage, delta)) continue;
    }

    if (!canEngage) {
      if (!unit.stats.stationary) {
        const destPoint = !unit.stats.ranged && slotIndex !== null ? getMeleeSlotPosition(unit) : enemy.mesh.position;
        followPathToward(unit, enemy, delta, destPoint);
      } else {
        advanceDefenderWithinLeash(unit, enemy, delta);
      }
      continue;
    }

    if (unit.attackCooldown > 0) {
      unit.attackCooldown -= delta;
      continue;
    }
    // Freeze slows attack speed too, not just movement — derived fresh
    // here exactly like unit.js's stepInDirection derives its own move-
    // speed multiplier, since there's no separately-tracked cooldown field
    // to have gotten out of sync (see attackSpeed's doc comment in unit.js).
    const atkSpeedMult = unit.freezeTimer > 0 ? 1 - unit.freezeSlowAmount : 1;
    unit.attackCooldown = 1 / (unit.stats.attackSpeed * atkSpeedMult);

    const damage = unit.attackDamageAgainst(enemy);

    if (unit.stats.ranged) {
      const from = unit.mesh.position.clone();
      from.y += 0.6;
      const to = enemy.mesh.position.clone();
      to.y += 0.6;
      // Splash-capable attackers (currently only the Mage) get a
      // splash-and-freeze impact callback instead of the plain single-
      // target applyDamage — see applySplashImpact above.
      const onImpact = unit.stats.splashRadius
        ? (attacker, targetUnit, dmg) => applySplashImpact(attacker, targetUnit, dmg, to, unit.stats)
        : applyDamage;
      projectiles.push(new Projectile(scene, from, to, damage, unit, enemy, onImpact, unit.stats.projectile));
    } else {
      applyDamage(unit, enemy, damage);
    }
  }

  const defendersAlive = defenders.some((u) => u.alive);
  const intrudersAlive = intruders.some((u) => u.alive);

  if (!intrudersAlive) {
    // At least one surviving defender guarantees zero city damage this
    // level — the city-targeting branch above can only ever fire once
    // EVERY defender is confirmed dead, so "a defender is still alive"
    // and "the city took damage" are mutually exclusive by construction.
    if (defendersAlive) {
      endBattle("victory");
    } else if (isCityDestroyed(PROGRESS)) {
      endBattle("gameOver");
    } else {
      endBattle("cityDamaged");
    }
  }
}

function endBattle(outcome) {
  // outcome: "victory" | "cityDamaged" | "gameOver"
  phase = "result";
  resultBanner.classList.remove("hidden");
  resultEvolutionLine.classList.add("hidden");
  resultSummaryLine.classList.add("hidden");
  // Only a finished RUN gets submitted, so this stays hidden for every
  // outcome except gameOver, which re-reveals it via
  // prepareScoreSubmission() below.
  scoreSubmitEl.classList.add("hidden");
  refreshShopVisibility();
  refreshBackpackIfOpen();

  if (outcome === "victory" || outcome === "cityDamaged") {
    // Both conclude the level and advance to the next one — a
    // "cityDamaged" outcome still means the level is OVER (every
    // defender was lost and at least one raider reached the city), but
    // the run continues as long as city health holds above the
    // game-over threshold (see the isCityDestroyed check just above,
    // which routes here as "gameOver" instead once it doesn't). Score
    // naturally comes out lower for this outcome without any special
    // casing — it's the sum of surviving defenders' HP, and there are
    // none, so it's however much score was already banked from EARLIER
    // levels plus zero this time.
    //
    // Order matters: interest is earned on whatever was sitting unused in
    // the bank BEFORE this level's flat clear-reward is added, so the
    // reward itself never earns interest the same level it's granted.
    const interestEarned = applyGoldInterest(PROGRESS);
    // Reward grows +1g per level cleared (CURRENT_LEVEL, the level just
    // played — level 1 clear = 10g, level 2 clear = 11g, ...), separate
    // from and computed before PROGRESS.level gets incremented below.
    // Midas' Hoard (see items.js's goldGainPercent) multiplies this same
    // number, so the displayed "+X Gold" reward line below always matches
    // exactly what actually gets credited.
    const goldReward = computeGoldReward(CURRENT_LEVEL) * (1 + globalItemBonuses.goldGainPercent);
    PROGRESS.gold += goldReward;
    PROGRESS.level += 1;

    // Score: sum of every surviving defender's REMAINING hp (however much
    // they had left, not their max), added to the running cumulative
    // total. Dead defenders contribute 0 (health clamps at 0 in
    // Unit.takeDamage, never goes negative) — no separate "alive" check
    // needed, but included for clarity anyway.
    const remainingDefenderHp = defenders.reduce((sum, u) => sum + (u.alive ? u.health : 0), 0);
    addScore(PROGRESS, remainingDefenderHp);

    // Raiders evolve once per CLEARED level (never on a loss) — pick one
    // random stat, apply it, and recompute the live effective raider
    // count/stats immediately so the stats panel reflects what the NEXT
    // level's raiders will actually be if it's opened before continuing.
    // PROGRESS.level was already incremented above, so getLevelType/
    // getLevelSpec here resolve the level about to be played, not the one
    // just cleared.
    const evolvedStat = evolveRaiders(PROGRESS.raiderEvolution);
    const nextLevelType = getLevelType(PROGRESS, PROGRESS.level);
    const nextLevelSpec = getLevelSpec(PROGRESS, PROGRESS.level);
    effectiveRaiderWave = getWaveStats(nextLevelType, nextLevelSpec, PROGRESS.raiderEvolution);
    effectiveRaiderCount = effectiveRaiderWave.count;
    effectiveRaiderStats = effectiveRaiderWave.stats;
    displayedLevelType = nextLevelType;
    displayedLevelSpec = nextLevelSpec;
    totalWaveHealth = effectiveRaiderCount * effectiveRaiderStats.maxHealth;
    meleeAttackerRadiusEstimate = computeCollisionRadius(effectiveRaiderStats);

    // Levels are predetermined well ahead of time — make sure the
    // schedule still covers the requested lookahead now that the level
    // number has advanced (this mostly just tops up one new entry per
    // win; the schedule is append-only, so anything already committed is
    // untouched).
    ensureLevelSchedule(PROGRESS, PROGRESS.level + LEVEL_TYPE_LOOKAHEAD);

    // Saved immediately — clearing the level, earning interest, scoring,
    // and raiders evolving are all facts as soon as they happen, not
    // something contingent on the player clicking the button below (a
    // page refresh right now should still land them on the next level
    // with everything intact). City health was already saved as it
    // happened, live, in applyCityArrival — nothing extra to persist for
    // it here.
    saveProgress(PROGRESS);

    scoreValue.textContent = Math.floor(PROGRESS.score);

    if (outcome === "victory") {
      resultText.textContent = "City Defended";
    } else {
      resultText.textContent = "Your Defenders Have Fallen\u2026";
    }

    shopRewardLine.textContent = `Level cleared! +${Math.floor(goldReward)} Gold`;
    const flooredInterest = Math.floor(interestEarned);
    shopInterestLine.classList.toggle("hidden", flooredInterest <= 0);
    if (flooredInterest > 0) {
      shopInterestLine.textContent = `Interest: +${flooredInterest} (${Math.round(GOLD_INTEREST_RATE * 100)}%)`;
    }

    resultEvolutionLine.classList.remove("hidden");
    resultEvolutionLine.textContent = `Raiders gained 20% ${RAIDER_EVOLUTION_LABELS[evolvedStat]}!`;

    // This is specifically the raider-evolution recompute above — only the
    // Attacker panel can be showing stale numbers here.
    if (!attackerStatsPanel.classList.contains("hidden")) renderAttackerStatsPanel();

    track(EVENTS.LEVEL_COMPLETED, {
      level: CURRENT_LEVEL,
      level_type: CURRENT_LEVEL_TYPE,
      level_spec: CURRENT_LEVEL_SPEC,
      // "victory" and "cityDamaged" both clear the level and advance the
      // run — the difference is whether any defender survived, which is
      // exactly the distinction worth being able to segment on later.
      outcome,
      score: Math.floor(PROGRESS.score),
      gold_reward: Math.floor(goldReward),
      city_health: Math.round(PROGRESS.cityHealth * 10) / 10,
      surviving_defenders: defenders.filter((u) => u.alive).length,
    });

    resultPrimaryBtn.textContent = `Start Level ${PROGRESS.level} →`;
    resultPrimaryBtn.dataset.action = "continue";
    openShop("win");
  } else {
    // gameOver: the whole run has ended — city health hit (or dropped
    // below) the game-over threshold. Deliberately NO gold/interest/
    // evolution/level-advance here: the entire point of a persistent,
    // never-auto-healing city health is that depleting it is a real,
    // terminal consequence, not something to shrug off by immediately
    // starting a fresh level with everything already accumulated still
    // intact. "Play Again" fully resets the save — functionally the same
    // action as the topbar's "Reset Game" button, just without needing a
    // confirmation modal first, since the run has already, unambiguously
    // ended; there's no "accidentally throwing away progress" risk here.
    shopInterestLine.classList.add("hidden");
    resultText.textContent = "The City Has Fallen";
    resultSummaryLine.classList.remove("hidden");
    resultSummaryLine.textContent = `Final Score: ${Math.floor(PROGRESS.score)} \u00b7 Reached Level ${PROGRESS.level}`;
    resultPrimaryBtn.textContent = "Play Again";
    resultPrimaryBtn.dataset.action = "reset";

    // The one point in the whole game where a final Score exists. Note
    // that "Play Again" below wipes the save, so the submit block sits
    // ABOVE that button in the banner — a player shouldn't be able to
    // discard their run without having seen the option to record it.
    prepareScoreSubmission();

    track(EVENTS.RUN_ENDED, {
      final_score: Math.floor(PROGRESS.score),
      level_reached: PROGRESS.level,
    });
  }
}

// Deliberately separate from the shop panel's own Close button — this is
// the ONLY control that actually advances/retries/restarts (a reload; see
// the "reload for level transitions" note earlier). The shop is purely
// optional and browsable alongside it; closing or never opening it has no
// effect on this button. `dataset.action` (set by endBattle) is what
// distinguishes "just move on to the next level" from "the run is over,
// wipe everything and start clean" — same button, same reload, different
// prep beforehand.
resultPrimaryBtn.addEventListener("click", () => {
  if (resultPrimaryBtn.dataset.action === "reset") {
    resetProgress();
  }
  window.location.reload();
});

// A* pathfinding controls ROUTING, but nothing about it physically stops a
// unit from ending up somewhere illegal if a DIFFERENT system moves it —
// specifically, unit-unit separation (below) nudges positions every frame
// with zero terrain awareness. This function is the actual physical
// guarantee: called every frame for every mobile unit, it pushes the unit
// back out if its position has drifted into a non-walkable tile,
// regardless of why. Tile-based version is simpler than the old
// continuous one — every non-walkable tile (sheer face, forest, city) is
// just an axis-aligned square now, so one unified circle-vs-square
// resolution handles all three cases instead of separate segment/circle
// math per feature type.
function resolveTerrainCollisions(unit) {
  const pos = unit.mesh.position;
  const pad = 0.05;
  const { tx: utx, tz: utz } = worldToTile(TILE_GRID, pos.x, pos.z);
  const checkRadius = 2;
  for (let dz = -checkRadius; dz <= checkRadius; dz++) {
    for (let dx = -checkRadius; dx <= checkRadius; dx++) {
      const tx = utx + dx;
      const tz = utz + dz;
      if (isTileWalkable(TILE_GRID, tx, tz)) continue;
      const center = tileToWorldCenter(TILE_GRID, tx, tz);
      const half = TILE_SIZE / 2;
      const minX = center.x - half;
      const maxX = center.x + half;
      const minZ = center.z - half;
      const maxZ = center.z + half;
      const closestX = Math.max(minX, Math.min(pos.x, maxX));
      const closestZ = Math.max(minZ, Math.min(pos.z, maxZ));
      const ddx = pos.x - closestX;
      const ddz = pos.z - closestZ;
      const distC = Math.hypot(ddx, ddz);
      const clearance = unit.collisionRadius + pad;
      if (distC < clearance) {
        if (distC > 0.0001) {
          const scale = clearance / distC;
          pos.x = closestX + ddx * scale;
          pos.z = closestZ + ddz * scale;
        } else {
          const penLeft = pos.x - minX;
          const penRight = maxX - pos.x;
          const penTop = pos.z - minZ;
          const penBottom = maxZ - pos.z;
          const minPen = Math.min(penLeft, penRight, penTop, penBottom);
          if (minPen === penLeft) pos.x = minX - clearance;
          else if (minPen === penRight) pos.x = maxX + clearance;
          else if (minPen === penTop) pos.z = minZ - clearance;
          else pos.z = maxZ + clearance;
        }
      }
    }
  }
}

function enforceTerrainCollisions() {
  // NOTE: this used to skip any unit.stats.stationary === true (i.e. both
  // defender types), on the assumption that "stationary" meant "never
  // moves, so collision resolution is pointless." That assumption broke
  // when guard mobility (advanceDefenderWithinLeash, below) was added —
  // defenders CAN move now, chasing a target up to DEFENDER_LEASH_RADIUS
  // from their home position, and that movement does its own leash-radius
  // check but ZERO terrain-walkability check. The result: a defender
  // could walk straight onto a sheer cliff face (or any other blocked
  // tile) while chasing a raider, since nothing here was ever correcting
  // its position afterward. Raiders never had this problem because they
  // move via real A* pathfinding, which only ever routes across walkable
  // tiles in the first place — this collision pass is the ONLY thing
  // standing between a defender and walking through a wall, so it must
  // run for defenders too. A defender that's never left its placed (and
  // already validated-walkable) home position is comfortably clear of
  // any blocked tile, so this remains a safe no-op for the common case
  // where a defender never chases anything.
  for (const unit of [...defenders, ...intruders]) {
    if (!unit.alive) continue;
    // Flying units are explicitly meant to sit over sheer cliffs, forests,
    // whatever — "transcends cliffs" per spec. Pushing them out of
    // blocked tiles would directly undo that, so they're exempt from
    // this pass entirely (their Y position is separately pinned to a
    // fixed altitude by snapToTerrain, not derived from ground height).
    if (unit.stats.flying) continue;
    resolveTerrainCollisions(unit);
    snapToTerrain(unit);
  }
}

// ---------- Unit-unit separation (no stacking) ----------
const SEPARATION_SPEED = 5;

function updateSeparation(delta) {
  const allUnits = [...defenders, ...intruders].filter((u) => u.alive);
  for (const unit of allUnits) {
    if (unit.stats.stationary) continue;
    let pushX = 0;
    let pushZ = 0;
    for (const other of allUnits) {
      if (other === unit) continue;
      // Flying units occupy a different altitude entirely — they
      // shouldn't physically jostle ground units they happen to be
      // passing directly over (or vice versa). Separation still applies
      // normally between two units at the SAME altitude category
      // (ground-vs-ground, flying-vs-flying), so a cluster of flying
      // raiders still doesn't stack on the exact same point mid-air.
      if (!!unit.stats.flying !== !!other.stats.flying) continue;
      // Never push a unit away from its OWN currently-held melee-slot
      // target. Standing at melee range inherently means standing close
      // enough that two units' physical footprints can overlap somewhat
      // — that's just what melee combat looks like — but the slot-ring
      // radius is capped at just under the attacker's actual attack
      // range (MELEE_RING_MAX_RADIUS, so a unit at its assigned slot can
      // always land a hit), and that cap can end up smaller than the
      // combined-radii "no overlap" distance for a large attacker
      // against a real target. Without this exemption, separation would
      // fight the slot assignment forever, continuously shoving the
      // attacker back out before it could ever settle within range — a
      // real, reported bug (worst for Boss, whose size makes the overlap
      // largest, but present in smaller degree for every raider size).
      // This only skips the pair between a unit and the ONE target it's
      // actually engaged with; separation between that unit and anyone
      // ELSE (including other raiders sharing the same target's ring)
      // still applies normally, so attackers still don't stack on each
      // other.
      if (other === unit.meleeSlotTarget) continue;
      const dx = unit.mesh.position.x - other.mesh.position.x;
      const dz = unit.mesh.position.z - other.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      const minDist = unit.collisionRadius + other.collisionRadius;
      if (dist < minDist) {
        if (dist > 0.0001) {
          const overlap = (minDist - dist) / minDist;
          pushX += (dx / dist) * overlap;
          pushZ += (dz / dist) * overlap;
        } else {
          const angle = Math.random() * Math.PI * 2;
          pushX += Math.cos(angle) * 0.5;
          pushZ += Math.sin(angle) * 0.5;
        }
      }
    }
    if (pushX !== 0 || pushZ !== 0) {
      unit.nudge(pushX * SEPARATION_SPEED * delta, pushZ * SEPARATION_SPEED * delta);
      snapToTerrain(unit);
    }
  }
}

// ---------- Per-frame updates that keep running regardless of phase ----------
function updateProjectiles(delta) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    projectiles[i].update(delta);
    if (projectiles[i].done) projectiles.splice(i, 1);
  }
}

function updateDyingUnits(delta) {
  for (let i = dyingUnits.length - 1; i >= 0; i--) {
    const d = dyingUnits[i];
    d.t += delta;
    const s = Math.max(0, 1 - d.t / 0.4);
    d.unit.mesh.scale.set(d.unit.baseScaleX * s, d.unit.baseScaleY * s, 1);
    if (d.t >= 0.4) {
      d.unit.destroy(scene);
      dyingUnits.splice(i, 1);
    }
  }
}

// ---------- Render loop ----------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);

  if (phase === "battle") {
    updateBattle(delta);
  }
  updateArmyHealthDisplay();
  updateSeparation(delta);
  enforceTerrainCollisions();
  updateProjectiles(delta);
  updateDyingUnits(delta);
  updateDamageNumbers(delta);

  // No more per-frame health-bar-facing step — sprites billboard toward
  // the camera automatically, unlike the old box meshes with manually-
  // oriented plane children.

  controls.update();
  renderer.render(scene, camera);
}

// ---------- Bootstrap ----------
const loadingScreen = document.getElementById("loading-screen");

async function bootstrap() {
  const loadingText = document.getElementById("loading-text");
  await preloadAssets((loaded, total) => {
    if (loadingText) loadingText.textContent = `Loading assets… ${Math.round((loaded / total) * 100)}%`;
  });

  clickableTileMeshes = buildGroundTiles();
  buildForestTrees();
  decorateGroundScatter();
  createCity();
  decorateCityBoundary();
  spawnIntruders();

  loadingScreen.classList.add("hidden");
  let introSeen = false;
  try {
    introSeen = localStorage.getItem(INTRO_SEEN_KEY) === "1";
  } catch {
    // Storage unavailable — default to showing it; see closeIntroModal.
  }
  if (!introSeen) openIntroModal();
  animate();
}

bootstrap().catch((err) => {
  console.error(err);
  const loadingText = document.getElementById("loading-text");
  if (loadingText) loadingText.textContent = "Failed to load assets. Try refreshing the page.";
});
