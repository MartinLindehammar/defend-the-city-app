// Attack-slot system: the standard fix for "many attackers crowding one
// target" in real-time games. Instead of letting units react to each other
// moment-to-moment (which can never fully resolve if more units want space
// than physically fits — that's what caused the jitter), each attacker
// reserves ONE specific point on a ring around the target before closing
// in. There's no competition for space because there's no ambiguity.

// Ring radius is based on real collision radii (not a fixed magic number),
// and slot count is however many attacker-sized bodies actually fit around
// the ring without overlapping. An optional maxRadius caps the ring —
// critical for correctness: without a cap, a large target's ring can end
// up farther from center than the attacker's own attack range, meaning an
// attacker standing exactly on its assigned slot could never actually
// land a hit (a real bug found via user report — see main.js's
// MELEE_RING_MAX_RADIUS for where this is applied and why).
export function computeSlotRing(targetRadius, attackerRadiusEstimate, options = {}) {
  const gap = options.gap ?? 0.1;
  let ringRadius = targetRadius + attackerRadiusEstimate + 0.15;
  if (options.maxRadius !== undefined) {
    ringRadius = Math.min(ringRadius, options.maxRadius);
  }
  const circumference = 2 * Math.PI * ringRadius;
  const slotWidth = attackerRadiusEstimate * 2 + gap;
  const count = Math.max(2, Math.floor(circumference / slotWidth));
  return { ringRadius, count };
}

export function angularSlotDistance(i, j, count) {
  const diff = Math.abs(i - j);
  return Math.min(diff, count - diff);
}

// Picks the free slot that maximizes minimum angular distance to already-
// occupied slots — spreads attackers evenly around the target regardless
// of arrival order, without ever needing to move an already-assigned
// occupant (which would look like units shuffling around mid-fight).
export function pickBestFreeSlot(occupied /* boolean[] */) {
  const count = occupied.length;
  const occupiedIndices = [];
  for (let i = 0; i < count; i++) if (occupied[i]) occupiedIndices.push(i);

  if (occupiedIndices.length === 0) {
    for (let i = 0; i < count; i++) if (!occupied[i]) return i;
    return -1;
  }

  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < count; i++) {
    if (occupied[i]) continue;
    let minDist = Infinity;
    for (const occ of occupiedIndices) {
      const d = angularSlotDistance(i, occ, count);
      if (d < minDist) minDist = d;
    }
    if (minDist > bestScore) {
      bestScore = minDist;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function slotWorldPosition(targetPos, ringRadius, index, count) {
  const angle = (index / count) * Math.PI * 2;
  return {
    x: targetPos.x + Math.cos(angle) * ringRadius,
    z: targetPos.z + Math.sin(angle) * ringRadius,
  };
}

// Pure decision logic: can a unit currently engage in combat? Extracted
// specifically so it's unit-testable without a full Three.js/browser
// stack. A real regression happened here: this logic used to live inline
// in a large per-frame combat loop, and a refactor accidentally left
// stationary melee units (Knights) unable to ever satisfy "has a usable
// slot" — they never attempt reservation (they don't move to reach one),
// but the check only exempted ranged units, not stationary ones, so
// `canEngage` was permanently false and Knights could never attack. A unit
// with an in-range enemy engages if it's ranged (never competes for
// slots), OR stationary (never moves to reach one, so slot availability is
// irrelevant), OR mobile-and-melee-but-actually-holding-a-slot.
//
// `targetIsFlying` (added for the Flying wave type) is checked FIRST and
// unconditionally: a melee attacker can never engage a flying target no
// matter what else is true — not in range, not out of range, doesn't
// matter, there's no "close enough" for a ground melee unit to reach
// something airborne. Ranged attackers are unaffected either way (flying
// targets are still ordinary ranged targets for an Archer). Defaults to
// false so every existing call site that hasn't been updated to pass it
// keeps behaving exactly as before.
export function computeCanEngage({ ranged, stationary, withinRange, cliffBlocked, hasSlot, targetIsFlying = false }) {
  if (!ranged && targetIsFlying) return false;
  const hasUsableSlot = ranged || stationary || hasSlot;
  return withinRange && !cliffBlocked && hasUsableSlot;
}
