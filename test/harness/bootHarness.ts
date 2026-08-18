"use strict";

/**
 * Boot the real game headlessly, once, for a harness run.
 *
 * This is `test/harness/waveRun.test.ts`'s boot sequence, lifted so a second harness does not
 * have to copy it. It mirrors `src/index.ts` step for step, minus what only exists for a human:
 * asset preloading, model warm-up, the requestAnimationFrame loop, and the extra UI listeners.
 * The one deliberate substitution is `Viewport.setupViewport(region, true)` - forcing the 2D
 * viewport - because jsdom has no WebGL. The 2D viewport is a renderer choice, not a simulation
 * choice.
 *
 * Determinism: every random draw in the stack goes through either `Random.get` (engine rolls)
 * or `Math.random` (lodash shuffles, jad stun order), and both are seeded here before any world
 * object exists.
 *
 * What this file deliberately does NOT own: the tick pump, the fake timers, and every decision
 * about when a run is over. Those differ per harness and belong with the harness that makes
 * them. `waveRun.test.ts` still carries its own copy of all of this on purpose - it is the
 * baseline every scoring change is measured against, and it is not being touched to add a
 * second harness beside it.
 */

import * as fs from "fs";
import * as path from "path";

import { Random, Settings, Viewport, World } from "osrs-sdk";

import { InfernoRegion } from "../../src/content/inferno/js/InfernoRegion";
import { InfernoSettings } from "../../src/content/inferno/js/InfernoSettings";
import type { ShieldDirection } from "../../src/content/inferno/js/ZukShield";

export interface BootOptions {
  seed: number;
  wave: number;
  loadout: string;
  /** Extra URL query params, exactly as the browser takes them. */
  query?: string;
  /** Override the prayer pool for the whole run; NaN or undefined leaves the loadout's. */
  prayerOverride?: number;
  /** Which way Zuk's shield sets off. "random" is the browser default and is seeded. */
  shieldDirection?: ShieldDirection;
}

export interface BootedRun {
  region: InfernoRegion;
  world: World;
  player: ReturnType<InfernoRegion["initialiseRegion"]>["player"];
}

/** Deterministic PRNG (mulberry32) - splittable enough for two independent streams. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bypass jest's console capture so a report reads as plain lines, not log noise. */
export function out(line: string) {
  process.stdout.write(line + "\n");
}

const silenced = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  debug: console.debug,
};

/**
 * Mute the sim's own per-wave and asset-preload chatter.
 *
 * console.error stays live, so a real failure still surfaces.
 */
export function silenceConsole() {
  console.log = console.info = console.warn = console.debug = () => undefined;
}

export function restoreConsole() {
  console.log = silenced.log;
  console.info = silenced.info;
  console.warn = silenced.warn;
  console.debug = silenced.debug;
}

export function bootHarness(options: BootOptions): BootedRun {
  // ---- Seed every randomness source before any world object exists. ----
  Random.setRandom(mulberry32(options.seed));
  Math.random = mulberry32(options.seed ^ 0x9e3779b9);

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

  // The region reads its wave number - and any custom spawns - from the URL, same as the browser.
  window.history.replaceState(
    {},
    "",
    `/?wave=${options.wave}${options.query ? `&${options.query}` : ""}`,
  );

  // ---- Settings, then harness-required overrides. ----
  Settings.readFromStorage();
  InfernoSettings.readFromStorage();
  Settings.use3dView = false; // no WebGL headless; also the storage default is ON
  Settings.metronome = false;
  Settings.loadout = options.loadout;
  InfernoSettings.waveProgression = true;
  InfernoSettings.spawnIndicators = false;
  InfernoSettings.displaySetTimer = false;
  if (options.shieldDirection) {
    // Read by the region through the sidebar's <select>, which initialiseRegion seeds from
    // this field - so it has to be set before the region builds the wave.
    InfernoSettings.shieldDirection = options.shieldDirection;
  }

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

  // Testing aid, not simulation: a run that would die of prayer drain can be given a pool deep
  // enough that the "ran out of prayer" ending is unreachable, so the behaviour past that point
  // is observable. The drain itself still happens - the pool is just bigger.
  if (options.prayerOverride !== undefined && !isNaN(options.prayerOverride)) {
    player.stats.prayer = options.prayerOverride;
    player.currentStats.prayer = options.prayerOverride;
  }

  return { region, world, player };
}
