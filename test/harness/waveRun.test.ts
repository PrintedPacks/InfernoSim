"use strict";

/**
 * Headless seeded wave run through the REAL bot.
 *
 * This boots the same objects the browser does - InfernoRegion, World, the SDK's control
 * panel and viewport - and then drives `World.tickWorld()` in a loop. Every decision is
 * made by `InfernoAutomation.onTick`, called from `InfernoRegion.postTick` exactly as in
 * live play; nothing here re-implements or mirrors any of it. The harness only supplies
 * what the browser supplies (a DOM, a boot sequence, a tick pump) and watches public
 * region/player state to report the outcome.
 *
 * Boot follows src/index.ts step for step, minus what only exists for a human: asset
 * preloading, model warm-up, the requestAnimationFrame loop, and the extra UI listeners.
 * The one deliberate substitution is `Viewport.setupViewport(region, true)` - forcing the
 * 2D viewport - because jsdom has no WebGL. The 2D viewport is a renderer choice, not a
 * simulation choice.
 *
 * Determinism: every random draw in the stack goes through either `Random.get` (engine
 * rolls) or `Math.random` (lodash shuffles, jad stun order), and both are seeded here
 * before any world object exists. Timers are jest fake timers advanced by exactly 600ms
 * per tick, so timer-mediated input lands on a fixed schedule - same seed, same run.
 *
 * The fake timers are not optional. Inventory clicks route through
 * `InputController.queueAction`, which holds each action behind a `setTimeout(inputDelay)`
 * before the next world tick flushes it - that is how the engine models human input
 * latency. In the browser the delay elapses in the ~600ms between ticks; in a synchronous
 * pump no timeout ever fires, the queue stays empty, and every gear switch silently
 * no-ops (the bot then re-clicks the same switch forever). Advancing fake time 600ms per
 * tick reproduces the browser's schedule exactly, and deterministically.
 *
 * Configuration (environment variables):
 *   INFERNO_SEED        integer seed, default 1
 *   INFERNO_WAVE        starting wave, default 1
 *   INFERNO_AUTO_DELAY  ticks AFTER the wave goes live before automation is switched on,
 *                       default 0 (on from boot). Use ~5-10 when replaying a captured
 *                       scenario: it reproduces "stand there, let the mobs settle into
 *                       their jammed/parked positions, then flip auto" - automation's
 *                       first decision then sees the same geometry your browser dump shows,
 *                       not the raw spawn tiles
 *   INFERNO_PRAYER      override the prayer pool for the whole run, e.g. 99999999 to make
 *                       "ran out of prayer" unreachable while testing other behaviour.
 *                       Unset = the loadout's real prayer (99, or 52 for zerker/pure)
 *   INFERNO_QUERY       extra URL query params, exactly as the browser takes them - e.g.
 *                       "blob=[[7,22]]&nibblers=false" reproduces the CUSTOM wave 4 button.
 *                       NOTE: any custom mob param makes the region force wave 1, same as
 *                       in the browser.
 *   INFERNO_LOADOUT     loadout key from the sidebar select, default max_tbow_speed
 *   INFERNO_WAVE_TICK_LIMIT  ticks allowed within a single wave before "stuck", default 3000
 *   INFERNO_TICK_LIMIT  total tick budget for the run, default 200000
 *   INFERNO_TIMEOUT_MS  jest timeout (read by jest.harness.config.js), default 30 min
 */

import * as fs from "fs";
import * as path from "path";

import { EntityNames, Random, Settings, Viewport, World } from "osrs-sdk";

import { InfernoAutomation } from "../../src/content/inferno/js/InfernoAutomation";
import { InfernoRegion } from "../../src/content/inferno/js/InfernoRegion";
import { InfernoSettings } from "../../src/content/inferno/js/InfernoSettings";

const SEED = parseInt(process.env.INFERNO_SEED || "1", 10);
const START_WAVE = parseInt(process.env.INFERNO_WAVE || "1", 10);
const LOADOUT = process.env.INFERNO_LOADOUT || "max_tbow_speed";
const EXTRA_QUERY = process.env.INFERNO_QUERY || "";
const PRAYER_OVERRIDE = parseInt(process.env.INFERNO_PRAYER || "", 10);
const AUTO_DELAY_TICKS = parseInt(process.env.INFERNO_AUTO_DELAY || "0", 10);
const WAVE_TICK_LIMIT = parseInt(process.env.INFERNO_WAVE_TICK_LIMIT || "3000", 10);
const TOTAL_TICK_LIMIT = parseInt(process.env.INFERNO_TICK_LIMIT || "200000", 10);

// Must match the sidebar's <select id="loadouts"> options - an unknown value would set the
// select to "" and InfernoLoadout.getLoadout() would return nothing.
const VALID_LOADOUTS = [
  "max_tbow_speed",
  "max_tbow",
  "max_fbow",
  "budget_fbow",
  "rcb",
  "zerker",
  "pure",
  "max_melee",
];

/** Deterministic PRNG (mulberry32) - splittable enough for two independent streams. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bypass jest's console capture so the report reads as plain lines, not log noise. */
function out(line: string) {
  process.stdout.write(line + "\n");
}

/** URL query param for each mob kind the import path supports, or undefined for the rest. */
const URL_PARAM_BY_MOB: Record<string, string> = {
  [EntityNames.JAL_MEJ_RAJ]: "bat",
  [EntityNames.JAL_AK]: "blob",
  [EntityNames.JAL_IM_KOT]: "melee",
  [EntityNames.JAL_XIL]: "ranger",
  [EntityNames.JAL_ZEK]: "mager",
  [EntityNames.JAL_AK_REK_MEJ]: "akrekmej",
  [EntityNames.JAL_AK_REK_XIL]: "akrekxil",
  [EntityNames.JAL_AK_REK_KET]: "akrekket",
};

/**
 * A copyable reproduction of the arena as it stands: every live, URL-supported mob at its
 * current tile (minus the (11,14) import offset), plus the player's tile (raw). Mobs the
 * import path cannot express - nibblers, Jad, Zuk - are reported rather than dropped
 * silently. Hitpoints cannot ride the URL, so everything replays at full health.
 */
function buildReplayQuery(
  region: { mobs: unknown[] },
  player: { location: { x: number; y: number } },
): { query: string; skipped: string[] } {
  const spawns = new Map<string, number[][]>();
  const skipped: string[] = [];
  for (const mob of region.mobs as {
    mobName(): string;
    dying: number;
    location: { x: number; y: number };
  }[]) {
    if (mob.dying !== -1) {
      continue;
    }
    const param = URL_PARAM_BY_MOB[mob.mobName()];
    if (!param) {
      skipped.push(mob.mobName());
      continue;
    }
    const list = spawns.get(param) ?? [];
    list.push([mob.location.x - 11, mob.location.y - 14]);
    spawns.set(param, list);
  }
  const parts = ["wave=1"];
  // forEach, NOT for...of: with target es5 and no downlevelIteration, TypeScript compiles
  // for...of into an index-based loop that iterates a Map zero times - silently.
  spawns.forEach((list, param) => {
    parts.push(`${param}=${JSON.stringify(list)}`);
  });
  parts.push("nibblers=false", `x=${player.location.x}`, `y=${player.location.y}`);
  return { query: parts.join("&"), skipped };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

test("seeded wave run through the real InfernoAutomation.onTick", () => {
  expect(VALID_LOADOUTS).toContain(LOADOUT);
  expect(Number.isFinite(SEED)).toBe(true);
  expect(START_WAVE).toBeGreaterThanOrEqual(1);
  expect(START_WAVE).toBeLessThanOrEqual(69);

  // The sim logs per-wave and asset-preload chatter from boot onwards; keep the report to
  // our lines. console.error stays live so real failures still surface.
  const silenced = { log: console.log, info: console.info, warn: console.warn, debug: console.debug };
  console.log = console.info = console.warn = console.debug = () => undefined;

  // ---- Seed every randomness source before any world object exists. ----
  Random.setRandom(mulberry32(SEED));
  Math.random = mulberry32(SEED ^ 0x9e3779b9);

  // ---- The DOM the boot sequence expects: real index.html body + real sidebar. ----
  const indexHtml = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "public", "index.html"),
    "utf8",
  );
  const body = indexHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!body) {
    throw new Error("src/public/index.html has no <body> - harness DOM cannot be built");
  }
  document.body.innerHTML = body[1];

  // The region reads its wave number - and any custom spawns - from the URL, same as the
  // browser.
  window.history.replaceState(
    {},
    "",
    `/?wave=${START_WAVE}${EXTRA_QUERY ? `&${EXTRA_QUERY}` : ""}`,
  );

  // ---- Settings, then harness-required overrides. ----
  Settings.readFromStorage();
  InfernoSettings.readFromStorage();
  Settings.use3dView = false; // no WebGL headless; also the storage default is ON
  Settings.metronome = false;
  Settings.loadout = LOADOUT;
  InfernoSettings.waveProgression = true; // the whole point: advance wave to wave
  InfernoSettings.spawnIndicators = false;
  InfernoSettings.displaySetTimer = false;

  // ---- Boot, mirroring src/index.ts. ----
  const region = new InfernoRegion();
  const world = new World();
  world.getReadyTimer = 6;
  region.world = world;
  world.addRegion(region);

  document.getElementById("sidebar_content")!.innerHTML = region.getSidebarContent();

  const { player } = region.initialiseRegion();

  Viewport.setupViewport(region, true); // force 2D: jsdom has no WebGL
  Viewport.viewport.setPlayer(player); // also wires Trainer.player, which the panels click on

  player.perceivedLocation = player.location;
  player.destinationLocation = player.location;

  // Testing aid, not simulation: a run that would die of prayer drain can be given a pool
  // deep enough that the "ran out of prayer" ending is unreachable, so the behaviour past
  // that point is observable. The drain itself still happens - the pool is just bigger.
  if (!isNaN(PRAYER_OVERRIDE)) {
    player.stats.prayer = PRAYER_OVERRIDE;
    player.currentStats.prayer = PRAYER_OVERRIDE;
  }

  // Custom mob params force the region to wave 1 (browser behaviour), so only hold the
  // region to the requested wave on a plain run.
  if (!EXTRA_QUERY) {
    expect(region.wave).toBe(START_WAVE);
  }
  // Fresh spawns land in newMobs and are merged into mobs by the first tickWorld.
  expect(region.mobs.length + region.newMobs.length).toBeGreaterThan(0);

  // With a delay, automation starts later - inside the tick loop - the way a person stands
  // watching the wave settle before flipping the switch. Everything else about the boot is
  // identical either way.
  if (AUTO_DELAY_TICKS <= 0) {
    InfernoAutomation.setEnabled(true);
  }

  // ---- Tick pump + reporting. ----
  const aliveMobs = () => region.mobs.filter((mob) => mob.dying === -1).length;
  const hp = () => `hp ${player.currentStats.hitpoint}/${player.stats.hitpoint}`;
  const prayer = () => `prayer ${player.currentStats.prayer}/${player.stats.prayer}`;
  // Run energy is 0-10000 in the engine; shown as percent. The engine sets `running` to false
  // the moment energy hits 0 and nothing turns it back on, so the flag is the interesting bit.
  const run = () =>
    `run ${Math.round(((player.currentStats as { run?: number }).run ?? 0) / 100)}% ` +
    `${(player as unknown as { running?: boolean }).running ? "ON" : "OFF"}`;

  out("");
  out(
    `inferno harness | seed ${SEED} | loadout ${LOADOUT} | starting wave ${region.wave} | ` +
      `wave tick limit ${WAVE_TICK_LIMIT}` +
      (AUTO_DELAY_TICKS > 0 ? ` | auto delayed ${AUTO_DELAY_TICKS} ticks past wave-live` : "") +
      (!isNaN(PRAYER_OVERRIDE) ? ` | prayer override ${PRAYER_OVERRIDE}` : "") +
      (EXTRA_QUERY ? ` | custom: ${EXTRA_QUERY}` : ""),
  );

  // Legacy fake timers on purpose: they fake setTimeout/setInterval (all the engine uses)
  // without freezing Date, so the wall-time figure below stays honest.
  jest.useFakeTimers("legacy");

  let outcome = "";
  let detail = "";
  let botLogAtStop = "";
  let tick = 0;
  let lastWave = region.wave;
  let waveStartTick = 0;
  let wavesCleared = 0;
  let zukWaveHadMobs = false;
  const startedAt = Date.now();

  try {
    let liveTicks = 0;
    while (tick < TOTAL_TICK_LIMIT) {
      tick++;
      // Exactly what World.browserLoop does around tickWorld - the countdown is decremented
      // by the render loop in the browser, so the pump has to own it here.
      if (world.getReadyTimer > 0) {
        world.getReadyTimer--;
      }
      // Delayed automation start: count ticks the wave has been live, flip the switch once
      // the requested settling time has passed - the mobs have walked, parked, and jammed
      // exactly as they had when a person flips it on by hand.
      if (AUTO_DELAY_TICKS > 0 && !InfernoAutomation.isEnabled()) {
        if (world.getReadyTimer === 0 && ++liveTicks > AUTO_DELAY_TICKS) {
          InfernoAutomation.setEnabled(true);
        }
      }
      // An engine throw is a finding about the sim, not a harness failure - capture it with
      // the same arena dump as any other bad ending, then fail the test explicitly below.
      try {
        world.tickWorld();
      } catch (e) {
        outcome = "crashed";
        detail =
          `engine threw on tick ${tick} (wave ${region.wave}): ${(e as Error)?.message ?? e}\n` +
          ((e as Error)?.stack?.split("\n").slice(1, 5).join("\n") ?? "");
        break;
      }
      // The 600ms between ticks, during which queued input (gear switches, walk clicks)
      // matures - see the header comment on fake timers.
      jest.advanceTimersByTime(600);

      // Death first: a dying player is removed from region.players by the engine.
      if (region.players.length === 0 || player.isDying()) {
        outcome = "died";
        detail = `died on wave ${region.wave} after ${tick - waveStartTick} ticks of the wave`;
        break;
      }

      // Out of prayer is terminal for a bot that never drinks a restore: overheads drop and
      // the wave is lost from that point, so report it as its own outcome rather than
      // letting it show up later as an unexplained death.
      if (player.currentStats.prayer <= 0) {
        outcome = "ran out of prayer";
        detail = `prayer hit 0 on wave ${region.wave} after ${tick - waveStartTick} ticks of the wave (${hp()})`;
        break;
      }

      // Wave progression increments region.wave when the next wave spawns; the increment IS
      // the durable "previous wave cleared" signal (the 9-tick countdown can be cancelled by
      // late bloblets, so the timer alone is not).
      if (region.wave !== lastWave) {
        wavesCleared += region.wave - lastWave;
        out(
          `wave ${String(lastWave).padStart(2)} cleared | ` +
            `${String(tick - waveStartTick).padStart(4)} ticks | ${hp()} | ${prayer()} | ${run()}`,
        );
        lastWave = region.wave;
        waveStartTick = tick;
      }

      // Wave 69 has no successor, so completion is "Zuk existed and now nothing is alive and
      // no countdown is pending" - the same state the region itself treats as the end.
      if (region.wave === 69) {
        if (aliveMobs() > 0) {
          zukWaveHadMobs = true;
        } else if (zukWaveHadMobs && region.ticksUntilNextWave === -1) {
          outcome = "completed";
          detail = `wave 69 cleared | ${String(tick - waveStartTick).padStart(4)} ticks | ${hp()} | ${prayer()} | ${run()}`;
          wavesCleared++;
          break;
        }
      }

      if (tick - waveStartTick > WAVE_TICK_LIMIT) {
        outcome = "stuck";
        detail =
          `no wave transition for ${WAVE_TICK_LIMIT} ticks on wave ${region.wave} ` +
          `(${aliveMobs()} mobs alive, ${hp()}, ${prayer()}, ${run()})`;
        break;
      }
    }
  } finally {
    console.log = silenced.log;
    console.info = silenced.info;
    console.warn = silenced.warn;
    console.debug = silenced.debug;
    // Read before disabling - setEnabled(false) clears the automation's rolling log.
    botLogAtStop = InfernoAutomation.getLog();
    InfernoAutomation.setEnabled(false);
    jest.useRealTimers();
  }

  if (!outcome) {
    outcome = "stuck";
    detail = `run hit the total tick budget (${TOTAL_TICK_LIMIT}) on wave ${region.wave}`;
  }
  if (outcome === "completed") {
    out(detail);
  } else {
    // The stop-state snapshot: where everyone was when the run ended. For a stuck run this
    // is usually the whole answer - an unreachable mob, or the bot parked somewhere wrong.
    out("");
    out(`arena when the run ended (tick ${tick}, wave ${region.wave}):`);
    out(
      `  player     @${player.location.x},${player.location.y} | ${hp()} | ${prayer()} | ${run()}`,
    );
    for (const mob of region.mobs as any[]) {
      const flags = [
        mob.dying !== -1 ? "dying" : "",
        (mob.frozen ?? 0) > 0 ? `frozen ${mob.frozen}` : "",
        mob.aggro === player ? "aggro=player" : "",
      ]
        .filter(Boolean)
        .join(", ");
      out(
        `  ${mob.mobName().padEnd(10)} @${mob.location.x},${mob.location.y} | ` +
          `hp ${mob.currentStats?.hitpoint ?? "?"} | size ${mob.size}${flags ? ` | ${flags}` : ""}`,
      );
    }
    // The bot's own rolling tick log - what it believed it was doing at the end.
    const botLog = botLogAtStop.split("\n").slice(-15);
    if (botLog.length > 0 && botLog[0] !== "") {
      out("last automation ticks:");
      for (const line of botLog) {
        out(`  ${line}`);
      }
    }

    // A copy-paste reproduction of this exact arena, in both flavours. Full health and the
    // settling caveat apply - pair the headless one with INFERNO_AUTO_DELAY to let the mobs
    // walk into their captured shapes before automation wakes.
    const replay = buildReplayQuery(region, player);
    out("replay this arena:");
    out(`  http://localhost:8000/?${replay.query}`);
    out(`  $env:INFERNO_QUERY='${replay.query.replace(/^wave=1&/, "")}'`);
    if (replay.skipped.length > 0) {
      out(`  (not expressible in the URL, so missing from the replay: ${replay.skipped.join(", ")})`);
    }

    // And the wave as it originally SPAWNED - player at home, mobs on their spawn tiles,
    // nibblers included. The region maintains this itself: spawnRegularWave writes the
    // replay link with the wave number and exact spawn points each time a wave spawns; the
    // x/y (where the player stood at spawn) are stripped so the replay starts from the home
    // tile like a fresh wave. Special waves (67+) never update the link, hence the guard.
    const waveStartHref =
      document.getElementById("replayLink")?.getAttribute("href") ?? "";
    const linkWave = parseInt(waveStartHref.match(/[?&]wave=(\d+)/)?.[1] ?? "", 10);
    if (linkWave === region.wave) {
      const startQuery = waveStartHref
        .replace(/^\/\?/, "")
        .replace(/&x=-?\d+&y=-?\d+/, "");
      out(`wave ${region.wave} as it spawned (player at home):`);
      out(`  http://localhost:8000/?${startQuery}`);
      out(
        `  $env:INFERNO_WAVE="${region.wave}"; $env:INFERNO_QUERY='${startQuery.replace(/^wave=\d+&/, "")}'`,
      );
    }
  }

  const inGame = formatDuration(tick * 600);
  const wall = formatDuration(Date.now() - startedAt);
  out("----------------------------------------------------------------");
  out(`RESULT: ${outcome}${outcome === "completed" ? "" : ` - ${detail}`}`);
  out(
    `reached wave ${region.wave} (started at ${START_WAVE}), cleared ${wavesCleared} wave${wavesCleared === 1 ? "" : "s"}`,
  );
  out(`${tick} ticks (~${inGame} in-game) | wall time ${wall} | seed ${SEED}`);
  out("");

  // A decisive outcome is a successful harness run - a death is a finding, not a test
  // failure. An engine crash fails loudly (after the report above has printed), because it
  // means the sim broke, not the bot.
  expect(outcome).not.toBe("crashed");
  expect(["completed", "died", "ran out of prayer", "stuck"]).toContain(outcome);
});
