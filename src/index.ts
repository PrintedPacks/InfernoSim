"use strict";

import { Settings, Region, World, Viewport, MapController, TileMarker, Assets, Location, Chrome, ImageLoader, Trainer, ControlPanelController } from "osrs-sdk";

import { InfernoRegion } from "./content/inferno/js/InfernoRegion";
import { FightCavesRegion } from "./content/fightcaves/js/FightCavesRegion";
import { InfernoAutomation } from "./content/inferno/js/InfernoAutomation";
import { InfernoSettings } from "./content/inferno/js/InfernoSettings";
import { seedEverything } from "./content/inferno/js/SeededRandom";
import {
  preloadInfernoModels,
  warmUpMobModels,
  disposeWarmupModels,
} from "./content/inferno/js/InfernoPreloader";

const SpecialAttackBarBackground = Assets.getAssetUrl("assets/images/attackstyles/interface/special_attack_background.png");

Settings.readFromStorage();
InfernoSettings.readFromStorage();

// ---- ?seed= and ?loadout=, so a harness run can be watched rather than only read. ----
//
// BEFORE ANY WORLD OBJECT EXISTS, which is the whole requirement: the region builds its wave in
// the constructor and every mob it makes has already rolled by the time this file finishes.
//
// The same two streams the harness seeds, through the same function, so `?seed=67` is the fight
// `INFERNO_SEED=67` produced. It will not be tick-identical forever - the 3D view is on here and
// off there, and anything on that path that touches Math.random pulls the streams apart - but the
// wave layout, the shield's opening direction and the early fight are the same.
{
  const params = new URLSearchParams(window.location.search);
  const seed = parseInt(params.get("seed") ?? "", 10);
  if (Number.isFinite(seed)) {
    seedEverything(seed);
    console.log(`seeded run: seed=${seed}`);
  }
  const loadout = params.get("loadout");
  if (loadout) {
    Settings.loadout = loadout;
  }
  // The shield's opening direction decides the whole fight, and the browser reads it from stored
  // settings while the harness forces "random". A stored "west" against a seeded "random" is not
  // the same run and never will be, however matched the seed is.
  const shield = params.get("shield");
  if (shield) {
    (InfernoSettings as unknown as { shieldDirection: string }).shieldDirection = shield;
  }
  // Printed in the same shape as the harness header, so the two can be compared line to line
  // before concluding anything from a difference between them.
  console.log(
    `zuk browser | seed ${Number.isFinite(seed) ? seed : "unseeded"} | ` +
      `loadout ${Settings.loadout} | ` +
      `shield ${(InfernoSettings as unknown as { shieldDirection?: string }).shieldDirection ?? "?"} | ` +
      `wave ${params.get("wave") ?? "1"} | ` +
      "prayer REAL DRAIN | run REAL DRAIN  <- the harness pins both; see below",
  );
  console.log(
    "  harness runs with prayer 99999 and run pinned to 10000 every tick. This page does not, " +
      "so prayer can empty and the orb can drop the bot to one tile a tick.",
  );
}

// Choose the region based on the URL.
const AVAILABLE_REGIONS = {
  'inferno.html': new InfernoRegion(),
  'fightcaves.html': new FightCavesRegion(),
};
const DEFAULT_REGION_PATH = 'inferno.html';

const regionName = window.location.pathname.split('/').pop();
const selectedRegion: Region = (regionName in AVAILABLE_REGIONS) ? AVAILABLE_REGIONS[regionName] : AVAILABLE_REGIONS[DEFAULT_REGION_PATH];

// Create world
const world = new World();
world.getReadyTimer = 6;
selectedRegion.world = world;
world.addRegion(selectedRegion);

// Initialise UI
document.getElementById('sidebar_content').innerHTML = selectedRegion.getSidebarContent();

document.getElementById("reset").addEventListener("click", () => {
  Trainer.reset();
});

document.getElementById("settings").addEventListener("click", () => {
  ControlPanelController.controller.setActiveControl('SETTINGS');
});

document.getElementById("death_close").addEventListener("click", () => {
  document.getElementById("death_modal").classList.add("hidden");
});

const tileMarkerColor = document.getElementById("tileMarkerColor") as HTMLInputElement;
tileMarkerColor.addEventListener("input", () => {
  Settings.tileMarkerColor = tileMarkerColor.value;
  TileMarker.onSetColor(Settings.tileMarkerColor);
  Settings.persistToStorage();
}, false);
tileMarkerColor.value = Settings.tileMarkerColor;

const { player } = selectedRegion.initialiseRegion();

Viewport.setupViewport(selectedRegion);
Viewport.viewport.setPlayer(player);

ImageLoader.onAllImagesLoaded(() => {
  MapController.controller.updateOrbsMask(player.currentStats, player.stats);
});
TileMarker.loadAll(selectedRegion);


player.perceivedLocation = player.location;
player.destinationLocation = player.location;
/// /////////////////////////////////////////////////////////
// UI controls

ImageLoader.onAllImagesLoaded(() =>
  MapController.controller.updateOrbsMask(Trainer.player.currentStats, Trainer.player.stats),
);

ImageLoader.onAllImagesLoaded(() => {
  drawAssetLoadingBar(loadingAssetProgress);
  imagesReady = true;
  checkStart();
});

const interval = setInterval(() => {
  ImageLoader.checkImagesLoaded(interval);
}, 50);

Assets.onAllAssetsLoaded(async () => {
  // Parse every Inferno model now, so the first spawn of each NPC type is a cache hit
  // rather than a meshopt decode on the main thread mid-wave.
  await preloadInfernoModels((loaded, total) => drawModelWarmupBar(loaded / total));

  // Build one of every mob and draw it into the scene, so that the compileAsync pass
  // inside initialise() compiles the exact shader variants the live mobs will use.
  // Without this the programs are linked on first sight of each NPC, which is the
  // stutter when the countdown ends.
  const warmed = await warmUpMobModels(selectedRegion, player);
  await Viewport.viewport.initialise();
  disposeWarmupModels(warmed);

  console.log("assets are preloaded");
  assetsPreloaded = true;
  checkStart();
});

// Second startup phase: models are downloaded, now they are being parsed and their
// shaders compiled. This is deliberately done up front so it is not paid mid-wave.
function drawModelWarmupBar(progress: number) {
  drawAssetLoadingBar(progress, "Preparing models");
}

function drawAssetLoadingBar(loadingProgress: number, label = "Loading models") {
  const specialAttackBarBackground = ImageLoader.createImage(SpecialAttackBarBackground);
  const { width: canvasWidth, height: canvasHeight } = Chrome.size();
  const canvas = document.getElementById("world") as HTMLCanvasElement;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#FFFF00";
  context.font = "32px OSRS";
  context.textAlign = "center";
  context.fillText(`${label}: ${Math.floor(loadingProgress * 100)}%`, canvas.width / 2, canvas.height / 2);
  const scale = 2;
  const left = canvasWidth / 2 - (specialAttackBarBackground.width * scale) / 2;
  const top = canvasHeight / 2 + 20;
  const width = specialAttackBarBackground.width * scale;
  const height = specialAttackBarBackground.height * scale;
  context.drawImage(specialAttackBarBackground, left, top, width, height);
  context.fillStyle = "#730606";
  context.fillRect(left + 2 * scale, top + 6 * scale, width - 4 * scale, height - 12 * scale);
  context.fillStyle = "#397d3b";
  context.fillRect(left + 2 * scale, top + 6 * scale, (width - 4 * scale) * loadingProgress, height - 12 * scale);
  context.fillStyle = "#000000";
  context.globalAlpha = 0.5;
  context.strokeRect(left + 2 * scale, top + 6 * scale, width - 4 * scale, height - 12 * scale);
  context.globalAlpha = 1;
}

let loadingAssetProgress = 0.0;
drawAssetLoadingBar(loadingAssetProgress);

Assets.onAssetProgress((loaded, total) => {
  loadingAssetProgress = loaded / total;
  drawAssetLoadingBar(loadingAssetProgress);
});

const assets2 = setInterval(() => {
  Assets.checkAssetsLoaded(assets2);
}, 50);

let imagesReady = false;
let assetsPreloaded = false;
let started = false;

function checkStart() {
  if (!started && imagesReady && assetsPreloaded) {
    started = true;

    // ---- ?skipTo=1900 : run the fight silently up to a tick, then hand over ----
    //
    // Watching a problem that happens at t1957 otherwise costs twenty minutes of real time at
    // 0.6s a tick. The skip runs the SAME tickWorld the loop would run, so every mob, every
    // projectile and every automation decision happens exactly as it would have - it is a
    // fast-forward, not a teleport, and the state it lands on is a state the fight really reached.
    //
    // It consumes the seeded stream at the same rate for the same reason, so a skipped run and a
    // watched one diverge no more than two watched runs would.
    //
    // getReadyTimer is spent first: those are the countdown ticks before the wave is live, and
    // skipping them would start the wave already moving.
    // ---- RE-SEED ON THE LINE BEFORE THE FIRST TICK ----
    //
    // Seeding at module load is not enough to reproduce a harness run here, because everything
    // between then and now differs: asset loading, model warmup and the 3D path all draw from
    // Math.random, and the harness never runs any of it. By the time the loop starts the two
    // streams are hundreds of draws apart and the same seed is a different fight.
    //
    // Re-seeding here puts BOTH loops on the same stream at the same point - the harness does the
    // same thing immediately before its own loop. Everything built during initialisation is
    // already fixed by then, so pass the same &shield= as ZUK_SHIELD to pin the one thing that is
    // decided before this line.
    {
      const again = parseInt(new URLSearchParams(window.location.search).get("seed") ?? "", 10);
      if (Number.isFinite(again)) {
        seedEverything(again);
      }
    }

    // THE BOT HAS TO BE PLAYING, or a skip fast-forwards through a fight nobody is fighting.
    //
    // Automation is off by default here - it is a button on the sidebar, and the harness turns it
    // on explicitly. Skipping without it produced exactly what it should have: 1550 ticks of Zuk
    // being ignored, so full hitpoints, no Jad, and a shield nothing had shot at.
    //
    // Implied by skipTo for that reason, and settable on its own with ?auto=1.
    const params2 = new URLSearchParams(window.location.search);
    const skipTo = parseInt(params2.get("skipTo") ?? "", 10);
    if (params2.get("auto") === "1" || (Number.isFinite(skipTo) && skipTo > 0)) {
      InfernoAutomation.setEnabled(true);
      console.log("automation enabled from the URL");
    }
    if (Number.isFinite(skipTo) && skipTo > 0) {
      const startedAt = performance.now();
      for (let tick = 0; tick < skipTo; tick++) {
        try {
          // EXACTLY WHAT browserLoop DOES PER TICK, and the countdown is the half that was
          // missing: it decrements getReadyTimer FIRST, and the region refuses to run its wave
          // while that is above zero. Calling tickWorld on its own left the timer pinned at 6, so
          // every skipped tick was a countdown tick and the wave never began - which is why the
          // arena came up untouched no matter how large the skip.
          if (world.getReadyTimer > 0) {
            world.getReadyTimer--;
          }
          world.tickWorld();
          // The client tick is where queued input matures - clicks, gear switches, the things the
          // automation issues. `browserLoop` drives it off a real 20ms timer, so a synchronous
          // skip never runs it and every action the bot took during the skip stayed queued.
          world.doClientTick();
        } catch (e) {
          console.error(`skipTo stopped at tick ${tick}: ${(e as Error)?.message ?? e}`);
          break;
        }
        // Nothing left alive means the fight ended before the requested tick - stop rather than
        // spin through thousands of empty ticks.
        if ((selectedRegion as unknown as { mobs?: unknown[] }).mobs?.length === 0 && tick > 50) {
          console.log(`skipTo: wave ended at tick ${tick}, before ${skipTo}`);
          break;
        }
      }
      // HAND BACK A CLOCK THAT HAS NOT MOVED, or the first frame plays catch-up.
      //
      // `browserLoop` ticks whenever `now - tickTimer >= 600`, and `doClientTick` runs up to FIFTY
      // client ticks in one go to make up a gap. After a skip those timers are however many
      // milliseconds old the loop took, so the first frame fires a burst of ticks and a wall of
      // client ticks at once - which is the spam, not the bot misbehaving.
      //
      // `startTicking` only re-stamps them when `deltaTimeSincePause` is -1, so that is set too.
      const nowAfterSkip = performance.now();
      world.tickTimer = nowAfterSkip;
      world.clientTickTimer = nowAfterSkip;
      world.then = nowAfterSkip;
      world.deltaTimeSincePause = -1;
      world.deltaTimeSinceLastTick = 0;

      const zuk = (selectedRegion as unknown as { mobs: { mobName(): string; currentStats?: { hitpoint: number } }[] })
        .mobs.find((mob) => mob.mobName() === "TzKal-Zuk");
      const shield = (selectedRegion as unknown as { mobs: { mobName(): string; currentStats?: { hitpoint: number } }[] })
        .mobs.find((mob) => mob.mobName() === "Inferno Shield");
      // Printed so the state can be checked against the harness at the same tick before anything
      // is concluded from watching it.
      console.log(
        `skipTo ${skipTo} done in ${Math.round(performance.now() - startedAt)}ms | ` +
          `zuk ${zuk?.currentStats?.hitpoint ?? "gone"} | shield ${shield?.currentStats?.hitpoint ?? "gone"} | ` +
          `player ${player.location.x},${player.location.y} hp ${player.currentStats.hitpoint} - live from here`,
      );
    }

    // Start the engine
    world.startTicking();
  }
}

/// /////////////////////////////////////////////////////////

// UI disclaimer
const topHeaderContainer = document.getElementById("disclaimer_panel");
topHeaderContainer.innerHTML = "Work in progress.<br />" + topHeaderContainer.innerHTML;
