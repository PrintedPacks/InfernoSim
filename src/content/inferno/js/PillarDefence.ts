"use strict";

import { EntityNames, Mob, Region } from "osrs-sdk";

import { ArenaSnapshot, snapshotPlayerCanSeeMob } from "./ArenaSnapshot";
import { visibleMobs } from "./Visibility";

/**
 * What it costs to leave nibblers alive, in damage.
 *
 * Nibblers never touch the player - their aggro is a pillar - so the trajectory scorer, which
 * only measures damage taken, values them at exactly zero and the bot happily stands in a safe
 * corner while the pillars are eaten. That is the one failure that compounds: pillars are what
 * break line of sight, so every pillar lost permanently degrades every future tile score.
 *
 * So pillar damage is priced in the same currency as our own and added to the tile score. There
 * is no "reach bonus" - reaching nibblers is valuable only because it stops pillar damage, and
 * saying so directly leaves one interpretable number to tune instead of an arbitrary weight.
 *
 * Numbers that set the scale: a nibbler has max hit 4 on a 4 tick cycle, so about half a point
 * of pillar HP per tick each. A pillar has 255. Three nibblers alive for twenty ticks costs
 * roughly thirty pillar HP - trivial in one wave, decisive across sixty-two of them.
 */

/** Ice Barrage: range 10 and a 3x3 blast, which is how nibblers are actually dealt with. */
export const BARRAGE_RANGE = 10;

const NIBBLER_MAX_HIT = 4;
const NIBBLER_ATTACK_SPEED = 4;

/**
 * Nibblers whose pillar we are allowed to know.
 *
 * In this engine a mob's facing is recomputed from `aggro` every frame, so a nibbler is drawn
 * pointing at its pillar the instant it appears - and a frozen one still points, because facing
 * never consults movement. Reading `aggro` would therefore be legitimate here.
 *
 * It is not legitimate in the real game. There a nibbler spawns on an arbitrary angle and only
 * turns to its target on the following tick, so knowing the pillar immediately is an artefact
 * of how this simulator renders rather than something a player could see. Anything built on it
 * would not survive contact with the real thing.
 *
 * So a nibbler's pillar stays unknown for its first visible tick, and is readable from the tick
 * after - which is exactly when a player watching it turn would know.
 */
const seenBefore = new WeakSet<Mob>();

/** Call once per tick, before anything asks about pillar targets. */
export function observeNibblers(region: Region) {
  for (const mob of visibleMobs(region)) {
    if (mob.mobName() === EntityNames.JAL_NIB) {
      seenBefore.add(mob);
    }
  }
}

export interface NibblerThreat {
  x: number;
  y: number;
  size: number;
  /** Ticks of walking before it is adjacent to its pillar and can start biting. */
  ticksToReach: number;
  /** Ticks of freeze left. Zero means loose and already walking. */
  frozen: number;
}

/**
 * Every nibbler currently threatening a pillar, with how soon it gets there.
 *
 * Frozen nibblers are INCLUDED, and dropping them was a real bug rather than an optimisation. A
 * freeze stops a nibbler walking; it does not remove it. It is still alive, still on the board,
 * still worth catching in a blast, and it resumes walking the moment the freeze runs out. Leaving
 * them out meant a tile that could barrage two frozen nibblers and one loose one looked no better
 * than one that could only reach the loose one.
 *
 * The freeze is carried rather than baked in, so each caller can decide what it means: for
 * reaching them it means nothing at all, and for pillar damage it is a delay.
 */
export function nibblerThreats(region: Region): NibblerThreat[] {
  const threats: NibblerThreat[] = [];

  for (const mob of visibleMobs(region)) {
    if (mob.mobName() !== EntityNames.JAL_NIB || mob.dying > -1) {
      continue;
    }
    // First visible tick: it has not visibly turned yet, so we do not know its pillar.
    if (!seenBefore.has(mob)) {
      continue;
    }
    const target = mob.aggro?.location;
    if (!target) {
      continue;
    }

    // Nibblers have attack range 1, so they close until adjacent. They move a tile a tick.
    const distance = Math.max(
      Math.abs(target.x - mob.location.x),
      Math.abs(target.y - mob.location.y),
    );
    threats.push({
      x: mob.location.x,
      y: mob.location.y,
      size: mob.size,
      ticksToReach: Math.max(0, distance - 1),
      frozen: Math.max(0, (mob as unknown as { frozen?: number }).frozen ?? 0),
    });
  }
  return threats;
}

/**
 * Expected pillar damage over the horizon if the player stands here.
 *
 * A nibbler we can reach from this tile is treated as neutralised - at 10 hitpoints a barrage
 * that touches it kills it, and one that somehow does not still freezes it for 32 ticks. So the
 * question for each nibbler is simply whether this tile can put a barrage on it.
 *
 * Deliberately binary. Pricing it properly would mean simulating our own damage output, which
 * the trajectory sim does not do - it models what happens TO us. That is what a time-to-kill
 * model would add, and until then "can we hit it at all" is the honest approximation.
 */
export function expectedPillarDamage(
  snapshot: ArenaSnapshot,
  threats: NibblerThreat[],
  fromX: number,
  fromY: number,
  horizon: number,
): number {
  let total = 0;

  for (const threat of threats) {
    const reachable = snapshotPlayerCanSeeMob(
      snapshot,
      fromX,
      fromY,
      threat.x,
      threat.y,
      threat.size,
      BARRAGE_RANGE,
    );
    if (reachable) {
      continue;
    }

    // Frozen means it has not started walking yet, so the two delays add.
    const bitingTicks = horizon - threat.frozen - threat.ticksToReach;
    if (bitingTicks <= 0) {
      continue;
    }
    const attacks = Math.floor(bitingTicks / NIBBLER_ATTACK_SPEED);
    // Damage rolls uniformly over 0..maxHit, so the mean is half.
    total += attacks * (NIBBLER_MAX_HIT / 2);
  }
  return total;
}
