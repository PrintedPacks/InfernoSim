"use strict";

import { EntityNames, Location, Mob, Region } from "osrs-sdk";

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

/**
 * Chebyshev distance from a tile to the nearest tile of a footprint - zero if it is inside one.
 *
 * A pillar is 3x3 and `location` is one CORNER of it, so measuring to that tile is measuring to
 * a 1x1 pillar that does not exist. The engine's own convention, from `LocationUtils.
 * closestPointTo` and every draw call in InfernoPillar: the footprint runs EAST and NORTH of
 * `location`, x over [x, x+size-1] and y over [y-size+1, y].
 *
 * Getting this wrong was worth up to two whole ticks, and always in the same direction, because
 * `location` is the south-west corner: a nibbler biting the NORTH or EAST face of a pillar read
 * as two or three ticks of walking still to do while it was already chewing.
 */
export function distanceToFootprint(
  x: number,
  y: number,
  originX: number,
  originY: number,
  size: number,
): number {
  const nearestX = Math.min(Math.max(x, originX), originX + size - 1);
  const nearestY = Math.min(Math.max(y, originY - size + 1), originY);
  return Math.max(Math.abs(x - nearestX), Math.abs(y - nearestY));
}

/** Call once per tick, before anything asks about pillar targets. */
export function observeNibblers(region: Region) {
  for (const mob of visibleMobs(region)) {
    if (mob.mobName() === EntityNames.JAL_NIB) {
      seenBefore.add(mob);
    }
  }
}

export interface NibblerThreat {
  /**
   * The live mob, so a caller that has to CLICK one is choosing from the same pool that
   * decides where to stand.
   *
   * Two nibblers can share a tile - they do not consume space - so position is not an
   * identity and matching a threat back to its mob by coordinates is ambiguous. Carrying the
   * reference is the only way the positioning and targeting lanes can be talking about the
   * same nibbler and be sure of it.
   */
  mob: Mob;
  x: number;
  y: number;
  size: number;
  /**
   * The tile it is walking at, or null while its pillar is still being withheld.
   *
   * Carried purely so the nibbler can be SIMMED - `nibblerAt` needs a direction, and a
   * direction is the one thing position and `ticksToReach` between them do not give you.
   * Null is not a special case anywhere: an unknown pillar already means `ticksToReach` 0,
   * which caps the projection at zero steps, so such a nibbler simply stands still.
   */
  pillar: Location | null;
  /** Ticks of walking before it is adjacent to its pillar and can start biting. */
  ticksToReach: number;
  /** Ticks of freeze left. Zero means loose and already walking. */
  frozen: number;
}

/**
 * Where this nibbler will be standing in `ticks` ticks.
 *
 * The same model `ticksToReach` already encodes, run forwards instead of counted: one tile a
 * tick towards the pillar, diagonals included, and it stops the moment it is adjacent. Written
 * as one expression per axis rather than a loop, which is the same thing for a straight-line
 * chase and cheaper when 441 tile scores each ask for it.
 *
 * Two things bound the walk, and both are the numbers the threat already carries:
 *
 *  - FREEZE. A frozen nibbler is not walking, so the first `frozen` ticks buy no steps at all.
 *    Past that it walks normally, which is what makes a long freeze read as a nibbler that is
 *    still where you left it rather than one that has vanished from the problem.
 *  - ARRIVAL. It stops at `ticksToReach`, because that is the definition of that number - the
 *    walk before it is adjacent and starts biting. Projecting past it would march the nibbler
 *    into and through its own pillar.
 *
 * Deliberately NOT routed around anything. Nibblers do not consume space (`consumesSpace`
 * returns null) so nothing blocks them but the map, and the arena between a nibbler's spawn and
 * its pillar is open. This matches `stepMob`'s greedy sign-per-axis chase for the same reason:
 * the engine does not pathfind here either.
 */
export function nibblerAt(threat: NibblerThreat, ticks: number): { x: number; y: number } {
  const pillar = threat.pillar;
  if (!pillar) {
    return { x: threat.x, y: threat.y };
  }
  const steps = Math.min(threat.ticksToReach, Math.max(0, ticks - threat.frozen));
  if (steps <= 0) {
    return { x: threat.x, y: threat.y };
  }

  const dx = pillar.x - threat.x;
  const dy = pillar.y - threat.y;
  return {
    x: threat.x + Math.sign(dx) * Math.min(steps, Math.abs(dx)),
    y: threat.y + Math.sign(dy) * Math.min(steps, Math.abs(dy)),
  };
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
    // The PILLAR is withheld on the first visible tick - a real nibbler has not visibly turned
    // to it yet, so we are not allowed to know it - but the NIBBLER is always listed.
    //
    // Dropping the whole entry was a bug, and not only for pillar scoring: this list is what
    // the targeting lane picks from, so a nibbler that had just spawned was not merely
    // unpriced, it was unclickable. On a nearly-empty board a bat could win a target that a
    // nibbler should have taken outright.
    //
    // Unknown pillar therefore means MAXIMALLY URGENT rather than absent. Conservative in the
    // right direction: it over-prices the wall for exactly one tick, where omitting it
    // under-priced the wall completely.
    const pillar = seenBefore.has(mob) ? mob.aggro : undefined;
    const target = pillar?.location;

    // Nibblers have attack range 1, so they close until adjacent. They move a tile a tick.
    //
    // Measured to the pillar's FOOTPRINT, not to its `location` corner - see
    // `distanceToFootprint`. This is not merely a tidier number: it is the cap `nibblerAt`
    // projects against, and against the corner that cap let a nibbler already pressed to the
    // north face be walked two more steps, which put it INSIDE the pillar. Nothing on the grid
    // has line of sight to a tile inside a pillar, so `barrageReach` came back zero from every
    // one of the 441 candidates and the bot was never pulled towards it at all - the nibbler ate
    // that pillar unopposed.
    const ticksToReach = target
      ? Math.max(
          0,
          distanceToFootprint(
            mob.location.x,
            mob.location.y,
            target.x,
            target.y,
            pillar?.size ?? 1,
          ) - 1,
        )
      : 0;

    threats.push({
      mob,
      x: mob.location.x,
      y: mob.location.y,
      size: mob.size,
      pillar: target ? { x: target.x, y: target.y } : null,
      ticksToReach,
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
