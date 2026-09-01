// Item drop system: raiders have a chance to drop a collectible item on
// death in combat (NOT when a raider reaches the city — see main.js's
// applyDamage, the only call site that rolls a drop, deliberately never
// applyCityArrival). Dropped items sit in a persistent backpack (part of
// PROGRESS, see progression.js); the player activates up to
// MAX_ACTIVE_ITEMS of them, and ONLY active items affect combat. Pure
// logic + no Three.js/DOM dependency, same separation as progression.js,
// so this is directly unit-testable (test-items.mjs) and reusable from
// main.js without dragging in rendering code.

export const ITEM_TIERS = ["common", "rare", "legendary"];

export const MAX_ACTIVE_ITEMS = 6;

// A hit that rolls a crit deals this much of its normal damage instead of
// 1x — one flat, fixed multiplier for every source of crit chance, so an
// item only ever needs to grant a CHANCE, never define its own multiplier
// (keeps every crit item directly comparable in power).
export const CRIT_DAMAGE_MULTIPLIER = 1.75;

// Every item's effect is one or more {scope, stat, amount} entries.
//   scope: "all" | "knight" | "archer" | "mage" — which defender type(s)
//     this effect applies to ("all" means every defender type) — OR
//     "global", for the two account-wide effects that aren't about any
//     one unit type at all (cityDamageReductionPercent, goldGainPercent).
//   stat:  "attackSpeedPercent" | "damagePercent" | "hpPercent" |
//     "armorFlat" | "rangeFlat" | "critChance" | "lifestealPercent"
//     (per-unit-type stats, scope "all"/"knight"/"archer"/"mage") OR
//     "cityDamageReductionPercent" | "goldGainPercent" (global stats,
//     scope "global" only — see computeGlobalItemBonuses).
//   amount: a raw fraction for every "...Percent"/"...Chance" stat
//     (0.05 = +5%), or a flat number for the two "...Flat" stats.
// Percent/chance stats stack ADDITIVELY across every ACTIVE item that
// grants them — matching every permanent upgrade's own additive-not-
// compounding design (see progression.js's attackSpeedPercent) — so two
// independent +5% items sum to a flat +10% bonus, never *1.05*1.05. This
// holds even for two copies of the exact same item (see
// computeItemBonuses): each ACTIVE INSTANCE contributes its effect
// independently, so owning and activating two "Swift Tonic"s really does
// give +10%, per spec.
//
// 30 items total, 10 per tier — designed as a coherent power curve, not
// just 30 random numbers: Commons are a single small (+3%, or +5% when
// scoped to one class) bonus; Rares are either one bigger single-class
// bonus or two smaller bonuses that reinforce one playstyle (e.g. an
// Archer item pairing damage with range); Legendaries are either a big
// dual/triple-stat "build-defining" bonus, a class "ultimate", or one of
// the two global effects (Aegis of the City, Midas' Hoard) that don't
// touch per-unit combat stats at all, giving the rarest tier some real
// variety beyond "a bigger version of a rare."
//
// Rebalance pass (explicit request): every effect amount cut 25%-50% from
// its original value, landing on a round whole-percent/whole-flat number —
// no decimal percentages, no fractional armor/range. The mechanical rule
// used throughout was a flat x0.6 (40% cut) on every percent stat, which
// is exact for any value that was already a multiple of 5 (5->3, 10->6,
// 15->9, 20->12, 25->15, 30->18, 35->21). Three raw values weren't
// multiples of 5 and needed a different, still-in-range cut to land clean:
// 3%->2% (33% cut), 8%->5% (37.5% cut), 12%->6% (50% cut, the window's
// edge). Flat armor/range effects were cut the same way wherever a clean
// smaller integer exists (2->1, 3->2, 6->4). A flat "+1" (armorFlat or
// rangeFlat) has no valid 25%-50%-cut integer above zero — cutting it
// would either erase the item's entire effect (0) or require a decimal
// (0.5-0.75), both of which violate the "round nice number" requirement —
// so those five items (ironHide, eagleEye, archersPrecision's range,
// rangersMark's range, guardiansWard's flat side was armor not range so it
// WAS cut) were left untouched rather than broken. CRIT_DAMAGE_MULTIPLIER
// above is a systemic constant, not any one item's effect amount, and is
// out of scope for this pass.
export const ITEMS = {
  // ---------- Common (10) ----------
  swiftTonic: {
    id: "swiftTonic",
    label: "Swift Tonic",
    tier: "common",
    description: "+3% attack speed for all defenders.",
    effects: [{ scope: "all", stat: "attackSpeedPercent", amount: 0.03 }],
  },
  sharpeningStone: {
    id: "sharpeningStone",
    label: "Sharpening Stone",
    tier: "common",
    description: "+3% damage for all defenders.",
    effects: [{ scope: "all", stat: "damagePercent", amount: 0.03 }],
  },
  ironHide: {
    id: "ironHide",
    label: "Iron Hide",
    tier: "common",
    // +1 is already the smallest meaningful armor step — no 25%-50% cut
    // lands on a clean positive integer, so left unchanged (see the
    // rebalance-pass note above ITEMS).
    description: "+1 armor for all defenders.",
    effects: [{ scope: "all", stat: "armorFlat", amount: 1 }],
  },
  vitalityDraught: {
    id: "vitalityDraught",
    label: "Vitality Draught",
    tier: "common",
    description: "+3% HP for all defenders.",
    effects: [{ scope: "all", stat: "hpPercent", amount: 0.03 }],
  },
  luckyCoin: {
    id: "luckyCoin",
    label: "Lucky Coin",
    tier: "common",
    description: "+3% critical hit chance for all defenders.",
    effects: [{ scope: "all", stat: "critChance", amount: 0.03 }],
  },
  minorLeechCharm: {
    id: "minorLeechCharm",
    label: "Minor Leech Charm",
    tier: "common",
    description: "Heals all defenders for 2% of the damage they deal.",
    effects: [{ scope: "all", stat: "lifestealPercent", amount: 0.02 }],
  },
  eagleEye: {
    id: "eagleEye",
    label: "Eagle Eye",
    tier: "common",
    // Same "+1 has no clean cut" reasoning as Iron Hide above.
    description: "+1 range for Archers.",
    effects: [{ scope: "archer", stat: "rangeFlat", amount: 1 }],
  },
  paddedBoots: {
    id: "paddedBoots",
    label: "Padded Boots",
    tier: "common",
    description: "+1 armor for Archers.",
    effects: [{ scope: "archer", stat: "armorFlat", amount: 1 }],
  },
  knightsWhetstone: {
    id: "knightsWhetstone",
    label: "Knight's Whetstone",
    tier: "common",
    description: "+5% damage for Knights.",
    effects: [{ scope: "knight", stat: "damagePercent", amount: 0.05 }],
  },
  apprenticesFocus: {
    id: "apprenticesFocus",
    label: "Apprentice's Focus",
    tier: "common",
    description: "+5% attack speed for Mages.",
    effects: [{ scope: "mage", stat: "attackSpeedPercent", amount: 0.05 }],
  },

  // ---------- Rare (10) ----------
  knightsFury: {
    id: "knightsFury",
    label: "Knight's Fury",
    tier: "rare",
    description: "+12% damage for Knights.",
    effects: [{ scope: "knight", stat: "damagePercent", amount: 0.12 }],
  },
  arcaneHaste: {
    id: "arcaneHaste",
    label: "Arcane Haste",
    tier: "rare",
    description: "+18% attack speed for Mages.",
    effects: [{ scope: "mage", stat: "attackSpeedPercent", amount: 0.18 }],
  },
  temperedPlate: {
    id: "temperedPlate",
    label: "Tempered Plate",
    tier: "rare",
    description: "+2 armor for all defenders.",
    effects: [{ scope: "all", stat: "armorFlat", amount: 2 }],
  },
  archersPrecision: {
    id: "archersPrecision",
    label: "Archer's Precision",
    tier: "rare",
    // The range side stays at +1 — no clean 25%-50% cut exists for it (see
    // the rebalance-pass note above ITEMS); only the damage side was cut.
    description: "+9% damage and +1 range for Archers.",
    effects: [
      { scope: "archer", stat: "damagePercent", amount: 0.09 },
      { scope: "archer", stat: "rangeFlat", amount: 1 },
    ],
  },
  berserkersRage: {
    id: "berserkersRage",
    label: "Berserker's Rage",
    tier: "rare",
    description: "+9% attack speed and +6% damage for Knights.",
    effects: [
      { scope: "knight", stat: "attackSpeedPercent", amount: 0.09 },
      { scope: "knight", stat: "damagePercent", amount: 0.06 },
    ],
  },
  vampiricEdge: {
    id: "vampiricEdge",
    label: "Vampiric Edge",
    tier: "rare",
    description: "Heals all defenders for 5% of the damage they deal.",
    effects: [{ scope: "all", stat: "lifestealPercent", amount: 0.05 }],
  },
  criticalFocus: {
    id: "criticalFocus",
    label: "Critical Focus",
    tier: "rare",
    description: "+9% critical hit chance for all defenders.",
    effects: [{ scope: "all", stat: "critChance", amount: 0.09 }],
  },
  frostAmplifier: {
    id: "frostAmplifier",
    label: "Frost Amplifier",
    tier: "rare",
    description: "+6% damage and +6% critical hit chance for Mages.",
    effects: [
      { scope: "mage", stat: "damagePercent", amount: 0.06 },
      { scope: "mage", stat: "critChance", amount: 0.06 },
    ],
  },
  rangersMark: {
    id: "rangersMark",
    label: "Ranger's Mark",
    tier: "rare",
    // The range side stays at +1 — same reasoning as Archer's Precision.
    description: "+6% critical hit chance and +1 range for Archers.",
    effects: [
      { scope: "archer", stat: "critChance", amount: 0.06 },
      { scope: "archer", stat: "rangeFlat", amount: 1 },
    ],
  },
  guardiansWard: {
    id: "guardiansWard",
    label: "Guardian's Ward",
    tier: "rare",
    description: "+9% HP and +1 armor for Knights.",
    effects: [
      { scope: "knight", stat: "hpPercent", amount: 0.09 },
      { scope: "knight", stat: "armorFlat", amount: 1 },
    ],
  },

  // ---------- Legendary (10) ----------
  warlordsBlessing: {
    id: "warlordsBlessing",
    label: "Warlord's Blessing",
    tier: "legendary",
    description: "+12% damage and +12% attack speed for all defenders.",
    effects: [
      { scope: "all", stat: "damagePercent", amount: 0.12 },
      { scope: "all", stat: "attackSpeedPercent", amount: 0.12 },
    ],
  },
  titansBulwark: {
    id: "titansBulwark",
    label: "Titan's Bulwark",
    tier: "legendary",
    description: "+12% HP and +4 armor for all defenders.",
    effects: [
      { scope: "all", stat: "hpPercent", amount: 0.12 },
      { scope: "all", stat: "armorFlat", amount: 4 },
    ],
  },
  executionersMark: {
    id: "executionersMark",
    label: "Executioner's Mark",
    tier: "legendary",
    description: "+15% critical hit chance and +6% damage for all defenders.",
    effects: [
      { scope: "all", stat: "critChance", amount: 0.15 },
      { scope: "all", stat: "damagePercent", amount: 0.06 },
    ],
  },
  bloodthirster: {
    id: "bloodthirster",
    label: "Bloodthirster",
    tier: "legendary",
    description: "Heals all defenders for 12% of the damage they deal.",
    effects: [{ scope: "all", stat: "lifestealPercent", amount: 0.12 }],
  },
  sunreaversEdge: {
    id: "sunreaversEdge",
    label: "Sunreaver's Edge",
    tier: "legendary",
    description: "+21% damage and +9% attack speed for Knights.",
    effects: [
      { scope: "knight", stat: "damagePercent", amount: 0.21 },
      { scope: "knight", stat: "attackSpeedPercent", amount: 0.09 },
    ],
  },
  stormcallersBow: {
    id: "stormcallersBow",
    label: "Stormcaller's Bow",
    tier: "legendary",
    description: "+12% damage, +12% attack speed, and +1 range for Archers.",
    effects: [
      { scope: "archer", stat: "damagePercent", amount: 0.12 },
      { scope: "archer", stat: "attackSpeedPercent", amount: 0.12 },
      { scope: "archer", stat: "rangeFlat", amount: 1 },
    ],
  },
  archmagesGrimoire: {
    id: "archmagesGrimoire",
    label: "Archmage's Grimoire",
    tier: "legendary",
    description: "+18% damage, +9% attack speed, and +9% critical hit chance for Mages.",
    effects: [
      { scope: "mage", stat: "damagePercent", amount: 0.18 },
      { scope: "mage", stat: "attackSpeedPercent", amount: 0.09 },
      { scope: "mage", stat: "critChance", amount: 0.09 },
    ],
  },
  phoenixHeart: {
    id: "phoenixHeart",
    label: "Phoenix Heart",
    tier: "legendary",
    description: "+9% HP and heals all defenders for 6% of the damage they deal.",
    effects: [
      { scope: "all", stat: "hpPercent", amount: 0.09 },
      { scope: "all", stat: "lifestealPercent", amount: 0.06 },
    ],
  },
  aegisOfTheCity: {
    id: "aegisOfTheCity",
    label: "Aegis of the City",
    tier: "legendary",
    description: "Raiders that reach the city deal 15% less damage to it.",
    effects: [{ scope: "global", stat: "cityDamageReductionPercent", amount: 0.15 }],
  },
  midasHoard: {
    id: "midasHoard",
    label: "Midas' Hoard",
    tier: "legendary",
    description: "+18% Gold earned from clearing a level.",
    effects: [{ scope: "global", stat: "goldGainPercent", amount: 0.18 }],
  },
};

export const ITEM_KEYS = Object.keys(ITEMS);

// Drop chance per raider death, keyed by LEVEL TYPE only (see
// progression.js's LEVEL_TYPES) — deliberately unaffected by level SPEC
// (Flying/Evasion/Pierce Resistance/Rush): drop rate is about how tough a
// wave's raiders were to kill, which is entirely a type property, not a
// spec one. Each tier's probability is a flat, independent slice of a
// SINGLE roll (see rollDropTier), so these numbers are exactly what they
// say: Normal is "6% common, 0.6% rare" (6.6% total drop chance), Boss is
// "6% common, 48% rare, 6% legendary" (60% total). Level types not listed
// here (there are none currently missing) would fall back to "normal"'s
// table.
//
// Rebalance pass (explicit request): every table cut by a flat 40% (x0.6)
// from its original value — "reduce drop rate by 40% across the board"
// applied literally to every entry, not just the totals. One real
// consequence worth flagging: Boss used to sum to exactly 100% (a Boss
// kill was GUARANTEED to drop something — see the git history/old
// comment here); at x0.6 that guarantee is gone (0.06+0.48+0.06=0.60, so
// a Boss kill now has a real 40% chance of no drop). This wasn't
// preserved as a special case — the request was uniform, and re-inflating
// just Boss's numbers to keep the old 100% guarantee would have meant NOT
// actually cutting Boss by 40% like every other type.
export const DROP_TABLES = {
  normal: { common: 0.06, rare: 0.006, legendary: 0 },
  mass: { common: 0.018, rare: 0, legendary: 0 },
  champions: { common: 0.30, rare: 0.27, legendary: 0.03 },
  boss: { common: 0.06, rare: 0.48, legendary: 0.06 },
};

// Single roll, checked rarest-first against cumulative thresholds — this
// is what makes the table's numbers literal flat probabilities rather
// than compounding conditional ones (three independent rng() checks, one
// per tier, would NOT reproduce "50/45/5" for Champions: missing the 5%
// legendary roll and then missing the 45% rare roll before even checking
// common would leave common's real hit rate well under 50%). One rng()
// draw, one partition, exactly matches the spec.
export function rollDropTier(levelType, rng = Math.random) {
  const table = DROP_TABLES[levelType] || DROP_TABLES.normal;
  const r = rng();
  let cumulative = table.legendary;
  if (r < cumulative) return "legendary";
  cumulative += table.rare;
  if (r < cumulative) return "rare";
  cumulative += table.common;
  if (r < cumulative) return "common";
  return null;
}

// Picks a uniformly-random item within one tier. Returns null only if a
// tier somehow has zero items defined (not currently possible — every
// tier in ITEM_TIERS has 10 entries in ITEMS).
export function pickItemForTier(tier, rng = Math.random) {
  const pool = ITEM_KEYS.filter((k) => ITEMS[k].tier === tier);
  if (pool.length === 0) return null;
  const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[idx];
}

// Full drop roll for one raider death: which tier (if any), then which
// specific item within that tier. Two rng() draws when a drop happens
// (tier, then item), zero when it doesn't — same "consume rng only as
// needed" shape as progression.js's pickRandomLevelType.
export function rollItemDrop(levelType, rng = Math.random) {
  const tier = rollDropTier(levelType, rng);
  if (!tier) return null;
  return pickItemForTier(tier, rng);
}

// ---------- Backpack (persisted inside PROGRESS — see progression.js) ----------
// Items are tracked as individual INSTANCES, not just counts per item
// type — this is what lets two copies of the same item both be activated
// for a doubled effect (per spec), since each instance carries its own
// independent active flag. main.js's backpack panel GROUPS instances by
// itemKey for display (a stacked "Swift Tonic ×3" row with a simple
// activate-one/deactivate-one stepper) but the underlying data model here
// never merges them — each instance is still activated/deactivated
// individually via its own instanceId.
export function defaultBackpackState() {
  return { backpack: [], nextItemInstanceId: 0 };
}

// Adds a freshly-dropped item instance, inactive by default — a new drop
// must never silently start affecting an already-running battle just by
// landing in the backpack; the player has to explicitly activate it (and,
// per the phase-gating main.js applies, only between battles).
export function addDroppedItem(progress, itemKey) {
  const instance = { instanceId: progress.nextItemInstanceId, itemKey, active: false };
  progress.nextItemInstanceId += 1;
  progress.backpack.push(instance);
  return instance;
}

export function countActiveItems(progress) {
  return progress.backpack.filter((i) => i.active).length;
}

// Activates or deactivates one item instance. Deactivating always
// succeeds; activating past MAX_ACTIVE_ITEMS fails cleanly ({ok:false},
// mirroring purchaseUpgrade's shape) rather than silently over-capping —
// main.js's UI is expected to disable the control preemptively once full,
// but this is the authoritative check either way.
export function setItemActive(progress, instanceId, active) {
  const instance = progress.backpack.find((i) => i.instanceId === instanceId);
  if (!instance) return { ok: false, reason: "unknown item instance" };
  if (active && !instance.active && countActiveItems(progress) >= MAX_ACTIVE_ITEMS) {
    return { ok: false, reason: "backpack full" };
  }
  instance.active = active;
  return { ok: true };
}

// The list of item KEYS (with duplicates — one entry per active instance,
// see the stacking note on ITEMS above) currently affecting combat.
export function getActiveItemKeys(progress) {
  return progress.backpack.filter((i) => i.active).map((i) => i.itemKey);
}

// ---------- Applying item effects to combat stats ----------
// Sums every matching effect from every entry in `activeItemKeys` (which
// may contain the same key more than once — see getActiveItemKeys) for
// one specific defender unitType, independently per stat. Percent/chance
// stats stay as raw fractions for the caller to apply multiplicatively
// against base, exactly like progression.js's getUpgradeBonus for
// attackSpeedPercent. "global"-scoped effects (see computeGlobalItemBonuses)
// are never matched here — `eff.scope !== "all" && eff.scope !== unitType`
// is true for scope "global" against any real unitType, so they're
// silently skipped without needing a special case.
export function computeItemBonuses(activeItemKeys, unitType) {
  const bonuses = { attackSpeedPercent: 0, damagePercent: 0, hpPercent: 0, armorFlat: 0, rangeFlat: 0, critChance: 0, lifestealPercent: 0 };
  for (const key of activeItemKeys) {
    const item = ITEMS[key];
    if (!item) continue;
    for (const eff of item.effects) {
      if (eff.scope !== "all" && eff.scope !== unitType) continue;
      bonuses[eff.stat] += eff.amount;
    }
  }
  return bonuses;
}

// The two account-wide effects that aren't about any one defender type —
// Aegis of the City (reduces city damage taken) and Midas' Hoard
// (increases Gold earned) — summed the same additive way as every other
// stat, just scoped "global" instead of a unit type. main.js reads this
// once (recomputed whenever active items change, same as effectiveStats)
// and applies cityDamageReductionPercent in applyCityArrival and
// goldGainPercent in endBattle's reward calculation.
export function computeGlobalItemBonuses(activeItemKeys) {
  const bonuses = { cityDamageReductionPercent: 0, goldGainPercent: 0 };
  for (const key of activeItemKeys) {
    const item = ITEMS[key];
    if (!item) continue;
    for (const eff of item.effects) {
      if (eff.scope !== "global") continue;
      bonuses[eff.stat] += eff.amount;
    }
  }
  return bonuses;
}

// Applies one unit type's aggregated item bonuses on top of an
// ALREADY-upgraded stats object (see progression.js's getUpgradedStats) —
// items are a second, independent power layer on top of permanent
// upgrades, combined MULTIPLICATIVELY between the two layers (each layer
// additive internally). This is the same two-layer shape getWaveStats
// already uses for raider evolution x wave-type, just applied to
// defenders instead of raiders. Never mutates the object passed in.
// critChance/lifestealPercent default to 0 on the base stats object (no
// upgrade or base stat currently grants either), so they're added
// directly rather than multiplied against an existing value.
export function applyItemBonuses(stats, unitType, activeItemKeys) {
  const bonuses = computeItemBonuses(activeItemKeys, unitType);
  const result = { ...stats };
  if (bonuses.attackSpeedPercent) result.attackSpeed = stats.attackSpeed * (1 + bonuses.attackSpeedPercent);
  if (bonuses.damagePercent) {
    result.damageMin = stats.damageMin * (1 + bonuses.damagePercent);
    result.damageMax = stats.damageMax * (1 + bonuses.damagePercent);
  }
  if (bonuses.hpPercent) result.maxHealth = stats.maxHealth * (1 + bonuses.hpPercent);
  if (bonuses.armorFlat) result.armor = stats.armor + bonuses.armorFlat;
  if (bonuses.rangeFlat) result.range = stats.range + bonuses.rangeFlat;
  if (bonuses.critChance) result.critChance = (stats.critChance || 0) + bonuses.critChance;
  if (bonuses.lifestealPercent) result.lifestealPercent = (stats.lifestealPercent || 0) + bonuses.lifestealPercent;
  return result;
}
