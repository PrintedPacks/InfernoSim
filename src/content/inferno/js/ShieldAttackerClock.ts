"use strict";

import { EntityNames, Mob, Player, Region } from "osrs-sdk";

import { committedStyle, isJad, ticksUntilJadLands } from "./JadTracker";
import { SimMob, withinMeleeRange } from "./Trajectory";
import { visibleMobs } from "./Visibility";

/**
 * When the mager and ranger will attack, from attacks we have actually SEEN.
 *
 * Same rule as `ZukAttackClock`: `attackDelay` is private state, so it is read only to spot the
 * RESET - the tick the attack animation starts and the projectile spawns, which is something you
 * can watch happen. Its timing is used, its value never is, and a mob that has not yet attacked
 * has no phase and is reported as such rather than guessed at.
 *
 * THE OPENING ATTACK IS READ STRAIGHT OFF THE ENGINE, which is a deliberate exception to the
 * rule above and the one place this file looks at state a player cannot see. A freshly spawned
 * mager or ranger has no cadence to sync to, but its first attack is not a guess - it is fixed by
 * the spawn options `TzKalZuk` hands it, and `spawnClock` below reproduces it exactly:
 *
 *   tick S      spawned; `Mob.movementStep` decrements `age`, `attackStep` returns early
 *   tick S+6    age reaches 0, `attackIfPossible` runs but `canAttack()` is false - `setStats`
 *               left `stunned` at 1 and nothing has decremented it yet - then stunned -> 0
 *   tick S+7    attacks
 *
 * So the first attack lands exactly `spawnDelay` ticks after the spawn (7 mager, 9 ranger), the
 * stun absorbing the single tick where age hits zero. From any earlier tick the remaining count
 * is `age + 1 while still stunned`, floored at 1 because the soonest anything can happen is the
 * next tick. Once it HAS fired, the observed cadence takes over and this is never consulted
 * again - so a mob whose opening was delayed by line of sight self-corrects immediately.
 *
 * JAD IS NOT SHAPED LIKE THE OTHERS AND IS NOT DRAWN LIKE THEM. Everything else commits its
 * style and rolls damage on the same tick, so the fire tick IS the tick the overhead is checked.
 * Jad does neither:
 *
 *  - `JadMagicWeapon`/`JadRangeWeapon` defer the real `super.attack()` by JAD_LAND_DELAY ticks,
 *    so the prayer is checked THREE TICKS AFTER the animation begins. The lane therefore marks
 *    the LANDING tick, not the fire - marking the fire would have the strip telling you to flick
 *    three ticks before it matters, and clear three ticks before it is safe.
 *  - its style is only truthful on the tick the animation starts. `Mob.attackIfPossible`
 *    re-rolls `attackStyle` every tick, so reading it at any other moment is a coin flip -
 *    measured at ~8000 damage per 240 attacks in jadTimeline.test.ts. `JadTracker.observeJads`
 *    captures it at the commit and remembers it, and `committedStyle` is the only honest read.
 *
 * So a Jad attack appears twice over its life: as an UNKNOWN at its projected landing while the
 * cadence is all we have, and then - from the tick it commits - as its real style at the exact
 * tick the overhead is tested. Those three ticks of warning are the whole Jad mechanic, and a
 * lane that showed it as permanently unknown threw them away.
 *
 * PER MOB, NOT PER TYPE, because there is rarely one of each. `TzKalZuk` spawns a fresh
 * mager+ranger pair every 350 ticks and the old ones do not necessarily die first, so the board
 * can hold several of either with completely unrelated phases. Each is tracked on its own.
 *
 * AN ATTACK CAN ARRIVE AS MORE THAN ONE STYLE, which is why `styles` is a list rather than a
 * value. `JalZek` and `JalXil` both implement `canMeleeIfClose`, and `Mob.attack()` re-rolls at
 * fire time:
 *
 *     if (canMeleeIfClose() && !isMeleeAttackStyle(attackStyle))
 *       if (isWithinMeleeRange() && Random.get() < 0.5)  -> melee instead
 *
 * So from a tile adjacent to a mager, the attack is a coin flip between magic and stab, and one
 * overhead covers half of it. Reporting a single style there would be worse than reporting
 * nothing - it reads as settled when it is not. Same shape `Trajectory.stylesAtFireTime` uses,
 * and the adjacency test is literally its `withinMeleeRange`, imported rather than re-derived so
 * the two cannot disagree about what counts as next to a 3x3.
 *
 * The RANGED half is safe to read off the name: both return a constant from
 * `attackStyleForNewAttack`, unlike Jad, whose version is a coin flip that would both mislead and
 * consume a seeded random.
 *
 * Judged against where the player stands NOW. These mobs are stationary once they can see you -
 * `Unit.canMove()` is `!hasLOS && ...`, and with range 15 they acquire immediately and park - so
 * the only thing that moves the answer is the player, and predicting that is a different problem.
 */

export interface AttackerFire {
  /** Ticks from now. Zero or less is something we watched; positive is projected. */
  offset: number;
  /**
   * Every style this attack might arrive as. One entry means it is settled; more than one means
   * the engine has not rolled yet - see the note at the top.
   */
  styles: string[];
  /** True when this is an attack we observed rather than one the cadence predicts. */
  observed: boolean;
}

interface Tracked {
  lastDelay: number;
  lastFireTick: number | null;
  speed: number;
  styles: string[];
  /** Ticks until its FIRST attack, for a mob that has not attacked yet. See spawnClock. */
  untilFirstFire: number;
  jad: boolean;
}

/**
 * Ticks between a Jad attack starting and the overhead being tested.
 *
 * `JadTracker.ANIM_TICK_LAND - ANIM_TICK_COMMIT`, kept in step by hand because that module keeps
 * them private. Three.
 */
export const JAD_LAND_DELAY = 3;

/**
 * Ticks until a mob that has never attacked takes its first swing - see the note at the top.
 *
 * Floored at 1: `Mob.attackStep` has already run by the time this is read, so nothing can happen
 * sooner than the next tick.
 */
function spawnClock(mob: Mob): number {
  const live = mob as unknown as { age?: number; stunned?: number };
  const age = live.age ?? 0;
  const stunned = (live.stunned ?? 0) > 0 ? 1 : 0;
  return Math.max(1, age + stunned);
}

/**
 * A style that is deliberately not a style: something WILL land on this tick and which overhead
 * stops it is not knowable yet.
 *
 * `prayerForAttackStyle` returns null for it, so it can never be mistaken for a prayable style
 * and can never be silently dropped into one of the real buckets.
 */
export const UNKNOWN_STYLE = "unknown";

/**
 * What this mob throws from a distance, or null if it is not one we track.
 *
 * JAD IS DELIBERATELY UNKNOWN RATHER THAN GUESSED. `JalTokJad.attackStyleForNewAttack` is a fresh
 * `Random.get() < 0.5` on every call, with no caching - so asking it does two bad things at once:
 * it returns a number unrelated to what Jad will actually do, and it consumes a draw from the
 * seeded stream, moving the simulation. The honest answer is that the tick is taken and the style
 * is not decided, which is exactly what the lane should show.
 */
export function rangedStyleOf(mob: Mob): string | null {
  const name = mob.mobName();
  if (name === EntityNames.JAL_ZEK) {
    return "magic";
  }
  if (name === EntityNames.JAL_XIL) {
    return "range";
  }
  return name === EntityNames.JAL_TOK_JAD ? UNKNOWN_STYLE : null;
}

/**
 * Every style this mob's next attack could arrive as, given where the player is standing.
 *
 * `withinMeleeRange` only reads x, y and size off its argument, so a shape carrying those three
 * is enough - the cast avoids rebuilding a whole SimMob to ask one geometric question.
 */
export function stylesFor(mob: Mob, player: Player | null | undefined, ranged: string): string[] {
  const melee = mob.canMeleeIfClose?.();
  if (!melee || !player) {
    return [ranged];
  }
  const box = { x: mob.location.x, y: mob.location.y, size: mob.size } as unknown as SimMob;
  return withinMeleeRange(box, player.location.x, player.location.y)
    ? [ranged, melee]
    : [ranged];
}

export class ShieldAttackerClock {
  private static tick = 0;
  /** Keyed by the mob itself, so two magers with different phases never share an entry. */
  private static tracked = new Map<Mob, Tracked>();

  /**
   * One tick of watching. Called from InfernoRegion.postTick alongside the other clocks.
   *
   * Entries are rebuilt against the live mobs each tick, so a dead mager's phase cannot linger
   * and be drawn as a threat that no longer exists.
   */
  static observe(region: Region, player?: Player | null) {
    ShieldAttackerClock.tick++;

    const live = new Map<Mob, Tracked>();
    for (const mob of visibleMobs(region)) {
      if (mob.dying > -1) {
        continue;
      }
      const ranged = rangedStyleOf(mob);
      if (!ranged) {
        continue;
      }
      const delay = (mob as unknown as { attackDelay?: number }).attackDelay ?? 0;
      const previous = ShieldAttackerClock.tracked.get(mob);
      const entry: Tracked = {
        lastDelay: delay,
        lastFireTick: previous?.lastFireTick ?? null,
        speed: mob.attackSpeed ?? 4,
        styles: stylesFor(mob, player, ranged),
        untilFirstFire: spawnClock(mob),
        jad: isJad(mob),
      };
      // The reset that means it fired - see the note at the top. ONLY a jump to the FULL
      // cooldown counts: `didAttack` is the one thing that writes `attackSpeed` into the delay.
      // Two other things also move it UPWARD and are not attacks - the mager's flicker parks the
      // delay at 1 the tick before it fires (`JalZek.attackIfPossible`), and a tag landing on a
      // shield-aggroed mob flinches it to `flinchDelay + 1` (`Unit.processIncomingAttacks`).
      // Both used to register phantom fires here, and a phantom fire is worse than a missed one:
      // every projection afterwards is anchored a tick or two early, exactly when the automation
      // is trying to place a tag BY that projection.
      if (previous && delay > previous.lastDelay && delay === entry.speed) {
        entry.lastFireTick = ShieldAttackerClock.tick;
      }
      live.set(mob, entry);
    }
    ShieldAttackerClock.tracked = live;
  }

  /**
   * Every attack falling inside the window, one entry per mob per tick it fires on.
   *
   * A mob that has never been seen to attack contributes nothing: there is no phase to project
   * from and inventing one would be exactly the kind of guess this file exists to avoid.
   */
  static firesInWindow(
    fromOffset: number,
    toOffset: number,
    include?: (mob: Mob) => boolean,
  ): AttackerFire[] {
    const fires: AttackerFire[] = [];
    ShieldAttackerClock.tracked.forEach((entry, mob) => {
      // An optional filter, because not every caller means "everything on the board". The
      // off-tick gate asks only about mobs whose attacks actually reach the PLAYER - the ones
      // it has to fit a new tag around - and which mobs those are is its judgement, not ours.
      if (include && !include(mob)) {
        return;
      }
      // A Jad attack already in flight: the style is no longer a guess and the tick it is tested
      // on is known exactly. This is the useful half of the lane, so it is added on top of the
      // projection rather than instead of it - the projection covers what comes AFTER.
      if (entry.jad) {
        const lands = ticksUntilJadLands(mob);
        const style = committedStyle(mob);
        if (lands !== null && style && lands >= fromOffset && lands <= toOffset) {
          fires.push({ offset: lands, styles: [style], observed: true });
        }
      }
      for (let offset = fromOffset; offset <= toOffset; offset++) {
        // The past is only ever answerable by observation.
        if (offset <= 0) {
          if (entry.lastFireTick === ShieldAttackerClock.tick + offset) {
            fires.push({ offset, styles: entry.styles, observed: true });
          }
          continue;
        }
        // Attacked before: project off the cadence we watched. Jad's projection is shifted to
        // the tick its attack would LAND rather than the tick it starts - see the note at the top.
        if (entry.lastFireTick !== null) {
          const since = ShieldAttackerClock.tick - entry.lastFireTick;
          const shift = entry.jad ? JAD_LAND_DELAY : 0;
          if ((offset - shift + since) % entry.speed === 0 && offset - shift >= 0) {
            fires.push({ offset, styles: entry.styles, observed: false });
          }
          continue;
        }
        // Never attacked: the opening is fixed by the spawn, and everything after it follows the
        // same cadence from there.
        const first = entry.untilFirstFire + (entry.jad ? JAD_LAND_DELAY : 0);
        if (offset >= first && (offset - first) % entry.speed === 0) {
          fires.push({ offset, styles: entry.styles, observed: false });
        }
      }
    });
    return fires;
  }

  /** How many mager/ranger are on the board, and how many have actually attacked yet. */
  /**
   * Ticks until this mob's next attack, or null if it is not one we track.
   *
   * The same two cases `firesInWindow` projects from, asked about one mob:
   *
   *   never fired   `spawnClock` - the spawn delay still counting down, recomputed every tick in
   *                 `observe`, so it is a live reading rather than a stamp from first sighting
   *   fired before  its own cadence, measured from the tick we watched it reset
   *
   * Exists so a target can be chosen by WHEN IT IS ABOUT TO HIT rather than by how near it is.
   * Distance decides which mob is convenient; this decides which one is expensive.
   */
  static ticksUntilFire(mob: Mob): number | null {
    const entry = ShieldAttackerClock.tracked.get(mob);
    if (!entry) {
      return null;
    }
    if (entry.lastFireTick === null) {
      return entry.untilFirstFire;
    }
    const since = ShieldAttackerClock.tick - entry.lastFireTick;
    const speed = entry.speed || 1;
    return speed - (since % speed);
  }

  /**
   * Whether this mob has ever been watched firing.
   *
   * The distinction matters to the off-tick gate because a mager that has NOT fired yet is the
   * one state where its pre-attack flicker survives across a tick boundary - `JalZek`'s spawn
   * path arms the flicker the tick before its opening attack, and that armed attack goes
   * through REGARDLESS of a flinch landing on the same tick. See TagCollisionGate.
   */
  static hasFired(mob: Mob): boolean {
    return (ShieldAttackerClock.tracked.get(mob)?.lastFireTick ?? null) !== null;
  }

  static counts(): { total: number; fired: number } {
    let total = 0;
    let fired = 0;
    ShieldAttackerClock.tracked.forEach((entry) => {
      total++;
      if (entry.lastFireTick !== null) {
        fired++;
      }
    });
    return { total, fired };
  }
}
