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
 *   ZUK_WAVE         wave to start on, default 69. 67 or 68 arrive at Zuk having actually
 *                    spent supplies on the Jads, at a few times the wall cost
 *   ZUK_SHIELD       random (default) | west | east - which way the shield sets off
 *   ZUK_TICK_LIMIT   tick budget for the run, default 4000 (~40 minutes in game)
 *   ZUK_JSON_OUT     write the machine-readable summary to this file as well as stdout
 *   INFERNO_TIMEOUT_MS  jest timeout (read by the jest config), default 30 min
 */

import * as fs from "fs";
import * as path from "path";

import { EntityNames, ItemName } from "osrs-sdk";

import { InfernoAutomation } from "../../src/content/inferno/js/InfernoAutomation";
import type { ShieldDirection } from "../../src/content/inferno/js/ZukShield";
import { bootHarness, out, restoreConsole, silenceConsole } from "./bootHarness";

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

const SEED = parseInt(process.env.INFERNO_SEED || "1", 10);
const LOADOUT = process.env.INFERNO_LOADOUT || "max_tbow_speed";
const START_WAVE = parseInt(process.env.ZUK_WAVE || "69", 10);
const SHIELD = (process.env.ZUK_SHIELD || "random") as ShieldDirection;
const PRAYER_OVERRIDE = parseInt(process.env.INFERNO_PRAYER || String(DEFAULT_PRAYER), 10);
const TICK_LIMIT = parseInt(process.env.ZUK_TICK_LIMIT || "4000", 10);
const JSON_OUT = process.env.ZUK_JSON_OUT || "";

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
  const spawnCounts: Record<string, number> = {};
  let maxPhase: Phase = "opening";
  let phase: Phase = "opening";
  const phaseFirstTick: Partial<Record<Phase, number>> = { opening: 0 };
  let zukMinHp = Number.MAX_SAFE_INTEGER;
  let zukHealed = 0;
  let shieldSeen = false;
  let shieldGoneTick: number | null = null;
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
  let zukWaveHadMobs = false;
  let tracked = new Set<unknown>();
  const startedAt = Date.now();

  const note = (text: string) => events.push({ tick, text });

  out("");
  out(
    `zuk harness | seed ${SEED} | loadout ${LOADOUT} | wave ${START_WAVE} | shield ${SHIELD} | ` +
      `tick limit ${TICK_LIMIT} | prayer pool ${PRAYER_OVERRIDE}` +
      (PRAYER_OVERRIDE === DEFAULT_PRAYER ? " (default - drain cannot end a run)" : ""),
  );

  // Legacy fake timers on purpose: they fake setTimeout/setInterval (all the engine uses) without
  // freezing Date, so the wall-time figure below stays honest. Inventory clicks route through
  // InputController's setTimeout(inputDelay), so without this every gear switch silently no-ops.
  jest.useFakeTimers("legacy");
  InfernoAutomation.setEnabled(true);

  try {
    while (tick < TICK_LIMIT) {
      tick++;
      // Exactly what World.browserLoop does around tickWorld - the countdown is decremented by
      // the render loop in the browser, so the pump has to own it here.
      if (world.getReadyTimer > 0) {
        world.getReadyTimer--;
      }

      const hpBefore = hp();
      const zukBefore = (findLive(EntityNames.TZ_KAL_ZUK) as { currentStats?: { hitpoint: number } } | null)
        ?.currentStats?.hitpoint;

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
      } else if (shieldSeen && shieldGoneTick === null) {
        shieldGoneTick = tick;
        note("Zuk's shield destroyed - no cover left");
      }
      /** Where the player stands relative to cover, with "there is no cover" folded in. */
      const cover = () =>
        !shieldNow ? "NO SHIELD" : covered() ? "covered" : "EXPOSED";

      // ---- Damage attribution. A projectile sits in the player's incoming list for its whole
      // flight and is removed the tick it resolves, so the set that disappeared between the last
      // snapshot and this one is exactly what landed this tick. ----
      const inFlight = new Set<unknown>(anyPlayer.incomingProjectiles);
      const landed: Landed[] = [];
      tracked.forEach((projectile) => {
        if (inFlight.has(projectile)) {
          return;
        }
        const shot = projectile as { damage?: number; attackStyle?: string };
        if ((shot.damage ?? 0) > 0) {
          landed.push({
            from: sourceOf(projectile as { from?: unknown }),
            damage: shot.damage ?? 0,
            style: shot.attackStyle ?? "?",
          });
        }
      });
      tracked = inFlight;

      for (const hit of landed) {
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
      const delta = hp() - hpBefore;
      const landedTotal = landed.reduce((sum, hit) => sum + hit.damage, 0);
      if (delta + landedTotal > 0) {
        healed += delta + landedTotal;
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

      // ---- OFF-TICK WATCH. Only one overhead can be up, so two tagged attackers sharing a fire
      // tick matters ONLY when they need different prayers: same-style mobs are covered by one
      // prayer and cost nothing (measured - three magers stacked on one residue did zero damage,
      // while one ranger sharing a mager's tick did all 74 points of mob damage). Restricted to
      // attackSpeed 4, the shared cycle: Zuk is speed 14 (7 enraged) and has no stable mod-4
      // residue, so counting it here reported collisions that did not exist. ----
      const tagged = liveMobs().filter((mob) => mob.aggro === player && mob.attackSpeed === 4);
      const byResidue = new Map<number, { name: string; style: string }[]>();
      for (const mob of tagged) {
        const residue = (((tick + (mob.attackDelay ?? 0)) % 4) + 4) % 4;
        let style = "?";
        try {
          style = mob.attackStyleForNewAttack?.() ?? "?";
        } catch (e) {
          // A style that cannot be read yet is not one that can be prayed against either.
        }
        const list = byResidue.get(residue) ?? [];
        list.push({ name: mob.mobName(), style });
        byResidue.set(residue, list);
      }
      byResidue.forEach((members, residue) => {
        if (members.length < 2) {
          return;
        }
        const styles = members.map((m) => m.style).filter((v, i, a) => a.indexOf(v) === i);
        const names = members.map((m) => m.name).sort().join("+");
        const key = residue + ":" + names;
        if (collisionsSeen.has(key)) {
          return;
        }
        collisionsSeen.add(key);
        if (styles.length > 1) {
          crossStyleCollisions++;
          note(
            "CROSS-STYLE COLLISION on residue " + residue + ": " +
              members.map((m) => m.name + "(" + m.style + ")").join(" + ") +
              " - one of these is unblockable",
          );
        } else {
          sameStyleCollisions++;
          note(
            "same-style collision on residue " + residue + ": " +
              members.map((m) => m.name).join(" + ") +
              " (" + styles[0] + ") - one prayer covers all, free",
          );
        }
      });
      maxTagged = Math.max(maxTagged, tagged.length);

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

      // ---- Endings. Death first: a dying player is removed from region.players by the engine.
      if ((region as unknown as { players: unknown[] }).players.length === 0 || anyPlayer.isDying()) {
        outcome = "died";
        killers = landed;
        const blame = landed.length
          ? landed.map((hit) => `${hit.from} for ${hit.damage}`).join(" + ")
          : "no projectile resolved on the death tick";
        cause = `killed by ${blame} at hp ${hpBefore} during ${phase}`;
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
          cause = `Zuk down in ${tick} ticks with ${hp()} hp left`;
          break;
        }
      }
    }
  } finally {
    // Read before disabling - setEnabled(false) clears the automation's rolling log.
    botLogAtStop = InfernoAutomation.getLog();
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
    const botLog = botLogAtStop.split("\n").slice(-12);
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
    overhead: overhead(),
    damageTaken,
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
    `player hp ${hp()} (lowest ${lowestHp}) | took ${damageTaken}, healed ${healed} | ` +
      `brew doses ${endingSupplies.brews}/${startingSupplies.brews}, ` +
      `restore doses ${endingSupplies.restores}/${startingSupplies.restores}`,
  );
  out(
    `off-tick: ${crossStyleCollisions} CROSS-STYLE collision${crossStyleCollisions === 1 ? "" : "s"} (these cost hp) | ` +
      `${sameStyleCollisions} same-style (free) | peak ${maxTagged} tagged speed-4 attackers`,
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
