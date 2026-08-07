"use strict";

import { LineOfSight, Mob, Player, Region } from "osrs-sdk";

/**
 * Issues the attack, without ever moving the player.
 *
 * WHICH mob to attack is TargetPlanner's job and has been since it started pricing targets by
 * what killing them prevents. What remains here is the effector - `applyAttackPlan` - plus
 * `isAttackable`, the reachability test the rest of the automation shares.
 *
 * `chooseTarget` below is the nearest-attackable rule TargetPlanner replaced. It is kept
 * because the harness tests use it as a fixed, obviously-correct baseline to measure real
 * target selection against; nothing in `src` calls it.
 *
 * The one decision that is NOT a placeholder is that this never chases.
 * `Player.determineDestination()` paths towards `aggro` whenever the player lacks line of
 * sight, so setting aggro on an out-of-range mob silently walks the player across the arena.
 * Position determines every mob's attack phase - a meleer at 3 tiles costs nothing while one
 * at 10 costs tens of thousands of damage - so movement has to stay owned by the movement
 * layer. Restricting targets to those already attackable keeps `hasLOS` true, and the chase
 * branch is never reached.
 */

/**
 * Can the player attack this mob from where it is standing right now?
 *
 * Uses the engine's own line-of-sight test - the same call `Unit.setHasLOS()` makes - so
 * this agrees with whether the attack would actually land, including weapon range and
 * obstacles.
 */
export function isAttackable(
  region: Region,
  player: Player,
  mob: Mob,
  range: number = player.attackRange,
): boolean {
  if (!mob || mob.dying > -1) {
    return false;
  }
  // The mob's own veto, and the only thing that models "you cannot kill this". Zuk's shield
  // sets `canBeAttacked()` false (and `selectable` false) precisely because it is scenery with
  // hitpoints: it is in region.mobs, it is drawn, it is enormous, and it is parked next to the
  // player for the whole of wave 69 - so without this it is simply the nearest thing in reach
  // and the bot would sit clicking it forever. Asked of the mob rather than by name so anything
  // else the engine marks unattackable is covered too. Nothing here changes what the MOBS do:
  // the shield still blocks and is still attacked by whatever the engine points at it.
  if (typeof mob.canBeAttacked === "function" && !mob.canBeAttacked()) {
    return false;
  }
  return LineOfSight.playerHasLineOfSightOfMob(
    region,
    player.location.x,
    player.location.y,
    mob,
    range,
  );
}

function distanceTo(player: Player, mob: Mob): number {
  const dx = Math.abs(mob.location.x - player.location.x);
  const dy = Math.abs(mob.location.y - player.location.y);
  return Math.max(dx, dy);
}

/**
 * Nearest attackable mob, keeping the current target while it remains valid.
 *
 * The baseline rule, not the live one - see the note at the top of this file. Sticking to a
 * target avoids re-clicking every tick, which would both waste the hand-time budget and make
 * measurements noisy.
 */
export function chooseTarget(
  region: Region,
  player: Player,
  mobs: Mob[],
  current: Mob | null,
  range: number = player.attackRange,
): Mob | null {
  if (current && mobs.includes(current) && isAttackable(region, player, current, range)) {
    return current;
  }

  let best: Mob | null = null;
  let bestDistance = Infinity;
  for (const mob of mobs) {
    if (!isAttackable(region, player, mob, range)) {
      continue;
    }
    const distance = distanceTo(player, mob);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = mob;
    }
  }
  return best;
}

/**
 * Point the player at the chosen target, or clear aggro when there is none.
 *
 * Choosing is TargetPlanner's job - this only issues the click. Clearing matters: a stale aggro
 * on a mob that has moved out of range puts the player back into the chase branch of
 * determineDestination() and it walks off.
 *
 * `click` mirrors the action on the simulated cursor. Returns the target now selected.
 */
export function applyAttackPlan(
  region: Region,
  player: Player,
  target: Mob | null,
  current: Mob | null,
  click?: (mob: Mob) => void,
): Mob | null {
  if (!target || !isAttackable(region, player, target)) {
    if (player.aggro) {
      player.setAggro(null);
      // Cancel any destination the previous aggro produced.
      player.destinationLocation = player.location;
    }
    return null;
  }

  if (player.aggro !== target) {
    player.setAggro(target);
    click?.(target);
  }

  // Deliberately does NOT pin destinationLocation here. determineDestination() only chases
  // when the player lacks line of sight to its aggro, and every target selected upstream
  // already has it - so there is nothing to suppress. Pinning it unconditionally would also
  // cancel the automation's own movement one step into any walk.
  return target;
}
