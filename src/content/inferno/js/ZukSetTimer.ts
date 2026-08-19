"use strict";

import { EntityNames, Mob, Region } from "osrs-sdk";

import { visibleMobs } from "./Visibility";

/**
 * How long until Zuk's next mager-and-ranger pair, kept as our own clock.
 *
 * `TzKalZuk` already owns the real one, but `setTimer` is private state on the boss - the same
 * kind of thing `attackDelay` is - so this reproduces it from what can actually be watched: sets
 * arriving, and Zuk's hitpoints, which are drawn above its head. Every rule below is a
 * transcription of `TzKalZuk`, not an approximation of it:
 *
 *   attackIfPossible()   setTimer-- each tick while not paused; at 0 it spawns a pair and
 *                        resets to SET_INTERVAL
 *   damageTaken()        under 600 hitpoints, ONCE, the timer pauses (`hasPaused` makes it
 *                        one-shot - it can never pause a second time)
 *                        while paused, under 480 it gains PAUSE_BONUS and resumes, and Jad spawns
 *
 * 350 ticks is 3:30 and 175 is 1:45 at 0.6s a tick, which is where those numbers on screen come
 * from.
 *
 * THE OBSERVED SPAWN IS THE AUTHORITY, not the countdown. Every sighting of a new pair resets the
 * clock outright, so a drifting model self-corrects within one set rather than compounding - the
 * countdown is only ever a prediction of something that then confirms or corrects it.
 */

/**
 * Ticks from the wave starting to the FIRST pair - `TzKalZuk`'s `setTimer = 72` at construction,
 * not the 350 that follows it.
 *
 * Seeded rather than waited for, because there is nothing to sync to yet and the first pair is
 * the one that most needs the run-up: without it the bot spends the approach shooting Zuk, is on
 * a full weapon cooldown when the pair lands, and the mager gets a free hit while it runs down.
 * 72 is a fixed property of the fight in the same way the 7 and 9 spawn delays are - a player
 * knows the first set is about 43 seconds in - so using it is not the same as reading private
 * state off the boss.
 */
const OPENING_INTERVAL = 72;

/** Ticks between pairs once the fight is running. 350 * 0.6s = 3:30. */
const SET_INTERVAL = 350;
/** Added to the timer when it resumes under 480. 175 * 0.6s = 1:45. */
const PAUSE_BONUS = 175;
/** TzKalZuk.damageTaken's own thresholds. */
const PAUSE_HP = 600;
const RESUME_HP = 480;

export class ZukSetTimer {
  /** Ticks until the next pair, or null before the first one has ever been seen. */
  private static ticksLeft: number | null = null;
  private static paused = false;
  /** The engine's `hasPaused`: the pause is one-shot and can never happen twice. */
  private static hasPaused = false;
  private static resumed = false;
  /** Pairs already counted, by identity, so a spawn is registered exactly once. */
  private static seen = new WeakSet<Mob>();

  /** Called from InfernoRegion.postTick, alongside the other clocks. */
  static observe(region: Region) {
    const mobs = visibleMobs(region);
    const zuk = mobs.find(
      (mob) => mob.dying <= -1 && mob.mobName() === EntityNames.TZ_KAL_ZUK,
    );
    if (!zuk) {
      ZukSetTimer.reset();
      return;
    }

    // A pair arriving is the one fact worth more than the model. Counting magers rather than both
    // halves keeps it to one reset per set.
    let spawned = false;
    for (const mob of mobs) {
      if (mob.mobName() !== EntityNames.JAL_ZEK || ZukSetTimer.seen.has(mob)) {
        continue;
      }
      ZukSetTimer.seen.add(mob);
      spawned = true;
    }

    // First sight of Zuk with nothing spawned yet: start the opening countdown. Minus one for the
    // same reason as below - this tick has already been consumed by the engine's own decrement.
    if (ZukSetTimer.ticksLeft === null && !spawned) {
      ZukSetTimer.ticksLeft = OPENING_INTERVAL - 1;
      return;
    }

    if (spawned) {
      // Minus one: `visibleMobs` deliberately hides a mob until the tick AFTER it is added, so by
      // the time one can be seen its set is already a tick old. Resetting to the full interval
      // here would put every prediction permanently one tick late.
      ZukSetTimer.ticksLeft = SET_INTERVAL - 1;
      return;
    }

    const hp = zuk.currentStats?.hitpoint ?? 0;

    // Pause, once and only once - `hasPaused` in the engine.
    if (!ZukSetTimer.paused && !ZukSetTimer.hasPaused && hp < PAUSE_HP) {
      ZukSetTimer.paused = true;
      ZukSetTimer.hasPaused = true;
      return;
    }
    // Resume with the bonus, once, when it drops again. Jad arrives on this same tick.
    if (ZukSetTimer.paused && !ZukSetTimer.resumed && hp < RESUME_HP) {
      ZukSetTimer.paused = false;
      ZukSetTimer.resumed = true;
      if (ZukSetTimer.ticksLeft !== null) {
        ZukSetTimer.ticksLeft += PAUSE_BONUS;
      }
      return;
    }

    if (!ZukSetTimer.paused && ZukSetTimer.ticksLeft !== null && ZukSetTimer.ticksLeft > 0) {
      ZukSetTimer.ticksLeft--;
    }
  }

  private static reset() {
    ZukSetTimer.ticksLeft = null;
    ZukSetTimer.paused = false;
    ZukSetTimer.hasPaused = false;
    ZukSetTimer.resumed = false;
    ZukSetTimer.seen = new WeakSet<Mob>();
  }

  /**
   * Ticks until the next pair, or null before the first has been seen.
   *
   * Null is honest rather than lazy: the opening interval is 72 rather than 350 and nothing has
   * arrived yet to sync to, so the first set genuinely cannot be predicted by this. Seed it at
   * wave start if that changes.
   */
  static ticksUntilSet(): number | null {
    return ZukSetTimer.ticksLeft;
  }

  static isPaused(): boolean {
    return ZukSetTimer.paused;
  }

  /** MM:SS, the same conversion `TzKalZuk.drawUILayer` uses for its own readout. */
  static display(): string | null {
    if (ZukSetTimer.ticksLeft === null) {
      return null;
    }
    const seconds = Math.round(ZukSetTimer.ticksLeft * 0.6);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }
}
