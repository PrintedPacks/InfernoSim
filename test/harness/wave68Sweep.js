"use strict";

/**
 * Wave 68 sweep: run the triple-Jad harness across many seeds IN PARALLEL and explain how each
 * one ended.
 *
 * Each seed is an independent single-core process, so the sweep runs one per core and the wall
 * time divides by the machine. Every seed's full report is kept on disk, so any interesting seed
 * can be read or re-run in detail afterwards.
 *
 * Usage:
 *   npm run test:wave68-sweep                        50 seeds (1..50), cores-1 in parallel
 *   W68_SEEDS=20 npm run test:wave68-sweep           seeds 1..20
 *   W68_SEED_START=100 npm run test:wave68-sweep     seeds 100..149
 *   W68_SEED_LIST=38 npm run test:wave68-sweep       just seed 38
 *   W68_SEED_LIST=11,38,73 npm run test:wave68-sweep only those three, in that order
 *   W68_PARALLEL=4 npm run test:wave68-sweep         cap concurrent runs at 4
 *
 * W68_SEED_LIST wins over the range when both are set. It is the one to reach for when a specific
 * seed has misbehaved: the report is identical to a full sweep's, so every per-seed section - the
 * per-Jad ledger, the healer tag latencies, the unprayed hits - is there for the one run.
 *
 * Every INFERNO_ and W68_ environment variable passes straight through to every run, so the
 * harness's own knobs work unchanged. The loadout defaults to `pure_rcb` - the wave-68 harness's
 * own default - so sweeping max gear instead is:
 *   INFERNO_LOADOUT=max_tbow_speed npm run test:wave68-sweep
 * (in PowerShell: $env:INFERNO_LOADOUT="max_tbow_speed"; then npm run test:wave68-sweep)
 *
 * Per-seed logs land in test/harness/wave68-results/<timestamp>/seed-N.log, alongside results.json
 * (every seed's full summary object) and summary.txt (the tables printed at the end).
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SEED_COUNT = parseInt(process.env.W68_SEEDS ?? "50", 10);
const SEED_START = parseInt(process.env.W68_SEED_START ?? "1", 10);
const PARALLEL = Math.max(1, parseInt(process.env.W68_PARALLEL ?? "", 10) || os.cpus().length - 1);

const ROOT = path.resolve(__dirname, "..", "..");
const JEST = path.join(ROOT, "node_modules", "jest", "bin", "jest.js");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = path.join(__dirname, "wave68-results", STAMP);
fs.mkdirSync(OUT_DIR, { recursive: true });

/** An explicit list beats the range - see the usage note above. Junk entries are dropped. */
const SEED_LIST = (process.env.W68_SEED_LIST ?? "")
  .split(",")
  .map((entry) => parseInt(entry.trim(), 10))
  .filter((seed) => Number.isFinite(seed));
const seeds =
  SEED_LIST.length > 0
    ? SEED_LIST
    : Array.from({ length: SEED_COUNT }, (_, i) => SEED_START + i);
const results = [];
let nextIndex = 0;
const startedAt = Date.now();

console.log(
  `wave 68 sweep | seeds ${
    SEED_LIST.length > 0 ? seeds.join(",") : `${SEED_START}..${SEED_START + SEED_COUNT - 1}`
  } | ` +
    `loadout ${process.env.INFERNO_LOADOUT ?? "pure_rcb"} | wave ${process.env.W68_WAVE ?? 68} | ` +
    `prayer ${process.env.INFERNO_PRAYER ?? 99999} | ` +
    `${PARALLEL} in parallel | logs in ${path.relative(ROOT, OUT_DIR)}`,
);

/**
 * Pull the run's own summary object back out of its output.
 *
 * The harness prints it as a single `W68_JSON {...}` line precisely so this does not have to
 * regex a human-readable report. A run that died before printing one gets a placeholder rather
 * than being dropped, so a broken seed is visible in the table instead of missing from it.
 */
function parseOutput(text, seed) {
  const line = /^W68_JSON (.*)$/m.exec(text);
  if (line) {
    try {
      return JSON.parse(line[1]);
    } catch (e) {
      // fall through to the placeholder
    }
  }
  return {
    seed,
    outcome: "no-result",
    cause: "no W68_JSON line - read the log",
    phase: "?",
    ticks: 0,
  };
}

function runSeed(seed) {
  return new Promise((resolve) => {
    const logPath = path.join(OUT_DIR, `seed-${seed}.log`);
    const log = fs.createWriteStream(logPath);
    const child = spawn(process.execPath, [JEST, "--config", "jest.wave68.config.js"], {
      cwd: ROOT,
      // The trace lands beside the log rather than wherever the run happens to be started from.
      // W68_JSON_OUT is deliberately NOT used - the sweep reads the summary off stdout and never
      // sets it, so anything gated on it never fires.
      env: {
        ...process.env,
        INFERNO_SEED: String(seed),
        W68_TRACE_OUT: process.env.W68_TRACE
          ? path.join(OUT_DIR, `seed-${seed}.trace.log`)
          : "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let captured = "";
    const capture = (chunk) => {
      captured += chunk;
      log.write(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    child.on("close", (code) => {
      log.end();
      const entry = { exitCode: code, ...parseOutput(captured, seed) };
      results.push(entry);
      console.log(
        `seed ${String(seed).padStart(4)} | ${String(entry.outcome).padEnd(16)} | ` +
          `${String(entry.phase).padEnd(8)} | ${String(entry.ticks).padStart(4)}t | ` +
          `jads ${String(entry.jadsKilled ?? "-")}/${String(entry.jadsSpawned ?? "-")} | ` +
          `unprayed ${String(entry.unprayedFires ?? "-").padStart(3)} | ` +
          `${results.length}/${seeds.length} done`,
      );
      resolve(entry);
    });
  });
}

async function worker() {
  while (nextIndex < seeds.length) {
    await runSeed(seeds[nextIndex++]);
  }
}

/** Count occurrences of a key across the results, returned biggest-first. */
function tally(entries, keyOf) {
  const counts = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === null || key === undefined) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? []).concat(entry.seed));
  }
  return [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
}

function stats(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: Math.round(mean),
    max: sorted[sorted.length - 1],
  };
}

Promise.all(Array.from({ length: Math.min(PARALLEL, seeds.length) }, worker)).then(() => {
  results.sort((a, b) => a.seed - b.seed);

  const lines = [];
  const put = (line) => {
    lines.push(line);
    console.log(line);
  };

  const completed = results.filter((r) => r.outcome === "completed");
  const died = results.filter((r) => r.outcome === "died");
  const prayer = results.filter((r) => r.outcome === "ran out of prayer");
  const stuck = results.filter((r) => r.outcome === "stuck");
  const broken = results.filter((r) => r.outcome === "no-result");
  const failed = [...died, ...prayer, ...stuck];

  put("");
  put("================ WAVE 68 SWEEP SUMMARY ================");
  // Every figure on this line is a COUNT OF RUNS. The prayer bucket is only printed when it is
  // non-zero, because "0 out of prayer" beside a run that has 99999 prayer reads as a prayer
  // LEVEL rather than a tally, and a headline nobody can parse at a glance is worse than absent.
  put(
    `${results.length} runs | ${completed.length} completed ` +
      `(${Math.round((completed.length / results.length) * 100)}%) | ${died.length} died | ` +
      `${stuck.length} stuck` +
      (prayer.length ? ` | ${prayer.length} ended on 0 prayer` : "") +
      (broken.length ? ` | ${broken.length} BROKEN` : ""),
  );

  const kills = stats(completed.map((r) => r.clearedTick ?? r.ticks));
  if (kills) {
    put(
      `clear time (ticks): min ${kills.min} | median ${kills.median} | mean ${kills.mean} | max ${kills.max}`,
    );
    const left = stats(completed.map((r) => r.hp));
    put(`hp left on a clear: min ${left.min} | median ${left.median} | max ${left.max}`);
  }

  put("");
  put("how far each seed got (jads left standing):");
  for (const [phase, seedList] of tally(results, (r) => r.phase)) {
    put(
      `  ${String(phase).padEnd(10)} x${String(seedList.length).padStart(3)}  [${seedList.join(", ")}]`,
    );
  }

  if (failed.length > 0) {
    put("");
    put("why the failures ended, by phase:");
    for (const [key, seedList] of tally(failed, (r) => `${r.outcome} in ${r.phase}`)) {
      put(
        `  ${key.padEnd(26)} x${String(seedList.length).padStart(3)}  [${seedList.join(", ")}]`,
      );
    }
    put("");
    put("killing blow, by mob:");
    for (const [key, seedList] of tally(died, (r) => r.killedBy ?? "unattributed")) {
      put(
        `  ${String(key).padEnd(26)} x${String(seedList.length).padStart(3)}  [${seedList.join(", ")}]`,
      );
    }
  }

  // Where the damage came from across the whole sweep - the thing a single seed cannot tell you.
  const totals = new Map();
  let grandTotal = 0;
  for (const entry of results) {
    for (const [source, amount] of Object.entries(entry.damageBySource ?? {})) {
      totals.set(source, (totals.get(source) ?? 0) + amount);
      grandTotal += amount;
    }
  }
  if (grandTotal > 0) {
    put("");
    put("damage taken across the sweep, by source:");
    for (const [source, amount] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
      put(
        `  ${source.padEnd(16)} ${String(amount).padStart(7)}  ${String(Math.round((amount / grandTotal) * 100)).padStart(3)}%`,
      );
    }
  }

  // THE PRAYER VERDICT, and the reason the two numbers are never added together. An unprayed hit
  // is a bot failure - the overhead was wrong when a fireball resolved and nothing stopped it
  // being right. A cross-style overlap is arithmetic: two Jads resolving different styles on one
  // tick cannot both be prayed by anyone. A sweep with zero unprayed hits and heavy Jad damage
  // means the flicking is correct and the overlaps are the cost of the wave.
  const unprayedTotal = results.reduce((sum, r) => sum + (r.unprayedFires ?? 0), 0);
  const overlapTotal = results.reduce((sum, r) => sum + (r.crossStyleCollisions ?? 0), 0);
  // The denominator, printed beside the failures on purpose: a Jad whose aggro has been pulled
  // onto a healer still fires and still animates, but that attack was never ours to pray. Zero
  // unprayed out of zero demands is an empty measurement, not a clean sweep.
  const demandTotal = results.reduce((sum, r) => sum + (r.jadFiresAtPlayer ?? 0), 0);
  const withUnprayed = results.filter((r) => (r.unprayedFires ?? 0) > 0);
  put("");
  put(
    `prayer: ${unprayedTotal} unprayed of ${demandTotal} jad hits aimed at us, across ` +
      `${withUnprayed.length}/${results.length} runs` +
      (withUnprayed.length ? ` [${withUnprayed.map((r) => r.seed).join(", ")}]` : "") +
      ` | ${overlapTotal} cross-style overlap ticks (unblockable)`,
  );

  // THE TAG-AND-TURN'S SCOREBOARD. A healer that is never tagged heals its Jad for the whole
  // fight, so "never tagged" and "hp given back" are the two halves of the same failure and the
  // per-seed table below is where a bad one is identified.
  const healersTotal = results.reduce((sum, r) => sum + (r.healersSpawned ?? 0), 0);
  const untaggedTotal = results.reduce((sum, r) => sum + (r.healersNeverTagged ?? 0), 0);
  const givenBack = results.reduce((sum, r) => sum + (r.healingGivenBack ?? 0), 0);
  const beforeTag = results.reduce((sum, r) => sum + (r.healingBeforeTag ?? 0), 0);
  put(
    `healers: ${healersTotal} spawned | ${untaggedTotal} never tagged | ` +
      `${givenBack} hp given back (${beforeTag} of it before the tag)`,
  );

  put("");
  put("per seed:");
  put(
    "  seed | outcome         | phase    | ticks | jads | heal-back | untagged | unprayed | ovlp | hp  | why",
  );
  for (const r of results) {
    put(
      `  ${String(r.seed).padStart(4)} | ${String(r.outcome).padEnd(15)} | ` +
        `${String(r.phase).padEnd(8)} | ${String(r.ticks).padStart(5)} | ` +
        `${String(r.jadsKilled ?? "-")}/${String(r.jadsSpawned ?? "-")}  | ` +
        `${String(r.jadHealedBack ?? "-").padStart(9)} | ` +
        `${String(r.healersNeverTagged ?? "-").padStart(8)} | ` +
        `${String(r.unprayedFires ?? "-").padStart(8)} | ` +
        `${String(r.crossStyleCollisions ?? "-").padStart(4)} | ` +
        `${String(r.hp ?? "-").padStart(3)} | ${r.cause ?? ""}`,
    );
  }

  put("");
  put(`total wall time: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  put(`logs: ${path.relative(ROOT, OUT_DIR)}`);

  fs.writeFileSync(path.join(OUT_DIR, "summary.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2) + "\n");
  process.exitCode = broken.length > 0 ? 1 : 0;
});
