import { createRng } from "./random.js";
import { buildNavGrid, findPath } from "./pathfinding.js";
import { TILE_SIZE, createTileGrid, stampPlateau, stampForest, stampCity, isWorldWalkable } from "./tileTerrain.js";

// Baseline dimensions (in TILES) this whole game was designed and
// playtested around — generated maps are expressed as a multiple of
// these. Matches the previous continuous system's 46x30 world-unit base,
// halved since TILE_SIZE=2 (23x15 tiles covers the same physical area,
// so map scale and unit stats feel exactly as before).
const BASE_COLS = 23;
const BASE_ROWS = 15;

// What fraction of the map's total width belongs to the defender. Kept
// identical to the pre-tile system (was explicitly widened from an
// implicit 50/50 split after feedback that half the map being unusable
// for defense was too much).
const DEFENDER_FRACTION = 0.75;

function dist(a, b) {
  return Math.hypot(a.tx - b.tx, a.tz - b.tz);
}

// Tries up to maxAttempts random candidates from propose(rng), returns the
// first that satisfies isValid(candidate), or null if none did.
function placeWithRejection(rng, maxAttempts, propose, isValid) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = propose(rng);
    if (isValid(candidate)) return candidate;
  }
  return null;
}

function pickMapTileSize(rng) {
  // SCALE_BACK is the one linear "shrink the whole map" knob — it scales
  // the final output uniformly without touching the width/depth variety
  // logic below (the random multiplier range). 0.75 * 0.7 * 0.8 = 0.42:
  // each factor is its own historical round of "make maps feel less
  // sprawling" requests, the last (0.8) being an explicit further ~20%
  // reduction. The old 15%-chance "extra-large map" roll has been removed
  // ENTIRELY (not just scaled down) per explicit request — every
  // generated map now draws from the same single size distribution, with
  // no chance of a larger outlier on top of it. The
  // `Math.max(20, ...)`/`Math.max(14, ...)` floors further down are left
  // untouched deliberately — those exist as a correctness guarantee
  // (enough room for the city/plateaus/forests to actually fit and for
  // reachability validation to succeed), not a size dial, so shrinking
  // them too would risk raising the generator's fallback rate rather than
  // just making maps more compact.
  const SCALE_BACK = 0.75 * 0.7 * 0.8;
  let widthMult = 1.8 + rng() * 1.4;
  let depthMult = 1.8 + rng() * 1.4;
  widthMult *= SCALE_BACK;
  depthMult *= SCALE_BACK;
  return {
    cols: Math.max(20, Math.round(BASE_COLS * widthMult)),
    rows: Math.max(14, Math.round(BASE_ROWS * depthMult)),
  };
}

// Every placed feature (plateaus, forests, the city) is tracked as a
// simple exclusion circle (in TILE-distance units now) for spacing
// purposes. Deliberate simplification, same reasoning as before: exact
// rectangle-vs-rectangle overlap math would be more precise, but the real
// correctness guarantee is the reachability validation at the end.
function boundingCircleOfRect(r) {
  const tx = (r.txMin + r.txMax) / 2;
  const tz = (r.tzMin + r.tzMax) / 2;
  const radius = Math.hypot(r.txMax - r.txMin, r.tzMax - r.tzMin) / 2;
  return { tx, tz, radius };
}

function tooClose(zone, existingZones, extraGap) {
  return existingZones.some((other) => dist(zone, other) < zone.radius + other.radius + extraGap);
}

const SIDE_NAMES = ["north", "south", "east", "west"];

// Plateaus unify the old separate Hill/Cliff systems — see tileTerrain.js's
// header comment for the full rationale. This single function generates
// BOTH kinds; only which sides are sheer varies. A "hill" (no sheer sides,
// walkable from every direction) and a "cliff" (1-3 sheer sides, never
// all 4 — always leave at least one way up) are the same underlying
// feature, just parameterized differently. Lives in defender territory,
// same as the old Hills/Cliffs did.
function generatePlateaus(rng, cols, rows, borderTileCol, exclusionZones) {
  const area = cols * rows;
  const targetCount = Math.max(3, Math.min(10, Math.round((area / 45) * (0.7 + rng() * 0.6))));
  const colCutoff = borderTileCol - 2; // stay clear of the border
  const plateaus = [];

  for (let i = 0; i < targetCount; i++) {
    const plateau = placeWithRejection(
      rng,
      25,
      (r) => {
        const footprintW = 4 + Math.floor(r() * 5); // 4-8 tiles
        const footprintD = 4 + Math.floor(r() * 5);
        const txMin = 1 + Math.floor(r() * Math.max(1, colCutoff - footprintW - 1));
        const txMax = txMin + footprintW;
        const tzMin = 1 + Math.floor(r() * Math.max(1, rows - footprintD - 2));
        const tzMax = tzMin + footprintD;

        const isHill = r() < 0.4; // ~40% hill-type (all ramps), ~60% cliff-type
        let sheerSides = new Set();
        if (!isHill) {
          const shuffled = [...SIDE_NAMES].sort(() => r() - 0.5);
          const sheerCount = 1 + Math.floor(r() * 3); // 1-3 sheer sides
          sheerSides = new Set(shuffled.slice(0, sheerCount));
        }

        return { txMin, txMax, tzMin, tzMax, level: 1, sheerSides };
      },
      (p) => {
        if (p.txMax >= colCutoff) return false;
        return !tooClose(boundingCircleOfRect(p), exclusionZones, 2);
      }
    );
    if (plateau) {
      plateaus.push(plateau);
      exclusionZones.push(boundingCircleOfRect(plateau));
    }
  }
  return plateaus;
}

// Forests are rectangular tile regions, deliberately biased toward the
// defender's (larger) side — most on the defense side, a few smaller ones
// on the intruder spawn strip. Two "gate" forests flank a passage right at
// the border, preserving the core chokepoint mechanic this game was built
// around, even though everything else is randomized.
function generateForests(rng, cols, rows, borderTileCol, exclusionZones) {
  const forests = [];

  const gateSize = 3 + Math.floor(rng() * 2);
  const gateCol = borderTileCol - 1;
  const gateOffset = Math.round(rows * 0.22 + rng() * rows * 0.05);
  const midRow = Math.round(rows / 2);
  const gateForests = [
    { txMin: gateCol - gateSize, txMax: gateCol, tzMin: midRow - gateOffset - gateSize, tzMax: midRow - gateOffset },
    { txMin: gateCol - gateSize, txMax: gateCol, tzMin: midRow + gateOffset, tzMax: midRow + gateOffset + gateSize },
  ];
  for (const f of gateForests) {
    forests.push(f);
    exclusionZones.push(boundingCircleOfRect(f));
  }

  const area = cols * rows;
  const totalScatter = Math.max(3, Math.min(12, Math.round((area / 24) * (0.7 + rng() * 0.6))));
  const defenderCount = Math.round(totalScatter * 0.8); // most forests on the defense side
  const intruderCount = Math.max(0, totalScatter - defenderCount);

  for (let i = 0; i < defenderCount; i++) {
    const forest = placeWithRejection(
      rng,
      25,
      (r) => {
        const w = 2 + Math.floor(r() * 3);
        const d = 2 + Math.floor(r() * 3);
        const txMin = 1 + Math.floor(r() * Math.max(1, borderTileCol - 3 - w));
        const tzMin = 1 + Math.floor(r() * Math.max(1, rows - d - 2));
        return { txMin, txMax: txMin + w, tzMin, tzMax: tzMin + d };
      },
      (f) => !tooClose(boundingCircleOfRect(f), exclusionZones, 1)
    );
    if (forest) {
      forests.push(forest);
      exclusionZones.push(boundingCircleOfRect(forest));
    }
  }

  for (let i = 0; i < intruderCount; i++) {
    const forest = placeWithRejection(
      rng,
      25,
      (r) => {
        const w = 1 + Math.floor(r() * 2); // smaller than defender-side forests
        const d = 1 + Math.floor(r() * 2);
        const txMin = borderTileCol + 1 + Math.floor(r() * Math.max(1, cols - borderTileCol - w - 2));
        const tzMin = 1 + Math.floor(r() * Math.max(1, rows - d - 2));
        return { txMin, txMax: txMin + w, tzMin, tzMax: tzMin + d };
      },
      (f) => !tooClose(boundingCircleOfRect(f), exclusionZones, 0.8)
    );
    if (forest) {
      forests.push(forest);
      exclusionZones.push(boundingCircleOfRect(forest));
    }
  }

  return forests;
}

// Raiders arrive as loose squads rather than a uniform spread — cluster
// count and per-cluster size are both randomized, but always sum to
// exactly `totalRaiders`. Spawns are confined to the intruder strip
// between the border and the east edge. Cluster CENTERS are chosen in
// tile space (for consistent placement relative to the border/forests),
// but individual raiders within a cluster jitter continuously in world
// units — raiders don't need to be tile-aligned, only the terrain does.
function generateIntruderSpawns(rng, cols, rows, borderTileCol, totalRaiders, unitType) {
  // clusterCount must never exceed totalRaiders — a cluster with 0 members
  // is meaningless, and worse, the per-cluster sizing loop below has an
  // "at least 1 per cluster" floor (Math.max(1, ...)) that silently
  // INVENTS extra spawns once there are more clusters than raiders to
  // fill them: with clusterCount=3 and totalRaiders=1 (Boss levels always
  // request exactly 1), the first two clusters each still claim their
  // forced minimum of 1, leaving the last cluster's "remaining" budget
  // negative — which the spawn loop just silently skips rather than
  // erroring, so the level generates with 2 raiders instead of the
  // requested 1 with no visible error anywhere. Confirmed by direct
  // trace before fixing, not assumed. The `Math.max(3, ...)` floor below
  // is still exactly what it was for any totalRaiders >= 3 (unchanged
  // behavior/variety for ordinary-sized levels); it just can no longer
  // force more clusters to exist than there are actual units to spawn.
  const targetClusters = Math.round((totalRaiders / 4) * (0.7 + rng() * 0.6));
  const clusterCount = Math.max(1, Math.min(totalRaiders, 8, Math.max(3, targetClusters)));

  const sizes = [];
  let remaining = totalRaiders;
  for (let i = 0; i < clusterCount; i++) {
    const isLast = i === clusterCount - 1;
    const avg = remaining / (clusterCount - i);
    const size = isLast ? remaining : Math.max(1, Math.min(remaining - (clusterCount - i - 1), Math.round(avg * (0.6 + rng() * 0.8))));
    sizes.push(size);
    remaining -= size;
  }

  const stripCols = cols - borderTileCol;
  const spawnCol = borderTileCol + stripCols * (0.45 + rng() * 0.35);
  const jitterCols = Math.min(cols * 0.03, stripCols * 0.25);
  const usableRows = rows * 0.84;

  const spawns = [];
  for (let i = 0; i < clusterCount; i++) {
    const clusterRow =
      clusterCount > 1
        ? rows / 2 - usableRows / 2 + (usableRows / (clusterCount - 1)) * i + (rng() - 0.5) * rows * 0.04
        : rows / 2 + (rng() - 0.5) * rows * 0.2;
    const clusterCol = spawnCol + (rng() - 0.5) * jitterCols;
    const centerX = (clusterCol - cols / 2) * TILE_SIZE;
    const centerZ = (clusterRow - rows / 2) * TILE_SIZE;
    for (let j = 0; j < sizes[i]; j++) {
      const angle = rng() * Math.PI * 2;
      const r = rng() * TILE_SIZE * 1.6;
      spawns.push({ type: unitType, pos: [centerX + Math.cos(angle) * r, centerZ + Math.sin(angle) * r * 0.7] });
    }
  }
  return spawns;
}

function buildCandidateLevel(rng, { totalRaiders, startingPopulation, unitType }) {
  const { cols, rows } = pickMapTileSize(rng);
  // Border tile column: tx=0 is the true west edge, tx=cols the true east
  // edge, so DEFENDER_FRACTION of the way across from the west edge gives
  // exactly "75% of the map is defender territory" with no offset math
  // needed (unlike the old world-centered formula).
  const borderTileCol = Math.round(cols * DEFENDER_FRACTION);

  // City: pinned to the far west edge (the actual back of the map) AND
  // pushed close to a genuine row-corner — explicitly never centered,
  // per feedback that a centered city read as "in the middle" rather than
  // tucked at the back. Corner distance is as close to the true edge as
  // the city's own footprint allows without clipping past it.
  const cityCornerSign = rng() < 0.5 ? -1 : 1;
  const cityHalfRows = Math.max(2, Math.round(rows * 0.12));
  const cityRowCenter = Math.round(rows / 2 + cityCornerSign * (rows / 2 - cityHalfRows - Math.max(1, rows * 0.02)));
  const cityColSpan = Math.max(3, Math.round(cols * 0.12));
  const cityTile = { txMin: 0, txMax: cityColSpan, tzMin: cityRowCenter - cityHalfRows, tzMax: cityRowCenter + cityHalfRows };

  const exclusionZones = [boundingCircleOfRect(cityTile)];
  const plateaus = generatePlateaus(rng, cols, rows, borderTileCol, exclusionZones);
  const forests = generateForests(rng, cols, rows, borderTileCol, exclusionZones);
  const intruderSpawns = generateIntruderSpawns(rng, cols, rows, borderTileCol, totalRaiders, unitType);

  const grid = createTileGrid(cols, rows);
  for (const p of plateaus) stampPlateau(grid, p);
  for (const f of forests) stampForest(grid, f);
  stampCity(grid, cityTile);

  // World-space convenience fields, derived once from tile bounds, for
  // code that wants continuous coordinates (border line rendering, city
  // placement-rejection rectangle, camera framing).
  const mapWidth = cols * TILE_SIZE;
  const mapDepth = rows * TILE_SIZE;
  const borderX = (borderTileCol - cols / 2) * TILE_SIZE;
  const cityZone = {
    xMin: (cityTile.txMin - cols / 2) * TILE_SIZE,
    xMax: (cityTile.txMax - cols / 2) * TILE_SIZE,
    zMin: (cityTile.tzMin - rows / 2) * TILE_SIZE,
    zMax: (cityTile.tzMax - rows / 2) * TILE_SIZE,
  };

  return { grid, cols, rows, mapWidth, mapDepth, borderX, cityZone, intruderSpawns, startingPopulation };
}

// The one hard correctness guarantee: build a real nav grid from the
// candidate tile grid and confirm every raider spawn can actually reach
// the defender's side at all. Simpler than the old continuous system —
// the tile grid's own walkability IS the nav grid's obstacle data now, no
// separate geometric sampling step needed.
function isReachable(config) {
  const { grid, mapWidth, mapDepth, cityZone, borderX, intruderSpawns } = config;
  const navGrid = buildNavGrid({
    mapWidth,
    mapDepth,
    cellSize: TILE_SIZE,
    isBlocked: (x, z) => !isWorldWalkable(grid, x, z),
  });

  const samples = [{ x: cityZone.xMax + TILE_SIZE, z: (cityZone.zMin + cityZone.zMax) / 2 }];
  const defXMin = -mapWidth / 2 + TILE_SIZE;
  const defXMax = borderX - TILE_SIZE;
  for (let i = 0; i < 6; i++) {
    samples.push({
      x: defXMin + (defXMax - defXMin) * (i / 5),
      z: -mapDepth * 0.4 + mapDepth * 0.8 * (i / 5),
    });
  }

  for (const spawn of intruderSpawns) {
    const spawnPos = { x: spawn.pos[0], z: spawn.pos[1] };
    const reachesAny = samples.some((s) => findPath(navGrid, spawnPos, s) !== null);
    if (!reachesAny) return false;
  }
  return true;
}

// Guaranteed-safe layout used only if every randomized attempt somehow
// fails validation — an empty, flat, fully-walkable grid with no
// plateaus/forests at all, so reachability is trivially guaranteed.
function buildFallbackLevel({ totalRaiders, startingPopulation, unitType }) {
  const cols = Math.round(BASE_COLS * 1.5);
  const rows = Math.round(BASE_ROWS * 1.5);
  const borderTileCol = Math.round(cols * DEFENDER_FRACTION);
  const grid = createTileGrid(cols, rows);
  const cityTile = { txMin: 0, txMax: 3, tzMin: Math.round(rows / 2) - 4, tzMax: Math.round(rows / 2) + 4 };
  stampCity(grid, cityTile);

  const mapWidth = cols * TILE_SIZE;
  const mapDepth = rows * TILE_SIZE;
  const borderX = (borderTileCol - cols / 2) * TILE_SIZE;
  const cityZone = {
    xMin: (cityTile.txMin - cols / 2) * TILE_SIZE,
    xMax: (cityTile.txMax - cols / 2) * TILE_SIZE,
    zMin: (cityTile.tzMin - rows / 2) * TILE_SIZE,
    zMax: (cityTile.tzMax - rows / 2) * TILE_SIZE,
  };

  const spawns = [];
  for (let i = 0; i < totalRaiders; i++) {
    spawns.push({
      type: unitType,
      pos: [mapWidth / 2 - TILE_SIZE * 2, -mapDepth * 0.3 + (mapDepth * 0.6 * i) / Math.max(1, totalRaiders - 1)],
    });
  }

  return { grid, cols, rows, mapWidth, mapDepth, borderX, cityZone, intruderSpawns: spawns, startingPopulation, fallback: true };
}

// Generates a fully validated level: randomized tile terrain + raider
// layout, guaranteed reachable. Retries internally with fresh randomness
// on validation failure; falls back to a guaranteed-simple layout if
// every attempt fails.
export function generateLevel({ seed = Date.now(), totalRaiders = 20, startingPopulation = 14, unitType = "raider", maxAttempts = 12 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = createRng((seed + attempt * 7919) >>> 0);
    const config = buildCandidateLevel(rng, { totalRaiders, startingPopulation, unitType });
    if (isReachable(config)) {
      config.seed = seed;
      config.attempt = attempt;
      config.fallback = false;
      return config;
    }
  }
  const fallback = buildFallbackLevel({ totalRaiders, startingPopulation, unitType });
  fallback.seed = seed;
  fallback.attempt = maxAttempts;
  return fallback;
}
