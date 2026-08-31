"use strict";

/**
 * OPENING-PRAYER PROBE, 2026-08-22: why does the first set's first post-tag fire land on an
 * empty overhead?
 *
 * Measured across the 2026-08-22 sweep: 135/150 seeds eat exactly one unprayed hit from the
 * FIRST pair (Jal-Xil's opening at ~t86 or Jal-Zek's at ~t85/89), and never again - every later
 * fire of the same mobs, and every later set, is prayed correctly. The observed-fire watch in
 * zukRun confirms the miss (`UNPRAYED Jal-Xil(range) fire ... overhead was none` at t86 on
 * seed 74), but not the WHY: the trajectory sim's inputs at postTick t85 look sufficient to
 * predict the t86 fire, so either the sim drops the threat or the planner's choice never
 * reaches the prayer controller.
 *
 * This probe runs the REAL automation to just past the first set and, each tick of the opening
 * window, prints the engine truth (delay/age/stun/aggro/LOS per set mob), what the trajectory
 * sim projects (threat ticks), what the planner therefore wants next tick, and what overhead
 * was actually active. Where those disagree is the defect.
 *
 * Run:  npx jest --config jest.harness.config.js --testPathPattern openingPrayer
 */

import { ControlPanelController, EntityNames, Mob, Player, Region, Settings } from "osrs-sdk";

import { InfernoAutomation } from "../../src/content/inferno/js/InfernoAutomation";
import { plannedOverhead } from "../../src/content/inferno/js/PrayerPlanner";
import { ArenaSnapshot } from "../../src/content/inferno/js/ArenaSnapshot";
import { simulateTrajectory, snapshotMobs } from "../../src/content/inferno/js/Trajectory";
import { visibleMobs } from "../../src/content/inferno/js/Visibility";
import { seedEverything } from "../../src/content/inferno/js/SeededRandom";
import { bootHarness, out, silenceConsole } from "./bootHarness";

const SEED = parseInt(process.env.INFERNO_SEED || "74", 10);
const FROM = parseInt(process.env.PROBE_FROM || "76", 10);
const TO = parseInt(process.env.PROBE_TO || "95", 10);

test("probe: overhead vs engine truth across the first set's opening", () => {
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
  // Same double-seed as zukRun: the browser re-seeds right before its first tick.
  seedEverything(SEED);
  InfernoAutomation.setEnabled(true);

  const anyRegion = region as unknown as Region;
  const anyPlayer = player as unknown as Player;
  const setMobs = () =>
    (anyRegion.mobs as Mob[])
      .concat((anyRegion as unknown as { newMobs: Mob[] }).newMobs)
      .filter((mob) => {
        const name = mob.mobName();
        return (
          mob.dying === -1 && (name === EntityNames.JAL_ZEK || name === EntityNames.JAL_XIL)
        );
      });
  const overheadName = () =>
    (anyPlayer as unknown as { prayerController?: { overhead(): { name?: string } | null } })
      .prayerController?.overhead()?.name ?? "none";

  // ---- Spies on the two layers a prayer click passes through, so a dropped click names the
  // layer that dropped it: PrayerControls.panelClickDown (the panel), then BasePrayer.toggle
  // (the engine). Logged with the tick they happened on. ----
  const spyLog: string[] = [];
  let spyTick = 0;
  {
    const prayerPanel = ControlPanelController.controls?.PRAYER as unknown as {
      panelClickDown?: (x: number, y: number) => void;
    } | null;
    if (prayerPanel?.panelClickDown) {
      const realClick = prayerPanel.panelClickDown.bind(prayerPanel);
      prayerPanel.panelClickDown = (x: number, y: number) => {
        spyLog.push(
          `t${spyTick} panelClickDown(${Math.round(x)},${Math.round(y)}) selected=${
            (ControlPanelController.controller as unknown as { selectedControl?: unknown })
              ?.selectedControl === (prayerPanel as unknown)
              ? "PRAYER"
              : "other"
          }`,
        );
        realClick(x, y);
      };
    } else {
      spyLog.push("(no PRAYER panel to spy on)");
    }
    const prayers = (
      player as unknown as {
        prayerController?: { prayers: { name: string; toggle: (p: unknown) => void }[] };
      }
    ).prayerController?.prayers ?? [];
    for (const prayer of prayers) {
      if (!prayer.name.startsWith("Protect from")) {
        continue;
      }
      const realToggle = prayer.toggle.bind(prayer);
      prayer.toggle = (p: unknown) => {
        spyLog.push(`t${spyTick} toggle(${prayer.name})`);
        realToggle(p);
      };
    }
  }

  let tick = 0;
  while (tick < TO) {
    tick++;
    spyTick = tick;
    if (world.getReadyTimer > 0) {
      world.getReadyTimer--;
    }
    (anyPlayer.currentStats as { run?: number }).run = 10000;
    anyPlayer.running = true;
    world.tickWorld();
    jest.advanceTimersByTime(600);

    if (tick < FROM) {
      continue;
    }

    // Engine truth for each set mob, read at postTick - after this tick's attacks, before the
    // automation's choices for next tick have committed.
    const mobLines = setMobs().map((mob) => {
      const live = mob as unknown as {
        attackDelay?: number;
        age?: number;
        stunned?: number;
        hasLOS?: boolean;
        aggro?: unknown;
      };
      const who = mob.mobName() === EntityNames.JAL_ZEK ? "Zek" : "Xil";
      const aggro =
        live.aggro === anyPlayer ? "player" : live.aggro ? "shield" : "none";
      return (
        `${who}[delay ${live.attackDelay} age ${live.age} stun ${live.stunned} ` +
        `aggro ${aggro} los ${live.hasLOS ? "y" : "n"}]`
      );
    });

    // What the trajectory sim projects from this exact state - the planner's entire evidence.
    // chosenPath is private; the probe reads it the way the trace does, by cast.
    const route = (
      InfernoAutomation as unknown as { chosenPath?: { x: number; y: number }[] }
    ).chosenPath;
    const here = { x: anyPlayer.location.x, y: anyPlayer.location.y };
    const path = route && route.length > 0 ? route : [here];
    let threatText = "(sim threw)";
    try {
      const threats = simulateTrajectory(
        new ArenaSnapshot(anyRegion),
        snapshotMobs(anyRegion, anyPlayer),
        path,
      );
      threatText =
        threats
          .filter((threat) => threat.tick <= 4)
          .map((threat) => `+${threat.tick} ${threat.name}(${threat.styles.join("/")})`)
          .join(" ") || "(none within 4)";
    } catch (e) {
      threatText = `(sim threw: ${(e as Error)?.message})`;
    }

    let wanted = "(planner threw)";
    try {
      wanted = plannedOverhead(anyPlayer, visibleMobs(anyRegion), route) ?? "null";
    } catch (e) {
      wanted = `(planner threw: ${(e as Error)?.message})`;
    }

    // The overhead prayers' raw state: did the click REGISTER (nextActiveState) even when
    // nothing ends up active next tick? Distinguishes "planner never asked" from "the click
    // never landed" from "it landed and something reverted it".
    const controller = (
      anyPlayer as unknown as {
        prayerController?: {
          prayers: { name: string; isActive: boolean; nextActiveState: boolean | null }[];
        };
      }
    ).prayerController;
    const prayerBits = (controller?.prayers ?? [])
      .filter((p) => p.name.startsWith("Protect from"))
      .map(
        (p) =>
          `${p.name.replace("Protect from ", "").slice(0, 3)}:${p.isActive ? "A" : "-"}${
            p.nextActiveState === null ? "." : p.nextActiveState ? "+" : "x"
          }`,
      )
      .join(" ");

    const pool = (anyPlayer as unknown as { currentStats?: { prayer?: number } }).currentStats
      ?.prayer;
    out(
      `t${String(tick).padStart(3)} | player ${here.x},${here.y} | active ${overheadName().padEnd(19)} | ` +
        `wants-next ${wanted.padEnd(19)} | ${prayerBits} | scale ${
          (Settings.controlPanelScale ?? 1).toFixed(3)
        } pool ${pool} | sim ${threatText.padEnd(30)} | ${mobLines.join(" ")}`,
    );
  }

  out("");
  out("click-path spy (every panelClickDown on the prayer panel, every overhead toggle):");
  for (const line of spyLog) {
    out(`  ${line}`);
  }

  expect(true).toBe(true);
});
