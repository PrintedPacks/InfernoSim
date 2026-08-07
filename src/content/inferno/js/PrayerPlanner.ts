"use strict";

import { EntityNames, LineOfSight, Location, Mob, Player } from "osrs-sdk";

import { isJad, jadThreatsLandingNextTick, observeJads } from "./JadTracker";
import {
  MAGIC_PRAYER,
  MELEE_PRAYER,
  OVERHEAD_PRAYERS as ALL_OVERHEADS,
  planOverheads,
  prayerForAttackStyle as styleToPrayer,
  RANGE_PRAYER,
} from "./OverheadPlanner";
import { ArenaSnapshot } from "./ArenaSnapshot";
import { simulateTrajectory, snapshotMobs, Threat } from "./Trajectory";

/**
 * Decides which overhead prayer must be lit, based on which mobs are about to attack.
 *
 * Timing rule (proved in test/harness/prayerTiming.test.ts):
 *
 *   A prayer toggled during postTick of tick N is ACTIVE for attacks fired on tick N+1.
 *
 * That is because Player.pretick() resolves isLit into isActive at step 2 of the region
 * tick, while mobs fire at step 6. So the planner runs one tick ahead: on each postTick it
 * asks "who fires next tick?" and lights the matching prayer.
 *
 * Protection is all-or-nothing and applied when the attacker fires, not when the projectile
 * lands - Weapon.attack() zeroes the damage before the projectile is even built. So there
 * is no partial credit for being late, and nothing to gain from praying during flight.
 */

// Prayer names and the style mapping live with the planner, so there is one definition.
const MAGIC = MAGIC_PRAYER;
const RANGE = RANGE_PRAYER;
const MELEE = MELEE_PRAYER;

export { OVERHEAD_PRAYERS, prayerForAttackStyle } from "./OverheadPlanner";

/**
 * Will this mob fire on the next tick?
 *
 * At postTick the mob's attackDelay has already been decremented for this tick (step 4)
 * and reset if it attacked (step 6). Next tick it decrements once more and fires when the
 * result is <= 0, so `attackDelay <= 1` means "fires next tick".
 *
 * attackDelay keeps counting past zero while line of sight is broken, so a mob that has
 * been waiting behind a pillar fires the instant it can see you again - hence the check is
 * <= 1 rather than === 1.
 */
export function willAttackNextTick(mob: Mob, player: Player): boolean {
  // Not every mob is coming for us. Nibblers are spawned with a pillar as their aggro
  // target and never touch the player, so praying against them wastes flicks and steals the
  // free ticks the blob scan logic needs.
  if (mob.aggro !== player || mob.dying > -1) {
    return false;
  }
  // Jad's attackDelay marks when its animation starts, not when the deferred attack
  // resolves three ticks later, and its style field is re-rolled every tick. It is scheduled
  // from the observed animation instead - see JadTracker.
  if (isJad(mob)) {
    return false;
  }
  if (mob.attackDelay > 1) {
    return false;
  }
  // NOTE ON BLOBS - do not "optimise" this to skip non-attacking ticks.
  //
  // A blob's attackDelay reaches zero on two different kinds of tick: the SCAN, where it
  // reads whichever overhead is active and commits to throwing the opposite style, and the
  // attack itself three ticks later. This function cannot tell them apart, so it reports a
  // threat on both and the caller lights a prayer on the scan tick too.
  //
  // That apparently wasted prayer is load-bearing. A blob that scans an active prayer picks
  // its style deterministically, so the fire tick is predictable and blockable. A blob that
  // scans nothing re-rolls its style at random on every call, and the style predicted one
  // tick ahead is then a different roll from the one it actually throws - roughly half of
  // those land. Teaching this function to recognise scans would silently reintroduce that.
  //
  // Verified over 400 trials / 4000 blob attacks in test/harness/blobRobust.test.ts.
  if (mob.hasLOS) {
    return true;
  }
  // Judged from the mob's current range only - no allowance for it stepping a tile closer
  // this tick. A mob out of range right now is not treated as a threat until it is actually
  // in range.
  return LineOfSight.mobHasLineOfSightOfPlayer(
    mob.region,
    player,
    mob.location.x,
    mob.location.y,
    mob.size,
    mob.attackRange,
    true,
  );
}

/**
 * The overhead needed for the next tick, or null if nothing is incoming.
 *
 * Only one overhead can be up at a time, so when several mobs fire on the same tick this
 * protects against the largest max hit and eats the rest. That is a greedy choice, not an
 * optimal one - the real answer depends on what is survivable over the next few ticks and
 * belongs to the search layer. It is the right default in the meantime.
 */
export function requiredPrayer(mobs: Mob[], player: Player): string | null {
  const incoming = mobs
    .filter((mob) => willAttackNextTick(mob, player))
    .map((mob) => ({ mob, prayer: styleToPrayer(mob.attackStyleForNewAttack()) }))
    .filter((entry) => entry.prayer !== null);

  // Jad resolves on a schedule of its own, but competes on max hit like anything else.
  for (const threat of jadThreatsLandingNextTick(mobs, player)) {
    const prayer = styleToPrayer(threat.style);
    if (prayer) {
      incoming.push({ mob: threat.mob, prayer });
    }
  }

  if (incoming.length === 0) {
    return null;
  }

  incoming.sort((a, b) => (b.mob.maxHit ?? 0) - (a.mob.maxHit ?? 0));
  return incoming[0].prayer;
}

/**
 * The style a mob is already committed to, without asking it to decide.
 *
 * `attackStyleForNewAttack()` is not a pure read for every mob. A blob that has not yet
 * scanned rolls `Random.get()` inside it and re-decides on the spot, so simply inspecting
 * the fight consumes RNG and changes what the blob throws. Anything that only wants to
 * observe must go through here.
 */
export function knownAttackStyle(mob: Mob): string | null {
  if (isBlob(mob)) {
    const scan = (mob as unknown as { playerPrayerScan?: string | null }).playerPrayerScan;
    if (scan !== "magic" && scan !== "range") {
      return null; // still to scan - nothing is decided yet
    }
  }
  return mob.attackStyleForNewAttack();
}

/**
 * Everything firing next tick, worst max hit first. Useful for the search layer.
 *
 * Observation only: uses knownAttackStyle so that reading the threat list cannot alter the
 * simulation. Mobs that have not committed to a style are reported with a null style rather
 * than being asked to pick one.
 */
export function incomingThreats(
  mobs: Mob[],
  player: Player,
): { mob: Mob; style: string | null; maxHit: number }[] {
  const normal = mobs
    .filter((mob) => willAttackNextTick(mob, player))
    .map((mob) => ({ mob, style: knownAttackStyle(mob), maxHit: mob.maxHit ?? 0 }));
  return [...normal, ...jadThreatsLandingNextTick(mobs, player)].sort(
    (a, b) => b.maxHit - a.maxHit,
  );
}

/**
 * Light the prayer needed for next tick and extinguish any other overhead.
 *
 * When `flick` is true the prayer is switched off whenever nothing is incoming, which is
 * what makes 1-tick flicking work and keeps prayer points. When false the prayer is simply
 * left on, which is safer but drains.
 */
/**
 * What this prayer's isActive will be after the next tick resolves.
 *
 * `isLit` is NOT that state and must not be branched on. BasePrayer.tick() does
 * `isActive = nextActiveState; isLit = isActive;`, so isLit is overwritten from isActive
 * every tick, and a click made this tick lives in `nextActiveState` until then. Reading
 * isLit made the planner toggle from a stale value and set the wrong overhead whenever the
 * required style changed from one tick to the next.
 */
function willBeActive(prayer: { isActive: boolean; nextActiveState: boolean | null }): boolean {
  return prayer.nextActiveState !== null ? prayer.nextActiveState : prayer.isActive;
}

/**
 * Does this mob fire exactly `offset` ticks from now?
 *
 * attackDelay is decremented once per tick and the mob fires when it reaches <= 0, so the
 * next shot is max(1, attackDelay) ticks away and they repeat every attackSpeed after that.
 *
 * Blobs are excluded: their attackDelay alternates between a scan and a real attack, so the
 * same countdown means different things on different cycles. They are projected separately.
 */
function firesAtOffset(mob: Mob, offset: number, player: Player): boolean {
  if (isBlob(mob) || mob.aggro !== player || mob.dying > -1) {
    return false;
  }
  const speed = mob.attackSpeed;
  if (!speed || speed < 1) {
    return false;
  }
  const first = Math.max(1, mob.attackDelay);
  if (offset < first) {
    return false;
  }
  return (offset - first) % speed === 0;
}

/**
 * Identify blobs by name, not by shape.
 *
 * This used to duck-type on `playerPrayerScan !== undefined`, but JalTokJad declares that
 * field too and never sets it - so Jad matched, was treated as a blob perpetually about to
 * scan, and the scan branch lit magic for no reason (and returned early, potentially hiding
 * a real threat that tick).
 */
function isBlob(mob: Mob): boolean {
  return mob.mobName() === EntityNames.JAL_AK;
}

/** True when this blob performs its prayer scan on the next tick. */
function scansNextTick(blob: Mob, player: Player): boolean {
  const b = blob as unknown as { playerPrayerScan: string | null };
  return b.playerPrayerScan === null && blob.attackDelay <= 1 && blob.aggro === player && blob.hasLOS;
}

/**
 * The overhead to show a blob that is about to scan.
 *
 * A blob commits to the opposite of whatever it scans, and fires attackSpeed ticks later.
 * If something else is already going to attack on that tick, showing the blob the opposite
 * of that style makes the blob throw the SAME style - so one overhead covers both instead
 * of one of them having to be eaten.
 *
 * Returns null when nothing else lands on that tick, in which case the blob's style does
 * not matter and the caller is free to leave the prayer alone.
 */
export function scanStyleToMatchThreats(blob: Mob, mobs: Mob[], player: Player): string | null {
  // The blob scans next tick (offset 1) and fires attackSpeed ticks after that.
  const fireOffset = 1 + blob.attackSpeed;

  const coinciding = mobs
    .filter((m) => m !== blob && firesAtOffset(m, fireOffset, player))
    .map((m) => ({ style: knownAttackStyle(m), maxHit: m.maxHit ?? 0 }))
    .filter((t) => t.style !== null && styleToPrayer(t.style) !== null)
    .sort((a, b) => b.maxHit - a.maxHit);

  if (coinciding.length === 0) {
    return null;
  }

  // Make the blob throw the same style as the biggest threat on that tick.
  const wanted = coinciding[0].style;
  if (wanted === "magic") {
    return RANGE; // scanning range makes it throw magic
  }
  if (wanted === "range") {
    return MAGIC; // scanning magic makes it throw range
  }
  // Melee threats cannot be matched by a blob, which only throws magic or range.
  return null;
}

/**
 * How a prayer gets switched.
 *
 * Tests call `prayer.toggle(player)` directly, which is the shortest path to the same state
 * change. The live automation instead routes through the control panel so the action is
 * visible on screen - see InfernoAutomation.clickPrayer.
 */
export type PrayerClicker = (prayerName: string) => void;

export function applyPrayerPlan(
  player: Player,
  mobs: Mob[],
  flick = true,
  click?: PrayerClicker,
  route?: Location[],
): void {
  // Must happen before any decision: Jad's committed style is only readable on the tick its
  // animation starts.
  observeJads(mobs);

  const wanted = plannedOverhead(player, mobs, route);

  const light = (name: string) => {
    const prayer = player.prayerController.findPrayerByName(name);
    // Toggling one overhead on makes BasePrayer.handleConflicts() switch the others off, so
    // the rest need no explicit handling here.
    if (prayer && !willBeActive(prayer)) {
      if (click) {
        click(name);
      } else {
        prayer.toggle(player);
      }
    }
  };

  if (wanted) {
    light(wanted);
    return;
  }

  if (!flick) {
    return;
  }
  for (const name of ALL_OVERHEADS) {
    const prayer = player.prayerController.findPrayerByName(name);
    if (prayer && willBeActive(prayer)) {
      if (click) {
        click(name);
      } else {
        prayer.toggle(player);
      }
    }
  }
}

/**
 * The overhead to show this tick, from the one planner.
 *
 * Planned against the route the bot is walking, falling back to standing still when it is not
 * moving. THIS tick is the same either way - World.tickRegion fires mobs before the player
 * moves, so tick one always resolves against the current tile - but the plan reaches three
 * ticks out to steer blobs, and there the two futures genuinely differ.
 *
 * Jad is folded in separately because it never enters the simulation: its attackDelay marks an
 * animation start rather than the attack that resolves three ticks later, so JadTracker
 * schedules it from the observed animation instead.
 */
export function plannedOverhead(
  player: Player,
  mobs: Mob[],
  route?: Location[],
): string | null {
  const region = player.region;
  const here = { x: player.location.x, y: player.location.y };
  // The walk the movement layer committed to, so a blob steer three ticks out is planned
  // against the future the bot is actually creating. Standing still when there is no walk.
  const path = route && route.length > 0 ? route : [here];

  let threats: Threat[] = [];
  if (region) {
    const snapshot = new ArenaSnapshot(region);
    threats = simulateTrajectory(snapshot, snapshotMobs(region, player), path);
  }

  for (const threat of jadThreatsLandingNextTick(mobs, player)) {
    if (styleToPrayer(threat.style)) {
      threats.push({ tick: 1, styles: [threat.style], maxHit: threat.maxHit, name: "Jad" });
    }
  }

  return planOverheads(threats).plan.get(1) ?? null;
}
