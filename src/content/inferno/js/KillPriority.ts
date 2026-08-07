"use strict";

import { EntityNames, Mob, Player, Region } from "osrs-sdk";

import { isAttackable } from "./AttackPlanner";
import { attackReachFor } from "./TargetPlanner";
import { visibleMobs } from "./Visibility";

/**
 * What to attack, by a fixed priority band and then by distance.
 *
 * DELIBERATELY SIMPLE, AND DELIBERATELY TEMPORARY. This is here to get the bot grinding so the
 * rest of the picture can be looked at with one fewer moving part, not because a priority list is
 * the right long-term answer. `TargetPlanner.chooseTarget` is the real one - it prices a target by
 * simulating the fight without it, which already includes the pillar damage a nibbler would do -
 * and swapping to it is a one line change at the call site in InfernoAutomation.
 *
 * The bands encode three judgements that the counterfactual works out for itself:
 *
 *   - nibblers first, because the damage they do is to the PILLARS, and a pillar lost is
 *     permanent for the rest of the run;
 *   - blobs last, because killing one replaces it with three bloblets, so it is not pure gain;
 *   - everything else in the middle, separated only by how near it is.
 */

export const NIBBLER_PRIORITY = 10;
export const DEFAULT_PRIORITY = 5;
export const BLOB_PRIORITY = 1;

export function killPriority(mob: Mob): number {
  switch (mob.mobName()) {
    case EntityNames.JAL_NIB:
      return NIBBLER_PRIORITY;
    case EntityNames.JAL_AK:
      return BLOB_PRIORITY;
    default:
      return DEFAULT_PRIORITY;
  }
}

/** Chebyshev distance, which is how OSRS measures reach. */
function distanceTo(player: Player, mob: Mob): number {
  return Math.max(
    Math.abs(mob.location.x - player.location.x),
    Math.abs(mob.location.y - player.location.y),
  );
}

/**
 * Can we hit this mob from where we stand, with the weapon we would actually use on it?
 *
 * Reach comes from the mob's OWN gear set rather than from whatever is in hand, so the answer
 * does not change when the gear does. Judging by the current weapon deadlocks - holding a
 * blowpipe nothing past 5 tiles is a candidate, so nothing is ever intended, so the gear layer is
 * never told to switch to the bow that would have reached it.
 *
 * It also has to agree with `applyAttackPlan`, which re-tests before setting aggro. When those
 * two used different ranges the bot picked a target, spent a tick switching gear for it, then
 * dropped it as unreachable - forever.
 */
export function canReach(region: Region, player: Player, mob: Mob): boolean {
  return isAttackable(region, player, mob, attackReachFor(player, mob));
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
