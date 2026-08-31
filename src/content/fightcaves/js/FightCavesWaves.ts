"use strict";

import { Player, Region, Mob, Location } from "osrs-sdk";
import { shuffle } from "lodash";

import { JalAk } from "../../inferno/js/mobs/JalAk";
import { JalImKot } from "../../inferno/js/mobs/JalImKot";
import { JalMejRah } from "../../inferno/js/mobs/JalMejRah";
import { JalXil } from "../../inferno/js/mobs/JalXil";
import { JalZek } from "../../inferno/js/mobs/JalZek";

/**
 * Wave content for the Fight Caves skeleton.
 *
 * Phase 1 only: an empty arena reusing the existing Inferno mob classes (bat/blob/melee/
 * ranger/mager) so the arena + wave-progression scaffolding can be built and played before
 * any Fight-Caves-specific mob or model exists. See FightCavesRegion for the arena itself.
 */
export class FightCavesWaves {
  // Scatter points inside the arena (see FightCavesRegion.width/height), kept clear of the
  // player's start tile.
  static spawns: Location[] = [
    { x: 6, y: 6 },
    { x: 18, y: 6 },
    { x: 6, y: 10 },
    { x: 18, y: 10 },
    { x: 12, y: 4 },
    { x: 6, y: 14 },
    { x: 18, y: 14 },
    { x: 12, y: 16 },
    { x: 9, y: 8 },
    { x: 15, y: 8 },
  ];

  static getRandomSpawns(): Location[] {
    // Deep copy - same reasoning as InfernoWaves.getRandomSpawns: shuffling in place would
    // corrupt the shared static array between waves/runs.
    return shuffle(FightCavesWaves.spawns.map((spawn) => ({ x: spawn.x, y: spawn.y })));
  }

  // [bat, blob, melee, ranger, mager]. Five simple waves, one new mob type introduced at a
  // time, before a "one of everything" finisher.
  static waves: number[][] = [
    [1, 0, 0, 0, 0], // 1
    [0, 1, 0, 0, 0], // 2
    [0, 0, 1, 0, 0], // 3
    [0, 0, 0, 1, 1], // 4
    [1, 1, 1, 1, 1], // 5
  ];

  static spawn(region: Region, player: Player, spawns: Location[], wave: number): Mob[] {
    const counts = FightCavesWaves.waves[wave - 1];
    if (!counts) {
      return [];
    }

    const mobs: Mob[] = [];
    let i = 0;

    Array(counts[0])
      .fill(0)
      .forEach(() => mobs.push(new JalMejRah(region, spawns[i++], { aggro: player })));
    Array(counts[1])
      .fill(0)
      .forEach(() => mobs.push(new JalAk(region, spawns[i++], { aggro: player })));
    Array(counts[2])
      .fill(0)
      .forEach(() => mobs.push(new JalImKot(region, spawns[i++], { aggro: player })));
    Array(counts[3])
      .fill(0)
      .forEach(() => mobs.push(new JalXil(region, spawns[i++], { aggro: player })));
    Array(counts[4])
      .fill(0)
      .forEach(() => mobs.push(new JalZek(region, spawns[i++], { aggro: player })));

    return mobs;
  }
}
