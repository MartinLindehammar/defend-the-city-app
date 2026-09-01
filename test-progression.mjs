// Tests for src/progression.js — gold interest, raider evolution, upgrade
// math, and localStorage persistence. A minimal in-memory localStorage
// polyfill is installed BEFORE importing the module under test, so
// loadProgress/saveProgress/resetProgress run their real code path (not a
// mocked-out alternative) while under Node.

globalThis.localStorage = {
  _data: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : null;
  },
  setItem(key, value) {
    this._data[key] = String(value);
  },
  removeItem(key) {
    delete this._data[key];
  },
};

const {
  BASE_POPULATION,
  POPULATION_PER_PURCHASE,
  computePopulationBudget,
  POPULATION_UPGRADE_BASE_COST,
  POPULATION_UPGRADE_COST_INCREMENT,
  getPopulationUpgradeCost,
  purchasePopulation,
  GOLD_PER_LEVEL_CLEAR,
  GOLD_INTEREST_RATE,
  applyGoldInterest,
  computeGoldReward,
  addScore,
  CITY_MAX_HEALTH,
  CITY_DAMAGE_FRACTION_PER_FULL_WAVE,
  CITY_GAME_OVER_THRESHOLD,
  computeCityDamage,
  applyCityDamage,
  isCityDestroyed,
  RAIDER_STARTING_COUNT,
  RAIDER_EVOLUTION_RATE,
  RAIDER_ARMOR_EVOLUTION_STEP,
  RAIDER_EVOLUTION_STATS,
  RAIDER_EVOLUTION_WEIGHTS,
  defaultRaiderEvolution,
  evolveRaiders,
  getRaiderCount,
  getEvolvedRaiderStats,
  LEVEL_TYPE_KEYS,
  LEVEL_TYPES,
  LEVEL_SPEC_KEYS,
  LEVEL_SPECS,
  LEVEL_TYPE_WEIGHTS,
  LEVEL_SPEC_WEIGHTS,
  LEVEL_SPEC_NONE_UNTIL_LEVEL,
  pickRandomLevelType,
  pickRandomLevelSpec,
  getWaveStats,
  LEVEL_TYPE_LOOKAHEAD,
  ensureLevelSchedule,
  getLevelType,
  getLevelSpec,
  UPGRADES,
  getUpgradedStats,
  getUpgradeBonus,
  getUpgradeCost,
  purchaseUpgrade,
  defaultProgress,
  loadProgress,
  saveProgress,
  resetProgress,
} = await import("./src/progression.js");

const { UNIT_STATS } = await import("./src/unit.js");

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`OK: ${label}`);
  } else {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}
function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// ---------- Gold interest ----------
check("interest rate is the documented 10%", GOLD_INTEREST_RATE === 0.1);
{
  const progress = defaultProgress();
  progress.gold = 100;
  const earned = applyGoldInterest(progress);
  check("interest earned on 100 gold is exactly 10", earned === 10);
  check("gold after interest is exactly 110 (not rounded)", progress.gold === 110);

  const zero = defaultProgress();
  const earnedOnZero = applyGoldInterest(zero);
  check("interest on 0 gold is 0, no crash", earnedOnZero === 0 && zero.gold === 0);

  // Compounding across multiple level clears — the SECOND call must earn
  // interest on the NEW balance (110), not the original (100), matching
  // "if unused between levels" applying fresh each time.
  const second = applyGoldInterest(progress);
  check("second interest application compounds on the new balance (110 * 0.1 = 11)", second === 11 && progress.gold === 121);

  // Fractional/non-round balances must stay EXACT internally — this is
  // the whole point of "keep an exact number, only floor for display".
  const fractional = defaultProgress();
  fractional.gold = 33;
  applyGoldInterest(fractional); // 33 * 1.1 = 36.3
  check("interest can produce a non-integer exact balance (36.3)", approxEqual(fractional.gold, 36.3));
  check("that exact balance is NOT silently rounded by applyGoldInterest itself", fractional.gold !== Math.floor(fractional.gold));
}

// ---------- Gold reward (grows +1g per level cleared) ----------
{
  check("clearing level 1 gives the base 10g", computeGoldReward(1) === 10);
  check("clearing level 2 gives 11g", computeGoldReward(2) === 11);
  check("clearing level 3 gives 12g", computeGoldReward(3) === 12);
  check("clearing level 10 gives 19g (linear, not compounding)", computeGoldReward(10) === 19);
}

// ---------- Score ----------
{
  const progress = defaultProgress();
  check("score starts at 0", progress.score === 0);
  const afterFirst = addScore(progress, 250);
  check("addScore adds the given amount", progress.score === 250 && afterFirst === 250);
  const afterSecond = addScore(progress, 180);
  check("addScore accumulates across levels rather than replacing", progress.score === 430 && afterSecond === 430);
  addScore(progress, 0);
  check("adding 0 (e.g. a level cleared with no defenders left standing) doesn't change the total", progress.score === 430);
}

// ---------- City health ----------
check("city max health is 100 (a percentage)", CITY_MAX_HEALTH === 100);
check("a full unopposed wave is calibrated to deal 80%", CITY_DAMAGE_FRACTION_PER_FULL_WAVE === 0.80);
check("game over threshold is the documented 0.1%", CITY_GAME_OVER_THRESHOLD === 0.1);

{
  const progress = defaultProgress();
  check("city starts at full health (100)", progress.cityHealth === 100);

  // The core calibration: a single raider representing the WHOLE wave's
  // HP budget (i.e. totalWaveHealth == its own current health — exactly
  // the Boss case, "a boss holds all this damage") deals precisely 80.
  check("a raider at full HP representing the entire wave budget deals exactly 80 (the Boss case)", computeCityDamage(100, 100) === 80);
  check("a raider at half its own max HP (but still 'the whole wave') deals exactly 40 — proportional to current HP, not max", computeCityDamage(50, 100) === 40);
  check("a raider at 25% HP deals exactly 20", computeCityDamage(25, 100) === 20);
  check("a raider that reached the city at 0 HP (shouldn't really happen, but must not crash or go negative) deals 0", computeCityDamage(0, 100) === 0);

  // The type-adjustment-for-free property: summing every raider in a
  // wave, each at full health, must total exactly 80 regardless of how
  // many raiders or what their individual max HP is — this is the actual
  // point of the proportional-to-total-wave-HP design (no per-type
  // multiplier table needed).
  {
    const perUnitHp = 32;
    const count = 10;
    const totalWaveHealth = perUnitHp * count; // 320 - what the wave "would have been" at full strength
    let totalDamage = 0;
    for (let i = 0; i < count; i++) totalDamage += computeCityDamage(perUnitHp, totalWaveHealth);
    check("10 Normal-shaped raiders, each at full HP, sum to exactly 80% (type-adjustment falls out of the math)", approxEqual(totalDamage, 80));
  }
  {
    // Champions: fewer, tankier raiders — different count and per-unit
    // HP, but the SAME formula, and it should STILL sum to exactly 80.
    const perUnitHp = 128;
    const count = 2;
    const totalWaveHealth = perUnitHp * count; // 256
    let totalDamage = 0;
    for (let i = 0; i < count; i++) totalDamage += computeCityDamage(perUnitHp, totalWaveHealth);
    check("2 Champion-shaped raiders (different count/HP entirely), each at full HP, ALSO sum to exactly 80%", approxEqual(totalDamage, 80));
  }
  {
    // Boss: count=1, HP IS the whole wave's total budget by definition.
    const totalWaveHealth = 320;
    const bossDamage = computeCityDamage(totalWaveHealth, totalWaveHealth);
    check("a Boss (1 unit holding the whole wave's HP budget) at full health deals the full 80% in one hit", approxEqual(bossDamage, 80));
  }
  {
    // A wave where defenders chipped everyone down before dying — total
    // damage to the city should be correspondingly less than 80%.
    const perUnitHp = 32;
    const count = 10;
    const totalWaveHealth = perUnitHp * count;
    // Half the raiders already died in combat (0 contribution), the
    // other half reach the city at only 25% of their own max HP.
    let totalDamage = 0;
    for (let i = 0; i < count / 2; i++) totalDamage += computeCityDamage(perUnitHp * 0.25, totalWaveHealth);
    check("a wave heavily chipped down by defenders before dying deals much less than 80% (here, 10%)", approxEqual(totalDamage, 10));
  }

  // applyCityDamage — clamping in both directions.
  const p2 = defaultProgress();
  const afterHit = applyCityDamage(p2, 30);
  check("applyCityDamage subtracts and returns the new value", p2.cityHealth === 70 && afterHit === 70);
  applyCityDamage(p2, 1000);
  check("applyCityDamage clamps at 0, never negative, even from a huge hit", p2.cityHealth === 0);
  const p3 = defaultProgress();
  applyCityDamage(p3, -50); // a hypothetical negative "damage" must not heal past max
  check("applyCityDamage clamps at CITY_MAX_HEALTH, can't exceed max even from a negative amount", p3.cityHealth === 100);

  // isCityDestroyed — boundary behavior at the documented threshold.
  const alive = defaultProgress();
  alive.cityHealth = 0.2;
  check("above the game-over threshold: not destroyed", isCityDestroyed(alive) === false);
  const exactlyAtThreshold = defaultProgress();
  exactlyAtThreshold.cityHealth = 0.1;
  check("exactly AT the threshold counts as destroyed ('more than 0.1%' is required to continue)", isCityDestroyed(exactlyAtThreshold) === true);
  const dead = defaultProgress();
  dead.cityHealth = 0;
  check("0 health is destroyed", isCityDestroyed(dead) === true);
}

// ---------- Raider evolution ----------
check("raider starting count is 10 as specified", RAIDER_STARTING_COUNT === 10);
check("raider evolution rate is the documented 20%", RAIDER_EVOLUTION_RATE === 0.2);
check("all 5 requested stats are evolvable", RAIDER_EVOLUTION_STATS.length === 5 && ["count", "maxHealth", "damage", "attackSpeed", "armor"].every((s) => RAIDER_EVOLUTION_STATS.includes(s)));

// Weighted distribution: Numbers/HP/Damage 25% each, Attack Speed 15%,
// Armor 10% — must sum to exactly 1, and every named stat needs a weight
// (a future stat added to RAIDER_EVOLUTION_STATS without a matching
// weight would silently fall through to whatever key happens to be last
// in evolveRaiders' loop, so both directions are checked).
check("evolution weights sum to exactly 1 (100%)", approxEqual(Object.values(RAIDER_EVOLUTION_WEIGHTS).reduce((s, v) => s + v, 0), 1));
check("every evolvable stat has a weight assigned", RAIDER_EVOLUTION_STATS.every((s) => typeof RAIDER_EVOLUTION_WEIGHTS[s] === "number"));
check("numbers/HP/damage are equally weighted at 25% each, as specified", RAIDER_EVOLUTION_WEIGHTS.count === 0.25 && RAIDER_EVOLUTION_WEIGHTS.maxHealth === 0.25 && RAIDER_EVOLUTION_WEIGHTS.damage === 0.25);
check("attack speed is weighted at 15%, as specified", RAIDER_EVOLUTION_WEIGHTS.attackSpeed === 0.15);
check("armor is weighted at 10% (the least likely), as specified", RAIDER_EVOLUTION_WEIGHTS.armor === 0.10);

{
  const zeroEvo = defaultRaiderEvolution();
  check("0 evolutions: raider count is exactly the starting 10", getRaiderCount(zeroEvo) === 10);
  const evolvedCount = { ...defaultRaiderEvolution(), count: 1 };
  check("1 count evolution: round(10 * 1.2) = 12", getRaiderCount(evolvedCount) === 12);
  const evolvedCount3 = { ...defaultRaiderEvolution(), count: 3 };
  check("3 count evolutions compound (10 * 1.2^3 = 17.28, rounds to 17)", getRaiderCount(evolvedCount3) === Math.round(10 * Math.pow(1.2, 3)));

  const zeroStats = getEvolvedRaiderStats(zeroEvo);
  check("0 evolutions: raider stats exactly match UNIT_STATS.raider (HP, dmg, speed)", zeroStats.maxHealth === UNIT_STATS.raider.maxHealth && zeroStats.damageMin === UNIT_STATS.raider.damageMin && zeroStats.damageMax === UNIT_STATS.raider.damageMax && zeroStats.attackSpeed === UNIT_STATS.raider.attackSpeed);

  const hpEvolved = getEvolvedRaiderStats({ ...defaultRaiderEvolution(), maxHealth: 1 });
  check("1 HP evolution: base * 1.2", approxEqual(hpEvolved.maxHealth, UNIT_STATS.raider.maxHealth * 1.2));
  check("HP evolution doesn't leak into damage/speed", hpEvolved.damageMin === UNIT_STATS.raider.damageMin && hpEvolved.attackSpeed === UNIT_STATS.raider.attackSpeed);

  const dmgEvolved = getEvolvedRaiderStats({ ...defaultRaiderEvolution(), damage: 2 });
  check("2 damage evolutions compound on BOTH damageMin and damageMax (base * 1.2^2 = *1.44)", approxEqual(dmgEvolved.damageMin, UNIT_STATS.raider.damageMin * 1.44) && approxEqual(dmgEvolved.damageMax, UNIT_STATS.raider.damageMax * 1.44));

  const spdEvolved = getEvolvedRaiderStats({ ...defaultRaiderEvolution(), attackSpeed: 1 });
  check("1 attack-speed evolution: base * 1.2", approxEqual(spdEvolved.attackSpeed, UNIT_STATS.raider.attackSpeed * 1.2));

  // Armor is the deliberate special case — raider base armor is 0, so a
  // multiplicative reading would be a permanent no-op. It's a flat step
  // instead.
  check("raider base armor really is 0 (confirming the special-case reasoning applies)", UNIT_STATS.raider.armor === 0);
  const armorEvolved1 = getEvolvedRaiderStats({ ...defaultRaiderEvolution(), armor: 1 });
  check("1 armor evolution adds the flat step, not a no-op multiplication of 0", armorEvolved1.armor === RAIDER_ARMOR_EVOLUTION_STEP);
  const armorEvolved3 = getEvolvedRaiderStats({ ...defaultRaiderEvolution(), armor: 3 });
  check("3 armor evolutions stack additively (3x the flat step)", armorEvolved3.armor === RAIDER_ARMOR_EVOLUTION_STEP * 3);

  // Never mutate the shared UNIT_STATS.raider singleton — same discipline
  // as getUpgradedStats for defenders.
  const beforeHp = UNIT_STATS.raider.maxHealth;
  getEvolvedRaiderStats({ ...defaultRaiderEvolution(), maxHealth: 10 });
  check("UNIT_STATS.raider.maxHealth is untouched after computing an evolved copy", UNIT_STATS.raider.maxHealth === beforeHp);
}

{
  // Deterministic RNG injection against the WEIGHTED cumulative
  // thresholds (count 0-0.25, maxHealth 0.25-0.5, damage 0.5-0.75,
  // attackSpeed 0.75-0.9, armor 0.9-1.0) — not a uniform 1/5 split.
  const evo = defaultRaiderEvolution();
  const picked = evolveRaiders(evo, () => 0);
  check("rng()=0 lands in the first bucket (count, 0-25%)", picked === "count" && evo.count === 1);

  const evoMid1 = defaultRaiderEvolution();
  check("rng()=0.30 lands in the second bucket (maxHealth, 25-50%)", evolveRaiders(evoMid1, () => 0.30) === "maxHealth");

  const evoMid2 = defaultRaiderEvolution();
  check("rng()=0.60 lands in the third bucket (damage, 50-75%)", evolveRaiders(evoMid2, () => 0.60) === "damage");

  const evoMid3 = defaultRaiderEvolution();
  check("rng()=0.80 lands in the fourth, narrower bucket (attackSpeed, 75-90%)", evolveRaiders(evoMid3, () => 0.80) === "attackSpeed");

  const evo2 = defaultRaiderEvolution();
  const picked2 = evolveRaiders(evo2, () => 0.999);
  check("rng()≈1 lands in the last, narrowest bucket (armor, 90-100%)", picked2 === "armor" && evo2.armor === 1);

  // Repeated picks of the same stat increment the same counter rather
  // than resetting or overwriting it.
  const evo3 = defaultRaiderEvolution();
  evolveRaiders(evo3, () => 0.1); // comfortably inside the "count" bucket
  check(`rng()=0.1 deterministically picks "count" and increments it to 1`, evo3.count === 1);
  evolveRaiders(evo3, () => 0.1);
  check(`a second identical pick increments the SAME stat to 2, not a different one`, evo3.count === 2);

  // Distribution sanity check over many rolls — not exact (it's random)
  // but should land close to the documented 25/25/25/15/10 split, same
  // methodology already used for the wave-type distribution check.
  const counts = { count: 0, maxHealth: 0, damage: 0, attackSpeed: 0, armor: 0 };
  let seed = 54321;
  const lcgRng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const trials = 20000;
  for (let i = 0; i < trials; i++) {
    const evoTrial = defaultRaiderEvolution();
    counts[evolveRaiders(evoTrial, lcgRng)]++;
  }
  for (const [stat, weight] of Object.entries(RAIDER_EVOLUTION_WEIGHTS)) {
    const fraction = counts[stat] / trials;
    check(`"${stat}" occurs close to its documented ${(weight * 100).toFixed(0)}% over ${trials} trials (got ${(fraction * 100).toFixed(1)}%)`, Math.abs(fraction - weight) < 0.02);
  }
}

// ---------- Level types + level specs (two independent axes) ----------
check("all 4 requested level types exist", LEVEL_TYPE_KEYS.length === 4 && ["normal", "mass", "champions", "boss"].every((k) => LEVEL_TYPE_KEYS.includes(k)));
check("flying is NOT a level type anymore (it moved to spec)", !LEVEL_TYPE_KEYS.includes("flying"));
check("all 5 requested level specs exist", LEVEL_SPEC_KEYS.length === 5 && ["none", "flying", "evasion", "pierceRes", "rush"].every((k) => LEVEL_SPEC_KEYS.includes(k)));
check("level type weights sum to 1", Math.abs(Object.values(LEVEL_TYPE_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
check("level type weights match the documented 40/20/20/20 split", LEVEL_TYPE_WEIGHTS.normal === 0.4 && LEVEL_TYPE_WEIGHTS.mass === 0.2 && LEVEL_TYPE_WEIGHTS.champions === 0.2 && LEVEL_TYPE_WEIGHTS.boss === 0.2);
check("level spec weights sum to 1", Math.abs(Object.values(LEVEL_SPEC_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
check("level spec weights match the documented 40/15/15/15/15 split", LEVEL_SPEC_WEIGHTS.none === 0.4 && LEVEL_SPEC_WEIGHTS.flying === 0.15 && LEVEL_SPEC_WEIGHTS.evasion === 0.15 && LEVEL_SPEC_WEIGHTS.pierceRes === 0.15 && LEVEL_SPEC_WEIGHTS.rush === 0.15);
check("LEVEL_SPEC_NONE_UNTIL_LEVEL is 5, matching the spec (first 5 levels always none)", LEVEL_SPEC_NONE_UNTIL_LEVEL === 5);

{
  // Deterministic RNG injection, same pattern as evolveRaiders' tests.
  function sequenceRng(...values) {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  }

  // pickRandomLevelType: single roll, cumulative thresholds (normal 0-0.4,
  // mass 0.4-0.6, champions 0.6-0.8, boss 0.8-1.0).
  check("pickRandomLevelType: r=0.39 -> normal", pickRandomLevelType(sequenceRng(0.39)) === "normal");
  check("pickRandomLevelType: r=0.4 -> mass (boundary exclusive on normal's side)", pickRandomLevelType(sequenceRng(0.4)) === "mass");
  check("pickRandomLevelType: r=0.59 -> mass", pickRandomLevelType(sequenceRng(0.59)) === "mass");
  // 0.60001 rather than exactly 0.6: cumulative floating-point summation
  // (0.4 + 0.2) lands on 0.6000000000000001, not exactly 0.6, so testing
  // the literal boundary value is fragile against FP drift, not a real
  // behavior difference — every other boundary check below picks a value
  // unambiguously past its threshold for the same reason.
  check("pickRandomLevelType: r=0.60001 -> champions", pickRandomLevelType(sequenceRng(0.60001)) === "champions");
  check("pickRandomLevelType: r=0.79 -> champions", pickRandomLevelType(sequenceRng(0.79)) === "champions");
  check("pickRandomLevelType: r=0.8 -> boss", pickRandomLevelType(sequenceRng(0.8)) === "boss");
  check("pickRandomLevelType: r just under 1 -> boss", pickRandomLevelType(sequenceRng(0.999)) === "boss");

  // pickRandomLevelSpec: none 0-0.4, flying 0.4-0.55, evasion 0.55-0.7,
  // pierceRes 0.7-0.85, rush 0.85-1.0.
  check("pickRandomLevelSpec: r=0.39 -> none", pickRandomLevelSpec(sequenceRng(0.39)) === "none");
  check("pickRandomLevelSpec: r=0.4 -> flying", pickRandomLevelSpec(sequenceRng(0.4)) === "flying");
  check("pickRandomLevelSpec: r=0.54 -> flying", pickRandomLevelSpec(sequenceRng(0.54)) === "flying");
  check("pickRandomLevelSpec: r=0.55 -> evasion", pickRandomLevelSpec(sequenceRng(0.55)) === "evasion");
  check("pickRandomLevelSpec: r=0.69 -> evasion", pickRandomLevelSpec(sequenceRng(0.69)) === "evasion");
  check("pickRandomLevelSpec: r=0.70001 -> pierceRes", pickRandomLevelSpec(sequenceRng(0.70001)) === "pierceRes"); // see FP-drift note above
  check("pickRandomLevelSpec: r=0.84 -> pierceRes", pickRandomLevelSpec(sequenceRng(0.84)) === "pierceRes");
  check("pickRandomLevelSpec: r=0.85001 -> rush", pickRandomLevelSpec(sequenceRng(0.85001)) === "rush"); // see FP-drift note above
  check("pickRandomLevelSpec: r just under 1 -> rush", pickRandomLevelSpec(sequenceRng(0.999)) === "rush");

  // Distribution sanity checks over many rolls.
  let seed = 12345;
  const lcgRng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const trials = 20000;

  const typeCounts = { normal: 0, mass: 0, champions: 0, boss: 0 };
  for (let i = 0; i < trials; i++) typeCounts[pickRandomLevelType(lcgRng)]++;
  for (const [type, weight] of Object.entries(LEVEL_TYPE_WEIGHTS)) {
    const fraction = typeCounts[type] / trials;
    check(`level type "${type}" occurs close to its documented ${(weight * 100).toFixed(0)}% over ${trials} trials (got ${(fraction * 100).toFixed(1)}%)`, Math.abs(fraction - weight) < 0.02);
  }

  const specCounts = { none: 0, flying: 0, evasion: 0, pierceRes: 0, rush: 0 };
  for (let i = 0; i < trials; i++) specCounts[pickRandomLevelSpec(lcgRng)]++;
  for (const [spec, weight] of Object.entries(LEVEL_SPEC_WEIGHTS)) {
    const fraction = specCounts[spec] / trials;
    check(`level spec "${spec}" occurs close to its documented ${(weight * 100).toFixed(0)}% over ${trials} trials (got ${(fraction * 100).toFixed(1)}%)`, Math.abs(fraction - weight) < 0.02);
  }
}

{
  // getWaveStats(type, spec, evolution) — normal+none should be numerically
  // identical to plain evolution with no modification at all.
  const evo = defaultRaiderEvolution();
  const plainCount = getRaiderCount(evo);
  const plainStats = getEvolvedRaiderStats(evo);
  const baseline = getWaveStats("normal", "none", evo);
  check("normal type + none spec: count matches plain evolution exactly", baseline.count === plainCount);
  check("normal type + none spec: HP matches plain evolution exactly", baseline.stats.maxHealth === plainStats.maxHealth);
  check("normal type + none spec: not flying, no evasion, no pierce res, no rush", baseline.stats.flying === false && baseline.stats.evasionChance === 0 && baseline.stats.pierceRes === false && baseline.stats.rushToCity === false);

  // ---- Types in isolation (spec = none) ----
  const massResult = getWaveStats("mass", "none", evo);
  check("mass type doubles count", massResult.count === Math.round(plainCount * 2));
  check("mass type reduces HP by 60%", approxEqual(massResult.stats.maxHealth, plainStats.maxHealth * 0.4));
  check("mass type reduces damage by 60% on both ends", approxEqual(massResult.stats.damageMin, plainStats.damageMin * 0.4) && approxEqual(massResult.stats.damageMax, plainStats.damageMax * 0.4));
  check("mass type increases speed by 20%", approxEqual(massResult.stats.speed, plainStats.speed * 1.2));

  const champResult = getWaveStats("champions", "none", evo);
  check("champions type is 1/5 count", champResult.count === Math.max(1, Math.round(plainCount * 0.2)));
  check("champions type quadruples HP", approxEqual(champResult.stats.maxHealth, plainStats.maxHealth * 4));
  check("champions type quadruples damage", approxEqual(champResult.stats.damageMin, plainStats.damageMin * 4));
  check("champions type reduces speed by 20%", approxEqual(champResult.stats.speed, plainStats.speed * 0.8));
  check("champions armor is a real nonzero value despite base raider armor being 0 (additive bonus)", champResult.stats.armor > 0);

  const bossResult = getWaveStats("boss", "none", evo);
  check("boss type is always exactly 1 unit", bossResult.count === 1);
  check("boss HP equals count x per-unit HP of the evolved baseline (sum of the wave's total budget)", approxEqual(bossResult.stats.maxHealth, plainCount * plainStats.maxHealth));
  check("boss type reduces speed by 40%", approxEqual(bossResult.stats.speed, plainStats.speed * 0.6));
  check("boss armor is a real nonzero value despite base raider armor being 0", bossResult.stats.armor > 0);

  // ---- Specs in isolation (type = normal) ----
  const flyingResult = getWaveStats("normal", "flying", evo);
  check("flying spec does NOT change count (count is type-only, per spec)", flyingResult.count === plainCount);
  check("flying spec reduces HP by 40%", approxEqual(flyingResult.stats.maxHealth, plainStats.maxHealth * 0.6));
  check("flying spec increases speed by 10%", approxEqual(flyingResult.stats.speed, plainStats.speed * 1.10));
  check("flying spec sets flying=true and ranged=true (attacks from range per spec) even though base raider is melee", flyingResult.stats.flying === true && flyingResult.stats.ranged === true);

  const evasionResult = getWaveStats("normal", "evasion", evo);
  check("evasion spec reduces HP by 25%", approxEqual(evasionResult.stats.maxHealth, plainStats.maxHealth * 0.75));
  check("evasion spec sets a 20% evasionChance", approxEqual(evasionResult.stats.evasionChance, 0.20));
  check("evasion spec does not set flying/pierceRes/rushToCity", evasionResult.stats.flying === false && evasionResult.stats.pierceRes === false && evasionResult.stats.rushToCity === false);

  const pierceResResult = getWaveStats("normal", "pierceRes", evo);
  check("pierce resistance spec reduces attack speed by 25%", approxEqual(pierceResResult.stats.attackSpeed, plainStats.attackSpeed * 0.75));
  check("pierce resistance spec sets pierceRes=true", pierceResResult.stats.pierceRes === true);
  check("pierce resistance spec does not change HP", pierceResResult.stats.maxHealth === plainStats.maxHealth);

  const rushResult = getWaveStats("normal", "rush", evo);
  check("rush spec sets rushToCity=true", rushResult.stats.rushToCity === true);
  check("rush spec reduces HP by 30% (a rushing unit is frailer, to balance ignoring defenders)", approxEqual(rushResult.stats.maxHealth, plainStats.maxHealth * 0.7));
  check("rush spec does not change speed or count", rushResult.stats.speed === plainStats.speed && rushResult.count === plainCount);

  // ---- Type x spec composability: the whole point of the split ----
  const flyingBoss = getWaveStats("boss", "flying", evo);
  check("Flying Boss: count is still exactly 1 (type's rule), unaffected by flying spec having no countMultiplier", flyingBoss.count === 1);
  check("Flying Boss: HP is the boss budget WITH the flying spec's -40% also applied on top", approxEqual(flyingBoss.stats.maxHealth, plainCount * plainStats.maxHealth * 0.6));
  check("Flying Boss: is flying (spec) AND still deals boss-level damage (type)", flyingBoss.stats.flying === true && approxEqual(flyingBoss.stats.damageMin, plainStats.damageMin * 8));

  const rushMass = getWaveStats("mass", "rush", evo);
  check("Rush Mass: count is still the mass type's doubled count, unaffected by rush spec", rushMass.count === Math.round(plainCount * 2));
  check("Rush Mass: rushes to the city (spec) while ALSO being mass-weak (type) AND rush-frail (spec) — both HP multipliers apply", rushMass.stats.rushToCity === true && approxEqual(rushMass.stats.maxHealth, plainStats.maxHealth * 0.4 * 0.7));

  // Never mutates UNIT_STATS.raider — same discipline as
  // getUpgradedStats/getEvolvedRaiderStats.
  const beforeHp = UNIT_STATS.raider.maxHealth;
  getWaveStats("boss", "flying", { ...defaultRaiderEvolution(), maxHealth: 5 });
  check("UNIT_STATS.raider.maxHealth is untouched after computing wave stats", UNIT_STATS.raider.maxHealth === beforeHp);

  // Visual placeholder fields exist and differ per combination, ready for
  // real per-combination assets later.
  const allTypeSpecPairs = LEVEL_TYPE_KEYS.flatMap((t) => LEVEL_SPEC_KEYS.map((s) => [t, s]));
  check("every type x spec combination produces a distinct spriteVariant key", new Set(allTypeSpecPairs.map(([t, s]) => getWaveStats(t, s, evo).stats.spriteVariant)).size === allTypeSpecPairs.length);
  check("a spec of 'none' leaves the type's own color completely untouched (no blend)", getWaveStats("boss", "none", evo).stats.color === LEVEL_TYPES.boss.color);
  check("a real spec (flying) actually changes the color from the type's plain color", getWaveStats("boss", "flying", evo).stats.color !== LEVEL_TYPES.boss.color);

  // Evolution keeps compounding regardless of type/spec — the core "type
  // and spec are layered ON TOP of, not instead of, the persistent
  // difficulty curve" requirement.
  const evolvedTwice = { ...defaultRaiderEvolution(), maxHealth: 2 };
  const bossEvolved = getWaveStats("boss", "none", evolvedTwice);
  const bossUnevolved = getWaveStats("boss", "none", defaultRaiderEvolution());
  check("a level's stats still reflect however much evolution has accumulated", bossEvolved.stats.maxHealth > bossUnevolved.stats.maxHealth);
}

// ---------- Level type + spec schedule ----------
{
  const progress = defaultProgress();
  check("a fresh save has empty type AND spec schedules", progress.levelTypeSchedule.length === 0 && progress.levelSpecSchedule.length === 0);

  const changed = ensureLevelSchedule(progress, 1, () => 0.4);
  check("ensureLevelSchedule reports it made a change on first call", changed === true);
  check("level 1's TYPE is ALWAYS normal, never randomized", progress.levelTypeSchedule[0] === "normal");
  check("level 1's SPEC is ALWAYS none (within the first-5-levels rule)", progress.levelSpecSchedule[0] === "none");

  ensureLevelSchedule(progress, LEVEL_TYPE_LOOKAHEAD + 1, () => 0.99); // 0.99 -> boss type, rush spec, deterministically
  check(`type schedule extends to cover at least the ${LEVEL_TYPE_LOOKAHEAD} lookahead requested`, progress.levelTypeSchedule.length >= LEVEL_TYPE_LOOKAHEAD + 1);
  check(`spec schedule extends to cover at least the ${LEVEL_TYPE_LOOKAHEAD} lookahead requested`, progress.levelSpecSchedule.length >= LEVEL_TYPE_LOOKAHEAD + 1);
  check("level 1's type is still normal after extending further (never gets overwritten)", progress.levelTypeSchedule[0] === "normal");
  check("levels 2-5's specs are still 'none' even though rng=0.99 would otherwise pick 'rush' (first-5-levels rule wins)", progress.levelSpecSchedule.slice(0, 5).every((s) => s === "none"));
  check("level 6's spec is randomized per the weights table (rng=0.99 -> rush)", progress.levelSpecSchedule[5] === "rush");

  const typeLengthBefore = progress.levelTypeSchedule.length;
  const specLengthBefore = progress.levelSpecSchedule.length;
  const noopChanged = ensureLevelSchedule(progress, 2, () => 0.5); // already covered, should be a no-op
  check("calling ensureLevelSchedule with an already-covered level makes no changes", noopChanged === false && progress.levelTypeSchedule.length === typeLengthBefore && progress.levelSpecSchedule.length === specLengthBefore);

  // getLevelType/getLevelSpec — predetermined stability: calling them
  // twice for the same level must return the SAME value both times, even
  // with a DIFFERENT rng passed the second time (proving it reads the
  // committed schedule rather than re-rolling).
  const fresh = defaultProgress();
  const firstType = getLevelType(fresh, 7);
  const secondType = getLevelType(fresh, 7, () => 0.0); // different rng, must not matter — already committed
  check("getLevelType is stable across repeated calls (predetermined, not re-rolled each time)", firstType === secondType);
  const firstSpec = getLevelSpec(fresh, 7);
  const secondSpec = getLevelSpec(fresh, 7, () => 0.0);
  check("getLevelSpec is stable across repeated calls (predetermined, not re-rolled each time)", firstSpec === secondSpec);
  check("getLevelType(1) is always normal", getLevelType(defaultProgress(), 1) === "normal");
  check("getLevelSpec(1) is always none", getLevelSpec(defaultProgress(), 1) === "none");
  check("getLevelSpec(5) is always none (still within the first-5 rule)", getLevelSpec(defaultProgress(), 5) === "none");

  // The whole point: level types/specs are visible/known well before the
  // player reaches them, and querying a level far in the future doesn't
  // silently fail to produce a real value.
  const farFutureType = getLevelType(defaultProgress(), 50);
  const farFutureSpec = getLevelSpec(defaultProgress(), 50);
  check("querying a level far in the future still returns a valid, real level type", LEVEL_TYPE_KEYS.includes(farFutureType));
  check("querying a level far in the future still returns a valid, real level spec", LEVEL_SPEC_KEYS.includes(farFutureSpec));
}

// ---------- Population ----------
check("base population is 12 as specified", BASE_POPULATION === 12);
check("population budget with no purchases equals the base, across levels (base doesn't scale by level, only by purchases)", computePopulationBudget(1) === 12 && computePopulationBudget(5) === 12);
check("each population purchase adds exactly +1 to the budget", computePopulationBudget(1, 3) === 12 + 3);
check("population upgrade cost schedule is 5, 10, 15... — same schedule as every other upgrade", getPopulationUpgradeCost(0) === 5 && getPopulationUpgradeCost(1) === 10 && getPopulationUpgradeCost(2) === 15);
check("population base/increment constants match the spec (same as every stat: 5g, +5g per purchase)", POPULATION_UPGRADE_BASE_COST === 5 && POPULATION_UPGRADE_COST_INCREMENT === 5 && POPULATION_PER_PURCHASE === 1);

{
  const progress = defaultProgress();
  progress.gold = 18;
  const first = purchasePopulation(progress);
  check("first population purchase succeeds and costs 5", first.ok === true && progress.gold === 13);
  check("first population purchase increments the counter", progress.populationPurchases === 1);
  const second = purchasePopulation(progress);
  check("second population purchase costs 10 (13 -> 3)", second.ok === true && progress.gold === 3);
  const third = purchasePopulation(progress);
  check("third population purchase fails — only 3 gold left, needs 15", third.ok === false && progress.gold === 3 && progress.populationPurchases === 2);
}

// ---------- Gold reward ----------
check("gold-per-clear is 10 as specified", GOLD_PER_LEVEL_CLEAR === 10);

// ---------- Upgrade math ----------
{
  const zero = getUpgradedStats("knight", { knightHp: 0, knightDmg: 0 });
  check("0 purchases leaves knight stats exactly at base", zero.maxHealth === UNIT_STATS.knight.maxHealth && zero.damageMin === UNIT_STATS.knight.damageMin && zero.damageMax === UNIT_STATS.knight.damageMax);

  const oneHp = getUpgradedStats("knight", { knightHp: 1 });
  check("1 HP purchase adds exactly +10 HP", oneHp.maxHealth === UNIT_STATS.knight.maxHealth + 10);

  const threeHp = getUpgradedStats("knight", { knightHp: 3 });
  check("purchases stack additively (3x +10 = +30)", threeHp.maxHealth === UNIT_STATS.knight.maxHealth + 30);

  const oneDmg = getUpgradedStats("archer", { archerDmg: 1 });
  check("damage upgrade shifts BOTH damageMin and damageMax by +2", oneDmg.damageMin === UNIT_STATS.archer.damageMin + 2 && oneDmg.damageMax === UNIT_STATS.archer.damageMax + 2);
  check("damage upgrade does not touch HP", oneDmg.maxHealth === UNIT_STATS.archer.maxHealth);

  const knightPurchase = getUpgradedStats("knight", { archerHp: 5, archerDmg: 5 });
  check("archer purchases never leak onto knight stats", knightPurchase.maxHealth === UNIT_STATS.knight.maxHealth);

  // Armor: flat additive, same pattern as HP/damage.
  const armorOnce = getUpgradedStats("archer", { archerArmor: 1 });
  check("1 armor purchase adds exactly +1 armor", armorOnce.armor === UNIT_STATS.archer.armor + 1);
  const armorThrice = getUpgradedStats("knight", { knightArmor: 3 });
  check("armor purchases stack additively (3x +1 = +3)", armorThrice.armor === UNIT_STATS.knight.armor + 3);

  // Range: flat additive, archer only — no knightRange key exists at all.
  const rangeTwice = getUpgradedStats("archer", { archerRange: 2 });
  check("2 range purchases add exactly +2 range", rangeTwice.range === UNIT_STATS.archer.range + 2);
  check("there is no knightRange upgrade — Knights don't get a range dial", UPGRADES.knightRange === undefined);
  check("knight stats are entirely unaffected by an (impossible) archerRange purchase", getUpgradedStats("knight", { archerRange: 5 }).range === UNIT_STATS.knight.range);

  // Attack speed: the important one — a PERCENTAGE applied multiplicatively
  // to the base RATE (attacks/sec), stacking additively on the percentage
  // across purchases (10%, 20%, 30%...), not compounding purchase-over-
  // purchase and not touching some separate "cooldown" field (there isn't
  // one — main.js derives cooldown as 1/attackSpeed fresh every time).
  const atkSpd1 = getUpgradedStats("knight", { knightAtkSpd: 1 });
  check("1 attack-speed purchase = base rate * 1.10 (+10%)", approxEqual(atkSpd1.attackSpeed, UNIT_STATS.knight.attackSpeed * 1.10));
  const atkSpd3 = getUpgradedStats("archer", { archerAtkSpd: 3 });
  check("3 attack-speed purchases = base rate * 1.30 (+30%, additive stacking not compounding)", approxEqual(atkSpd3.attackSpeed, UNIT_STATS.archer.attackSpeed * 1.30));
  check("attack-speed purchases do NOT compound (would be *1.1^3 ≈ *1.331 if they did)", !approxEqual(atkSpd3.attackSpeed, UNIT_STATS.archer.attackSpeed * Math.pow(1.10, 3)));

  // The important regression: the shared UNIT_STATS singleton must never
  // be mutated by computing upgraded stats, since other modules (melee
  // slot ring sizing, the generator, other tests) read it directly and
  // must always see base values.
  const beforeHealth = UNIT_STATS.knight.maxHealth;
  const beforeAtkSpd = UNIT_STATS.knight.attackSpeed;
  getUpgradedStats("knight", { knightHp: 50, knightAtkSpd: 10 });
  check("UNIT_STATS.knight.maxHealth is untouched after computing an upgraded copy", UNIT_STATS.knight.maxHealth === beforeHealth);
  check("UNIT_STATS.knight.attackSpeed is untouched after computing an upgraded copy", UNIT_STATS.knight.attackSpeed === beforeAtkSpd);

  check("getUpgradeBonus reports the correct total for a given purchase count", getUpgradeBonus("knightHp", { knightHp: 4 }) === 40);
  check("getUpgradeBonus is 0 with no purchases recorded", getUpgradeBonus("archerDmg", {}) === 0);
  check("getUpgradeBonus for a percent-based upgrade returns the raw fraction (0.2 for 2 purchases), formatting is main.js's job", getUpgradeBonus("archerAtkSpd", { archerAtkSpd: 2 }) === 0.2);

  // Mage: same flat-additive HP/Damage/Armor/AtkSpd pattern as Knight/Archer,
  // plus one new stat shape — freezeSlowPercent lives on a NESTED `freeze`
  // object (not a flat field), so it needs its own verification that it
  // updates the right sub-field without disturbing the rest of `freeze` or
  // mutating the shared UNIT_STATS.mage.freeze object.
  const mageZero = getUpgradedStats("mage", { mageHp: 0 });
  check("0 purchases leaves mage stats exactly at base, including the nested freeze object", mageZero.maxHealth === UNIT_STATS.mage.maxHealth && mageZero.freeze.slowPercent === UNIT_STATS.mage.freeze.slowPercent);

  const mageHp2 = getUpgradedStats("mage", { mageHp: 2 });
  check("2 mage HP purchases add exactly +12 HP (2x +6)", mageHp2.maxHealth === UNIT_STATS.mage.maxHealth + 12);

  const mageDmg1 = getUpgradedStats("mage", { mageDmg: 1 });
  check("1 mage damage purchase shifts both damageMin and damageMax by +4", mageDmg1.damageMin === UNIT_STATS.mage.damageMin + 4 && mageDmg1.damageMax === UNIT_STATS.mage.damageMax + 4);

  const mageFreeze1 = getUpgradedStats("mage", { mageFreeze: 1 });
  check("1 freeze purchase adds exactly +5 percentage points of slow (10% -> 15%)", approxEqual(mageFreeze1.freeze.slowPercent, UNIT_STATS.mage.freeze.slowPercent + 0.05));
  check("a freeze purchase leaves freeze.duration untouched", mageFreeze1.freeze.duration === UNIT_STATS.mage.freeze.duration);

  const mageFreeze3 = getUpgradedStats("mage", { mageFreeze: 3 });
  check("freeze purchases stack additively (3x +5% = +15%: 10% -> 25%)", approxEqual(mageFreeze3.freeze.slowPercent, UNIT_STATS.mage.freeze.slowPercent + 0.15));

  const beforeFreezeSlow = UNIT_STATS.mage.freeze.slowPercent;
  getUpgradedStats("mage", { mageFreeze: 5 });
  check("UNIT_STATS.mage.freeze.slowPercent (the shared nested object) is untouched after computing an upgraded copy", UNIT_STATS.mage.freeze.slowPercent === beforeFreezeSlow);

  check("mage stats carry splashRadius and freeze unmodified from UNIT_STATS (neither is an upgrade target on its own)", mageZero.splashRadius === UNIT_STATS.mage.splashRadius);
  check("mage is disabled until Level 10, matching the spec", UNIT_STATS.mage.unlockLevel === 10);
  check("mage costs 4 population, matching the spec", UNIT_STATS.mage.cost === 4);

  check("getUpgradeBonus for the freeze upgrade returns the raw fraction (0.10 for 2 purchases)", approxEqual(getUpgradeBonus("mageFreeze", { mageFreeze: 2 }), 0.10));
  check("mageFreeze cost schedule is 5, 10, 15... same as every other upgrade", getUpgradeCost("mageFreeze", { mageFreeze: 0 }) === 5 && getUpgradeCost("mageFreeze", { mageFreeze: 1 }) === 10);
}

// ---------- Escalating upgrade cost ----------
{
  check("HP upgrade cost schedule is 5, 10, 15... — same as everything else now (no longer flat)", getUpgradeCost("knightHp", { knightHp: 0 }) === 5 && getUpgradeCost("knightHp", { knightHp: 1 }) === 10 && getUpgradeCost("knightHp", { knightHp: 5 }) === 30);
  check("damage upgrade cost schedule is 5, 10, 15... too", getUpgradeCost("archerDmg", { archerDmg: 0 }) === 5 && getUpgradeCost("archerDmg", { archerDmg: 1 }) === 10);
  check("armor upgrade cost schedule is 5, 10, 15, 20... as specified", getUpgradeCost("knightArmor", { knightArmor: 0 }) === 5 && getUpgradeCost("knightArmor", { knightArmor: 1 }) === 10 && getUpgradeCost("knightArmor", { knightArmor: 2 }) === 15 && getUpgradeCost("knightArmor", { knightArmor: 3 }) === 20);
  check("attack-speed upgrade cost schedule is 5, 10, 15... too", getUpgradeCost("archerAtkSpd", { archerAtkSpd: 0 }) === 5 && getUpgradeCost("archerAtkSpd", { archerAtkSpd: 2 }) === 15);
  check("range upgrade cost schedule is 5, 10, 15... too", getUpgradeCost("archerRange", { archerRange: 0 }) === 5 && getUpgradeCost("archerRange", { archerRange: 1 }) === 10);
}

// ---------- purchaseUpgrade ----------
{
  const progress = defaultProgress();
  progress.gold = 20;
  const result = purchaseUpgrade(progress, "knightHp");
  check("successful purchase reports ok:true", result.ok === true);
  check("successful purchase deducts the correct cost", progress.gold === 20 - UPGRADES.knightHp.cost);
  check("successful purchase increments the purchase count", progress.purchases.knightHp === 1);

  const poor = defaultProgress();
  poor.gold = 1;
  const denied = purchaseUpgrade(poor, "knightHp");
  check("purchase with insufficient gold reports ok:false", denied.ok === false);
  check("denied purchase leaves gold untouched", poor.gold === 1);
  check("denied purchase leaves purchase count untouched", poor.purchases.knightHp === 0);

  const bogus = purchaseUpgrade(defaultProgress(), "notARealUpgrade");
  check("purchasing an unknown upgrade key fails gracefully instead of throwing", bogus.ok === false);

  // Escalating-cost purchase sequence, end to end through purchaseUpgrade
  // (not just getUpgradeCost in isolation) — 5, then 10, then 15.
  const escalating = defaultProgress();
  escalating.gold = 100;
  purchaseUpgrade(escalating, "knightArmor");
  check("1st escalating purchase costs 5 (100 -> 95)", escalating.gold === 95);
  purchaseUpgrade(escalating, "knightArmor");
  check("2nd escalating purchase costs 10 (95 -> 85)", escalating.gold === 85);
  purchaseUpgrade(escalating, "knightArmor");
  check("3rd escalating purchase costs 15 (85 -> 70)", escalating.gold === 70);
  check("purchase count is 3 after 3 successful buys", escalating.purchases.knightArmor === 3);
}

// ---------- Persistence round-trip ----------
{
  resetProgress();
  const fresh = loadProgress();
  check("loadProgress with nothing saved returns level 1", fresh.level === 1);
  check("loadProgress with nothing saved returns 0 gold", fresh.gold === 0);
  check("loadProgress with nothing saved returns 0 score", fresh.score === 0);
  check("loadProgress with nothing saved returns city at full health (100)", fresh.cityHealth === 100);
  check("loadProgress with nothing saved returns 0 population purchases", fresh.populationPurchases === 0);
  check("loadProgress with nothing saved returns all-zero purchases, including all 5 Mage upgrade keys", Object.values(fresh.purchases).every((v) => v === 0) && Object.keys(fresh.purchases).length === 14);
  check("loadProgress with nothing saved returns all-zero raiderEvolution", Object.values(fresh.raiderEvolution).every((v) => v === 0) && Object.keys(fresh.raiderEvolution).length === 5);
  check("loadProgress with nothing saved returns an empty levelTypeSchedule", Array.isArray(fresh.levelTypeSchedule) && fresh.levelTypeSchedule.length === 0);
  check("loadProgress with nothing saved returns an empty backpack and a fresh instance-id counter", Array.isArray(fresh.backpack) && fresh.backpack.length === 0 && fresh.nextItemInstanceId === 0);

  fresh.gold = 42;
  fresh.score = 875;
  fresh.cityHealth = 63.5;
  fresh.level = 3;
  fresh.purchases.archerDmg = 2;
  fresh.purchases.knightAtkSpd = 4;
  fresh.populationPurchases = 2;
  fresh.raiderEvolution.maxHealth = 3;
  fresh.raiderEvolution.armor = 1;
  fresh.levelTypeSchedule = ["normal", "boss", "champions"];
  fresh.levelSpecSchedule = ["none", "none", "flying"];
  fresh.backpack = [{ instanceId: 0, itemKey: "swiftTonic", active: true }, { instanceId: 1, itemKey: "ironHide", active: false }];
  fresh.nextItemInstanceId = 2;
  saveProgress(fresh);

  const reloaded = loadProgress();
  check("saveProgress -> loadProgress round-trips gold correctly", reloaded.gold === 42);
  check("saveProgress -> loadProgress round-trips score correctly", reloaded.score === 875);
  check("saveProgress -> loadProgress round-trips city health exactly, including a fractional percentage", reloaded.cityHealth === 63.5);
  check("saveProgress -> loadProgress round-trips level correctly", reloaded.level === 3);
  check("saveProgress -> loadProgress round-trips a purchase correctly", reloaded.purchases.archerDmg === 2);
  check("saveProgress -> loadProgress round-trips a NEW-stat-type purchase correctly", reloaded.purchases.knightAtkSpd === 4);
  check("saveProgress -> loadProgress round-trips populationPurchases correctly", reloaded.populationPurchases === 2);
  check("saveProgress -> loadProgress round-trips untouched purchase keys as 0", reloaded.purchases.knightHp === 0);
  check("saveProgress -> loadProgress round-trips the level type schedule exactly, in order", JSON.stringify(reloaded.levelTypeSchedule) === JSON.stringify(["normal", "boss", "champions"]));
  check("saveProgress -> loadProgress round-trips the level spec schedule exactly, in order", JSON.stringify(reloaded.levelSpecSchedule) === JSON.stringify(["none", "none", "flying"]));
  check("saveProgress -> loadProgress round-trips raiderEvolution correctly", reloaded.raiderEvolution.maxHealth === 3 && reloaded.raiderEvolution.armor === 1);
  check("saveProgress -> loadProgress round-trips untouched raiderEvolution keys as 0", reloaded.raiderEvolution.count === 0 && reloaded.raiderEvolution.damage === 0);
  check("saveProgress -> loadProgress round-trips the backpack exactly, including each instance's active flag", JSON.stringify(reloaded.backpack) === JSON.stringify(fresh.backpack));
  check("saveProgress -> loadProgress round-trips nextItemInstanceId correctly", reloaded.nextItemInstanceId === 2);

  // Fractional gold (from interest) must round-trip through JSON exactly
  // — this is the actual persistence path interest relies on.
  const fractional = defaultProgress();
  fractional.gold = 39.6;
  saveProgress(fractional);
  const reloadedFractional = loadProgress();
  check("fractional gold survives a save/load round-trip exactly (39.6, not truncated)", reloadedFractional.gold === 39.6);

  // Forward-compatibility: a save written by an "older" version missing a
  // key entirely shouldn't crash loadProgress or silently produce
  // `undefined` fields downstream code might do arithmetic on. This is
  // exactly what happens to any real save made before this round — it has
  // gold/level/purchases but no populationPurchases, no raiderEvolution at
  // all, and no knightArmor et al. inside purchases.
  localStorage.setItem("defend-the-city-progress-v1", JSON.stringify({ level: 2, gold: 5, purchases: { knightHp: 1, archerDmg: 2 } }));
  const partial = loadProgress();
  check("loading an old-shape save fills in populationPurchases as 0", partial.populationPurchases === 0);
  check("loading an old-shape save fills in the 5 new upgrade keys as 0 without dropping the 2 old ones present", partial.purchases.knightArmor === 0 && partial.purchases.archerAtkSpd === 0 && partial.purchases.knightHp === 1 && partial.purchases.archerDmg === 2);
  check("loading an old-shape save (predating raiderEvolution entirely) fills it in as all-zero rather than crashing", partial.raiderEvolution && Object.values(partial.raiderEvolution).every((v) => v === 0));
  check("loading an old-shape save (predating levelTypeSchedule entirely) fills it in as an empty array rather than crashing", Array.isArray(partial.levelTypeSchedule) && partial.levelTypeSchedule.length === 0);
  check("loading an old-shape save (predating score entirely) fills it in as 0 rather than undefined", partial.score === 0);
  check("loading an old-shape save (predating city health entirely) fills it in at FULL health, not 0 — a save from before this feature existed shouldn't start with a pre-destroyed city", partial.cityHealth === 100);
  check("loading a partial save still preserves the fields that WERE present", partial.level === 2 && partial.gold === 5);
  check("loading an old-shape save (predating the item/backpack system entirely) fills in an empty backpack rather than crashing", Array.isArray(partial.backpack) && partial.backpack.length === 0 && partial.nextItemInstanceId === 0);

  // Migration: a save from before the type/spec split stores "flying" as
  // a TYPE value (it used to be one of the 5 wave types) — that's no
  // longer valid in LEVEL_TYPE_KEYS now that Flying is a spec. Both
  // schedules must be wiped so they regenerate cleanly under the new
  // two-axis system, rather than main.js later reading "flying" back as
  // a type and silently mis-resolving it.
  localStorage.setItem("defend-the-city-progress-v1", JSON.stringify({ level: 4, gold: 12, levelTypeSchedule: ["normal", "flying", "boss"] }));
  const legacy = loadProgress();
  check("loading a save with a legacy 'flying' TYPE value wipes the type schedule rather than keeping the now-invalid entry", legacy.levelTypeSchedule.length === 0);
  check("loading a save with a legacy 'flying' TYPE value also wipes the spec schedule (the two axes are regenerated together)", legacy.levelSpecSchedule.length === 0);
  check("the type/spec migration doesn't touch unrelated fields (level, gold still preserved)", legacy.level === 4 && legacy.gold === 12);

  // A save whose schedule only contains valid NEW-shape type values (e.g.
  // written by this same version, or empty/absent) must NOT be wiped —
  // the migration should only fire on genuinely legacy data.
  localStorage.setItem("defend-the-city-progress-v1", JSON.stringify({ level: 4, levelTypeSchedule: ["normal", "boss", "mass"] }));
  const notLegacy = loadProgress();
  check("a schedule containing only valid current-shape type values is left untouched, not wiped", JSON.stringify(notLegacy.levelTypeSchedule) === JSON.stringify(["normal", "boss", "mass"]));

  // Corrupt data shouldn't throw either.
  localStorage.setItem("defend-the-city-progress-v1", "{not valid json");
  const corrupt = loadProgress();
  check("loading corrupt JSON falls back to default progress instead of throwing", corrupt.level === 1 && corrupt.gold === 0);

  // Rename migration: the project used to be called "City Defense" and
  // saved under a correspondingly-named key. Anyone with a run in
  // progress at rename time must keep it — a rename is a cosmetic change
  // and should never cost a player their progress.
  localStorage.removeItem("defend-the-city-progress-v1");
  localStorage.setItem("city-defense-progress-v1", JSON.stringify({ level: 7, gold: 42, score: 1234 }));
  const migrated = loadProgress();
  check("a save under the pre-rename key is still loaded (level/gold/score all carried over)", migrated.level === 7 && migrated.gold === 42 && migrated.score === 1234);

  // The current key must WIN over the legacy one whenever both exist —
  // otherwise a player who kept playing after the rename would silently
  // get rolled back to their pre-rename state on every load.
  localStorage.setItem("defend-the-city-progress-v1", JSON.stringify({ level: 9, gold: 1 }));
  const bothPresent = loadProgress();
  check("with both the current and legacy keys present, the CURRENT key wins (no rollback to pre-rename state)", bothPresent.level === 9 && bothPresent.gold === 1);

  // resetProgress has to clear BOTH keys. Clearing only the current one
  // would leave the legacy save behind, and the very next load would fall
  // back to it — a reset that silently undoes itself.
  resetProgress();
  const afterMigrationReset = loadProgress();
  check("resetProgress clears the legacy key too, so a reset can't be undone by a stale pre-rename save", afterMigrationReset.level === 1 && afterMigrationReset.gold === 0);

  resetProgress();
  const afterReset = loadProgress();
  check("resetProgress fully clears the save (back to defaults)", afterReset.level === 1 && afterReset.gold === 0);
}

console.log(`\n${failures} failure(s).`);
if (failures > 0) process.exit(1);
console.log("All progression checks passed.");
