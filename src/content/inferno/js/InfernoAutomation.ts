"use strict";

import { Player, Region, Location, Mob, ControlPanelController, EntityNames, Random, Settings } from "osrs-sdk";

import { AutomationOverlay, ClickStep } from "./AutomationOverlay";
import { applyPrayerPlan, incomingThreats } from "./PrayerPlanner";
import { applyAttackPlan } from "./AttackPlanner";
import { equipSet, GearSetName, isWearing, requiredSetFor } from "./GearSets";
import { hasIceBarrageSelected, selectedSpell, selectIceBarrage } from "./SpellCaster";
import { isAttackable } from "./AttackPlanner";
import { bestMove, ScoredTile, scoreCandidates } from "./TileScorer";
import { ArenaSnapshot } from "./ArenaSnapshot";
import { chooseByPriority } from "./KillPriority";
import { observeNibblers } from "./PillarDefence";
import { chooseTarget } from "./TargetPlanner";
import { visibleMobs } from "./Visibility";

/**
 * Safe spot the bot returns to between waves.
 *
 * There are 9 ticks of downtime after the last mob of a wave dies
 * (InfernoRegion.waveCompleteTimer), though that countdown is cancelled outright if bloblets
 * spawn late - so the window is not guaranteed to run its full length.
 */
const HOME_TILE = { x: 28, y: 17 };

/**
 * The nine tiles nibblers can spawn on, straight out of InfernoWaves.spawnNibblers.
 *
 * It shuffles this exact list and takes the first n, so on a normal three nibbler wave only
 * three of the nine are occupied and WHICH three is decided at spawn time. During the countdown
 * the renderer draws no mobs at all, so a player standing there genuinely cannot know - see
 * Visibility.
 */
const NIBBLER_SPAWN_TILES: Location[] = [
  { x: 19, y: 27 },
  { x: 20, y: 27 },
  { x: 21, y: 27 },
  { x: 19, y: 26 },
  { x: 20, y: 26 },
  { x: 21, y: 26 },
  { x: 19, y: 25 },
  { x: 20, y: 25 },
  { x: 21, y: 25 },
];


// Prayer icons are laid out 5 per row. Derived from PrayerControls.panelClickDown, which
// maps a click back to an index with (x/scale - 14) / 35 and (y/scale - 22) / 35.
const PRAYER_GRID_ORIGIN_X = 14;
const PRAYER_GRID_ORIGIN_Y = 22;
const PRAYER_GRID_CELL = 35;
const PRAYER_GRID_COLUMNS = 5;

/**
 * Drives the player automatically, one decision per world tick.
 *
 * Everything goes through the same entry points a human click uses - `Player.moveTo` is
 * exactly what `ClickController.playerWalkClick` calls - so automation cannot desync the
 * simulation or change tick semantics. It only supplies the input a player would otherwise
 * supply with the mouse.
 *
 * Decisions are made from `Region.postTick()`, so exactly one action is issued per 600ms
 * tick, matching the budget a real player has. Play is currently perfect: no reaction time
 * and no misclicks are modelled.
 */
export class InfernoAutomation {
  static enabled = false;

  /** Tiles still to walk to, in order. */
  private static route: Location[] = [];

  /** Custom per-tick logic, run after the built-in route stepping. */
  private static onTickHandler: ((region: Region, player: Player) => void) | null = null;

  /**
   * The mob we have COMMITTED to, held between ticks.
   *
   * Two jobs, and they must be the same field. It stops the bot re-clicking a target it is
   * already attacking, and it is what `chooseTarget` is given as the incumbent - which is the
   * only thing that engages the switch margin.
   *
   * So it has to be set the moment a target is chosen, including on the tick a gear switch
   * consumes. Leaving it null through the switch meant the next tick chose from scratch with no
   * incumbent, so the margin never applied, and the bot alternated bow and blowpipe every tick
   * without ever attacking.
   */
  private static target: Mob | null = null;

  /**
   * Every click issued this tick, in order, for the overlay to replay.
   *
   * Collected rather than drawn as it happens. The engine takes the whole tick's input at
   * once - tab switches included - so drawing at that moment shows the last tab with the
   * cursor still working through clicks that belonged to earlier ones.
   */
  private static clickLog: ClickStep[] = [];

  /**
   * Tile the scorer picked this tick, or null between waves where the safe spot wins.
   *
   * Recomputed every tick rather than held: pillars die, mobs move, and a tile that was right
   * last tick need not be now. Exposed so the debug grid can highlight the same tile the
   * movement layer is acting on, instead of deriving its own answer.
   */
  private static chosenTile: Location | null = null;

  /**
   * This tick's scored candidates, kept so the debug grid can draw the very numbers the
   * decision used instead of scoring everything a second time.
   */
  private static scoredTiles: ScoredTile[] = [];

  /**
   * Why the bot did or did not attack this tick, for the overlay.
   *
   * Attacking sits behind two gates - repositioning suppresses it, and a gear switch consumes
   * the tick - and from outside all three outcomes look identical: the bot stands there. This
   * says which one actually happened.
   */
  private static attackState = "-";

  /**
   * Rolling per-tick log, written to the sidebar rather than the canvas overlay.
   *
   * The overlay banner shows the current tick and cannot be selected, which is useless for
   * working out why a sequence of ticks went wrong. This is plain selectable text with a copy
   * button, so a run can be pulled out and read.
   */
  private static log: string[] = [];
  private static tickCount = 0;

  private static readonly LOG_LINES = 40;

  static getLog(): string {
    return InfernoAutomation.log.join("\n");
  }

  static getChosenTile(): Location | null {
    return InfernoAutomation.chosenTile;
  }

  static getScoredTiles(): ScoredTile[] {
    return InfernoAutomation.scoredTiles;
  }

  /**
   * The walk the movement layer settled on this tick, for the prayer plan to follow.
   *
   * Undefined between waves and during the countdown, where nothing was scored - the planner
   * then falls back to standing still, which is what the bot is doing anyway.
   *
   * Stored rather than looked up from `chosenTile`. The tile does not identify a route on its
   * own, and re-finding it left two places deciding what "the plan" was.
   */
  private static chosenPath: Location[] | undefined;

  /**
   * Tile the current walk is heading for, so a walk already going the right way is not
   * re-issued every tick, and one going the wrong way can be redirected.
   */
  private static walkingTo: Location | null = null;

  /**
   * The nibbler spawn tile the cursor is parked on for this wave, or null before one is picked.
   *
   * Chosen ONCE per wave and held, because a hover that re-rolled every tick would be a twitch
   * rather than a player deciding where to aim. Cleared between waves so the next one re-rolls.
   */
  private static hoverTile: Location | null = null;

  private static onEnabledChanged: ((enabled: boolean) => void) | null = null;

  static setEnabled(enabled: boolean) {
    InfernoAutomation.enabled = enabled;
    InfernoAutomation.route = [];
    InfernoAutomation.target = null;
    InfernoAutomation.walkingTo = null;
    InfernoAutomation.chosenTile = null;
    InfernoAutomation.chosenPath = undefined;
    InfernoAutomation.scoredTiles = [];
    InfernoAutomation.hoverTile = null;
    InfernoAutomation.log = [];
    InfernoAutomation.tickCount = 0;

    if (enabled) {
      AutomationOverlay.show(() => InfernoAutomation.setEnabled(false));
    } else {
      AutomationOverlay.hide();
    }
    InfernoAutomation.onEnabledChanged?.(enabled);
  }

  static isEnabled(): boolean {
    return InfernoAutomation.enabled;
  }

  /**
   * Prayer flicking with nothing else attached: no scoring, no movement, no attacking, no gear.
   *
   * A separate switch from `enabled` rather than a mode of it, because the two are not
   * alternatives - full automation already prays, so it simply OVERRIDES this while it is on and
   * this resumes when it is switched off. Nothing needs resetting between them.
   *
   * The point is manual play with the one thing a human cannot do reliably handled for them, so
   * this deliberately does NOT show the overlay or block the mouse the way `setEnabled` does.
   */
  private static prayerOnly = false;

  static setPrayerOnly(enabled: boolean) {
    InfernoAutomation.prayerOnly = enabled;
  }

  static isPrayerOnly(): boolean {
    return InfernoAutomation.prayerOnly;
  }

  /** Lets the UI keep its button label in sync, including when Escape stops automation. */
  static setEnabledListener(listener: ((enabled: boolean) => void) | null) {
    InfernoAutomation.onEnabledChanged = listener;
  }

  /** Queue a tile to walk to. Equivalent to left-clicking it, but issued on a tick boundary. */
  static goTo(x: number, y: number) {
    InfernoAutomation.route.push({ x, y });
  }

  static setRoute(tiles: Location[]) {
    InfernoAutomation.route = [...tiles];
  }

  static clearRoute() {
    InfernoAutomation.route = [];
  }

  static setTickHandler(handler: ((region: Region, player: Player) => void) | null) {
    InfernoAutomation.onTickHandler = handler;
  }

  /**
   * True while the player still has ground to cover.
   *
   * Do NOT use `player.path` for this. It is a vestigial field: the constructor sets it to
   * [] and nothing ever pushes to it, so it reads empty forever and this returned false even
   * mid-walk. That made the bot re-issue moveTo every tick - each one calling
   * interruptCombat() - and stopped it suppressing attacks while repositioning.
   *
   * This is the same comparison Player.moveTowardsDestination() uses for `willMoveThisTick`.
   */
  private static isMoving(player: Player): boolean {
    const destination = player.destinationLocation;
    if (!destination) {
      return false;
    }
    return player.location.x !== destination.x || player.location.y !== destination.y;
  }

  /**
   * Switch a prayer the way a player does: open the prayer tab with its hotkey, move the
   * cursor onto the icon, and click it.
   *
   * The click goes through PrayerControls.panelClickDown - the same handler a real mouse
   * click reaches - rather than calling prayer.toggle() directly, so the on-screen state and
   * the engine state cannot drift apart.
   */
  private static clickPrayer(player: Player, prayerName: string) {
    const controller = ControlPanelController.controller;
    const prayerPanel = ControlPanelController.controls.PRAYER;
    if (!controller || !prayerPanel) {
      return;
    }

    // Open the tab with its keybinding if it is not already showing.
    if (controller.selectedControl !== prayerPanel) {
      const key = (prayerPanel as unknown as { keyBinding?: string }).keyBinding;
      if (key) {
        AutomationOverlay.pressKey(key);
      }
      // The keypress is what a player would do; make sure the tab really is open, since
      // the engine may bind that key differently.
      if (controller.selectedControl !== prayerPanel) {
        controller.setActiveControl("PRAYER");
      }
    }

    const index = player.prayerController.prayers.findIndex((p) => p.name === prayerName);
    if (index < 0) {
      return;
    }

    const scale = Settings.controlPanelScale ?? 1;
    const column = index % PRAYER_GRID_COLUMNS;
    const row = Math.floor(index / PRAYER_GRID_COLUMNS);
    // Centre of the icon, in panel-relative pixels before scaling.
    const localX = (PRAYER_GRID_ORIGIN_X + (column + 0.5) * PRAYER_GRID_CELL) * scale;
    const localY = (PRAYER_GRID_ORIGIN_Y + (row + 0.5) * PRAYER_GRID_CELL) * scale;

    try {
      const panelPos = controller.controlPosition(prayerPanel);
      InfernoAutomation.clickLog.push({
        panel: "PRAYER",
        canvas: { x: panelPos.x + localX, y: panelPos.y + localY },
      });
    } catch (e) {
      // Cursor position is cosmetic; never let it stop the prayer switch.
    }

    prayerPanel.panelClickDown(localX, localY);
  }

  /**
   * The nibbler to aim Ice Barrage at, chosen for blast coverage rather than proximity.
   *
   * BarrageSpell.aoe is the nine tiles around its TARGET, so the cast is really a choice of
   * centre, and centring it on the closest nibbler is usually the worst option available - the
   * closest one tends to be an edge of the spread, so the blast reaches past it into empty
   * ground. Nibblers spawn on a fixed 3x3 block (x 19-21, y 25-27) and only three of those nine
   * tiles are occupied on a normal wave, up to two tiles apart, so which one is picked decides
   * whether the opening cast catches one or all three.
   *
   * Frozen nibblers are not counted towards coverage. Ice Barrage freezes for 32 ticks, which
   * is long enough that a frozen nibbler reaches no pillar in any meaningful timeframe - it is
   * already neutralised, so spending blast coverage on it buys nothing. They remain valid
   * centres, because the centre has to be a real mob and an already-frozen one may still sit in
   * the best position to cover the others.
   */
  private static bestBarrageNibbler(region: Region, player: Player): Mob | null {
    const nibblers = visibleMobs(region).filter(
      (mob) => mob.mobName() === EntityNames.JAL_NIB && mob.dying <= -1,
    );
    if (nibblers.length === 0) {
      return null;
    }

    const isFrozen = (mob: Mob) =>
      ((mob as unknown as { frozen?: number }).frozen ?? 0) > 0;
    const chebyshev = (a: Location, b: Location) =>
      Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

    let best: Mob | null = null;
    let bestCovered = -1;
    let bestDistance = Infinity;

    for (const centre of nibblers) {
      // The blast covers everything within one tile of the centre, itself included.
      const covered = nibblers.filter(
        (other) => !isFrozen(other) && chebyshev(other.location, centre.location) <= 1,
      ).length;
      const distance = chebyshev(centre.location, player.location);

      // Most unfrozen nibblers caught; nearest breaks the tie so the cast is not thrown away
      // reaching for a target the player has to walk towards.
      if (covered > bestCovered || (covered === bestCovered && distance < bestDistance)) {
        bestCovered = covered;
        bestDistance = distance;
        best = centre;
      }
    }
    return best;
  }

  /**
   * Park the cursor on one of the nine nibbler spawn tiles, picked at random and held.
   *
   * This is a guess, and it has to be. InfernoWaves shuffles the nine tiles and takes the first
   * three, so which three are occupied is decided at spawn time - and during the countdown the
   * renderer draws no mobs at all, so there is nothing on screen to aim at. A player waiting for
   * the wave parks the mouse somewhere in the block and adjusts once it appears; anything
   * cleverer than random would be reading spawn positions nobody can see yet.
   *
   * Cursor only - no click. Clicking would be an action the bot has not taken, and the world is
   * frozen during the countdown anyway.
   *
   * Random.get is drawn from once per wave rather than per tick, and only on countdown ticks
   * where tickRegion has the mobs frozen, so it perturbs nothing that is running.
   */
  private static hoverNibblerSpawn() {
    if (!InfernoAutomation.hoverTile) {
      const index = Math.min(
        NIBBLER_SPAWN_TILES.length - 1,
        Math.floor(Random.get() * NIBBLER_SPAWN_TILES.length),
      );
      InfernoAutomation.hoverTile = NIBBLER_SPAWN_TILES[index];
    }
    InfernoAutomation.clickLog.push({
      tile: { ...InfernoAutomation.hoverTile },
      hover: true,
    });
  }

  /** Queue Ice Barrage for the next wave, if it is not already queued. */
  private static preloadIceBarrage(player: Player) {
    if (hasIceBarrageSelected(player)) {
      return;
    }
    selectIceBarrage(player, (x, y) =>
      InfernoAutomation.clickLog.push({ panel: "ANCIENTSSPELLBOOK", canvas: { x, y } }),
    );
  }

  /**
   * Equip a set, logging the clicks it took so the overlay can walk through them.
   *
   * All the clicks land on the engine this tick; only the drawing is spread out, because
   * several cursor moves inside one frame are invisible.
   */
  private static equipAndShow(player: Player, set: GearSetName) {
    equipSet(player, set, (x, y) =>
      InfernoAutomation.clickLog.push({ panel: "INVENTORY", canvas: { x, y } }),
    );
  }

  /**
   * Surface what the planner is reacting to. Prayer switches happen on single ticks and are
   * easy to miss on screen, so the overlay names the prayer and what it is covering.
   */
  private static reportThreats(region: Region, player: Player) {
    const overhead = player.prayerController?.overhead();
    const threats = incomingThreats(visibleMobs(region), player);
    const summary = threats
      .map((t) => `${t.mob.mobName()} ${t.style ?? "?"}(${t.maxHit})`)
      .join(", ");

    // Wave state drives which tile the bot holds, so surface what it currently believes.
    const inferno = region as unknown as {
      isBetweenWaves?: boolean;
      ticksUntilNextWave?: number;
    };
    const between = inferno.isBetweenWaves === true;
    const countdown = inferno.ticksUntilNextWave ?? -1;
    // Spell state, so the barrage sequence can be read off the screen rather than guessed at.
    const nibblers = visibleMobs(region).filter((m) => m.mobName() === EntityNames.JAL_NIB);
    const reachable = nibblers.filter((m) => isAttackable(region, player, m)).length;
    const spellLine =
      `spell=${selectedSpell(player) ?? "none"}` +
      ` | nibblers ${reachable}/${nibblers.length} in reach` +
      ` | aggro=${player.aggro ? player.aggro.mobName?.() ?? "set" : "none"}` +
      ` | atkDelay=${player.attackDelay} range=${player.attackRange}`;

    const station = InfernoAutomation.stationTile(region, player);
    const attackLine = ` | ${InfernoAutomation.attackState}`;
    const state =
      `${between ? "between waves" : "wave live"}` +
      `${countdown > 0 ? ` (next in ${countdown})` : ""}` +
      ` | station ${station.x},${station.y}` +
      ` | at ${player.location.x},${player.location.y}` +
      attackLine;

    AutomationOverlay.setStatus(overhead ? overhead.name : null, summary, `${state}
${spellLine}`);
  }

  /**
   * Issue a walk and mirror it on the simulated cursor, so the overlay shows the same
   * action the engine just received.
   */
  private static walkTo(player: Player, x: number, y: number) {
    player.moveTo(x, y);
    InfernoAutomation.clickLog.push({ tile: { x, y } });
  }

  /**
   * Advance the movement plan. Returns true if the player is repositioning this tick, in
   * which case attacking must be skipped - `moveTo()` interrupts combat, so issuing both
   * would leave the walk cancelled two steps in.
   */
  private static stepMovement(player: Player, region: Region): boolean {
    // An explicitly queued route wins over any station tile.
    if (!InfernoAutomation.isMoving(player) && InfernoAutomation.route.length > 0) {
      const next = InfernoAutomation.route.shift();
      if (next) {
        InfernoAutomation.walkTo(player, next.x, next.y);
        InfernoAutomation.walkingTo = { x: next.x, y: next.y };
        return true;
      }
    }

    const station = InfernoAutomation.stationTile(region, player);
    if (player.location.x === station.x && player.location.y === station.y) {
      InfernoAutomation.walkingTo = null;
      return false;
    }

    // Already walking to the right place - stay committed.
    const walkingTo = InfernoAutomation.walkingTo;
    if (
      InfernoAutomation.isMoving(player) &&
      walkingTo &&
      walkingTo.x === station.x &&
      walkingTo.y === station.y
    ) {
      return true;
    }

    // Either standing still off-station, or walking somewhere that is no longer where we
    // want to be. The second case is what happens when a wave spawns mid-way back to the
    // safe spot: getting home is best-effort, and once the wave is live the wave tile
    // matters more than finishing the trip.
    InfernoAutomation.walkTo(player, station.x, station.y);
    InfernoAutomation.walkingTo = { x: station.x, y: station.y };
    return true;
  }

  /**
   * The tile the bot should be standing on right now.
   *
   * Between waves it returns to the safe spot. While a wave is live the tile scorer decides.
   * Null means scoring had nothing to say - it was skipped, or it threw - and the answer is
   * then "where the player already is", which is a decision to hold rather than an absence of
   * one, and keeps the movement layer from walking somewhere nothing chose.
   */
  private static stationTile(region: Region, player: Player): Location {
    if (InfernoAutomation.isBetweenWaves(region)) {
      return HOME_TILE;
    }
    return InfernoAutomation.chosenTile ?? player.location;
  }

  /** InfernoRegion exposes this; other regions do not, so treat absence as "wave live". */
  private static isBetweenWaves(region: Region): boolean {
    return (region as unknown as { isBetweenWaves?: boolean }).isBetweenWaves === true;
  }

  static onTick(region: Region, player: Player) {
    if (!InfernoAutomation.enabled || !player || player.isDying()) {
      // Drop the cached scores rather than leaving them lying around. The debug grid reuses
      // them when they exist so it does not score everything twice, and a stale list would
      // freeze the grid outright - the marker positions come from it too, not just the
      // numbers. Empty means "nothing scored this tick", so the grid computes its own.
      InfernoAutomation.scoredTiles = [];
      InfernoAutomation.chosenTile = null;
      InfernoAutomation.chosenPath = undefined;
      // Prayer-only runs in exactly the gap full automation leaves behind, which is what makes
      // "auto overrides it" fall out rather than needing to be enforced.
      if (InfernoAutomation.prayerOnly && player && !player.isDying()) {
        InfernoAutomation.flickPrayerOnly(region, player);
      }
      return;
    }

    // Collect the tick's clicks, then hand the whole ordered sequence to the overlay in one
    // go. decide() has several early exits, so wrapping it is the only way to be sure the
    // replay is issued exactly once however the tick ends.
    InfernoAutomation.clickLog = [];
    InfernoAutomation.tickCount++;
    // Any uncaught error must show up in the log rather than silently stopping the bot. A throw
    // in decide() looks identical from outside to "chose to do nothing", which cost hours.
    try {
      InfernoAutomation.decide(region, player);
    } catch (e) {
      InfernoAutomation.attackState = `ERROR: ${(e as Error)?.message ?? e}`;
    }
    InfernoAutomation.appendLog(region, player);
    AutomationOverlay.replayClicks(InfernoAutomation.clickLog);
  }

  /**
   * The prayer half of a tick, on its own.
   *
   * Same planner as full automation, so the overhead chosen here is the overhead the bot would
   * have chosen - only the movement, attacking and gear layers are absent.
   *
   * Two deliberate differences from the way `decide()` prays:
   *
   * No click callback, so `applyPrayerPlan` toggles the prayer directly instead of routing
   * through PrayerControls. The click path opens the prayer tab to reach the icon, which is
   * right when the bot owns the screen and openly hostile when the human does - it would yank
   * the panel away from the inventory mid-gear-switch, every single flick.
   *
   * No route, so the plan is made against standing still. THIS tick is unaffected either way -
   * World.tickRegion fires mobs before the player moves, so tick one always resolves from the
   * current tile - and the route only shapes blob steering three ticks out, which cannot be
   * known anyway while a human is deciding where to walk.
   *
   * `observeNibblers` is not called here: InfernoRegion.postTick already does it every tick,
   * ahead of this, whether any automation is running or not.
   */
  private static flickPrayerOnly(region: Region, player: Player) {
    // A throw here would propagate into postTick and take the region tick down with it. Prayer
    // failing silently is bad; the whole sim stopping is worse.
    try {
      applyPrayerPlan(player, visibleMobs(region), true);
    } catch (e) {
      // Deliberately swallowed - see above.
    }
  }

  /**
   * One line per tick: where we are, what we prayed, what we did about attacking.
   *
   * Deliberately terse. A wave is hundreds of ticks and the useful signal is a pattern across
   * them - "moving" forty times in a row says something a single frame never could.
   */
  private static appendLog(region: Region, player: Player) {
    const overhead = player.prayerController?.overhead();
    const chosen = InfernoAutomation.chosenTile;
    const line =
      `t${String(InfernoAutomation.tickCount).padStart(4)} ` +
      `@${player.location.x},${player.location.y} ` +
      `-> ${chosen ? `${chosen.x},${chosen.y}` : "home"} ` +
      `pray=${(overhead?.feature() ?? "-").padEnd(5)} ` +
      `hp=${player.currentStats?.hitpoint ?? "?"} ` +
      `${InfernoAutomation.attackState}`;

    InfernoAutomation.log.push(line);
    if (InfernoAutomation.log.length > InfernoAutomation.LOG_LINES) {
      InfernoAutomation.log.shift();
    }

    const element = document.getElementById("automation_log");
    if (element) {
      element.innerText = InfernoAutomation.log.join("\n");
      element.scrollTop = element.scrollHeight;
    }
  }

  private static decide(region: Region, player: Player) {
    // Once per tick, before anything asks which pillar a nibbler is heading for. A nibbler's
    // target stays unknown for its first visible tick - see PillarDefence.
    observeNibblers(region);

    // One arena snapshot for the whole tick, shared by the tile scorer and the target scorer.
    // Building it walks every entity in the region, and the geometry cannot change between two
    // reads inside a single tick - so a second one would be the same answer at full price.
    const snapshot = new ArenaSnapshot(region);

    // Scoring first, then prayer. Scoring is a pure computation - it clicks nothing and touches
    // no world state - so running it ahead of prayer costs nothing and lets prayer be planned
    // against the route the bot is about to walk rather than against standing still.
    if (InfernoAutomation.isBetweenWaves(region)) {
      InfernoAutomation.chosenTile = null;
      InfernoAutomation.chosenPath = undefined;
      InfernoAutomation.scoredTiles = [];
    } else {
      // Wave is live, so the guess made during downtime has been spent. Cleared here rather than
      // in the branch above, where it would re-roll every tick and the cursor would twitch.
      InfernoAutomation.hoverTile = null;
      // Scoring is best-effort; prayer is not. Scoring runs before prayer so the plan can follow
      // the chosen route, which also means a throw in here would take prayer down with it - and
      // it did exactly that. Falling back to "no opinion on where to stand" costs position;
      // losing prayer costs the run.
      try {
        InfernoAutomation.scoredTiles = scoreCandidates(region, player, snapshot);
        const move = bestMove(region, player, InfernoAutomation.scoredTiles);
        InfernoAutomation.chosenTile = move?.tile ?? null;
        InfernoAutomation.chosenPath = move?.route;
      } catch (e) {
        InfernoAutomation.scoredTiles = [];
        InfernoAutomation.chosenTile = null;
        InfernoAutomation.chosenPath = undefined;
        InfernoAutomation.attackState = `SCORING FAILED: ${(e as Error)?.message ?? e}`;
      }
    }

    // Prayer goes first, ahead of absolutely everything - including the get-ready gate below.
    //
    // It is the only action with no cost and no conflict: a prayer click touches neither combat
    // nor movement state, so nothing below can be spoiled by it having already happened. Every
    // other action can afford to slip a tick; a missed overhead cannot, because protection is
    // all-or-nothing and applied at the moment the attacker fires.
    //
    // It has to sit ABOVE the countdown gate, not just above the barrage hold. The planner runs
    // one tick ahead, so the prayer chosen on the LAST tick of the countdown is the one
    // protecting the FIRST live tick. Gating it meant the wave always opened with no overhead
    // up - which is the missing first hit, and also why the only click visible during the
    // countdown was the barrage.
    // Route through the control panel when there IS one, so the on-screen tab and cursor stay in
    // step with the engine. With no panel - headless - `clickPrayer` returns without doing
    // anything, so passing it would silently drop every overhead and leave the bot tanking
    // unprayed. `applyPrayerPlan` falls back to toggling the prayer directly when given no
    // callback, which is the same state change by a shorter route.
    const clickPrayer = ControlPanelController.controller
      ? (name: string) => InfernoAutomation.clickPrayer(player, name)
      : undefined;
    applyPrayerPlan(
      player,
      visibleMobs(region),
      true,
      clickPrayer,
      InfernoAutomation.chosenPath,
    );

    // Everything past here is a world action, and world actions are what the countdown gate is
    // for. The wave's mobs are spawned but tickRegion freezes them until getReadyTimer reaches
    // zero, so moving or attacking now just issues input into a world that is not running - the
    // player turns to face a tile without moving, and the first real tick arrives with the bot
    // already mid-action.
    if ((region.world?.getReadyTimer ?? 0) > 0) {
      // Pre-load Ice Barrage while the wave is frozen. Selecting a spell is a UI click - it
      // moves nothing and attacks nothing - so it is safe inside the countdown where world
      // actions are not. The cast itself happens on the first live tick.
      InfernoAutomation.preloadIceBarrage(player);
      return;
    }

    // A loaded barrage is spent before anything else moves.
    //
    // Nibblers are targeted without first checking reachability on purpose. The previous
    // version filtered by line of sight and, finding none (the nibblers spawn tucked against
    // a pillar), dropped the spell and walked off - which is exactly the "it just leaves
    // without casting" behaviour. Setting aggro and holding lets the engine decide when it can
    // cast: Player.attackIfPossible() checks hasLOS and attackDelay itself.
    if (hasIceBarrageSelected(player)) {
      const nibbler = InfernoAutomation.bestBarrageNibbler(region, player);
      if (nibbler) {
        if (player.aggro !== nibbler) {
          player.setAggro(nibbler);
          InfernoAutomation.clickLog.push({
            tile: { x: nibbler.location.x, y: nibbler.location.y },
          });
        }
        InfernoAutomation.reportThreats(region, player);
        return; // hold until Player.attack() consumes the selection
      }
    }

    // Between waves: get into the mage set, load the barrage, and park the cursor on the tile
    // we intend to cast it at. Inventory and spellbook clicks touch neither movement nor combat
    // state, so this happens alongside the walk home rather than competing with it.
    if (InfernoAutomation.isBetweenWaves(region)) {
      if (!isWearing(player, "mage")) {
        InfernoAutomation.equipAndShow(player, "mage");
      }
      // Only once parked. moveTo() nulls manualSpellCastSelection, so selecting it mid-walk home
      // just throws it away.
      if (!InfernoAutomation.isMoving(player)) {
        InfernoAutomation.preloadIceBarrage(player);
      }
      InfernoAutomation.hoverNibblerSpawn();
    }

    // Movement and attacking are NOT independent, and the engine enforces it both ways:
    //   Player.moveTo()  -> interruptCombat() -> setAggro(null)   walking drops the target
    //   setAggro(inRangeMob)                                      attacking stops the walk
    // They are both left-clicks on the world and in OSRS the later one wins, so only one can
    // happen per tick. Movement takes precedence: repositioning decides which mobs can hit us
    // and on which ticks, and a delayed attack only costs a little damage output.
    const repositioning = InfernoAutomation.stepMovement(player, region);
    InfernoAutomation.attackState = repositioning ? "moving" : "-";

    if (repositioning) {
      // The walk has already cleared aggro; drop our record of it so the next attack re-clicks
      // rather than assuming it is still engaged.
      InfernoAutomation.target = null;
    } else {
      // THE ONE LINE TO SWAP. `chooseByPriority` is the simple placeholder - fixed bands, nearest
      // within a band. `TargetPlanner.chooseTarget(region, player, snapshot, route, target)` is
      // the real one, which prices a target by simulating the fight without it and already
      // accounts for the pillar damage a nibbler would do.
      const intended = chooseByPriority(region, player, InfernoAutomation.target);

      if (!intended) {
        InfernoAutomation.attackState = "no target";
      } else {
        const set = requiredSetFor(intended);
        if (!isWearing(player, set)) {
          InfernoAutomation.attackState = `switching to ${set} for ${intended.mobName()}`;
          InfernoAutomation.equipAndShow(player, set);
          // Commit BEFORE returning. The switch costs this tick, and next tick this is the
          // incumbent the chooser has to be given - otherwise the switch we just paid for is
          // re-decided from nothing and can be reversed immediately, which is one gear change
          // per tick and no attacks at all.
          InfernoAutomation.target = intended;
          InfernoAutomation.reportThreats(region, player);
          return;
        }
        InfernoAutomation.attackState = `attacking ${intended.mobName()}`;
      }

      InfernoAutomation.target = applyAttackPlan(
        region,
        player,
        intended,
        InfernoAutomation.target,
        (mob) =>
          InfernoAutomation.clickLog.push({
            tile: { x: mob.location.x, y: mob.location.y },
          }),
      );
    }

    InfernoAutomation.reportThreats(region, player);
    InfernoAutomation.onTickHandler?.(region, player);
  }
}
