"use strict";
import { BrowserUtils, ControlPanelController, Player, Region, Settings } from "osrs-sdk";

import { InfernoLoadout } from "../../inferno/js/InfernoLoadout";
import { FightCavesWallTile } from "./FightCavesWallTile";
import { FightCavesWaves } from "./FightCavesWaves";

import SidebarContent from "../sidebar.html";

const WAVE_COUNT = FightCavesWaves.waves.length;

/**
 * Fight Caves skeleton region: an empty arena (no map image, no pillars) running the same
 * wave-progression shape as Inferno but trimmed to FightCavesWaves' 5 waves. Reuses the
 * existing Inferno mob classes and InfernoLoadout for gear - see FightCavesWaves for why.
 *
 * Registered in src/index.ts's AVAILABLE_REGIONS, served from fightcaves.html.
 */
export class FightCavesRegion extends Region {
  wave: number;

  private waveCompleteTimer = -1; // -1 = not counting down, 0..N = ticks until next wave
  private lastMobCount = 0;
  private waveProgressionEnabled = false;
  private deathHandled = false;

  getName() {
    return "Fight Caves";
  }

  get width(): number {
    return 39;
  }

  get height(): number {
    return 39;
  }

  /**
   * Placeholder boundary - solid, differently-coloured tiles ringing the arena edge until the
   * real Fight Caves geometry exists. Top/bottom rows run the full width; the side columns skip
   * the corners, which the rows already cover.
   */
  private addBoundaryWalls() {
    for (let x = 0; x < this.width; x++) {
      this.addEntity(new FightCavesWallTile(this, { x, y: 0 }));
      this.addEntity(new FightCavesWallTile(this, { x, y: this.height - 1 }));
    }
    for (let y = 1; y < this.height - 1; y++) {
      this.addEntity(new FightCavesWallTile(this, { x: 0, y }));
      this.addEntity(new FightCavesWallTile(this, { x: this.width - 1, y }));
    }
  }

  private initializeAndGetLoadoutType() {
    const loadoutSelector = document.getElementById("loadouts") as HTMLInputElement;
    loadoutSelector.value = Settings.loadout;
    loadoutSelector.addEventListener("change", () => {
      Settings.loadout = loadoutSelector.value;
      Settings.persistToStorage();
    });
    return loadoutSelector.value;
  }

  private initializeAndGetOnTask() {
    const onTaskCheckbox = document.getElementById("onTask") as HTMLInputElement;
    onTaskCheckbox.checked = Settings.onTask;
    onTaskCheckbox.addEventListener("change", () => {
      Settings.onTask = onTaskCheckbox.checked;
      Settings.persistToStorage();
    });
    return onTaskCheckbox.checked;
  }

  initialiseRegion() {
    // Close to the NW corner on purpose: the camera is player-centred with no clamping to map
    // bounds, and its zoom is fixed to show the full arena WIDTH regardless of screen size - so
    // a player parked mid-arena in a 39x39 space can have every wall sitting well outside the
    // browser's actual (aspect-ratio-limited) vertical view. Starting near a corner keeps two
    // walls on screen immediately instead of requiring a walk to find them. Clear of every
    // FightCavesWaves spawn point - see that file's `spawns` list.
    const player = new Player(this, {
      x: parseInt(BrowserUtils.getQueryVar("x")) || 4,
      y: parseInt(BrowserUtils.getQueryVar("y")) || 4,
    });
    this.addPlayer(player);

    const loadoutType = this.initializeAndGetLoadoutType();
    const onTask = this.initializeAndGetOnTask();

    this.wave = parseInt(BrowserUtils.getQueryVar("wave"));
    if (isNaN(this.wave) || this.wave < 1) {
      this.wave = 1;
    }
    if (this.wave > WAVE_COUNT) {
      this.wave = WAVE_COUNT;
    }

    const loadout = new InfernoLoadout(this.wave, loadoutType, onTask);
    loadout.setStats(player);
    player.setUnitOptions(loadout.getLoadout());

    this.addBoundaryWalls();

    this.spawnWave(player, this.wave);

    const waveInput = document.getElementById("waveinput") as HTMLInputElement;
    document.getElementById("playWaveNum").addEventListener("click", () => {
      window.location.href = `${window.location.pathname}?wave=${waveInput.value || this.wave}`;
    });

    document
      .getElementById("pauseResumeLink")
      .addEventListener("click", () => (this.world.isPaused ? this.world.startTicking() : this.world.stopTicking()));

    waveInput.addEventListener("focus", () => (ControlPanelController.controller.isUsingExternalUI = true));
    waveInput.addEventListener("focusout", () => (ControlPanelController.controller.isUsingExternalUI = false));

    player.perceivedLocation = player.location;
    player.destinationLocation = player.location;

    return { player };
  }

  private spawnWave(player: Player, wave: number) {
    const spawns = FightCavesWaves.getRandomSpawns();
    FightCavesWaves.spawn(this, player, spawns, wave).forEach(this.addMob.bind(this));

    const waveInput = document.getElementById("waveinput") as HTMLInputElement;
    if (waveInput) {
      waveInput.value = String(wave);
    }
  }

  private handleWaveProgression() {
    this.waveProgressionEnabled =
      this.wave >= 1 && this.wave < WAVE_COUNT && (document.getElementById("waveProgression") as HTMLInputElement)?.checked;

    if (!this.waveProgressionEnabled) {
      return;
    }

    const currentMobCount = this.mobs.filter((mob) => mob.dying === -1).length;

    if (currentMobCount === 0 && this.lastMobCount > 0 && this.waveCompleteTimer === -1) {
      this.waveCompleteTimer = 9;
    }

    if (this.waveCompleteTimer > 0 && currentMobCount > 0) {
      // New mobs appeared during the countdown (e.g. a delayed split) - cancel it.
      this.waveCompleteTimer = -1;
    }

    if (this.waveCompleteTimer > 0) {
      this.waveCompleteTimer--;
      if (this.waveCompleteTimer === 0) {
        this.wave++;
        this.spawnWave(this.players[0], this.wave);
        this.waveCompleteTimer = -1;
      }
    }

    this.lastMobCount = currentMobCount;
  }

  postTick() {
    super.postTick();

    const player = this.players[0];
    if (player && player.isDying()) {
      if (!this.deathHandled) {
        this.deathHandled = true;
        document.getElementById("death_modal").classList.remove("hidden");
      }
    } else {
      this.deathHandled = false;
    }

    this.handleWaveProgression();

    const readout = document.getElementById("player_tile");
    if (readout && player) {
      readout.innerText = `Tile: ${player.location.x}, ${player.location.y}`;
    }
  }

  getSidebarContent() {
    return SidebarContent;
  }
}
