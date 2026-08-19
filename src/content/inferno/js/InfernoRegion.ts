"use strict";
import { BrowserUtils, CardinalDirection, ControlPanelController, Entity, EntityNames, ImageLoader, InvisibleMovementBlocker, Location, Mob, Player, Region, Settings, TileMarker, Trainer, Viewport } from "osrs-sdk";

import InfernoMapImage from "../assets/images/map.png";

import { filter, shuffle } from "lodash";
import { InfernoLoadout } from "./InfernoLoadout";
import { InfernoMobDeathStore } from "./InfernoMobDeathStore";
import { InfernoPillar } from "./InfernoPillar";
import { InfernoScene } from "./InfernoScene";
import { InfernoSettings } from "./InfernoSettings";
import { InfernoWaves } from "./InfernoWaves";
import { JalAk } from "./mobs/JalAk";
import { JalAkRekKet } from "./mobs/JalAkRekKet";
import { JalAkRekMej } from "./mobs/JalAkRekMej";
import { JalAkRekXil } from "./mobs/JalAkRekXil";
import { JalImKot } from "./mobs/JalImKot";
import { JalMejRah } from "./mobs/JalMejRah";
import { JalTokJad } from "./mobs/JalTokJad";
import { JalXil } from "./mobs/JalXil";
import { JalZek } from "./mobs/JalZek";
import { TzKalZuk } from "./mobs/TzKalZuk";
import { Wall } from "./Wall";
import { ZukShield, type ShieldDirection } from "./ZukShield";
import { AutomationOverlay } from "./AutomationOverlay";
import { DebugPanel } from "./DebugPanel";
import { InfernoAutomation } from "./InfernoAutomation";
import { canReach } from "./KillPriority";
import { TileGrid } from "./TileGrid";
import { PlayerAttackClock } from "./PlayerAttackClock";
import { ShieldAttackerClock } from "./ShieldAttackerClock";
import { ZukAttackClock } from "./ZukAttackClock";
import { ZukSetTimer } from "./ZukSetTimer";
import { ZukSimPanel } from "./ZukSimPanel";
import { observeNibblers } from "./PillarDefence";
import { distanceToNearestMob, GRID_SIZE, isInsideArena, lastScoreDurationMs, scoreCandidates } from "./TileScorer";

import SidebarContent from "../sidebar.html";

/* eslint-disable @typescript-eslint/no-explicit-any */

export class InfernoRegion extends Region {
  wave: number;
  mapImage: HTMLImageElement = ImageLoader.createImage(InfernoMapImage);

  // Wave progression properties
  private waveCompleteTimer = -1; // -1 = not triggered, 0-7 = countdown to next wave
  private lastMobCount = 0;
  private waveProgressionEnabled = false;

  // Spawn indicator entities
  private spawnIndicators: Entity[] = [];

  private deathHandled = false;

  // Debug panel logging state. Only touched while the panel is open.
  private debugTick = 0;
  private debugLastTile: string | null = null;
  private debugArrivedTick = 0;
  private debugSeenProjectiles = new WeakSet<object>();

  get initialFacing() {
    return this.wave === 69 ? CardinalDirection.NORTH : CardinalDirection.SOUTH;
  }

  getName() {
    return "Inferno";
  }

  get width(): number {
    return 51;
  }

  get height(): number {
    return 57;
  }

  rightClickActions(): any[] {
    if (this.wave !== 0) {
      return [];
    }

    return [
      {
        text: [
          { text: "Spawn ", fillStyle: "white" },
          { text: "Bat", fillStyle: "blue" },
        ],
        action: () => {
          Trainer.clickController.yellowClick();
          const x = Viewport.viewport.contextMenu.destinationLocation.x;
          const y = Viewport.viewport.contextMenu.destinationLocation.y;
          const mob = new JalMejRah(this, { x, y }, { aggro: Trainer.player });
          mob.removableWithRightClick = true;
          this.addMob(mob);
        },
      },

      {
        text: [
          { text: "Spawn ", fillStyle: "white" },
          { text: "Blob", fillStyle: "green" },
        ],
        action: () => {
          Trainer.clickController.yellowClick();
          const x = Viewport.viewport.contextMenu.destinationLocation.x;
          const y = Viewport.viewport.contextMenu.destinationLocation.y;
          const mob = new JalAk(this, { x, y }, { aggro: Trainer.player });
          mob.removableWithRightClick = true;
          this.addMob(mob);
        },
      },

      {
        text: [
          { text: "Spawn ", fillStyle: "white" },
          { text: "Meleer", fillStyle: "yellow" },
        ],
        action: () => {
          Trainer.clickController.yellowClick();
          const x = Viewport.viewport.contextMenu.destinationLocation.x;
          const y = Viewport.viewport.contextMenu.destinationLocation.y;
          const mob = new JalImKot(this, { x, y }, { aggro: Trainer.player });
          mob.removableWithRightClick = true;
          this.addMob(mob);
        },
      },

      {
        text: [
          { text: "Spawn ", fillStyle: "white" },
          { text: "Ranger", fillStyle: "orange" },
        ],
        action: () => {
          Trainer.clickController.yellowClick();
          const x = Viewport.viewport.contextMenu.destinationLocation.x;
          const y = Viewport.viewport.contextMenu.destinationLocation.y;
          const mob = new JalXil(this, { x, y }, { aggro: Trainer.player });
          mob.removableWithRightClick = true;
          this.addMob(mob);
        },
      },

      {
        text: [
          { text: "Spawn ", fillStyle: "white" },
          { text: "Mager", fillStyle: "red" },
        ],
        action: () => {
          Trainer.clickController.yellowClick();
          const x = Viewport.viewport.contextMenu.destinationLocation.x;
          const y = Viewport.viewport.contextMenu.destinationLocation.y;
          const mob = new JalZek(this, { x, y }, { aggro: Trainer.player });
          mob.removableWithRightClick = true;
          this.addMob(mob);
        },
      },
    ];
  }

  initializeAndGetLoadoutType() {
    const loadoutSelector = document.getElementById("loadouts") as HTMLInputElement;
    loadoutSelector.value = Settings.loadout;
    loadoutSelector.addEventListener("change", () => {
      Settings.loadout = loadoutSelector.value;
      Settings.persistToStorage();
    });

    return loadoutSelector.value;
  }

  initializeAndGetOnTask() {
    const onTaskCheckbox = document.getElementById("onTask") as HTMLInputElement;
    onTaskCheckbox.checked = Settings.onTask;
    onTaskCheckbox.addEventListener("change", () => {
      Settings.onTask = onTaskCheckbox.checked;
      Settings.persistToStorage();
    });
    return onTaskCheckbox.checked;
  }

  initializeAndGetSouthPillar() {
    const southPillarCheckbox = document.getElementById("southPillar") as HTMLInputElement;
    southPillarCheckbox.checked = Settings.southPillar;
    southPillarCheckbox.addEventListener("change", () => {
      Settings.southPillar = southPillarCheckbox.checked;
      Settings.persistToStorage();
    });
    return southPillarCheckbox.checked;
  }

  initializeAndGetWestPillar() {
    const westPillarCheckbox = document.getElementById("westPillar") as HTMLInputElement;
    westPillarCheckbox.checked = Settings.westPillar;
    westPillarCheckbox.addEventListener("change", () => {
      Settings.westPillar = westPillarCheckbox.checked;
      Settings.persistToStorage();
    });
    return westPillarCheckbox.checked;
  }

  initializeAndGetNorthPillar() {
    const northPillarCheckbox = document.getElementById("northPillar") as HTMLInputElement;
    northPillarCheckbox.checked = Settings.northPillar;
    northPillarCheckbox.addEventListener("change", () => {
      Settings.northPillar = northPillarCheckbox.checked;
      Settings.persistToStorage();
    });
    return northPillarCheckbox.checked;
  }

  initializeAndGetShieldDirection(): ShieldDirection {
    const directionSelect = document.getElementById("shieldDirection") as HTMLInputElement;
    directionSelect.value = InfernoSettings.shieldDirection;
    directionSelect.addEventListener("change", () => {
      InfernoSettings.shieldDirection = directionSelect.value as ShieldDirection;
      InfernoSettings.persistToStorage();
      window.location.reload();
    });
    return directionSelect.value as ShieldDirection;
  }

  initializeAndGetUse3dView() {
    const use3dViewCheckbox = document.getElementById("use3dView") as HTMLInputElement;
    use3dViewCheckbox.checked = Settings.use3dView;
    use3dViewCheckbox.addEventListener("change", () => {
      Settings.use3dView = use3dViewCheckbox.checked;
      Settings.persistToStorage();
      window.location.reload();
    });
    return use3dViewCheckbox.checked;
  }

  initializeWaveProgressionToggle() {
    const waveProgressionCheckbox = document.getElementById("waveProgression") as HTMLInputElement;
    waveProgressionCheckbox.checked = InfernoSettings.waveProgression === true;
    waveProgressionCheckbox.addEventListener("change", () => {
      InfernoSettings.waveProgression = waveProgressionCheckbox.checked;
      InfernoSettings.persistToStorage();
    });
  }

  initializeSpawnIndicatorsToggle() {
    const spawnIndicatorsCheckbox = document.getElementById("spawnIndicators") as HTMLInputElement;
    spawnIndicatorsCheckbox.checked = InfernoSettings.spawnIndicators === true;
    spawnIndicatorsCheckbox.addEventListener("change", () => {
      InfernoSettings.spawnIndicators = spawnIndicatorsCheckbox.checked;
      InfernoSettings.persistToStorage();
      // Update current spawn indicators visibility
      if (!InfernoSettings.spawnIndicators) {
        this.clearSpawnIndicators();
      } else {
        // Refresh spawn indicators if enabled
        const spawns = InfernoWaves.getRandomSpawns();
        this.updateSpawnIndicators(spawns);
      }
    });
  }

  initializeDisplaySetTimerToggle() {
    const displaySetTimerCheckbox = document.getElementById("displaySetTimer") as HTMLInputElement;
    displaySetTimerCheckbox.checked = InfernoSettings.displaySetTimer === true;
    displaySetTimerCheckbox.addEventListener("change", () => {
      InfernoSettings.displaySetTimer = displaySetTimerCheckbox.checked;
      InfernoSettings.persistToStorage();
    });
  }

  initialiseRegion() {
    const automationButton = document.getElementById("toggleAutomation") as HTMLButtonElement;

    // Copies the whole visible log to the clipboard, since selecting inside a scrolled <pre>
    // is fiddly and the interesting part is usually a long run of ticks.
    const copyLogButton = document.getElementById("copyAutomationLog") as HTMLButtonElement;
    copyLogButton?.addEventListener("click", () => {
      const text = InfernoAutomation.getLog();
      navigator.clipboard?.writeText(text).then(
        () => {
          copyLogButton.innerText = "Copied";
          setTimeout(() => (copyLogButton.innerText = "Copy"), 1200);
        },
        () => undefined,
      );
    });

    // Mouse blocking is its own switch. Enabling automation turns it on as the sane default,
    // but does not own it - untick it mid-run to take the mouse back while the bot carries on
    // praying and the grid carries on showing what it would have chosen.
    const blockMouseCheckbox = document.getElementById("blockMouseInput") as HTMLInputElement;
    blockMouseCheckbox?.addEventListener("change", () => {
      AutomationOverlay.setInputBlocked(blockMouseCheckbox.checked);
    });

    // Keeps the label correct however automation was stopped, including via Escape.
    InfernoAutomation.setEnabledListener((enabled) => {
      automationButton.innerText = enabled ? "Disable Automation" : "Enable Automation";
      automationButton.classList.toggle("enabled", enabled);
      if (enabled && blockMouseCheckbox) {
        blockMouseCheckbox.checked = true;
      }
      AutomationOverlay.setInputBlocked(blockMouseCheckbox?.checked ?? true);
    });
    automationButton?.addEventListener("click", () => {
      InfernoAutomation.setEnabled(!InfernoAutomation.isEnabled());
    });

    // Prayer flicking with nothing else attached - the mouse stays yours, so this is the mode
    // for walking a scenario by hand without losing the wave to a missed overhead. Independent
    // of the automation button rather than exclusive with it: full automation already prays, so
    // it just overrides this while on, and this takes back over when it is switched off.
    const prayerOnlyButton = document.getElementById("togglePrayerOnly") as HTMLButtonElement;
    prayerOnlyButton?.addEventListener("click", () => {
      const next = !InfernoAutomation.isPrayerOnly();
      InfernoAutomation.setPrayerOnly(next);
      prayerOnlyButton.innerText = next ? "Disable Prayer" : "Enable Prayer";
      prayerOnlyButton.classList.toggle("enabled", next);
    });

    // The tile grid is a view, not a behaviour - it works with automation off, so the
    // candidate set can be inspected while walking around by hand.
    const tileGridCheckbox = document.getElementById("showTileGrid") as HTMLInputElement;
    tileGridCheckbox?.addEventListener("change", () => {
      TileGrid.setVisible(tileGridCheckbox.checked);
    });

    // The Zuk timeline strip - a view like the two above, and for now a static one. It draws
    // placeholder marks until the lanes are wired, so it is safe to leave on while working.
    const zukSimCheckbox = document.getElementById("showZukSim") as HTMLInputElement;
    zukSimCheckbox?.addEventListener("change", () => {
      ZukSimPanel.setVisible(zukSimCheckbox.checked);
    });
    window.addEventListener("resize", () => ZukSimPanel.onResize());

    // Same reasoning as the tile grid - a view, works with automation off.
    const debugPanelButton = document.getElementById("toggleDebugPanel") as HTMLButtonElement;
    debugPanelButton?.addEventListener("click", () => {
      DebugPanel.toggle();
    });

    // Snapshot of exactly what the scorer saw, as JSON, for reading outside the sim.
    //
    // Reuses this tick's scores when automation has already computed them and scores fresh
    // otherwise, so it works with automation off - same fallback the tile grid uses. `source`
    // records which, because "the numbers the bot acted on" and "the numbers as of this click"
    // are not the same claim.
    //
    // Tiles are rows against a `columns` header rather than 441 repeated key sets, purely for
    // size - the full grid is unusable as pretty-printed objects.
    const dumpButton = document.getElementById("dumpScores") as HTMLButtonElement;
    dumpButton?.addEventListener("click", () => {
      const current = this.players[0];
      if (!current) {
        return;
      }

      const fromAutomation = InfernoAutomation.getScoredTiles();
      const scored = fromAutomation.length > 0 ? fromAutomation : scoreCandidates(this, current);
      const round = (value: number) => Math.round(value * 1000) / 1000;

      const dump = {
        source: fromAutomation.length > 0 ? "automation" : "fresh",
        player: { x: current.location.x, y: current.location.y },
        chosenTile: InfernoAutomation.getChosenTile(),
        mobs: this.mobs.map((mob: any) => ({
          name: mob.mobName(),
          x: mob.location.x,
          y: mob.location.y,
          size: mob.size,
          hp: mob.currentStats?.hitpoint,
          maxHit: mob.maxHit,
          attackDelay: mob.attackDelay,
          attackSpeed: mob.attackSpeed,
          attackRange: mob.attackRange,
          hasLOS: mob.hasLOS,
          stunned: mob.stunned ?? 0,
          frozen: mob.frozen ?? 0,
          dying: mob.dying,
          aggro: mob.aggro === current ? "player" : mob.aggro ? "other" : null,
        })),
        columns: [
          "x",
          "y",
          "score",
          "barrage",
          "blob",
          "healer",
          "reach",
          "quiet",
          "los",
          "safe",
          "home",
          "shield",
          "lead",
          "zukReach",
          "tagReach",
          "sortie",
          "damage",
          "threats",
          "routeLen",
        ],
        tiles: scored.map((entry) => [
          entry.tile.x,
          entry.tile.y,
          round(entry.score),
          entry.parts ? round(entry.parts.barrageReach) : null,
          entry.parts ? round(entry.parts.blobletReach) : null,
          entry.parts ? round(entry.parts.healerReach) : null,
          entry.parts ? round(entry.parts.npcReachSoon) : null,
          entry.parts ? round(entry.parts.quietTicks) : null,
          entry.parts ? round(entry.parts.losBonus) : null,
          entry.parts ? round(entry.parts.safeSpot) : null,
          entry.parts ? round(entry.parts.homePull) : null,
          entry.parts ? round(entry.parts.shieldPenalty) : null,
          entry.parts ? round(entry.parts.shieldLead) : null,
          entry.parts ? round(entry.parts.zukReach) : null,
          entry.parts ? round(entry.parts.tagReach) : null,
          entry.parts ? round(entry.parts.sortie) : null,
          entry.parts ? round(entry.parts.damageTaken) : null,
          entry.parts ? entry.parts.threats : null,
          entry.route.length,
        ]),
      };

      // eslint-disable-next-line no-console
      console.log(dump);
      navigator.clipboard?.writeText(JSON.stringify(dump)).then(
        () => {
          dumpButton.innerText = "Copied";
          setTimeout(() => (dumpButton.innerText = "Dump Scores"), 1200);
        },
        () => undefined,
      );
    });

    // Same mechanism as the New Wave button below - a full page navigation, so the whole region
    // reinitialises fresh from initialiseRegion() rather than trying to patch live state. NOT
    // wave=0 - that is the build/editor state (see importSpawn), not a real playable wave.
    // Instead this is the backwards-compatibility custom-mob path a few lines down: any of
    // bat/blob/melee/ranger/mager/akrekmej/akrekxil/akrekket being non-empty forces this.wave = 1, a
    // genuine live wave, then spawns exactly those mobs. nibblers=false keeps the board to just
    // the mobs named here.
    //
    // Edit the coordinates below directly to test a different setup. [x,y] values are offset by
    // (-11,-14) from the actual tile - importSpawn adds that back - matching the export/import
    // convention "Edit Wave"/"Play Wave" already use.
    const customScenarioButton = document.getElementById("customScenario") as HTMLButtonElement;
    customScenarioButton?.addEventListener("click", () => {
      const akrekxil = JSON.stringify([[17, 8]]); // tile 28,22 (front, closer to player)
      const akrekmej = JSON.stringify([[17, 9]]); // tile 28,23 (back, further from player)
      window.location.href = `/?wave=1&akrekxil=${akrekxil}&akrekmej=${akrekmej}&nibblers=false`;
    });

    // The same safe-spot scenario, but with full size mobs instead of size 1 bloblets.
    //
    // The anchors look further south than the bloblet ones and are not: a mob's footprint runs
    // EAST and NORTH from its location tile (x..x+size-1, y-size+1..y - see ArenaSnapshot), and
    // north is toward the player here, since y increases southward. So a size 3 ranger anchored
    // at 28,24 actually occupies y 22..24 - its player-facing edge lands on 28,22, exactly where
    // the bloblet ranger stood. Anchoring it at 28,22 like the bloblet would push its footprint
    // up into y 20..22 and straight through the north pillar (x 28..30, y 19..21), which is a
    // collision, not a spawn.
    //
    // Ranger size 3 -> y 22..24, mager size 4 -> y 25..28, so they stack without overlapping.
    //
    // ONE HONEST DIFFERENCE from the bloblet version: the pillar is 3 wide and the mager is 4,
    // so the mager cannot be fully hidden behind it at any alignment - expect it to have partial
    // line of sight the bloblet never had. That is geometry, not a setup mistake, and it is worth
    // eyeballing before treating this as a like-for-like replica.
    const customScenario2Button = document.getElementById("customScenario2") as HTMLButtonElement;
    customScenario2Button?.addEventListener("click", () => {
      const ranger = JSON.stringify([[17, 10]]); // anchor 28,24 -> occupies x 28..30, y 22..24
      const mager = JSON.stringify([[17, 14]]); // anchor 28,28 -> occupies x 28..31, y 25..28
      window.location.href = `/?wave=1&ranger=${ranger}&mager=${mager}&nibblers=false`;
    });

    // Wave 2 with the two mobs swapped: mager in front, ranger behind.
    //
    // NOT a swap of the two arrays above. Anchors are size-dependent, so trading them directly
    // would put the size 4 mager on 28,24, whose footprint runs north into y 21 - inside the
    // pillar (x 28..30, y 19..21) - and it would not spawn at all. Each anchor is recomputed
    // from its own mob's size to land the same player-facing edge:
    //
    //   mager  size 4, front -> anchor 28,25, occupies x 28..31, y 22..25
    //   ranger size 3, back  -> anchor 28,28, occupies x 28..30, y 26..28
    //
    // Same 7 tile deep block as wave 2 (y 22..28) with the same front face on y 22, so the two
    // are directly comparable - only the order within the block differs.
    //
    // EXPECT MORE LEAKAGE THAN WAVE 2, for two compounding reasons. The over-wide mob is now the
    // near one, so the tile the pillar most needs to cover is the one it cannot; and the mager
    // hits for 70 against the ranger's much lower max, so the mob most likely to have sight is
    // also the expensive one. This is the harsher of the two orderings, deliberately.
    const customScenario3Button = document.getElementById("customScenario3") as HTMLButtonElement;
    customScenario3Button?.addEventListener("click", () => {
      const mager = JSON.stringify([[17, 11]]); // anchor 28,25 -> occupies x 28..31, y 22..25
      const ranger = JSON.stringify([[17, 14]]); // anchor 28,28 -> occupies x 28..30, y 26..28
      window.location.href = `/?wave=1&ranger=${ranger}&mager=${mager}&nibblers=false`;
    });

    // Replica of a stuck state found by the headless harness: a lone blob at 18,36, hugging
    // the west face of the south pillar (x 21..23, y 35..37), that the bot never landed a hit
    // on - it was at 40 hp, which IS a blob's full health - while the player prayed to zero
    // holding 23,23. The pillar plausibly denies LOS from that hold, and the bot never walks
    // around it; this button exists to watch that live.
    //
    // One knowing difference, because the URL cannot carry it: the player starts on the home
    // tile (this path pins the start to 28,17) rather than at 23,23. The blob's tile is exact.
    // Anchor 18,36 with size 3 occupies x 18..20, y 34..36 - adjacent to the pillar, not
    // inside it. [7, 22] is (18,36) minus the (11,14) export offset.
    const customScenario4Button = document.getElementById("customScenario4") as HTMLButtonElement;
    customScenario4Button?.addEventListener("click", () => {
      const blob = JSON.stringify([[7, 22]]); // anchor 18,36 -> occupies x 18..20, y 34..36
      window.location.href = `/?wave=1&blob=${blob}&nibblers=false`;
    });

    // Another harness capture, prayer drained to 0 with both mobs at full health: a blob
    // tucked directly behind the north pillar (x 28..30, y 19..21) and a bat just west of it,
    // with the player one tile off the home spot. The blob's anchor 28,24 puts its footprint
    // (x 28..30, y 22..24) flush against the pillar's south face, so from the home area it is
    // entirely in pillar shadow - the bat at 26,20 (x 26..27, y 19..20) hugs the pillar's west
    // flank. Player position is one tile off the capture (28,18 vs the pinned 28,17); close
    // enough that the sightlines are the same.
    const customScenario5Button = document.getElementById("customScenario5") as HTMLButtonElement;
    customScenario5Button?.addEventListener("click", () => {
      const blob = JSON.stringify([[17, 10]]); // anchor 28,24 -> occupies x 28..30, y 22..24
      const bat = JSON.stringify([[15, 6]]); // anchor 26,20 -> occupies x 26..27, y 19..20
      window.location.href = `/?wave=1&blob=${blob}&bat=${bat}&nibblers=false`;
    });

    const waveInput: HTMLInputElement = document.getElementById("waveinput") as HTMLInputElement;


    const exportWaveInput: HTMLButtonElement = document.getElementById("exportCustomWave") as HTMLButtonElement;
    const editWaveInput: HTMLButtonElement = document.getElementById("editWave") as HTMLButtonElement;

    editWaveInput.addEventListener("click", () => {
      const magers = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_ZEK;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const rangers = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_XIL;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const meleers = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_IM_KOT;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const blobs = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_AK;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const bats = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_MEJ_RAJ;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const url = `/?wave=0&mager=${JSON.stringify(magers)}&ranger=${JSON.stringify(
        rangers,
      )}&melee=${JSON.stringify(meleers)}&blob=${JSON.stringify(blobs)}&bat=${JSON.stringify(bats)}&copyable`;
      window.location.href = url;
    });
    exportWaveInput.addEventListener("click", () => {
      const magers = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_ZEK;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const rangers = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_XIL;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const meleers = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_IM_KOT;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const blobs = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_AK;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const bats = filter(this.mobs, (mob: Mob) => {
        return mob.mobName() === EntityNames.JAL_MEJ_RAJ;
      }).map((mob: Mob) => {
        return [mob.location.x - 11, mob.location.y - 14];
      });

      const url = `/?wave=74&mager=${JSON.stringify(magers)}&ranger=${JSON.stringify(rangers)}&melee=${JSON.stringify(
        meleers,
      )}&blob=${JSON.stringify(blobs)}&bat=${JSON.stringify(bats)}&copyable`;
      window.location.href = url;
    });

    // create player
    const player = new Player(this, {
      x: parseInt(BrowserUtils.getQueryVar("x")) || 25,
      y: parseInt(BrowserUtils.getQueryVar("y")) || 25,
    });

    this.addPlayer(player);

    const loadoutType = this.initializeAndGetLoadoutType();
    const onTask = this.initializeAndGetOnTask();
    const southPillar = this.initializeAndGetSouthPillar();
    const westPillar = this.initializeAndGetWestPillar();
    const northPillar = this.initializeAndGetNorthPillar();

    this.initializeAndGetUse3dView();
    this.initializeWaveProgressionToggle();
    this.initializeSpawnIndicatorsToggle();
    this.initializeDisplaySetTimerToggle();
    this.wave = parseInt(BrowserUtils.getQueryVar("wave"));

    if (isNaN(this.wave)) {
      this.wave = 62;
    }
    if (this.wave < 0) {
      this.wave = 0;
    }
    if (this.wave > InfernoWaves.waves.length + 8) {
      this.wave = InfernoWaves.waves.length + 8;
    }

    const loadout = new InfernoLoadout(this.wave, loadoutType, onTask);
    loadout.setStats(player); // flip this around one day
    player.setUnitOptions(loadout.getLoadout());

    if (this.wave < 67 || this.wave >= 70) {
      // Add pillars
      InfernoPillar.addPillarsToWorld(this, southPillar, westPillar, northPillar);
    }

    const randomPillar = (shuffle(this.entities.filter((entity) => entity.entityName() === EntityNames.PILLAR)) || [
      null,
    ])[0]; // Since we've only added pillars this is safe. Do not move to after movement blockers.

    for (let x = 10; x < 41; x++) {
      this.addEntity(new InvisibleMovementBlocker(this, { x, y: 13 }));
      this.addEntity(new InvisibleMovementBlocker(this, { x, y: 44 }));
    }
    for (let y = 14; y < 44; y++) {
      this.addEntity(new InvisibleMovementBlocker(this, { x: 10, y }));
      this.addEntity(new InvisibleMovementBlocker(this, { x: 40, y }));
    }

    const bat = BrowserUtils.getQueryVar("bat") || "[]";
    const blob = BrowserUtils.getQueryVar("blob") || "[]";
    const melee = BrowserUtils.getQueryVar("melee") || "[]";
    const ranger = BrowserUtils.getQueryVar("ranger") || "[]";
    const mager = BrowserUtils.getQueryVar("mager") || "[]";
    const akrekmej = BrowserUtils.getQueryVar("akrekmej") || "[]";
    const akrekxil = BrowserUtils.getQueryVar("akrekxil") || "[]";
    const akrekket = BrowserUtils.getQueryVar("akrekket") || "[]";
    // Defaults to spawning, same as every existing link that predates this param - only an
    // explicit "false" turns them off.
    const nibblers = BrowserUtils.getQueryVar("nibblers") !== "false";
    const replayLink = document.getElementById("replayLink") as HTMLLinkElement;

    function importSpawn(region: Region) {
      try {
        JSON.parse(mager).forEach((spawn: number[]) =>
          region.addMob(new JalZek(region, { x: spawn[0] + 11, y: spawn[1] + 14 }, { aggro: player })),
        );
        JSON.parse(ranger).forEach((spawn: number[]) =>
          region.addMob(new JalXil(region, { x: spawn[0] + 11, y: spawn[1] + 14 }, { aggro: player })),
        );
        JSON.parse(melee).forEach((spawn: number[]) =>
          region.addMob(new JalImKot(region, { x: spawn[0] + 11, y: spawn[1] + 14 }, { aggro: player })),
        );
        JSON.parse(blob).forEach((spawn: number[]) =>
          region.addMob(new JalAk(region, { x: spawn[0] + 11, y: spawn[1] + 14 }, { aggro: player })),
        );
        JSON.parse(bat).forEach((spawn: number[]) =>
          region.addMob(new JalMejRah(region, { x: spawn[0] + 11, y: spawn[1] + 14 }, { aggro: player })),
        );
        JSON.parse(akrekmej).forEach((spawn: number[]) =>
          region.addMob(
            new JalAkRekMej(region, { x: spawn[0] + 11, y: spawn[1] + 14 }, { aggro: player, cooldown: 4 }),
          ),
        );
        JSON.parse(akrekxil).forEach((spawn: number[]) =>
          region.addMob(
            new JalAkRekXil(region, { x: spawn[0] + 11, y: spawn[1] + 14 }, { aggro: player, cooldown: 4 }),
          ),
        );
        JSON.parse(akrekket).forEach((spawn: number[]) =>
          region.addMob(
            new JalAkRekKet(region, { x: spawn[0] + 11, y: spawn[1] + 14 }, { aggro: player, cooldown: 4 }),
          ),
        );

        if (nibblers) {
          InfernoWaves.spawnNibblers(3, region, randomPillar).forEach(region.addMob.bind(region));
        }

        replayLink.href = `/${window.location.search}`;
      } catch (ex) {
        console.log("failed to import wave from inferno stats", ex);
      }
    }
    // Optional custom start tile from the `x`/`y` query params - RAW arena coordinates, no
    // (-11,-14) offset, because these are the very params the replay link already emits and
    // the Player constructor already reads; the wave branches below used to overwrite them
    // with the home tile unconditionally. Outside the arena (or absent) falls back to home.
    // Waves 67-69 ignore this: those fights have fixed starting spots.
    const startQueryX = parseInt(BrowserUtils.getQueryVar("x"));
    const startQueryY = parseInt(BrowserUtils.getQueryVar("y"));
    const customStart =
      !isNaN(startQueryX) && !isNaN(startQueryY) && isInsideArena(startQueryX, startQueryY)
        ? { x: startQueryX, y: startQueryY }
        : null;

    // Add mobs
    if (this.wave === 0) {
      // world.getReadyTimer = 0;
      player.location = customStart ?? { x: 28, y: 17 };
      this.world.getReadyTimer = -1;

      // Clear death store when starting any wave
      InfernoMobDeathStore.clearDeadMobs();

      // Use our spawn indicator system instead of manual tile markers
      const spawns = InfernoWaves.getRandomSpawns();
      this.updateSpawnIndicators(spawns);

      importSpawn(this);
    } else if (this.wave < 67) {
      player.location = customStart ?? { x: 28, y: 17 };
      if (
        bat != "[]" ||
        blob != "[]" ||
        melee != "[]" ||
        ranger != "[]" ||
        mager != "[]" ||
        akrekmej != "[]" ||
        akrekxil != "[]" ||
        akrekket != "[]"
      ) {
        // Backwards compatibility layer for runelite plugin
        this.wave = 1;

        // Clear death store when starting any wave
        InfernoMobDeathStore.clearDeadMobs();

        importSpawn(this);
      } else {
        // Native approach
        const customSpawns = BrowserUtils.getQueryVar("spawns")
          ? JSON.parse(decodeURIComponent(BrowserUtils.getQueryVar("spawns")))
          : undefined;

        this.spawnRegularWave(player, randomPillar, customSpawns);
      }
    } else if (this.wave === 67) {
      // Clear death store when starting special waves
      InfernoMobDeathStore.clearDeadMobs();
      this.removePillars();

      player.location = { x: 18, y: 25 };
      const jad = new JalTokJad(
        this,
        { x: 23, y: 27 },
        { aggro: player, attackSpeed: 8, stun: 1, healers: 5, isZukWave: false },
      );
      this.addMob(jad);
    } else if (this.wave === 68) {
      // Clear death store when starting special waves
      InfernoMobDeathStore.clearDeadMobs();
      this.removePillars();

      player.location = { x: 25, y: 27 };

      const stunTimers = [1, 4, 7].sort(() => 0.5 - Math.random());

      const jad1 = new JalTokJad(
        this,
        { x: 18, y: 24 },
        { aggro: player, attackSpeed: 9, stun: stunTimers[0], healers: 3, isZukWave: false },
      );
      this.addMob(jad1);

      const jad2 = new JalTokJad(
        this,
        { x: 28, y: 24 },
        { aggro: player, attackSpeed: 9, stun: stunTimers[1], healers: 3, isZukWave: false },
      );
      this.addMob(jad2);

      const jad3 = new JalTokJad(
        this,
        { x: 23, y: 35 },
        { aggro: player, attackSpeed: 9, stun: stunTimers[2], healers: 3, isZukWave: false },
      );
      this.addMob(jad3);
    } else if (this.wave === 69) {
      // Clear death store when starting special waves
      InfernoMobDeathStore.clearDeadMobs();
      this.removePillars();

      player.location = { x: 25, y: 15 };

      // spawn zuk
      const shieldDirection = this.initializeAndGetShieldDirection();
      const shield = new ZukShield(this, { x: 23, y: 13 }, { aggro: player }, shieldDirection);
      this.addMob(shield);

      this.addMob(new TzKalZuk(this, { x: 22, y: 8 }, { aggro: player }));

      this.addEntity(new Wall(this, { x: 21, y: 8 }));
      this.addEntity(new Wall(this, { x: 21, y: 7 }));
      this.addEntity(new Wall(this, { x: 21, y: 6 }));
      this.addEntity(new Wall(this, { x: 21, y: 5 }));
      this.addEntity(new Wall(this, { x: 21, y: 4 }));
      this.addEntity(new Wall(this, { x: 21, y: 3 }));
      this.addEntity(new Wall(this, { x: 21, y: 2 }));
      this.addEntity(new Wall(this, { x: 21, y: 1 }));
      this.addEntity(new Wall(this, { x: 21, y: 0 }));
      this.addEntity(new Wall(this, { x: 29, y: 8 }));
      this.addEntity(new Wall(this, { x: 29, y: 7 }));
      this.addEntity(new Wall(this, { x: 29, y: 6 }));
      this.addEntity(new Wall(this, { x: 29, y: 5 }));
      this.addEntity(new Wall(this, { x: 29, y: 4 }));
      this.addEntity(new Wall(this, { x: 29, y: 3 }));
      this.addEntity(new Wall(this, { x: 29, y: 2 }));
      this.addEntity(new Wall(this, { x: 29, y: 1 }));
      this.addEntity(new Wall(this, { x: 29, y: 0 }));

      this.addEntity(new TileMarker(this, { x: 14, y: 14 }, "#00FF00", 1, false));

      this.addEntity(new TileMarker(this, { x: 16, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 17, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 18, y: 14 }, "#FF0000", 1, false));

      this.addEntity(new TileMarker(this, { x: 20, y: 14 }, "#00FF00", 1, false));

      this.addEntity(new TileMarker(this, { x: 30, y: 14 }, "#00FF00", 1, false));

      this.addEntity(new TileMarker(this, { x: 32, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 33, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 34, y: 14 }, "#FF0000", 1, false));

      this.addEntity(new TileMarker(this, { x: 36, y: 14 }, "#00FF00", 1, false));
    } else if (this.wave === 74) {
      player.location = { x: 28, y: 17 };
      importSpawn(this);
    }

    document.getElementById("playWaveNum").addEventListener("click", () => {
      window.location.href = `/?wave=${waveInput.value || this.wave}`;
    });

    document
      .getElementById("pauseResumeLink")
      .addEventListener("click", () => (this.world.isPaused ? this.world.startTicking() : this.world.stopTicking()));

    waveInput.addEventListener("focus", () => (ControlPanelController.controller.isUsingExternalUI = true));
    waveInput.addEventListener("focusout", () => (ControlPanelController.controller.isUsingExternalUI = false));

    // set timer
    let timer_mode = "Start Set Timer";
    let timer_time = 210;

    setInterval(() => {
      if (
        timer_mode === "Start Set Timer" ||
        timer_mode === "Resume"
      ) {
        return;
      }
      timer_time--;
      if (timer_time <= 0) {
        timer_time = 210;
        timer_mode = "Start Set Timer";
      }
      document.getElementById("set_timer_time").innerText =
        String(Math.floor(timer_time / 60)) +
        ":" +
        String(timer_time % 60).padStart(2, "0");
      document.getElementById("set_timer_button").innerText =
        timer_mode;
    }, 1000);
    document
      .getElementById("set_timer_button")
      .addEventListener("click", () => {
        if (timer_mode === "Start Set Timer") {
          timer_mode = "Pause";
        } else if (timer_mode === "Pause") {
          timer_mode = "Resume";
        } else if (timer_mode === "Resume") {
          timer_mode = "Reset";
          timer_time += 105;
        } else if (timer_mode === "Reset") {
          timer_time = 210;
          timer_mode = "Start Set Timer";
        }
        document.getElementById("set_timer_time").innerText =
          String(Math.floor(timer_time / 60)) +
          ":" +
          String(timer_time % 60).padStart(2, "0");
        document.getElementById("set_timer_button").innerText =
          timer_mode;
      });


    // Add 3d scene
    if (Settings.use3dView) {
      this.addEntity(new InfernoScene(this, { x: 0, y: 48 }));
    }

    player.perceivedLocation = player.location;
    player.destinationLocation = player.location;

    return { player };
  }

  drawWorldBackground(context: OffscreenCanvasRenderingContext2D, scale: number) {
    context.fillStyle = "black";
    context.fillRect(0, 0, 10000000, 10000000);
    if (this.mapImage) {
      const ctx = context as any;
      ctx.webkitImageSmoothingEnabled = false;
      ctx.mozImageSmoothingEnabled = false;
      context.imageSmoothingEnabled = false;

      context.fillStyle = "white";

      context.drawImage(this.mapImage, 0, 0, this.width * scale, this.height * scale);

      ctx.webkitImageSmoothingEnabled = true;
      ctx.mozImageSmoothingEnabled = true;
      context.imageSmoothingEnabled = true;
    }
  }

  drawDefaultFloor() {
    // replaced by an Entity in 3d view
    return !Settings.use3dView;
  }

  // Spawn indicator management methods
  private clearSpawnIndicators() {
    this.spawnIndicators.forEach(indicator => {
      this.removeEntity(indicator);
    });
    this.spawnIndicators = [];
  }

  private updateSpawnIndicators(spawns: Location[]) {
    // Clear existing indicators
    this.clearSpawnIndicators();

    // Only show spawn indicators if the setting is enabled
    if (!InfernoSettings.spawnIndicators) {
      return;
    }

    console.log("Updating spawn indicators for spawns:", spawns);

    // Add new indicators for current spawn points
    spawns.forEach((spawn: Location, index: number) => {
      // Create multiple size indicators with completely isolated location objects
      [2, 3, 4].forEach((size: number) => {
        const color = index < 9 ? "#00FF0050" : "#FF000050"; // Green for valid spawns, red for overflow
        // Create a completely isolated copy of the location to prevent any reference sharing
        const isolatedLocation = { x: spawn.x, y: spawn.y };
        const tileMarker = new TileMarker(this, isolatedLocation, color, size, false);
        this.addEntity(tileMarker);
        this.spawnIndicators.push(tileMarker);
      });
    });

    console.log(`Added ${this.spawnIndicators.length} spawn indicator entities`);
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

    // Watching the nibblers turn is an OBSERVATION, not an automation action, so it happens
    // whether automation is on or not. Without this the debug grid scored every tile zero with
    // automation off - not because the grid was stale, but because nothing had ever recorded
    // which pillar each nibbler was heading for, so there were no threats to score against.
    //
    // Must run before anything asks about pillar targets, and exactly once a tick. Automation
    // calls it too and that is harmless - it only adds to a WeakSet.
    observeNibblers(this);

    // Watching Zuk attack is an OBSERVATION too, and it has to happen BEFORE automation decides:
    // wave 69 positions against "where must I be when Zuk next fires", so a clock read after the
    // decision would always be a tick stale. Same reasoning as observeNibblers above.
    // ---- SIM POOLS: prayer and run energy pinned, exactly as the harness pins them ----
    //
    // The harness runs with a 99999 prayer pool and run energy re-pinned every tick, so neither
    // can end a run. Without the same here, a browser run of the same seed diverges for reasons
    // that have nothing to do with the fight: prayer empties, overheads drop, and the orb dying
    // halves the bot's movement to one tile a tick - which is the difference between reaching a
    // spawn and not.
    //
    // Run is re-pinned EVERY TICK because `Player.movementStep` ends by clamping it, so setting it
    // once at spawn lasts about a minute. Prayer only needs the pool raised once.
    //
    // Only with ?seed= present, so ordinary play is untouched.
    {
      const sim = this as unknown as { zukSimPools?: boolean | null };
      if (sim.zukSimPools === undefined) {
        sim.zukSimPools = new URLSearchParams(window.location.search).get("seed") !== null;
      }
      const player = this.players[0] as unknown as {
        stats?: { prayer: number };
        currentStats?: { prayer: number; run: number };
        running?: boolean;
      };
      if (sim.zukSimPools && player?.currentStats && player.stats) {
        if (player.stats.prayer < 99999) {
          player.stats.prayer = 99999;
          player.currentStats.prayer = 99999;
        }
        player.currentStats.run = 10000;
        player.running = true;
      }
    }

    // ---- Set watch, printed in the same shape the harness reports ----
    //
    // So a run watched in the browser can be compared with a run read in the harness. It has to be
    // the same three numbers or the comparison is worthless: WHERE we were when the pair landed,
    // HOW FAR each half was, and HOW LONG until each was pulled off the shield.
    //
    // The two are not the same fight from the same seed - the 3D path consumes Math.random during
    // model warmup and the harness never runs it - so this is here to make the difference visible
    // rather than to pretend it away.
    {
      const watcher = this as unknown as {
        zukSetWatch?: Map<Mob, { tick: number; distance: number }>;
        zukSetTick?: number;
        zukLastSetTick?: number;
        zukShieldSeen?: Set<unknown>;
      };
      watcher.zukSetTick = (watcher.zukSetTick ?? 0) + 1;
      watcher.zukSetWatch = watcher.zukSetWatch ?? new Map();
      const player = this.players[0];
      if (player) {
        for (const mob of this.mobs.concat(this.newMobs)) {
          const name = mob.mobName();
          if (name !== EntityNames.JAL_ZEK && name !== EntityNames.JAL_XIL) {
            continue;
          }
          const distance = Math.max(
            Math.abs(mob.location.x - player.location.x),
            Math.abs(mob.location.y - player.location.y),
          );
          const seen = watcher.zukSetWatch.get(mob);
          if (!seen) {
            watcher.zukSetWatch.set(mob, { tick: watcher.zukSetTick, distance });
            watcher.zukLastSetTick = watcher.zukSetTick;
            console.log(
              `t${watcher.zukSetTick} SPAWN ${name} | player ${player.location.x},` +
                `${player.location.y} | distance ${distance}`,
            );
            continue;
          }
          if (mob.aggro === player && seen.distance >= 0) {
            console.log(
              `t${watcher.zukSetTick} TAGGED ${name} | +${watcher.zukSetTick - seen.tick} ticks ` +
                `after spawn (was d${seen.distance})`,
            );
            seen.distance = -1; // reported once
          }
        }
      }
    }

    // ---- Every hit the shield takes, in the same shape the harness table prints ----
    //
    // The offset from the last spawn is the number that means something: both halves fire on a
    // fixed schedule from the tick they land - 7 and 9, then every 4 - so +11 is their first shot
    // arriving and every 4 after it is one more the tag was late for. A hit at all means the tag
    // landed after +7.
    //
    // Attributed the same way the harness does: a projectile counts on the tick its remainingDelay
    // reaches 0, not when it leaves the list.
    {
      const watch = this as unknown as {
        zukShieldSeen?: Set<unknown>;
        zukSetTick?: number;
        zukLastSetTick?: number;
      };
      watch.zukShieldSeen = watch.zukShieldSeen ?? new Set();
      const shield = this.mobs.find((mob) => mob.mobName() === EntityNames.INFERNO_SHIELD) as
        | { currentStats?: { hitpoint: number }; incomingProjectiles?: unknown[] }
        | undefined;
      if (shield) {
        for (const projectile of shield.incomingProjectiles ?? []) {
          if (watch.zukShieldSeen.has(projectile)) {
            continue;
          }
          const shot = projectile as {
            remainingDelay?: number;
            damage?: number;
            from?: { mobName?: () => string };
          };
          if ((shot.remainingDelay ?? 1) > 0) {
            continue;
          }
          watch.zukShieldSeen.add(projectile);
          if ((shot.damage ?? 0) <= 0) {
            continue;
          }
          const from = shot.from?.mobName?.() ?? "?";
          const who =
            from === EntityNames.JAL_ZEK
              ? "MAGER"
              : from === EntityNames.JAL_XIL
                ? "RANGER"
                : from === EntityNames.JAL_TOK_JAD
                  ? "JAD"
                  : from;
          const offset =
            watch.zukLastSetTick === undefined
              ? "-"
              : `+${(watch.zukSetTick ?? 0) - watch.zukLastSetTick}`;
          console.log(
            `t${watch.zukSetTick} SHIELD HIT ${who} ${shot.damage} | ${offset} after spawn | ` +
              `shield ${shield.currentStats?.hitpoint ?? "?"} left`,
          );
        }
      }
    }

    ZukAttackClock.observe(this);
    ShieldAttackerClock.observe(this, this.players[0]);
    ZukSetTimer.observe(this);
    PlayerAttackClock.observe(this.players[0]);

    // Automation decides last, so it sees this tick's wave state - including a wave that
    // handleWaveProgression() has only just spawned.
    InfernoAutomation.onTick(this, this.players[0]);
    this.updatePlayerTileReadout();
    this.updateTileGrid();
    this.updateDebugPanel();
    // A view, same as the two above - and after them, so the strip reports the tick everything
    // else has already finished reading. Costs nothing while the checkbox is off.
    ZukSimPanel.update();
  }

  /**
   * Feed the debug panel its numbers. A view, same as the tile grid - only does the work while
   * it is actually on screen, and works with automation off.
   */
  private updateDebugPanel() {
    const player = this.players[0];
    if (!DebugPanel.isVisible() || !player) {
      return;
    }
    this.debugTick++;

    const tile = `${player.location.x},${player.location.y}`;
    const moved = this.debugLastTile !== null && this.debugLastTile !== tile;
    if (moved || this.debugLastTile === null) {
      this.debugArrivedTick = this.debugTick;
    }
    this.debugLastTile = tile;

    // A projectile we have not seen before IS the moment a mob fired at us - mobs reset their
    // own attackDelay in the same step, so watching the delay cannot tell a fresh shot from a
    // stale count. `from` names who, `attackStyle` names what prayer it needed.
    const fired: string[] = [];
    for (const projectile of player.incomingProjectiles as any[]) {
      if (this.debugSeenProjectiles.has(projectile)) {
        continue;
      }
      this.debugSeenProjectiles.add(projectile);
      fired.push(`${projectile.from?.mobName?.() ?? "?"}/${projectile.attackStyle}`);
    }

    // Same reach test the target layer uses, so this agrees with what the bot believes rather
    // than being a second opinion - `canReach` measures at the range of the weapon that mob's
    // own gear set carries.
    const reachable = this.mobs
      .filter((mob: Mob) => mob.dying === -1 && canReach(this, player, mob))
      .map((mob: Mob) => mob.mobName());

    const distance = distanceToNearestMob(this, player);
    const overhead = player.prayerController?.overhead();

    DebugPanel.append(
      `t${String(this.debugTick).padStart(3)} @${tile.padEnd(6)}` +
        `${moved ? " MOVED" : "      "} ` +
        `arrived=t${String(this.debugArrivedTick).padEnd(3)} ` +
        `dist=${distance === null ? "-" : distance} ` +
        `pray=${(overhead?.feature() ?? "-").padEnd(5)} ` +
        `reach=${(reachable.length ? reachable.join(",") : "-").padEnd(28)} ` +
        `fired=${fired.length ? fired.join(",") : "-"}`,
    );
  }

  /**
   * Re-centre the debug tile grid on the player.
   *
   * Runs after automation so the grid reflects where the player ended up this tick, and runs
   * regardless of whether automation is on - it is purely a view.
   */
  private updateTileGrid() {
    const player = this.players[0];
    if (!player) {
      return;
    }

    // Only scored when the grid is actually on screen - this is an instrument, and it should
    // not cost anything while it is switched off.
    if (TileGrid.isVisible()) {
      // Reuse whatever automation already scored this tick. Scoring is hundreds of simulated
      // trajectories, so doing it twice would double the cost purely to draw it.
      const existing = InfernoAutomation.getScoredTiles();
      const scored = existing.length > 0 ? existing : scoreCandidates(this, player);
      // Null when the movement layer chose nothing this tick - the grid then marks no tile
      // rather than substituting the best-scoring one, which would claim a decision that was
      // never made. See TileGrid.shadeFor.
      TileGrid.update(this, player, scored, InfernoAutomation.getChosenTile());
    } else {
      TileGrid.update(this, player, [], null);
    }

    const readout = document.getElementById("tile_grid_count");
    if (readout) {
      readout.innerText = TileGrid.isVisible()
        ? ` ${TileGrid.candidateCount()}/${GRID_SIZE * GRID_SIZE} ${lastScoreDurationMs().toFixed(1)}ms`
        : "";
    }
  }

  /**
   * Show the player's true tile in the sidebar.
   *
   * Uses `location` rather than `perceivedLocation`: the perceived one is interpolated for
   * smooth rendering between ticks, so it does not correspond to the tile the engine is
   * actually pathing and attacking from.
   */
  private updatePlayerTileReadout() {
    const readout = document.getElementById("player_tile");
    const player = this.players[0];
    if (!readout || !player) {
      return;
    }
    readout.innerText = `Tile: ${player.location.x}, ${player.location.y}`;
  }

  /**
   * True while the wave is cleared and the next has not spawned yet.
   *
   * Derived from living mobs rather than `waveCompleteTimer` alone, so it is still correct
   * when wave progression is switched off and no timer ever starts.
   */
  get isBetweenWaves(): boolean {
    // The get-ready countdown. Starting a wave spawns its mobs immediately, but tickRegion
    // gates every mob step on `getReadyTimer == 0`, so they stand frozen until it expires.
    // Mobs being present is therefore not the same as the wave being live, and without this
    // the bot walks out to its wave tile before anything can act.
    if ((this.world?.getReadyTimer ?? 0) > 0) {
      return true;
    }
    // newMobs is deliberately NOT consulted. It holds a wave that has spawned but has not been
    // merged into `mobs` yet, and the renderer draws `mobs` - so those mobs have not been shown
    // to anybody. Peeking would let the bot react to a wave a tick before it is visible, which
    // is the same information the rest of the automation now refuses through Visibility.
    //
    // The cost is that a freshly spawned wave reads as downtime for exactly one tick. That is
    // the honest answer, and it also removes the disagreement that used to lose the preloaded
    // barrage: this getter said "wave live" while every mob lookup still said "nothing there".
    return this.mobs.every((mob) => mob.dying !== -1);
  }

  /**
   * Ticks until the next wave spawns, or -1 when no countdown is running.
   *
   * Not a guarantee: the countdown is cancelled outright if mobs appear while it runs, which
   * is what happens when a blob dies late and its bloblets spawn.
   */
  get ticksUntilNextWave(): number {
    return this.waveCompleteTimer;
  }

  private handleWaveProgression() {
    // Only enable wave progression for waves 1-69 and if the setting is enabled
    if (this.wave >= 1 && this.wave <= 69 && InfernoSettings.waveProgression) {
      this.waveProgressionEnabled = true;
    } else {
      this.waveProgressionEnabled = false;
    }

    if (!this.waveProgressionEnabled) {
      return;
    }

    // Count current alive mobs (with special handling for nibblers)
    const aliveMobs = this.mobs.filter(mob => {
      return mob.dying === -1;
    });

    const currentMobCount = aliveMobs.length;

    // Check if wave just completed (all relevant mobs dead)
    if (currentMobCount === 0 && this.lastMobCount > 0 && this.waveCompleteTimer === -1) {
      // Wave completed! Start 9-tick timer (1 extra tick to allow for bloblet spawning)
      this.waveCompleteTimer = 9;
      console.log(`Wave ${this.wave} completed! Next wave spawning in 9 ticks (allowing for bloblets)...`);

      // Update wave display
      const waveInput = document.getElementById("waveinput") as HTMLInputElement;
      if (waveInput) {
        waveInput.value = String(this.wave + 1);
      }
    }

    // Cancel wave completion if mobs spawned during countdown (e.g., bloblets)
    if (this.waveCompleteTimer > 0 && currentMobCount > 0) {
      console.log(`Wave ${this.wave} completion cancelled - new mobs detected (likely bloblets)`);
      this.waveCompleteTimer = -1;

      // Revert wave display
      const waveInput = document.getElementById("waveinput") as HTMLInputElement;
      if (waveInput) {
        waveInput.value = String(this.wave);
      }
    }

    // Handle countdown timer
    if (this.waveCompleteTimer > 0) {
      this.waveCompleteTimer--;

      if (this.waveCompleteTimer === 0) {
        // Timer finished, spawn next wave
        this.spawnNextWave();
        this.waveCompleteTimer = -1;
      }
    }

    this.lastMobCount = currentMobCount;
  }

  /**
   * The pillars collapse going into wave 67, as in the real Inferno - Jad, the triple Jads
   * and Zuk are fought in an open arena. Routed through each pillar's own `dead()` so the
   * teardown (death animation, delayed removeEntity, 3D model) is the same one a nibbler
   * kill triggers, rather than a second removal path that could drift from it.
   *
   * Called from every wave 67+ spawn site - the progression path and the boot-at-wave path -
   * so starting a run directly at 67, 68 or 69 gets the same open arena as arriving there.
   * Harmless when the pillars are already gone: the filter simply finds nothing.
   */
  private removePillars() {
    for (const entity of this.entities.filter(
      (candidate) => candidate.entityName() === EntityNames.PILLAR,
    )) {
      (entity as unknown as { dead: () => void }).dead();
    }
  }

  private spawnRegularWave(player: any, randomPillar: any, customSpawns?: Location[]) {
    // Common logic for spawning regular waves (1-66)
    const spawns = customSpawns || InfernoWaves.getRandomSpawns();

    // Clear death store to prevent resurrection of mobs from previous waves
    InfernoMobDeathStore.clearDeadMobs();

    // Add spawn indicators before spawning mobs
    this.updateSpawnIndicators(spawns);

    // Spawn the mobs
    InfernoWaves.spawn(this, player, randomPillar, spawns, this.wave).forEach(this.addMob.bind(this));

    // Update replay link and wave input
    const encodedSpawn = encodeURIComponent(JSON.stringify(spawns));
    const replayLink = document.getElementById("replayLink") as HTMLLinkElement;
    if (replayLink) {
      replayLink.href = `/?wave=${this.wave}&x=${player.location.x}&y=${player.location.y}&spawns=${encodedSpawn}`;
    }

    const waveInput = document.getElementById("waveinput") as HTMLInputElement;
    if (waveInput) {
      waveInput.value = String(this.wave);
    }
  }

  private spawnNextWave() {
    if (this.wave >= 69) {
      // Don't spawn anything after wave 69
      console.log("Inferno completed! No more waves to spawn.");
      this.waveProgressionEnabled = false;
      return;
    }

    // Increment to next wave
    this.wave++;
    console.log(`Spawning wave ${this.wave}...`);

    // Get player reference
    const player = this.players[0];
    if (!player) {
      console.error("No player found for wave progression");
      return;
    }

    // Get random pillar for nibblers
    const randomPillar = (shuffle(this.entities.filter((entity) => entity.entityName() === EntityNames.PILLAR)) || [null])[0];

    // Spawn the next wave based on wave number
    if (this.wave >= 1 && this.wave <= 66) {
      // Regular waves (1-66)
      this.spawnRegularWave(player, randomPillar);
    } else if (this.wave === 67) {
      // Jad wave - clear spawn indicators since it's a special spawn
      this.clearSpawnIndicators();

      // Clear death store for special waves
      InfernoMobDeathStore.clearDeadMobs();
      this.removePillars();

      player.location = { x: 18, y: 25 };
      const jad = new JalTokJad(
        this,
        { x: 23, y: 27 },
        { aggro: player, attackSpeed: 8, stun: 1, healers: 5, isZukWave: false },
      );
      this.addMob(jad);
    } else if (this.wave === 68) {
      // Triple Jad wave - clear spawn indicators since it's a special spawn
      this.clearSpawnIndicators();

      // Clear death store for special waves
      InfernoMobDeathStore.clearDeadMobs();
      this.removePillars();

      player.location = { x: 25, y: 27 };

      const jad1 = new JalTokJad(
        this,
        { x: 18, y: 24 },
        { aggro: player, attackSpeed: 9, stun: 1, healers: 3, isZukWave: false },
      );
      this.addMob(jad1);

      const jad2 = new JalTokJad(
        this,
        { x: 28, y: 24 },
        { aggro: player, attackSpeed: 9, stun: 7, healers: 3, isZukWave: false },
      );
      this.addMob(jad2);

      const jad3 = new JalTokJad(
        this,
        { x: 23, y: 35 },
        { aggro: player, attackSpeed: 9, stun: 4, healers: 3, isZukWave: false },
      );
      this.addMob(jad3);
    } else if (this.wave === 69) {
      // Zuk wave
      // Clear death store for special waves
      InfernoMobDeathStore.clearDeadMobs();

      player.location = { x: 25, y: 15 };

      // Should already be gone since 67, but a run started at 68/69 arrives here directly.
      // Through dead() rather than a silent filter, so the teardown is the real one.
      this.removePillars();

      // Spawn zuk
      const shieldDirection = this.initializeAndGetShieldDirection();
      const shield = new ZukShield(this, { x: 23, y: 13 }, { aggro: player }, shieldDirection);
      this.addMob(shield);

      this.addMob(new TzKalZuk(this, { x: 22, y: 8 }, { aggro: player }));

      // Add walls
      for (let y = 0; y <= 8; y++) {
        this.addEntity(new Wall(this, { x: 21, y }));
        this.addEntity(new Wall(this, { x: 29, y }));
      }

      // Add tile markers
      this.addEntity(new TileMarker(this, { x: 14, y: 14 }, "#00FF00", 1, false));
      this.addEntity(new TileMarker(this, { x: 16, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 17, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 18, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 20, y: 14 }, "#00FF00", 1, false));
      this.addEntity(new TileMarker(this, { x: 30, y: 14 }, "#00FF00", 1, false));
      this.addEntity(new TileMarker(this, { x: 32, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 33, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 34, y: 14 }, "#FF0000", 1, false));
      this.addEntity(new TileMarker(this, { x: 36, y: 14 }, "#00FF00", 1, false));
    }

    // Update wave input display
    const waveInput = document.getElementById("waveinput") as HTMLInputElement;
    if (waveInput) {
      waveInput.value = String(this.wave);
    }
  }

  getSidebarContent() {
    return SidebarContent;
  }
}
