"use strict";

import { EntityNames, Mob, Region } from "osrs-sdk";

import { visibleMobs } from "./Visibility";

/**
 * When Zuk will attack next, derived from attacks we have actually SEEN.
 *
 * Extracted from ZukSimPanel because it stopped being a view the moment the tile scorer needed
 * it: positioning now answers "where do I have to be when Zuk fires", and a debug overlay cannot
 * be a scoring input. One observer, one answer - the strip on screen and the tiles the bot walks
 * to are reading the same clock, so they can never disagree about when the next attack is.
 *
 * NOTHING HERE KNOWS MORE THAN A PLAYER WATCHING THE SCREEN. Zuk's `attackDelay` is a private
 * countdown, so it is never used to say when an attack is coming. `observe` reads it only to spot
 * the RESET, which lands on the same tick the attack animation starts and the projectile spawns -
 * an event you can see. Its timing is used; its value never is. Until Zuk has attacked once there
 * is no phase to project from and every accessor below says so by returning null.
 *
 * The cadence itself (10 ticks, 7 enraged) is static knowledge a player has, the same way they
 * know Jad hits through prayer, so one sighting is enough to fix every future tick.
 */

interface ZukReading {
  hp: number;
  speed: number;
  enraged: boolean;
}

export class ZukAttackClock {
  /** Ticks seen since this module loaded. Only differences matter, never the value. */
  private static tick = 0;
  /** Last tick's `attackDelay`, purely to spot the reset. */
  private static lastDelay: number | null = null;
  /** The tick we last SAW Zuk attack, or null if we never have. */
  private static lastFireTick: number | null = null;
  /**
   * The attackSpeed Zuk had ON that fire, which is the length of the cycle now running.
   *
   * NOT the same as its speed today, and the difference killed a run. `didAttack` sets
   * `attackDelay = this.attackSpeed` at the MOMENT of firing, so the gap between two attacks is
   * fixed by the first of them. Enrage flipping 10 to 7 part-way through a countdown does not
   * shorten it - `attackDelay` is already mid-count and untouched - it only shortens cycles from
   * the next fire onward.
   *
   * Predicting with the CURRENT speed against a fire made under the old one applied the change
   * retroactively: measured, the clock reported the next attack four ticks later than it was,
   * the bot believed it had time it did not, and took 99 unprayed while walking back into cover.
   * Late is the fatal direction - early only wastes ticks.
   */
  private static speedAtLastFire = 0;
  /** The tick of every attack we have watched Zuk make, in order. Cleared when it leaves. */
  private static fireTicks: number[] = [];
  private static reading: ZukReading | null = null;

  /**
   * One tick of watching. Called from InfernoRegion.postTick BEFORE automation decides, so the
   * bot positions against this tick's observation rather than last tick's.
   *
   * `Unit.attackStep` decrements `attackDelay` and then `didAttack` resets it to `attackSpeed`,
   * so the only way the number can have gone UP since last tick is that Zuk fired. Testing for an
   * increase rather than `delay === speed` survives the enrage flip, which changes `attackSpeed`
   * from 10 to 7 underneath us and would otherwise register a phantom shot on whichever tick
   * happened to be sitting at 7.
   */
  static observe(region: Region) {
    ZukAttackClock.tick++;

    const zuk = visibleMobs(region).find(
      (mob: Mob) => mob.dying <= -1 && mob.mobName() === EntityNames.TZ_KAL_ZUK,
    ) as (Mob & { enraged?: boolean; attackDelay?: number }) | undefined;

    if (!zuk) {
      // Gone means the cadence is gone with it: a re-entry re-syncs from scratch rather than
      // carrying a dead phase forward.
      ZukAttackClock.reading = null;
      ZukAttackClock.lastDelay = null;
      ZukAttackClock.lastFireTick = null;
      ZukAttackClock.speedAtLastFire = 0;
      ZukAttackClock.fireTicks = [];
      return;
    }

    const delay = zuk.attackDelay ?? 0;
    if (ZukAttackClock.lastDelay !== null && delay > ZukAttackClock.lastDelay) {
      ZukAttackClock.lastFireTick = ZukAttackClock.tick;
      ZukAttackClock.fireTicks.push(ZukAttackClock.tick);
      // `attackDelay` was reset to the speed as it stands NOW, and that reset value IS the
      // length of the cycle just started - so reading it here is exact rather than inferred.
      ZukAttackClock.speedAtLastFire = delay;
    }
    ZukAttackClock.lastDelay = delay;
    ZukAttackClock.reading = {
      hp: zuk.currentStats?.hitpoint ?? 0,
      // Read off the mob rather than hardcoded 10/7: enrage flips it, and the getter is the only
      // thing that knows when.
      speed: zuk.attackSpeed ?? 10,
      enraged: zuk.enraged === true,
    };
  }

  /**
   * How many attacks Zuk has been WATCHED to make this fight.
   *
   * Counts fires, not damage. Zuk aims at the shield whenever the player is behind it, so most of
   * these never touch us - what is being counted is how far into the fight we are, which is what
   * a player counts too.
   */
  static attacksSeen(): number {
    return ZukAttackClock.fireTicks.length;
  }

  /**
   * Ticks elapsed since the Nth attack we watched (1-based), or null if it has not happened.
   *
   * Deliberately separate from `attacksSeen`. Zuk repeats every 10, so "10 ticks after the 5th"
   * and "the 6th" are the same instant while the count is right - and different the moment it is
   * not. Timing off a recorded tick rather than off a running total means the trigger cannot
   * drift with a missed or double-counted fire.
   */
  static ticksSinceNthAttack(n: number): number | null {
    const at = ZukAttackClock.fireTicks[n - 1];
    return at === undefined ? null : ZukAttackClock.tick - at;
  }

  /** Zuk as it can be seen this tick - hitpoints above its head, and its known cadence. */
  static zuk(): ZukReading | null {
    return ZukAttackClock.reading;
  }

  /** Have we watched Zuk attack at least once? Nothing below is meaningful until this is true. */
  static hasSync(): boolean {
    return ZukAttackClock.lastFireTick !== null && ZukAttackClock.reading !== null;
  }

  /**
   * Ticks from now until Zuk's next attack, or null before the first sighting.
   *
   * `speed` on the tick it just fired, counting down to 1 on the tick before the next one.
   */
  static ticksUntilNextAttack(): number | null {
    const reading = ZukAttackClock.reading;
    if (reading === null || ZukAttackClock.lastFireTick === null) {
      return null;
    }
    const since = ZukAttackClock.tick - ZukAttackClock.lastFireTick;

    // The cycle in flight runs at the speed it was STARTED with - see speedAtLastFire.
    const running = ZukAttackClock.speedAtLastFire || reading.speed;
    if (since < running) {
      return running - since;
    }
    // Past it without a sighting - the fire was missed, or it stalled with nothing to shoot. Fall
    // back to the current speed, which is right for every cycle after the first.
    return reading.speed - ((since - running) % reading.speed);
  }

  /**
   * Did we watch Zuk fire on the tick `offset` ticks from now? Only the past is answerable, so
   * this is for offsets of 0 or less; anything ahead is a prediction, not an observation.
   */
  static firedOnTickOffset(offset: number): boolean {
    return (
      ZukAttackClock.lastFireTick !== null &&
      ZukAttackClock.lastFireTick === ZukAttackClock.tick + offset
    );
  }

  /** Ticks since the fire we are projecting from, or null before the first sighting. */
  static ticksSinceLastAttack(): number | null {
    return ZukAttackClock.lastFireTick === null
      ? null
      : ZukAttackClock.tick - ZukAttackClock.lastFireTick;
  }
}
