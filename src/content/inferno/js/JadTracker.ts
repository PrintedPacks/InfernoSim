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
 * A committed Jad attack, remembered INDEPENDENTLY of the Jad it came from.
 *
 * The ghost hit: JadMagicWeapon/JadRangeWeapon register a DelayedAction that runs the real
 * `super.attack()` - damage roll AND protection check - three ticks after the animation
 * starts, with no check on the attacker still being alive. Kill Jad inside that window and
 * the fireball still lands. Meanwhile everything about the LIVE mob that announced the attack
 * is destroyed by `dead()`: `dying` goes positive, `aggro` is nulled, and the death animation
 * replaces `currentAnimation` - so a tracker that reads the mob deregisters the prayer at the
 * exact moment it is still needed, and a 113 max hit arrives unprayed. Measured by the user
 * as the "ghost hit".
 *
 * So a commit, once seen, lives here as a schedule with a landing tick, and the report below
 * reads THIS ledger rather than the mob. Records expire on their own within four ticks, so
 * there is no cross-wave state to reset.
 */
interface PendingJadAttack {
  mob: Mob;
  style: string;
  maxHit: number;
  /** Global tick the DelayedAction resolves on - the tick the prayer must already be up. */
  landsAtTick: number;
}

let pending: PendingJadAttack[] = [];

function tickOf(unit: { region?: { world?: { globalTickCounter?: number } } }): number | null {
  return unit.region?.world?.globalTickCounter ?? null;
}

/**
 * Record the committed style for any Jad that has just begun an attack animation.
 *
 * Must run every tick, before planning, or the commit tick is missed and that attack becomes
 * unblockable.
 *
 * Known edge this cannot cover: a Jad killed on the SAME tick its animation starts has the
 * death animation in place of the attack animation by the time this runs, so the commit is
 * unobservable - the attack was still registered and will still land. Every later kill inside
 * the window is covered, because the commit was recorded a tick or more before the death.
 */
export function observeJads(mobs: Mob[]): void {
  for (const mob of mobs) {
    if (!isJad(mob)) {
      continue;
    }
    const jad = mob as JadLike;
    if (jad.currentAnimation && jad.currentAnimationTick === ANIM_TICK_COMMIT) {
      jad[COMMITTED_STYLE] = jad.attackStyle;

      const now = tickOf(jad);
      if (now === null || !jad.attackStyle) {
        continue;
      }
      const landsAtTick = now + (ANIM_TICK_LAND - ANIM_TICK_COMMIT);
      // The debug grid can trigger a second observation in the same tick - one commit, one
      // record.
      if (!pending.some((p) => p.mob === mob && p.landsAtTick === landsAtTick)) {
        pending.push({ mob, style: jad.attackStyle, maxHit: mob.maxHit ?? 0, landsAtTick });
      }
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
 * Committed Jad attacks that resolve on the next tick, so the prayer must go up now.
 *
 * Read from the pending-attack ledger, NOT from the mobs - deliberately. The old version
 * filtered on `dying`, `aggro` and the live animation, and all three deregister the moment a
 * Jad dies, while its DelayedAction attack still lands regardless: the ghost hit. A committed
 * attack is a fact about the future, not a property of the mob that announced it. The mobs
 * parameter is kept so callers need not change; `player` guards against a record from a Jad
 * that was never fighting us at commit time (they always are, in this sim, but free to check).
 */
export function jadThreatsLandingNextTick(
  mobs: Mob[],
  player: Player,
): { mob: Mob; style: string; maxHit: number }[] {
  const now = tickOf(player);
  if (now === null) {
    return [];
  }
  pending = pending.filter((p) => p.landsAtTick > now);
  return pending
    .filter((p) => p.landsAtTick === now + 1)
    .map((p) => ({ mob: p.mob, style: p.style, maxHit: p.maxHit }));
}
