"use strict";

import type { ShieldDirection } from "./ZukShield";

export class InfernoSettings {
  static waveProgression = false;
  static spawnIndicators = false;
  static displaySetTimer = false;
  /**
   * EXPERIMENTAL: the tile scorer slowly decays the score of the tile the player is standing
   * on while mobs are alive but no fighting is happening, to pressure the bot out of
   * standoffs. A toggle rather than always-on because it is unproven and may need ripping
   * out - see TileScorer's decay constants for the rate.
   */
  static tileDecay = false;
  static shieldDirection: ShieldDirection = "random";

  static persistToStorage() {
    window.localStorage.setItem("waveProgression", String(InfernoSettings.waveProgression));
    window.localStorage.setItem("spawnIndicators", String(InfernoSettings.spawnIndicators));
    window.localStorage.setItem("displaySetTimer", String(InfernoSettings.displaySetTimer));
    window.localStorage.setItem("tileDecay", String(InfernoSettings.tileDecay));
    window.localStorage.setItem("shieldDirection", InfernoSettings.shieldDirection);
  }

  static readFromStorage() {
    InfernoSettings.waveProgression = window.localStorage.getItem("waveProgression") === "true" || false;
    InfernoSettings.spawnIndicators = window.localStorage.getItem("spawnIndicators") === "true" || false;
    InfernoSettings.displaySetTimer = window.localStorage.getItem("displaySetTimer") === "true" || false;
    InfernoSettings.tileDecay = window.localStorage.getItem("tileDecay") === "true" || false;
    const shieldDir = window.localStorage.getItem("shieldDirection");
    if (shieldDir === "west" || shieldDir === "east" || shieldDir === "random") {
      InfernoSettings.shieldDirection = shieldDir;
    } else {
      InfernoSettings.shieldDirection = "random";
    }
  }
}
