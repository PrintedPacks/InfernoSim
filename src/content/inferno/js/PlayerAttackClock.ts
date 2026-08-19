"use strict";

import { Player } from "osrs-sdk";

/**
 * The player's weapon cooldown, and when the next shot could actually land.
 *
 * DELIBERATELY NOT THE SAME SHAPE AS `ZukAttackClock`, because the two clocks do not behave the
 * same way and drawing them as if they did would be a lie.
 *
 * Zuk is relentless: `attackIfPossible` fires the moment its delay reaches zero, `didAttack`
 * resets it to `attackSpeed`, and the cycle repeats forever. Knowing one fire tick tells you every
 * future one.
 *
 * The player's does not repeat. `Player.attackIfPossible` only fires when there is aggro AND line
 * of sight, so with nothing targeted the delay counts down past zero and keeps going negative -
 * the weapon TIMES OUT and then simply sits there, available, for as long as it takes. So there
 * is no cadence to project: the only honest statement about the future is "the cooldown clears
 * here, and from that tick on a shot is available whenever one is asked for". Whether it is ever
 * asked for is a decision that has not been made yet, and this must not pretend otherwise.
 *
 * READING `attackDelay` HERE IS LEGITIMATE, WHERE IT IS NOT FOR ZUK. Zuk's countdown is hidden
 * state belonging to something else; the player's is their own weapon. A player knows the tick
 * they last attacked and knows what their weapon's speed is, so the cooldown is something they
 * genuinely have - no observation trick needed, and none used.
 */

interface PlayerReading {
  /** Ticks until the cooldown clears. Negative once it has cleared and gone unused. */
  delay: number;
  /** The equipped weapon's speed, or 0 with nothing equipped. Changes with a gear switch. */
  speed: number;
}

export class PlayerAttackClock {
  private static tick = 0;
  private static lastDelay: number | null = null;
  private static lastFireTick: number | null = null;
  private static reading: PlayerReading | null = null;

  /**
   * One tick of watching. Called from InfernoRegion.postTick alongside `ZukAttackClock.observe`.
   *
   * Registering a shot uses the same signal as Zuk's: `Unit.attackStep` decrements the delay and
   * `didAttack` resets it to `attackSpeed`, so an increase since last tick means a shot went out.
   * Robust to a gear switch for the same reason it is robust to Zuk's enrage - it compares
   * against the previous reading rather than against the current weapon's speed, so swapping from
   * a blowpipe to a bow mid-fight cannot fake a shot.
   */
  static observe(player: Player | null | undefined) {
    PlayerAttackClock.tick++;

    if (!player || player.isDying()) {
      PlayerAttackClock.reading = null;
      PlayerAttackClock.lastDelay = null;
      PlayerAttackClock.lastFireTick = null;
      return;
    }

    const delay = (player as unknown as { attackDelay?: number }).attackDelay ?? 0;
    if (PlayerAttackClock.lastDelay !== null && delay > PlayerAttackClock.lastDelay) {
      PlayerAttackClock.lastFireTick = PlayerAttackClock.tick;
    }
    PlayerAttackClock.lastDelay = delay;
    PlayerAttackClock.reading = { delay, speed: player.attackSpeed ?? 0 };
  }

  static weapon(): PlayerReading | null {
    return PlayerAttackClock.reading;
  }

  /** Did we fire on the tick `offset` ticks from now? Only the past is answerable. */
  static firedOnTickOffset(offset: number): boolean {
    return (
      PlayerAttackClock.lastFireTick !== null &&
      PlayerAttackClock.lastFireTick === PlayerAttackClock.tick + offset
    );
  }

  /** True once the cooldown has cleared and the shot is sitting unused. */
  static isReadyNow(): boolean {
    const reading = PlayerAttackClock.reading;
    return reading !== null && reading.delay <= 0;
  }

  /**
   * The earliest tick offset a shot could actually go out, or null with no weapon state.
   *
   * Floored at 1, not 0. `Player.attackStep` has already run by the time anything reads this, so
   * the soonest a decision made now can put a projectile in the air is next tick - even with the
   * cooldown long expired. Reporting 0 would promise a shot on a tick that has already finished.
   */
  static earliestShotOffset(): number | null {
    const reading = PlayerAttackClock.reading;
    return reading === null ? null : Math.max(1, reading.delay);
  }
}
