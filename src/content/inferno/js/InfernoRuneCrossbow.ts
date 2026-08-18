"use strict";

import { Assets, RuneCrossbow } from "osrs-sdk";

export const RuneCrossbowModel = Assets.getAssetUrl("models/player_rune_crossbow.glb");

/**
 * The SDK's rune crossbow, wearing a 3D model.
 *
 * Every other equipment class in the SDK sets `this.Model` in its constructor and returns it
 * from `model`; `RuneCrossbow` is the one that does not, so in the 3D viewport the player
 * holds nothing. The engine is not ours to edit, and this needs no other behaviour changed -
 * damage, range, speed, bolt procs and `itemName` all stay exactly as the SDK defines them,
 * which matters because `itemName` is what every inventory lookup in GearSets matches on.
 */
export class InfernoRuneCrossbow extends RuneCrossbow {
  override get model(): string {
    return RuneCrossbowModel;
  }
}
