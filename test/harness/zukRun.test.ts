"use strict";

/**
 * One seeded Zuk fight through the REAL bot, reported so the ending explains itself.
 *
 * Same machinery as `waveRun.test.ts` - the game boots for real, `InfernoAutomation.onTick`
 * makes every decision - but pointed at wave 69 and instrumented for the one question a Zuk
 * sweep asks: HOW did this seed end, and WHY. So on top of the outcome it reports the phase the
 * fight had reached, what landed the killing blow, where the damage came from over the whole
 * fight, how many sets spawned, and what supplies were left.
 *
 * Not run by `npm run test:harness` - jest.harness.config.js ignores this file so the existing
 * baseline command keeps costing what it always cost. Run it with `npm run test:zuk` (one seed)
 * or `npm run test:zuk-sweep` (many, in parallel).
 *
 * Configuration (environment variables):
 *   INFERNO_SEED     integer seed, default 1
 *   INFERNO_LOADOUT  loadout key from the sidebar select, default max_tbow_speed
 *   INFERNO_PRAYER   the prayer pool for the run, default 99999 - see DEFAULT_PRAYER. Set it to
 *                    99 for the loadout's real pool, when prayer is the thing being measured
 *   INFERNO_RUN      the run-energy pool, default 999999 - deep enough that the orb never drops
 *                    and the bot never falls back to walking speed. Set it to 10000 for the real
 *                    pool, when stamina is the thing being measured
 *   ZUK_WAVE         wave to start on, default 69. 67 or 68 arrive at Zuk having actually
 *                    spent supplies on the Jads, at a few times the wall cost
 *   ZUK_SHIELD       random (default) | west | east - which way the shield sets off
 *   ZUK_TICK_LIMIT   tick budget for the run, default 4000 (~40 minutes in game)
 *   ZUK_JSON_OUT     write the machine-readable summary to this file as well as stdout
 *   INFERNO_TIMEOUT_MS  jest timeout (read by the jest config), default 30 min
 */

import * as fs from "fs";
import * as path from "path";

import { EntityNames, ItemName, Player } from "osrs-sdk";

import { weaponForSet } from "../../src/content/inferno/js/GearSets";

import { committedStyle, isJad, ticksUntilJadLands } from "../../src/content/inferno/js/JadTracker";
import { prayerForAttackStyle } from "../../src/content/inferno/js/OverheadPlanner";
import { JAD_LAND_DELAY } from "../../src/content/inferno/js/ShieldAttackerClock";
import { InfernoAutomation } from "../../src/content/inferno/js/InfernoAutomation";
import { isCoveredByShield, projectShield, sortieDebug } from "../../src/content/inferno/js/TileScorer";
import { PlayerAttackClock } from "../../src/content/inferno/js/PlayerAttackClock";
import { ZukAttackClock } from "../../src/content/inferno/js/ZukAttackClock";
import type { ShieldDirection } from "../../src/content/inferno/js/ZukShield";
import { seedEverything } from "../../src/content/inferno/js/SeededRandom";
import { ZukSetTimer } from "../../src/content/inferno/js/ZukSetTimer";
import { bootHarness, out, restoreConsole, silenceConsole } from "./bootHarness";
import { buildReplayHtml } from "./replayHtml";

/**
 * The prayer pool a Zuk run gets unless asked for otherwise.
 *
 * Deep enough that "ran out of prayer" cannot happen, because on this wave it is not the answer
 * to anything: it ends the run several phases early and hides whatever the fight was actually
 * going to do, and the drain that caused it is a whole-inferno question rather than a Zuk one.
 * The drain still happens exactly as it always did - only the pool is bigger - so a run that
 * would have died of it now reports the death it goes on to have instead.
 *
 * Set INFERNO_PRAYER=99 for the real pool when the question IS prayer.
 */
const DEFAULT_PRAYER = 99999;

/**
 * Run energy the player is held at, every tick. 10000 is full; 0 disables the aid entirely.
 *
 * TOPPED UP RATHER THAN DEEPENED, because a deep pool is not possible - `Player.movementStep`
 * ends with `currentStats.run = Math.min(Math.max(run, 0), 10000)`, so it re-clamps to 10000 on
 * every single movement step and any larger starting value is gone within a tick.
 *
 * Not cosmetic: the tile scorer prices every walk at PLAYER_TILES_PER_TICK = 2, which is only
 * true while running. A drained run makes every arrival estimate twice as optimistic as reality,
 * so the bot misses deadlines it believed it could make - and that failure drowns out whatever
 * the run was actually measuring. Until that assumption is fixed, energy wants to be off the
 * table.
 *
 * Set INFERNO_RUN=0 for honest stamina, when the drain IS the question.
 */
const DEFAULT_RUN = 10000;

const SEED = parseInt(process.env.INFERNO_SEED || "1", 10);
const LOADOUT = process.env.INFERNO_LOADOUT || "max_tbow_speed";
const START_WAVE = parseInt(process.env.ZUK_WAVE || "69", 10);
const SHIELD = (process.env.ZUK_SHIELD || "random") as ShieldDirection;
const PRAYER_OVERRIDE = parseInt(process.env.INFERNO_PRAYER || String(DEFAULT_PRAYER), 10);
const RUN_OVERRIDE = parseInt(process.env.INFERNO_RUN || String(DEFAULT_RUN), 10);
const TICK_LIMIT = parseInt(process.env.ZUK_TICK_LIMIT || "4000", 10);
const JSON_OUT = process.env.ZUK_JSON_OUT || "";
/**
 * ZUK_TRACE=1600-1660 - a tick by tick account of a window of the real run.
 *
 * The browser cannot show this fight: its RNG stream, its input timing and its renderer all differ
 * from the harness, and a seed that matches on the first tick has drifted by the hundredth. This
 * is the same information without the parity problem, because it IS the run being reported.
 *
 * One line per tick: where the player stands, where the shield covers, where every set mob is and
 * how far away, whether it is tagged, and the decision the automation made that tick.
 */
/**
 * ZUK_REPLAY=1 - write a scrubbable view of the run next to its log.
 *
 * The browser cannot show this fight. Its RNG stream, its input timing and its renderer all differ
 * from the harness, and every attempt to align them has aligned one and broken another. So instead
 * of making the engine reproduce the run, the run records itself and is drawn back: same numbers
 * the report is built from, one frame per tick, no simulation involved and nothing to diverge.
 */
const REPLAY = process.env.ZUK_REPLAY === "1";

const TRACE = (() => {
  const raw = process.env.ZUK_TRACE ?? "";
  const match = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  return match ? { from: parseInt(match[1], 10), to: parseInt(match[2], 10) } : null;
})();
/**
 * Where the trace file lands. The default carries both the seed and the shield direction, so a
 * west run and an east run of the same seed sit side by side instead of overwriting each other.
 */
const TRACE_OUT =
  process.env.ZUK_TRACE_OUT ||
  path.resolve("test/harness/zuk-results", `seed-${SEED}-${SHIELD}.trace.log`);

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
 * The fight's phases, in the order Zuk goes through them.
 *
 * Read off Zuk's own state rather than off hitpoint thresholds, because the thresholds are only
 * half the rule: the set timer pausing at 600 and resuming at 480 is what decides whether Jad is
 * coming, and `hasPaused` is what stops it happening twice. Ordered so "how far did this seed
 * get" is just an index comparison.
 */
const PHASES = ["opening", "pre-jad", "jad", "post-jad", "enrage", "dead"] as const;
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

test("seeded Zuk fight through the real InfernoAutomation.onTick", () => {
  expect(VALID_LOADOUTS).toContain(LOADOUT);
  expect(Number.isFinite(SEED)).toBe(true);
  expect(START_WAVE).toBeGreaterThanOrEqual(67);
  expect(START_WAVE).toBeLessThanOrEqual(69);

  silenceConsole();

  const { region, world, player } = bootHarness({
    seed: SEED,
    wave: START_WAVE,
    loadout: LOADOUT,
    prayerOverride: PRAYER_OVERRIDE,
    runOverride: RUN_OVERRIDE,
    shieldDirection: SHIELD,
  });

  const anyRegion = region as unknown as { wave: number; mobs: any[]; newMobs: any[]; ticksUntilNextWave: number };
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
  const findLive = (name: string) => liveMobs().find((mob) => mob.mobName() === name) ?? null;
  const hp = () => anyPlayer.currentStats.hitpoint;
  const prayer = () => anyPlayer.currentStats.prayer;
  const overhead = () => {
    try {
      return anyPlayer.prayerController?.overhead()?.name ?? "none";
    } catch (e) {
      return "?";
    }
  };
  /**
   * Supplies counted in DOSES, not vials.
   *
   * A brew is one inventory item holding four sips, so counting items only moves on every
   * fourth drink - and "did the bot drink at all" is the whole question when a run dies at 40
   * hitpoints with a full inventory.
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
  /**
   * Whether the tile we are standing on is behind the shield, this tick.
   *
   * Read off the score the bot itself decided from - `shieldPenalty` is non-zero exactly when
   * the tile is exposed to Zuk - rather than recomputed here, so the report cannot disagree
   * with what the bot believed.
   */
  const covered = () =>
    !InfernoAutomation.getScoredTiles().some(
      (scored) =>
        scored.tile.x === anyPlayer.location.x &&
        scored.tile.y === anyPlayer.location.y &&
        (scored.parts?.shieldPenalty ?? 0) !== 0,
    );

  const phaseNow = (): Phase => {
    const zuk = findLive(EntityNames.TZ_KAL_ZUK) as
      | { enraged: boolean; timerPaused: boolean; hasPaused: boolean }
      | null;
    if (!zuk) {
      return "dead";
    }
    if (zuk.enraged) {
      return "enrage";
    }
    if (findLive(EntityNames.JAL_TOK_JAD)) {
      return "jad";
    }
    if (zuk.hasPaused) {
      return zuk.timerPaused ? "pre-jad" : "post-jad";
    }
    return "opening";
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
  const recentHits: { tick: number; phase: Phase; from: string; damage: number; hpAfter: number }[] = [];
  const seenMobs = new Set<unknown>();

  /**
   * EVERY ZUK ATTACK, GRADED AGAINST WHAT THE SCORER BELIEVED WHEN IT CHOSE THE TILE.
   *
   * Three hits in forty runs is not a tuning problem, it is a specific disagreement between the
   * model and the world happening three times in seven thousand attacks - so the only useful
   * record is the one taken AT the disagreement, with both sides of it written down.
   *
   * Reasoning backwards from a death cannot separate the candidates. A projection that drifts, an
   * arrival estimate that overpromises and a clock that mis-dates the fire all end with the same
   * corpse on the same tile. They do NOT leave the same row here: the first shows predicted x not
   * matching real x, the second shows a tile marked safe that was never stood on, the third shows
   * the fire landing on a tick nothing was predicted for.
   *
   * `beliefs` is the rolling trail, keyed by nothing - just the last ~16 ticks - because the tick
   * a decision was committed on is exactly what is in question and must not be assumed.
   */
  interface Belief {
    tick: number;
    untilFire: number | null;
    /** The tick the clock said this attack would land on, or null with no sync yet. */
    predictedFireTick: number | null;
    playerX: number;
    playerY: number;
    shieldX: number | null;
    shieldDir: boolean | null;
    shieldFrozen: number;
    /** What the scorer projected the shield to be at the fire tick it was aiming for. */
    projectedShieldX: number | null;
    chosenX: number | null;
    chosenY: number | null;
    /** The scorer's own verdict on the tile the player is STANDING on. */
    standingSafe: boolean;
    /** Real geometry, TzKalZuk.attack's own test - not the scorer's opinion of it. */
    standingCovered: boolean;
    /**
     * WHY THE WALK IS THE SPEED IT IS - the four readings that separate the candidates.
     *
     * Measured, seed 9 with the sprint active: eight tiles in seven ticks, moving two and then
     * none, repeating, with no attack, no gear swap and the sprint gate returning early on every
     * one of those ticks. So the stall is not the bot spending the tick elsewhere, and every
     * remaining explanation lives in these fields.
     *
     *   dest      null or already-arrived on the still ticks means the destination is being
     *             dropped and re-issued rather than held, and the re-click costs the tick
     *   running   false on the still ticks means the orb is being turned off, and a walk is 1
     *   runEnergy falling to 0 means the engine downgraded the run despite the harness pin
     *   moved     the ground truth the other three are explaining
     */
    destX: number | null;
    destY: number | null;
    running: boolean;
    runEnergy: number;
    moved: number;
  }
  const beliefs: Belief[] = [];
  interface FireAudit {
    tick: number;
    /** Where the player was when Zuk aimed: end of the PREVIOUS tick, since mobs step first. */
    aimedAtX: number;
    aimedAtY: number;
    shieldX: number | null;
    covered: boolean;
    damage: number;
    trail: Belief[];
  }
  const fires: FireAudit[] = [];
  const zukHitTicks: { tick: number; damage: number }[] = [];
  let zukAttacks = 0;
  let zukFiresUncovered = 0;
  let lastZukDelay: number | null = null;
  let prevPlayerX = 0;
  let prevPlayerY = 0;
  /**
   * Damage that arrived with no projectile to blame it on.
   *
   * Jad, in practice, and only Jad. Its `DelayedAction` calls `super.attack()` three ticks late,
   * and the projectile that call builds carries `reduceDelay: JAD_PROJECTILE_DELAY` - which floors
   * `remainingDelay` at 1 and lets the player's `processIncomingAttacks` resolve it in the SAME
   * tick it was created. The attribution above compares two snapshots a tick apart, so a
   * projectile that never survives a tick boundary is invisible to it: hitpoints fall and nothing
   * is named. Every other attacker's shot lives at least one full tick and attributes fine.
   *
   * `delta + landedTotal` is the arithmetic. `delta` is the tick's whole hitpoint change and
   * `landedTotal` is the part with a projectile behind it, so a negative sum is damage that
   * happened without one.
   */
  const unattributed: {
    tick: number;
    phase: Phase;
    damage: number;
    hpAfter: number;
    overhead: string;
    jadStyle: string;
    jadLandsIn: string;
  }[] = [];
  let unattributedTotal = 0;
  const spawnCounts: Record<string, number> = {};
  let maxPhase: Phase = "opening";
  let phase: Phase = "opening";
  const phaseFirstTick: Partial<Record<Phase, number>> = { opening: 0 };
  let zukMinHp = Number.MAX_SAFE_INTEGER;
  let zukHealed = 0;
  let shieldSeen = false;
  let shieldGoneTick: number | null = null;
  /**
   * WHERE THE SHIELD'S 600 HITPOINTS ACTUALLY WENT.
   *
   * Two sources, and they mean opposite things:
   *
   *   TzKal-Zuk        structural and not a failure. `attackIfPossible` aims at the SHIELD rather
   *                    than at us whenever we are inside the band, so every shot we successfully
   *                    hide from is paid for out of these hitpoints. Being hidden IS spending
   *                    them, and nothing about our targeting changes it.
   *   Jal-Zek/Jal-Xil  a tagging failure, and the only part that can be played better. A set
   *                    spawns aggroed to the shield and stays on it until we land one hit, so
   *                    every point here is one that a faster tag would have saved.
   *
   * Same resolution rule as the player's attribution - a projectile counts on the tick its
   * `remainingDelay` reaches 0, not when it leaves the list.
   */
  /**
   * WHAT THE BOT WAS DOING ON EVERY TICK A SET MOB SAT UNTAGGED.
   *
   * The gap between a pair spawning and being pulled off the shield is the whole of the shield's
   * damage - Zuk contributes nothing to it - and the ordering is already untagged-first, so the
   * delay is something REFUSING the shot rather than something choosing a different target.
   * Reach, weapon cooldown, a hold, a gear swap and re-shooting a mob whose tag is still in flight
   * all produce the same number and different reasons, so the reason is what gets counted.
   *
   * Keyed by the automation's own attackState, verbatim, so nothing here has to guess at intent.
   */
  /**
   * WHY NO STEP-OUT WAS OFFERED, on the ticks one was wanted.
   *
   * Counted only while something is still on the shield, since that is the only time the question
   * matters. Read straight off the scorer's own report so it cannot disagree with the code that
   * decided - see SortieDebug.
   */
  const sortieRefusals = new Map<string, number>();
  let sortieOfferedTicks = 0;
  let sortieWantedTicks = 0;
  /** One pipe-separated line per traced tick, plus FIRED lines - written to TRACE_OUT. */
  const traceLines: string[] = [];
  /** One frame per tick when ZUK_REPLAY=1 - see REPLAY. */
  const replayFrames: {
    t: number;
    px: number;
    py: number;
    hp: number;
    sx: number | null;
    sd: boolean;
    shp: number;
    mobs: { n: string; x: number; y: number; t: boolean }[];
    s: string;
  }[] = [];
  const untaggedReasons = new Map<string, Map<string, number>>();
  /**
   * ARE WE TAGGING AS SOON AS IT IS POSSIBLE TO?
   *
   * A tick counts as an OPPORTUNITY when all three are true at once:
   *
   *   - an untagged set mob is alive and inside the long weapon's reach
   *   - `earliestShotOffset` is 1, so the engine will let a shot go next tick
   *   - therefore a click now becomes a tag
   *
   * If the bot attacked a set mob on that tick the opportunity was TAKEN. Anything else is a tick
   * where the tag was available and something else was done with it, and the automation's own
   * state string says what. Two untagged mobs in reach on the same tick is still one opportunity,
   * because there is one weapon - so this never counts an unavoidable wait as a miss.
   *
   * Zero missed means the answer is yes and any remaining shield damage is reach or cooldown,
   * neither of which is a targeting fault.
   */
  let tagChances = 0;
  let tagChancesTaken = 0;
  const tagMissReasons = new Map<string, number>();
  /**
   * UNCONTESTED: the mob was the ONLY untagged thing in reach, so no other tag was competing for
   * the tick. A miss here cannot be explained by "it was busy tagging the other one" - there was
   * no other one - and is the sharpest evidence of a real delay in the automation rather than in
   * the geometry. Tracked per mob because the two halves of a pair fail for different reasons.
   */
  /**
   * EVERY SET MOB'S LIFE FROM SPAWN TO TAG, with where we were standing when it landed.
   *
   * The `west/mager` line in the automation log answers a different question badly: it is latched
   * at the FIRST set and never re-read, so it says nothing about where the shield had carried us
   * for sets two through six - which is the only thing that decides which half of the pair is
   * reachable. This records the answer per set instead of per fight.
   *
   * The three ticks that matter are spawn, first-in-reach and tagged. Their gaps separate the two
   * failures completely: spawn -> in-reach is geometry, nothing the targeting can do about it;
   * in-reach -> tagged is the automation, and should be one cooldown at most.
   */
  /**
   * HOW LONG EACH HEALER WAS ACTUALLY ALIVE.
   *
   * "During enrage" and "while a healer was alive" are not the same window and reading one as the
   * other overstates the healers badly: they spawn together at enrage and are killed, while the
   * enrage phase label then runs to the end of the fight. A set arriving 200 ticks into enrage may
   * be arriving into four healers or into none, and only this can tell them apart.
   */
  const healerLives: { spawned: number; died: number | null }[] = [];
  const healerIndex = new Map<unknown, number>();
  const setSpawns: {
    tick: number;
    name: string;
    playerX: number;
    playerY: number;
    distance: number;
    firstInReach: number | null;
    taggedAt: number | null;
    /** Live healers at the moment this pair landed - the whole question, recorded once. */
    healersAlive: number;
    mob: unknown;
  }[] = [];
  const soloChances = new Map<string, number>();
  const soloTaken = new Map<string, number>();
  const soloMissReasons = new Map<string, Map<string, number>>();
  const shieldDamageBySource = new Map<string, number>();
  /** Every hit the shield took, so the SHAPE of the drain is visible and not just its total. */
  const shieldHits: { tick: number; phase: Phase; from: string; damage: number; hpAfter: number }[] =
    [];
  const shieldShotsSeen = new Set<unknown>();
  let shieldDamageTotal = 0;
  const collisionsSeen = new Set<string>();
  const taggedSeen = new Set<unknown>();
  const spawnTicks = new Map<unknown, number>();
  const tagLog: {
    tick: number;
    name: string;
    style: string;
    delay: number;
    residue: number;
    gapFromSpawn: number | null;
    rephased: boolean;
    preFirstShot: boolean;
  }[] = [];
  let crossStyleCollisions = 0;
  let sameStyleCollisions = 0;
  let maxTagged = 0;
  // ---- FIRE WATCH state: observed attacks, not delay arithmetic. A fire is the delay RESET
  // (attackDelay jumping to the full attackSpeed - `didAttack` is the only writer that does
  // that), the same rule ShieldAttackerClock uses. Everything the off-tick verdict reports is
  // derived from these observed events, because `(tick + attackDelay) % 4` is only meaningful
  // for a mob ON its firing cycle - pre-opening and walking mobs have a drifting negative delay
  // and produced phantom collisions (seeds 29 and 75 of the 2026-08-22 sweep). ----
  const lastDelayByMob = new Map<unknown, number>();
  /** Per tracked attacker: every observed fire, with the overhead that was up when it mattered. */
  const fireHistory = new Map<
    unknown,
    { name: string; speed: number; demands: { tick: number; atPlayer: boolean }[] }
  >();
  /**
   * Prayer-demand ledger, keyed by the tick the overhead is actually tested on: the FIRE tick
   * for the pair (damage is rolled, and blocked, at fire time), the LANDING tick for Jad
   * (JadMagicWeapon/JadRangeWeapon defer the real attack by JAD_LAND_DELAY).
   */
  const demandsByTick = new Map<
    number,
    { name: string; style: string; prayer: string | null }[]
  >();
  let unprayedFires = 0;
  let lastSupplies = startingSupplies;
  let uncoveredTicks = 0;
  let damageTaken = 0;
  let healed = 0;
  let lowestHp = anyPlayer.stats.hitpoint;
  let tick = 0;
  let outcome = "";
  let cause = "";
  let killers: Landed[] = [];
  let botLogAtStop = "";
  /**
   * Read BEFORE `setEnabled(false)`, for the same reason `botLogAtStop` is: disabling resets every
   * piece of per-run automation state, the heal counter included, so asking afterwards reports a
   * flat zero on every seed no matter what happened.
   */
  let scaffoldHealing = { used: 0, total: 0 };
  let zukWaveHadMobs = false;
  let zukEverSeen = false;
  // Projectiles already counted, by identity - see the attribution block.
  const tracked = new WeakSet<object>();
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
    `zuk harness | seed ${SEED} | loadout ${LOADOUT} | wave ${START_WAVE} | shield ${SHIELD} | ` +
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
  // /?seed=N&shield=X is the run this reports. See src/index.ts.
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
      const zukBefore = (findLive(EntityNames.TZ_KAL_ZUK) as { currentStats?: { hitpoint: number } } | null)
        ?.currentStats?.hitpoint;
      // For the FIRED trace lines. A shot that goes out THIS tick uses the aggro and the weapon
      // from before tickWorld runs: aggro set by a click only changes in postTick, after the
      // attack has already resolved, and a queued gear switch only matures when the timers
      // advance below - so the post-tick readings can both belong to the NEXT shot, not this one.
      const wornBefore =
        (anyPlayer as unknown as { equipment?: { weapon?: { itemName?: string } } }).equipment
          ?.weapon?.itemName ?? "none";
      const aggroBefore =
        (anyPlayer as unknown as { aggro?: { mobName?: () => string } }).aggro?.mobName?.() ??
        null;

      // An engine throw is a finding about the sim, not a harness failure - capture it, then fail
      // the test explicitly below once the report has printed.
      try {
        world.tickWorld();
      } catch (e) {
        outcome = "crashed";
        cause =
          `engine threw on tick ${tick} (phase ${phase}): ${(e as Error)?.message ?? e}\n` +
          ((e as Error)?.stack?.split("\n").slice(1, 5).join("\n") ?? "");
        break;
      }
      // The 600ms between ticks, during which queued input (gear switches, walk clicks) matures.
      jest.advanceTimersByTime(600);

      // ---- Shield watch, first, because everything below reports against it. Zuk's own typeless
      // hits land on the shield whenever the player is behind it, and the shield has 600
      // hitpoints and dies of them. Losing it means there is no cover left for the rest of the
      // fight - the largest thing that can happen to a run short of a mob spawning. ----
      const shieldNow = liveMobs().find((mob) => mob.mobName() === EntityNames.INFERNO_SHIELD) as
        | { currentStats?: { hitpoint: number } }
        | undefined;
      if (shieldNow) {
        shieldSeen = true;
        for (const projectile of (shieldNow as { incomingProjectiles?: unknown[] })
          .incomingProjectiles ?? []) {
          if (shieldShotsSeen.has(projectile)) {
            continue;
          }
          const shot = projectile as { remainingDelay?: number; damage?: number };
          if ((shot.remainingDelay ?? 1) > 0) {
            continue;
          }
          shieldShotsSeen.add(projectile);
          const damage = shot.damage ?? 0;
          if (damage > 0) {
            const from = sourceOf(projectile as { from?: unknown });
            shieldDamageBySource.set(from, (shieldDamageBySource.get(from) ?? 0) + damage);
            shieldDamageTotal += damage;
            shieldHits.push({
              tick,
              phase,
              from,
              damage,
              hpAfter: (shieldNow as { currentStats?: { hitpoint: number } }).currentStats?.hitpoint ?? 0,
            });
          }
        }
      } else if (shieldSeen && shieldGoneTick === null) {
        shieldGoneTick = tick;
        note("Zuk's shield destroyed - no cover left");
      }
      /** Where the player stands relative to cover, with "there is no cover" folded in. */
      const cover = () =>
        !shieldNow ? "NO SHIELD" : covered() ? "covered" : "EXPOSED";

      // Healer lifetimes. Death is "no longer live" rather than removal from the region, so the
      // death animation does not count as time spent healing.
      for (const mob of allMobs()) {
        if (mob.mobName() !== EntityNames.JAL_MEJ_JAK) {
          continue;
        }
        if (!healerIndex.has(mob)) {
          healerIndex.set(mob, healerLives.length);
          healerLives.push({ spawned: tick, died: null });
        }
        const record = healerLives[healerIndex.get(mob) as number];
        if (record.died === null && mob.dying !== -1) {
          record.died = tick;
        }
      }

      // Fill in the two milestones for anything still unresolved - see `setSpawns`.
      {
        const bowNow = weaponForSet(anyPlayer as unknown as Player, "tbow") as
          | { attackRange?: number }
          | null;
        const reachNow = bowNow?.attackRange ?? 0;
        for (const record of setSpawns) {
          const mob = record.mob as {
            location: { x: number; y: number };
            aggro?: unknown;
            dying: number;
          };
          if (record.taggedAt !== null || mob.dying !== -1) {
            continue;
          }
          if (
            record.firstInReach === null &&
            Math.max(
              Math.abs(mob.location.x - anyPlayer.location.x),
              Math.abs(mob.location.y - anyPlayer.location.y),
            ) <= reachNow
          ) {
            record.firstInReach = tick;
          }
          if (mob.aggro === anyPlayer) {
            record.taggedAt = tick;
          }
        }
      }

      {
        const debug = sortieDebug();
        if (debug.canTag > 0 || debug.canTagCovered > 0) {
          sortieWantedTicks++;
          if (debug.sorties > 0 || debug.canTagCovered > 0) {
            sortieOfferedTicks++;
          } else {
            const why = debug.refusedFor ?? "no tile could reach it at all";
            sortieRefusals.set(why, (sortieRefusals.get(why) ?? 0) + 1);
          }
        } else if (liveMobs().some((mob) => {
          const name = mob.mobName();
          return (
            (name === EntityNames.JAL_ZEK || name === EntityNames.JAL_XIL) &&
            (mob as { aggro?: unknown }).aggro !== anyPlayer
          );
        })) {
          // Something is on the shield and not one tile in the grid can shoot it.
          sortieWantedTicks++;
          const why = `nothing in range (budget ${debug.walkTicks ?? "-"})`;
          sortieRefusals.set(why, (sortieRefusals.get(why) ?? 0) + 1);
        }
      }

      if (TRACE && tick >= TRACE.from && tick <= TRACE.to) {
        const shieldMob = liveMobs().find(
          (mob) => mob.mobName() === EntityNames.INFERNO_SHIELD,
        ) as { location?: { x: number }; movementDirection?: boolean; frozen?: number; currentStats?: { hitpoint: number } } | undefined;
        const band = shieldMob?.location
          ? `${shieldMob.location.x}..${shieldMob.location.x + 4}${shieldMob.movementDirection ? "E" : "W"}`
          : "gone";
        const mobs = liveMobs()
          .filter((mob) =>
            mob.mobName() === EntityNames.JAL_ZEK || mob.mobName() === EntityNames.JAL_XIL)
          .map((mob) => {
            const distance = Math.max(
              Math.abs(mob.location.x - anyPlayer.location.x),
              Math.abs(mob.location.y - anyPlayer.location.y),
            );
            const tagged = (mob as { aggro?: unknown }).aggro === anyPlayer ? "TAGGED" : "onShield";
            return `${mob.mobName().replace("Jal-", "")}@${mob.location.x},${mob.location.y} d${distance} ${tagged}`;
          })
          .join("  ");
        out(
          `TRACE t${String(tick).padStart(4)} player ${anyPlayer.location.x},${anyPlayer.location.y} ` +
            `| shield ${band} ${shieldMob?.currentStats?.hitpoint ?? "-"}hp ` +
            `| zukIn ${ZukAttackClock.ticksUntilNextAttack() ?? "-"} ` +
            `| ${mobs || "no set mobs"} ` +
            `| ${InfernoAutomation.getAttackState?.() ?? "-"}`,
        );

        // ---- The file line: every field of the decision, one line per tick. Same readings as
        // the console line where the two overlap, so they cannot disagree. ----
        const fileBand = shieldMob?.location
          ? `${shieldMob.location.x}..${shieldMob.location.x + 4}|` +
            `${shieldMob.movementDirection ? "E" : "W"}|frz${shieldMob.frozen ?? 0}`
          : "gone";
        const untilSet = ZukSetTimer.ticksUntilSet();
        const setIn = `${untilSet ?? "-"}${ZukSetTimer.isPaused() ? "P" : ""}`;
        const zukNowHp =
          (findLive(EntityNames.TZ_KAL_ZUK) as { currentStats?: { hitpoint: number } } | null)
            ?.currentStats?.hitpoint ?? "-";
        const chosen = InfernoAutomation.getChosenTile?.() ?? null;
        const dest =
          (anyPlayer as unknown as { destinationLocation?: { x: number; y: number } | null })
            .destinationLocation ?? null;
        const walking =
          dest && (dest.x !== anyPlayer.location.x || dest.y !== anyPlayer.location.y)
            ? `->${dest.x},${dest.y}`
            : "-";
        const worn =
          (anyPlayer as unknown as { equipment?: { weapon?: { itemName?: string } } }).equipment
            ?.weapon?.itemName ?? "none";
        const decision = InfernoAutomation.getZukDecision?.() ?? {
          target: null,
          band: "-",
          tagGate: null,
        };
        const gate =
          decision.tagGate === null
            ? "-"
            : decision.tagGate.safe
              ? "ok"
              : `HELD: ${decision.tagGate.reason ?? "?"}`;
        const board = liveMobs()
          .filter((mob) => mob.mobName() !== EntityNames.INFERNO_SHIELD)
          .map((mob) => {
            const name = mob.mobName();
            const tagged =
              (mob as { aggro?: unknown }).aggro === anyPlayer
                ? "TAGGED"
                : name === EntityNames.JAL_ZEK ||
                    name === EntityNames.JAL_XIL ||
                    name === EntityNames.JAL_TOK_JAD
                  ? "onShield"
                  : "untagged";
            return `${name.replace("Jal-", "")}@${mob.location.x},${mob.location.y} ${tagged}`;
          })
          .join("; ");
        traceLines.push(
          `t${tick} | ${anyPlayer.location.x},${anyPlayer.location.y} | ${fileBand} | ` +
            `zukIn ${ZukAttackClock.ticksUntilNextAttack() ?? "-"} | setIn ${setIn} | ` +
            `zukHp ${zukNowHp} | chosen ${chosen ? `${chosen.x},${chosen.y}` : "-"} | ` +
            `walk ${walking} | weapon ${worn} | ` +
            `untilShot ${PlayerAttackClock.earliestShotOffset() ?? "-"} | ` +
            `target ${decision.target ?? "-"}[${decision.band}] | gate ${gate} | ` +
            `overhead ${overhead()} | ${board || "no mobs"}`,
        );
        // The clock's own fire signal - attackDelay going up this tick - so this cannot disagree
        // with what the engine did. Weapon and target are the pre-tick readings; see wornBefore.
        if (PlayerAttackClock.firedOnTickOffset(0)) {
          traceLines.push(
            `FIRED t${tick} | ${anyPlayer.location.x},${anyPlayer.location.y} | ` +
              `${wornBefore} | ${aggroBefore ?? "-"}`,
          );
        }
      }

      if (REPLAY) {
        const shieldMob = liveMobs().find(
          (mob) => mob.mobName() === EntityNames.INFERNO_SHIELD,
        ) as
          | { location?: { x: number }; movementDirection?: boolean; currentStats?: { hitpoint: number } }
          | undefined;
        replayFrames.push({
          t: tick,
          px: anyPlayer.location.x,
          py: anyPlayer.location.y,
          hp: hp(),
          sx: shieldMob?.location?.x ?? null,
          sd: Boolean(shieldMob?.movementDirection),
          shp: shieldMob?.currentStats?.hitpoint ?? 0,
          mobs: liveMobs()
            .filter((mob) => mob.mobName() !== EntityNames.INFERNO_SHIELD)
            .map((mob) => ({
              n: mob.mobName(),
              x: mob.location.x,
              y: mob.location.y,
              t: (mob as { aggro?: unknown }).aggro === anyPlayer,
            })),
          s: InfernoAutomation.getAttackState?.() ?? "-",
        });
      }

      // See `tagChances`. The reach asked about is the LONGEST weapon carried, because that is
      // what decides whether a shot is possible at all - which weapon is on is the bot's problem
      // and is exactly what this is measuring.
      {
        const bow = weaponForSet(anyPlayer as unknown as Player, "tbow") as
          | { attackRange?: number }
          | null;
        const reach = bow?.attackRange ?? 0;
        const state = InfernoAutomation.getAttackState?.() ?? "-";
        // `region.mobs` ONLY, deliberately. The automation reads through `visibleMobs`, which
        // withholds `newMobs` for a tick - a spawn is not knowable until the tick after it lands -
        // so counting a mob's spawn tick as a missed chance would be grading the bot against
        // information it is not allowed to have. One phantom miss per set, otherwise.
        const inReach = anyRegion.mobs
          .filter((mob) => mob.dying === -1)
          .filter((mob) => {
          const name = mob.mobName();
          if (name !== EntityNames.JAL_ZEK && name !== EntityNames.JAL_XIL) {
            return false;
          }
          if ((mob as { aggro?: unknown }).aggro === anyPlayer) {
            return false;
          }
          return (
            Math.max(
              Math.abs(mob.location.x - anyPlayer.location.x),
              Math.abs(mob.location.y - anyPlayer.location.y),
            ) <= reach
          );
        });
        if (inReach.length > 0 && PlayerAttackClock.earliestShotOffset() === 1) {
          // AGGRO, NOT THE STATE STRING. Matching on wording graded the bot against my choice of
          // words: a rule added to shoot with the held weapon says "shooting ... with what is in
          // hand", which no pattern written for "attacking ..." matches, so four real tags on
          // seed 67 were reported as misses. Aggro is the engine's own record of what we are
          // shooting, and it also counts correctly when the shot goes out on its own from aggro
          // set on an earlier tick - which is a chance taken, however it was set up.
          const shooting = inReach.some(
            (mob) => mob === (anyPlayer as { aggro?: unknown }).aggro,
          );
          const reason = state.replace(/^wave 69: /, "").split(" (")[0];
          tagChances++;
          if (shooting) {
            tagChancesTaken++;
          } else {
            tagMissReasons.set(reason, (tagMissReasons.get(reason) ?? 0) + 1);
          }
          // Uncontested only - one untagged mob in reach, one weapon, nothing to argue with.
          if (inReach.length === 1) {
            const name = inReach[0].mobName();
            soloChances.set(name, (soloChances.get(name) ?? 0) + 1);
            if (shooting) {
              soloTaken.set(name, (soloTaken.get(name) ?? 0) + 1);
            } else {
              const perMob = soloMissReasons.get(name) ?? new Map<string, number>();
              perMob.set(reason, (perMob.get(reason) ?? 0) + 1);
              soloMissReasons.set(name, perMob);
            }
          }
        }
      }

      // See `untaggedReasons`. Distance is Chebyshev, as the engine measures it, so a reach
      // explanation can be checked against the weapon rather than taken on trust.
      for (const mob of liveMobs()) {
        const name = mob.mobName();
        if (name !== EntityNames.JAL_ZEK && name !== EntityNames.JAL_XIL) {
          continue;
        }
        if ((mob as { aggro?: unknown }).aggro === anyPlayer) {
          continue;
        }
        const distance = Math.max(
          Math.abs(mob.location.x - anyPlayer.location.x),
          Math.abs(mob.location.y - anyPlayer.location.y),
        );
        const state = InfernoAutomation.getAttackState?.() ?? "-";
        // Bucketed to the leading phrase, so "attacking Jal-Xil" and "attacking Jal-Zek" do not
        // become two reasons, but the distance band is kept - it is the whole reach question.
        const reason = `${state.replace(/^wave 69: /, "").split(" (")[0].replace(/ (Jal|TzKal)-\S+/, "")}` +
          ` [d${distance <= 5 ? "<=5" : distance <= 7 ? "6-7" : distance <= 10 ? "8-10" : ">10"}]`;
        const perMob = untaggedReasons.get(name) ?? new Map<string, number>();
        perMob.set(reason, (perMob.get(reason) ?? 0) + 1);
        untaggedReasons.set(name, perMob);
      }

      // ---- Damage attribution, BY RESOLUTION rather than by removal.
      //
      // The old version diffed the incoming-projectile set across ticks and treated anything that
      // vanished as having just landed. That is a tick late, and the comment claiming otherwise
      // was wrong: `Unit.processIncomingAttacks` filters `shouldDestroy()` at the START of the
      // tick and applies damage further down, so a shot resolves on tick N and is still in the
      // list at postTick N - it only disappears on N+1. Hitpoints therefore fell a tick before
      // the blame did, and every hit was reported twice by the reconciliation below: once as
      // unexplained on the real tick, once attributed on the next.
      //
      // Resolution is `remainingDelay <= 0`, which is exactly the test the engine itself uses to
      // decide the shot has arrived. Each projectile is counted once, tracked by identity.
      //
      // It also picks up Jad, which the diff could never see. Jad's deferred `super.attack()`
      // builds a projectile with `reduceDelay: JAD_PROJECTILE_DELAY`, flooring `remainingDelay` at
      // 1 so it is created and resolved inside a single tick - born and dead between two
      // snapshots. Resolved-and-still-listed catches it like anything else.
      const landed: Landed[] = [];
      for (const projectile of anyPlayer.incomingProjectiles) {
        if (tracked.has(projectile)) {
          continue;
        }
        const shot = projectile as { damage?: number; attackStyle?: string; remainingDelay?: number };
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
        if (hit.from === EntityNames.TZ_KAL_ZUK && hit.damage > 0) {
          zukHitTicks.push({ tick, damage: hit.damage });
        }
        damageTaken += hit.damage;
        damageBySource.set(hit.from, (damageBySource.get(hit.from) ?? 0) + hit.damage);
        recentHits.push({ tick, phase, from: hit.from, damage: hit.damage, hpAfter: hp() });
        if (recentHits.length > 40) {
          recentHits.shift();
        }
        if (hit.damage >= 40) {
          note(`took ${hit.damage} from ${hit.from} (hp ${hp()}, ${cover()})`);
        }
      }
      const landedThisTick = landed;
      const delta = hp() - hpBefore;
      const landedTotal = landed.reduce((sum, hit) => sum + hit.damage, 0);
      if (delta + landedTotal > 0) {
        healed += delta + landedTotal;
      } else if (delta + landedTotal < 0) {
        // Damage with no resolved projectile behind it at all. With attribution now happening on
        // the tick the shot resolves, this should be empty - anything landing here is a genuine
        // hole rather than the one-tick lag it used to report.
        const damage = -(delta + landedTotal);
        unattributedTotal += damage;
        const jad = liveMobs().find((mob) => isJad(mob)) ?? null;
        unattributed.push({
          tick,
          phase,
          damage,
          hpAfter: hp(),
          overhead: overhead(),
          jadStyle: jad ? committedStyle(jad) ?? "-" : "no jad",
          jadLandsIn: jad ? String(ticksUntilJadLands(jad) ?? "-") : "-",
        });
        note(
          `UNATTRIBUTED ${damage} (hp ${hp()}, overhead ${overhead()}, ` +
            `jad committed ${jad ? committedStyle(jad) ?? "-" : "none"})`,
        );
      }
      lowestHp = Math.min(lowestHp, hp());

      // ---- Spawn watch: every mob is counted once, by identity. ----
      for (const mob of allMobs()) {
        if (seenMobs.has(mob)) {
          continue;
        }
        seenMobs.add(mob);
        spawnTicks.set(mob, tick);
        const name = mob.mobName();
        spawnCounts[name] = (spawnCounts[name] ?? 0) + 1;
        if (name === EntityNames.JAL_ZEK || name === EntityNames.JAL_XIL) {
          setSpawns.push({
            tick,
            name,
            playerX: anyPlayer.location.x,
            playerY: anyPlayer.location.y,
            distance: Math.max(
              Math.abs(mob.location.x - anyPlayer.location.x),
              Math.abs(mob.location.y - anyPlayer.location.y),
            ),
            firstInReach: null,
            taggedAt: null,
            healersAlive: liveMobs().filter(
              (other) => other.mobName() === EntityNames.JAL_MEJ_JAK,
            ).length,
            mob,
          });
        }
        if (name === EntityNames.JAL_ZEK) {
          note(`set ${spawnCounts[name]} spawned (mager + ranger)`);
        } else if (name === EntityNames.JAL_TOK_JAD) {
          note("Jad spawned");
        } else if (name === EntityNames.JAL_MEJ_JAK && spawnCounts[name] === 1) {
          note("enrage: Zuk's healers spawned");
        }
      }

      // ---- Zuk watch. ----
      const zuk = findLive(EntityNames.TZ_KAL_ZUK) as { currentStats?: { hitpoint: number } } | null;
      const zukHp = zuk?.currentStats?.hitpoint;
      if (zukHp !== undefined) {
        zukMinHp = Math.min(zukMinHp, zukHp);
        if (zukBefore !== undefined && zukHp > zukBefore) {
          zukHealed += zukHp - zukBefore;
        }
      }
      // Counted with the shield's existence folded in, NOT from the score alone: with no shield
      // on the board no tile carries a shield penalty, so the score would read "covered
      // everywhere" for the rest of the fight and quietly stop counting the exposure.
      if (!shieldNow || !covered()) {
        uncoveredTicks++;
      }

      // ---- TAG WATCH. The moment a mob's aggro flips to us, record what the flinch did to it.
      //
      // `Unit.processIncomingAttacks` floors `attackDelay` to `flinchDelay + 1` (3 here) ONLY if
      // it was below that, so a tag either re-phases the mob or leaves its cycle untouched - and
      // which of the two happened is the single fact that decides whether the resulting residue
      // was ours to choose or inherited. `attackDelay === 3` on the tag tick means the floor
      // fired. The spawn gap is carried too: `Mob.attackStep` returns early while `age > 0`, so a
      // mob tagged inside its spawn delay had never fired a shot. ----
      for (const mob of liveMobs()) {
        if (mob.aggro !== player || taggedSeen.has(mob) || (mob.attackSpeed ?? 0) !== 4) {
          continue;
        }
        taggedSeen.add(mob);
        const delay = mob.attackDelay ?? 0;
        const residue = (((tick + delay) % 4) + 4) % 4;
        const flinched = delay === 2;
        const spawnTick = spawnTicks.get(mob);
        const gap = spawnTick === undefined ? "?" : String(tick - spawnTick);
        const age = (mob as { age?: number }).age ?? 0;
        let style = "?";
        try {
          style = mob.attackStyleForNewAttack?.() ?? "?";
        } catch (e) {
          // Unreadable style is not a prayable style either.
        }
        tagLog.push({
          tick,
          name: mob.mobName(),
          style,
          delay,
          residue,
          gapFromSpawn: spawnTick === undefined ? null : tick - spawnTick,
          // The flinch sets attackDelay to 3 during movementStep, and Unit.attackStep
          // decrements it later in the SAME tick - so a mob observed at postTick reading 2 is one
          // the floor fired on, and one reading 3 was cycling at 4 and merely ticked down.
          rephased: delay === 2,
          preFirstShot: age > 0,
        });
        note(
          `TAG ${mob.mobName()}(${style}) | delay ${delay} -> residue ${residue} | ` +
            `${gap} ticks after spawn | ${flinched ? "RE-PHASED by the flinch" : "phase kept"}` +
            `${age > 0 ? " | before its first shot" : ""}`,
        );
      }

      // ---- OFF-TICK WATCH, from OBSERVED fires. Two attackers only cost hitpoints when their
      // prayer demands land on the SAME tick needing DIFFERENT overheads, so that - and nothing
      // reconstructed from attackDelay arithmetic - is what gets counted. The pair's demand tick
      // is its fire tick (Weapon.attack rolls and blocks damage at fire time); Jad's is its
      // LANDING tick, JAD_LAND_DELAY after the fire, because its weapons defer the real attack.
      // Zuk stays out: its hits are positional and no overhead answers them. ----
      {
        // 1. Detect this tick's fires: attackDelay jumping UP to the full attackSpeed. The two
        // other upward writers are not attacks and do not match it - the flinch parks the delay
        // at flinchDelay + 1 (3) and the mager's resurrection branch writes a flat 8.
        const watched = liveMobs().filter((mob) => {
          const name = mob.mobName();
          return (
            name === EntityNames.JAL_ZEK || name === EntityNames.JAL_XIL || isJad(mob)
          );
        });
        for (const mob of watched) {
          const delay = mob.attackDelay ?? 0;
          const previous = lastDelayByMob.get(mob);
          lastDelayByMob.set(mob, delay);
          if (previous === undefined || delay <= previous || delay !== (mob.attackSpeed ?? 4)) {
            continue;
          }
          const jad = isJad(mob);
          const name = mob.mobName();
          // Style by name for the pair - constant, and asking attackStyleForNewAttack would be
          // honest too but Jad's version is a fresh seeded draw, so names keep the rule uniform.
          // Jad's real style was captured at the animation commit by JadTracker this very tick.
          const style = jad
            ? committedStyle(mob) ?? "unknown"
            : name === EntityNames.JAL_ZEK
              ? "magic"
              : "range";
          const atPlayer = mob.aggro === player;
          const demandTick = tick + (jad ? JAD_LAND_DELAY : 0);
          const record = fireHistory.get(mob) ?? {
            name,
            speed: mob.attackSpeed ?? 4,
            demands: [],
          };
          record.demands.push({ tick: demandTick, atPlayer });
          fireHistory.set(mob, record);
          if (atPlayer) {
            const list = demandsByTick.get(demandTick) ?? [];
            list.push({ name, style, prayer: prayerForAttackStyle(style) });
            demandsByTick.set(demandTick, list);
          }
        }

        // 2. Judge THIS tick's demands against the overhead that was actually up while its
        // attacks resolved. Reading the controller HERE, after tickWorld, is deliberate: a
        // toggle made in postTick lives in `nextActiveState` until BasePrayer.tick() commits it
        // during the NEXT tick, so the isActive-based reading at this point is exactly the
        // overhead this tick's attackSteps saw - postTick's fresh clicks are not yet in it.
        // Jad's entry was filed JAD_LAND_DELAY ticks ago and the pair's just now, so by this
        // point the ledger for the current tick is complete.
        const overheadThisTick = overhead();
        const due = demandsByTick.get(tick) ?? [];
        demandsByTick.delete(tick);
        for (const demand of due) {
          if (demand.prayer !== null && demand.prayer !== overheadThisTick) {
            unprayedFires++;
            note(
              `UNPRAYED ${demand.name}(${demand.style}) fire judged this tick - ` +
                `overhead was ${overheadThisTick}`,
            );
          }
        }
        if (due.length >= 2) {
          const prayers = due
            .map((demand) => demand.prayer)
            .filter((value, index, all) => all.indexOf(value) === index);
          const names = due.map((demand) => `${demand.name}(${demand.style})`).join(" + ");
          const key = `${tick}:${names}`;
          if (!collisionsSeen.has(key)) {
            collisionsSeen.add(key);
            if (prayers.length > 1 || prayers.includes(null)) {
              crossStyleCollisions++;
              note(`OFF-TICK OVERLAP t${tick}: ${names} - one of these is unblockable`);
            } else {
              sameStyleCollisions++;
              note(`same-style overlap t${tick}: ${names} - one prayer covers both, free`);
            }
          }
        }
        // Kept for the summary's peak-attackers figure, same meaning as before.
        maxTagged = Math.max(
          maxTagged,
          liveMobs().filter((mob) => mob.aggro === player && mob.attackSpeed === 4).length,
        );
      }

      // ---- Supply watch, in doses: what the bot drank, and when. ----
      const nowSupplies = supplies();
      for (const key of Object.keys(nowSupplies)) {
        if (nowSupplies[key] < lastSupplies[key]) {
          note(`drank ${key} (${nowSupplies[key]} doses left, hp ${hp()}, prayer ${prayer()})`);
        }
      }
      lastSupplies = nowSupplies;

      const nextPhase = phaseNow();
      if (nextPhase !== phase) {
        phase = nextPhase;
        if (phaseFirstTick[phase] === undefined) {
          phaseFirstTick[phase] = tick;
        }
        if (PHASES.indexOf(phase) > PHASES.indexOf(maxPhase)) {
          maxPhase = phase;
        }
        const counts = supplies();
        note(
          `phase -> ${phase} | zuk ${zukHp ?? "-"} | hp ${hp()}/${anyPlayer.stats.hitpoint} | ` +
            `prayer ${prayer()} | brews ${counts.brews} restores ${counts.restores}`,
        );
      }

      if (findLive(EntityNames.TZ_KAL_ZUK)) {
        zukEverSeen = true;
      }

      // ---- Endings. ----
      //
      // ZUK DYING ENDS THE WAVE, and it is tested ahead of the player's own death on purpose.
      //
      // `TzKalZuk.damageTaken` sets `dying = 0` on every other mob the moment Zuk reaches zero -
      // its own shield included - and `detectDeath` runs after `attackStep`, so Zuk fires one last
      // shot in the same tick it dies, into an arena where the cover was destroyed earlier in that
      // same tick. That shot travels three ticks and lands on a player with nothing to stand
      // behind. Measured, four times in a hundred seeds, always at exactly +4 ticks: 1770 -> 1774,
      // 2220 -> 2224, 2249 -> 2253, 2581 -> 2585.
      //
      // Those runs killed Zuk. Reporting them as deaths counted a win as a loss and, worse, put
      // four unanswerable positional failures into the death column where they read as a bug in
      // the movement. There is no tile that survives a shot fired after the shield is already
      // gone, so there is nothing there to fix.
      //
      // NOT the old `no mobs left && ticksUntilNextWave === -1` test, which is what let these
      // through: `ticksUntilNextWave` is a wave-complete TIMER, so it reads non-negative for a
      // while after the kill and the run has to survive the countdown to be credited with a win it
      // has already earned. `findLive` excludes a mob mid-death-animation, so this fires on the
      // tick Zuk actually dies.
      if (anyRegion.wave === 69 && zukEverSeen && !findLive(EntityNames.TZ_KAL_ZUK)) {
        outcome = "completed";
        cause = `completed in ${tick} ticks with ${hp()} hp left`;
        break;
      }

      // Death second: a dying player is removed from region.players by the engine.
      if ((region as unknown as { players: unknown[] }).players.length === 0 || anyPlayer.isDying()) {
        outcome = "died";
        // This tick's hits if there are any, otherwise last tick's - see `previousLanded`.
        killers = landed.length ? landed : previousLanded;
        // The tick offset between the blow and the death being noticed is a property of
        // `Player.attackStep` running detectDeath before processIncomingAttacks, not of the run -
        // so it belongs in the source, not in every death line.
        const blame = killers.length
          ? killers.map((hit) => `${hit.from} for ${hit.damage}`).join(" + ")
          : "nothing resolved on the death tick or the one before";
        // Cover state belongs in the cause, not just the arena dump. Without the shield there is
        // no positional answer to Zuk at all, so "died to Zuk" means something completely
        // different depending on this - and it is the first thing worth knowing.
        const coverAtDeath =
          shieldGoneTick !== null
            ? ` - NO SHIELD (destroyed t${shieldGoneTick})`
            : covered()
              ? ""
              : " - EXPOSED, shield alive";
        // hp and phase are already their own columns in the sweep table, so repeating them
        // here only pushed the part that differs per seed off the end of the line.
        cause = `killed by ${blame}${coverAtDeath}`;
        break;
      }

      // Out of prayer is terminal for a bot that never drinks a restore: overheads drop and the
      // fight is lost from that point, so report it as its own outcome rather than letting it
      // show up later as an unexplained death.
      if (prayer() <= 0) {
        outcome = "ran out of prayer";
        cause = `prayer hit 0 during ${phase} (hp ${hp()}, ${supplies().restores} restores left)`;
        break;
      }

      // Wave 69 has no successor, so completion is "Zuk existed and now nothing is alive and no
      // countdown is pending" - the same state the region itself treats as the end.
      if (anyRegion.wave === 69) {
        if (liveMobs().length > 0) {
          zukWaveHadMobs = true;
        } else if (zukWaveHadMobs && anyRegion.ticksUntilNextWave === -1) {
          outcome = "completed";
          cause = `completed in ${tick} ticks with ${hp()} hp left`;
          break;
        }
      }

      // ---- Zuk fire audit. See `beliefs`. ----
      //
      // AFTER tickWorld, which is what makes the readings the right ones. Mobs step before
      // players, so on a tick Zuk fires: the shield has ALREADY moved and its position now is the
      // one Zuk aimed against, while the player has NOT yet moved from where Zuk saw them - which
      // is the position at the end of the previous tick, hence `prevPlayer`.
      {
        const zukNow = findLive(EntityNames.TZ_KAL_ZUK) as
          | { attackDelay?: number; attackSpeed?: number }
          | null;
        const shieldMob = liveMobs().find(
          (mob) => mob.mobName() === EntityNames.INFERNO_SHIELD,
        ) as { location?: { x: number }; movementDirection?: boolean; frozen?: number } | undefined;
        const shieldX = shieldMob?.location?.x ?? null;
        const shieldDir = shieldMob?.movementDirection ?? null;
        const shieldFrozen = shieldMob?.frozen ?? 0;
        const untilFire = ZukAttackClock.ticksUntilNextAttack();
        const chosen = InfernoAutomation.getChosenTile?.() ?? null;

        const belief: Belief = {
          tick,
          untilFire,
          predictedFireTick: untilFire === null ? null : tick + untilFire,
          playerX: anyPlayer.location.x,
          playerY: anyPlayer.location.y,
          shieldX,
          shieldDir,
          shieldFrozen,
          // The scorer's own projection, called rather than reimplemented - a copy of it here
          // would agree with a broken original by construction.
          projectedShieldX:
            shieldX === null || untilFire === null || shieldDir === null
              ? null
              : projectShield({ x: shieldX, direction: shieldDir, frozen: shieldFrozen }, untilFire)
                  .x,
          chosenX: chosen?.x ?? null,
          chosenY: chosen?.y ?? null,
          standingSafe: covered(),
          standingCovered:
            shieldX !== null &&
            isCoveredByShield(anyPlayer.location.x, anyPlayer.location.y, shieldX),
          destX:
            ((anyPlayer as { destinationLocation?: { x: number; y: number } | null })
              .destinationLocation ?? null)?.x ?? null,
          destY:
            ((anyPlayer as { destinationLocation?: { x: number; y: number } | null })
              .destinationLocation ?? null)?.y ?? null,
          running: Boolean((anyPlayer as { running?: boolean }).running),
          runEnergy: (anyPlayer.currentStats as { run?: number }).run ?? 0,
          // Chebyshev, because a diagonal step is one move in this engine.
          moved: Math.max(
            Math.abs(anyPlayer.location.x - prevPlayerX),
            Math.abs(anyPlayer.location.y - prevPlayerY),
          ),
        };
        beliefs.push(belief);
        if (beliefs.length > 16) {
          beliefs.shift();
        }

        // A FIRE IS THE DELAY GOING UP, the same rule ZukAttackClock syncs on: `didAttack` sets
        // attackDelay back to attackSpeed at the moment of firing, so a reading higher than last
        // tick's is an attack and nothing else is.
        const delayNow = zukNow?.attackDelay ?? null;
        if (delayNow !== null && lastZukDelay !== null && delayNow > lastZukDelay) {
          zukAttacks++;
          const aimedCovered =
            shieldX !== null && isCoveredByShield(prevPlayerX, prevPlayerY, shieldX);
          if (!aimedCovered) {
            zukFiresUncovered++;
            fires.push({
              tick,
              aimedAtX: prevPlayerX,
              aimedAtY: prevPlayerY,
              shieldX,
              covered: aimedCovered,
              // Whatever Zuk put on us this tick, so a breach that cost nothing is still visible.
              // Filled in by the report - the shot has three ticks of travel still to run.
              damage: 0,
              trail: beliefs.slice(-12).map((entry) => ({ ...entry })),
            });
          }
        }
        lastZukDelay = delayNow;
        prevPlayerX = anyPlayer.location.x;
        prevPlayerY = anyPlayer.location.y;
      }

      // LAST thing in the iteration, past every `break` above. Set any earlier and the death
      // check reads this tick's hits back as if they were last tick's, which is the same empty
      // list it already had.
      previousLanded = landedThisTick;
    }
  } finally {
    // Read before disabling - setEnabled(false) clears the automation's per-run state.
    botLogAtStop = InfernoAutomation.getLog();
    scaffoldHealing = InfernoAutomation.getZukHealing?.() ?? { used: 0, total: 0 };
    InfernoAutomation.setEnabled(false);
    jest.useRealTimers();
    restoreConsole();
  }

  if (!outcome) {
    outcome = "stuck";
    const zuk = findLive(EntityNames.TZ_KAL_ZUK) as { currentStats?: { hitpoint: number } } | null;
    cause =
      `hit the ${TICK_LIMIT} tick budget during ${phase} ` +
      `(zuk ${zuk?.currentStats?.hitpoint ?? "-"}, ${liveMobs().length} mobs alive, hp ${hp()})`;
  }

  // ---- Report. ----
  const zukAtEnd = (findLive(EntityNames.TZ_KAL_ZUK) as { currentStats?: { hitpoint: number } } | null)
    ?.currentStats?.hitpoint ?? 0;
  const endingSupplies = supplies();
  const shield = allMobs().find((mob) => mob.mobName() === EntityNames.INFERNO_SHIELD);

  out("");
  out("timeline:");
  for (const event of events) {
    out(`  t${String(event.tick).padStart(4)}  ${event.text}`);
  }

  out("");
  out("tags (what the flinch did to each mob's cycle):");
  if (tagLog.length === 0) {
    out("  (nothing was ever tagged)");
  }
  for (const entry of tagLog) {
    out(
      `  t${String(entry.tick).padStart(4)}  ${entry.name.padEnd(8)} ${entry.style.padEnd(5)} | ` +
        `delay ${String(entry.delay).padStart(3)} -> residue ${entry.residue} | ` +
        `${String(entry.gapFromSpawn ?? "?").padStart(3)} ticks after spawn | ` +
        `${entry.rephased ? "RE-PHASED" : "phase kept"}${entry.preFirstShot ? " | pre-first-shot" : ""}`,
    );
  }

  // ---- Lanes: each attacker's OBSERVED demand ticks, the ground truth the residue arithmetic
  // above only approximates. A "slip" is a consecutive pair of at-player demands whose gap is
  // not a multiple of the mob's speed - the cadence re-anchoring mid-life, which nothing in the
  // automation currently detects or repairs. The first at-player demand is exempt: the jump
  // from shield cadence to tag cadence is the flinch doing its job, not a slip. ----
  const lanes: {
    name: string;
    speed: number;
    firstAtPlayer: number | null;
    residues: number[];
    demands: number;
    slips: number;
  }[] = [];
  out("");
  out("lanes (observed fires; demand tick = fire for the pair, landing for Jad):");
  if (fireHistory.size === 0) {
    out("  (no set mob or Jad ever fired)");
  }
  fireHistory.forEach((record) => {
    const atPlayer = record.demands.filter((demand) => demand.atPlayer).map((d) => d.tick);
    let slips = 0;
    for (let i = 1; i < atPlayer.length; i++) {
      if ((atPlayer[i] - atPlayer[i - 1]) % record.speed !== 0) {
        slips++;
      }
    }
    const residues = atPlayer
      .map((t) => ((t % 4) + 4) % 4)
      .filter((value, index, all) => all.indexOf(value) === index);
    lanes.push({
      name: record.name,
      speed: record.speed,
      firstAtPlayer: atPlayer[0] ?? null,
      residues,
      demands: atPlayer.length,
      slips,
    });
    out(
      `  ${record.name.padEnd(11)} speed ${record.speed} | ` +
        `${String(record.demands.length).padStart(3)} fires, ` +
        `${String(atPlayer.length).padStart(3)} at player` +
        (atPlayer.length > 0
          ? ` from t${atPlayer[0]} | residues mod4 [${residues.join(",")}] | ` +
            `${slips === 0 ? "cadence held" : `${slips} SLIP${slips === 1 ? "" : "S"}`}`
          : ""),
    );
  });

  out("");
  out("unattributed damage (no projectile to blame - see the note in the source):");
  if (unattributed.length === 0) {
    out("  (none - every point of damage had a projectile behind it)");
  }
  for (const hit of unattributed) {
    out(
      `  t${String(hit.tick).padStart(4)}  ${String(hit.damage).padStart(3)} ` +
        `-> hp ${String(hit.hpAfter).padStart(3)} | overhead ${hit.overhead.padEnd(16)} ` +
        `| jad committed ${hit.jadStyle.padEnd(6)} lands in ${hit.jadLandsIn}  [${hit.phase}]`,
    );
  }
  if (unattributed.length > 0) {
    out(`  ${unattributed.length} hits, ${unattributedTotal} damage total`);
  }

  out("");
  out(`zuk attacks: ${zukAttacks} | fired at an UNCOVERED player ${zukFiresUncovered} time` +
    `${zukFiresUncovered === 1 ? "" : "s"}` +
    `${zukAttacks > 0 ? ` (1 in ${Math.round(zukAttacks / Math.max(1, zukFiresUncovered))})` : ""}`);
  if (fires.length === 0) {
    out("  (every shot was aimed at a covered player - the model held all run)");
  }
  for (const fire of fires) {
    // The shot lands three ticks out; anything from Zuk in the next few ticks belongs to it.
    const hit = zukHitTicks.find((h) => h.tick > fire.tick && h.tick <= fire.tick + 5);
    out("");
    out(
      `  BREACH t${fire.tick}: zuk aimed at ${fire.aimedAtX},${fire.aimedAtY} | ` +
        `shield x ${fire.shieldX ?? "-"} (covers ${fire.shieldX ?? "-"}..${
          fire.shieldX === null ? "-" : fire.shieldX + 4
        }) | ` +
        `${hit ? `HIT for ${hit.damage} on t${hit.tick}` : "no damage"}`,
    );
    out(
      "    tick  untilFire  predFire  player  shield  proj  chosen   scorer  real  mv  dest     run",
    );
    for (const b of fire.trail) {
      // predFire === the fire tick means this row is a belief ABOUT the shot that broke through.
      const aboutThisShot = b.predictedFireTick === fire.tick ? "*" : " ";
      out(
        `    ${String(b.tick).padStart(4)}${aboutThisShot} ` +
          `${String(b.untilFire ?? "-").padStart(9)} ` +
          `${String(b.predictedFireTick ?? "-").padStart(9)} ` +
          `${`${b.playerX},${b.playerY}`.padStart(7)} ` +
          `${String(b.shieldX ?? "-").padStart(7)}${b.shieldDir === null ? " " : b.shieldDir ? "E" : "W"}` +
          `${b.shieldFrozen > 0 ? `f${b.shieldFrozen}` : "  "} ` +
          `${String(b.projectedShieldX ?? "-").padStart(4)} ` +
          `${`${b.chosenX ?? "-"},${b.chosenY ?? "-"}`.padStart(7)} ` +
          `${(b.standingSafe ? "safe" : "UNSAFE").padStart(7)} ` +
          `${b.standingCovered ? "cov" : "EXP"}` +
          `${String(b.moved).padStart(4)}  ` +
          `${`${b.destX ?? "-"},${b.destY ?? "-"}`.padEnd(7)} ` +
          `${b.running ? "run" : "WALK"}${String(Math.round(b.runEnergy / 100)).padStart(4)}%`,
      );
    }
    out(
      "    (* = a belief about THIS shot. proj = what the scorer projected the shield to be at " +
        "the fire tick.",
    );
    out(
      "     scorer = its verdict on the tile the player stood on; real = TzKalZuk's own cover " +
        "test on that tile.)",
    );
  }

  out("");
  out("healers, and whether any set landed while one was alive:");
  if (healerLives.length === 0) {
    out("  (no healers ever spawned)");
  }
  for (const life of healerLives) {
    out(
      `  Jal-MejJak  t${life.spawned} -> ${life.died === null ? "still alive at the end" : `t${life.died}`}` +
        `${life.died === null ? "" : ` (${life.died - life.spawned} ticks)`}`,
    );
  }
  {
    const overlapping = setSpawns.filter((record) => record.healersAlive > 0);
    const setTicks: number[] = [];
    for (const record of overlapping) {
      if (setTicks.indexOf(record.tick) < 0) {
        setTicks.push(record.tick);
      }
    }
    out(
      setTicks.length === 0
        ? "  NO set spawned while a healer was alive - healers are ruled out"
        : `  ${setTicks.length} set(s) landed with healers alive: ${setTicks
            .map((tick) => `t${tick}`)
            .join(", ")}`,
    );
  }

  out("");
  out("every set mob, spawn -> in reach -> tagged:");
  out("  spawn  mob       player   dist  inReach(+n)  tagged(+n)   note");
  for (const record of setSpawns) {
    const reachGap = record.firstInReach === null ? null : record.firstInReach - record.tick;
    const tagGap = record.taggedAt === null ? null : record.taggedAt - record.tick;
    // The two halves of the gap, named. Geometry is spawn -> in reach; the automation owns the
    // rest, and anything past one cooldown there is a real delay.
    const note =
      record.taggedAt === null
        ? "NEVER TAGGED"
        : reachGap === null
          ? "-"
          : `${reachGap} waiting for reach, ${(tagGap ?? 0) - reachGap} to shoot`;
    out(
      `  t${String(record.tick).padStart(5)}  ${record.name.padEnd(9)} ` +
        `${`${record.playerX},${record.playerY}`.padEnd(7)} ` +
        `${String(record.distance).padStart(4)}  ` +
        `${String(record.firstInReach ?? "-").padStart(6)}${`(+${reachGap ?? "-"})`.padEnd(6)} ` +
        `${String(record.taggedAt ?? "-").padStart(6)}${`(+${tagGap ?? "-"})`.padEnd(6)}  ${note}`,
    );
  }

  out("");
  out(
    `tagging as soon as possible: ${tagChancesTaken}/${tagChances} chances taken` +
      `${tagChances > 0 ? ` (${Math.round((tagChancesTaken / tagChances) * 100)}%)` : ""}`,
  );
  if (tagChances === tagChancesTaken) {
    out("  (every tick where a tag was both in reach and off cooldown was used on one)");
  }
  {
    const rows: { reason: string; ticks: number }[] = [];
    tagMissReasons.forEach((ticks, reason) => rows.push({ reason, ticks }));
    rows.sort((a, b) => b.ticks - a.ticks);
    for (const row of rows) {
      out(`  MISSED ${String(row.ticks).padStart(4)}  ${row.reason}`);
    }
  }
  out("");
  out("uncontested chances (that mob was the ONLY untagged one in reach):");
  if (soloChances.size === 0) {
    out("  (never - a tag was always competing with the other half of the pair)");
  }
  soloChances.forEach((chances, name) => {
    const taken = soloTaken.get(name) ?? 0;
    out(
      `  ${name.padEnd(10)} ${taken}/${chances} taken` +
        `${chances > 0 ? ` (${Math.round((taken / chances) * 100)}%)` : ""}`,
    );
    const perMob = soloMissReasons.get(name);
    if (perMob) {
      const rows: { reason: string; ticks: number }[] = [];
      perMob.forEach((ticks, reason) => rows.push({ reason, ticks }));
      rows.sort((a, b) => b.ticks - a.ticks);
      for (const row of rows) {
        out(`      MISSED ${String(row.ticks).padStart(4)}  ${row.reason}`);
      }
    }
  });

  out("");
  out(
    `step-out (sortie): ${sortieOfferedTicks}/${sortieWantedTicks} ticks had a firing tile ` +
      `available while something was still on the shield`,
  );
  {
    const rows: { why: string; ticks: number }[] = [];
    sortieRefusals.forEach((ticks, why) => rows.push({ why, ticks }));
    rows.sort((a, b) => b.ticks - a.ticks);
    for (const row of rows) {
      out(`  REFUSED ${String(row.ticks).padStart(4)}  ${row.why}`);
    }
  }

  out("");
  out("why a set mob was left untagged, per tick it stayed on the shield:");
  if (untaggedReasons.size === 0) {
    out("  (nothing ever sat untagged)");
  }
  untaggedReasons.forEach((perMob, name) => {
    const rows: { reason: string; ticks: number }[] = [];
    perMob.forEach((ticks, reason) => rows.push({ reason, ticks }));
    rows.sort((a, b) => b.ticks - a.ticks);
    const total = rows.reduce((sum, row) => sum + row.ticks, 0);
    out(`  ${name} - ${total} untagged ticks in total`);
    for (const row of rows) {
      out(
        `    ${String(row.ticks).padStart(4)}  ${String(Math.round((row.ticks / total) * 100)).padStart(3)}%  ` +
          row.reason,
      );
    }
  });

  out("");
  out(`shield damage by source (${shieldDamageTotal} attributed):`);
  if (shieldDamageBySource.size === 0) {
    out("  (nothing resolved against the shield)");
  }
  const shieldRows: { source: string; amount: number }[] = [];
  shieldDamageBySource.forEach((amount, source) => shieldRows.push({ source, amount }));
  shieldRows.sort((a, b) => b.amount - a.amount);
  for (const { source, amount } of shieldRows) {
    const share = shieldDamageTotal > 0 ? Math.round((amount / shieldDamageTotal) * 100) : 0;
    out(
      `  ${source.padEnd(16)} ${String(amount).padStart(5)}  ${String(share).padStart(3)}%` +
        `${source === EntityNames.TZ_KAL_ZUK ? "  (structural - shots we hid from)" : "  (tag delay)"}`,
    );
  }

  // EVERY HIT, NAMED AND TIMED AGAINST ITS OWN SET.
  //
  // The tick alone says nothing; the offset from that set's spawn says everything, because both
  // halves fire on a fixed schedule from the moment they land - `spawnDelay` 7 on the mager and 9
  // on the ranger, then every `attackSpeed` 4 ticks, with about three ticks of travel on top. So
  // an offset of +11 is their FIRST shot arriving and every later one is 4 ticks behind the last.
  //
  // Which makes the target exact rather than vague: a tag has to land before +7, not merely
  // "fast". A tag at +10 is already a hit taken, because their shot was in the air before ours
  // resolved. Each further 4 ticks of delay is one more hit, and a hit averages about 45 - so the
  // shield's 600 is a budget of roughly thirteen of them for the whole fight.
  if (shieldHits.length > 0) {
    const setTicks: number[] = [];
    for (const record of setSpawns) {
      if (setTicks.indexOf(record.tick) < 0) {
        setTicks.push(record.tick);
      }
    }
    setTicks.sort((a, b) => a - b);
    const setOf = (tick: number) => {
      let index = 0;
      for (let i = 0; i < setTicks.length; i++) {
        if (tick >= setTicks[i]) {
          index = i + 1;
        }
      }
      return index;
    };
    const who: Record<string, string> = {
      [EntityNames.JAL_ZEK]: "MAGER",
      [EntityNames.JAL_XIL]: "RANGER",
      [EntityNames.JAL_TOK_JAD]: "JAD",
    };
    out("");
    out("every hit the shield took:");
    out("  set  tick    who      +after spawn   dmg   shield left");
    let left = 600;
    for (const hit of shieldHits) {
      const index = setOf(hit.tick);
      const offset = index > 0 ? hit.tick - setTicks[index - 1] : null;
      left -= hit.damage;
      out(
        `   ${String(index || "-").padEnd(3)} t${String(hit.tick).padEnd(6)} ` +
          `${(who[hit.from] ?? hit.from).padEnd(7)}  ` +
          `+${String(offset ?? "-").padEnd(12)} ` +
          `${String(hit.damage).padStart(3)}   ${String(left).padStart(3)}`,
      );
    }
  }

  // WHEN it drained, in blocks, because a total cannot tell a steady bleed from a burst. A set
  // arriving and going untagged shows up as one block doing far more than its neighbours.
  if (shieldHits.length > 0) {
    const BLOCK = 250;
    const blocks = new Map<number, { total: number; zuk: number; set: number }>();
    for (const hit of shieldHits) {
      const key = Math.floor(hit.tick / BLOCK) * BLOCK;
      const row = blocks.get(key) ?? { total: 0, zuk: 0, set: 0 };
      row.total += hit.damage;
      if (hit.from === EntityNames.TZ_KAL_ZUK) {
        row.zuk += hit.damage;
      } else {
        row.set += hit.damage;
      }
      blocks.set(key, row);
    }
    const keys: number[] = [];
    blocks.forEach((_row, key) => keys.push(key));
    keys.sort((a, b) => a - b);
    out("");
    out(`shield drain per ${BLOCK} ticks (zuk = shots we hid from, set = tag delay):`);
    for (const key of keys) {
      const row = blocks.get(key);
      if (!row) {
        continue;
      }
      out(
        `  t${String(key).padStart(4)}-${String(key + BLOCK - 1).padEnd(5)} ` +
          `${String(row.total).padStart(4)} total | zuk ${String(row.zuk).padStart(4)} | ` +
          `set ${String(row.set).padStart(4)}  ${"#".repeat(Math.min(40, Math.round(row.total / 5)))}`,
      );
    }
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

  if (outcome !== "completed") {
    out("");
    out(`last hits before the end (tick ${tick}, phase ${phase}):`);
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
        `prayer ${prayer()}/${anyPlayer.stats.prayer} | overhead ${overhead()} | ` +
        `${shieldGoneTick !== null ? "NO SHIELD LEFT" : covered() ? "behind the shield" : "EXPOSED to Zuk"}`,
    );
    for (const mob of liveMobs()) {
      out(
        `  ${mob.mobName().padEnd(14)} @${mob.location.x},${mob.location.y} | ` +
          `hp ${mob.currentStats?.hitpoint ?? "?"}${(mob.frozen ?? 0) > 0 ? ` | frozen ${mob.frozen}` : ""}`,
      );
    }
    const botLog = botLogAtStop.split("\n").slice(-35);
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
    startWave: START_WAVE,
    shield: SHIELD,
    outcome,
    cause: cause.split("\n")[0],
    phase: maxPhase,
    ticks: tick,
    zukHp: zukAtEnd,
    zukMinHp: zukMinHp === Number.MAX_SAFE_INTEGER ? null : zukMinHp,
    zukHealed,
    shieldHp:
      (shield as { currentStats?: { hitpoint: number } } | undefined)?.currentStats?.hitpoint ?? 0,
    shieldGoneTick,
    // A set is one mager plus one ranger, so `sets` counts magers - but the two are reported
    // separately as well, because they do NOT die at the same rate and the gap between these
    // numbers and `aliveAtEnd` is the whole story of which one the bot is leaving on the board.
    sets: spawnCounts[EntityNames.JAL_ZEK] ?? 0,
    magersSpawned: spawnCounts[EntityNames.JAL_ZEK] ?? 0,
    rangersSpawned: spawnCounts[EntityNames.JAL_XIL] ?? 0,
    magersAlive: liveMobs().filter((mob) => mob.mobName() === EntityNames.JAL_ZEK).length,
    rangersAlive: liveMobs().filter((mob) => mob.mobName() === EntityNames.JAL_XIL).length,
    jads: spawnCounts[EntityNames.JAL_TOK_JAD] ?? 0,
    zukHealers: spawnCounts[EntityNames.JAL_MEJ_JAK] ?? 0,
    killers: killers.map((hit) => hit.from),
    killedBy: killers.length ? killers[0].from : null,
    hp: hp(),
    lowestHp,
    prayer: prayer(),
    prayerPool: PRAYER_OVERRIDE,
    runPool: RUN_OVERRIDE,
    overhead: overhead(),
    scaffoldHealing,
    zukAttacks,
    zukFiresUncovered,
    zukBreaches: fires.map((fire) => ({
      tick: fire.tick,
      aimedAt: { x: fire.aimedAtX, y: fire.aimedAtY },
      shieldX: fire.shieldX,
      damage: zukHitTicks.find((h) => h.tick > fire.tick && h.tick <= fire.tick + 5)?.damage ?? 0,
      trail: fire.trail,
    })),
    setSpawns: setSpawns.map((record) => ({
      tick: record.tick,
      name: record.name,
      playerX: record.playerX,
      playerY: record.playerY,
      distance: record.distance,
      firstInReach: record.firstInReach,
      taggedAt: record.taggedAt,
      healersAlive: record.healersAlive,
    })),
    healerLives,
    sortieOfferedTicks,
    sortieWantedTicks,
    tagChances,
    tagChancesTaken,
    soloChances: (() => {
      const asObject: Record<string, { chances: number; taken: number }> = {};
      soloChances.forEach((chances, name) => {
        asObject[name] = { chances, taken: soloTaken.get(name) ?? 0 };
      });
      return asObject;
    })(),
    shieldDamageTotal,
    shieldHits,
    shieldDamageBySource: (() => {
      const asObject: Record<string, number> = {};
      shieldDamageBySource.forEach((amount, source) => {
        asObject[source] = amount;
      });
      return asObject;
    })(),
    damageTaken,
    unattributedDamage: unattributedTotal,
    unattributedHits: unattributed.length,
    unattributed,
    healed,
    damageBySource: bySource.reduce(
      (map, [source, total]) => {
        map[source] = total;
        return map;
      },
      {} as Record<string, number>,
    ),
    uncoveredTicks,
    // The off-tick verdict: how many distinct residue collisions ever formed, and the most
    // simultaneous tagged attackers (over 4 and the flick is impossible by arithmetic alone).
    tagCollisions: collisionsSeen.size,
    crossStyleCollisions,
    sameStyleCollisions,
    unprayedFires,
    lanes,
    tags: tagLog,
    maxTagged,
    forcedAttacks: InfernoAutomation.getForcedAttackCount?.() ?? 0,
    suppliesStart: startingSupplies,
    suppliesLeft: endingSupplies,
    phaseFirstTick,
    aliveAtEnd: liveMobs().map((mob) => mob.mobName()),
    wallMs: Date.now() - startedAt,
  };

  out("----------------------------------------------------------------");
  out(`RESULT: ${outcome} - ${cause}`);
  out(
    `phase reached ${maxPhase} | zuk ${zukAtEnd} hp (lowest ${summary.zukMinHp}` +
      `${zukHealed > 0 ? `, healed ${zukHealed}` : ""}) | ` +
      `${summary.jads} jad${summary.jads === 1 ? "" : "s"}`,
  );
  out(
    `${summary.sets} sets | magers ${summary.magersSpawned} spawned, ${summary.magersAlive} still up | ` +
      `rangers ${summary.rangersSpawned} spawned, ${summary.rangersAlive} still up`,
  );
  out(
    `unattributed (jad): ${unattributedTotal} over ${unattributed.length} hit` +
      `${unattributed.length === 1 ? "" : "s"}`,
  );
  out(
    `test heal used ${scaffoldHealing.used}/${scaffoldHealing.total} | sets seen ${
      spawnCounts[EntityNames.JAL_ZEK] ?? 0
    }`,
  );
  out(
    `player hp ${hp()} (lowest ${lowestHp}) | took ${damageTaken}, healed ${healed} | ` +
      `brew doses ${endingSupplies.brews}/${startingSupplies.brews}, ` +
      `restore doses ${endingSupplies.restores}/${startingSupplies.restores}`,
  );
  out(
    `off-tick (observed fires): ${crossStyleCollisions} CROSS-STYLE overlap tick${crossStyleCollisions === 1 ? "" : "s"} (these cost hp) | ` +
      `${sameStyleCollisions} same-style (free) | ${unprayedFires} UNPRAYED fire${unprayedFires === 1 ? "" : "s"} | ` +
      `peak ${maxTagged} tagged speed-4 attackers`,
  );
  out(
    `shield ${shieldGoneTick === null ? `${summary.shieldHp} hp` : `DESTROYED on tick ${shieldGoneTick}`} | ` +
      `exposed to Zuk ${uncoveredTicks}/${tick} ticks ` +
      `(${Math.round((uncoveredTicks / tick) * 100)}%)`,
  );
  out(
    `${tick} ticks (~${formatDuration(tick * 600)} in-game) | wall time ${formatDuration(summary.wallMs)} | seed ${SEED}`,
  );
  // Machine-readable, one line, for zukSweep.js. Kept last so a truncated log still ends with it.
  out(`ZUK_JSON ${JSON.stringify(summary)}`);
  out("");

  if (TRACE) {
    fs.mkdirSync(path.dirname(TRACE_OUT), { recursive: true });
    fs.writeFileSync(TRACE_OUT, traceLines.join("\n") + "\n");
    out(`trace written: ${TRACE_OUT} (${traceLines.length} lines)`);
  }

  if (REPLAY) {
    // Beside the log when the sweep says where, otherwise beside the results folder so a bare
    // `npm run test:zuk` still produces one somewhere findable.
    const target =
      process.env.ZUK_REPLAY_OUT ||
      path.resolve("test/harness/zuk-results", `seed-${SEED}.replay.html`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      buildReplayHtml(SEED, replayFrames, shieldHits, setSpawns.map((record) => record.tick)),
    );
    out(`replay written: ${target} (${replayFrames.length} frames)`);
  }

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(summary, null, 2) + "\n");
  }

  // A decisive outcome is a successful harness run - a death is a finding, not a test failure. An
  // engine crash fails loudly (after the report above has printed), because it means the sim
  // broke, not the bot.
  expect(outcome).not.toBe("crashed");
  expect(["completed", "died", "ran out of prayer", "stuck"]).toContain(outcome);
});
