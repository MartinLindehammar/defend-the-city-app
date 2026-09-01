// Tile-based terrain data model. Replaces the old continuous-heightmap
// terrain.js. Core idea: elevation is now a small integer "level" per
// tile, not a sampled float — this is what makes the game read as a
// tile-based RTS (Age of Empires-style) instead of a smooth 3D landscape,
// and it's also what lets pathfinding.js work completely unchanged (a
// discrete grid was always what it expected; previously we had to sample
// continuous terrain to approximate one).
//
// Hills and Cliffs, previously two separate systems, are now ONE concept:
// a "plateau" is a raised rectangular region whose four edges are each
// either a RAMP (walkable transition — matches the old Hill behavior of
// being climbable from any side) or a SHEER face (impassable — matches
// the old Cliff behavior). A Hill is a plateau with ramps on all four
// sides; a Cliff is a plateau with some sides sheer.

export const TILE_SIZE = 2;
export const LEVEL_HEIGHT = 2; // world-unit height per elevation level

export const TileType = {
  GROUND: 0,
  RAMP: 1,
  SHEER: 2,
  FOREST: 3,
  CITY: 4,
};

export function createTileGrid(cols, rows) {
  return {
    cols,
    rows,
    level: new Uint8Array(cols * rows),
    type: new Uint8Array(cols * rows), // defaults to 0 = GROUND
    // 1 = this tile is a plateau edge whose transition is WALKABLE (a
    // ramp/slope side) rather than a sheer face. Kept as its own array
    // rather than inferred from `type` because stampForest/stampCity
    // overwrite `type` on tiles they cover while leaving `level` raised —
    // so a plateau's slope edge can end up typed FOREST and become
    // indistinguishable from a sheer edge by type alone. That's not
    // hypothetical: a census over 200 generated levels found 450 exposed
    // elevated tiles whose type had been overwritten this way. Rendering
    // read `type === RAMP`, so every one of them drew a rock cliff face —
    // including on hills that are supposed to be pure grassy slopes.
    // Purely a rendering concern: no walkability/pathfinding/combat
    // function reads this field.
    ramp: new Uint8Array(cols * rows),
  };
}

function tileIndex(grid, tx, tz) {
  return tz * grid.cols + tx;
}

export function inBounds(grid, tx, tz) {
  return tx >= 0 && tx < grid.cols && tz >= 0 && tz < grid.rows;
}

export function getTileLevel(grid, tx, tz) {
  if (!inBounds(grid, tx, tz)) return 0;
  return grid.level[tileIndex(grid, tx, tz)];
}

export function getTileType(grid, tx, tz) {
  if (!inBounds(grid, tx, tz)) return TileType.GROUND;
  return grid.type[tileIndex(grid, tx, tz)];
}

// True if this tile is a plateau edge whose transition is a walkable
// slope rather than a sheer face. Rendering-only (see createTileGrid);
// `grid.ramp` may be absent on a hand-built fixture grid, in which case
// this falls back to the type check that was used before it existed.
export function isRampEdge(grid, tx, tz) {
  if (!inBounds(grid, tx, tz)) return false;
  const idx = tileIndex(grid, tx, tz);
  if (!grid.ramp) return grid.type[idx] === TileType.RAMP;
  return grid.ramp[idx] === 1;
}

export function isTileWalkable(grid, tx, tz) {
  if (!inBounds(grid, tx, tz)) return false;
  const t = getTileType(grid, tx, tz);
  return t !== TileType.SHEER && t !== TileType.FOREST && t !== TileType.CITY;
}

// World <-> tile coordinate conversion. The grid is centered so world
// (0,0) is the map center — matches the previous continuous-terrain
// convention (defender territory at negative x, intruder at positive x),
// so the border/placement/spawn logic in levelGenerator.js and main.js
// didn't need to change its sign conventions.
export function worldToTile(grid, x, z) {
  return {
    tx: Math.floor(x / TILE_SIZE + grid.cols / 2),
    tz: Math.floor(z / TILE_SIZE + grid.rows / 2),
  };
}

export function tileToWorldCenter(grid, tx, tz) {
  return {
    x: (tx - grid.cols / 2 + 0.5) * TILE_SIZE,
    z: (tz - grid.rows / 2 + 0.5) * TILE_SIZE,
  };
}

export function getWorldLevel(grid, x, z) {
  const { tx, tz } = worldToTile(grid, x, z);
  return getTileLevel(grid, tx, tz);
}

export function getWorldHeight(grid, x, z) {
  return getWorldLevel(grid, x, z) * LEVEL_HEIGHT;
}

export function isWorldWalkable(grid, x, z) {
  const { tx, tz } = worldToTile(grid, x, z);
  return isTileWalkable(grid, tx, tz);
}

// Two positions can't fight in melee if they're on different elevation
// levels — direct tile-level equivalent of the old continuous
// blockedByCliff(). Ramps count as their plateau's level (not a
// fractional in-between value), so a unit only stops being "blocked" once
// it has actually climbed all the way up, exactly matching the old
// behavior where climbing a Hill's gentle slope to matching height ended
// the block naturally, while a Cliff's sheer face physically prevented
// ever reaching matching height from that side.
export function isMeleeBlockedByElevation(grid, posA, posB) {
  return getWorldLevel(grid, posA.x, posA.z) !== getWorldLevel(grid, posB.x, posB.z);
}

// Stamps a rectangular plateau onto the grid. `sheerSides` is a Set of
// 'north'|'south'|'east'|'west'; those edges become impassable sheer
// tiles, the rest become walkable ramp tiles. The interior (inset by one
// tile on every side) is flat ground at `level`. A plateau needs at least
// 3 tiles in each dimension to have any interior at all.
export function stampPlateau(grid, { txMin, txMax, tzMin, tzMax, level, sheerSides }) {
  for (let tz = tzMin; tz <= tzMax; tz++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      if (!inBounds(grid, tx, tz)) continue;
      const idx = tileIndex(grid, tx, tz);
      const onNorth = tz === tzMin;
      const onSouth = tz === tzMax;
      const onWest = tx === txMin;
      const onEast = tx === txMax;

      grid.level[idx] = level;

      if (!onNorth && !onSouth && !onWest && !onEast) {
        grid.type[idx] = TileType.GROUND;
        grid.ramp[idx] = 0;
        continue;
      }
      // Corner tiles touch two edges — sheer wins if either does (a
      // corner can't be "half sheer, half ramp").
      const sheer =
        (onNorth && sheerSides.has("north")) ||
        (onSouth && sheerSides.has("south")) ||
        (onWest && sheerSides.has("west")) ||
        (onEast && sheerSides.has("east"));
      grid.type[idx] = sheer ? TileType.SHEER : TileType.RAMP;
      // Written alongside `type`, but survives later forest/city stamping
      // (which only rewrites `type`) — see createTileGrid's note.
      grid.ramp[idx] = sheer ? 0 : 1;
    }
  }
}

export function stampForest(grid, { txMin, txMax, tzMin, tzMax }) {
  for (let tz = tzMin; tz <= tzMax; tz++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      if (!inBounds(grid, tx, tz)) continue;
      grid.type[tileIndex(grid, tx, tz)] = TileType.FOREST;
    }
  }
}

export function stampCity(grid, { txMin, txMax, tzMin, tzMax }) {
  for (let tz = tzMin; tz <= tzMax; tz++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      if (!inBounds(grid, tx, tz)) continue;
      grid.type[tileIndex(grid, tx, tz)] = TileType.CITY;
    }
  }
}
