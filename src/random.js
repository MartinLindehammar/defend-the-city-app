// Deterministic, seeded randomness: a given seed always produces the same
// sequence (and therefore the same generated map) — useful for debugging
// and reproducibility. Pure math, no external dependency.

// Mulberry32 — small, fast, good-enough statistical quality for procedural
// generation (not cryptographic).
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Classic gradient (Perlin-style) noise, seeded via a shuffled permutation
// table built from the given rng. Returns values roughly in [-1, 1].
export function createNoise2D(rng) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const GRADIENTS = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];

  function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  function lerp(a, b, t) {
    return a + t * (b - a);
  }
  function grad(hash, x, y) {
    const g = GRADIENTS[hash & 7];
    return g[0] * x + g[1] * y;
  }

  return function noise2D(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  };
}

// Fractal Brownian Motion: sums several octaves of noise at increasing
// frequency/decreasing amplitude for natural-looking, multi-scale terrain
// instead of single-frequency noise (which looks uniformly "bumpy").
export function createFbm2D(rng, { octaves = 4, persistence = 0.5, lacunarity = 2.0 } = {}) {
  const noise = createNoise2D(rng);
  return function fbm(x, y) {
    let total = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxAmplitude = 0;
    for (let i = 0; i < octaves; i++) {
      total += noise(x * frequency, y * frequency) * amplitude;
      maxAmplitude += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxAmplitude; // normalized to roughly [-1, 1]
  };
}
