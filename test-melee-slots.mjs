// Standalone test for src/meleeSlots.js — run with: node test-melee-slots.mjs
// Pure geometry, no game-object dependency: verifies slots are correctly
// sized from real collision radii, assigned to maximize spread (not bunch
// attackers on one side), and world positions land exactly on the ring.

import { computeSlotRing, pickBestFreeSlot, angularSlotDistance, slotWorldPosition, computeCanEngage } from "./src/meleeSlots.js";
import { computeCollisionRadius, UNIT_STATS } from "./src/unit.js";

let failures = 0;
function check(label, cond) {
  if (!cond) { failures++; console.error(`FAIL: ${label}`); }
  else console.log(`OK: ${label}`);
}

// A Knight-sized target (collisionRadius ~0.75) should fit several raiders around it.
const ring = computeSlotRing(0.75, 0.6);
check("ring has a positive radius", ring.ringRadius > 0);
check("ring fits at least 4 attackers", ring.count >= 4);

// Sequential assignment should spread attackers, not bunch them.
const occupied = new Array(ring.count).fill(false);
const assigned = [];
for (let i = 0; i < 3; i++) {
  const idx = pickBestFreeSlot(occupied);
  check(`slot ${i} assigned (not -1)`, idx !== -1);
  occupied[idx] = true;
  assigned.push(idx);
}
// With 3 attackers on say a 7-slot ring, they should NOT all be adjacent —
// check the minimum pairwise angular distance is reasonably large.
let minPairDist = Infinity;
for (let i = 0; i < assigned.length; i++) {
  for (let j = i + 1; j < assigned.length; j++) {
    minPairDist = Math.min(minPairDist, angularSlotDistance(assigned[i], assigned[j], ring.count));
  }
}
check(`3 attackers spread out (min pairwise slot distance ${minPairDist} >= 2 on a ${ring.count}-slot ring)`, minPairDist >= 2);

// Filling every slot should leave none free.
const full = new Array(ring.count).fill(true);
check("no free slot when ring is full", pickBestFreeSlot(full) === -1);

// World positions should actually land on the ring (correct distance from center).
const target = { x: 10, z: -5 };
const pos = slotWorldPosition(target, ring.ringRadius, 0, ring.count);
const actualDist = Math.hypot(pos.x - target.x, pos.z - target.z);
check(`slot world position is exactly ringRadius from target (${actualDist.toFixed(4)} vs ${ring.ringRadius.toFixed(4)})`, Math.abs(actualDist - ring.ringRadius) < 1e-9);

// Two different indices should give two different positions (no accidental collapse).
const posA = slotWorldPosition(target, ring.ringRadius, 0, ring.count);
const posB = slotWorldPosition(target, ring.ringRadius, 1, ring.count);
check("distinct slot indices give distinct positions", posA.x !== posB.x || posA.z !== posB.z);

// ---- Regression test: the ring-radius bug ----
// Real bug found via user report: a Knight's ring (target radius ~0.75,
// attacker estimate 0.6) came out to ~1.5, but a Raider's actual attack
// range is only 1.3 — meaning a raider parked exactly on its assigned slot
// could never actually be within its own attack range, appearing "stuck
// right next to the defender" without attacking. The fix caps ring radius
// via an explicit maxRadius option. Verify the cap actually holds and
// that slot count is recomputed against the CAPPED radius (not stale).
const RAIDER_RANGE = 1.3;
const uncappedRing = computeSlotRing(0.75, 0.6);
check(
  `sanity check: reproduces the bug scenario (uncapped ring ${uncappedRing.ringRadius.toFixed(3)} > Raider range ${RAIDER_RANGE})`,
  uncappedRing.ringRadius > RAIDER_RANGE
);

const cap = RAIDER_RANGE - 0.1;
const cappedRing = computeSlotRing(0.75, 0.6, { maxRadius: cap });
check(`capped ring radius respects the cap (${cappedRing.ringRadius.toFixed(3)} <= ${cap})`, cappedRing.ringRadius <= cap + 1e-9);
check(`capped ring radius is within Raider's actual range (${cappedRing.ringRadius.toFixed(3)} < ${RAIDER_RANGE})`, cappedRing.ringRadius < RAIDER_RANGE);
// Slot count must reflect the capped (smaller) circumference, not the
// original uncapped one — otherwise slots would be packed too tightly.
const expectedCappedCount = Math.max(2, Math.floor((2 * Math.PI * cappedRing.ringRadius) / (0.6 * 2 + 0.1)));
check(`slot count recomputed against the capped radius (${cappedRing.count} vs expected ${expectedCappedCount})`, cappedRing.count === expectedCappedCount);
check(`capped ring has fewer (or equal) slots than uncapped (${cappedRing.count} <= ${uncappedRing.count})`, cappedRing.count <= uncappedRing.count);

console.log(`\n${failures} failure(s).`);
if (failures > 0) process.exit(1);
console.log("All melee-slot geometry checks passed.");

// ---- computeCanEngage regression coverage ----
// This is the exact function where a real, severe regression happened: a
// refactor left stationary melee units (Knights) permanently unable to
// engage, because the "does this unit need a slot" check only exempted
// ranged units and forgot stationary ones. Knights never attempt slot
// reservation in the first place (they don't move to reach one), so they
// could never satisfy "has a slot" either — canEngage was always false,
// and Knights stood next to raiders forever without ever attacking.
// Exhaustive coverage of all four (ranged x stationary) combinations,
// specifically so this exact bug class cannot silently reappear.
function checkEngage(label, args, expected) {
  const result = computeCanEngage(args);
  check(`${label}: expected ${expected}, got ${result}`, result === expected);
}

// Knight: melee, stationary. Must be able to engage in range WITHOUT a
// slot — this is the precise case that regressed.
checkEngage("Knight (melee, stationary) in range, no slot", { ranged: false, stationary: true, withinRange: true, cliffBlocked: false, hasSlot: false }, true);
checkEngage("Knight in range, WITH a slot too (should still work)", { ranged: false, stationary: true, withinRange: true, cliffBlocked: false, hasSlot: true }, true);
checkEngage("Knight out of range", { ranged: false, stationary: true, withinRange: false, cliffBlocked: false, hasSlot: false }, false);
checkEngage("Knight in range but cliff-blocked", { ranged: false, stationary: true, withinRange: true, cliffBlocked: true, hasSlot: false }, false);

// Archer: ranged, stationary. Must engage in range regardless of slot
// (ranged units never compete for slots at all).
checkEngage("Archer (ranged, stationary) in range, no slot", { ranged: true, stationary: true, withinRange: true, cliffBlocked: false, hasSlot: false }, true);
checkEngage("Archer out of range", { ranged: true, stationary: true, withinRange: false, cliffBlocked: false, hasSlot: false }, false);

// Raider: melee, mobile. Must ONLY engage in range if it actually holds a
// slot — this is the one combination where "no slot" should legitimately
// block engagement (that's the whole point of the attack-slot system).
checkEngage("Raider (melee, mobile) in range WITH a slot", { ranged: false, stationary: false, withinRange: true, cliffBlocked: false, hasSlot: true }, true);
checkEngage("Raider (melee, mobile) in range WITHOUT a slot", { ranged: false, stationary: false, withinRange: true, cliffBlocked: false, hasSlot: false }, false);
checkEngage("Raider out of range even with a slot", { ranged: false, stationary: false, withinRange: false, cliffBlocked: false, hasSlot: true }, false);

// Catapult: ranged, mobile. Must engage in range regardless of slot, same
// as any ranged unit.
checkEngage("Catapult (ranged, mobile) in range, no slot", { ranged: true, stationary: false, withinRange: true, cliffBlocked: false, hasSlot: false }, true);

// Flying-target immunity (added for the Flying wave type): a melee
// attacker can NEVER engage a flying target, full stop, regardless of
// range/slot/cliff-blocking — there's no "close enough" for a ground
// melee unit to reach something airborne. A ranged attacker (Archer)
// is completely unaffected and engages a flying target exactly like any
// other ranged target. Every melee case above is re-run here with
// targetIsFlying:true to confirm it's now unconditionally blocked, and
// the ranged case confirms flying targets are ordinary business for
// ranged attackers.
checkEngage("Knight (melee, stationary) vs flying target, otherwise-perfect conditions -> still blocked", { ranged: false, stationary: true, withinRange: true, cliffBlocked: false, hasSlot: false, targetIsFlying: true }, false);
checkEngage("Raider (melee, mobile) vs flying target WITH a slot -> still blocked (melee just can't reach flying, slot or not)", { ranged: false, stationary: false, withinRange: true, cliffBlocked: false, hasSlot: true, targetIsFlying: true }, false);
checkEngage("Archer (ranged, stationary) vs flying target, in range -> engages normally, unaffected by the flying rule", { ranged: true, stationary: true, withinRange: true, cliffBlocked: false, hasSlot: false, targetIsFlying: true }, true);
checkEngage("Catapult (ranged, mobile) vs flying target, in range -> engages normally", { ranged: true, stationary: false, withinRange: true, cliffBlocked: false, hasSlot: false, targetIsFlying: true }, true);
checkEngage("targetIsFlying defaults to false when omitted (existing call sites keep working unchanged)", { ranged: false, stationary: true, withinRange: true, cliffBlocked: false, hasSlot: false }, true);

console.log(`\n${failures} failure(s) after computeCanEngage coverage.`);
if (failures > 0) process.exit(1);
console.log("All computeCanEngage regression checks passed.");

// ---- Slot capacity increase (explicit request: "increase spots per defender") ----
// main.js tightened MELEE_ATTACKER_RADIUS_ESTIMATE from 0.6 to 0.4 to fit
// more attackers per ring. Verify this actually increases capacity for the
// real game scenario (Knight-sized target, capped by Raider's range).
const RAIDER_RANGE_2 = 1.3;
const cap2 = RAIDER_RANGE_2 - 0.1;
const oldCapacityRing = computeSlotRing(0.75, 0.6, { maxRadius: cap2 });
const newCapacityRing = computeSlotRing(0.75, 0.4, { maxRadius: cap2 });
console.log(`\nSlot capacity: old estimate (0.6) = ${oldCapacityRing.count} slots, new estimate (0.4) = ${newCapacityRing.count} slots`);
if (newCapacityRing.count <= oldCapacityRing.count) {
  console.error(`FAIL: expected the tightened estimate to increase capacity, got ${newCapacityRing.count} <= ${oldCapacityRing.count}`);
  process.exit(1);
}
console.log("Capacity increase confirmed.");

// ---- Real bug regression: melee ring must scale with the ACTUAL
// attacking raider's size, not a fixed guess ----
// A real, reported bug: main.js used to size the melee ring around a
// fixed MELEE_ATTACKER_RADIUS_ESTIMATE (0.4), regardless of how big the
// actual attacking raider was. That's fine for the base raider (whose
// real collision radius, computed below, happens to be close to 0.4) but
// badly wrong for size-scaled wave types (Champions sizeMultiplier 1.3,
// Boss 1.8) — their real physical bulk vastly exceeded what the ring
// assumed, so their own separation/collision resolution (which DOES use
// their real, larger radius) kept shoving them back out of their
// assigned slot before they could ever get within actual attack range.
// Symptom reported directly: Boss "tries to attack but deals no damage"
// (worst mismatch), Champions "struggle to get in place" but eventually
// succeed (smaller mismatch). Fixed by computing the estimate from the
// real per-level attacker stats (computeCollisionRadius) instead of a
// constant — this verifies that fix holds across every wave-type size,
// not just the base case.
{
  const baseRaiderSize = UNIT_STATS.raider.size; // [0.9, 1.2, 0.9]
  const knightCollisionRadius = computeCollisionRadius(UNIT_STATS.knight);
  const raiderRange = UNIT_STATS.raider.range; // 1.3 — never changed by wave type or evolution
  const maxRadius = raiderRange - 0.1; // the real MELEE_RING_MAX_RADIUS formula

  function radiusForSizeMultiplier(mult) {
    const [w, h, d] = baseRaiderSize;
    return computeCollisionRadius({ size: [w * mult, h * mult, d * mult] });
  }

  const normalRadius = radiusForSizeMultiplier(1); // Normal/base raider
  const championsRadius = radiusForSizeMultiplier(1.3); // WAVE_TYPES.champions.sizeMultiplier
  const bossRadius = radiusForSizeMultiplier(1.8); // WAVE_TYPES.boss.sizeMultiplier

  check("Champions' real collision radius is meaningfully bigger than the base raider's", championsRadius > normalRadius * 1.2);
  check("Boss's real collision radius is meaningfully bigger than Champions'", bossRadius > championsRadius * 1.3);

  // The actual regression: for EVERY size, a unit standing exactly at its
  // assigned slot (ringRadius from target center) must be within real
  // attack range — this is the property that was already correctly
  // protected for the TARGET's size (see meleeSlots.js's own comment
  // history) but not for the ATTACKER's size until this fix.
  for (const [label, radius] of [["Normal", normalRadius], ["Champions", championsRadius], ["Boss", bossRadius]]) {
    const ring = computeSlotRing(knightCollisionRadius, radius, { maxRadius });
    check(`${label}-sized attacker: assigned slot (ring radius ${ring.ringRadius.toFixed(3)}) is within actual attack range (${raiderRange})`, ring.ringRadius <= raiderRange);
    check(`${label}-sized attacker: ring produces at least 1 usable slot`, ring.count >= 1);
  }

  // Confirm the OLD fixed-0.4 estimate really was a meaningful
  // underestimate for Boss specifically (quantifying the bug, not just
  // asserting a fix exists) — this is what caused the assigned slot to be
  // too tight for the Boss's real body to occupy without being pushed
  // back out by its own collision resolution.
  const OLD_FIXED_ESTIMATE = 0.4;
  check("the old fixed 0.4 estimate was a real, significant underestimate of the Boss's actual size (confirming the bug's root cause, not just its fix)", bossRadius > OLD_FIXED_ESTIMATE * 2);
}

