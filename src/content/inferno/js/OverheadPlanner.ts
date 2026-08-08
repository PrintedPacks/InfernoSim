"use strict";

import { EntityNames } from "osrs-sdk";

import { Threat } from "./Trajectory";

/**
 * The single place that decides which overhead to pray, on this tick and every tick ahead.
 *
 * There is exactly one planner on purpose. The tile scorer and the prayer layer used to answer
 * this question separately - the scorer would price a tile at zero on the assumption of a blob
 * steer, and the prayer layer, looking one tick ahead, would see nothing incoming and flick
 * everything off. The steer never happened and the tile took the hit it was scored as avoiding.
 * A number you cannot learn from is worse than a wrong one, so both now call this.
 *
 * The reason prayer cannot be decided one tick at a time is blobs. A blob throws the OPPOSITE
 * of whatever overhead it saw three ticks earlier, so its style is not a property of the blob -
 * it is a consequence of a decision we already made. That makes the overhead a sequence, and a
 * sequence has to be planned rather than reacted to.
 */

export const MAGIC_PRAYER = "Protect from Magic";
export const RANGE_PRAYER = "Protect from Range";
export const MELEE_PRAYER = "Protect from Melee";

export const OVERHEAD_PRAYERS = [MAGIC_PRAYER, RANGE_PRAYER, MELEE_PRAYER];

/** Every overhead, plus the option of praying nothing at all. */
const PRAYER_OPTIONS: (string | null)[] = [MAGIC_PRAYER, RANGE_PRAYER, MELEE_PRAYER, null];

export function prayerForAttackStyle(style: string): string | null {
  switch (style) {
    case "magic":
      return MAGIC_PRAYER;
    case "range":
      return RANGE_PRAYER;
    case "crush":
    case "slash":
    case "stab":
      return MELEE_PRAYER;
    default:
      return null;
  }
}

/**
 * What a blob throws, given the overhead it scanned.
 *
 * JalAk.attackStyleForNewAttack returns the OPPOSITE of what it saw, so showing range makes it
 * throw magic. Melee - or nothing at all - is not a third choice: it fails the
 * `!== "magic" && !== "range"` test and the blob rolls at random instead. That is why a scan
 * tick already committed to blocking a meleer costs you the steer.
 */
export function blobStyles(shown: string | null): string[] {
  if (shown === MAGIC_PRAYER) {
    return ["range"];
  }
  if (shown === RANGE_PRAYER) {
    return ["magic"];
  }
  return ["magic", "range"];
}

/**
 * Scan ticks searched exhaustively. Four options each means 4^3 = 64 plans at worst, and a blob
 * only scans every six ticks, so a twelve tick horizon rarely reaches even this.
 */
const MAX_PLANNED_SCANS = 3;

export interface OverheadPlan {
  /** Expected damage that still gets through under this plan. */
  damage: number;
  /** Overhead to show on each tick that matters. Absent means nothing needs praying. */
  plan: Map<number, string | null>;
}

/**
 * Choose the overhead for every tick in the horizon, and report what still gets through.
 *
 * Three different kinds of uncertainty are handled differently, which is the whole subtlety:
 *
 *   - a BLOB is a decision. Its style is whatever our plan forces, so it is MINIMISED over -
 *     steer it to match the biggest thing landing on its fire tick and one overhead covers
 *     both. It only costs where it cannot be matched (a meleer on the same tick, since a blob
 *     throws magic or range only) or where its scan tick is already spent.
 *   - an adjacent mager or ranger is a coin flip. Mob.attack() rolls Random.get() to decide
 *     whether to switch to its melee style, and nothing we choose changes that, so it is
 *     averaged over instead. Praying one of its two styles blocks half its max hit.
 *   - JAD IS NOT A GUESS, and pricing it as one was wrong. This simulation deliberately never
 *     predicts Jad's roll (see Trajectory.snapshotMobs - resolving it would draw from the
 *     seeded stream on every one of 441 tile-scores a tick), so a Jad threat still arrives
 *     here as the ambiguous ["magic","range"] pair, same shape as an unscanned blob's. But
 *     LIVE PLAY is never actually guessing: JadTracker watches the animation and reads the
 *     REAL committed style three ticks before it lands, so the prayer that goes up is always
 *     the right one - unless something else needs the slot on that exact tick. Charging half
 *     of every landing's max hit as an unavoidable cost, on every tile in the arena (Jad's
 *     range is 50, it reaches everywhere), turned Jad into a flat, position-independent floor
 *     that swamped the one thing tile scoring actually exists to weigh - see
 *     TileScorer.focusHealer and the wave 68 dump that motivated this: every candidate priced
 *     within a few points of -226 regardless of position, so healer-dodge distance became the
 *     ONLY visible signal and the bot ran real distance to buy single-digit tie-breaks.
 *     So: a plan that shows Magic or Range - either one, since the true style is discovered
 *     before it lands, not gambled on - is charged NOTHING for Jad. A plan that spends the
 *     slot on something else instead pays Jad's FULL hit, not half, because on the tick that
 *     really happens nothing was guessed - the slot simply went elsewhere and Jad's
 *     known-but-unprayed hit lands whole. Scoped to the plain two-style case only: adjacency
 *     adds a real stab coin flip Jad's own weapon rolls at fire time (Mob.attack's
 *     canMeleeIfClose check), which this simulation can resolve no better than a mager's -
 *     though it never reaches a scored candidate anyway, since routeEntersForbiddenZone
 *     already refuses to stand next to Jad.
 */
export function planOverheads(threats: Threat[]): OverheadPlan {
  const plan = new Map<number, string | null>();
  if (threats.length === 0) {
    return { damage: 0, plan };
  }

  const byTick = new Map<number, Threat[]>();
  for (const threat of threats) {
    const list = byTick.get(threat.tick) ?? [];
    list.push(threat);
    byTick.set(threat.tick, list);
  }

  const scanTicks: number[] = [];
  for (const threat of threats) {
    if (threat.scanTick !== undefined && !scanTicks.includes(threat.scanTick)) {
      scanTicks.push(threat.scanTick);
    }
  }
  const planned = scanTicks.sort((a, b) => a - b).slice(0, MAX_PLANNED_SCANS);

  const shown = new Map<number, string | null>();

  const costOfTick = (tickThreats: Threat[], prayer: string | null): number => {
    let sum = 0;
    for (const threat of tickThreats) {
      // A blob whose scan this plan controls throws what the plan forces it to. Anything else
      // keeps the styles the simulation reported, which may be a genuine coin flip.
      let styles = threat.styles;
      if (threat.scanTick !== undefined && shown.has(threat.scanTick)) {
        // The scan decides magic against range, and nothing more. It does NOT decide the melee
        // flip: Mob.attack() rolls that separately at fire time, so a blob we have steered
        // perfectly still throws crush half the time if we are standing next to it - and crush
        // is unprayable alongside whatever we steered it to.
        //
        // Overwriting the simulated styles outright dropped that flip on the floor, and with it
        // the entire cost of standing beside a blob: the tile scorer priced adjacency at zero
        // and had no reason not to park there. Only the magic/range half is the plan's to choose.
        styles = [
          ...blobStyles(shown.get(threat.scanTick) ?? null),
          ...threat.styles.filter((style) => prayerForAttackStyle(style) === MELEE_PRAYER),
        ];
      }
      // Jad: 0 if the plan shows a category that covers it (Magic or Range - see the module
      // header), its FULL hit otherwise. Never the blob's null-style shape misread as Jad -
      // gated on the name, not just the ambiguous style pair - and never the adjacency case,
      // which keeps the ordinary averaged treatment below.
      if (threat.name === EntityNames.JAL_TOK_JAD && styles.length === 2) {
        const covered = styles.some(
          (style) => prayer !== null && prayerForAttackStyle(style) === prayer,
        );
        sum += covered ? 0 : threat.maxHit;
        continue;
      }

      const blocked = styles.filter(
        (style) => prayer !== null && prayerForAttackStyle(style) === prayer,
      ).length;
      sum += threat.maxHit * (1 - blocked / styles.length);
    }
    return sum;
  };

  /** Damage under the current scan-tick assignment, plus the per-tick choices it implies. */
  const evaluate = (): { damage: number; choices: Map<number, string | null> } => {
    const choices = new Map<number, string | null>(shown);
    let damage = 0;
    byTick.forEach((tickThreats, tick) => {
      if (shown.has(tick)) {
        damage += costOfTick(tickThreats, shown.get(tick) ?? null);
        return;
      }
      let best = Infinity;
      let bestPrayer: string | null = null;
      for (const option of PRAYER_OPTIONS) {
        const cost = costOfTick(tickThreats, option);
        if (cost < best) {
          best = cost;
          bestPrayer = option;
        }
      }
      damage += best;
      choices.set(tick, bestPrayer);
    });
    return { damage, choices };
  };

  let bestDamage = Infinity;
  let bestChoices = new Map<number, string | null>();

  const search = (index: number) => {
    if (index === planned.length) {
      const { damage, choices } = evaluate();
      if (damage < bestDamage) {
        bestDamage = damage;
        bestChoices = choices;
      }
      return;
    }
    for (const option of PRAYER_OPTIONS) {
      shown.set(planned[index], option);
      search(index + 1);
    }
    shown.delete(planned[index]);
  };
  search(0);

  return { damage: bestDamage, plan: bestChoices };
}
