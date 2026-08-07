"use strict";

/**
 * Seed sweep: run the wave harness across many seeds IN PARALLEL and summarise the outcomes.
 *
 * A single full run is CPU-bound on the tile scorer's per-tick simulations and cannot be made
 * much faster from out here - but every run is an independent single-core process, so the
 * sweep runs one per core and the wall time divides by the machine. Each seed's full harness
 * output is kept on disk, so any interesting seed can be re-run or read in detail afterwards.
 *
 * Usage:
 *   npm run test:sweep                        50 seeds (1..50), cores-1 in parallel
 *   SWEEP_SEEDS=20 npm run test:sweep         seeds 1..20
 *   SWEEP_SEED_START=100 npm run test:sweep   seeds 100..149
 *   SWEEP_PARALLEL=4 npm run test:sweep       cap concurrent runs at 4
 *
 * All INFERNO_* environment variables pass straight through to every run, so the usual knobs
 * work unchanged - e.g. a quick smoke sweep of the early game:
 *   INFERNO_TICK_LIMIT=4000 INFERNO_PRAYER=99999999 INFERNO_AUTO_DELAY=8 npm run test:sweep
 * (in PowerShell: $env:INFERNO_TICK_LIMIT="4000"; etc., then npm run test:sweep)
 *
 * Per-seed logs land in test/harness/sweep-results/<timestamp>/seed-N.log alongside a
 * summary.txt of the table printed at the end.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SEED_COUNT = parseInt(process.env.SWEEP_SEEDS ?? "50", 10);
const SEED_START = parseInt(process.env.SWEEP_SEED_START ?? "1", 10);
const PARALLEL = Math.max(
  1,
  parseInt(process.env.SWEEP_PARALLEL ?? "", 10) || os.cpus().length - 1,
);

const ROOT = path.resolve(__dirname, "..", "..");
const JEST = path.join(ROOT, "node_modules", "jest", "bin", "jest.js");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = path.join(__dirname, "sweep-results", STAMP);
fs.mkdirSync(OUT_DIR, { recursive: true });

const seeds = Array.from({ length: SEED_COUNT }, (_, i) => SEED_START + i);
const results = [];
let nextIndex = 0;
const startedAt = Date.now();

console.log(
  `sweep | seeds ${SEED_START}..${SEED_START + SEED_COUNT - 1} | ` +
    `${PARALLEL} in parallel | logs in ${path.relative(ROOT, OUT_DIR)}`,
);

/** Pull the interesting lines back out of one run's captured output. */
function parseOutput(text) {
  const result = /RESULT: (\w+)(?: - (.*))?/.exec(text);
  const reached = /reached wave (\d+) \(started at \d+\), cleared (\d+) wave/.exec(text);
  const ticks = /^(\d+) ticks \(~([^)]+) in-game\) \| wall time ([^|]+) \|/m.exec(text);
  return {
    outcome: result ? result[1] : "no-result",
    detail: result?.[2] ?? "",
    wave: reached ? parseInt(reached[1], 10) : 0,
    cleared: reached ? parseInt(reached[2], 10) : 0,
    ticks: ticks ? parseInt(ticks[1], 10) : 0,
    wall: ticks ? ticks[3].trim() : "?",
  };
}

function runSeed(seed) {
  return new Promise((resolve) => {
    const logPath = path.join(OUT_DIR, `seed-${seed}.log`);
    const log = fs.createWriteStream(logPath);
    const child = spawn(
      process.execPath,
      [JEST, "--config", "jest.harness.config.js"],
      {
        cwd: ROOT,
        env: { ...process.env, INFERNO_SEED: String(seed) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let captured = "";
    const capture = (chunk) => {
      captured += chunk;
      log.write(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    child.on("close", (code) => {
      log.end();
      const parsed = parseOutput(captured);
      const entry = { seed, exitCode: code, ...parsed };
      results.push(entry);
      const label =
        parsed.outcome === "completed"
          ? "COMPLETED"
          : `${parsed.outcome} wave ${parsed.wave}`;
      console.log(
        `seed ${String(seed).padStart(4)} | ${label.padEnd(16)} | ` +
          `cleared ${String(parsed.cleared).padStart(2)} | ${parsed.wall.padStart(7)} | ` +
          `${results.length}/${seeds.length} done`,
      );
      resolve(entry);
    });
  });
}

async function worker() {
  while (nextIndex < seeds.length) {
    const seed = seeds[nextIndex++];
    await runSeed(seed);
  }
}

Promise.all(Array.from({ length: Math.min(PARALLEL, seeds.length) }, worker)).then(() => {
  results.sort((a, b) => a.seed - b.seed);

  const lines = [];
  const put = (line) => {
    lines.push(line);
    console.log(line);
  };

  put("");
  put("================ SWEEP SUMMARY ================");
  const completed = results.filter((r) => r.outcome === "completed");
  const died = results.filter((r) => r.outcome === "died");
  const stuck = results.filter((r) => r.outcome === "stuck");
  const broken = results.filter(
    (r) => !["completed", "died", "stuck"].includes(r.outcome),
  );

  put(
    `${results.length} runs | ${completed.length} completed | ` +
      `${died.length} died | ${stuck.length} stuck` +
      (broken.length ? ` | ${broken.length} BROKEN (no RESULT line)` : ""),
  );
  const clearedTotal = results.reduce((sum, r) => sum + r.cleared, 0);
  put(`average waves cleared: ${(clearedTotal / results.length).toFixed(1)}`);

  const byWave = new Map();
  for (const r of [...died, ...stuck]) {
    const key = `${r.outcome} @ wave ${r.wave}`;
    byWave.set(key, (byWave.get(key) ?? []).concat(r.seed));
  }
  if (byWave.size > 0) {
    put("");
    put("failures by wave (seeds):");
    for (const [key, seedList] of [...byWave.entries()].sort()) {
      put(`  ${key.padEnd(16)} x${seedList.length}  [${seedList.join(", ")}]`);
    }
  }
  for (const r of broken) {
    put(`  BROKEN seed ${r.seed} (exit ${r.exitCode}) - read its log`);
  }

  put("");
  put(`total wall time: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  put(`logs: ${path.relative(ROOT, OUT_DIR)}`);

  fs.writeFileSync(path.join(OUT_DIR, "summary.txt"), lines.join("\n") + "\n");
  process.exitCode = broken.length > 0 ? 1 : 0;
});
