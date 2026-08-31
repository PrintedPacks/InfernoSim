"use strict";

/**
 * SLIP PROBE, 2026-08-22: what exactly happens on the tick a tagged mager's cycle stretches?
 *
 * Seed 74 (pure_rcb): set 4's Jal-Zek, tagged clean onto residue 0 at t1776, is observed on
 * residue 1 by t1825 - one cycle somewhere in between took 5 ticks instead of 4, landing it on
 * Jad's lane and killing the run. The user reports LOS is never lost on this wave, so the cause
 * is NOT the assumed sight-break. This probe watches every tick of the window and prints the
 * engine truth the moment the cadence stretches: delay, LOS flag, distances, player position,
 * and whether the mob was under the player, frozen, or stunned.
 *
 * Run:  INFERNO_SEED=74 npx jest --config jest.harness.config.js --testPathPattern slipMoment
 */

import { EntityNames, Mob, Player, Region } from "osrs-sdk";

import { InfernoAutomation } from "../../src/content/inferno/js/InfernoAutomation";
import { seedEverything } from "../../src/content/inferno/js/SeededRandom";
import { bootHarness, out, silenceConsole } from "./bootHarness";

const SEED = parseInt(process.env.INFERNO_SEED || "74", 10);
const FROM = parseInt(process.env.PROBE_FROM || "1755", 10);
const TO = parseInt(process.env.PROBE_TO || "1900", 10);

test("probe: the tick a tagged attacker's cadence stretches", () => {
  silenceConsole();
  jest.useFakeTimers("legacy");
  const { region, world, player } = bootHarness({
    seed: SEED,
    wave: 69,
    loadout: "pure_rcb",
    prayerOverride: 99999,
    runOverride: 10000,
    shieldDirection: "random",
  });
  seedEverything(SEED);
  InfernoAutomation.setEnabled(true);

  const anyRegion = region as unknown as Region;
  const anyPlayer = player as unknown as Player;
  const mobs = () =>
    (anyRegion.mobs as Mob[]).concat((anyRegion as unknown as { newMobs: Mob[] }).newMobs);

  // Fires observed the same way the harness watch observes them: delay jumping to full speed.
  const lastDelay = new Map<Mob, number>();
  const fireTicks = new Map<Mob, number[]>();

  let tick = 0;
  while (tick < TO) {
    tick++;
    if (world.getReadyTimer > 0) {
      world.getReadyTimer--;
    }
    (anyPlayer.currentStats as { run?: number }).run = 10000;
    anyPlayer.running = true;
    world.tickWorld();
    jest.advanceTimersByTime(600);

    const watched = mobs().filter((mob) => {
      const name = mob.mobName();
      return (
        mob.dying === -1 &&
        (name === EntityNames.JAL_ZEK ||
          name === EntityNames.JAL_XIL ||
          name === EntityNames.JAL_TOK_JAD)
      );
    });
    for (const mob of watched) {
      const delay = mob.attackDelay ?? 0;
      const previous = lastDelay.get(mob);
      lastDelay.set(mob, delay);
      if (previous !== undefined && delay > previous && delay === (mob.attackSpeed ?? 4)) {
        const list = fireTicks.get(mob) ?? [];
        list.push(tick);
        fireTicks.set(mob, list);
      }
    }

    if (tick < FROM) {
      continue;
    }

    const lines = watched.map((mob) => {
      const live = mob as unknown as {
        attackDelay?: number;
        hasLOS?: boolean;
        stunned?: number;
        frozen?: number;
        aggro?: unknown;
        isFlickering?: boolean;
      };
      const name = mob.mobName();
      const who =
        name === EntityNames.JAL_ZEK ? "Zek" : name === EntityNames.JAL_XIL ? "Xil" : "Jad";
      const closest = mob.getClosestTileTo(anyPlayer.location.x, anyPlayer.location.y);
      const distance = Math.max(
        Math.abs(closest[0] - anyPlayer.location.x),
        Math.abs(closest[1] - anyPlayer.location.y),
      );
      const fired = (fireTicks.get(mob) ?? []).includes(tick) ? "*FIRE*" : "      ";
      return (
        `${who}@${mob.location.x},${mob.location.y} d${String(distance).padStart(2)} ` +
        `delay ${String(live.attackDelay).padStart(3)} los ${live.hasLOS ? "y" : "N"} ` +
        `${live.isFlickering ? "flick" : "     "} ` +
        `${(live.frozen ?? 0) > 0 ? `frz${live.frozen}` : ""}${
          (live.stunned ?? 0) > 0 ? `stn${live.stunned}` : ""
        }${live.aggro === anyPlayer ? "" : " AGGRO-NOT-PLAYER"} ${fired}`
      );
    });
    out(
      `t${tick} | p ${anyPlayer.location.x},${anyPlayer.location.y} | ` + lines.join(" | "),
    );
  }

  out("");
  out("observed fire ticks (gaps flagged where not a multiple of speed):");
  fireTicks.forEach((ticks, mob) => {
    const speed = mob.attackSpeed ?? 4;
    const gaps = ticks
      .map((t, i) => (i === 0 ? `${t}` : `+${t - ticks[i - 1]}${(t - ticks[i - 1]) % speed !== 0 ? "<-SLIP" : ""}`))
      .join(" ");
    out(`  ${mob.mobName()} (speed ${speed}): ${gaps}`);
  });

  expect(true).toBe(true);
});
