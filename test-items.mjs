// Tests for src/items.js — drop-table probabilities, item effect math
// (including the "stacking is additive per active instance, not
// compounding" requirement), and backpack instance/activation mechanics.
// No localStorage dependency here (unlike test-progression.mjs) — the
// backpack functions operate on a plain `progress`-shaped object passed
// in directly, they don't touch storage themselves.

const {
  ITEM_TIERS,
  MAX_ACTIVE_ITEMS,
  CRIT_DAMAGE_MULTIPLIER,
  ITEMS,
  ITEM_KEYS,
  DROP_TABLES,
  rollDropTier,
  pickItemForTier,
  rollItemDrop,
  defaultBackpackState,
  addDroppedItem,
  countActiveItems,
  setItemActive,
  getActiveItemKeys,
  computeItemBonuses,
  computeGlobalItemBonuses,
  applyItemBonuses,
} = await import("./src/items.js");

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

// A deterministic sequence RNG for exact-boundary tests — returns each
// value in `seq` in order, cycling if called more times than seq.length.
function sequenceRng(seq) {
  let i = 0;
  return () => seq[i++ % seq.length];
}

// ---------- Item definitions ----------
{
  check("every item's tier is one of the three defined tiers", ITEM_KEYS.every((k) => ITEM_TIERS.includes(ITEMS[k].tier)));
  check("every item has at least one effect", ITEM_KEYS.every((k) => ITEMS[k].effects.length > 0));
  check("there is at least one item per tier", ITEM_TIERS.every((tier) => ITEM_KEYS.some((k) => ITEMS[k].tier === tier)));
  check("MAX_ACTIVE_ITEMS is 6, matching the spec", MAX_ACTIVE_ITEMS === 6);

  // Spec-specific items, checked by exact value so a future accidental
  // rebalance shows up here rather than only being noticed in play.
  // Values reflect the rebalance pass (every effect cut 25%-50%, see the
  // note above ITEMS in items.js) — NOT the original design-doc numbers.
  check("Swift Tonic: +3% attack speed for all defenders", approxEqual(ITEMS.swiftTonic.effects[0].amount, 0.03) && ITEMS.swiftTonic.effects[0].scope === "all" && ITEMS.swiftTonic.effects[0].stat === "attackSpeedPercent");
  check("Sharpening Stone: +3% damage for all defenders", approxEqual(ITEMS.sharpeningStone.effects[0].amount, 0.03) && ITEMS.sharpeningStone.effects[0].stat === "damagePercent");
  check("Iron Hide: +1 armor for all defenders (unchanged — no clean 25%-50% cut of +1 exists)", ITEMS.ironHide.effects[0].amount === 1 && ITEMS.ironHide.effects[0].stat === "armorFlat" && ITEMS.ironHide.effects[0].scope === "all");
  check("Eagle Eye: +1 range for Archers only, unchanged for the same reason as Iron Hide", ITEMS.eagleEye.effects[0].amount === 1 && ITEMS.eagleEye.effects[0].stat === "rangeFlat" && ITEMS.eagleEye.effects[0].scope === "archer");
  check("Knight's Fury: +12% damage for Knights only", approxEqual(ITEMS.knightsFury.effects[0].amount, 0.12) && ITEMS.knightsFury.effects[0].scope === "knight" && ITEMS.knightsFury.effects[0].stat === "damagePercent");
  check("Arcane Haste: +18% attack speed for Mages only", approxEqual(ITEMS.arcaneHaste.effects[0].amount, 0.18) && ITEMS.arcaneHaste.effects[0].scope === "mage" && ITEMS.arcaneHaste.effects[0].stat === "attackSpeedPercent");
  check("Tempered Plate: +2 armor for all defenders", ITEMS.temperedPlate.effects[0].amount === 2 && ITEMS.temperedPlate.effects[0].scope === "all" && ITEMS.temperedPlate.effects[0].stat === "armorFlat");
  check("Warlord's Blessing: +12% damage AND +12% attack speed for all defenders (two effects)", ITEMS.warlordsBlessing.effects.length === 2 && ITEMS.warlordsBlessing.effects.every((e) => approxEqual(e.amount, 0.12) && e.scope === "all"));
  check("Warlord's Blessing covers both damagePercent and attackSpeedPercent, not the same stat twice", new Set(ITEMS.warlordsBlessing.effects.map((e) => e.stat)).size === 2);

  check("common item count matches the spec (10 listed)", ITEM_KEYS.filter((k) => ITEMS[k].tier === "common").length === 10);
  check("rare item count matches the spec (10 listed)", ITEM_KEYS.filter((k) => ITEMS[k].tier === "rare").length === 10);
  check("legendary item count matches the spec (10 listed)", ITEM_KEYS.filter((k) => ITEMS[k].tier === "legendary").length === 10);
  check("30 items total", ITEM_KEYS.length === 30);
  check("no duplicate item ids", new Set(ITEM_KEYS).size === ITEM_KEYS.length);
  check("every item's internal id matches its own object key", ITEM_KEYS.every((k) => ITEMS[k].id === k));
  check("every item has a non-empty label and description", ITEM_KEYS.every((k) => ITEMS[k].label.length > 0 && ITEMS[k].description.length > 0));
  check("every effect's scope is a real scope (all/knight/archer/mage/global)", ITEM_KEYS.every((k) => ITEMS[k].effects.every((e) => ["all", "knight", "archer", "mage", "global"].includes(e.scope))));
  check("every effect's stat is a recognized stat name", ITEM_KEYS.every((k) => ITEMS[k].effects.every((e) => ["attackSpeedPercent", "damagePercent", "hpPercent", "armorFlat", "rangeFlat", "critChance", "lifestealPercent", "cityDamageReductionPercent", "goldGainPercent"].includes(e.stat))));
  check("every effect's amount is a positive number", ITEM_KEYS.every((k) => ITEMS[k].effects.every((e) => typeof e.amount === "number" && e.amount > 0)));
  check("global-scoped effects only use the two global stats", ITEM_KEYS.every((k) => ITEMS[k].effects.every((e) => e.scope !== "global" || ["cityDamageReductionPercent", "goldGainPercent"].includes(e.stat))));
  check("no non-global effect uses a global-only stat", ITEM_KEYS.every((k) => ITEMS[k].effects.every((e) => e.scope === "global" || !["cityDamageReductionPercent", "goldGainPercent"].includes(e.stat))));

  // Power-curve sanity: legendaries should generally hit harder than
  // commons for the same stat, a basic balance guarantee worth locking in
  // as an automated check rather than just eyeballing 30 numbers by hand.
  function totalMagnitudeForStat(tier, stat) {
    return ITEM_KEYS.filter((k) => ITEMS[k].tier === tier).reduce((sum, k) => sum + ITEMS[k].effects.filter((e) => e.stat === stat).reduce((s, e) => s + e.amount, 0), 0);
  }
  check("legendary items grant more total damagePercent across the tier than common items do", totalMagnitudeForStat("legendary", "damagePercent") > totalMagnitudeForStat("common", "damagePercent"));
  check("legendary items grant more total armorFlat across the tier than common items do", totalMagnitudeForStat("legendary", "armorFlat") > totalMagnitudeForStat("common", "armorFlat"));

  // Class coverage: every defender type should have real representation
  // across the roster, not be an afterthought in one tier only.
  for (const scope of ["knight", "archer", "mage"]) {
    const count = ITEM_KEYS.filter((k) => ITEMS[k].effects.some((e) => e.scope === scope)).length;
    check(`at least 3 items grant a ${scope}-specific bonus`, count >= 3);
  }
  check("exactly 2 legendary items use the global scope (Aegis of the City, Midas' Hoard)", ITEM_KEYS.filter((k) => ITEMS[k].tier === "legendary" && ITEMS[k].effects.some((e) => e.scope === "global")).length === 2);
}

// ---------- Drop tables: exact spec values ----------
// Keyed by LEVEL TYPE only (Normal/Mass/Champions/Boss) — deliberately
// unaffected by level SPEC (Flying/Evasion/Pierce Resistance/Rush) now
// that those are a separate, independent axis (see progression.js).
{
  // Values reflect the x0.6 (40% cut) rebalance pass — see the note above
  // DROP_TABLES in items.js for exactly how each entry was derived.
  check("normal: 6% common, 0.6% rare, 0% legendary", approxEqual(DROP_TABLES.normal.common, 0.06) && approxEqual(DROP_TABLES.normal.rare, 0.006) && DROP_TABLES.normal.legendary === 0);
  check("there is no 'flying' entry in DROP_TABLES — flying is a spec now, not a type", DROP_TABLES.flying === undefined);
  check("mass: 1.8% common, 0% rare, 0% legendary", approxEqual(DROP_TABLES.mass.common, 0.018) && DROP_TABLES.mass.rare === 0 && DROP_TABLES.mass.legendary === 0);
  check("champions: 30% common, 27% rare, 3% legendary", approxEqual(DROP_TABLES.champions.common, 0.30) && approxEqual(DROP_TABLES.champions.rare, 0.27) && approxEqual(DROP_TABLES.champions.legendary, 0.03));
  check("boss: 6% common, 48% rare, 6% legendary (sums to 60% — a Boss kill is no longer guaranteed to drop, by design of the uniform 40% cut)", approxEqual(DROP_TABLES.boss.common, 0.06) && approxEqual(DROP_TABLES.boss.rare, 0.48) && approxEqual(DROP_TABLES.boss.legendary, 0.06));
}

// ---------- rollDropTier: exact boundary behavior ----------
// These pin down the "single roll, cumulative thresholds, rarest-first"
// mechanics precisely enough to catch a regression to independent
// per-tier rolls (which would silently change the real drop rates — see
// items.js's comment on why that would be wrong for e.g. Champions).
// Thresholds recomputed for the rebalanced tables: normal is
// legendary<0 (empty), rare<0.006, common<0.066; boss is legendary<0.06,
// rare<0.54, common<0.60.
{
  check("normal, r=0 -> legendary bucket is empty (0%), falls through to rare", rollDropTier("normal", sequenceRng([0])) === "rare");
  check("normal, r=0.003 (< 0.006 rare threshold) -> rare", rollDropTier("normal", sequenceRng([0.003])) === "rare");
  check("normal, r=0.03 (between 0.006 and 0.066) -> common", rollDropTier("normal", sequenceRng([0.03])) === "common");
  check("normal, r=0.1 (>= 0.066 total) -> no drop", rollDropTier("normal", sequenceRng([0.1])) === null);
  check("normal, r just under 1 -> no drop", rollDropTier("normal", sequenceRng([0.999])) === null);

  check("boss, r=0.03 (< 0.06 legendary threshold) -> legendary", rollDropTier("boss", sequenceRng([0.03])) === "legendary");
  check("boss, r=0.3 (between 0.06 and 0.54) -> rare", rollDropTier("boss", sequenceRng([0.3])) === "rare");
  check("boss, r=0.57 (between 0.54 and 0.60) -> common", rollDropTier("boss", sequenceRng([0.57])) === "common");
  // The old "Boss always drops" guarantee is gone under the uniform 40%
  // cut (the three tiers now sum to 60%, not 100% — see the note above
  // DROP_TABLES) — a high roll now genuinely misses.
  check("boss, r=0.999999 (>= 0.60 total) -> no drop, since the tiers now only sum to 60%", rollDropTier("boss", sequenceRng([0.999999])) === null);

  check("an unknown level type key falls back to the normal table", rollDropTier("madeUpType", sequenceRng([0.03])) === "common");
}

// ---------- Statistical verification (matches the project's existing
// pattern for LEVEL_TYPES' own probability distribution in test-progression) ----------
{
  function simulateDropRate(levelType, tier, trials) {
    let rng = mulberry32(12345);
    let hits = 0;
    for (let i = 0; i < trials; i++) {
      if (rollDropTier(levelType, rng) === tier) hits++;
    }
    return hits / trials;
  }
  // Minimal local PRNG (mirrors src/random.js's mulberry32 shape) so this
  // file has no dependency on that module just for a statistical check.
  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const trials = 200000;
  const champCommon = simulateDropRate("champions", "common", trials);
  const champRare = simulateDropRate("champions", "rare", trials);
  const champLegendary = simulateDropRate("champions", "legendary", trials);
  check(`champions common lands close to 30% over ${trials} trials (got ${(champCommon * 100).toFixed(1)}%)`, Math.abs(champCommon - 0.30) < 0.01);
  check(`champions rare lands close to 27% over ${trials} trials (got ${(champRare * 100).toFixed(1)}%)`, Math.abs(champRare - 0.27) < 0.01);
  check(`champions legendary lands close to 3% over ${trials} trials (got ${(champLegendary * 100).toFixed(1)}%)`, Math.abs(champLegendary - 0.03) < 0.01);
}

// ---------- pickItemForTier / rollItemDrop ----------
{
  check("pickItemForTier always returns an item actually in that tier", ["common", "rare", "legendary"].every((tier) => {
    for (let i = 0; i < 50; i++) {
      const key = pickItemForTier(tier, Math.random);
      if (ITEMS[key].tier !== tier) return false;
    }
    return true;
  }));

  check("rollItemDrop returns null when the tier roll misses (normal, high r)", rollItemDrop("normal", sequenceRng([0.5])) === null);
  check("rollItemDrop returns a real common-tier item key when the roll hits common", (() => {
    const key = rollItemDrop("normal", sequenceRng([0.05, 0]));
    return key !== null && ITEMS[key].tier === "common";
  })());
}

// ---------- Backpack: adding, counting, activating ----------
{
  const progress = { ...defaultBackpackState() };
  check("a fresh backpack starts empty", progress.backpack.length === 0 && progress.nextItemInstanceId === 0);

  const first = addDroppedItem(progress, "swiftTonic");
  check("adding a drop appends one instance", progress.backpack.length === 1);
  check("a freshly dropped item starts INACTIVE — collecting must never silently affect combat", first.active === false);
  check("instance ids are assigned sequentially starting at 0", first.instanceId === 0);

  const second = addDroppedItem(progress, "swiftTonic");
  check("a second drop of the SAME item type gets its own distinct instance id", second.instanceId === 1 && second.instanceId !== first.instanceId);
  check("nextItemInstanceId advances past every assigned id", progress.nextItemInstanceId === 2);

  check("countActiveItems is 0 before any activation", countActiveItems(progress) === 0);

  const activateResult = setItemActive(progress, first.instanceId, true);
  check("activating a real instance succeeds", activateResult.ok === true);
  check("countActiveItems reflects the activation", countActiveItems(progress) === 1);
  check("getActiveItemKeys returns the activated item's key", getActiveItemKeys(progress).length === 1 && getActiveItemKeys(progress)[0] === "swiftTonic");

  const deactivateResult = setItemActive(progress, first.instanceId, false);
  check("deactivating succeeds and always does, regardless of capacity", deactivateResult.ok === true && countActiveItems(progress) === 0);

  const unknownResult = setItemActive(progress, 999, true);
  check("activating an unknown instance id fails cleanly instead of throwing", unknownResult.ok === false);

  // Duplicates: two instances of the SAME item, both active — this is the
  // literal mechanism behind "two active +5% items give +10%" from spec.
  setItemActive(progress, first.instanceId, true);
  setItemActive(progress, second.instanceId, true);
  check("two instances of the same item can both be active simultaneously", countActiveItems(progress) === 2);
  check("getActiveItemKeys lists the duplicate key TWICE, not deduplicated", getActiveItemKeys(progress).length === 2 && getActiveItemKeys(progress).every((k) => k === "swiftTonic"));
}

// ---------- MAX_ACTIVE_ITEMS cap ----------
{
  const progress = { ...defaultBackpackState() };
  const instances = [];
  for (let i = 0; i < MAX_ACTIVE_ITEMS; i++) instances.push(addDroppedItem(progress, "ironHide"));
  for (const inst of instances) {
    const result = setItemActive(progress, inst.instanceId, true);
    check(`activation ${inst.instanceId + 1}/${MAX_ACTIVE_ITEMS} succeeds while under the cap`, result.ok === true);
  }
  check(`exactly ${MAX_ACTIVE_ITEMS} items are active after filling the cap`, countActiveItems(progress) === MAX_ACTIVE_ITEMS);

  const seventh = addDroppedItem(progress, "ironHide");
  const overCapResult = setItemActive(progress, seventh.instanceId, true);
  check("activating a 7th item past the cap fails cleanly", overCapResult.ok === false && overCapResult.reason === "backpack full");
  check("the failed activation attempt did not change the active count", countActiveItems(progress) === MAX_ACTIVE_ITEMS);

  // Re-activating an ALREADY-active instance must not be blocked by the
  // cap (it's a no-op on an already-counted slot, not a new claim).
  const reactivate = setItemActive(progress, instances[0].instanceId, true);
  check("re-activating an already-active instance at full capacity still succeeds (not a new slot)", reactivate.ok === true);

  // Freeing a slot makes room for the previously-rejected item.
  setItemActive(progress, instances[0].instanceId, false);
  const retry = setItemActive(progress, seventh.instanceId, true);
  check("after deactivating one item, the previously-rejected item can now activate", retry.ok === true);
}

// ---------- computeItemBonuses: stacking is additive, not compounding ----------
{
  check("no active items -> all bonuses are zero", (() => {
    const b = computeItemBonuses([], "knight");
    return b.attackSpeedPercent === 0 && b.damagePercent === 0 && b.armorFlat === 0 && b.rangeFlat === 0;
  })());

  check("one Swift Tonic active -> +3% attack speed, exactly", approxEqual(computeItemBonuses(["swiftTonic"], "knight").attackSpeedPercent, 0.03));

  // The same additive-not-compounding property the original spec called
  // out, just at the rebalanced +3% magnitude: two active items give
  // +6%, not +6.09% (which is what 1.03*1.03 would imply).
  check("two active Swift Tonics -> +6% attack speed (additive, 0.03+0.03), not compounding", approxEqual(computeItemBonuses(["swiftTonic", "swiftTonic"], "knight").attackSpeedPercent, 0.06));
  check("three active Swift Tonics -> +9% attack speed", approxEqual(computeItemBonuses(["swiftTonic", "swiftTonic", "swiftTonic"], "knight").attackSpeedPercent, 0.09));

  check("Knight's Fury only affects knight scope, not archer or mage", computeItemBonuses(["knightsFury"], "archer").damagePercent === 0 && computeItemBonuses(["knightsFury"], "mage").damagePercent === 0 && approxEqual(computeItemBonuses(["knightsFury"], "knight").damagePercent, 0.12));
  check("Eagle Eye only affects archer scope", computeItemBonuses(["eagleEye"], "knight").rangeFlat === 0 && computeItemBonuses(["eagleEye"], "archer").rangeFlat === 1);
  check("Arcane Haste only affects mage scope", computeItemBonuses(["arcaneHaste"], "archer").attackSpeedPercent === 0 && approxEqual(computeItemBonuses(["arcaneHaste"], "mage").attackSpeedPercent, 0.18));

  check("an 'all' scope item (Iron Hide) affects every defender type", computeItemBonuses(["ironHide"], "knight").armorFlat === 1 && computeItemBonuses(["ironHide"], "archer").armorFlat === 1 && computeItemBonuses(["ironHide"], "mage").armorFlat === 1);

  check("Warlord's Blessing contributes to BOTH damagePercent and attackSpeedPercent from one active instance", (() => {
    const b = computeItemBonuses(["warlordsBlessing"], "knight");
    return approxEqual(b.damagePercent, 0.12) && approxEqual(b.attackSpeedPercent, 0.12);
  })());

  check("mixed active items sum independently per stat", (() => {
    const b = computeItemBonuses(["swiftTonic", "sharpeningStone", "ironHide", "ironHide"], "knight");
    return approxEqual(b.attackSpeedPercent, 0.03) && approxEqual(b.damagePercent, 0.03) && b.armorFlat === 2;
  })());

  check("an unknown item key in the active list is ignored rather than throwing", (() => {
    const b = computeItemBonuses(["notARealItem"], "knight");
    return b.attackSpeedPercent === 0 && b.damagePercent === 0 && b.armorFlat === 0 && b.rangeFlat === 0;
  })());
}

// ---------- applyItemBonuses: applied on top of an already-upgraded stats object ----------
{
  const baseStats = { maxHealth: 150, damageMin: 16, damageMax: 20, attackSpeed: 0.56, armor: 2, range: 1.7 };

  const withNoItems = applyItemBonuses(baseStats, "knight", []);
  check("no active items leaves stats numerically identical to the input", withNoItems.damageMin === baseStats.damageMin && withNoItems.attackSpeed === baseStats.attackSpeed && withNoItems.armor === baseStats.armor);
  check("applyItemBonuses never mutates the object passed in", baseStats.damageMin === 16 && baseStats.attackSpeed === 0.56);

  const withDamage = applyItemBonuses(baseStats, "knight", ["sharpeningStone"]);
  check("+3% damage shifts BOTH damageMin and damageMax by the same fraction", approxEqual(withDamage.damageMin, 16 * 1.03) && approxEqual(withDamage.damageMax, 20 * 1.03));

  const withArmor = applyItemBonuses(baseStats, "knight", ["ironHide", "temperedPlate"]);
  check("flat armor bonuses from multiple active items sum on top of the input armor (2 + 1 + 2 = 5)", withArmor.armor === 5);

  const withRange = applyItemBonuses({ ...baseStats, range: 7 }, "archer", ["eagleEye"]);
  check("flat range bonus applies on top of the input range (7 + 1 = 8)", withRange.range === 8);

  const withAtkSpd = applyItemBonuses(baseStats, "knight", ["swiftTonic", "swiftTonic"]);
  check("attack speed bonus is a direct multiplicative factor on the RATE, matching progression.js's own attackSpeedPercent convention", approxEqual(withAtkSpd.attackSpeed, 0.56 * 1.06));

  // The two-layer design: items apply on top of whatever the caller
  // passes in (already-upgraded stats from getUpgradedStats), so an
  // upgrade's bonus and an item's bonus combine MULTIPLICATIVELY between
  // the two layers even though each layer is additive internally.
  const upgradedAndItemized = applyItemBonuses({ ...baseStats, attackSpeed: 0.56 * 1.30 }, "knight", ["swiftTonic"]);
  check("an item's percent bonus multiplies against an ALREADY-upgraded rate, not the raw base rate", approxEqual(upgradedAndItemized.attackSpeed, 0.56 * 1.30 * 1.03));
}

// ---------- New stat kinds: hpPercent, critChance, lifestealPercent ----------
{
  check("CRIT_DAMAGE_MULTIPLIER is the documented 1.75x", CRIT_DAMAGE_MULTIPLIER === 1.75);

  check("Vitality Draught grants +3% hpPercent to all defenders", approxEqual(computeItemBonuses(["vitalityDraught"], "archer").hpPercent, 0.03));
  check("Lucky Coin grants +3% critChance to all defenders", approxEqual(computeItemBonuses(["luckyCoin"], "mage").critChance, 0.03));
  check("Minor Leech Charm grants +2% lifestealPercent to all defenders", approxEqual(computeItemBonuses(["minorLeechCharm"], "knight").lifestealPercent, 0.02));

  const baseStats = { maxHealth: 150, damageMin: 16, damageMax: 20, attackSpeed: 0.56, armor: 2, range: 1.7 };

  const withHp = applyItemBonuses(baseStats, "knight", ["vitalityDraught"]);
  check("hpPercent multiplies maxHealth the same way damagePercent multiplies damage", approxEqual(withHp.maxHealth, 150 * 1.03));

  check("a single crit item on a base stats object with no prior critChance starts from 0, not NaN/undefined", approxEqual(applyItemBonuses(baseStats, "knight", ["luckyCoin"]).critChance, 0.03));
  check("two active Lucky Coins stack additively (3% + 3% = 6%), not compounding", approxEqual(applyItemBonuses(baseStats, "knight", ["luckyCoin", "luckyCoin"]).critChance, 0.06));

  const withLifesteal = applyItemBonuses(baseStats, "knight", ["minorLeechCharm", "vampiricEdge"]);
  check("lifestealPercent stacks additively across two different items (2% + 5% = 7%)", approxEqual(withLifesteal.lifestealPercent, 0.07));

  check("an item with no hpPercent/critChance/lifestealPercent effect leaves those fields absent on the result (no spurious 0 fields added)", applyItemBonuses(baseStats, "knight", ["ironHide"]).critChance === undefined);
}

// ---------- Global item bonuses (Aegis of the City, Midas' Hoard) ----------
{
  check("no active items -> both global bonuses are zero", (() => {
    const b = computeGlobalItemBonuses([]);
    return b.cityDamageReductionPercent === 0 && b.goldGainPercent === 0;
  })());

  check("Aegis of the City grants +15% cityDamageReductionPercent", approxEqual(computeGlobalItemBonuses(["aegisOfTheCity"]).cityDamageReductionPercent, 0.15));
  check("Midas' Hoard grants +18% goldGainPercent", approxEqual(computeGlobalItemBonuses(["midasHoard"]).goldGainPercent, 0.18));
  check("two Aegis of the City instances stack additively (15% + 15% = 30%)", approxEqual(computeGlobalItemBonuses(["aegisOfTheCity", "aegisOfTheCity"]).cityDamageReductionPercent, 0.30));

  check("global-scoped items contribute NOTHING to computeItemBonuses for any real unit type", (() => {
    const b = computeItemBonuses(["aegisOfTheCity", "midasHoard"], "knight");
    return b.attackSpeedPercent === 0 && b.damagePercent === 0 && b.hpPercent === 0 && b.armorFlat === 0 && b.rangeFlat === 0 && b.critChance === 0 && b.lifestealPercent === 0;
  })());

  check("per-unit-scoped items contribute NOTHING to computeGlobalItemBonuses", (() => {
    const b = computeGlobalItemBonuses(["warlordsBlessing", "knightsFury"]);
    return b.cityDamageReductionPercent === 0 && b.goldGainPercent === 0;
  })());
}

console.log(`\n${failures} failure(s).`);
if (failures > 0) process.exit(1);
console.log("All item-system checks passed.");
