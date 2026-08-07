"use strict";

import { Mob, Region } from "osrs-sdk";

/**
 * The mobs the bot is allowed to know about.
 *
 * Everything the automation reads about the fight must come through here. The rule is simple
 * and absolute: if the renderer would not draw a mob, the bot must not see it either.
 *
 * There are two ways to accidentally break that, and both were live before this existed.
 *
 * THE COUNTDOWN. Starting a wave spawns its mobs immediately, but both viewports draw mobs
 * only when the countdown has expired:
 *
 *     // Viewport3d.draw2dScene
 *     const units = [...region.players, ...(world.getReadyTimer <= 0 ? region.mobs : [])];
 *
 * So for the whole get-ready window the arena looks empty to a player while `region.mobs` is
 * already fully populated. Scoring tiles against that is reading the wave's entire layout
 * several ticks before anyone could possibly know it - not a modelling error, a cheat.
 *
 * NEWLY SPAWNED MOBS. `handleWaveProgression` runs in postTick and pushes into `newMobs`,
 * which `tickRegion` does not merge into `mobs` until the start of the following tick. The
 * renderer draws `mobs`, so a mob sitting in `newMobs` has not been shown to anyone yet.
 * Reading it is a one-tick head start - far smaller than the countdown, but the same kind of
 * thing, and worth refusing on principle rather than defending as negligible.
 *
 * The cost of this honesty is real and should be expected: the bot cannot pre-pray a mob's
 * very first attack, because it genuinely does not know that mob exists until the tick it
 * appears. A human is in exactly the same position. Taking that hit is correct; avoiding it
 * would mean seeing the future.
 */
export function visibleMobs(region: Region): Mob[] {
  if ((region.world?.getReadyTimer ?? 0) > 0) {
    return [];
  }
  return region.mobs;
}

/** True while the wave is spawned but frozen, and therefore not yet drawn to the player. */
export function isCountingDown(region: Region): boolean {
  return (region.world?.getReadyTimer ?? 0) > 0;
}
