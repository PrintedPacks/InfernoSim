"use strict";

/**
 * One seeded WAVE 68 - the triple Jad - through the REAL bot, reported so the ending explains
 * itself.
 *
 * Same machinery as `zukRun.test.ts`, pointed one wave earlier and instrumented for the question
 * THIS wave asks. Wave 69 is a positioning problem; 68 is a prayer problem. Three Jads on a
 * 9-tick cadence, each committing its style three ticks before the damage is rolled, each
 * spawning three healers at half health - so what decides a run is whether the overhead was
 * right when each fireball resolved, and whether the healers were tagged before they undid the
 * damage.
 *
 * So on top of the outcome it reports: how many Jad attacks resolved against the WRONG overhead,
 * how many ticks had two Jads landing DIFFERENT styles at once (unblockable by arithmetic - no
 * bot can pray two overheads), how long each healer lived untagged and how much health it gave
 * back, and where every point of damage came from.
 *
 * Not run by `npm run test:harness` - jest.harness.config.js ignores this file, exactly as it
 * ignores the Zuk harness, so the baseline command keeps costing what it always cost. Run it
 * with `npm run test:wave68` (one seed) or `npm run test:wave68-sweep` (many, in parallel).
 *
 * THE DEFAULT LOADOUT HERE IS `pure_rcb`, not the max gear the other harnesses default to. A
 * pure is the loadout this wave is hardest for and the one it was asked about: 52 prayer, no
 * defence, a rune crossbow's reach of 7 rather than a twisted bow's 10. Pass INFERNO_LOADOUT
 * for anything else.
 *
 * Configuration (environment variables):
 *   INFERNO_SEED     integer seed, default 1
 *   INFERNO_LOADOUT  loadout key from the sidebar select, default pure_rcb
 *   INFERNO_PRAYER   the prayer pool for the run, default 99999 - see DEFAULT_PRAYER. Set it to
 *                    52 for a pure's real pool, when prayer is the thing being measured
 *   INFERNO_RUN      the run-energy pool, default 10000 (pinned full) - deep enough that the bot
 *                    never falls back to walking speed. Set it to 0 for the real drain
 *   W68_WAVE         wave to run, 68 (default) or 67 - the single Jad, same instrumentation
 *   W68_TICK_LIMIT   tick budget for the run, default 1500 (~15 minutes in game)
 *   W68_JSON_OUT     write the machine-readable summary to this file as well as stdout
 *   W68_TRACE        "from-to" tick window to write a per-tick account of, e.g. 200-260
 *   W68_TRACE_OUT    where that trace lands, default test/harness/wave68-results/seed-N.trace.log
 *   INFERNO_TIMEOUT_MS  jest timeout (read by the jest config), default 30 min
 */

import * as fs from "fs";
import * as path from "path";

import { EntityNames, ItemName } from "osrs-sdk";

import { committedStyle, isJad, ticksUntilJadLands } from "../../src/content/inferno/js/JadTracker";
import { prayerForAttackStyle } from "../../src/content/inferno/js/OverheadPlanner";
import { JAD_LAND_DELAY } from "../../src/content/inferno/js/ShieldAttackerClock";
import { InfernoAutomation } from "../../src/content/inferno/js/InfernoAutomation";
import { seedEverything } from "../../src/content/inferno/js/SeededRandom";
import { bootHarness, out, restoreConsole, silenceConsole } from "./bootHarness";

/**
 * The prayer pool a wave-68 run gets unless asked for otherwise.
 *
 * Deep enough that "ran out of prayer" cannot happen. On this wave the drain is real and a pure
 * only has 52 to spend, but it is a SUPPLY question - did the bot sip its restores - and it ends
 * the run before the flicking question this harness exists to measure has finished being asked.
 * The drain still happens exactly as it always did; only the pool is bigger, so a run that would
 * have died of it reports the death it goes on to have instead.
 *
 * Set INFERNO_PRAYER=52 for a pure's real pool when the question IS prayer.
 */
const DEFAULT_PRAYER = 99999;

/**
 * Run energy the player is held at, every tick. 10000 is full; 0 disables the aid entirely.
 *
 * TOPPED UP RATHER THAN DEEPENED - `Player.movementStep` re-clamps to 10000 on every movement
 * step, so a larger starting value is gone within a tick. Same reasoning as the Zuk harness: the
 * tile scorer prices every walk at PLAYER_TILES_PER_TICK = 2, which is only true while running,
 * so a drained run makes every arrival estimate twice as optimistic as reality and that failure
 * drowns out whatever the run was actually measuring.
 */
const DEFAULT_RUN = 10000;

const SEED = parseInt(process.env.INFERNO_SEED || "1", 10);
const LOADOUT = process.env.INFERNO_LOADOUT || "pure_rcb";
const WAVE = parseInt(process.env.W68_WAVE || "68", 10);
const PRAYER_OVERRIDE = parseInt(process.env.INFERNO_PRAYER || String(DEFAULT_PRAYER), 10);
const RUN_OVERRIDE = parseInt(process.env.INFERNO_RUN || String(DEFAULT_RUN), 10);
const TICK_LIMIT = parseInt(process.env.W68_TICK_LIMIT || "1500", 10);
const JSON_OUT = process.env.W68_JSON_OUT || "";

/**
 * W68_TRACE=200-260 - a tick by tick account of a window of the real run.
 *
 * The browser cannot show this fight: its RNG stream, its input timing and its renderer all
 * differ from the harness, and a seed that matches on the first tick has drifted by the
 * hundredth. This is the same information without the parity problem, because it IS the run
 * being reported. One line per tick: where the player stands, what the overhead is, what each
 * Jad has committed to and when it lands, how many healers are still untagged, and the decision
 * the automation made that tick.
 */
const TRACE = (() => {
  const raw = process.env.W68_TRACE ?? "";
  const match = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  return match ? { from: parseInt(match[1], 10), to: parseInt(match[2], 10) } : null;
})();
const TRACE_OUT =
  process.env.W68_TRACE_OUT ||
  path.resolve("test/harness/wave68-results", `seed-${SEED}.trace.log`);

// Must match the sidebar's <select id="loadouts"> options - an unknown value would set the
// select to "" and InfernoLoadout.getLoadout() would return nothing.
const VALID_LOADOUTS = [
  "max_tbow_speed",
  "max_rcb_speed",
  "max_tbow",
  "max_fbow",
  "budget_fbow",
  "rcb",
  "zerker",
  "pure",
  "pure_rcb",
  "max_melee",
];

/**
 * How far a run got, as an ordered list so "furthest reached" is an index comparison.
 *
 * Read off the live Jad count rather than off hitpoints, because that is the only thing on this
 * wave that monotonically progresses - a Jad's health goes back UP when its healers are working,
 * which is the whole reason the healers matter. A wave-67 run simply starts at "1-jad".
 */
const PHASES = ["3-jads", "2-jads", "1-jad", "cleared"] as const;
type Phase = (typeof PHASES)[number];

/** Supplies worth counting - what the bot burns, and what running out of would end a run. */
const SUPPLY_ITEMS: Record<string, string> = {
  brews: ItemName.SARADOMIN_BREW,
  restores: ItemName.SUPER_RESTORE,
  bastions: ItemName.BASTION_POTION,
};

interface Landed {
  from: string;
  damage: number;
  style: string;
}

/** One Jad's whole life, from spawn to corpse. */
interface JadRecord {
  id: string;
  spawnTick: number;
  maxHp: number;
  lastHp: number;
  lowestHp: number;
  /** Hitpoints its healers gave back - the tag-and-turn's scoreboard. */
  healedBack: number;
  /** Hitpoints we put into it. */
  damageDealt: number;
  killedTick: number | null;
  fires: number;
  firesAtPlayer: number;
  unprayed: number;
  healersSpawned: number;
}

/** One healer's life. `taggedTick` null at the end means it healed unopposed all run. */
interface HealerRecord {
  jad: string;
  spawnTick: number;
  taggedTick: number | null;
  killedTick: number | null;
  /** Hitpoints it restored to its Jad before anything stopped it. */
  healedBeforeTag: number;
  healedTotal: number;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

test("seeded wave 68 (triple Jad) through the real InfernoAutomation.onTick", () => {
  expect(VALID_LOADOUTS).toContain(LOADOUT);
  expect(Number.isFinite(SEED)).toBe(true);
  expect([67, 68]).toContain(WAVE);

  silenceConsole();

  const { region, world, player } = bootHarness({
    seed: SEED,
    wave: WAVE,
    loadout: LOADOUT,
    prayerOverride: PRAYER_OVERRIDE,
    runOverride: RUN_OVERRIDE,
  });

  const anyRegion = region as unknown as {
    wave: number;
    mobs: any[];
    newMobs: any[];
    players: unknown[];
    ticksUntilNextWave: number;
  };
  const anyPlayer = player as unknown as {
    location: { x: number; y: number };
    inventory: ({ itemName?: string } | null)[];
    incomingProjectiles: any[];
    currentStats: { hitpoint: number; prayer: number; run?: number };
    stats: { hitpoint: number; prayer: number };
    prayerController?: { overhead(): { name?: string } | null };
    isDying(): boolean;
    running?: boolean;
  };

  // ---- Readers over public state. Nothing here decides anything; it only watches. ----
  const allMobs = () => anyRegion.mobs.concat(anyRegion.newMobs);
  const liveMobs = () => allMobs().filter((mob) => mob.dying === -1);
  const liveJads = () => liveMobs().filter((mob) => isJad(mob));
  const liveHealers = () => liveMobs().filter((mob) => mob.mobName() === EntityNames.YT_HUR_KOT);
  const hp = () => anyPlayer.currentStats.hitpoint;
  const prayer = () => anyPlayer.currentStats.prayer;
  const overhead = () => {
    try {
      return anyPlayer.prayerController?.overhead()?.name ?? "none";
    } catch (e) {
      return "?";
    }
  };
  const distanceTo = (mob: { location: { x: number; y: number } }) =>
    Math.max(
      Math.abs(mob.location.x - anyPlayer.location.x),
      Math.abs(mob.location.y - anyPlayer.location.y),
    );

  /**
   * Supplies counted in DOSES, not vials - a brew is one inventory item holding four sips, so
   * counting items only moves on every fourth drink, and "did the bot drink at all" is the whole
   * question when a run dies at 40 hitpoints with a full inventory.
   */
  const countDoses = (itemName: string) =>
    anyPlayer.inventory.reduce((total, item) => {
      if (!item || item.itemName !== itemName) {
        return total;
      }
      return total + ((item as { doses?: number }).doses ?? 1);
    }, 0);
  const supplies = () => {
    const counts: Record<string, number> = {};
    for (const key of Object.keys(SUPPLY_ITEMS)) {
      counts[key] = countDoses(SUPPLY_ITEMS[key]);
    }
    return counts;
  };

  const phaseNow = (): Phase => {
    const alive = liveJads().length;
    if (alive === 0) {
      return "cleared";
    }
    return alive >= 3 ? "3-jads" : alive === 2 ? "2-jads" : "1-jad";
  };

  /** Who fired a projectile: a mob by name, or the player at themselves (ruby bolts). */
  const sourceOf = (projectile: { from?: unknown }): string => {
    const from = projectile.from as { mobName?: () => string } | undefined;
    if (!from) {
      return "unknown";
    }
    if ((from as unknown) === (player as unknown)) {
      return "self (ruby bolt)";
    }
    return from.mobName?.() ?? "unknown";
  };

  // ---- Run state. ----
  const startingSupplies = supplies();
  const events: { tick: number; text: string }[] = [];
  const damageBySource = new Map<string, number>();
  const recentHits: { tick: number; phase: Phase; from: string; damage: number; hpAfter: number }[] =
    [];
  const seenMobs = new Set<unknown>();
  const spawnCounts: Record<string, number> = {};
  const traceLines: string[] = [];

  /** Per-Jad and per-healer ledgers, keyed by mob identity. */
  const jadRecords = new Map<unknown, JadRecord>();
  const healerRecords = new Map<unknown, HealerRecord>();
  /** Which Jad a healer belongs to - the healer stores the mob as `myJad`, we store its label. */
  const jadIdOf = (mob: unknown) => jadRecords.get(mob)?.id ?? "?";

  /**
   * WHAT MUST BE PRAYED, AND WHEN.
   *
   * Filed on the tick the demand RESOLVES, which for a Jad is JAD_LAND_DELAY ticks after the
   * animation starts - `JadMagicWeapon`/`JadRangeWeapon` defer the real `super.attack()`, so the
   * overhead is checked three ticks after the style is committed. Judging at the fire would grade
   * the bot three ticks early and call correct flicks wrong.
   */
  const demandsByTick = new Map<number, { jad: string; style: string; prayer: string | null }[]>();
  const lastDelayByMob = new Map<unknown, number>();

  /**
   * THE TWO WAYS THIS WAVE KILLS YOU, COUNTED SEPARATELY.
   *
   * `unprayedFires` is a bot failure: one Jad's fireball resolved and the wrong overhead was up.
   * `crossStyleCollisions` is not - two Jads resolving DIFFERENT styles on the same tick cannot
   * both be prayed, by arithmetic, so one of them was always going to land. Rolling them into one
   * number would make an unavoidable hit look like a mistake and hide the mistakes among them.
   */
  let unprayedFires = 0;
  let crossStyleCollisions = 0;
  let sameStyleCollisions = 0;
  let maxSimultaneousDemands = 0;
  const collisionTicks: { tick: number; jads: string[]; styles: string[] }[] = [];

  let damageTaken = 0;
  let healed = 0;
  let unattributedTotal = 0;
  const unattributed: {
    tick: number;
    phase: Phase;
    damage: number;
    hpAfter: number;
    overhead: string;
  }[] = [];
  let lowestHp = anyPlayer.stats.hitpoint;
  let tick = 0;
  let outcome = "";
  let cause = "";
  let killers: Landed[] = [];
  let botLogAtStop = "";
  let jadsEverSeen = false;
  let clearedTick: number | null = null;
  let phase: Phase = "3-jads";
  let maxPhase: Phase = PHASES[0];
  const phaseFirstTick: Record<string, number> = {};

  // Projectiles already counted, by identity - see the attribution block.
  const tracked = new WeakSet<object>();
  const trackedHeals = new WeakSet<object>();
  /**
   * Last tick's hits, kept because a death is noticed a tick after the blow that caused it.
   *
   * `Player.attackStep` runs `detectDeath()` BEFORE `processIncomingAttacks()`, so the fatal
   * damage is applied after that tick's death check has already passed and `dying` is not set
   * until the following tick. Blaming the death on the hits resolving on the tick it is NOTICED
   * therefore finds nothing - the killer landed one tick earlier.
   */
  let previousLanded: Landed[] = [];
  const startedAt = Date.now();

  const note = (text: string) => events.push({ tick, text });

  out("");
  out(
    `wave 68 harness | seed ${SEED} | loadout ${LOADOUT} | wave ${WAVE} | ` +
      `tick limit ${TICK_LIMIT} | prayer pool ${PRAYER_OVERRIDE}` +
      (PRAYER_OVERRIDE === DEFAULT_PRAYER ? " (default - drain cannot end a run)" : "") +
      ` | run ${RUN_OVERRIDE > 0 ? `pinned ${Math.min(RUN_OVERRIDE, 10000)}` : "real drain"}` +
      (RUN_OVERRIDE === DEFAULT_RUN ? " (default - never walks)" : ""),
  );

  // Legacy fake timers on purpose: they fake setTimeout/setInterval (all the engine uses) without
  // freezing Date, so the wall-time figure below stays honest. Inventory clicks route through
  // InputController's setTimeout(inputDelay), so without this every gear switch silently no-ops.
  jest.useFakeTimers("legacy");
  // Matches the browser's re-seed on the line before its first tick, so a run watched at
  // /?seed=N is the run this reports. See src/index.ts.
  seedEverything(SEED);

  InfernoAutomation.setEnabled(true);

  try {
    while (tick < TICK_LIMIT) {
      tick++;
      // Exactly what World.browserLoop does around tickWorld - the countdown is decremented by
      // the render loop in the browser, so the pump has to own it here.
      if (world.getReadyTimer > 0) {
        world.getReadyTimer--;
      }

      // Held at the top of the tick so the movement step this tick runs on full energy. Both
      // fields, because the engine latches `running` to false the moment energy touches zero and
      // never turns it back on by itself - refilling the number alone would leave it walking.
      if (RUN_OVERRIDE > 0) {
        (anyPlayer.currentStats as { run?: number }).run = Math.min(RUN_OVERRIDE, 10000);
        anyPlayer.running = true;
      }

      const hpBefore = hp();

      try {
        world.tickWorld();
      } catch (e) {
        outcome = "crashed";
        cause =
          `engine threw on tick ${tick}: ${(e as Error)?.message ?? e}\n` +
          ((e as Error)?.stack?.split("\n").slice(1, 5).join("\n") ?? "");
        break;
      }
      // The 600ms between ticks, during which queued input (gear switches, walk clicks) matures.
      jest.advanceTimersByTime(600);

      phase = phaseNow();
      if (PHASES.indexOf(phase) > PHASES.indexOf(maxPhase)) {
        maxPhase = phase;
      }
      if (phaseFirstTick[phase] === undefined) {
        phaseFirstTick[phase] = tick;
      }

      // ---- Spawn watch: every mob is counted once, by identity. ----
      for (const mob of allMobs()) {
        if (seenMobs.has(mob)) {
          continue;
        }
        seenMobs.add(mob);
        const name = mob.mobName();
        spawnCounts[name] = (spawnCounts[name] ?? 0) + 1;
        if (isJad(mob)) {
          jadsEverSeen = true;
          const id = `jad${jadRecords.size + 1}`;
          jadRecords.set(mob, {
            id,
            spawnTick: tick,
            maxHp: mob.stats?.hitpoint ?? 350,
            lastHp: mob.currentStats?.hitpoint ?? 350,
            lowestHp: mob.currentStats?.hitpoint ?? 350,
            healedBack: 0,
            damageDealt: 0,
            killedTick: null,
            fires: 0,
            firesAtPlayer: 0,
            unprayed: 0,
            healersSpawned: 0,
          });
          note(`${id} spawned @${mob.location.x},${mob.location.y} (stun ${mob.stunned ?? "-"})`);
        } else if (name === EntityNames.YT_HUR_KOT) {
          // The healer knows its Jad - it stored the mob as `myJad` in its constructor - so the
          // ledger is keyed to the Jad the healing actually goes to rather than guessed at from
          // position.
          const owner = (mob as { myJad?: unknown }).myJad;
          healerRecords.set(mob, {
            jad: jadIdOf(owner),
            spawnTick: tick,
            taggedTick: null,
            killedTick: null,
            healedBeforeTag: 0,
            healedTotal: 0,
          });
          const ownerRecord = jadRecords.get(owner);
          if (ownerRecord) {
            ownerRecord.healersSpawned++;
          }
        }
      }

      // ---- Healer tagging: "still healing" is precisely `aggro !== player`, which is the same
      // test `chooseJadWaveTarget` uses to pick one. Recorded on the tick it flips, so the
      // latency between a healer spawning and being pulled is measurable rather than inferred.
      healerRecords.forEach((record, mob) => {
        const healer = mob as { aggro?: unknown; dying: number };
        if (record.taggedTick === null && healer.aggro === (player as unknown)) {
          record.taggedTick = tick;
        }
        if (record.killedTick === null && healer.dying !== -1) {
          record.killedTick = tick;
          if (record.taggedTick === null) {
            note(`${record.jad}: healer died UNTAGGED after ${tick - record.spawnTick} ticks`);
          }
        }
      });

      // ---- Per-Jad health: what we put in, and what the healers put back.
      //
      // Read off the Jad's own INCOMING projectiles rather than diffed off its hitpoints, because
      // the two directions have to be separable: a Jad sitting at the same health for thirty
      // ticks is either untouched or being healed exactly as fast as it is being shot, and those
      // are opposite findings. `HealWeapon.attack` sets a NEGATIVE damage, so the sign of the
      // resolved projectile is the whole classification.
      for (const mob of allMobs()) {
        const record = jadRecords.get(mob);
        if (!record) {
          continue;
        }
        for (const projectile of (mob as { incomingProjectiles?: any[] }).incomingProjectiles ??
          []) {
          if (trackedHeals.has(projectile)) {
            continue;
          }
          const shot = projectile as { damage?: number; remainingDelay?: number; from?: unknown };
          if ((shot.remainingDelay ?? 1) > 0) {
            continue; // still in flight
          }
          trackedHeals.add(projectile);
          const amount = shot.damage ?? 0;
          if (amount < 0) {
            record.healedBack += -amount;
            const healer = healerRecords.get(shot.from);
            if (healer) {
              healer.healedTotal += -amount;
              if (healer.taggedTick === null) {
                healer.healedBeforeTag += -amount;
              }
            }
          } else if ((shot.from as unknown) === (player as unknown)) {
            record.damageDealt += amount;
          }
        }
        const now = (mob as { currentStats?: { hitpoint: number } }).currentStats?.hitpoint ?? 0;
        record.lastHp = now;
        record.lowestHp = Math.min(record.lowestHp, now);
        if (record.killedTick === null && (mob as { dying: number }).dying !== -1) {
          record.killedTick = tick;
          note(
            `${record.id} DEAD on tick ${tick} (${tick - record.spawnTick} ticks alive, ` +
              `healed back ${record.healedBack})`,
          );
        }
      }

      // ---- Damage attribution, BY RESOLUTION rather than by removal.
      //
      // `Unit.processIncomingAttacks` filters `shouldDestroy()` at the START of the tick and
      // applies damage further down, so a shot resolves on tick N and is still in the list at
      // postTick N - it only disappears on N+1. Diffing the set across ticks therefore blames
      // every hit a tick late. `remainingDelay <= 0` is exactly the test the engine itself uses
      // to decide the shot has arrived, and each projectile is counted once by identity.
      //
      // It also picks up Jad, which a diff could never see: the deferred `super.attack()` builds
      // a projectile with `reduceDelay: JAD_PROJECTILE_DELAY`, flooring `remainingDelay` at 1 so
      // it is created and resolved inside a single tick - born and dead between two snapshots.
      const landed: Landed[] = [];
      for (const projectile of anyPlayer.incomingProjectiles) {
        if (tracked.has(projectile)) {
          continue;
        }
        const shot = projectile as {
          damage?: number;
          attackStyle?: string;
          remainingDelay?: number;
        };
        if ((shot.remainingDelay ?? 1) > 0) {
          continue; // still in flight
        }
        tracked.add(projectile);
        if ((shot.damage ?? 0) > 0) {
          landed.push({
            from: sourceOf(projectile as { from?: unknown }),
            damage: shot.damage ?? 0,
            style: shot.attackStyle ?? "?",
          });
        }
      }

      for (const hit of landed) {
        damageTaken += hit.damage;
        damageBySource.set(hit.from, (damageBySource.get(hit.from) ?? 0) + hit.damage);
        recentHits.push({ tick, phase, from: hit.from, damage: hit.damage, hpAfter: hp() });
        if (recentHits.length > 40) {
          recentHits.shift();
        }
        if (hit.damage >= 30) {
          note(
            `took ${hit.damage} from ${hit.from} (${hit.style}, hp ${hp()}, overhead ${overhead()})`,
          );
        }
      }
      const delta = hp() - hpBefore;
      const landedTotal = landed.reduce((sum, hit) => sum + hit.damage, 0);
      if (delta + landedTotal > 0) {
        healed += delta + landedTotal;
      } else if (delta + landedTotal < 0) {
        // Damage with no resolved projectile behind it at all. With attribution happening on the
        // tick the shot resolves this should stay empty - anything landing here is a genuine hole
        // rather than the one-tick lag a diff-based version used to report.
        const damage = -(delta + landedTotal);
        unattributedTotal += damage;
        unattributed.push({ tick, phase, damage, hpAfter: hp(), overhead: overhead() });
        note(`UNATTRIBUTED ${damage} (hp ${hp()}, overhead ${overhead()})`);
      }
      lowestHp = Math.min(lowestHp, hp());

      // ---- THE PRAYER LEDGER. Every Jad attack, filed on the tick its damage resolves, then
      // graded against the overhead that was actually up while it resolved. ----
      {
        // 1. Detect this tick's fires: attackDelay jumping UP to the full attackSpeed. The other
        // upward writer is not an attack and does not match - the flinch parks the delay at
        // flinchDelay + 1 (3), while a wave-68 Jad's attackSpeed is 9.
        for (const mob of liveJads()) {
          const delay = mob.attackDelay ?? 0;
          const previous = lastDelayByMob.get(mob);
          lastDelayByMob.set(mob, delay);
          if (previous === undefined || delay <= previous || delay !== (mob.attackSpeed ?? 9)) {
            continue;
          }
          const record = jadRecords.get(mob);
          const id = record?.id ?? "jad?";
          // The real style, captured by JadTracker at the animation commit THIS tick. Reading
          // `attackStyle` directly would be a coin flip - `Mob.attackIfPossible` re-rolls it
          // every tick and it only tells the truth on the tick the animation starts.
          const style = committedStyle(mob) ?? "unknown";
          if (record) {
            record.fires++;
          }
          if (mob.aggro !== player) {
            continue; // aimed at nothing we have to answer
          }
          if (record) {
            record.firesAtPlayer++;
          }
          const demandTick = tick + JAD_LAND_DELAY;
          const list = demandsByTick.get(demandTick) ?? [];
          list.push({ jad: id, style, prayer: prayerForAttackStyle(style) });
          demandsByTick.set(demandTick, list);
        }

        // 2. Judge THIS tick's demands against the overhead that was up while its attacks
        // resolved. Reading the controller HERE, after tickWorld, is deliberate: a toggle made in
        // postTick lives in `nextActiveState` until BasePrayer.tick() commits it during the NEXT
        // tick, so the isActive-based reading at this point is exactly the overhead this tick's
        // attackSteps saw - postTick's fresh clicks are not yet in it.
        const overheadThisTick = overhead();
        const due = demandsByTick.get(tick) ?? [];
        demandsByTick.delete(tick);
        maxSimultaneousDemands = Math.max(maxSimultaneousDemands, due.length);
        for (const demand of due) {
          if (demand.prayer !== null && demand.prayer !== overheadThisTick) {
            unprayedFires++;
            let record: JadRecord | undefined;
            jadRecords.forEach((candidate) => {
              if (candidate.id === demand.jad) {
                record = candidate;
              }
            });
            if (record) {
              record.unprayed++;
            }
            note(
              `UNPRAYED ${demand.jad}(${demand.style}) resolved this tick - ` +
                `overhead was ${overheadThisTick}`,
            );
          }
        }
        if (due.length >= 2) {
          const styles = due.map((demand) => demand.style);
          const distinct = styles.filter((value, index, all) => all.indexOf(value) === index);
          if (distinct.length > 1) {
            crossStyleCollisions++;
            collisionTicks.push({ tick, jads: due.map((demand) => demand.jad), styles });
            note(
              `CROSS-STYLE OVERLAP t${tick}: ${due
                .map((demand) => `${demand.jad}(${demand.style})`)
                .join(" + ")} - one of these is unblockable`,
            );
          } else {
            sameStyleCollisions++;
          }
        }
      }

      // ---- The trace window. ----
      if (TRACE && tick >= TRACE.from && tick <= TRACE.to) {
        const jadParts = liveJads().map((mob) => {
          const record = jadRecords.get(mob);
          const lands = ticksUntilJadLands(mob);
          return (
            `${record?.id ?? "jad?"} ${String(mob.currentStats?.hitpoint ?? 0).padStart(3)}hp ` +
            `d${String(distanceTo(mob)).padStart(2)} ` +
            `${(committedStyle(mob) ?? "-").padEnd(7)}${lands === null ? "" : `+${lands}`}`
          );
        });
        const healersUp = liveHealers();
        const untagged = healersUp.filter((mob) => mob.aggro !== player).length;
        traceLines.push(
          `t${String(tick).padStart(4)} @${anyPlayer.location.x},${anyPlayer.location.y} ` +
            `hp ${String(hp()).padStart(3)} pray ${String(prayer()).padStart(3)} ` +
            `[${overhead()}] | healers ${healersUp.length} (${untagged} untagged) | ` +
            `${jadParts.join(" | ")} | ${InfernoAutomation.getAttackState?.() ?? "-"}`,
        );
      }

      // ---- Endings. Death first: a dying player is removed from region.players by the engine.
      if (anyRegion.players.length === 0 || anyPlayer.isDying()) {
        outcome = "died";
        // The killing blow landed on the tick BEFORE the one that noticed it - see previousLanded.
        killers = landed.length ? landed : previousLanded;
        cause =
          `died on tick ${tick} in ${phase}` +
          (killers.length
            ? ` to ${killers.map((hit) => `${hit.from} ${hit.damage}`).join(" + ")}`
            : " (no projectile resolved on the fatal tick)");
        break;
      }

      if (prayer() <= 0) {
        outcome = "ran out of prayer";
        cause = `prayer hit 0 on tick ${tick} in ${phase} (hp ${hp()})`;
        break;
      }

      // The last Jad and its healers are down. Recorded here but NOT ended on: a Jad killed
      // mid-animation still lands its deferred fireball - the ghost hit - so a run that stops on
      // the kill tick reports a survival the player would not have had. The wave transition below
      // is the real ending, and everything between is the ghost window.
      if (jadsEverSeen && clearedTick === null && liveMobs().length === 0) {
        clearedTick = tick;
        note(`board clear on tick ${tick} - waiting out the ghost window`);
      }

      // Wave progression increments region.wave when the next wave spawns; the increment IS the
      // durable "previous wave cleared" signal (the 9-tick countdown can be cancelled, so the
      // timer alone is not).
      if (anyRegion.wave !== WAVE) {
        outcome = "completed";
        cause = `wave ${WAVE} cleared on tick ${clearedTick ?? tick} (hp ${hp()}, prayer ${prayer()})`;
        break;
      }

      previousLanded = landed;
    }
  } finally {
    restoreConsole();
    // Read before disabling - setEnabled(false) clears the automation's rolling log.
    botLogAtStop = InfernoAutomation.getLog();
    InfernoAutomation.setEnabled(false);
    jest.useRealTimers();
  }

  if (!outcome) {
    outcome = "stuck";
    cause =
      `hit the tick budget (${TICK_LIMIT}) in ${phase} ` +
      `(${liveJads().length} jads, ${liveHealers().length} healers alive, hp ${hp()})`;
  }

  const endingSupplies = supplies();
  /**
   * This wave's own mobs, for the counts the summary reports.
   *
   * A completed run ends on the tick the SUCCESSOR wave spawns - that increment is the durable
   * "cleared" signal - so by the time the summary is built, Zuk and its shield are standing on
   * the board. Left unfiltered, every clean run reports two mobs alive at the end and a spawn
   * count including TzKal-Zuk, which reads as a wave-68 finding and is nothing of the kind.
   */
  const WAVE_MOBS: string[] = [EntityNames.JAL_TOK_JAD, EntityNames.YT_HUR_KOT];
  const jads: JadRecord[] = [];
  jadRecords.forEach((record) => jads.push(record));
  const healers: HealerRecord[] = [];
  healerRecords.forEach((record) => healers.push(record));

  // ---- The report. ----
  out("");
  out("each jad, spawn to corpse:");
  // `at us` is printed beside `fires` and not folded into it, because it is what makes the
  // unprayed column mean anything: a Jad whose aggro has been pulled onto a healer still plays
  // its animation and still counts a fire, but nothing about that attack was ours to pray. Zero
  // unprayed against zero demands is not a clean run, it is an empty measurement, and the two
  // are indistinguishable without this column.
  out(
    "  jad  | spawn | killed | ticks | hp left | we dealt | healed back | fires | at us | unprayed | healers",
  );
  for (const record of jads) {
    out(
      `  ${record.id.padEnd(4)} | ${String(record.spawnTick).padStart(5)} | ` +
        `${String(record.killedTick ?? "-").padStart(6)} | ` +
        `${String((record.killedTick ?? tick) - record.spawnTick).padStart(5)} | ` +
        `${String(record.lastHp).padStart(7)} | ${String(record.damageDealt).padStart(8)} | ` +
        `${String(record.healedBack).padStart(11)} | ${String(record.fires).padStart(5)} | ` +
        `${String(record.firesAtPlayer).padStart(5)} | ` +
        `${String(record.unprayed).padStart(8)} | ${String(record.healersSpawned).padStart(7)}`,
    );
  }

  out("");
  const untaggedEver = healers.filter((record) => record.taggedTick === null);
  const tagLatencies = healers
    .filter((record) => record.taggedTick !== null)
    .map((record) => (record.taggedTick as number) - record.spawnTick);
  out(
    `healers: ${healers.length} spawned | ${healers.length - untaggedEver.length} tagged | ` +
      `${untaggedEver.length} never tagged | ` +
      `${healers.reduce((sum, record) => sum + record.healedTotal, 0)} hp given back ` +
      `(${healers.reduce((sum, record) => sum + record.healedBeforeTag, 0)} of it before the tag)`,
  );
  if (tagLatencies.length > 0) {
    const sorted = [...tagLatencies].sort((a, b) => a - b);
    out(
      `  ticks from spawn to tag: min ${sorted[0]} | median ${sorted[Math.floor(sorted.length / 2)]} | ` +
        `max ${sorted[sorted.length - 1]}`,
    );
  }
  for (const record of healers) {
    out(
      `  ${record.jad} healer  spawned t${String(record.spawnTick).padStart(4)} | ` +
        `${
          record.taggedTick === null
            ? "NEVER TAGGED"
            : `tagged t${record.taggedTick} (+${record.taggedTick - record.spawnTick})`
        } | ` +
        `${record.killedTick === null ? "still alive" : `died t${record.killedTick}`} | ` +
        `healed ${record.healedTotal} (${record.healedBeforeTag} untagged)`,
    );
  }

  out("");
  out("damage taken by source:");
  // forEach, NOT spread or for...of: with target es5 and no downlevelIteration, TypeScript
  // compiles Map iteration into an index-based loop that iterates zero times - silently.
  const bySource: [string, number][] = [];
  damageBySource.forEach((total, source) => bySource.push([source, total]));
  bySource.sort((a, b) => b[1] - a[1]);
  if (bySource.length === 0) {
    out("  (none)");
  }
  for (const [source, total] of bySource) {
    const share = damageTaken > 0 ? Math.round((total / damageTaken) * 100) : 0;
    out(`  ${source.padEnd(14)} ${String(total).padStart(5)}  ${String(share).padStart(3)}%`);
  }
  out(`  ${"TOTAL".padEnd(14)} ${String(damageTaken).padStart(5)}   (healed back ${healed})`);

  if (collisionTicks.length > 0) {
    out("");
    out(
      "cross-style overlaps - two jads, two prayers, one overhead (these cost hp by arithmetic):",
    );
    for (const collision of collisionTicks.slice(0, 20)) {
      out(
        `  t${String(collision.tick).padStart(4)}  ${collision.jads.join(" + ")}  ` +
          `(${collision.styles.join(" vs ")})`,
      );
    }
    if (collisionTicks.length > 20) {
      out(`  ... and ${collisionTicks.length - 20} more`);
    }
  }

  if (events.length > 0) {
    out("");
    out(`events (last 40 of ${events.length}):`);
    for (const event of events.slice(-40)) {
      out(`  t${String(event.tick).padStart(4)}  ${event.text}`);
    }
  }

  if (outcome !== "completed") {
    out("");
    out(`last hits before the end (tick ${tick}, ${phase}):`);
    for (const hit of recentHits.slice(-8)) {
      out(
        `  t${String(hit.tick).padStart(4)}  ${hit.from.padEnd(14)} ${String(hit.damage).padStart(3)} ` +
          `-> hp ${hit.hpAfter}  [${hit.phase}]`,
      );
    }
    out("");
    out("arena when the run ended:");
    out(
      `  player     @${anyPlayer.location.x},${anyPlayer.location.y} | hp ${hp()}/${anyPlayer.stats.hitpoint} | ` +
        `prayer ${prayer()}/${anyPlayer.stats.prayer} | overhead ${overhead()}`,
    );
    for (const mob of liveMobs()) {
      out(
        `  ${mob.mobName().padEnd(14)} @${mob.location.x},${mob.location.y} | ` +
          `hp ${mob.currentStats?.hitpoint ?? "?"} | d${distanceTo(mob)}` +
          `${mob.aggro === player ? " | aggro=player" : ""}`,
      );
    }
    const botLog = botLogAtStop.split("\n").slice(-25);
    if (botLog.length > 0 && botLog[0] !== "") {
      out("last automation ticks:");
      for (const line of botLog) {
        out(`  ${line}`);
      }
    }
  }

  const summary = {
    seed: SEED,
    loadout: LOADOUT,
    wave: WAVE,
    outcome,
    cause: cause.split("\n")[0],
    phase: maxPhase,
    ticks: tick,
    clearedTick,
    killers: killers.map((hit) => hit.from),
    killedBy: killers.length ? killers[0].from : null,
    hp: hp(),
    maxHp: anyPlayer.stats.hitpoint,
    lowestHp,
    prayer: prayer(),
    prayerPool: PRAYER_OVERRIDE,
    runPool: RUN_OVERRIDE,
    overhead: overhead(),
    jadsSpawned: jads.length,
    jadsKilled: jads.filter((record) => record.killedTick !== null).length,
    jadsAlive: liveJads().length,
    jadHpLeft: liveJads().map((mob) => mob.currentStats?.hitpoint ?? 0),
    jadHealedBack: jads.reduce((sum, record) => sum + record.healedBack, 0),
    jadKillTicks: jads.map((record) => ({
      id: record.id,
      spawn: record.spawnTick,
      killed: record.killedTick,
      ticks: (record.killedTick ?? tick) - record.spawnTick,
      hpLeft: record.lastHp,
      healedBack: record.healedBack,
      fires: record.fires,
      firesAtPlayer: record.firesAtPlayer,
      unprayed: record.unprayed,
    })),
    /** Total Jad attacks that demanded an overhead - the denominator `unprayedFires` is out of. */
    jadFiresAtPlayer: jads.reduce((sum, record) => sum + record.firesAtPlayer, 0),
    healersSpawned: healers.length,
    healersTagged: healers.length - untaggedEver.length,
    healersNeverTagged: untaggedEver.length,
    healingGivenBack: healers.reduce((sum, record) => sum + record.healedTotal, 0),
    healingBeforeTag: healers.reduce((sum, record) => sum + record.healedBeforeTag, 0),
    tagLatency: tagLatencies.length
      ? {
          min: Math.min.apply(null, tagLatencies),
          max: Math.max.apply(null, tagLatencies),
          mean: Math.round(
            tagLatencies.reduce((sum, value) => sum + value, 0) / tagLatencies.length,
          ),
        }
      : null,
    // The prayer verdict. `unprayedFires` is the bot's fault; `crossStyleCollisions` is not -
    // see the note where they are counted.
    unprayedFires,
    crossStyleCollisions,
    sameStyleCollisions,
    maxSimultaneousDemands,
    collisionTicks,
    damageTaken,
    healed,
    unattributedDamage: unattributedTotal,
    unattributedHits: unattributed.length,
    unattributed,
    damageBySource: bySource.reduce(
      (map, [source, total]) => {
        map[source] = total;
        return map;
      },
      {} as Record<string, number>,
    ),
    forcedAttacks: InfernoAutomation.getForcedAttackCount?.() ?? 0,
    suppliesStart: startingSupplies,
    suppliesLeft: endingSupplies,
    spawnCounts: Object.keys(spawnCounts)
      .filter((name) => WAVE_MOBS.indexOf(name) !== -1)
      .reduce(
        (map, name) => {
          map[name] = spawnCounts[name];
          return map;
        },
        {} as Record<string, number>,
      ),
    phaseFirstTick,
    aliveAtEnd: liveMobs()
      .map((mob) => mob.mobName())
      .filter((name: string) => WAVE_MOBS.indexOf(name) !== -1),
    wallMs: Date.now() - startedAt,
  };

  out("----------------------------------------------------------------");
  out(`RESULT: ${outcome} - ${cause}`);
  out(
    `furthest ${maxPhase} | ${summary.jadsKilled}/${summary.jadsSpawned} jads killed` +
      (summary.jadsAlive > 0 ? ` | left standing: ${summary.jadHpLeft.join(", ")} hp` : "") +
      ` | jads healed back ${summary.jadHealedBack}`,
  );
  out(
    `healers ${summary.healersSpawned} spawned, ${summary.healersTagged} tagged, ` +
      `${summary.healersNeverTagged} never | gave back ${summary.healingGivenBack} hp ` +
      `(${summary.healingBeforeTag} untagged)`,
  );
  out(
    `prayer: ${unprayedFires} UNPRAYED of ${summary.jadFiresAtPlayer} jad hits aimed at us ` +
      `(bot's fault) | ${crossStyleCollisions} cross-style overlap tick${crossStyleCollisions === 1 ? "" : "s"} ` +
      `(unblockable) | ${sameStyleCollisions} same-style (free) | ` +
      `peak ${maxSimultaneousDemands} landing at once`,
  );
  out(
    `player hp ${hp()}/${anyPlayer.stats.hitpoint} (lowest ${lowestHp}) | took ${damageTaken}, healed ${healed} | ` +
      `brew doses ${endingSupplies.brews}/${startingSupplies.brews}, ` +
      `restore doses ${endingSupplies.restores}/${startingSupplies.restores}`,
  );
  out(
    `${tick} ticks (~${formatDuration(tick * 600)} in-game) | wall time ${formatDuration(summary.wallMs)} | seed ${SEED}`,
  );
  // Machine-readable, one line, for wave68Sweep.js. Kept last so a truncated log still ends with it.
  out(`W68_JSON ${JSON.stringify(summary)}`);
  out("");

  if (TRACE) {
    fs.mkdirSync(path.dirname(TRACE_OUT), { recursive: true });
    fs.writeFileSync(TRACE_OUT, traceLines.join("\n") + "\n");
    out(`trace written: ${TRACE_OUT} (${traceLines.length} lines)`);
  }

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(summary, null, 2) + "\n");
  }

  // A decisive outcome is a successful harness run - a death is a finding, not a test failure.
  // An engine crash fails loudly (after the report above has printed), because it means the sim
  // broke, not the bot.
  expect(outcome).not.toBe("crashed");
  expect(["completed", "died", "ran out of prayer", "stuck"]).toContain(outcome);
});
