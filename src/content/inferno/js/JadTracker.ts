"use strict";

import { EntityNames, Mob, Player } from "osrs-sdk";

/**
 * Tracks Jad attacks, which cannot be handled like any other mob.
 *
 * Ordinary mobs commit their style and roll damage in the same tick, so the prayer has to be
 * up in advance and the style is predictable from `attackStyleForNewAttack()`. Jad is the
 * opposite on both counts:
 *
 *  - its style is `Random.get() < 0.5 ? "range" : "magic"` - a genuine coin flip, so it
 *    cannot be predicted before the attack starts;
 *  - JadMagicWeapon/JadRangeWeapon defer the real `super.attack()` by JAD_PROJECTILE_DELAY
 *    ticks, so the protection prayer is checked three ticks AFTER the animation begins.
 *
 * That makes Jad reactive: watch for the animation, read the style, and have the prayer up
 * before the deferred attack resolves.
 *
 * The trap: `Mob.attackIfPossible()` reassigns `this.attackStyle = attackStyleForNewAttack()`
 * on EVERY tick, so for Jad the field is re-rolled continuously and only tells the truth on
 * the tick the animation starts. Reading it later is a coin flip - measured at ~8000 damage
 * per 240 attacks in test/harness/jadTimeline.test.ts, versus 0 when captured at the start.
 * So the committed style is recorded once and remembered.
 */

/** Animation tick on which attack() fires and the style is committed. */
const ANIM_TICK_COMMIT = 1;

/**
 * Animation tick on which the deferred super.attack() runs, rolling damage and checking the
 * overhead. ANIM_TICK_COMMIT + JAD_PROJECTILE_DELAY (3).
 */
const ANIM_TICK_LAND = 4;

const COMMITTED_STYLE = "__automationCommittedStyle";

type JadLike = Mob & {
  currentAnimation?: unknown;
  currentAnimationTick?: number;
  [COMMITTED_STYLE]?: string | null;
};

/**
 * Identify Jad by name rather than by the presence of an animation counter - shape checks
 * across these mobs are unreliable, since several share fields they do not all use.
 */
export function isJad(mob: Mob): boolean {
  return mob.mobName() === EntityNames.JAL_TOK_JAD;
}

/**
 * Record the committed style for any Jad that has just begun an attack animation.
 *
 * Must run every tick, before planning, or the commit tick is missed and that attack becomes
 * unblockable.
 */
export function observeJads(mobs: Mob[]): void {
  for (const mob of mobs) {
    if (!isJad(mob)) {
      continue;
    }
    const jad = mob as JadLike;
    if (jad.currentAnimation && jad.currentAnimationTick === ANIM_TICK_COMMIT) {
      jad[COMMITTED_STYLE] = jad.attackStyle;
    }
  }
}

/** The style a Jad committed to on its current animation, or null if it is not attacking. */
export function committedStyle(mob: Mob): string | null {
  return (mob as JadLike)[COMMITTED_STYLE] ?? null;
}

/** Ticks until this Jad's pending attack resolves, or null when nothing is pending. */
export function ticksUntilJadLands(mob: Mob): number | null {
  const jad = mob as JadLike;
  if (!jad.currentAnimation || !committedStyle(mob)) {
    return null;
  }
  const remaining = ANIM_TICK_LAND - (jad.currentAnimationTick ?? 0);
  return remaining >= 0 ? remaining : null;
}

/**
 * Jads whose deferred attack resolves on the next tick, so the prayer must go up now.
 *
 * Uses the remembered style rather than the live `attackStyle` field, which by this point has
 * been re-rolled several times.
 */
export function jadThreatsLandingNextTick(
  mobs: Mob[],
  player: Player,
): { mob: Mob; style: string; maxHit: number }[] {
  const threats: { mob: Mob; style: string; maxHit: number }[] = [];
  for (const mob of mobs) {
    if (!isJad(mob) || mob.aggro !== player || mob.dying > -1) {
      continue;
    }
    const style = committedStyle(mob);
    if (!style || ticksUntilJadLands(mob) !== 1) {
      continue;
    }
    threats.push({ mob, style, maxHit: mob.maxHit ?? 0 });
  }
  return threats;
}
