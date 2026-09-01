import * as THREE from "three";
import { CRIT_DAMAGE_MULTIPLIER } from "./items.js";

// Medieval fantasy roster.
// Defenders are stationary (they hold a chokepoint and fight what comes to them).
// Intruders always advance toward the nearest defender.
//
// Explicit stat model (kept simple and shared as our common vocabulary):
//   HP, damageMin/damageMax (rolled per hit), attackSpeed (hits/sec), range,
//   armor (flat damage reduction per hit, min 1 always gets through),
//   move speed, cost (defenders only).
// Melee units get a NARROW damage range (consistent, predictable trades).
// Ranged units get a WIDE damage range (swingy — sometimes a weak plink,
// sometimes a devastating hit).
//
// UNCHANGED by the tile-terrain rewrite — every number here means exactly
// what it meant before. Strategy/balance was never touched by the visual
// pivot, deliberately: the whole point was to change how the game LOOKS,
// not how it PLAYS.
//
// attackSpeed values below have now been reduced ~25% TWICE (two
// separate rounds of the same "reduce starting attack speed for all
// units by around 25%" request) — cumulative, not a typo: the first
// round took the original values down to ~0.75/0.9/0.98/0.41, and this
// second round takes THOSE down by another ~25% each. Every unit type
// uniformly, same as before — not just defenders or just intruders.
// Upgrades/evolution (see progression.js) apply on top of these as
// always; nothing about how those systems work changed, only the base
// numbers they start from.
export const UNIT_STATS = {
  knight: {
    label: "Knight",
    team: "defender",
    color: 0x4a6fa5,
    size: [1.3, 1.7, 1.3],
    maxHealth: 150,
    damageMin: 16,
    damageMax: 20,
    attackSpeed: 0.56, // reduced ~25% AGAIN from the (already-reduced) 0.75 — see unit.js top comment
    range: 1.7,
    armor: 2,
    speed: 0,
    stationary: true,
    ranged: false,
    cost: 3,
  },
  archer: {
    label: "Archer",
    team: "defender",
    color: 0x3fa796,
    size: [0.9, 1.5, 0.9],
    maxHealth: 50,
    damageMin: 6,
    damageMax: 20,
    attackSpeed: 0.68, // reduced ~25% AGAIN from the (already-reduced) 0.9
    range: 7, // reduced by 2 from the original 9
    armor: 0,
    speed: 0,
    stationary: true,
    ranged: true,
    cost: 2,
    projectile: { color: 0xffe066, radius: 0.14, speed: 18, arcHeight: 0.8 },
  },
  mage: {
    label: "Mage",
    team: "defender",
    color: 0x8e44ec,
    size: [0.85, 1.5, 0.85],
    maxHealth: 30, // fragile — even lower than Archer's 50
    damageMin: 29, // +10% from 26 (26*1.1=28.6, rounded) — 26 itself was +20% from the original 22
    damageMax: 40, // +10% from 36 (36*1.1=39.6, rounded) — high per-hit damage, offsetting the slow attack speed
    attackSpeed: 0.32, // low attack speed — slower than Knight (0.56) and Archer (0.68)
    range: 6,
    armor: 0,
    speed: 0,
    stationary: true,
    ranged: true,
    cost: 4,
    unlockLevel: 10, // not selectable/placeable before this level — see refreshAffordability in main.js
    splashRadius: 1.8, // small-radius splash — every living enemy within this of the impact point is hit
    // Freezing on-hit effect: every enemy caught in the splash also has its
    // move speed AND attack speed reduced by `slowPercent` for `duration`
    // seconds (see applyFreeze/stepInDirection). Nested in its own object
    // (rather than flat fields) so getUpgradedStats can upgrade it as one
    // unit without touching the rest of the stats object.
    freeze: { slowPercent: 0.10, duration: 1.0 },
    projectile: { color: 0xa96bf2, radius: 0.17, speed: 15, arcHeight: 1.0 },
  },
  raider: {
    label: "Raider",
    team: "intruder",
    color: 0xb03a3a,
    size: [0.9, 1.2, 0.9],
    maxHealth: 32,
    damageMin: 7,
    damageMax: 8,
    attackSpeed: 0.74, // reduced ~25% AGAIN from the (already-reduced) 0.98
    range: 1.3,
    armor: 0,
    speed: 3.6,
    stationary: false,
    ranged: false,
  },
  catapult: {
    label: "Catapult",
    team: "intruder",
    color: 0x8a5a2a,
    size: [1.9, 1.3, 1.9],
    maxHealth: 130,
    damageMin: 18,
    damageMax: 34,
    attackSpeed: 0.31, // reduced ~25% AGAIN from the (already-reduced) 0.41 (catapult defined but unused in any level)
    range: 6,
    armor: 2,
    speed: 1.1,
    stationary: false,
    ranged: true,
    projectile: { color: 0x6b4a2a, radius: 0.28, speed: 12, arcHeight: 2.5 },
  },
};

// Damage multiplier applied when the attacker stands meaningfully higher
// than its target. Unchanged logic and unchanged threshold/bonus values —
// only WHERE groundHeight comes from changed (tile level lookup instead
// of continuous terrain sampling), not what this comparison means.
export const ELEVATION_ADVANTAGE_THRESHOLD = 1.0;
export const ELEVATION_DAMAGE_BONUS = 1.3; // +30% damage from high ground

let nextId = 0;

// Placeholder character art: a simple colored circle per unit type,
// cached so e.g. several raiders of the same wave type share one texture
// instead of generating a fresh canvas per unit. This is exactly the
// kind of thing meant to be replaced wholesale once real sprite sheets
// are sourced — Unit only ever asks "give me the texture for this
// variant," so swapping this function's internals for an image loader is
// the only change needed anywhere in the codebase to bring in real
// character art.
//
// Cached by `variantKey`, not by base unit `type` — a wave type (see
// progression.js's WAVE_TYPES/getWaveStats) reuses the "raider" archetype
// for every variant (Flying/Mass/Champions/Boss are all still literally
// `new Unit("raider", ...)`), just with a different statsOverride, so
// caching by `type` alone would make every wave type render identically.
// `variantKey` defaults to `type` for anything that doesn't set
// `stats.spriteVariant` (defenders, and base "raider"/"knight"/"archer"
// placements), so this is a pure addition — nothing about existing
// texture caching changes for units that don't opt into a variant.
const spriteTextureCache = new Map();
function getUnitTexture(variantKey, stats) {
  if (spriteTextureCache.has(variantKey)) return spriteTextureCache.get(variantKey);
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const hex = "#" + stats.color.toString(16).padStart(6, "0");
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  spriteTextureCache.set(variantKey, texture);
  return texture;
}

// Physical footprint radius derived from a stats object's `size` — used
// for BOTH a unit's own collision radius (below, in the constructor) and,
// in main.js, to size the melee attack-slot ring around a target based on
// however big THIS level's actual attacking raiders are. Exported
// specifically so both places share one formula rather than risking two
// copies drifting apart — that mismatch is exactly what caused a real
// bug: Boss/Champions (much larger stats.size via their wave-type
// sizeMultiplier) were being assigned slot positions sized for a small,
// fixed estimate that had nothing to do with their real bulk, so their
// own separation/collision resolution (which DOES use their real,
// larger radius) kept shoving them back out of their assigned slot
// before they could ever get within actual attack range — visible as
// "tries to attack but deals no damage" (Boss, worst mismatch) or
// "struggles to get in place" (Champions, smaller mismatch).
export function computeCollisionRadius(stats) {
  const [w, , d] = stats.size;
  return (Math.max(w, d) / 2) * 1.15;
}

export class Unit {
  constructor(type, position, scene, statsOverride = null) {
    this.id = nextId++;
    this.type = type;
    // Defenders can receive a per-run "effective stats" object (base
    // UNIT_STATS plus any permanent upgrades purchased with banked Gold —
    // see progression.js's getUpgradedStats). Intruders and unupgraded
    // placements just fall back to the shared base template. Either way,
    // this.stats is never the SAME object as UNIT_STATS[type] once an
    // override is in play, so nothing here can accidentally mutate the
    // shared template.
    this.stats = statsOverride || UNIT_STATS[type];
    this.team = this.stats.team; // "defender" | "intruder"
    this.health = this.stats.maxHealth;
    this.alive = true;
    this.attackCooldown = 0;
    // Freeze/slow status (currently only ever applied by the Mage's
    // splash-on-hit — see applyFreeze in main.js): freezeTimer counts down
    // in seconds, freezeSlowAmount is the fraction (e.g. 0.1 = -10%) taken
    // off both move speed (stepInDirection, below) and attack speed
    // (main.js's cooldown reset) while freezeTimer > 0. A fresh hit
    // REFRESHES the timer rather than stacking it — a standard slow-effect
    // design, and simple since only one source of freeze exists right now.
    this.freezeTimer = 0;
    this.freezeSlowAmount = 0;
    // Persistent target: once acquired, kept until it dies, so units finish
    // one fight before starting the next instead of spreading damage thin
    // across whichever enemy happens to be nearest each frame.
    this.target = null;
    // A* path to the current target: an array of {x,z} waypoints, plus
    // which index we're currently walking toward.
    this.path = null;
    this.pathIndex = 0;
    this.pathTarget = null;
    // World position the CURRENT cached path was actually computed toward
    // — compared against the live destination each frame so a stale path
    // (e.g. chasing a defender that has since moved via its guard-mobility
    // leash) gets recomputed instead of silently walking toward memory.
    this.pathDestPos = null;
    // If a target's attack ring turns out full right when this unit
    // arrives, it's temporarily avoided (not permanently — fullness is
    // transient, unlike a geometrically bad slot) so target reacquisition
    // doesn't just immediately re-pick the same one.
    this.avoidTarget = null;
    this.avoidTimer = 0;
    // Melee attack-slot state — see meleeSlots.js / main.js for the system.
    this.meleeSlotTarget = null;
    this.meleeSlotIndex = null;
    // Stuck-detection watchdog (see updateStuckWatchdog in main.js).
    this.stuckCheckPos = null;
    this.stuckCheckElapsed = 0;
    this.stuckTimer = 0;
    // Defenders' fixed post (their placement point) — used for the
    // limited "guard" mobility leash, see DEFENDER_LEASH_RADIUS in main.js.
    this.homePosition = null;
    // As a target: this unit's own ring of slots, lazily created the first
    // time something tries to melee it.
    this.slotRing = null;
    this.slotOccupants = null;
    // Facing angle (radians, atan2(dx,dz) convention) — tracked for
    // future directional-sprite use (a real character sprite sheet would
    // pick a frame based on this). Placeholder circles don't visually
    // change with it yet, since a billboard sprite always faces the
    // camera regardless of this value; the data is still computed exactly
    // as before so nothing about targeting/movement needs to change when
    // real directional art arrives.
    this.facingAngle = this.team === "defender" ? Math.PI / 2 : -Math.PI / 2;

    const [w, h, d] = this.stats.size;
    this.halfHeight = h / 2;
    // Physical footprint used for unit-unit separation, so units don't stack.
    this.collisionRadius = computeCollisionRadius(this.stats);

    // Body: a billboard sprite instead of a 3D mesh. Sprites always face
    // the camera automatically — this is also why the old per-frame
    // faceHealthBarToCamera step is gone entirely (see health bar below):
    // there's nothing left to manually orient.
    const spriteVariant = this.stats.spriteVariant || type;
    const spriteMat = new THREE.SpriteMaterial({ map: getUnitTexture(spriteVariant, this.stats) });
    this.mesh = new THREE.Sprite(spriteMat);
    this.mesh.renderOrder = 0;
    this.mesh.position.copy(position);
    this.mesh.position.y = position.y + this.halfHeight;
    this.baseScaleX = Math.max(w, d) * 1.3;
    this.baseScaleY = h * 1.3;
    this.mesh.scale.set(this.baseScaleX, this.baseScaleY, 1);
    scene.add(this.mesh);

    // Health bar — a single sprite whose texture is a small canvas we draw
    // the track and the fill into ourselves, rather than two separately
    // positioned/scaled sprites (a dark background + a green foreground).
    // The two-sprite version was a real, reported bug: at sub-pixel world
    // scale the two sprites could visibly desync (z-fighting between two
    // near-coplanar quads, and the background sprite's own edges showing
    // as a stray dark rectangle whenever timing/scale made the two not
    // line up exactly) — "a free floating black bar" not attached to the
    // actual health reading. Baking both into one texture makes that
    // class of bug structurally impossible: the "remaining" portion is
    // background pixels behind the SAME draw call as the fill, so they
    // can never separate. Billboards automatically (it's a Sprite),
    // parented to the body so it inherits position for free.
    //
    // IMPORTANT: a child Object3D's local position/scale are transformed
    // by the PARENT's full matrixWorld (including its scale) when
    // computing the child's own matrixWorld — this is true for Sprites
    // too (the billboard trick only cancels rotation at render time, not
    // the scene-graph transform itself). The body sprite's scale is
    // non-uniform and unit-type-specific (`baseScaleX`/`baseScaleY`, from
    // each unit's `size` stat), so a naive child position/scale authored
    // in "world units" gets silently re-multiplied by that per-type
    // scale. Fixed by dividing every local position/scale value by the
    // body's own scale so the NET effect after the parent multiplies back
    // in is exactly the intended world-space bar size/offset, regardless
    // of which unit type (and therefore which baseScaleX/baseScaleY) it's
    // parented to.
    const barWidth = 1.4;
    const barHeight = h + 0.5;
    const invScaleX = 1 / this.baseScaleX;
    const invScaleY = 1 / this.baseScaleY;

    this.healthBarCanvas = document.createElement("canvas");
    this.healthBarCanvas.width = 96;
    this.healthBarCanvas.height = 14;
    this.healthBarCtx = this.healthBarCanvas.getContext("2d");
    this.healthBarTexture = new THREE.CanvasTexture(this.healthBarCanvas);

    const barMat = new THREE.SpriteMaterial({ map: this.healthBarTexture, transparent: true });
    this.healthBarSprite = new THREE.Sprite(barMat);
    this.healthBarSprite.renderOrder = 1;
    this.healthBarSprite.scale.set(barWidth * invScaleX, 0.2 * invScaleY, 1);
    this.healthBarSprite.position.set(0, barHeight * invScaleY, 0);

    this.mesh.add(this.healthBarSprite);
    this.barWidth = barWidth;
    this.invScaleX = invScaleX;
    this._refreshHealthBar();
  }

  get groundHeight() {
    return this.mesh.position.y - this.halfHeight;
  }

  // Shared by takeDamage and heal — both just move this.health and then
  // need the exact same track+fill redraw. Draws both into the SAME
  // canvas in one pass, so the "remaining" portion is guaranteed to be
  // exactly the background behind the fill, pixel for pixel — see the
  // constructor comment on why this replaced two separately-transformed
  // sprites.
  _refreshHealthBar() {
    const pct = Math.max(0, Math.min(1, this.health / this.stats.maxHealth));
    const ctx = this.healthBarCtx;
    const w = this.healthBarCanvas.width;
    const h = this.healthBarCanvas.height;
    const color = pct > 0.5 ? "#4caf50" : pct > 0.25 ? "#d5a83a" : "#d53a3a";

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, w, h);
    if (pct > 0) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, Math.round(w * pct), h);
    }
    this.healthBarTexture.needsUpdate = true;
  }

  // Returns true if this hit was the one that brought the unit to 0 health.
  takeDamage(amount) {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this._refreshHealthBar();
    if (this.health <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  // Lifesteal (see items.js's lifestealPercent) — heals this unit,
  // clamped at its own max HP, never revives a dead unit. Only ever
  // called from main.js's applyDamage, on the ATTACKER, for a fraction of
  // the damage it just actually dealt.
  heal(amount) {
    if (!this.alive || amount <= 0) return;
    this.health = Math.min(this.stats.maxHealth, this.health + amount);
    this._refreshHealthBar();
  }

  // Final damage this unit would deal to `target` right now — completely
  // unchanged from before. groundHeight now comes from a tile-level
  // lookup (set via terrain snapping in main.js) instead of continuous
  // terrain sampling, but this method doesn't know or care about that;
  // it just compares two Y positions, exactly as it always did. Crit
  // (see items.js's critChance) is rolled AFTER the elevation bonus and
  // BEFORE armor — a crit multiplies the same "raw" damage the elevation
  // bonus already scaled, then armor still reduces the final number
  // exactly as it always does, so a crit can't itself bypass armor.
  attackDamageAgainst(target) {
    const rolled = THREE.MathUtils.randFloat(this.stats.damageMin, this.stats.damageMax);
    const elevDiff = this.groundHeight - target.groundHeight;
    const bonus = elevDiff >= ELEVATION_ADVANTAGE_THRESHOLD ? ELEVATION_DAMAGE_BONUS : 1;
    let raw = rolled * bonus;
    if (this.stats.critChance && Math.random() < this.stats.critChance) {
      raw *= CRIT_DAMAGE_MULTIPLIER;
    }
    const armor = target.stats.armor || 0;
    return Math.max(1, raw - armor);
  }

  faceToward(otherUnit) {
    const dx = otherUnit.mesh.position.x - this.mesh.position.x;
    const dz = otherUnit.mesh.position.z - this.mesh.position.z;
    if (dx !== 0 || dz !== 0) this.facingAngle = Math.atan2(dx, dz);
  }

  // Horizontal (x/z) distance only — elevation is handled separately by the
  // damage bonus and elevation-block rules, not folded into range checks.
  distanceTo(otherUnit) {
    return Math.hypot(this.mesh.position.x - otherUnit.mesh.position.x, this.mesh.position.z - otherUnit.mesh.position.z);
  }

  // Moves in a given normalized 2D direction {x, y} (y meaning z here) for
  // this frame — main.js supplies the direction toward the current path
  // waypoint.
  stepInDirection(dir, delta) {
    if (dir.x === 0 && dir.y === 0) return;
    const slowMult = this.freezeTimer > 0 ? 1 - this.freezeSlowAmount : 1;
    this.mesh.position.x += dir.x * this.stats.speed * slowMult * delta;
    this.mesh.position.z += dir.y * this.stats.speed * slowMult * delta;
    this.facingAngle = Math.atan2(dir.x, dir.y);
  }

  // Direct, unsteered positional nudge — used for unit-unit separation only
  // (doesn't respect move speed since it's a physical correction, not travel).
  nudge(dx, dz) {
    this.mesh.position.x += dx;
    this.mesh.position.z += dz;
  }

  destroy(scene) {
    scene.remove(this.mesh);
  }
}
