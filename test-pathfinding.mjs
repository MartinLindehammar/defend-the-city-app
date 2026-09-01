// Standalone sanity test for the CORE PATHFINDING/COLLISION ALGORITHM —
// run with: node test-pathfinding.mjs
//
// pathfinding.js itself is completely unchanged by the tile-terrain
// rewrite (it was always a generic grid consumer — see tileTerrain.js's
// header comment). What changed is the FIXTURE: obstacles are now simple
// axis-aligned tile squares (a plateau's sheer sides, forest tiles)
// instead of the old continuous segment-based cliff walls and circular
// forests. This fixture is built using the REAL production functions
// from tileTerrain.js (stampPlateau, stampForest), not hand-duplicated
// geometry, so it can never silently drift from what the game actually
// generates.
//
// INDEPENDENCE NOTE: verification below samples the line against the
// tile grid's raw square geometry directly (computing point-in-square
// tests from first principles), at a finer and differently-phased
// resolution than production's own grid sampling in pathfinding.js's
// smoothPath — a genuinely separate check, not the same code checking
// its own output. Historical context, still true here: an earlier
// version of this fixture had a real blind spot in an analytic
// segment-distance approximation; grid/tile geometry has no equivalent
// shortcut to get wrong, but independent verification remains the right
// discipline regardless.

import { buildNavGrid, findPath, smoothPath } from "./src/pathfinding.js";
import { TileType, TILE_SIZE, createTileGrid, stampPlateau, stampForest, isWorldWalkable, tileToWorldCenter } from "./src/tileTerrain.js";

// ---- illustrative fixture (not tied to any specific generated level) ----
// A 30x20 tile grid (60x40 world units) with one cliff-type plateau
// (sheer on the west side only — approach from the east is blocked,
// north/south/west of the sheer face requires a detour) and two forest
// clusters forming a chokepoint.
const COLS = 30;
const ROWS = 20;
const grid = createTileGrid(COLS, ROWS);

stampPlateau(grid, { txMin: 10, txMax: 18, tzMin: 4, tzMax: 14, level: 1, sheerSides: new Set(["west"]) });
stampForest(grid, { txMin: 20, txMax: 22, tzMin: 2, tzMax: 5 });
stampForest(grid, { txMin: 20, txMax: 22, tzMin: 13, tzMax: 16 });

function isPointBlocked(x, z) {
  return !isWorldWalkable(grid, x, z);
}

// ---- genuinely independent verification ----
// Directly tests whether a fine-grained sample of points along a line
// falls inside any non-walkable tile's actual square bounds — computed
// from raw tile coordinates, not via the SAME isWorldWalkable/grid.blocked
// path production's own pathfinding.js uses internally for grid cells
// (this queries the tile TYPE array directly and does its own square-vs-
// point math), and at a different sampling resolution.
function tileSquareBounds(tx, tz) {
  const c = tileToWorldCenter(grid, tx, tz);
  const half = TILE_SIZE / 2;
  return { minX: c.x - half, maxX: c.x + half, minZ: c.z - half, maxZ: c.z + half };
}
function isNonWalkableType(t) {
  return t === TileType.SHEER || t === TileType.FOREST || t === TileType.CITY;
}
function independentlyPointBlocked(x, z) {
  const tx = Math.floor(x / TILE_SIZE + grid.cols / 2);
  const tz = Math.floor(z / TILE_SIZE + grid.rows / 2);
  if (tx < 0 || tz < 0 || tx >= grid.cols || tz >= grid.rows) return true;
  const idx = tz * grid.cols + tx;
  return isNonWalkableType(grid.type[idx]);
}
function independentlyVerifyClear(a, b) {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(3, Math.ceil(dist / (TILE_SIZE * 0.13))); // fine, independently-chosen resolution
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (independentlyPointBlocked(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
  }
  return true;
}

const navGrid = buildNavGrid({
  mapWidth: COLS * TILE_SIZE,
  mapDepth: ROWS * TILE_SIZE,
  cellSize: TILE_SIZE,
  isBlocked: isPointBlocked,
});

let blockedCount = 0;
for (let i = 0; i < navGrid.blocked.length; i++) if (navGrid.blocked[i]) blockedCount++;
console.log(`Grid: ${navGrid.cols}x${navGrid.rows} cells, ${blockedCount} blocked (${((blockedCount / navGrid.blocked.length) * 100).toFixed(1)}%)`);
if (blockedCount === 0) throw new Error("FAIL: no cells blocked at all — obstacle predicate is broken");
if (blockedCount === navGrid.blocked.length) throw new Error("FAIL: entire grid blocked — nothing would be pathable");

function checkPathClearIndependently(path, label) {
  for (let i = 0; i < path.length - 1; i++) {
    if (!independentlyVerifyClear(path[i], path[i + 1])) {
      throw new Error(`FAIL [${label}]: smoothed path segment ${i}->${i + 1} is blocked according to INDEPENDENT verification!`);
    }
  }
}

function runCase(label, start, end, expectDetour) {
  const raw = findPath(navGrid, start, end);
  if (!raw) throw new Error(`FAIL [${label}]: no path found at all`);
  const smoothed = smoothPath(navGrid, raw);
  checkPathClearIndependently(smoothed, label);
  const straightLineBlocked = !independentlyVerifyClear(start, end);
  console.log(`[${label}] raw=${raw.length} waypoints, smoothed=${smoothed.length} waypoints, direct line blocked=${straightLineBlocked}`);
  if (expectDetour && smoothed.length < 3) {
    throw new Error(`FAIL [${label}]: expected a real detour (>=3 waypoints) but got a near-straight path (${smoothed.length})`);
  }
  return smoothed;
}

// Case 1: approach the plateau's sheer (west) face from due west — must
// detour around north or south to reach the top via a ramp side.
const worldW = COLS * TILE_SIZE;
const worldH = ROWS * TILE_SIZE;
const toWorldX = (tx) => (tx - COLS / 2) * TILE_SIZE;
const toWorldZ = (tz) => (tz - ROWS / 2) * TILE_SIZE;

const plateauPath = runCase(
  "west of sheer face -> plateau top",
  { x: toWorldX(6), z: toWorldZ(9) },
  { x: toWorldX(14), z: toWorldZ(9) },
  true
);
const wentNorth = plateauPath.some((p) => p.z <= toWorldZ(4) - 1);
const wentSouth = plateauPath.some((p) => p.z >= toWorldZ(14) + 1);
console.log(`  routed around north: ${wentNorth}, south: ${wentSouth}`);
if (!wentNorth && !wentSouth) throw new Error("FAIL: path to plateau top didn't route around either end of the sheer face");

// Case 2: approach the plateau from the EAST (a ramp side) — should be a
// short, direct climb, no detour needed.
runCase("east of plateau -> plateau top (ramp side)", { x: toWorldX(20), z: toWorldZ(9) }, { x: toWorldX(14), z: toWorldZ(9) }, false);

// Case 3: through the forest chokepoint gap between the two forest clusters.
runCase("through forest chokepoint", { x: toWorldX(25), z: toWorldZ(9) }, { x: toWorldX(18), z: toWorldZ(9) }, false);

// Case 4: forced around a forest cluster entirely (target tucked behind it).
const forestDetour = runCase("around forest cluster", { x: toWorldX(25), z: toWorldZ(3) }, { x: toWorldX(19), z: toWorldZ(3) }, true);
console.log(`  forest-detour waypoints: ${forestDetour.length}`);

console.log("\nAll pathfinding checks passed (verified independently of production's own logic).");

// ---- Stress test: many spawn points against several representative
// defender placements, exercising the plateau and both forests at once ----
const SPAWN_POINTS = [];
for (let i = 0; i < 20; i++) {
  SPAWN_POINTS.push({ x: toWorldX(26 + (i % 3)), z: toWorldZ(1 + i) % worldH || toWorldZ(2 + (i % 16)) });
}
const DEFENDER_SPOTS = [
  { label: "plateau top (via ramp)", pos: { x: toWorldX(14), z: toWorldZ(9) } },
  { label: "plateau base, sheer side", pos: { x: toWorldX(8), z: toWorldZ(9) } },
  { label: "open ground near forest gap", pos: { x: toWorldX(18), z: toWorldZ(9) } },
  { label: "far corner", pos: { x: toWorldX(3), z: toWorldZ(2) } },
];

let total = 0;
let failures = 0;
for (const spot of DEFENDER_SPOTS) {
  for (const spawn of SPAWN_POINTS) {
    total++;
    const raw = findPath(navGrid, spawn, spot.pos);
    if (!raw) {
      failures++;
      console.error(`FAIL: no path from spawn (${spawn.x.toFixed(1)},${spawn.z.toFixed(1)}) to "${spot.label}"`);
      continue;
    }
    const smoothed = smoothPath(navGrid, raw);
    try {
      checkPathClearIndependently(smoothed, `${spot.label} <- spawn(${spawn.x.toFixed(1)},${spawn.z.toFixed(1)})`);
    } catch (e) {
      failures++;
      console.error(String(e.message));
    }
  }
}
console.log(`\nFull-fixture check: ${total - failures}/${total} spawn->defender paths OK.`);
if (failures > 0) throw new Error(`FAIL: ${failures} path(s) failed across the spawn x defender-spot matrix`);
console.log("Full-fixture pathfinding matrix: all clear (independently verified).");

// ---- Collision-resolution stress test ----
// Exercises the SAME circle-vs-tile-square resolution logic main.js's
// resolveTerrainCollisions uses, reimplemented here (not imported — main.js
// isn't a testable module, it's the app entry point) against worst-case
// forced positions: dead center of a blocked tile, and right at each edge.
function resolveAgainstTile(pos, collisionRadius, tx, tz) {
  const bounds = tileSquareBounds(tx, tz);
  const closestX = Math.max(bounds.minX, Math.min(pos.x, bounds.maxX));
  const closestZ = Math.max(bounds.minZ, Math.min(pos.z, bounds.maxZ));
  const dx = pos.x - closestX;
  const dz = pos.z - closestZ;
  const dist = Math.hypot(dx, dz);
  const clearance = collisionRadius + 0.05;
  if (dist >= clearance) return pos;
  if (dist > 0.0001) {
    const scale = clearance / dist;
    return { x: closestX + dx * scale, z: closestZ + dz * scale };
  }
  const penLeft = pos.x - bounds.minX;
  const penRight = bounds.maxX - pos.x;
  const penTop = pos.z - bounds.minZ;
  const penBottom = bounds.maxZ - pos.z;
  const minPen = Math.min(penLeft, penRight, penTop, penBottom);
  if (minPen === penLeft) return { x: bounds.minX - clearance, z: pos.z };
  if (minPen === penRight) return { x: bounds.maxX + clearance, z: pos.z };
  if (minPen === penTop) return { x: pos.x, z: bounds.minZ - clearance };
  return { x: pos.x, z: bounds.maxZ + clearance };
}

const collisionRadius = 0.75;
let stressFailures = 0;
const sheerTile = { tx: 10, tz: 9 }; // west edge of the plateau, a sheer tile
const bounds = tileSquareBounds(sheerTile.tx, sheerTile.tz);
const worstCasePoints = [
  { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 }, // dead center
  { x: bounds.minX, z: (bounds.minZ + bounds.maxZ) / 2 }, // west edge
  { x: bounds.maxX, z: (bounds.minZ + bounds.maxZ) / 2 }, // east edge
  { x: (bounds.minX + bounds.maxX) / 2, z: bounds.minZ }, // north edge
];
for (const p of worstCasePoints) {
  const resolved = resolveAgainstTile(p, collisionRadius, sheerTile.tx, sheerTile.tz);
  const closestX = Math.max(bounds.minX, Math.min(resolved.x, bounds.maxX));
  const closestZ = Math.max(bounds.minZ, Math.min(resolved.z, bounds.maxZ));
  const finalDist = Math.hypot(resolved.x - closestX, resolved.z - closestZ);
  const ok = finalDist >= collisionRadius - 0.001;
  console.log(`[collision stress] forced to (${p.x.toFixed(2)},${p.z.toFixed(2)}) -> resolved (${resolved.x.toFixed(2)},${resolved.z.toFixed(2)}), clearance=${finalDist.toFixed(3)}: ${ok ? "OK" : "FAIL"}`);
  if (!ok) stressFailures++;
}
if (stressFailures > 0) throw new Error(`FAIL: ${stressFailures} worst-case collision point(s) not properly resolved`);
console.log("Collision-resolution stress test: all worst-case violations correctly resolved.");
