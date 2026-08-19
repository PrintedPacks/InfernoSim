"use strict";

import { EntityNames, Mob, Player, Region } from "osrs-sdk";

import { prayerForAttackStyle } from "./OverheadPlanner";
import {
  JAD_LAND_DELAY,
  rangedStyleOf,
  ShieldAttackerClock,
  stylesFor,
  UNKNOWN_STYLE,
} from "./ShieldAttackerClock";

/**
 * May this tag go out NOW, or would it wire a new attacker into the prayer timeline on ticks
 * the timeline cannot absorb?
 *
 * THE TICK A TAG LANDS CHOOSES THE MOB'S PHASE, and that is the entire lever this gate pulls.
 * A set mob spawns aggroed to the shield and turns on us only when our projectile LANDS -
 * `JalZek`/`JalXil`/`JalTokJad` all override `shouldChangeAggro` to `aggro != projectile.from`.
 * At that landing, `Unit.processIncomingAttacks` flinches it: `attackDelay` is raised to
 * `flinchDelay + 1` (never lowered) if it was below that. So the mob's first attack on the
 * player - and every attack after it, `attackSpeed` apart - is fixed by WHEN the tag lands,
 * and waiting a tick moves the whole future cadence by a tick. That is what lets mage be kept
 * off range: hold the click until the phase it produces fits.
 *
 * WHAT "FITS" MEANS: one overhead per tick. The prayer layer flicks freely between ticks, so a
 * magic attack on tick t and a range attack on t+1 cost nothing - but two different prayers
 * demanded on the SAME tick is damage no overhead can answer. Same style on the same tick is
 * fine: mage on mage stacks under one prayer. So the test is per-tick: every attack testing the
 * overhead on a tick must want the SAME prayer, and any attack whose style is not knowable in
 * advance can never satisfy that against company.
 *
 * JAD IS PERMANENTLY AMBIGUOUS, BY DESIGN. Its style is a fresh coin flip at fire time,
 * observable only when the animation commits - three ticks before the overhead is tested, which
 * is enough warning to flick to IT but not enough to have planned anything else on that tick.
 * So Jad's ticks match nothing, in both directions: a pair tag may not land its cadence on a
 * Jad landing tick, and a Jad tag may not put Jad's landing ticks on anyone else's cadence.
 *
 * PREDICTING THE FIRST ATTACK, exactly as the engine will run it. Offsets are ticks from now
 * (the postTick this decides in - same clock as ShieldAttackerClock):
 *
 *   fire     +1                        the click sets aggro now, `Player.attackStep` fires next
 *                                      tick (the caller only clicks at `earliestShotOffset` 1)
 *   landing  +1 + calculateHitDelay+1  the engine adds one to a player projectile's delay
 *                                      because mobs process hits in `movementStep`, BEFORE the
 *                                      player's `attackStep` created it that tick
 *   flinch   at landing                delay becomes max(delay at landing, flinchDelay + 1);
 *                                      the landing happens in the mob's movement phase, so that
 *                                      same tick's `attackStep` already counts it down once,
 *                                      and the first attack fires `D - 1` ticks after landing
 *   after    every `attackSpeed`       these mobs park once they have line of sight
 *                                      (`canMove()` is `!hasLOS && ...`), so the cadence holds
 *
 * The delay AT landing is not readable - it is reconstructed from the cadence the clock has
 * watched: if the mob's next shield attack is `nf` ticks out, its delay on the landing tick is
 * `nf - landing + 1`. A tag landing right after it fired (delay still above the flinch floor)
 * changes nothing and the mob KEEPS its shield phase; a tag landing later gets the floor, and
 * the first attack is `landing + flinchDelay` - the tag-timed phase. Both fall out of the same
 * max().
 *
 * ONE EDGE IS REFUSED RATHER THAN PREDICTED: a mager that has never attacked arms its flicker
 * the tick before its opening shot, and `JalZek.attackStep` fires an armed flicker REGARDLESS
 * of the flinch that just raised its delay - so a tag landing exactly on that opening redirects
 * the shot to the player on the spot and puts the whole cadence on the spawn's phase, not the
 * tag's. Rather than model a one-tick window that exists once per mob, the gate declines that
 * alignment and the caller waits a tick.
 *
 * TAGS IN FLIGHT ARE PART OF THE TIMELINE. The aggro flip is invisible until the projectile
 * lands, so for a few ticks a mob we have committed to reads as still on the shield and the
 * clock still projects its shield cadence - which the landing is about to overwrite. Every tag
 * this gate approves is remembered (`noteTag`) with the cadence it predicted, that prediction
 * stands in for the mob until its first real attack is watched, and a second tag is judged
 * against it. The entry expires on the predicted fire tick: from there the clock has observed
 * the real thing and is the better source.
 */

/** The cadence a tag was approved with - remembered until the engine confirms it. */
export interface TagPrediction {
  /** Absolute gate tick of the first post-tag attack (the FIRE, not the landing). */
  fireTick: number;
  /** Ticks between that fire and the overhead being tested - JAD_LAND_DELAY for Jad, else 0. */
  shift: number;
  /** Ticks between attacks from then on. */
  speed: number;
  /** Every style those attacks might arrive as - one entry means it is settled. */
  styles: string[];
}

export interface TagVerdict {
  safe: boolean;
  /** Why the tag is being held, for the state line. Null when safe. */
  reason: string | null;
  /** Present when this verdict is about an actual tag - hand it to `noteTag` on the click. */
  prediction?: TagPrediction;
}

const SAFE: TagVerdict = { safe: true, reason: null };

/**
 * How far past the first predicted attack the timeline is checked, in ticks.
 *
 * Long enough to be EXACT rather than a sample: every attacker here is periodic at 4 (the
 * pair) or 8 (Jad), so two cadences that collide at all collide within the least common
 * multiple - 8 ticks - of both being live. A longer window finds nothing new and starts
 * pricing in attacks from mobs that will be dead by then; a shorter one misses the 4-against-8
 * alignments entirely.
 */
const COLLISION_WINDOW = 8;

/**
 * The prayer a tick full of these styles demands, or null if no single prayer covers it.
 *
 * More than one possible style - Jad's unknown, or a mob close enough to melee - is ambiguous
 * by definition: whatever is prayed, some version of the attack comes through. Ambiguous never
 * matches anything, including another copy of itself.
 */
function requiredPrayer(styles: string[]): string | null {
  if (styles.length !== 1) {
    return null;
  }
  return prayerForAttackStyle(styles[0]);
}

export class TagCollisionGate {
  /** Same convention as the other clocks: incremented once per postTick, offsets hang off it. */
  private static tick = 0;
  /** Tags approved and clicked, keyed by the mob, until the engine shows us the real cadence. */
  private static committed = new Map<Mob, TagPrediction>();

  /**
   * One tick of bookkeeping. Called from InfernoRegion.postTick alongside the other clocks,
   * AFTER ShieldAttackerClock - expiry hands over to a clock that has already seen this tick.
   */
  static observe(region: Region) {
    TagCollisionGate.tick++;
    if (((region as unknown as { wave?: number }).wave ?? 0) !== 69) {
      if (TagCollisionGate.committed.size > 0) {
        TagCollisionGate.committed.clear();
      }
      return;
    }
    TagCollisionGate.committed.forEach((prediction, mob) => {
      // Dead, or reached its predicted first attack: either way the prediction has nothing
      // left to say. On the fire tick itself the clock watched the reset happen this very
      // postTick, so projection continues from the real attack without a gap.
      if (mob.dying > -1 || TagCollisionGate.tick >= prediction.fireTick) {
        TagCollisionGate.committed.delete(mob);
      }
    });
  }

  /** Remember an approved tag the caller has actually clicked. See the note at the top. */
  static noteTag(mob: Mob, prediction: TagPrediction) {
    TagCollisionGate.committed.set(mob, prediction);
  }

  /**
   * Judge attacking this mob on THIS tick. Cheap, and stateless until `noteTag`.
   *
   * Only a first tag is ever gated. A mob already ours is on whatever cadence the tag gave it
   * and further hits change nothing - `shouldChangeAggro` is false once we are the aggro, so
   * there is no second flinch. A mob with a tag in flight is likewise committed; blocking the
   * follow-up shot would cost damage without moving anything.
   */
  static evaluate(region: Region, player: Player, target: Mob): TagVerdict {
    const ranged = rangedStyleOf(target);
    if (!ranged) {
      return SAFE;
    }
    if (target.aggro === player || TagCollisionGate.committed.has(target)) {
      return SAFE;
    }
    const untilFire = ShieldAttackerClock.ticksUntilFire(target);
    if (untilFire === null) {
      // Spawned so recently the clock has no entry. One tick of patience beats a guess.
      return { safe: false, reason: "no cadence to judge yet" };
    }

    // Landing tick of the tag, from the weapon actually in hand. Both callers click on the
    // tick the shot goes out next tick, so the click is +0 and the fire is +1. The distance is
    // measured the way `Projectile` measures it - closest tile of the target's box - with the
    // one known blur that a shot taken mid-walk leaves from next tick's tile, not this one;
    // at worst that is one tile, which only moves the hit delay at a range band's edge.
    const closest = target.getClosestTileTo(player.location.x, player.location.y);
    const distance = Math.max(
      Math.abs(closest[0] - player.location.x),
      Math.abs(closest[1] - player.location.y),
    );
    const weapon = (player.equipment?.weapon ?? null) as {
      calculateHitDelay?: (distance: number) => number;
    } | null;
    const hitDelay = weapon?.calculateHitDelay?.(distance) ?? 1;
    const landing = 1 + hitDelay + 1;

    const speed = target.attackSpeed ?? 4;
    const jad = target.mobName() === EntityNames.JAL_TOK_JAD;

    // The opening-flicker redirect - see the note at the top. Only a mager that has never
    // attacked can be holding an armed flicker across a tick boundary.
    if (
      target.mobName() === EntityNames.JAL_ZEK &&
      !ShieldAttackerClock.hasFired(target) &&
      landing === untilFire
    ) {
      return { safe: false, reason: "tag would land on its opening attack" };
    }

    // Reconstruct the flinch from the cadence - the arithmetic in the note at the top.
    let nextFire = untilFire;
    while (nextFire < landing) {
      nextFire += speed;
    }
    const delayAtLanding = nextFire - landing + 1;
    const flinchFloor = target.flinchDelay + 1;
    const firstFire = landing + Math.max(delayAtLanding, flinchFloor) - 1;

    const shift = jad ? JAD_LAND_DELAY : 0;
    const styles = jad ? [UNKNOWN_STYLE] : stylesFor(target, player, ranged);
    const mine = requiredPrayer(styles);

    // The ticks this tag would add to the timeline: overhead-test ticks, so Jad's are shifted
    // to the landing exactly as the clock shifts its own Jad projections.
    const first = firstFire + shift;
    const windowEnd = first + COLLISION_WINDOW;

    // What the timeline already holds on those ticks. Only attacks that actually reach the
    // player: mobs already turned on us - minus any whose shield cadence a tag in flight is
    // about to overwrite - plus the remembered predictions standing in for those tags.
    const taken = new Map<number, string[][]>();
    const claim = (offset: number, claimedStyles: string[]) => {
      const list = taken.get(offset);
      if (list) {
        list.push(claimedStyles);
      } else {
        taken.set(offset, [claimedStyles]);
      }
    };
    for (const fire of ShieldAttackerClock.firesInWindow(
      first,
      windowEnd,
      (mob) =>
        mob !== target && mob.aggro === player && !TagCollisionGate.committed.has(mob),
    )) {
      claim(fire.offset, fire.styles);
    }
    TagCollisionGate.committed.forEach((pending, mob) => {
      if (mob === target || mob.dying > -1) {
        return;
      }
      for (
        let offset = pending.fireTick - TagCollisionGate.tick + pending.shift;
        offset <= windowEnd;
        offset += pending.speed
      ) {
        if (offset >= first) {
          claim(offset, pending.styles);
        }
      }
    });

    for (let offset = first; offset <= windowEnd; offset += speed) {
      for (const theirs of taken.get(offset) ?? []) {
        const required = requiredPrayer(theirs);
        if (mine === null || required === null || mine !== required) {
          return {
            safe: false,
            reason:
              `${styles.join("/")} would share tick +${offset} ` +
              `with ${theirs.join("/")}`,
          };
        }
      }
    }

    return {
      safe: true,
      reason: null,
      prediction: {
        fireTick: TagCollisionGate.tick + firstFire,
        shift,
        speed,
        styles,
      },
    };
  }
}
