// Grid-based A* pathfinding, generic and terrain-agnostic — the caller
// supplies an `isBlocked(x, z)` predicate when building the grid. Path
// smoothing samples directly against that same grid (see smoothPath below),
// not a separate obstacle check, so routing and smoothing can never
// disagree. This module doesn't know
// anything about forests, cliffs, or any other game-specific terrain.

// ---------- Geometry helper (exported for reuse in obstacle predicates) ----------
export function pointToSegmentDist(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - x1) * dx + (pz - z1) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + dx * t;
  const cz = z1 + dz * t;
  return Math.hypot(px - cx, pz - cz);
}

// ---------- Grid ----------
export function buildNavGrid({ mapWidth, mapDepth, cellSize, isBlocked }) {
  const cols = Math.ceil(mapWidth / cellSize);
  const rows = Math.ceil(mapDepth / cellSize);
  const originX = -mapWidth / 2;
  const originZ = -mapDepth / 2;
  const blocked = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = originX + (col + 0.5) * cellSize;
      const z = originZ + (row + 0.5) * cellSize;
      blocked[row * cols + col] = isBlocked(x, z) ? 1 : 0;
    }
  }

  return { cols, rows, cellSize, originX, originZ, blocked };
}

function worldToCell(grid, x, z) {
  return {
    col: Math.min(grid.cols - 1, Math.max(0, Math.floor((x - grid.originX) / grid.cellSize))),
    row: Math.min(grid.rows - 1, Math.max(0, Math.floor((z - grid.originZ) / grid.cellSize))),
  };
}

function cellToWorld(grid, col, row) {
  return {
    x: grid.originX + (col + 0.5) * grid.cellSize,
    z: grid.originZ + (row + 0.5) * grid.cellSize,
  };
}

function cellIndex(grid, col, row) {
  return row * grid.cols + col;
}

function isCellBlocked(grid, col, row) {
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return true;
  return grid.blocked[row * grid.cols + col] === 1;
}

function findNearestOpenCell(grid, cell) {
  const maxRadius = Math.max(grid.cols, grid.rows);
  for (let radius = 1; radius < maxRadius; radius++) {
    for (let dc = -radius; dc <= radius; dc++) {
      for (let dr = -radius; dr <= radius; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
        const c = cell.col + dc;
        const r = cell.row + dr;
        if (!isCellBlocked(grid, c, r)) return { col: c, row: r };
      }
    }
  }
  return null;
}

// ---------- A* ----------
// Simple binary min-heap keyed by f-score.
class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, priority) {
    this.items.push({ item, priority });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].priority <= this.items[i].priority) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < this.items.length && this.items[l].priority < this.items[smallest].priority) smallest = l;
        if (r < this.items.length && this.items[r].priority < this.items[smallest].priority) smallest = r;
        if (smallest === i) break;
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return top ? top.item : undefined;
  }
}

function octile(a, b) {
  const dx = Math.abs(a.col - b.col);
  const dz = Math.abs(a.row - b.row);
  return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
}

const NEIGHBORS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

function reconstructPath(grid, cameFrom, current) {
  const path = [cellToWorld(grid, current.col, current.row)];
  let idx = cellIndex(grid, current.col, current.row);
  while (cameFrom.has(idx)) {
    current = cameFrom.get(idx);
    idx = cellIndex(grid, current.col, current.row);
    path.unshift(cellToWorld(grid, current.col, current.row));
  }
  return path;
}

// Returns an array of {x, z} world-space waypoints from start to end, or
// null if no path exists at all (shouldn't happen with our simple obstacle
// layouts, but handled defensively).
export function findPath(grid, startWorld, endWorld) {
  let start = worldToCell(grid, startWorld.x, startWorld.z);
  let goal = worldToCell(grid, endWorld.x, endWorld.z);

  // Neither start nor goal should normally land on a blocked cell (only
  // terrain, not units, marks cells blocked), but snap to the nearest open
  // cell defensively in case a unit's live position ever drifts into one
  // (e.g. nudged by separation near an obstacle's edge).
  if (isCellBlocked(grid, goal.col, goal.row)) {
    goal = findNearestOpenCell(grid, goal) || goal;
  }
  if (isCellBlocked(grid, start.col, start.row)) {
    start = findNearestOpenCell(grid, start) || start;
  }

  const startIdx = cellIndex(grid, start.col, start.row);
  const goalIdx = cellIndex(grid, goal.col, goal.row);
  if (startIdx === goalIdx) return [cellToWorld(grid, goal.col, goal.row)];

  const open = new MinHeap();
  const gScore = new Map([[startIdx, 0]]);
  const cameFrom = new Map();
  const closed = new Set();

  open.push(start, octile(start, goal));

  const maxIterations = grid.cols * grid.rows; // hard safety cap, avoids any risk of an infinite loop
  let iterations = 0;

  while (open.size > 0 && iterations < maxIterations) {
    iterations++;
    const current = open.pop();
    const currentIdx = cellIndex(grid, current.col, current.row);
    if (currentIdx === goalIdx) return reconstructPath(grid, cameFrom, current);
    if (closed.has(currentIdx)) continue;
    closed.add(currentIdx);

    for (const [dc, dr, cost] of NEIGHBORS) {
      const nc = current.col + dc;
      const nr = current.row + dr;
      if (isCellBlocked(grid, nc, nr)) continue;
      // Prevent cutting diagonally across a blocked corner.
      if (dc !== 0 && dr !== 0) {
        if (isCellBlocked(grid, current.col + dc, current.row) || isCellBlocked(grid, current.col, current.row + dr)) {
          continue;
        }
      }
      const neighborIdx = cellIndex(grid, nc, nr);
      if (closed.has(neighborIdx)) continue;
      const tentativeG = gScore.get(currentIdx) + cost;
      if (tentativeG < (gScore.get(neighborIdx) ?? Infinity)) {
        gScore.set(neighborIdx, tentativeG);
        cameFrom.set(neighborIdx, current);
        open.push({ col: nc, row: nr }, tentativeG + octile({ col: nc, row: nr }, goal));
      }
    }
  }

  return null; // no path found
}

// ---------- Path smoothing (string-pulling) ----------
// Grid paths naturally zig-zag along cell boundaries. This greedily
// replaces runs of waypoints with a single straight hop wherever a direct
// line between two points is clear, producing a much more natural-looking
// route with far fewer waypoints.
//
// Clearance is checked by walking the SAME grid A* used to build the path
// cell-by-cell (a DDA/supercover line traversal — see below), not a
// separate geometric approximation or fixed-interval sampling — this
// guarantees routing and smoothing can never disagree, and it can't be
// fooled by how thin an obstacle's footprint along the line happens to
// be. History: an early version used an analytic segment-vs-segment
// distance shortcut, which had a real blind spot (a line crossing a
// wall's midpoint while staying far from both endpoints read as
// "clear"). That was fixed by sampling the grid directly at fixed
// intervals instead — better, but testing against the tile system found
// a DIFFERENT blind spot in that fix: a diagonal line can clip a single
// tile's corner with a footprint as narrow as ~0.25 world units, and any
// FIXED sampling interval can be fooled by a clip thinner than itself,
// landing samples on either side of it without ever landing inside it.
// No interval, however fine, closes that class of bug — only walking
// every cell the line geometrically touches does. DDA (digital
// differential analyzer) traversal does exactly that: instead of asking
// "is the obstacle near these N sample points," it visits the exact
// sequence of grid cells the segment passes through, in order, with a
// "supercover" extension so a line passing exactly through a shared
// corner point counts as touching all cells that meet there (a unit
// can't thread a single-point diagonal gap between two blocked tiles).
// Verified against 3000+ random-grid trials plus both real regressions
// found in testing, checked against brute-force ground truth every time.
function isLineClearOnGrid(grid, a, b) {
  let col = Math.floor((a.x - grid.originX) / grid.cellSize);
  let row = Math.floor((a.z - grid.originZ) / grid.cellSize);
  const endCol = Math.floor((b.x - grid.originX) / grid.cellSize);
  const endRow = Math.floor((b.z - grid.originZ) / grid.cellSize);

  if (isCellBlocked(grid, col, row)) return false;
  if (col === endCol && row === endRow) return true;

  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const stepCol = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepRow = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  const nextColBoundaryX = grid.originX + (col + (stepCol > 0 ? 1 : 0)) * grid.cellSize;
  const nextRowBoundaryZ = grid.originZ + (row + (stepRow > 0 ? 1 : 0)) * grid.cellSize;
  let tMaxCol = stepCol !== 0 ? (nextColBoundaryX - a.x) / dx : Infinity;
  let tMaxRow = stepRow !== 0 ? (nextRowBoundaryZ - a.z) / dz : Infinity;
  const tDeltaCol = stepCol !== 0 ? grid.cellSize / Math.abs(dx) : Infinity;
  const tDeltaRow = stepRow !== 0 ? grid.cellSize / Math.abs(dz) : Infinity;

  const EPS = 1e-9;
  // Bounded by the number of cell boundaries the segment can possibly
  // cross — a safety cap against any floating-point edge case looping,
  // same defensive style as A*'s own maxIterations above.
  const maxSteps = (Math.abs(endCol - col) + Math.abs(endRow - row) + 4) * 2;
  for (let i = 0; i < maxSteps; i++) {
    if (Math.abs(tMaxCol - tMaxRow) < EPS && tMaxCol <= 1 + EPS) {
      // Crossing exactly through a shared corner — four cells meet at
      // that point. A plain diagonal step would jump straight from the
      // leaving cell to the entering (diagonal) cell without ever
      // touching the two cells that share only an edge with both;
      // supercover checks those too.
      if (isCellBlocked(grid, col + stepCol, row)) return false;
      if (isCellBlocked(grid, col, row + stepRow)) return false;
      col += stepCol;
      row += stepRow;
      tMaxCol += tDeltaCol;
      tMaxRow += tDeltaRow;
    } else if (tMaxCol < tMaxRow) {
      col += stepCol;
      tMaxCol += tDeltaCol;
    } else {
      row += stepRow;
      tMaxRow += tDeltaRow;
    }
    if (isCellBlocked(grid, col, row)) return false;
    if (col === endCol && row === endRow) return true;
  }
  return col === endCol && row === endRow;
}

export function smoothPath(grid, path) {
  if (!path || path.length <= 2) return path;
  const result = [path[0]];
  let anchor = 0;
  while (anchor < path.length - 1) {
    let farthest = anchor + 1;
    for (let i = path.length - 1; i > anchor + 1; i--) {
      if (isLineClearOnGrid(grid, path[anchor], path[i])) {
        farthest = i;
        break;
      }
    }
    result.push(path[farthest]);
    anchor = farthest;
  }
  return result;
}
