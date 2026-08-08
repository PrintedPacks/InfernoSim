"use strict";

import { EntityNames, Mob, Player, Region } from "osrs-sdk";

import { attackOptionFor } from "./TargetPlanner";
import { visibleMobs } from "./Visibility";

/**
 * What to attack, by a per-mob priority and then by distance.
 *
 * A priority list is still not the long-term answer - `TargetPlanner.chooseTarget` prices a
 * target by simulating the fight without it, and swapping to it is a one line change at the
 * call site in InfernoAutomation - but it is now a real ordering rather than three bands with
 * everything piled into the middle one.
 *
 * The numbers below are the whole ranking; the table in SCORING_STATUS.md is the same list with
 * the reasoning written out. What the ordering CANNOT express is anything that changes during a
 * fight: remaining hitpoints, ticks to kill, the cost of a gear switch, or what a mob is about
 * to do. Those are the counterfactual's job.
 *
 * The shield is listed at 0 for completeness, but it never reaches this function - it is
 * excluded upstream by `AttackPlanner.isAttackable`, which now refuses any mob whose own
 * `canBeAttacked()` says no. Priority cannot express "unkillable": a 0 still wins when it is
 * the only thing in reach.
 */
const PRIORITY: Record<string, number> = {
  [EntityNames.JAL_NIB]: 10, // nibbler - pillar damage is permanent
  [EntityNames.JAL_IM_KOT]: 8, // meleer - 49 max, digs when starved
  [EntityNames.JAL_MEJ_RAJ]: 7, // bat
  [EntityNames.JAL_AK_REK_KET]: 7, // melee bloblet
  [EntityNames.JAL_AK_REK_MEJ]: 7, // magic bloblet
  [EntityNames.JAL_AK_REK_XIL]: 7, // ranged bloblet
  [EntityNames.JAL_ZEK]: 6, // mager - 70 max, resurrects dead mobs
  [EntityNames.JAL_XIL]: 5, // ranger - 46 max
  [EntityNames.YT_HUR_KOT]: 2, // Jad healer
  [EntityNames.JAL_MEJ_JAK]: 2, // Zuk healer
  [EntityNames.JAL_TOK_JAD]: 1,
  [EntityNames.TZ_KAL_ZUK]: 1,
  [EntityNames.JAL_AK]: 1, // blob - killing it spawns three bloblets, so not pure gain
  [EntityNames.INFERNO_SHIELD]: 0, // never targeted; see the note above
};

/**
 * Anything not in the table: mid-list, so a mob nobody has ranked is neither ignored nor
 * rushed. Every mob the Inferno spawns IS ranked, so this only catches something new.
 */
export const DEFAULT_PRIORITY = 5;

export function killPriority(mob: Mob): number {
  const priority = PRIORITY[mob.mobName()];
  return priority === undefined ? DEFAULT_PRIORITY : priority;
}

/** Chebyshev distance, which is how OSRS measures reach. */
function distanceTo(player: Player, mob: Mob): number {
  return Math.max(
    Math.abs(mob.location.x - player.location.x),
    Math.abs(mob.location.y - player.location.y),
  );
}

/**
 * Can we hit this mob from where we stand, with some set we are permitted to use on it?
 *
 * Delegated wholesale to `attackOptionFor` - the mob's own set first, the long bow as a
 * fallback when it cannot reach (never for pures) - so candidacy, the gear switch and the
 * attack click all read the one answer. When those layers used different ranges the bot
 * picked a target, spent a tick switching gear for it, then dropped it as unreachable -
 * forever.
 */
export function canReach(region: Region, player: Player, mob: Mob): boolean {
  return attackOptionFor(region, player, mob) !== null;
}

/**
 * Highest priority band we can actually reach, nearest first within the band.
 *
 * Sticky: the current target is kept whenever it is still reachable and still in the top band on
 * offer. Re-picking every tick would re-click and, worse, could ping-pong between two mobs of
 * equal priority as they move.
 */
export function chooseByPriority(
  region: Region,
  player: Player,
  current: Mob | null,
): Mob | null {
  const reachable = visibleMobs(region).filter(
    (mob) => mob.dying <= -1 && canReach(region, player, mob),
  );
  if (reachable.length === 0) {
    return null;
  }

  let best: Mob | null = null;
  let bestPriority = -Infinity;
  let bestDistance = Infinity;

  for (const mob of reachable) {
    const priority = killPriority(mob);
    const distance = distanceTo(player, mob);
    if (
      priority > bestPriority ||
      (priority === bestPriority && distance < bestDistance)
    ) {
      best = mob;
      bestPriority = priority;
      bestDistance = distance;
    }
  }

  // Hold the current target while nothing outranks it. Equal priority is not a reason to switch,
  // so a target already being attacked is not dropped for one that happens to be a tile nearer.
  if (current && reachable.indexOf(current) >= 0 && killPriority(current) >= bestPriority) {
    return current;
  }
  return best;
}
