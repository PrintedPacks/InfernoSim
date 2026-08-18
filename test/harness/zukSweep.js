"use strict";

/**
 * Zuk sweep: run the Zuk harness across many seeds IN PARALLEL and explain how each one ended.
 *
 * Each seed is an independent single-core process, so the sweep runs one per core and the wall
 * time divides by the machine. Every seed's full report is kept on disk, so any interesting seed
 * can be read or re-run in detail afterwards.
 *
 * Usage:
 *   npm run test:zuk-sweep                        50 seeds (1..50), cores-1 in parallel
 *   ZUK_SEEDS=20 npm run test:zuk-sweep           seeds 1..20
 *   ZUK_SEED_START=100 npm run test:zuk-sweep     seeds 100..149
 *   ZUK_PARALLEL=4 npm run test:zuk-sweep         cap concurrent runs at 4
 *
 * Every INFERNO_ and ZUK_ environment variable passes straight through to every run, so the
 * harness's own knobs work unchanged - e.g. sweeping the crossbow loadout:
 *   INFERNO_LOADOUT=max_rcb_speed npm run test:zuk-sweep
 * (in PowerShell: $env:INFERNO_LOADOUT="max_rcb_speed"; then npm run test:zuk-sweep)
 *
 * Per-seed logs land in test/harness/zuk-results/<timestamp>/seed-N.log, alongside results.json
 * (every seed's full summary object) and summary.txt (the tables printed at the end).
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SEED_COUNT = parseInt(process.env.ZUK_SEEDS ?? "50", 10);
const SEED_START = parseInt(process.env.ZUK_SEED_START ?? "1", 10);
const PARALLEL = Math.max(
  1,
  parseInt(process.env.ZUK_PARALLEL ?? "", 10) || os.cpus().length - 1,
);

const ROOT = path.resolve(__dirname, "..", "..");
const JEST = path.join(ROOT, "node_modules", "jest", "bin", "jest.js");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = path.join(__dirname, "zuk-results", STAMP);
fs.mkdirSync(OUT_DIR, { recursive: true });

const seeds = Array.from({ length: SEED_COUNT }, (_, i) => SEED_START + i);
const results = [];
let nextIndex = 0;
const startedAt = Date.now();

console.log(
  `zuk sweep | seeds ${SEED_START}..${SEED_START + SEED_COUNT - 1} | ` +
    `loadout ${process.env.INFERNO_LOADOUT ?? "max_tbow_speed"} | wave ${process.env.ZUK_WAVE ?? 69} | ` +
    `prayer ${process.env.INFERNO_PRAYER ?? 99999} | ` +
    `${PARALLEL} in parallel | logs in ${path.relative(ROOT, OUT_DIR)}`,
);

/**
 * Pull the run's own summary object back out of its output.
 *
 * The harness prints it as a single `ZUK_JSON {...}` line precisely so this does not have to
 * regex a human-readable report. A run that died before printing one gets a placeholder rather
 * than being dropped, so a broken seed is visible in the table instead of missing from it.
 */
function parseOutput(text, seed) {
  const line = /^ZUK_JSON (.*)$/m.exec(text);
  if (line) {
    try {
      return JSON.parse(line[1]);
    } catch (e) {
      // fall through to the placeholder
    }
  }
  return { seed, outcome: "no-result", cause: "no ZUK_JSON line - read the log", phase: "?", ticks: 0 };
}

function runSeed(seed) {
  return new Promise((resolve) => {
    const logPath = path.join(OUT_DIR, `seed-${seed}.log`);
    const log = fs.createWriteStream(logPath);
    const child = spawn(process.execPath, [JEST, "--config", "jest.zuk.config.js"], {
      cwd: ROOT,
      env: { ...process.env, INFERNO_SEED: String(seed) },
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
          `zuk ${String(entry.zukHp ?? "-").padStart(4)} | ${results.length}/${seeds.length} done`,
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
  put("================ ZUK SWEEP SUMMARY ================");
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

  const kills = stats(completed.map((r) => r.ticks));
  if (kills) {
    put(
      `kill time (ticks): min ${kills.min} | median ${kills.median} | mean ${kills.mean} | max ${kills.max}`,
    );
    const left = stats(completed.map((r) => r.hp));
    put(`hp left on a kill: min ${left.min} | median ${left.median} | max ${left.max}`);
  }

  put("");
  put("how far each seed got (phase reached):");
  for (const [phase, seedList] of tally(results, (r) => r.phase)) {
    put(`  ${String(phase).padEnd(10)} x${String(seedList.length).padStart(3)}  [${seedList.join(", ")}]`);
  }

  if (failed.length > 0) {
    put("");
    put("why the failures ended, by phase:");
    for (const [key, seedList] of tally(failed, (r) => `${r.outcome} in ${r.phase}`)) {
      put(`  ${key.padEnd(26)} x${String(seedList.length).padStart(3)}  [${seedList.join(", ")}]`);
    }
    put("");
    put("killing blow, by mob:");
    for (const [key, seedList] of tally(died, (r) => r.killedBy ?? "unattributed")) {
      put(`  ${String(key).padEnd(26)} x${String(seedList.length).padStart(3)}  [${seedList.join(", ")}]`);
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

  // The off-tick verdict across the sweep. A run with zero collisions that still ate mager or
  // ranger damage means the flick itself is wrong, not the tagging - the two are separable here.
  const withCollisions = results.filter((r) => (r.crossStyleCollisions ?? 0) > 0);
  const sameStyleTotal = results.reduce((n, r) => n + (r.sameStyleCollisions ?? 0), 0);
  put("");
  put(
    `off-tick: ${withCollisions.length}/${results.length} runs formed a CROSS-STYLE collision` +
      (withCollisions.length ? ` [${withCollisions.map((r) => r.seed).join(", ")}]` : "") +
      ` | ${sameStyleTotal} same-style collisions across the sweep (free)`,
  );

  put("");
  put("per seed:");
  put("  seed | outcome         | phase    | ticks | zuk  | hp  | why");
  for (const r of results) {
    put(
      `  ${String(r.seed).padStart(4)} | ${String(r.outcome).padEnd(15)} | ` +
        `${String(r.phase).padEnd(8)} | ${String(r.ticks).padStart(5)} | ` +
        `${String(r.zukHp ?? "-").padStart(4)} | ${String(r.hp ?? "-").padStart(3)} | ${r.cause ?? ""}`,
    );
  }

  put("");
  put(`total wall time: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  put(`logs: ${path.relative(ROOT, OUT_DIR)}`);

  fs.writeFileSync(path.join(OUT_DIR, "summary.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2) + "\n");
  process.exitCode = broken.length > 0 ? 1 : 0;
});
