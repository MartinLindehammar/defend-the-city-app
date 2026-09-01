import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Kenney "Nature Kit" (CC0, see `nature assets/License.txt`) — the same
// pack whose files were already sitting unreferenced under public/models/
// from an earlier round. Reactivated here for the tile/nature visual pass:
// real ground/cliff/ramp tile models and real tree/clutter models replace
// the flat colored-box placeholders.
export const MODEL_NAMES = {
  groundTile: ["ground_grass"],
  cliffBlock: ["cliff_block_rock"],
  cliffLarge: ["cliff_large_rock"],
  cliffCorner: ["cliff_cornerLarge_rock"],
  // Walkable plateau edges render as the kit's real staircase pieces
  // (replacing the old plain cliff_blockSlope_rock wedge). The two mate
  // exactly: cliff_stepsCorner_rock's -X edge profile is vertex-for-vertex
  // the same stepped profile as cliff_steps_rock's, so a straight run
  // flows into a corner with no seam. Both descend toward local -Z.
  cliffSteps: ["cliff_steps_rock"],
  cliffStepsCorner: ["cliff_stepsCorner_rock"],
  cityGround: ["platform_stone"],
  trees: [
    "tree_oak",
    "tree_oak_dark",
    "tree_oak_fall",
    "tree_pineDefaultA",
    "tree_pineDefaultB",
    "tree_pineRoundA",
    "tree_pineRoundB",
    "tree_pineTallA_detailed",
    "tree_pineTallB_detailed",
    "tree_pineTallC_detailed",
    "tree_pineTallD_detailed",
    "tree_pineSmallA",
    "tree_pineSmallB",
    "tree_pineGroundA",
    "tree_pineGroundB",
  ],
  forestClutter: ["rock_smallA", "rock_smallB", "rock_smallC", "plant_bush", "grass", "grass_large"],
  groundClutter: [
    "flower_purpleA",
    "flower_purpleB",
    "flower_purpleC",
    "flower_redA",
    "flower_redB",
    "flower_redC",
    "grass",
    "grass_large",
    "plant_bush",
  ],
};

const MODEL_BASE = "/models/";
const ALL_NAMES = [...new Set(Object.values(MODEL_NAMES).flat())];

const loader = new GLTFLoader();
const cache = new Map();

function loadOne(name) {
  return new Promise((resolve, reject) => {
    loader.load(
      `${MODEL_BASE}${name}.glb`,
      (gltf) => {
        const root = gltf.scene;
        root.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            // Every model in this pack exports with metalness=1 — with no
            // environment map in this scene, a fully metallic PBR surface
            // has no diffuse response at all, rendering flat black except
            // for blown-out specular hotspots facing the sun. These are
            // flat-shaded stylized assets, not metal; force metalness to 0
            // so their base color actually reads as a lit diffuse surface.
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
              if (mat && "metalness" in mat) mat.metalness = 0;
            }
          }
        });
        cache.set(name, root);
        resolve();
      },
      undefined,
      (err) => reject(new Error(`Failed to load model "${name}": ${err?.message || err}`))
    );
  });
}

export async function preloadAssets(onProgress) {
  let loaded = 0;
  await Promise.all(
    ALL_NAMES.map((name) =>
      loadOne(name).then(() => {
        loaded++;
        if (onProgress) onProgress(loaded, ALL_NAMES.length);
      })
    )
  );
}

export function spawnModel(name) {
  const template = cache.get(name);
  if (!template) {
    throw new Error(`Model "${name}" isn't loaded — did preloadAssets() run and complete first?`);
  }
  return template.clone(true);
}

export function randomOf(names) {
  return names[Math.floor(Math.random() * names.length)];
}

// Every Kenney Nature Kit model checked so far is a single mesh node under
// a single root node (1-2 material primitives — e.g. a "grass top" +
// "rock/wood base" pair), never a deeper hierarchy, so extracting a flat
// list of {geometry, material, matrix} parts once and reusing them across
// many THREE.InstancedMesh groups (one per part, since InstancedMesh needs
// one shared geometry+material) is safe and correct for real-time tile
// rendering at map scale, where a per-tile scene clone would be far too
// many draw calls. `matrix` is each part's transform relative to the
// model's own root (composed with updateMatrixWorld so it's correct even
// if a part sits under a non-identity mesh-node transform) — callers
// multiply it under their own per-instance placement matrix.
const partsCache = new Map();

export function getModelParts(name) {
  if (partsCache.has(name)) return partsCache.get(name);
  const template = cache.get(name);
  if (!template) {
    throw new Error(`Model "${name}" isn't loaded — did preloadAssets() run and complete first?`);
  }
  template.updateMatrixWorld(true);
  const parts = [];
  template.traverse((child) => {
    if (child.isMesh) {
      parts.push({ geometry: child.geometry, material: child.material, matrix: child.matrixWorld.clone() });
    }
  });
  partsCache.set(name, parts);
  return parts;
}
