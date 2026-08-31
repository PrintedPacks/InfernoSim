"use strict";

import { EntityNames, Mob, Player, Region } from "osrs-sdk";

import { isAttackable } from "./AttackPlanner";
import { attackOptionFor, attackReachForName } from "./TargetPlanner";
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
 * Jad-wave targeting: the tag-and-turn every player does, replacing the priority table while
 * a Jad is alive.
 *
 * Healers spawn healing Jad (`aggro` = their Jad, weapon style "heal") and flip aggro to
 * whoever hits them first - so "still healing" is precisely `aggro !== player`, and one
 * blowpipe hit each is the whole job. The order is: nearest UNTAGGED healer at blowpipe reach
 * minus one until none remain, then the COMMITTED Jad - and never the tagged ones, which the
 * priority table would otherwise rank above Jad (healer 2 > Jad 1) and grind down one by one
 * while fresh healers spawned and healed everything back.
 *
 * The two halves answer reach differently on purpose, and both are documented where they live:
 * the healer pick carries a tile of slack because a healer is walking while it is being picked
 * (`chooseUntaggedHealer`), and the Jad pick is made by spawn order and only then checked for
 * reach, so an out-of-reach Jad holds fire rather than handing the fight to a nearer one
 * (`chosenJad`).
 *
 * Null when nothing useful is reachable - the tile scorer's focus pull and the force-attack
 * backstop own getting us somewhere better, exactly as everywhere else. The caller must NOT
 * fall back to the priority table on a Jad wave, or the tagged healers come straight back as
 * targets.
 */
export function chooseJadWaveTarget(region: Region, player: Player): Mob | null {
  return chooseUntaggedHealer(region, player) ?? chosenJad(region, player);
}

/**
 * The healer worth a tag right now: the nearest untagged one, judged at BLOWPIPE REACH MINUS ONE.
 *
 * The slack is ADDED, one tile beyond the weapon's reach. A healer is the only thing on this wave
 * that is walking while it is being picked, and the tag is a click issued this tick and processed
 * the next - so a healer one tile outside reach right now is inside it by the time the click
 * lands. Picking only inside the exact reach throws that tick away and leaves the healer healing;
 * reaching one tile further catches it as it closes.
 *
 * Asked of the BLOWPIPE, not of `attackOptionFor`: the tag is a blowpipe job, and a healer
 * picked at a longer weapon's range is one the blowpipe cannot tag.
 */
function chooseUntaggedHealer(region: Region, player: Player): Mob | null {
  // THE PICK IS AT THE REAL BLOWPIPE REACH, with no slack added.
  //
  // The slack lives in `TileScorer.jadWaveFocus` instead, where it is a reason to WALK. Adding it
  // here picked healers one tile beyond what `attackOptionFor` will attack - which, now that
  // healers are blowpipe-only and it refuses the long-weapon fallback for them, is a target that
  // can never be fired at. The bot held that target and neither shot nor moved.
  const reach = attackReachForName(player, EntityNames.YT_HUR_KOT);

  let best: Mob | null = null;
  let bestDistance = Infinity;
  for (const mob of visibleMobs(region)) {
    if (mob.dying > -1 || mob.mobName() !== EntityNames.YT_HUR_KOT || mob.aggro === player) {
      continue;
    }
    if (!isAttackable(region, player, mob, reach)) {
      continue;
    }
    const distance = distanceTo(player, mob);
    if (distance < bestDistance) {
      best = mob;
      bestDistance = distance;
    }
  }
  return best;
}

/** Tiles of slack ADDED to the healer pick's reach - see `chooseUntaggedHealer`. */
export const HEALER_REACH_SLACK = 1;

/**
 * The Jad currently locked on - picked once, then held until it dies.
 *
 * Module state rather than a per-call answer, and that IS the feature. The pick below is made on
 * position, and Jads move: recomputed every tick, a Jad that walks a tile south takes the slot
 * from the one we have already put 200 damage into, and three Jads at 350 hitpoints each end the
 * wave alive with a third of their health gone apiece. The lock is what turns a pick into a
 * commitment - the bot finishes what it starts.
 *
 * Cleared by `resetJadLock`, which `InfernoAutomation.setEnabled` calls, so a fresh run never
 * inherits the previous one's target. The liveness check below is the second guard: a reference
 * held across a wave transition cannot match anything in the new `region.mobs`, so it re-picks.
 */
let lockedJad: Mob | null = null;

/** Drop the lock. Called on every automation enable/disable - see `lockedJad`. */
export function resetJadLock(): void {
  lockedJad = null;
}

/**
 * The Jad the wave is being fought against: the SOUTHERNMOST one, held until it dies.
 *
 * SOUTH FIRST. `y` increases southward in this engine (see the arena bounds in `TileScorer`), so
 * the southern Jad is the one with the largest `y` - on wave 68 that is the 23,35 spawn, the one
 * below the player's 25,27 start, with the other two north of it at y 24. Killing it first is the
 * order asked for: it clears the side the bot is standing on, and leaves the survivors on one
 * side of the arena instead of two.
 *
 * Compared on `location.y` directly, which is safe because every Jad is size 5 and this engine
 * anchors a footprint at its southern row (`y` down to `y - size + 1`) - so the same edge is
 * being compared on each. It would NOT be safe against a mob of a different size.
 *
 * Ties break on spawn order - `region.mobs` is append-only, so its order is the order the wave
 * built them in, the sim's stand-in for the client's npcIndex. Wave 68 spawns two Jads at y 24,
 * so the tie is real and needs an answer that is the same on every seed.
 *
 * Re-picked only when the lock is empty or its Jad is gone, never while one is alive.
 */
export function committedJad(region: Region): Mob | null {
  const live = visibleMobs(region).filter(
    (mob) => mob.dying <= -1 && mob.mobName() === EntityNames.JAL_TOK_JAD,
  );

  if (lockedJad && live.indexOf(lockedJad) !== -1) {
    return lockedJad;
  }

  let best: Mob | null = null;
  for (const mob of live) {
    // Strictly greater, so the first-spawned of two Jads on the same row keeps the slot.
    if (!best || mob.location.y > best.location.y) {
      best = mob;
    }
  }
  lockedJad = best;
  return best;
}

/**
 * The locked Jad, if it can be shot from where we stand.
 *
 * REACH IS CHECKED ON THE PICK, NOT USED TO MAKE IT. Out of reach returns null - hold fire - and
 * deliberately does NOT fall through to a Jad that happens to be closer, which would be the
 * nearest-target rule wearing a different hat and would break the lock every time the committed
 * Jad wandered out of blowpipe range. Getting back into reach of it is the movement layer's job,
 * and `TileScorer` pulls towards this same mob for exactly that reason.
 */
export function chosenJad(region: Region, player: Player): Mob | null {
  const jad = committedJad(region);
  if (!jad) {
    return null;
  }
  return canReach(region, player, jad) ? jad : null;
}

/**
 * Highest-ranked reachable mob under whatever priority function is handed in, nearest breaking
 * ties, sticky on the incumbent.
 *
 * Sticky: the current target is kept whenever it is still reachable and still top-ranked.
 * Re-picking every tick would re-click and, worse, could ping-pong between two mobs of equal
 * priority as they move.
 */
function pickByPriority(
  reachable: Mob[],
  priorityOf: (mob: Mob) => number,
  player: Player,
  current: Mob | null,
): Mob | null {
  if (reachable.length === 0) {
    return null;
  }

  let best: Mob | null = null;
  let bestPriority = -Infinity;
  let bestDistance = Infinity;

  for (const mob of reachable) {
    const priority = priorityOf(mob);
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
  if (current && reachable.indexOf(current) >= 0 && priorityOf(current) >= bestPriority) {
    return current;
  }
  return best;
}

export function chooseByPriority(
  region: Region,
  player: Player,
  current: Mob | null,
): Mob | null {
  const reachable = visibleMobs(region).filter(
    (mob) => mob.dying <= -1 && canReach(region, player, mob),
  );
  return pickByPriority(reachable, killPriority, player, current);
}
