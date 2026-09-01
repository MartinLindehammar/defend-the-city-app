// Meta-progression: the per-level population placement-budget, the
// persistent Gold economy (with interest — see below) used to buy
// permanent unit upgrades, and raider evolution (the attacker-side
// equivalent of upgrades — raiders get permanently stronger too, in a
// random stat, once per cleared level). Pure logic + localStorage
// persistence — no Three.js/DOM dependency, so it's directly unit-testable
// (test-progression.mjs) and swappable from main.js without touching any
// rendering code.

import { UNIT_STATS } from "./unit.js";
import { defaultBackpackState } from "./items.js";

// ---------- Population (per-level unit-placement budget) ----------
// Base is constant per level; on top of that, permanently-purchased
// population (see POPULATION_UPGRADE below) adds a flat bonus that applies
// to every future level. Written as a function (not a bare constant) so
// scaling the BASE by level later is still a one-line change here.
export const BASE_POPULATION = 12;
export const POPULATION_PER_PURCHASE = 1;
export function computePopulationBudget(_levelNumber, populationPurchases = 0) {
  return BASE_POPULATION + populationPurchases * POPULATION_PER_PURCHASE;
}

// Population purchases use the same escalating schedule as every stat
// upgrade below (see getUpgradeCost): 1st purchase 5g, 2nd 10g, 3rd 15g,
// ... Tracked separately from `purchases` (which is keyed by upgrade id)
// since this isn't a per-unit-type stat.
export const POPULATION_UPGRADE_BASE_COST = 5;
export const POPULATION_UPGRADE_COST_INCREMENT = 5;

export function getPopulationUpgradeCost(populationPurchases) {
  return POPULATION_UPGRADE_BASE_COST + POPULATION_UPGRADE_COST_INCREMENT * populationPurchases;
}

export function purchasePopulation(progress) {
  const cost = getPopulationUpgradeCost(progress.populationPurchases);
  if (progress.gold < cost) return { ok: false, reason: "insufficient gold" };
  progress.gold -= cost;
  progress.populationPurchases += 1;
  return { ok: true };
}

// ---------- Gold economy (persistent meta-currency, separate from
// population) ----------
// ---------- Gold economy (persistent meta-currency, separate from
// population) ----------
export const GOLD_PER_LEVEL_CLEAR = 10;

// Interest on whatever Gold is sitting unspent in the bank, applied once
// per cleared level, BEFORE the flat GOLD_PER_LEVEL_CLEAR reward is added
// (so the reward itself never earns interest the same level it's granted
// — only gold that was actually sitting there "unused between levels"
// does). `progress.gold` is kept as an exact float internally (interest
// compounds fractionally level over level); UI code is responsible for
// flooring it at every display point — this module never rounds, up or
// down, since rounding here would silently lose precision from the saved
// value itself rather than just how it's shown.
export const GOLD_INTEREST_RATE = 0.10;

export function applyGoldInterest(progress) {
  const interestEarned = progress.gold * GOLD_INTEREST_RATE;
  progress.gold += interestEarned;
  return interestEarned;
}

// Reward for clearing a level scales up +1g per level number, on top of
// the base — clearing level 1 gives GOLD_PER_LEVEL_CLEAR (10), level 2
// gives 11, level 3 gives 12, and so on. Linear, not compounding — a
// deliberately different growth shape from the interest above, so the
// two don't get confused with each other despite both being "gold gets
// added on a win."
export function computeGoldReward(levelNumber) {
  return GOLD_PER_LEVEL_CLEAR + (levelNumber - 1);
}

// ---------- Score ----------
// A separate running total from Gold — never spent, never reset except by
// a full progress reset. Sum of all defenders' REMAINING hp (however much
// they had left when the level ended, not their max) at the moment each
// level is cleared, added to whatever the running total already was —
// "compounding over levels" in the sense of an ever-growing cumulative
// total across a run, not percentage compounding the way gold interest
// is. Only main.js has access to live Unit health (progress.js has no
// Three.js/DOM dependency), so it's main.js's job to compute the
// remaining-HP sum and pass it in here; this function just does the
// (trivial, but worth keeping testable and consistent with everything
// else in this module) accumulation.
export function addScore(progress, remainingDefenderHp) {
  progress.score += remainingDefenderHp;
  return progress.score;
}

// ---------- City health ----------
// Replaces the old instant-loss-when-defenders-die behavior. Once every
// defender is dead, surviving raiders march on the city instead of
// standing idle (see main.js — this is a pathing/targeting change, not a
// damage-formula one, and lives entirely in main.js's combat loop as a
// small additive branch; nothing here needs to know HOW a raider gets to
// the city, only how much damage it deals once it's there).
//
// City health is stored as a percentage (0-100) and is PERSISTENT across
// the whole run — it never automatically regenerates between levels, only
// ever decreases. This is a deliberate design choice, not explicitly
// specified: it's what makes "instead of just binary win/lose round"
// mean something — a level where defenders are wiped now has a lasting
// consequence (city damage) rather than being reset back to a clean
// slate the moment a new level starts. The game ends when city health
// drops to (or below) CITY_GAME_OVER_THRESHOLD; above that threshold, a
// new level can always begin, regardless of how battered the city is.
export const CITY_MAX_HEALTH = 100;
export const CITY_DAMAGE_FRACTION_PER_FULL_WAVE = 0.80;
export const CITY_GAME_OVER_THRESHOLD = 0.1;

// Each raider that reaches the city (only possible once every defender is
// dead) deals damage proportional to how much HP it personally had left,
// as a fraction of the WHOLE WAVE's total HP budget (count x per-unit max
// HP for that level's wave type + evolution — the same "total wave HP"
// concept a Boss's own single HP is already built from). This is what
// makes the damage automatically type-adjusted with no per-type
// multiplier table needed: sum this formula across every raider in a
// wave, each at full health, and it always collapses to exactly
// CITY_DAMAGE_FRACTION_PER_FULL_WAVE x CITY_MAX_HEALTH — regardless of
// whether the wave was 20 Mass raiders, 4 Champions, or 1 Boss, because
// each raider's current HP is definitionally some fraction of that same
// total. A Boss (which by definition already holds the wave's entire HP
// budget in one unit) reaching the city at full health deals the full
// amount in a single hit, automatically, with no special-casing.
export function computeCityDamage(raiderCurrentHealth, totalWaveHealth) {
  if (totalWaveHealth <= 0) return 0;
  return (raiderCurrentHealth / totalWaveHealth) * CITY_DAMAGE_FRACTION_PER_FULL_WAVE * CITY_MAX_HEALTH;
}

// Mutates progress.cityHealth, clamped to [0, CITY_MAX_HEALTH] — damage
// can never push it negative, and (since it never auto-heals) it can
// never exceed the max either. Returns the new value for convenience.
export function applyCityDamage(progress, amount) {
  progress.cityHealth = Math.max(0, Math.min(CITY_MAX_HEALTH, progress.cityHealth - amount));
  return progress.cityHealth;
}

export function isCityDestroyed(progress) {
  return progress.cityHealth <= CITY_GAME_OVER_THRESHOLD;
}

// ---------- Raider evolution ----------
// The attacker-side mirror of defender upgrades: once per CLEARED level
// (never on a loss — see main.js's endBattle), exactly one raider stat is
// picked at random and permanently boosted 20%, compounding across
// however many times that particular stat gets picked over a run. This
// fully replaces the old level-number-driven difficulty-budget formula
// that used to scale raider count deterministically — that system is
// gone; raider strength now grows only through this random evolution
// mechanic, starting from RAIDER_STARTING_COUNT at the real, current
// UNIT_STATS.raider stats (no separate scaling baseline to keep in sync).
export const RAIDER_STARTING_COUNT = 10;
export const RAIDER_EVOLUTION_RATE = 0.20;
// Raider armor starts at 0 (see unit.js) — a strict "x *= 1.2" reading
// would make an armor-evolution pick a permanent no-op (0 stays 0 no
// matter how many times it compounds), silently wasting 1-in-5 evolution
// events. Armor evolves by a flat step instead, chosen to feel roughly
// comparable in impact to a 20% swing in the other stats rather than
// trying to force a percentage onto a zero base.
export const RAIDER_ARMOR_EVOLUTION_STEP = 1;
export const RAIDER_EVOLUTION_STATS = ["count", "maxHealth", "damage", "attackSpeed", "armor"];
export const RAIDER_EVOLUTION_LABELS = {
  count: "Numbers",
  maxHealth: "HP",
  damage: "Attack Damage",
  attackSpeed: "Attack Speed",
  armor: "Armor",
};

export function defaultRaiderEvolution() {
  return { count: 0, maxHealth: 0, damage: 0, attackSpeed: 0, armor: 0 };
}

// Weighted, not uniform — the difficulty increase is deliberately skewed:
// Numbers/HP/Damage are the "core" scaling stats and equally likely
// (25% each); Attack Speed less so (15%); Armor least likely (10%),
// since a raider evolution that's silently a no-op against a 0 base for
// most types (see RAIDER_ARMOR_EVOLUTION_STEP above) shouldn't come up
// as often as the stats that always meaningfully matter. Weights are
// keyed by the same names as RAIDER_EVOLUTION_STATS and must sum to 1 —
// tested explicitly, so a future retune that doesn't add up gets caught
// immediately rather than silently skewing the real distribution.
export const RAIDER_EVOLUTION_WEIGHTS = {
  count: 0.25,
  maxHealth: 0.25,
  damage: 0.25,
  attackSpeed: 0.15,
  armor: 0.10,
};

// Picks one of the 5 stats via a single weighted roll (cumulative
// thresholds, same pattern as pickRandomLevelType/pickRandomLevelSpec
// below), increments how many times it's been picked, and returns which
// one was picked (for the "Raiders gained 20% X!" announcement). `rng`
// defaults to Math.random but is injectable so tests can make this
// deterministic.
export function evolveRaiders(raiderEvolution, rng = Math.random) {
  const roll = rng();
  let cumulative = 0;
  let stat = RAIDER_EVOLUTION_STATS[RAIDER_EVOLUTION_STATS.length - 1];
  for (const key of RAIDER_EVOLUTION_STATS) {
    cumulative += RAIDER_EVOLUTION_WEIGHTS[key];
    if (roll < cumulative) {
      stat = key;
      break;
    }
  }
  raiderEvolution[stat] = (raiderEvolution[stat] || 0) + 1;
  return stat;
}

// Compounding growth: N picks of the same stat = (1 + RATE)^N, exactly
// mirroring how the old difficulty budget used to compound level-over-
// level, and how a raider "evolving" repeatedly in the same direction
// intuitively should stack.
function evolutionMultiplier(pickCount) {
  return Math.pow(1 + RAIDER_EVOLUTION_RATE, pickCount || 0);
}

export function getRaiderCount(raiderEvolution) {
  return Math.max(1, Math.round(RAIDER_STARTING_COUNT * evolutionMultiplier(raiderEvolution.count)));
}

// Returns a NEW stats object — never mutates the shared UNIT_STATS.raider
// template, same discipline as getUpgradedStats above.
export function getEvolvedRaiderStats(raiderEvolution) {
  const base = UNIT_STATS.raider;
  const stats = { ...base };
  stats.maxHealth = base.maxHealth * evolutionMultiplier(raiderEvolution.maxHealth);
  stats.damageMin = base.damageMin * evolutionMultiplier(raiderEvolution.damage);
  stats.damageMax = base.damageMax * evolutionMultiplier(raiderEvolution.damage);
  stats.attackSpeed = base.attackSpeed * evolutionMultiplier(raiderEvolution.attackSpeed);
  stats.armor = base.armor + RAIDER_ARMOR_EVOLUTION_STEP * (raiderEvolution.armor || 0);
  return stats;
}

// ---------- Level types + level specs (two independent axes) ----------
// A level used to be ONE choice out of five (Normal/Flying/Mass/Champions/
// Boss). Split into two INDEPENDENT layers, each applied on top of the
// evolved raider baseline above, so any type can combine with any spec —
// a Flying Boss, a Rush Mass wave, etc. This is the exact same "layer a
// second independent multiplier set on top of the evolved baseline"
// mechanism the single wave-type system already used (see the old
// getWaveStats), now applied twice instead of once. Reuses the "raider"
// archetype for every combination rather than inventing new UNIT_STATS
// entries — main.js still spawns plain `new Unit("raider", ...,
// statsOverride)`.
//
// TYPE controls the "shape" of the wave: how many raiders, and how
// tanky/hard-hitting/armored/large each one is (Mass = many weak fast
// units, Champions/Boss = few-to-one strong units). All multipliers below
// are the same placeholder-first-pass numbers as before this split — only
// the STRUCTURE changed, not the type-level tuning. `armorFlatBonus` stays
// ADDITIVE (not multiplicative) for the same reason as before: base raider
// armor is 0, and multiplying zero is always zero.
export const LEVEL_TYPE_KEYS = ["normal", "mass", "champions", "boss"];

export const LEVEL_TYPES = {
  normal: {
    label: "Normal",
    countMultiplier: 1,
    hpMultiplier: 1,
    damageMultiplier: 1,
    speedMultiplier: 1,
    armorFlatBonus: 0,
    sizeMultiplier: 1,
    color: 0xb03a3a,
  },
  mass: {
    label: "Mass",
    countMultiplier: 2,
    hpMultiplier: 0.4, // -60%
    damageMultiplier: 0.4, // -60%
    speedMultiplier: 1.2, // +20%
    armorFlatBonus: 0,
    sizeMultiplier: 0.7,
    color: 0xd97a7a,
  },
  champions: {
    label: "Champions",
    countMultiplier: 0.2, // /5
    hpMultiplier: 4,
    damageMultiplier: 4,
    speedMultiplier: 0.8, // -20%
    armorFlatBonus: 3, // stands in for "50% armor" against a 0 base — see note above
    sizeMultiplier: 1.3,
    color: 0xd4af37,
  },
  boss: {
    label: "Boss",
    countMultiplier: null, // special-cased to exactly 1, see getWaveStats
    hpMultiplier: null, // special-cased to "sum of the wave's total HP", see getWaveStats
    damageMultiplier: 8, // 8x a normal raider's damage, per spec
    speedMultiplier: 0.6, // -40%
    armorFlatBonus: 4, // stands in for "2x armor" against a 0 base — see note above
    sizeMultiplier: 1.8,
    color: 0x4a1a4a,
  },
};

// SPEC controls a special ABILITY layered on top of whatever type is
// active, independent of how many/how strong the raiders are. `flying`
// used to be a whole wave TYPE (with its own countMultiplier that halved
// the wave's count) — now that it's a spec, it deliberately carries NO
// countMultiplier at all: count is entirely the TYPE's decision, per
// spec ("No affect on number, this is set by type"). `evasionChance`,
// `pierceRes`, and `rushToCity` are new raider-side flags consumed
// directly by main.js's combat loop (applyDamage for the first two,
// updateBattle's target-acquisition for the third) — see there for the
// actual mechanics, since none of those three behaviors are expressible
// as a stat multiplier the way HP/speed/attack-speed are.
export const LEVEL_SPEC_KEYS = ["none", "flying", "evasion", "pierceRes", "rush"];

export const LEVEL_SPECS = {
  none: {
    label: "None",
    hpMultiplier: 1,
    speedMultiplier: 1,
    attackSpeedMultiplier: 1,
    flying: false,
    evasionChance: 0,
    pierceRes: false,
    rushToCity: false,
    color: null, // no tint — see blendSpecColor
  },
  flying: {
    label: "Flying",
    hpMultiplier: 0.6, // -40%
    speedMultiplier: 1.10, // +10%
    attackSpeedMultiplier: 1,
    flying: true, // immune to melee, ignores cliff/terrain blocking, ranged — see main.js
    evasionChance: 0,
    pierceRes: false,
    rushToCity: false,
    color: 0x8fd3f4,
  },
  evasion: {
    label: "Evasion",
    hpMultiplier: 0.75, // -25%
    speedMultiplier: 1,
    attackSpeedMultiplier: 1,
    flying: false,
    evasionChance: 0.20, // 20% chance any incoming hit deals 0 damage — see applyDamage
    pierceRes: false,
    rushToCity: false,
    color: 0x7ed957,
  },
  pierceRes: {
    label: "Pierce Resistance",
    hpMultiplier: 1,
    speedMultiplier: 1,
    attackSpeedMultiplier: 0.75, // -25%
    flying: false,
    evasionChance: 0,
    pierceRes: true, // takes 0 damage from Archer attacks specifically — see applyDamage
    rushToCity: false,
    color: 0x8a5a2a,
  },
  rush: {
    label: "Rush",
    hpMultiplier: 0.7, // -30%
    speedMultiplier: 1,
    attackSpeedMultiplier: 1,
    flying: false,
    evasionChance: 0,
    pierceRes: false,
    rushToCity: true, // beelines straight for the city, ignores defenders entirely — see main.js
    color: 0xff6b3a,
  },
};

// First level is always Normal TYPE (handled by ensureLevelSchedule, not
// here); every level after that draws from this distribution. Kept as a
// named weights map (rather than one "normal probability" constant, like
// the old single-axis system had) so a future retune is just editing
// numbers here — still must sum to 1, verified by a dedicated test.
export const LEVEL_TYPE_WEIGHTS = {
  normal: 0.4,
  mass: 0.2,
  champions: 0.2,
  boss: 0.2,
};

export function pickRandomLevelType(rng = Math.random) {
  const roll = rng();
  let cumulative = 0;
  for (const key of LEVEL_TYPE_KEYS) {
    cumulative += LEVEL_TYPE_WEIGHTS[key];
    if (roll < cumulative) return key;
  }
  return LEVEL_TYPE_KEYS[LEVEL_TYPE_KEYS.length - 1];
}

// The first 5 levels are always spec "none" (handled by ensureLevelSchedule,
// not here) — every level after that draws from this distribution.
export const LEVEL_SPEC_WEIGHTS = {
  none: 0.4,
  flying: 0.15,
  evasion: 0.15,
  pierceRes: 0.15,
  rush: 0.15,
};

export const LEVEL_SPEC_NONE_UNTIL_LEVEL = 5;

export function pickRandomLevelSpec(rng = Math.random) {
  const roll = rng();
  let cumulative = 0;
  for (const key of LEVEL_SPEC_KEYS) {
    cumulative += LEVEL_SPEC_WEIGHTS[key];
    if (roll < cumulative) return key;
  }
  return LEVEL_SPEC_KEYS[LEVEL_SPEC_KEYS.length - 1];
}

// Blends a spec's accent color into a type's base color (a spec with no
// color, i.e. "none", leaves the type's color completely untouched) — a
// cheap way to make e.g. a Flying Boss visually read as "a Boss, but
// tinted toward Flying's blue" rather than being indistinguishable from a
// plain Boss until you open the stats panel. Placeholder-tier, same as
// every other color in this file — ready to be replaced by real per-
// combination sprite art later.
const SPEC_COLOR_BLEND_WEIGHT = 0.35;
function blendSpecColor(baseColor, specColor) {
  if (specColor == null) return baseColor;
  const br = (baseColor >> 16) & 0xff, bg = (baseColor >> 8) & 0xff, bb = baseColor & 0xff;
  const sr = (specColor >> 16) & 0xff, sg = (specColor >> 8) & 0xff, sb = specColor & 0xff;
  const r = Math.round(br * (1 - SPEC_COLOR_BLEND_WEIGHT) + sr * SPEC_COLOR_BLEND_WEIGHT);
  const g = Math.round(bg * (1 - SPEC_COLOR_BLEND_WEIGHT) + sg * SPEC_COLOR_BLEND_WEIGHT);
  const b = Math.round(bb * (1 - SPEC_COLOR_BLEND_WEIGHT) + sb * SPEC_COLOR_BLEND_WEIGHT);
  return (r << 16) | (g << 8) | b;
}

// Combines the evolved (compounding, persistent) baseline with BOTH this
// level's type multipliers AND its spec multipliers into the final
// {count, stats} actually used to generate and spawn this level's
// raiders. Type and spec are independent, multiplicative layers on top of
// the evolved baseline (each internally as documented on LEVEL_TYPES/
// LEVEL_SPECS above) — never mutates UNIT_STATS.raider or the
// evolved-stats object either layer starts from.
export function getWaveStats(levelType, levelSpec, raiderEvolution) {
  const typeDef = LEVEL_TYPES[levelType] || LEVEL_TYPES.normal;
  const specDef = LEVEL_SPECS[levelSpec] || LEVEL_SPECS.none;
  const evolvedStats = getEvolvedRaiderStats(raiderEvolution);
  const evolvedCount = getRaiderCount(raiderEvolution);

  let count;
  let maxHealth;
  if (typeDef.hpMultiplier === null) {
    // Boss: one unit carrying the sum of what the whole wave's total HP
    // budget would otherwise have been — scales with evolution exactly
    // like every other type does, just concentrated into a single target
    // instead of spread across many. The spec's HP multiplier (e.g. a
    // Flying Boss's -40%) still applies on top of that budget.
    count = 1;
    maxHealth = evolvedCount * evolvedStats.maxHealth * specDef.hpMultiplier;
  } else {
    count = Math.max(1, Math.round(evolvedCount * typeDef.countMultiplier));
    maxHealth = evolvedStats.maxHealth * typeDef.hpMultiplier * specDef.hpMultiplier;
  }

  const stats = {
    ...evolvedStats,
    maxHealth,
    damageMin: evolvedStats.damageMin * typeDef.damageMultiplier,
    damageMax: evolvedStats.damageMax * typeDef.damageMultiplier,
    attackSpeed: evolvedStats.attackSpeed * specDef.attackSpeedMultiplier,
    speed: evolvedStats.speed * typeDef.speedMultiplier * specDef.speedMultiplier,
    armor: evolvedStats.armor + typeDef.armorFlatBonus,
    flying: specDef.flying,
    // Flying implies ranged (it attacks from range, per spec) — every
    // other spec inherits the base raider's ranged:false unchanged.
    ranged: specDef.flying ? true : evolvedStats.ranged,
    evasionChance: specDef.evasionChance,
    pierceRes: specDef.pierceRes,
    rushToCity: specDef.rushToCity,
    // Size stays TYPE-only (specs don't resize a raider) — melee-slot ring
    // sizing (main.js's meleeAttackerRadiusEstimate) depends on this.
    size: evolvedStats.size.map((v) => v * typeDef.sizeMultiplier),
    color: blendSpecColor(typeDef.color, specDef.color),
    spriteVariant: `raider-${levelType}-${levelSpec}`,
  };
  return { count, stats };
}

// ---------- Level type + spec schedule ----------
// Levels are NOT rolled the moment they start — the whole point is that
// they're predetermined far enough in advance for the player to see them
// coming and prepare (e.g. bring extra Archers for an upcoming Flying
// level). `progress.levelTypeSchedule` / `progress.levelSpecSchedule` are
// simple append-only, parallel arrays (index 0 = level 1's type/spec,
// index 1 = level 2's, ...) that only ever grow, never get regenerated or
// overwritten — once a level's type/spec is committed, it's permanent for
// that save. Two independent arrays (rather than one array of {type,spec}
// pairs) since the two axes have genuinely different "always X for the
// first N levels" rules (type: only level 1; spec: the first 5 levels)
// and independent probability tables — keeping them as separate arrays
// means each axis's generation logic only has to know about itself.
export const LEVEL_TYPE_LOOKAHEAD = 5;

// Extends BOTH schedules (if needed) so they cover at least `throughLevel`.
// Level 1's type is hardcoded "normal"; levels 1 through
// LEVEL_SPEC_NONE_UNTIL_LEVEL's spec is hardcoded "none" — neither is ever
// randomized. Idempotent: calling this again with the same or a smaller
// throughLevel does nothing further. Returns true if any new entries were
// generated in EITHER schedule (so callers know whether they need to
// persist the change — see main.js).
export function ensureLevelSchedule(progress, throughLevel, rng = Math.random) {
  if (!progress.levelTypeSchedule) progress.levelTypeSchedule = [];
  if (!progress.levelSpecSchedule) progress.levelSpecSchedule = [];
  let changed = false;

  if (progress.levelTypeSchedule.length === 0) {
    progress.levelTypeSchedule.push("normal");
    changed = true;
  }
  while (progress.levelTypeSchedule.length < throughLevel) {
    progress.levelTypeSchedule.push(pickRandomLevelType(rng));
    changed = true;
  }

  while (progress.levelSpecSchedule.length < throughLevel) {
    const levelNumber = progress.levelSpecSchedule.length + 1;
    progress.levelSpecSchedule.push(levelNumber <= LEVEL_SPEC_NONE_UNTIL_LEVEL ? "none" : pickRandomLevelSpec(rng));
    changed = true;
  }

  return changed;
}

export function getLevelType(progress, levelNumber) {
  ensureLevelSchedule(progress, levelNumber);
  return progress.levelTypeSchedule[levelNumber - 1];
}

export function getLevelSpec(progress, levelNumber) {
  ensureLevelSchedule(progress, levelNumber);
  return progress.levelSpecSchedule[levelNumber - 1];
}

// ---------- Upgrades ----------
// Each upgrade permanently improves one stat on one defender unit type.
// `amount` is added per purchase (repeatable, stacks additively — see
// getUpgradedStats for the one deliberate exception: attack speed, where
// `amount` is a FRACTION of base applied multiplicatively, not a flat
// number, since attackSpeed is itself a rate — see the comment there).
//
// `cost` is the price of the FIRST purchase; `costIncrement` is added per
// purchase already made, so purchase N (1-indexed) costs
// `cost + costIncrement * (N-1)`. Every upgrade — HP, damage, attack
// speed, armor, range, and population (see above) — uses the same 5g
// base / +5g-per-purchase schedule (5, 10, 15, 20, ...) uniformly.
//
// Deliberately no `knightRange` entry: Knights fight in melee and their
// range is an engagement-distance constant, not a strategic dial the way
// an archer's is — see the "Melee" label handling in main.js's stats
// panel, which is purely a DISPLAY choice and never touches the
// underlying numeric range Knights use in combat.
//
// `label` is a plain stat name only (no unit-name prefix or flavor word —
// "Vitality"/"Sharpening"/"Swiftness"/"Frostbite" were dropped) since
// main.js's upgrade-matrix UI already puts the unit type in the column
// header; repeating it per-row would just be noise. `label` itself isn't
// currently read by that matrix (which sources its row labels from its
// own SHOP_MATRIX_ROWS table, to guarantee one consistent label per stat
// across all three unit columns) — kept here anyway as the canonical
// human-readable name for this upgrade, for any other caller that wants one.
export const UPGRADES = {
  knightHp: { label: "Health", unitType: "knight", stat: "health", amount: 10, cost: 5, costIncrement: 5 },
  knightDmg: { label: "Damage", unitType: "knight", stat: "damage", amount: 3, cost: 5, costIncrement: 5 },
  knightAtkSpd: { label: "Attack Speed", unitType: "knight", stat: "attackSpeedPercent", amount: 0.10, cost: 5, costIncrement: 5 },
  knightArmor: { label: "Armor", unitType: "knight", stat: "armor", amount: 1, cost: 5, costIncrement: 5 },

  archerHp: { label: "Health", unitType: "archer", stat: "health", amount: 10, cost: 5, costIncrement: 5 },
  archerDmg: { label: "Damage", unitType: "archer", stat: "damage", amount: 2, cost: 5, costIncrement: 5 },
  archerAtkSpd: { label: "Attack Speed", unitType: "archer", stat: "attackSpeedPercent", amount: 0.10, cost: 5, costIncrement: 5 },
  archerArmor: { label: "Armor", unitType: "archer", stat: "armor", amount: 1, cost: 5, costIncrement: 5 },
  archerRange: { label: "Range", unitType: "archer", stat: "range", amount: 1, cost: 5, costIncrement: 5 },

  mageHp: { label: "Health", unitType: "mage", stat: "health", amount: 6, cost: 5, costIncrement: 5 },
  mageDmg: { label: "Damage", unitType: "mage", stat: "damage", amount: 4, cost: 5, costIncrement: 5 },
  mageAtkSpd: { label: "Attack Speed", unitType: "mage", stat: "attackSpeedPercent", amount: 0.10, cost: 5, costIncrement: 5 },
  mageArmor: { label: "Armor", unitType: "mage", stat: "armor", amount: 1, cost: 5, costIncrement: 5 },
  mageRange: { label: "Range", unitType: "mage", stat: "range", amount: 1, cost: 5, costIncrement: 5 },
  // Upgrades the Mage's freeze-on-hit slow by +5 percentage points per
  // purchase (10% -> 15% -> 20% ...) — see getUpgradedStats' "freezeSlowPercent"
  // branch below, the one stat that isn't a flat number on the base object
  // itself but on the nested `freeze` object instead.
  mageFreeze: { label: "Freeze", unitType: "mage", stat: "freezeSlowPercent", amount: 0.05, cost: 5, costIncrement: 5 },
};

// Applies all purchased upgrade levels on top of a unit type's base
// UNIT_STATS, returning a NEW stats object — never mutates the shared
// UNIT_STATS template, since other code (melee-slot ring sizing, the
// generator, tests) reads UNIT_STATS directly and must keep seeing base
// values regardless of what's been purchased.
export function getUpgradedStats(unitType, purchases) {
  const base = UNIT_STATS[unitType];
  const stats = { ...base };
  for (const key in UPGRADES) {
    const upg = UPGRADES[key];
    if (upg.unitType !== unitType) continue;
    const count = (purchases && purchases[key]) || 0;
    if (count === 0) continue;
    if (upg.stat === "health") {
      stats.maxHealth = base.maxHealth + upg.amount * count;
    } else if (upg.stat === "damage") {
      stats.damageMin = base.damageMin + upg.amount * count;
      stats.damageMax = base.damageMax + upg.amount * count;
    } else if (upg.stat === "armor") {
      stats.armor = base.armor + upg.amount * count;
    } else if (upg.stat === "range") {
      stats.range = base.range + upg.amount * count;
    } else if (upg.stat === "attackSpeedPercent") {
      // attackSpeed is a RATE (hits/sec — see unit.js), and main.js's
      // combat loop derives the actual attack cooldown as
      // `1 / stats.attackSpeed`. Because of that, "+10% attack speed"
      // means the rate itself goes up by 10% of base — a direct
      // multiplicative bonus on the rate — NOT a 10% reduction applied to
      // some separately-tracked cooldown field (there isn't one; the
      // cooldown is always derived fresh from whatever attackSpeed is at
      // the moment, so bumping the rate is automatically correct and
      // needs no separate inversion anywhere else in the codebase).
      // Purchases stack additively on the PERCENTAGE (10%, 20%, 30%...),
      // matching every other upgrade's flat-additive-per-purchase design,
      // rather than compounding multiplicatively purchase-over-purchase.
      stats.attackSpeed = base.attackSpeed * (1 + upg.amount * count);
    } else if (upg.stat === "freezeSlowPercent") {
      // Nested object, not a flat field — spread a NEW object rather than
      // mutating base.freeze in place, since `stats` starts as a shallow
      // copy of `base` and would otherwise still point at the exact same
      // freeze object UNIT_STATS.mage itself uses.
      stats.freeze = { ...base.freeze, slowPercent: base.freeze.slowPercent + upg.amount * count };
    }
  }
  return stats;
}

// Total bonus currently purchased for one upgrade, for display purposes.
// Returns a raw number — a flat amount for HP/damage/armor/range, or a
// FRACTION (e.g. 0.3 for three attack-speed purchases) for the percent-
// based upgrade; callers format the percent case for display (see
// main.js's formatUpgradeAmount/formatUpgradeBonus).
export function getUpgradeBonus(upgradeKey, purchases) {
  const upg = UPGRADES[upgradeKey];
  const count = (purchases && purchases[upgradeKey]) || 0;
  return upg.amount * count;
}

// Cost of the NEXT purchase of this upgrade, given how many have already
// been bought — cost + costIncrement * count, so with cost=5,
// costIncrement=5 this produces 5, 10, 15, 20... exactly the schedule
// requested (flat-cost upgrades simply have costIncrement=0).
export function getUpgradeCost(upgradeKey, purchases) {
  const upg = UPGRADES[upgradeKey];
  const count = (purchases && purchases[upgradeKey]) || 0;
  return upg.cost + (upg.costIncrement || 0) * count;
}

export function purchaseUpgrade(progress, upgradeKey) {
  const upg = UPGRADES[upgradeKey];
  if (!upg) return { ok: false, reason: "unknown upgrade" };
  const cost = getUpgradeCost(upgradeKey, progress.purchases);
  if (progress.gold < cost) return { ok: false, reason: "insufficient gold" };
  progress.gold -= cost;
  progress.purchases[upgradeKey] = (progress.purchases[upgradeKey] || 0) + 1;
  return { ok: true };
}

// ---------- Persistence ----------
// Single-slot save in localStorage. Uses the real global `localStorage`
// (present in every browser) rather than an injected storage backend, so
// call sites in main.js stay simple; test-progression.mjs supplies an
// in-memory localStorage polyfill before importing this module so the same
// real code path is exercised under Node, not a mocked-out alternative.
const STORAGE_KEY = "defend-the-city-progress-v1";
// The key this save used to live under, before the project was renamed to
// Defend The City. Read-only fallback: loadProgress falls back to it when
// the current key is empty, so anyone who played the game under its old
// name keeps their run. Nothing ever WRITES here again — the first save
// after a migrated load lands under STORAGE_KEY, and resetProgress clears
// both so a reset can't be silently undone by a stale legacy save.
const LEGACY_STORAGE_KEY = "city-defense-progress-v1";

export function defaultProgress() {
  return {
    level: 1,
    gold: 0,
    score: 0,
    cityHealth: CITY_MAX_HEALTH,
    populationPurchases: 0,
    purchases: {
      knightHp: 0,
      knightDmg: 0,
      knightAtkSpd: 0,
      knightArmor: 0,
      archerHp: 0,
      archerDmg: 0,
      archerAtkSpd: 0,
      archerArmor: 0,
      archerRange: 0,
      mageHp: 0,
      mageDmg: 0,
      mageAtkSpd: 0,
      mageArmor: 0,
      mageFreeze: 0,
    },
    raiderEvolution: defaultRaiderEvolution(),
    levelTypeSchedule: [],
    levelSpecSchedule: [],
    ...defaultBackpackState(),
  };
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return defaultProgress();
    const parsed = JSON.parse(raw);
    // Merge over defaults so a save from an earlier version of this system
    // (e.g. missing a since-added upgrade key) can't crash anything
    // downstream that expects every key to be present.
    const defaults = defaultProgress();
    const merged = {
      ...defaults,
      ...parsed,
      purchases: { ...defaults.purchases, ...(parsed.purchases || {}) },
      raiderEvolution: { ...defaults.raiderEvolution, ...(parsed.raiderEvolution || {}) },
    };
    // Migration: a save from before the type/spec split stores its level
    // schedule as ONE combined axis, so it can contain "flying" as a
    // TYPE value — which no longer exists in LEVEL_TYPE_KEYS now that
    // Flying is a spec, not a type. Reading that stale value back as a
    // "type" would break getWaveStats (falls back to normal silently, but
    // that's not what was actually committed). Rather than try to migrate
    // each entry individually, wipe BOTH schedules so they regenerate
    // cleanly under the new two-axis system on next access — nothing else
    // about the save (gold, upgrades, raiderEvolution, backpack) is
    // affected, only which levels are shown as "upcoming."
    const hasLegacyTypeValue = merged.levelTypeSchedule.some((t) => !LEVEL_TYPE_KEYS.includes(t));
    if (hasLegacyTypeValue) {
      merged.levelTypeSchedule = [];
      merged.levelSpecSchedule = [];
    }
    return merged;
  } catch (err) {
    console.warn("Couldn't read saved progress, starting fresh.", err);
    return defaultProgress();
  }
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (err) {
    console.warn("Couldn't save progress.", err);
  }
}

export function resetProgress() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (err) {
    console.warn("Couldn't clear saved progress.", err);
  }
}
