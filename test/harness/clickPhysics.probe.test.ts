"use strict";

/**
 * PHYSICS PROBE, 2026-08-21: what does THIS engine actually do when an attack
 * "click" (setAggro) lands mid-walk?
 *
 * Written because the automation's own comments claim two contradictory things
 * and a live account died on the difference (client capture 1787316434906,
 * the tick-2762 Zuk 75):
 *
 *   - InfernoAutomation.walkClickIssued's doc says "an attack does NOT cancel
 *     [the walk]... the bot can shoot and keep walking."
 *   - Player.determineDestination's source says: aggro + LOS in range =>
 *     destinationLocation = this.location (STOP).
 *
 * Only one of those can be true. This probe asks the engine directly and
 * prints the verdict; it makes no assertions about which answer is "right"
 * beyond internal consistency, because its whole job is to find out.
 *
 * Run:  npx jest --config jest.harness.config.js --testPathPattern clickPhysics
 */

import { EntityNames, Player, Unit } from "osrs-sdk";

import { bootHarness, out, silenceConsole } from "./bootHarness";

const at = (p: Player) => `${p.location.x},${p.location.y}`;
const dest = (p: Player) =>
  p.destinationLocation ? `${p.destinationLocation.x},${p.destinationLocation.y}` : "none";

test("probe: attack click semantics mid-walk", () => {
  silenceConsole();
  const { region, world, player } = bootHarness({
    seed: 1,
    wave: 69,
    loadout: "max_tbow_speed",
    prayerOverride: 99999,
    runOverride: 10000,
    shieldDirection: "west",
  });

  // Automation stays OFF -- the probe drives the player by hand.
  // (bootHarness never enables it; this is documentation, not a change.)

  // Let the wave settle so Zuk and the shield exist.
  world.tickWorld(3);
  const zuk = region.mobs.find((m: Unit) => m.mobName?.() === EntityNames.TZ_KAL_ZUK);
  if (!zuk) {
    out("PROBE ABORT: no Zuk on the board after 3 ticks");
    expect(zuk).toBeTruthy();
    return;
  }
  out(`zuk at ${zuk.location.x},${zuk.location.y} size ${zuk.size}`);
  out(`player boots at ${at(player)} attackRange ${player.attackRange} attackDelay ${player.attackDelay}`);

  player.running = true;

  // ---- Probe 1: plain walk speed, no aggro. ----
  const start = { ...player.location };
  player.moveTo(start.x - 8, start.y);
  world.tickWorld(1);
  out(
    `P1 walk tick: ${start.x},${start.y} -> ${at(player)} ` +
      `(moved ${Math.abs(player.location.x - start.x)} tiles) dest=${dest(player)}`,
  );

  // ---- Probe 2: attack click MID-WALK, in range, weapon ready. ----
  player.attackDelay = 0;
  const before2 = { ...player.location };
  const delayBefore2 = player.attackDelay;
  player.setAggro(zuk as Unit);
  world.tickWorld(1);
  const moved2 = Math.abs(player.location.x - before2.x) + Math.abs(player.location.y - before2.y);
  out(
    `P2 aggro mid-walk tick: ${before2.x},${before2.y} -> ${at(player)} ` +
      `(moved ${moved2}) dest=${dest(player)} hasLOS=${player.hasLOS} ` +
      `attackDelay ${delayBefore2} -> ${player.attackDelay} ` +
      `(shot fired: ${player.attackDelay > 0})`,
  );

  // ---- Probe 3: next tick, NO new click -- does sticky aggro hold the player? ----
  const before3 = { ...player.location };
  world.tickWorld(1);
  const moved3 = Math.abs(player.location.x - before3.x) + Math.abs(player.location.y - before3.y);
  out(`P3 sticky tick (no click): ${before3.x},${before3.y} -> ${at(player)} (moved ${moved3}) dest=${dest(player)}`);

  // ---- Probe 4: walk re-click the tick after a shot -- full speed again? ----
  const before4 = { ...player.location };
  player.moveTo(before4.x - 8, before4.y);
  world.tickWorld(1);
  const moved4 = Math.abs(player.location.x - before4.x) + Math.abs(player.location.y - before4.y);
  out(
    `P4 re-click tick: ${before4.x},${before4.y} -> ${at(player)} (moved ${moved4}) ` +
      `aggro=${player.aggro ? "held" : "cleared"} dest=${dest(player)}`,
  );

  // ---- Probe 5: attack click OUT of range -- does the engine drag the player? ----
  // Walk away from Zuk until past tbow range (10), then aggro and watch.
  for (let i = 0; i < 30 && Math.abs(player.location.y - zuk.location.y) < 16; i++) {
    if (!player.destinationLocation ||
        (player.location.x === player.destinationLocation.x &&
         player.location.y === player.destinationLocation.y)) {
      player.moveTo(player.location.x, player.location.y + 4);
    }
    world.tickWorld(1);
  }
  const before5 = { ...player.location };
  player.attackDelay = 0;
  player.setAggro(zuk as Unit);
  world.tickWorld(1);
  const d5 = { ...player.location };
  world.tickWorld(1);
  out(
    `P5 aggro out of range: ${before5.x},${before5.y} -> ${d5.x},${d5.y} -> ${at(player)} ` +
      `hasLOS=${player.hasLOS} dest=${dest(player)} (engine walking the player toward Zuk: ${
        Math.abs(player.location.y - before5.y) > 0 ? "YES" : "no"
      })`,
  );

  expect(true).toBe(true);
});
