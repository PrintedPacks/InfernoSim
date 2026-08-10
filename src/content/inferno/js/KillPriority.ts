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
 * Jad-wave targeting: the tag-and-turn every player does, replacing the priority table while
 * a Jad is alive.
 *
 * Healers spawn healing Jad (`aggro` = their Jad, weapon style "heal") and flip aggro to
 * whoever hits them first - so "still healing" is precisely `aggro !== player`, and one
 * blowpipe hit each is the whole job. The order is: nearest reachable UNTAGGED healer until
 * none remain, then Jad - and never the tagged ones, which the priority table would otherwise
 * rank above Jad (healer 2 > Jad 1) and grind down one by one while fresh healers spawned and
 * healed everything back.
 *
 * Null when nothing useful is reachable - the tile scorer's healer-reach term and the
 * force-attack backstop own getting us somewhere better, exactly as everywhere else. The
 * caller must NOT fall back to the priority table on a Jad wave, or the tagged healers come
 * straight back as targets.
 */
export function chooseJadWaveTarget(region: Region, player: Player): Mob | null {
  const alive = visibleMobs(region).filter((mob) => mob.dying <= -1);

  let bestHealer: Mob | null = null;
  let bestDistance = Infinity;
  for (const mob of alive) {
    if (mob.mobName() !== EntityNames.YT_HUR_KOT || mob.aggro === player) {
      continue;
    }
    if (!canReach(region, player, mob)) {
      continue;
    }
    const distance = distanceTo(player, mob);
    if (distance < bestDistance) {
      bestHealer = mob;
      bestDistance = distance;
    }
  }
  if (bestHealer) {
    return bestHealer;
  }

  let bestJad: Mob | null = null;
  bestDistance = Infinity;
  for (const mob of alive) {
    if (mob.mobName() !== EntityNames.JAL_TOK_JAD || !canReach(region, player, mob)) {
      continue;
    }
    const distance = distanceTo(player, mob);
    if (distance < bestDistance) {
      bestJad = mob;
      bestDistance = distance;
    }
  }
  return bestJad;
}

/**
 * Highest-ranked reachable mob under whatever priority function is handed in, nearest breaking
 * ties, sticky on the incumbent - the shared shape behind both `chooseByPriority` and
 * `chooseZukWaveTarget`, so the two rankings can never drift apart in HOW they are applied,
 * only in the numbers themselves.
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

/**
 * Zuk-wave targeting: healers before the roaming ranger and mager before Jad before Zuk
 * itself - the user's explicit order for wave 69, replacing the general table entirely rather
 * than feeding into it, because the two waves rank the same mobs differently (Jad is 1 in
 * `PRIORITY`, 4 here; Zuk is 1 there, 2 here; a healer is 2 there, 10 here) and one flat map
 * cannot hold both answers for the same mob at once.
 *
 * Both healer types rank equally - Yt-HurKot spawns with the Zuk-phase Jad (`healers: 3` in
 * its spawn options) exactly as on a normal Jad wave, and Jal-MejJak spawns from Zuk's own
 * enrage phase. Neither gets the dedicated tag-and-turn `chooseJadWaveTarget` runs on a normal
 * Jad wave - this is a flat ranking, not that mechanic re-applied here.
 */
const ZUK_WAVE_PRIORITY: Record<string, number> = {
  [EntityNames.YT_HUR_KOT]: 10, // Jad's healers, if the Zuk-phase Jad is up
  [EntityNames.JAL_MEJ_JAK]: 10, // Zuk's own healers, enrage phase
  [EntityNames.JAL_XIL]: 8, // ranger
  [EntityNames.JAL_ZEK]: 6, // mager
  [EntityNames.JAL_TOK_JAD]: 4,
  [EntityNames.TZ_KAL_ZUK]: 2,
};

function zukWavePriority(mob: Mob): number {
  return ZUK_WAVE_PRIORITY[mob.mobName()] ?? 0;
}

/**
 * `exclude` is the boss-sequence layer's escape hatch: mager while Zuk is still >= 600 hp, and
 * Jad once it has been tagged, are BOTH still alive, reachable and would otherwise win this
 * flat ranking outright (mager is priority 6, well above Zuk's 2) - the sequence deliberately
 * wants Zuk instead in both cases, and excluding them here is what stops this fallback from
 * quietly overriding that choice the moment it is consulted.
 */
export function chooseZukWaveTarget(
  region: Region,
  player: Player,
  current: Mob | null,
  exclude: ReadonlyArray<Mob> = [],
): Mob | null {
  const reachable = visibleMobs(region).filter(
    (mob) => mob.dying <= -1 && !exclude.includes(mob) && canReach(region, player, mob),
  );
  return pickByPriority(reachable, zukWavePriority, player, current);
}
