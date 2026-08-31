"use strict";

import { Player, Region, Location, Mob, Chrome, ControlPanelController, EntityNames, MapController, Random, Settings } from "osrs-sdk";

import { AutomationOverlay, ClickStep } from "./AutomationOverlay";
import { applyPrayerPlan, incomingThreats, knownAttackStyle, prayerForAttackStyle } from "./PrayerPlanner";
import { applyAttackPlan } from "./AttackPlanner";
import { equipSet, GearSetName, isWearing, requiredSetFor, weaponForSet } from "./GearSets";
import { hasIceBarrageSelected, selectedSpell, selectIceBarrage } from "./SpellCaster";
import { isAttackable } from "./AttackPlanner";
import { bestMove, findShield, focusNibbler, HOME_TILE, isCoveredByShield, projectShield, ScoredTile, scoreCandidates, scoreZukTiles, sortieDebug, tileIsForbidden, waveHomeTile } from "./TileScorer";
import { hasDyingBlob } from "./Trajectory";
import { PlayerAttackClock } from "./PlayerAttackClock";
import { ShieldAttackerClock } from "./ShieldAttackerClock";
import { TagCollisionGate } from "./TagCollisionGate";
import { ZukAttackClock } from "./ZukAttackClock";
import { ZukSetTimer } from "./ZukSetTimer";
import { ArenaSnapshot } from "./ArenaSnapshot";
import { chooseByPriority, chooseJadWaveTarget, committedJad, killPriority, resetJadLock } from "./KillPriority";
import {
  healerSwungThisTick,
  nearestWallTile,
  planSteppedCrossing,
  planHealerApproach,
  readyToTrap,
  steppedRoute,
  taggedHealers,
  trapIsSpent,
  TrapPhase,
} from "./HealerTrap";
import { nibblerThreats, observeNibblers } from "./PillarDefence";
import { attackOptionFor, attackReachForName, chooseTarget } from "./TargetPlanner";
import { visibleMobs } from "./Visibility";

// HOME_TILE lives in TileScorer now, imported above: the last-npc home pull anchors to it, and
// the tile the score pulls towards and the tile waited on between waves must be the same one.

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
   * The wave-69 target decision, broken into the parts `attackState` folds into prose.
   *
   * Instrumentation only - nothing in here is read back into a decision. `band` names which
   * priority band produced the target (untagged-tag / healer / ranger-kill / mager-kill / zuk),
   * or "held" when the tag gate refused the click; `tagGate` is the gate's verdict verbatim on
   * the tick it was asked, null on ticks it never got that far.
   */
  private static zukDecision: {
    target: string | null;
    band: string;
    tagGate: { safe: boolean; reason: string | null } | null;
  } = { target: null, band: "-", tagGate: null };

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

  /**
   * Run energy (0-10000, so this is 10%) the orb is switched back on at - see `restoreRun`.
   */
  private static readonly RUN_RESTORE_THRESHOLD = 1000;

  /**
   * Centre of the run orb in the minimap's own coordinate space, from the box
   * `MapController.leftClickDown` tests (15..67 by 122..149).
   */
  private static readonly RUN_ORB_CENTRE = { x: 41, y: 135 };

  static getLog(): string {
    return InfernoAutomation.log.join("\n");
  }

  /** What the bot decided this tick, verbatim - the same string its own log line carries. */
  static getAttackState(): string {
    return InfernoAutomation.attackState;
  }

  static getChosenTile(): Location | null {
    return InfernoAutomation.chosenTile;
  }

  static getZukDecision(): {
    target: string | null;
    band: string;
    tagGate: { safe: boolean; reason: string | null } | null;
  } {
    return InfernoAutomation.zukDecision;
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
   * The Jad the healer trap is being run against, or null when no trap is running.
   *
   * Held rather than re-derived so the trap can be abandoned the instant its wall dies - see
   * `HealerTrap.trapIsSpent`. It is also what tells the weave and the movement layer to stand
   * down: the trap owns the walk from the moment it starts, and a tick spent shooting or
   * re-scoring mid-trap is a tick the healers spend spreading back out.
   */
  private static trapJad: Mob | null = null;

  /** Where the trap has got to. See `HealerTrap` for what each phase is waiting on. */
  private static trapPhase: TrapPhase = "idle";

  /**
   * The untagged healer currently being walked to, or null.
   *
   * A committed walk, not a scoring preference - see `HealerTrap.planHealerApproach` for why the
   * `healerReach` pull could never move the bot on its own. Held so the walk survives the ticks
   * it takes, and dropped the moment the healer is tagged, dies, or comes into reach.
   */
  private static approachHealer: Mob | null = null;

  /**
   * One trap per set of healers. Latched when a crossing finishes, cleared when the set changes.
   *
   * Without it the entry condition - healers tagged, none left healing - is still true the tick
   * the crossing ends, so the bot would set off for the wall again and never do anything else.
   */
  private static trapDone = false;

  /**
   * Whether the current `chosenTile` earned the safe-spot bonus when it was chosen.
   *
   * Remembered because the arrival settle needs to know what KIND of tile the walk was heading
   * for, and on the tick it matters the fresh scoring pass is exactly the thing being held at
   * arm's length.
   */
  private static chosenIsSafeSpot = false;

  /**
   * True once the arrival settle has been spent on the current chosen tile.
   *
   * Mobs react to where the player stands one tick AFTER the player stands there - engine
   * order is mobs move, mobs attack, player moves - so a verdict rendered on the tick the
   * player arrives somewhere is judged against a board that has not answered the arrival yet.
   * Measured (wave 55, two pillar-jammed bloblets): arrive near a safespot, re-score against
   * the unsettled mobs, get told the mirror tile across the pillar is better, walk off, and
   * repeat forever - a stable oscillation the stuck detector ends after 3000 ticks.
   *
   * So the first tick standing on a chosen SAFE tile keeps the previous decision pinned:
   * repositioning waits exactly one tick while the mobs take their reaction step, and the next
   * re-score is judged against the settled board. Prayer and attacking are untouched - only
   * the movement verdict waits. One settle per arrival: re-confirming the tile the bot is
   * already camped on does not re-arm it, or a camp would only re-score every other tick.
   */
  private static arrivalSettled = false;

  /**
   * Live-wave ticks in a row without a shot fired - the standoff detector for the
   * force-attack backstop. Reset by firing (attackDelay above zero) or an empty board.
   */
  private static idleTicks = 0;

  /** The mob being force-chased, or null when the backstop is not engaged. */
  private static forceTarget: Mob | null = null;
  private static forceTicks = 0;


  /**
   * Every time the backstop has engaged this run - the instrumentation that keeps a forced
   * attack a measurement instead of a mask. The harness prints the per-wave delta, so a wave
   * that only cleared because the bot was shoved reads as exactly that in every sweep.
   */
  private static forcedAttacks = 0;

  /**
    * Hitpoints healed by the wave-69 test scaffolding, and the cap it is drawing from.
    *
    * Reported so a run cannot look survivable on the strength of healing the real client would
    * have done differently - see the note on ZUK_HEAL_AMOUNT.
    */
  static getZukHealing(): { used: number; total: number } {
    return {
      used: InfernoAutomation.zukHealsUsed * InfernoAutomation.ZUK_HEAL_AMOUNT,
      total: InfernoAutomation.ZUK_HEAL_COUNT * InfernoAutomation.ZUK_HEAL_AMOUNT,
    };
  }

  static getForcedAttackCount(): number {
    return InfernoAutomation.forcedAttacks;
  }

  /** Idle ticks before the backstop engages - "a simple 50 tick idle", as specified. */
  private static readonly FORCE_ATTACK_IDLE_TICKS = 50;

  /** Ticks a single forced chase may run before standing down and re-evaluating. */
  private static readonly FORCE_ATTACK_CHASE_TICKS = 100;

  /** The three things a blob becomes. Shared by the stack tests below. */
  private static readonly BLOBLET_NAMES: string[] = [
    EntityNames.JAL_AK_REK_KET,
    EntityNames.JAL_AK_REK_MEJ,
    EntityNames.JAL_AK_REK_XIL,
  ];

  /**
   * Ticks the landing-stack ice barrage has been held waiting for its cast. Kept tight -
   * STACK_HOLD_TICKS and no more - because unlike the nibbler hold, this one runs mid-wave
   * with other mobs shooting: a barrage attempt must never become a standoff of its own.
   */
  private static stackHoldTicks = 0;
  private static readonly STACK_HOLD_TICKS = 6;


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
    InfernoAutomation.zukOnRangerSide = null;
    InfernoAutomation.zukSelfClicked = false;
    InfernoAutomation.zukHealsUsed = 0;
    InfernoAutomation.zukEnraged = false;
    InfernoAutomation.chosenTile = null;
    InfernoAutomation.chosenPath = undefined;
    InfernoAutomation.chosenIsSafeSpot = false;
    InfernoAutomation.arrivalSettled = false;
    InfernoAutomation.idleTicks = 0;
    InfernoAutomation.forceTarget = null;
    InfernoAutomation.forceTicks = 0;
    InfernoAutomation.stackHoldTicks = 0;
    InfernoAutomation.scoredTiles = [];
    InfernoAutomation.hoverTile = null;
    InfernoAutomation.log = [];
    InfernoAutomation.tickCount = 0;
    // The Jad wave's target lock lives in KillPriority, so it needs clearing from here like
    // every other piece of per-run state - see `lockedJad`.
    resetJadLock();
    InfernoAutomation.trapJad = null;
    InfernoAutomation.trapPhase = "idle";
    InfernoAutomation.trapDone = false;
    InfernoAutomation.approachHealer = null;

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
  /**
   * The one nibbler answer, shared by the ice cast and the ordinary attack so the two can
   * never disagree about which one matters.
   *
   * Freeze is read FIRST, and that ordering is the whole point:
   *
   *  - ANYTHING FROZEN -> `focusNibbler`, the same selector the tile score positions for. It
   *    takes the most urgent LOOSE nibbler while any is loose, and falls back to the whole
   *    pool once everything is held. So on a part-frozen board the lane we walk for and the
   *    lane we shoot at are the same nibbler by construction, not by coincidence.
   *  - NOTHING FROZEN -> `bestBarrageNibbler`, the best-covered 3x3 centre. With nothing
   *    neutralised the blast catching two or three is worth more than urgency ordering.
   *
   * Why coverage cannot decide the all-frozen board: `bestBarrageNibbler` counts only
   * UNFROZEN nibblers, so with the whole pack held every candidate scores zero coverage, they
   * all tie, and the tie-break silently becomes distance from the PLAYER - which is the wrong
   * question entirely. Nothing is moving; the only thing that ranks them is how close each
   * already sits to its pillar, which is exactly what `ticksToReach` measures.
   *
   * The seam that remains, stated so nobody claims more than is true: with NO nibbler frozen,
   * positioning still takes the most urgent and this takes the best-covered, so they can name
   * different nibblers. Both are usually inside barrage range of the chosen tile so the cast
   * still lands, but it is the original three-mechanism bug in miniature and it is the first
   * thing to look at if the bot ever walks for one nibbler and casts at another.
   */
  private static nibblerTarget(region: Region, player: Player): Mob | null {
    const threats = nibblerThreats(region);
    if (threats.length === 0) {
      return null;
    }
    if (threats.some((threat) => threat.frozen > 0)) {
      return focusNibbler(threats)?.mob ?? null;
    }
    return InfernoAutomation.bestBarrageNibbler(region, player);
  }

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

  private static isBloblet(mob: Mob): boolean {
    return InfernoAutomation.BLOBLET_NAMES.includes(mob.mobName());
  }

  /**
   * Live bloblets a 3x3 blast centred on this mob would catch, the mob itself included.
   * Two or more is a "stack" - the threshold every stack decision below shares.
   */
  private static blobletsCovered(region: Region, centre: Mob): number {
    return visibleMobs(region).filter(
      (mob) =>
        mob.dying <= -1 &&
        InfernoAutomation.isBloblet(mob) &&
        Math.max(
          Math.abs(mob.location.x - centre.location.x),
          Math.abs(mob.location.y - centre.location.y),
        ) <= 1,
    ).length;
  }

  /**
   * The bloblet whose 3x3 catches the most bloblets - the landing stack's centre in the case
   * that matters, since the three spawn on a diagonal the middle one covers entirely. Nearest
   * breaks ties, same as the nibbler version. Null when no bloblet is alive.
   */
  private static bestBarrageBloblet(
    region: Region,
    player: Player,
  ): { mob: Mob; covered: number } | null {
    const bloblets = visibleMobs(region).filter(
      (mob) => mob.dying <= -1 && InfernoAutomation.isBloblet(mob),
    );
    let best: Mob | null = null;
    let bestCovered = 0;
    let bestDistance = Infinity;
    for (const centre of bloblets) {
      const covered = InfernoAutomation.blobletsCovered(region, centre);
      const distance = Math.max(
        Math.abs(centre.location.x - player.location.x),
        Math.abs(centre.location.y - player.location.y),
      );
      if (covered > bestCovered || (covered === bestCovered && distance < bestDistance)) {
        best = centre;
        bestCovered = covered;
        bestDistance = distance;
      }
    }
    return best ? { mob: best, covered: bestCovered } : null;
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
  /**
   * Turn running back on once there is energy for it.
   *
   * `Unit.movementStep` switches running OFF the moment energy reaches zero and NOTHING in the
   * engine ever switches it back on - energy regenerates (about 15 per tick from an empty
   * tank) but the orb stays dark, so one depletion means walking at ONE tile per tick for the
   * rest of the run. Measured: a wave 21 stuck ending on `run 100% OFF` - a full tank, walking.
   *
   * That is not just slow, it silently invalidates the whole tile score. Trajectory prices
   * every candidate at PLAYER_TILES_PER_TICK = 2, so with the orb off every simulated walk
   * arrives in half the ticks the real one takes, and the mobs are given a reaction step the
   * model never charged for. Reach, safety and damage are then all judged for a walk that is
   * not the walk being taken.
   *
   * A player watches the orb and clicks it back on; this is that click. The engine's own orb
   * handler is exactly this assignment (`MapController.leftClickDown`:
   * `Trainer.player.running = !Trainer.player.running`), so the state change is identical in
   * the browser and headless - the minimap orb redraws from the flag either way.
   *
   * RUN_RESTORE_THRESHOLD, not zero, so the orb is not flicked on into an empty tank and
   * straight back off by the engine on the next step.
   */
  private static restoreRun(player: Player) {
    const runner = player as unknown as { running?: boolean };
    if (runner.running) {
      return;
    }
    const energy = (player.currentStats as unknown as { run?: number })?.run ?? 0;
    if (energy <= InfernoAutomation.RUN_RESTORE_THRESHOLD) {
      return;
    }
    runner.running = true;
    // Show it on the cursor, like every other click the bot makes.
    const orb = InfernoAutomation.runOrbCanvasPoint();
    if (orb) {
      InfernoAutomation.clickLog.push({ canvas: orb });
    }
  }

  /**
   * Where the run orb sits in game-canvas pixels, or null when there is no minimap to click -
   * headless, or before the map controller exists.
   *
   * `MapController.leftClickDown` maps a canvas click INTO minimap space with
   *
   *     offset = Chrome.size().width - map.width - (menuVisible ? 232 : 0)
   *     x = (canvasX - offset) / scale        y = canvasY / scale
   *
   * and treats `15 < x < 67, 122 < y < 149` as the run orb. This is that arithmetic inverted
   * from the centre of the box, so the drawn cursor lands where a player's really would.
   * `map.width` is already scaled (`draw` sets it to INITIAL_WIDTH * scale), so it must not be
   * scaled again here.
   *
   * Wrapped because it is decoration on a decision: `decide()` is called inside a try/catch
   * that turns any throw into a skipped tick, and a cursor position must never be able to cost
   * the bot its movement and attack.
   */
  private static runOrbCanvasPoint(): { x: number; y: number } | null {
    try {
      const map = MapController.controller as unknown as { width?: number } | undefined;
      if (!map || typeof map.width !== "number") {
        return null;
      }
      const scale = Settings.minimapScale || 1;
      const offset =
        Chrome.size().width - map.width - ((Settings as { menuVisible?: boolean }).menuVisible ? 232 : 0);
      return {
        x: offset + InfernoAutomation.RUN_ORB_CENTRE.x * scale,
        y: InfernoAutomation.RUN_ORB_CENTRE.y * scale,
      };
    } catch (e) {
      return null;
    }
  }

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
    // The automation's own reading, not the raw getter - a dying blob is not downtime.
    const between = InfernoAutomation.isBetweenWaves(region);
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
  /**
   * Did this tick issue a walk CLICK, as opposed to letting one already in flight continue?
   *
   * The distinction decides which tick a shot may share. `moveTo` calls `interruptCombat`, so a
   * new tile click wipes aggro and the two cannot share a tick. A walk already under way is not
   * re-clicked - `stepMovement` just returns true and leaves it alone.
   *
   * CORRECTED 2026-08-21 (test/harness/clickPhysics.probe.test.ts): an attack DOES end the walk.
   * This comment used to claim `setAggro` never touches `destinationLocation` and the walk
   * carries on underneath a shot - wrong against the current engine, and the client port died on
   * inheriting it (capture 1787316434906). `Player.determineDestination` runs every movement
   * step: while aggro holds with the target in range and sight it clamps the destination to the
   * standing tile (the player STOPS on the shot tick and stays stopped), and out of range it
   * paths TOWARD the target - the drag. The walk resumes only because `stepMovement` reads
   * `isMoving` false on the next pass and re-clicks, so a mid-walk shot costs exactly ONE
   * stationary tick. The cadence keeps pace with the shield anyway: 2 tiles a tick of run
   * against 1 tile a tick of band.
   */
  private static walkClickIssued = false;

  /**
   * When the blowpipe goes on: this many ticks after Zuk's Nth watched attack.
   *
   * Timed off the recorded tick of a specific attack rather than off a running count, so the
   * trigger cannot drift if a fire is ever missed or double-counted.
   *
   * Zuk opens at attackDelay 14 and repeats every 10, so its Nth attack lands on tick 4 + 10N -
   * the sixth at 64. Eight ticks past that is 72, which is exactly when `TzKalZuk.setTimer`
   * expires and the first mager and ranger spawn.
   *
   * Landing BETWEEN Zuk's attacks is the point of the offset rather than an accident of it: a
   * multiple of 10 would coincide with an attack, and a tick spent equipping is a tick not spent
   * reacting to one. Eight puts it in the gap after the sixth and before the seventh at 74.
   */
  /**
   * Ticks before the next pair lands that the blowpipe goes on, and the mager-side tile click is
   * spent.
   *
   * Timed off `ZukSetTimer` rather than counted from a Zuk attack. The hit-count version was
   * always a proxy - Zuk's cadence and the set timer only line up because 350 is a multiple of
   * 10, and the moment the timer pauses under 600 hitpoints and gains 1:45 they come apart
   * completely, at exactly the point in the fight where being ready matters most.
   */
  private static readonly ZUK_SWAP_BEFORE_SET = 3;

  /**
   * How many ticks before the shot a weapon change is allowed to happen.
   *
   * TWO, so the swap lands on the tick before the cooldown expires and the shot goes out the tick
   * after. Every earlier tick is left alone.
   *
   * Swapping the moment the WANTED weapon changes is what produced the thrash: the wanted weapon
   * is recomputed from live distance every tick, and distance changes every tick because both the
   * shield and the mobs are moving - so on a five-tick crossbow cooldown the bot spent three or
   * four of those ticks changing gear for a shot it could not take yet, then changed back. Across
   * a 12-seed sweep, a quarter of every tick a set mob sat untagged AND IN REACH was spent
   * swapping.
   *
   * Deciding late costs nothing, because a weapon changed on a cooldown tick buys nothing the same
   * change would not buy on the last one, and answers the question with the distance that will
   * actually apply rather than a distance from four ticks ago.
   */
  private static readonly ZUK_SWAP_LEAD = 2;

  /**
   * Where a pair always spawns - `TzKalZuk.attackIfPossible` constructs them at these exact tiles.
   *
   * Fixed, so the pre-swap can ask a real question instead of a proxy one: is the weapon we are
   * about to hold able to reach the tile the mob is about to appear on. The old test was "are we
   * east", which is not the same question and answered it wrong - measured across 12 seeds, a set
   * mob was NEVER within blowpipe range while untagged, so the blowpipe was being pre-equipped for
   * a target it could not hit and swapped straight back off.
   */
  private static readonly ZUK_MAGER_SPAWN = { x: 20, y: 21 };
  private static readonly ZUK_RANGER_SPAWN = { x: 29, y: 21 };

  /**
   * The line between the mager's half of the arena and the ranger's.
   *
   * A set always spawns split - `TzKalZuk.attackIfPossible` puts the mager at x 20 and the ranger
   * at x 29 - so west of here is the mager's side and east is the ranger's. Which side you are
   * standing on is something a player just knows by looking, and that is the whole test.
   *
   * A constant rather than a reading off the mobs, because the switch can come due on the very
   * tick they spawn and `visibleMobs` deliberately hides a mob until the tick AFTER it is added -
   * the renderer has not drawn it yet. Where sets spawn is static knowledge of the fight; the
   * mobs themselves are not ours to see yet.
   */
  private static readonly ZUK_SET_DIVIDE_X = 25;

  /**
   * The hitpoints below which a tagged mager is worth killing.
   *
   * `TzKalZuk.damageTaken` pauses the set timer the first time it drops under 600 and never
   * restarts it until Jad is out, so racing Zuk to this number is racing to stop any FURTHER
   * pairs arriving - which is worth more than finishing the one already on the board. Above it,
   * a tagged mager is already doing its worst and costs nothing extra to leave alive; below it
   * there is nothing left to race and it can be cleaned up.
   *
   * SO THIS NUMBER SPLITS THE FIGHT IN TWO, and it gates the hold below as well as the target
   * order. Above it, leaving a tagged mager alive is the plan. Below it there is no plan that
   * involves a live set at all: the pair is cleared to the last one before Zuk is touched again,
   * because everything after this point - the run to enrage, four healers, a faster Zuk - is hard
   * enough without a mager still throwing magic through it.
   */
  private static readonly ZUK_MAGER_KILL_HP = 600;

  /**
   * The hitpoints TzKalZuk enrages at - `damageTaken`'s own `< 240`.
   *
   * Four `JalMejJak` at once and the attack speed dropping 10 -> 7, which is the single biggest
   * step change in the fight. Every rule below is about choosing WHEN to cross it.
   */
  private static readonly ZUK_ENRAGE_HP = 240;

  /**
   * Hold Zuk above this while a set is imminent, rather than walking into both at once.
   *
   * THE STATE BEING AVOIDED is enrage landing on top of a fresh pair. Crossing ZUK_ENRAGE_HP puts
   * four healers on the board pouring hitpoints back into Zuk while its attack speed rises; doing
   * that with a mager and ranger also arriving means the shield is being eaten from three
   * directions and the healers - the only thing on the board that undoes work already done - are
   * the ones that go unanswered.
   *
   * So the last few hitpoints before enrage are deliberately not spent while a pair is due. The set
   * is allowed to arrive against a Zuk that is still slow and still unhealed, both halves are
   * killed, and the timer resets to its full interval - which buys well over the minute this was
   * holding for, all of it clear, to cross enrage and answer the healers in.
   *
   * WRITTEN AS A MARGIN ON ENRAGE, not as a number, because that is what it is: the room for the
   * LAST shot that goes out before the hold arms. The hold can only be checked between shots, so
   * whatever is in flight when hitpoints cross the line still lands, and the margin is what stops
   * that landing inside enrage. It is not a target to coast down to.
   *
   * 40 covers a normal roll comfortably. It is still RNG - a big enough hit from just above 280
   * carries through into enrage anyway - and that is accepted rather than solved.
   */
  private static readonly ZUK_HOLD_SET_MARGIN = 40;
  private static readonly ZUK_HOLD_SET_HP =
    InfernoAutomation.ZUK_ENRAGE_HP + InfernoAutomation.ZUK_HOLD_SET_MARGIN;

  /** One minute, at 0.6s a tick. How close a pair has to be for ZUK_HOLD_SET_HP to arm. */
  private static readonly ZUK_HOLD_SET_TICKS = 100;

  /**
   * Whether enrage has already happened, latched.
   *
   * NOT DERIVED FROM HITPOINTS, because `JalMejJak.HealWeapon` rolls a NEGATIVE damage into Zuk -
   * it genuinely heals it - so Zuk can climb back above ZUK_ENRAGE_HP after enraging and a live
   * `hp < 240` test would report the fight un-enraged while four healers stood on the board. Once
   * seen, it is true for the rest of the fight; `setEnabled` clears it with the rest of the state.
   */
  private static zukEnraged = false;

  /**
   * Which side we were on when the blowpipe came due, or null before that.
   *
   * LATCHED, not re-read. The bot follows a shield that slides a tile a tick, so a live test
   * would flip sides mid-fight and thrash the gear a tick at a time. "Which half were we on when
   * the set landed" has exactly one answer.
   */
  private static zukOnRangerSide: boolean | null = null;

  /** Whether the mager-side tile click has already been spent - see where it is issued. */
  private static zukSelfClicked = false;

  /**
   * TEST SCAFFOLDING, NOT A FEATURE. Wave 69 only, and temporary.
   *
   * THE CLIENT THIS IS PORTED INTO ALREADY HAS A VITALS LANE. Eating, drinking and staying alive
   * are its job and are not being rebuilt here. This exists only so a wave-69 run in this
   * simulator does not end with "died at full inventory", which answers nothing about the fight.
   *
   * It is NOT a simulation of eating. Hitpoints move directly rather than through an inventory
   * click, so there is no dose tracking, no four-sip vial, no brew stat drain and no restore to
   * undo it. The one thing it does model is the only part that changes a decision: healing COSTS
   * THE TICK, so it competes with attacking exactly as a real sip would.
   *
   * Five of twenty is a hundred hitpoints against a 99 pool - roughly a brew and a half - enough
   * to tell whether a run dies of the fight or dies of never topping up. Delete it rather than
   * grow it: anything more than this is duplicating a lane that already exists elsewhere.
   */
  private static readonly ZUK_HEAL_AMOUNT = 16;
  private static readonly ZUK_HEAL_COUNT = 8;
  private static zukHealsUsed = 0;

  /**
   * Waves the attack weave applies to. 67 and 68 - the Jad fights.
   *
   * SCOPED, NOT GLOBAL, and deliberately so. Inverting movement and attacking is a real change to
   * how every tick of every wave is spent, and waves 1-66 are the measured baseline every scoring
   * change is judged against - re-basing them is a decision to take on purpose with a sweep to
   * back it, not a side effect of fixing the Jad waves. Widening it is this list.
   */
  private static readonly WEAVE_WAVES: number[] = [67, 68];

  /**
   * Does a ready weapon hold this tick's walk?
   *
   * THE GENERAL RULE - movement first, always - is right on a normal wave and wrong on a Jad one,
   * and the difference is what the movement is FOR. Everywhere else, repositioning is dodging:
   * which tiles are safe changes every tick, so a tick spent walking buys real damage avoided. On
   * 67/68 there is nothing to dodge. Jad's range is 50 and it sees the whole arena, so no tile is
   * safer than another, and what the tile score is actually choosing between is angles on the
   * same fight. Meanwhile `IMPROVEMENT_MARGIN` is zero, so a tile a single hundredth better wins
   * and issues a walk - and a walk calls `interruptCombat`. Three Jads at 350 hitpoints each, and
   * the bot can spend the entire fight one hundredth ahead of itself, never shooting.
   *
   * So on those waves a click that will actually fire outranks a reposition. The walk is not
   * cancelled, only skipped for this tick: nothing here clears `chosenTile`, scoring re-runs next
   * tick, and the walk re-issues then - which is exactly what a player does, weaving a step
   * between attacks rather than choosing one or the other for the fight.
   *
   * All four conditions have to hold, and the last two are what keep this from being "never
   * move": the weapon must be off cooldown, something must be worth clicking, and the gear for it
   * must ALREADY be worn - a tick that would be spent switching is a tick that should be spent
   * walking instead, since the switch happens either way. And an escape outranks everything: a
   * bot standing inside a melee ring must leave, whatever its weapon is doing.
   */
  private static weaveHoldsWalk(region: Region, player: Player): boolean {
    if (InfernoAutomation.trapJad || InfernoAutomation.approachHealer) {
      return false; // a committed walk owns the tick
    }
    const wave = (region as unknown as { wave?: number }).wave ?? 0;
    if (!InfernoAutomation.WEAVE_WAVES.includes(wave)) {
      return false;
    }
    if ((player.attackDelay ?? 0) > 0) {
      return false;
    }
    if (tileIsForbidden(region, player, player.location)) {
      return false; // escaping beats shooting - see bestMove's escape branch
    }
    const target = chooseJadWaveTarget(region, player);
    if (!target) {
      return false;
    }
    const set = attackOptionFor(region, player, target)?.set ?? requiredSetFor(target);
    return isWearing(player, set);
  }

  /**
   * Drive the healer trap: to the wall, wait for a swing, cross to the far side of Jad.
   *
   * Owns `route` for the duration. `stepMovement` already walks a queued route in preference to
   * the scored station tile, and holds the walk while `trapJad` is set, so once a leg is queued
   * this only has to decide when that leg is over.
   *
   * ABANDONING CLEARS THE ROUTE rather than letting it drain. A crossing whose wall has died is a
   * walk around empty floor, and the remaining waypoints would keep the bot out of the fight for
   * several more ticks while healers that are no longer blocked by anything close back in.
   */
  /**
   * Walk to where the nearest untagged healer can be blowpiped, in steps, then hand back over.
   *
   * Dropped the moment the healer is tagged, dies, or is close enough to click - at which point
   * the ordinary attack path picks it up as `chooseJadWaveTarget`'s top choice and fires. The walk
   * exists only to close a distance the score could not.
   */
  private static stepHealerApproach(region: Region, player: Player) {
    // NEVER WHILE A TRAP IS RUNNING. Both own `route`, and this one runs first - so a healer
    // coming into view mid-crossing would overwrite the walk the trap had committed to, sending
    // the bot back the way it came. That is the step-forward-step-back. The trap finishes, then
    // this picks up whatever is still untagged.
    if (InfernoAutomation.trapJad) {
      return;
    }
    const reach = attackReachForName(player, EntityNames.YT_HUR_KOT);

    if (InfernoAutomation.approachHealer) {
      const healer = InfernoAutomation.approachHealer;
      const done =
        healer.dying > -1 ||
        healer.aggro === player ||
        Math.max(
          Math.abs(healer.location.x - player.location.x),
          Math.abs(healer.location.y - player.location.y),
        ) <= reach;
      if (done) {
        InfernoAutomation.approachHealer = null;
        InfernoAutomation.clearRoute();
        return;
      }
      if (InfernoAutomation.route.length === 0 && !InfernoAutomation.isMoving(player)) {
        InfernoAutomation.approachHealer = null; // arrived but still short - re-plan next tick
        return;
      }
      InfernoAutomation.attackState = "walking to tag a healer";
      return;
    }

    const plan = planHealerApproach(region, player, reach);
    if (!plan) {
      return;
    }
    InfernoAutomation.approachHealer = plan.healer;
    InfernoAutomation.setRoute(plan.route);
    InfernoAutomation.attackState = "walking to tag a healer";
  }

  private static stepTrap(region: Region, player: Player) {
    if (InfernoAutomation.trapJad) {
      if (trapIsSpent(region, player, InfernoAutomation.trapJad)) {
        InfernoAutomation.trapJad = null;
        InfernoAutomation.trapPhase = "idle";
        InfernoAutomation.clearRoute();
        return;
      }

      const arrived =
        InfernoAutomation.route.length === 0 && !InfernoAutomation.isMoving(player);

      if (InfernoAutomation.trapPhase === "to-wall") {
        if (arrived) {
          InfernoAutomation.trapPhase = "at-wall";
        }
        InfernoAutomation.attackState = "trap: backing into the wall";
        return;
      }

      if (InfernoAutomation.trapPhase === "at-wall") {
        // THE SWING IS THE STARTING GUN. Waiting for it is what makes the crossing a fact rather
        // than a guess: a healer that has just attacked is adjacent, has spent its tick, and its
        // next step is computed from where it stands now - bunched against us at the wall - so
        // the body lands squarely on its line the moment we are across.
        if (healerSwungThisTick(region, player)) {
          const crossing = planSteppedCrossing(
            region,
            player,
            taggedHealers(region, player),
            InfernoAutomation.trapJad,
          );
          if (crossing.length === 0) {
            return; // no clean way round yet - hold at the wall and try again next tick
          }
          // Every waypoint against every melee ring on the board, not just this Jad's. The ring
          // is two tiles clear of ITS OWN wall by construction, but on wave 68 the other two Jads
          // stand on the same floor and a crossing can pass through one of them.
          if (crossing.some((tile) => tileIsForbidden(region, player, tile))) {
            InfernoAutomation.trapJad = null;
            InfernoAutomation.trapPhase = "idle";
            InfernoAutomation.trapDone = true; // do not thrash at the wall retrying every tick
            return;
          }
          InfernoAutomation.setRoute(crossing);
          InfernoAutomation.trapPhase = "crossing";
          InfernoAutomation.attackState = "trap: crossing to the far side of jad";
          return;
        }
        InfernoAutomation.attackState = "trap: at the wall, waiting for a swing";
        return;
      }

      if (InfernoAutomation.trapPhase === "crossing") {
        if (arrived) {
          InfernoAutomation.trapJad = null;
          InfernoAutomation.trapPhase = "done";
          InfernoAutomation.trapDone = true;
        } else {
          InfernoAutomation.attackState = "trap: crossing to the far side of jad";
        }
        return;
      }
      return;
    }

    // A NEW SET OF HEALERS RE-ARMS THE TRAP. The latch is about not repeating a trap for the same
    // healers; a Jad dropping below half spawns three more that have never been trapped.
    if (InfernoAutomation.trapDone && taggedHealers(region, player).length === 0) {
      InfernoAutomation.trapDone = false;
    }
    if (InfernoAutomation.trapDone || !readyToTrap(region, player)) {
      return;
    }

    const wall = nearestWallTile(region);
    if (tileIsForbidden(region, player, wall)) {
      return; // a Jad is parked on the wall we would back into; not this tick
    }
    // Stepped and mob-aware, or it is a blind run straight through whatever is in the way.
    const toWall = steppedRoute(region, player.location, wall);
    if (toWall.length === 0) {
      return;
    }
    InfernoAutomation.trapJad = committedJad(region);
    InfernoAutomation.trapPhase = "to-wall";
    InfernoAutomation.setRoute(toWall);
    InfernoAutomation.attackState = "trap: backing into the wall";
  }

  private static stepMovement(player: Player, region: Region): boolean {
    InfernoAutomation.walkClickIssued = false;
    // An explicitly queued route wins over any station tile.
    if (!InfernoAutomation.isMoving(player) && InfernoAutomation.route.length > 0) {
      const next = InfernoAutomation.route.shift();
      if (next) {
        InfernoAutomation.walkClickIssued = true;
        InfernoAutomation.walkTo(player, next.x, next.y);
        InfernoAutomation.walkingTo = { x: next.x, y: next.y };
        return true;
      }
    }

    // MID-LEG, THE LAP KEEPS THE WALK. The branch above only fires on a tick the player is
    // standing still, so while it is walking between two corners the code below would ask the
    // tile scorer where to be, get a different answer - it has no idea a lap is running - and
    // re-click there, abandoning the circuit on its second tick. Every leg would be cut short and
    // the lap would never trap anything.
    //
    // Gated on the lap rather than on `route.length`, because the final leg has already been
    // shifted off the queue and would otherwise be the one leg left unprotected. `stepTrap` runs
    // before this and clears `trapJad` the moment the last waypoint is reached, so this cannot
    // outlive the circuit.
    if (InfernoAutomation.trapJad || InfernoAutomation.approachHealer) {
      return true;
    }

    const station = InfernoAutomation.stationTile(region, player);
    if (player.location.x === station.x && player.location.y === station.y) {
      InfernoAutomation.walkingTo = null;
      return false;
    }

    // Already walking to the right place - stay committed, UNLESS the destination has become a
    // melee ring since the walk was clicked.
    //
    // THE CLICK-PROCESS TEST. The route veto runs inside scoring, against the board as it stood
    // when the tile was chosen. The click is processed a tick later, from a tile the player has
    // moved to, against mobs that have moved themselves - and this branch is where a walk chosen
    // on an older board survives, because "already going there" short-circuits every check that
    // would re-ask. A Jad that stepped onto the destination in the meantime is the case that
    // actually happens: the tile was legal when it was picked and is inside a ring by the time
    // the player arrives on it.
    //
    // Re-asked of the DESTINATION rather than the whole route on purpose - see `tileIsForbidden`.
    // Failing it drops the commitment rather than stopping the bot: the code below re-clicks at
    // whatever the fresh station is, which scoring has already vetted against the current board.
    const walkingTo = InfernoAutomation.walkingTo;
    if (
      InfernoAutomation.isMoving(player) &&
      walkingTo &&
      walkingTo.x === station.x &&
      walkingTo.y === station.y &&
      !tileIsForbidden(region, player, walkingTo)
    ) {
      return true;
    }

    // Either standing still off-station, or walking somewhere that is no longer where we
    // want to be. The second case is what happens when a wave spawns mid-way back to the
    // safe spot: getting home is best-effort, and once the wave is live the wave tile
    // matters more than finishing the trip.
    InfernoAutomation.walkClickIssued = true;
    InfernoAutomation.walkTo(player, station.x, station.y);
    InfernoAutomation.walkingTo = { x: station.x, y: station.y };
    return true;
  }

  /**
   * The tile the bot should be standing on right now.
   *
   * Between waves it returns to the home tile for the wave being ENTERED - `region.wave` still
   * holds the cleared wave during the downtime, since `spawnNextWave` increments at spawn.
   * Jad is waited for at 18,25 and the triple Jads at 25,27, matching where those spawns place
   * the player; going into Zuk there is no home at all, so the bot holds wherever it stands.
   * While a wave is live the tile scorer decides.
   *
   * Null chosenTile means scoring had nothing to say - it was skipped, or it threw - and the
   * answer is then "where the player already is", which is a decision to hold rather than an
   * absence of one, and keeps the movement layer from walking somewhere nothing chose.
   */
  private static stationTile(region: Region, player: Player): Location {
    if (InfernoAutomation.isBetweenWaves(region)) {
      const entering =
        ((region as unknown as { wave?: number }).wave ?? 0) + 1;
      if (entering >= 69) {
        return { x: player.location.x, y: player.location.y };
      }
      // The same map the tile scorer's homePull anchors to, so the tile waited on between
      // waves and the tile pulled towards during them can never disagree.
      return waveHomeTile(entering) ?? HOME_TILE;
    }
    return InfernoAutomation.chosenTile ?? player.location;
  }

  /**
   * InfernoRegion exposes this; other regions do not, so treat absence as "wave live".
   *
   * Overruled by a dying blob. The region's getter is `mobs.every(mob => mob.dying !== -1)`, so
   * a blob part-way through its death animation reads as downtime - and downtime sends the bot
   * home, ignoring tile scoring entirely. Measured: the bot walked to HOME_TILE across the
   * spawn point while three bloblets were landing on it, and the debug grid showed a chosen
   * tile the movement layer was not using, because `chosenTile` is null between waves.
   *
   * `JalAk.removedFromWorld` spawns its three bloblets unconditionally, so a dying blob always
   * means more mobs - there is no case where calling it downtime is right. The same predicate
   * drives the ghost bloblets, so the threat model and the wave state cannot disagree.
   */
  private static isBetweenWaves(region: Region): boolean {
    if ((region as unknown as { isBetweenWaves?: boolean }).isBetweenWaves !== true) {
      return false;
    }
    return !hasDyingBlob(region);
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
      InfernoAutomation.chosenIsSafeSpot = false;
      InfernoAutomation.arrivalSettled = false;
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
    // Run energy is 0-10000 in the engine, shown here as percent. The engine flips `running`
    // to false when energy reaches 0 and never turns it back on by itself, so the OFF marker
    // is the thing to look for in a walking-speed mystery.
    const energy = Math.round(
      ((player.currentStats as { run?: number })?.run ?? 0) / 100,
    );
    const orb = (player as unknown as { running?: boolean }).running ? "ON" : "OFF";

    // WAVE 69 ONLY: the shield's own state, and the tick Zuk is expected to fire.
    //
    // Without these a wave-69 log cannot answer the only question that matters about a Zuk hit -
    // where the band actually was when the shot was aimed. Position alone is not enough: the
    // target tile is derived from the shield PROJECTED to the fire tick, so a destination that
    // walks backwards is either the shield reversing or the shield frozen mid-bounce while the
    // clock keeps counting, and those are indistinguishable from the outside.
    //
    // `frozen` is the one to watch. `ZukShield.movementStep` only steps while it is <= 0, so a
    // frozen shield holds position while `untilFire` keeps dropping - which drags the projected
    // band, and therefore the chosen tile, back towards the player a tile per tick.
    let zukState = "";
    const shield = visibleMobs(region).find(
      (mob) => mob.dying <= -1 && mob.mobName() === EntityNames.INFERNO_SHIELD,
    );
    if (shield) {
      const live = shield as unknown as { movementDirection?: boolean; frozen?: number };
      const covered =
        player.location.x >= shield.location.x &&
        player.location.x < shield.location.x + 5 &&
        player.location.y <= 16;
      const untilSet = ZukSetTimer.ticksUntilSet();
      zukState =
        `shield=${shield.location.x}..${shield.location.x + 4}` +
        `${live.movementDirection ? "E" : "W"}` +
        `${(live.frozen ?? 0) > 0 ? `frz${live.frozen}` : ""} ` +
        `${covered ? "COV" : "EXP"} ` +
        `zukIn=${ZukAttackClock.ticksUntilNextAttack() ?? "-"} ` +
        `setIn=${untilSet ?? "-"}${ZukSetTimer.isPaused() ? "P" : ""} `;
    }

    const line =
      `t${String(InfernoAutomation.tickCount).padStart(4)} ` +
      `@${player.location.x},${player.location.y} ` +
      `-> ${chosen ? `${chosen.x},${chosen.y}` : "home"} ` +
      `pray=${(overhead?.feature() ?? "-").padEnd(5)} ` +
      `hp=${player.currentStats?.hitpoint ?? "?"} ` +
      `run=${energy}% ${orb} ` +
      zukState +
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

  /**
   * The overhead for this tick. Extracted so there is exactly one prayer path: wave 69 has been
   * stripped back to prayer alone, and it has to be provably the SAME prayer full automation
   * does, not a second copy that can drift from it.
   *
   * Route through the control panel when there IS one, so the on-screen tab and cursor stay in
   * step with the engine. With no panel - headless - `clickPrayer` returns without doing
   * anything, so passing it would silently drop every overhead and leave the bot tanking
   * unprayed. `applyPrayerPlan` falls back to toggling the prayer directly when given no
   * callback, which is the same state change by a shorter route.
   */
  private static prayThisTick(region: Region, player: Player, route?: Location[]) {
    const clickPrayer = ControlPanelController.controller
      ? (name: string) => InfernoAutomation.clickPrayer(player, name)
      : undefined;
    applyPrayerPlan(player, visibleMobs(region), true, clickPrayer, route);
  }

  /**
   * WAVE 69, STRIPPED TO THE FLOOR.
   *
   * Four things happen on this wave and nothing else does: the prayer planner runs, every
   * candidate tile is scored on cover and on distance from the shield's leading face, the bot
   * walks to the winner, and if it did not have to walk it shoots Zuk. No other target, no
   * force-attack backstop, no barrage, no supplies - the return in `decide` is what guarantees
   * it, rather than a flag each of those layers is trusted to check.
   *
   * THE ATTACK IS DELIBERATELY THE SIMPLEST ONE THAT EXISTS: Zuk, whenever we are not walking.
   * No target selection, no priority, nothing about the mager, ranger or Jad that this will
   * start spawning - `TzKalZuk.damageTaken` pauses the set timer under 600, spawns Jad under
   * 480 and the healers under 240, and none of that is answered yet. Expect it to die sooner
   * than the version that never attacked, not later; the point is to put real shots on the
   * timeline so the player lane can be read against Zuk's.
   *
   * MOVEMENT WINS OVER SHOOTING, the same way it does in `decide`. A walk issues `moveTo`, which
   * calls `interruptCombat` and clears aggro, so the two genuinely cannot both happen on one
   * tick - and position decides which ticks we get hit on, while a delayed shot costs only
   * damage output.
   *
   * The score is published through the same `scoredTiles` field the old path used, so the 3D
   * tile grid draws it with no change to InfernoRegion or TileGrid.
   */
  private static decideZukWave(region: Region, player: Player) {
    // Fresh every tick, so a tick that returns before target selection cannot inherit last
    // tick's decision. Instrumentation only - see the field.
    InfernoAutomation.zukDecision = { target: null, band: "-", tagGate: null };
    // No safespot concept on this wave, so the settle-on-arrival hold that guards one never
    // arms. Cleared rather than left alone, in case a wave was entered from one that had.
    InfernoAutomation.chosenIsSafeSpot = false;
    InfernoAutomation.arrivalSettled = false;
    // Scoring is best-effort and prayer is not - same order and same reasoning as `decide`.
    // attackState is assigned on BOTH paths, so last tick's failure cannot outlive the tick
    // that failed.
    let failed = false;
    try {
      InfernoAutomation.scoredTiles = InfernoAutomation.isBetweenWaves(region)
        ? []
        : scoreZukTiles(region, player);
      // Null between waves and whenever nothing beats holding - `stationTile` reads that as
      // "stay where you are", which is the right answer in both cases.
      const move = bestMove(region, player, InfernoAutomation.scoredTiles);
      InfernoAutomation.chosenTile = move?.tile ?? null;
      InfernoAutomation.chosenPath = move?.route;
    } catch (e) {
      failed = true;
      InfernoAutomation.scoredTiles = [];
      InfernoAutomation.chosenTile = null;
      InfernoAutomation.chosenPath = undefined;
      InfernoAutomation.attackState = `SCORING FAILED: ${(e as Error)?.message ?? e}`;
    }
    InfernoAutomation.prayThisTick(region, player, InfernoAutomation.chosenPath);

    // Prayer is above the countdown gate and movement is below it, exactly as in `decide`. The
    // planner runs a tick ahead, so the overhead chosen on the LAST countdown tick is the one
    // protecting the FIRST live tick - gating prayer opens the wave unprayed. A walk, in
    // contrast, is a world action issued into a world tickRegion has frozen: the player turns
    // to face the tile without moving and the first live tick arrives mid-action. Scoring above
    // still runs, so the grid is populated and correct before the wave starts - the shield does
    // not move during the countdown either, so there is nothing to be stale about.
    if ((region.world?.getReadyTimer ?? 0) > 0) {
      if (!failed) {
        InfernoAutomation.attackState = "wave 69: waiting out the countdown";
      }
      return;
    }

    // Run back on, before anything can issue a walk this tick. Part of moving rather than a
    // fourth behaviour: the shield slides a tile per tick and a WALKING player also does one
    // tile per tick, so with the orb off the bot can hold station on the leading face but can
    // never close on it. Running is what makes "follow" mean anything.
    InfernoAutomation.restoreRun(player);

    // A scoring throw has already put its own message in attackState; nothing below should
    // overwrite it, since where the bot stands is the more urgent failure.
    const say = (text: string) => {
      if (!failed) {
        InfernoAutomation.attackState = text;
      }
    };

    // A READY TAG OUTRANKS A ROUTINE WALK CLICK. The walk owning the tick (below) is right when
    // the walk is survival; it is wrong when the walk is the face preference tidying position
    // while a one-or-two-tick tag window closes. Measured on seed 26 set 8: the ranger was in
    // crossbow reach for exactly two ticks - the spawn-visibility tick, unavoidable, and t3008,
    // which a follow-shield click spent while the player's tile stayed covered for three more
    // ticks. The westbound shield then pulled the ranger out of reach, its sortie trip never
    // fit the enraged budget, and it put the shield's last 72 hitpoints into the floor.
    //
    // So the walk click is deferred ONE tick when everything needed to tag is already true:
    // an untagged set mob attackable from this tile, the weapon ready, the gate content, and -
    // the part that keeps this honest - the tile we would stand on still covered when Zuk's
    // next shot is aimed. Cover is a deadline, not a standing requirement (see the scorer), so
    // a tick of stillness inside that deadline is free; when it is not free, the walk keeps the
    // tick exactly as before.
    let walkDeferredForTag = false;
    if (PlayerAttackClock.earliestShotOffset() === 1) {
      const heavyReach = Math.max(
        (weaponForSet(player, "blowpipe") as { attackRange?: number } | null)
          ?.attackRange ?? 0,
        (weaponForSet(player, "tbow") as { attackRange?: number } | null)
          ?.attackRange ?? 0,
      );
      const tagable = visibleMobs(region).find(
        (mob) =>
          mob.dying === -1 &&
          mob.aggro !== player &&
          (mob.mobName() === EntityNames.JAL_ZEK ||
            mob.mobName() === EntityNames.JAL_XIL ||
            mob.mobName() === EntityNames.JAL_TOK_JAD) &&
          isAttackable(region, player, mob, heavyReach) &&
          TagCollisionGate.evaluate(region, player, mob).safe,
      );
      if (tagable) {
        const shieldHere = findShield(region);
        const untilFire = ZukAttackClock.ticksUntilNextAttack();
        walkDeferredForTag =
          shieldHere !== null &&
          untilFire !== null &&
          untilFire >= 2 &&
          isCoveredByShield(
            player.location.x,
            player.location.y,
            projectShield(shieldHere, untilFire).x,
          );
      }
    }
    if (walkDeferredForTag) {
      InfernoAutomation.walkClickIssued = false;
    }
    const repositioning = walkDeferredForTag
      ? false
      : InfernoAutomation.stepMovement(player, region);

    // THE WALK OWNS THE TICK IT IS CLICKED ON. A tile click and an attack click are both world
    // clicks, one per tick, and `moveTo` -> `interruptCombat` has already cleared aggro by the
    // time we get here - so this tick's shot is gone whatever we do. Movement takes it, and the
    // record of the target goes with it so the next attack re-clicks rather than assuming it is
    // still engaged.
    if (repositioning && InfernoAutomation.walkClickIssued) {
      InfernoAutomation.target = null;
      say("wave 69: following shield");
      return;
    }

    // Everything past here spends NO click on movement: either standing on station, or part-way
    // through a walk that was clicked on an earlier tick and needs no re-click (see
    // `walkClickIssued`). A shot on those ticks is NOT free - setAggro ends the in-flight walk
    // (the engine clamps the destination to the standing tile while aggro holds; probed by
    // clickPhysics.probe.test.ts) - but it costs exactly one stationary tick, because
    // `stepMovement` reads isMoving false on the next pass and re-clicks the walk.

    // Standing still, so the tick is free to shoot with.
    //
    // Reach, line of sight and which gear to use all come from `attackOptionFor`, unchanged from
    // every other wave: it asks the engine's own `LineOfSight.playerHasLineOfSightOfMob` through
    // `isAttackable`, and falls back to the long bow when the preferred set cannot reach.
    //
    // ASKED, NEVER ASSUMED, because reach is loadout-dependent and the margin is thin. Zuk is a
    // 7x7 at 22,8, so its southern edge is y 8 and the distance from cover is just `playerY - 8`.
    // A twisted bow reaches 10 and covers the whole band; a rune crossbow reaches 7, so it needs
    // y 15 or lower - while the shield covers y 16. Those are NOT the same constraint, and
    // nothing here yet steers the bot off the one row where it is covered but cannot shoot.
    // HEALING GOES AHEAD OF ATTACKING, and behind movement. Test scaffolding only - the client
    // this ports into owns vitals. See the note on ZUK_HEAL_AMOUNT.
    //
    // Ahead of attacking because a lost shot is damage output and being dead is the run; behind
    // movement for the reason every other action on this wave is - the tick a reposition is
    // clicked on is already gone, and standing still to sip while the shield slides off is how
    // the 251 lands. See the movement gate above.
    //
    // AND ONLY WHILE HEALERS ARE ALIVE. The whole of this exists to cover `JalMejJak`'s AOE, which
    // is the one source of damage on this wave that no positioning avoids: `AoeWeapon.attack`
    // aims its first spark at the tile the player is standing on, so it lands whatever the bot
    // does. Everything else that hits us - the mager, the ranger, Zuk - is a positioning or
    // tagging failure, and topping those up would hide the failure instead of showing it.
    //
    // So no sips before the healers exist, and none once the last one is dead. Nothing is reset
    // when they die; the budget simply stops being spendable, which is what makes the hitpoints a
    // run ends on mean something again.
    const maxHitpoints = player.stats?.hitpoint ?? 0;
    const hitpoints = player.currentStats?.hitpoint ?? 0;
    const healersUp = visibleMobs(region).some(
      (mob) =>
        mob.dying === -1 &&
        (mob.mobName() === EntityNames.JAL_MEJ_JAK || mob.mobName() === EntityNames.YT_HUR_KOT),
    );
    if (
      healersUp &&
      maxHitpoints > 0 &&
      hitpoints * 2 < maxHitpoints &&
      InfernoAutomation.zukHealsUsed < InfernoAutomation.ZUK_HEAL_COUNT
    ) {
      InfernoAutomation.zukHealsUsed++;
      player.currentStats.hitpoint = Math.min(
        maxHitpoints,
        hitpoints + InfernoAutomation.ZUK_HEAL_AMOUNT,
      );
      say(
        `wave 69: healed ${InfernoAutomation.ZUK_HEAL_AMOUNT} ` +
          `(${InfernoAutomation.ZUK_HEAL_COUNT - InfernoAutomation.zukHealsUsed} left, ` +
          `hp ${player.currentStats.hitpoint}/${maxHitpoints})`,
      );
      return;
    }

    const zuk = visibleMobs(region).find(
      (mob) => mob.dying === -1 && mob.mobName() === EntityNames.TZ_KAL_ZUK,
    );
    // ZUK'S REACH IS ZUK'S PROBLEM, not a gate on the whole tick.
    //
    // This used to `return` whenever `option` was null - a question about whether ZUK can be shot
    // from here - and answering "no" cancelled the mager and ranger with it. On the crossbow's 7
    // that fires the moment the bot stands at y 16 (Zuk's south edge is y 8, so distance 8), so a
    // set mob three tiles away went unattacked because an unrelated mob was one tile too far.
    // Zuk is now one candidate among the rest, and its reach is checked where it is used.
    const option = zuk ? attackOptionFor(region, player, zuk) : null;

    // The blowpipe goes on a fixed number of ticks after a specific watched attack - but ONLY if
    // we are EAST when it comes due. The pair spawns split, mager west and ranger east, so which
    // of them we are standing next to is decided by where the shield has carried us by then. The
    // blowpipe is the ranger's tool; on the mager's side it is the wrong weapon aimed at the
    // wrong half of the set, so the bow stays on instead.
    // THE SIDE DECIDES THE WEAPON, NOT THE TARGET. Once the set is due, the mager and the ranger
    // are what we shoot either way - standing on the mager's half is a reason to keep the bow, not
    // a reason to go back to plinking Zuk. Only `allowBlowpipe` is gated on being east.
    // The window is now the last few ticks before the pair actually lands, read off our own copy
    // of the engine's set timer. Naturally bounded: it opens ZUK_SWAP_BEFORE_SET ticks out and
    // shuts the moment the set arrives and the clock resets to 350.
    const untilSet = ZukSetTimer.ticksUntilSet();

    // A PAUSED TIMER IS NOT A COUNTDOWN, AND NOTHING MAY WAIT ON ONE.
    //
    // `TzKalZuk.damageTaken` freezes the set timer the first time Zuk drops under 600 and only
    // restarts it under 480, so between those two numbers the reading is a stopped clock: whatever
    // it says, no pair is coming and the only thing that can ever make one come is damage on Zuk.
    //
    // Every wait below is a wait for a SPAWN, so each of them read a stopped clock as "about to
    // happen" and held for it. Observed, seed 13: the pause caught the timer at 2, inside
    // ZUK_SWAP_BEFORE_SET, so the pre-spawn hold armed and never disarmed - the bot held fire for
    // a set that could not arrive until it stopped holding fire. Zuk sat on 587 hitpoints for
    // 3200 ticks and the run hit the budget without dying. A deadlock, not a slow kill: the wait
    // was for an event that the waiting itself prevented.
    const setCountingDown = untilSet !== null && !ZukSetTimer.isPaused();
    const inBlowpipeWindow =
      setCountingDown && (untilSet as number) <= InfernoAutomation.ZUK_SWAP_BEFORE_SET;

    // WHICH SIDE: read live until the pair is actually on the board, then latched.
    //
    // Latching it on the tick the TIMER fired is what made "hit 5 + 2" never equip while
    // "hit 2 + 2" worked. The trigger can be twenty ticks before the set exists, the shield has
    // carried the bot somewhere else by then, and the answer was frozen regardless - hit 2 landed
    // east by luck, hit 5 landed west and disabled the blowpipe for the entire fight. Reading it
    // live until there is a real pair to be on a side OF, and freezing only then, asks the
    // question that was actually meant and stops the trigger tick deciding the run.
    const setOnBoard = visibleMobs(region).some(
      (mob) =>
        mob.dying === -1 &&
        (mob.mobName() === EntityNames.JAL_ZEK || mob.mobName() === EntityNames.JAL_XIL),
    );
    // WHAT IS UNFINISHED ON THE BOARD, WITHOUT ASKING WHETHER WE CAN REACH IT.
    //
    // Separate from the candidate loop below on purpose: that one drops anything out of reach,
    // because it is choosing something to shoot THIS tick. These two questions are the opposite -
    // they ask what is outstanding, and something we cannot currently reach is still outstanding.
    // Folding them into the candidate loop would make both silently false the moment the bot was
    // too far away, which is exactly the situation they exist to catch.
    const zukHp = zuk?.currentStats?.hitpoint ?? 0;
    let healerAlive = false;
    let rangerAlive = false;
    let magerAlive = false;
    let setUntagged = false;
    for (const mob of visibleMobs(region)) {
      if (mob.dying !== -1) {
        continue;
      }
      const name = mob.mobName();
      if (name === EntityNames.JAL_MEJ_JAK || name === EntityNames.YT_HUR_KOT) {
        healerAlive = true;
        // A JalMejJak on the board IS the enrage, and this is the only honest record of it. See
        // `zukEnraged` for why hitpoints cannot be asked instead.
        if (name === EntityNames.JAL_MEJ_JAK) {
          InfernoAutomation.zukEnraged = true;
        }
        continue;
      }
      if (name !== EntityNames.JAL_ZEK && name !== EntityNames.JAL_XIL) {
        continue;
      }
      if (name === EntityNames.JAL_XIL) {
        rangerAlive = true;
      } else {
        magerAlive = true;
      }
      if (mob.aggro !== player) {
        setUntagged = true;
      }
    }

    // ZUK IS THE LAST THING TO SHOOT, NOT THE DEFAULT ONE.
    //
    // Falling through to Zuk whenever nothing else is in reach reads as free damage and is not:
    // both of these states are ones where a shot spent on Zuk is a shot the weapon owes back at
    // the moment it matters. Standing idle costs nothing but time, and time is the resource this
    // fight has most of.
    //
    //  - A HEALER ALIVE, reachable or not. `JalMejJak` spawns at enrage aggroed to Zuk and heals
    //    it, so every point we put into Zuk while one lives is a point being handed back. Racing
    //    a healer is losing arithmetic. The scorer is already walking us at them -
    //    ZUK_HEALER_REACH_BONUS - so the shot wanted here is the tag, a few ticks from now, on a
    //    weapon that is off cooldown when it arrives.
    //  - AN UNTAGGED SET WITH THE RANGER STILL UP. Untagged means it is shooting the shield, and
    //    the shield does not come back. The tag is worth more than any amount of boss damage, and
    //    the same reasoning as the pre-spawn hold applies: a bow committed to Zuk is five ticks
    //    from being able to take it. Gated on the ranger living because that is the half we
    //    actually kill - once it is dead the mager is left tagged-and-alive by design, and holding
    //    for it would be holding forever.
    //
    // Both are checked only where Zuk is the fallback; a reachable set mob is shot regardless.
    // Belt and braces on the latch: enrage fires on Zuk's own `damageTaken`, and `visibleMobs`
    // hides a new mob for a tick, so the healers are not on the board on the tick it happens.
    if (zuk && zukHp < InfernoAutomation.ZUK_ENRAGE_HP) {
      InfernoAutomation.zukEnraged = true;
    }

    // DO NOT CROSS ENRAGE WITH A PAIR ABOUT TO LAND. See ZUK_HOLD_SET_HP.
    //
    // Arms only BEFORE enrage - afterwards there is nothing left to time, the healers are already
    // out, and holding would just be refusing to finish the fight. Disarms by itself the moment
    // the pair spawns, because `ZukSetTimer` resets to its full interval and the set is no longer
    // "due in under a minute" - at which point the untagged-set rule below takes over and the pair
    // is what gets shot.
    const setImminent =
      setCountingDown && (untilSet as number) <= InfernoAutomation.ZUK_HOLD_SET_TICKS;
    const holdForSet =
      !InfernoAutomation.zukEnraged &&
      zukHp > 0 &&
      zukHp < InfernoAutomation.ZUK_HOLD_SET_HP &&
      setImminent;

    // PAST ZUK_MAGER_KILL_HP THE SET IS CLEARED TO THE LAST ONE, mager included.
    //
    // Leaving a tagged mager alive is a first-half rule and only a first-half rule: it is paid for
    // by racing Zuk to 600 to stop further pairs, and once that race is won it buys nothing. What
    // it costs from then on is a magic attack landing every four ticks through the run to enrage,
    // for the whole time the healers are being answered - so below 600 it is finished off like the
    // ranger, and Zuk waits until the board is clear.
    const holdToClearSet =
      (rangerAlive || magerAlive) &&
      zukHp > 0 &&
      zukHp < InfernoAutomation.ZUK_MAGER_KILL_HP;

    const holdOffZuk =
      healerAlive || holdToClearSet || (setUntagged && rangerAlive) || holdForSet;
    const holdReason = healerAlive
      ? "healer up"
      : holdToClearSet
        ? `clearing the set (zuk ${zukHp})`
        : setUntagged && rangerAlive
          ? "set untagged, ranger alive"
          : `banking ${zukHp}hp for the set (due in ${untilSet ?? "-"})`;

    if (setOnBoard && InfernoAutomation.zukOnRangerSide === null) {
      InfernoAutomation.zukOnRangerSide =
        player.location.x >= InfernoAutomation.ZUK_SET_DIVIDE_X;
    }
    const onRangerSide =
      InfernoAutomation.zukOnRangerSide ??
      player.location.x >= InfernoAutomation.ZUK_SET_DIVIDE_X;


    // PREFERRED WEAPON, LONG-RANGE FALLBACK - the same shape `attackOptionFor` uses everywhere
    // else, but with the blowpipe as the preference. It cannot simply BE `attackOptionFor`,
    // because `requiredSetFor` answers "tbow" for a mager or ranger, so that function would never
    // reach for the blowpipe at all.
    //
    // The reaches are read off the loadout rather than hardcoded, so a crossbow build (7) and a
    // twisted bow build (10) both work, and neither is assumed to out-reach the blowpipe.
    const reachOf = (name: GearSetName) =>
      (weaponForSet(player, name) as { attackRange?: number } | null)?.attackRange ?? 0;
    const blowpipeReach = reachOf("blowpipe");
    const bowReach = reachOf("tbow");

    // Targeting is not on a timer: a mager or ranger on the board is what we shoot, whenever
    // that is. The window only decides which weapon is wanted BEFORE one exists.
    //
    // ASKED OF THE SPAWN TILES, not of which half of the arena we are on. The pair lands on two
    // fixed tiles, so "will the blowpipe reach the nearer of them from here" is answerable exactly,
    // and it is the only thing that decides whether pre-equipping it is worth a tick. Standing at
    // y 14 the answer is almost always no - the spawn row is y 21, so `dy` alone is 7 against the
    // blowpipe's 5 - which is why the bot kept putting on a weapon that could not tag anything.
    const spawnReach = (spawn: { x: number; y: number }) =>
      Math.max(
        Math.abs(spawn.x - player.location.x),
        Math.abs(spawn.y - player.location.y),
      );
    const nearestSpawn = Math.min(
      spawnReach(InfernoAutomation.ZUK_MAGER_SPAWN),
      spawnReach(InfernoAutomation.ZUK_RANGER_SPAWN),
    );
    const preSwap = inBlowpipeWindow && nearestSpawn <= blowpipeReach;

    // TARGET FIRST, THEN GEAR. Which weapon to hold depends on which mob is being shot and how
    // far away it is, so choosing the set before the target - as this did - can only ever be a
    // guess that the later choice then has to live with.
    let target: Mob = zuk as Mob;
    let hasSetMob = false;
    // Filled when the band passed over a gate-blocked candidate, so the state line can say so.
    let heldOverNote = "";
    // Anything from the set still on the shield, reachable or not. Reach is a separate question
    // answered by the candidate scan below; this one exists because a mob OUTSIDE reach is still
    // a decision - it is what the sortie hold and the worn-weapon rule are both about.
    const untaggedSetMobOnBoard = visibleMobs(region).some(
      (mob) =>
        mob.dying === -1 &&
        mob.aggro !== player &&
        (mob.mobName() === EntityNames.JAL_ZEK ||
          mob.mobName() === EntityNames.JAL_XIL ||
          mob.mobName() === EntityNames.JAL_TOK_JAD),
    );

    {
      // Candidates are anything either weapon can hit, so a mob outside the blowpipe's reach is
      // still a target - just one the bow takes instead of dropping it.
      const furthest = Math.max(blowpipeReach, bowReach);
      // ANYTHING NOT ALREADY SHOOTING US COMES FIRST, because what it IS shooting is the shield.
      //
      // A set spawns with `aggro: this.shield` (TzKalZuk.attackIfPossible) and turns on us only
      // when we hit it - `JalZek` and `JalXil` override `shouldChangeAggro` to
      // `this.aggro != projectile.from`, so the flip is permanent and one hit is the whole cost.
      // Until then every attack it makes lands on 600 hitpoints of cover that never comes back.
      // So `mob.aggro !== player` is not a tie-break among equals: it separates a mob that is
      // costing us the shield from one that is costing us nothing extra.
      //
      // The flip happens when the PROJECTILE LANDS, not when the click goes out, so a mob already
      // shot at still reads as untagged for a few ticks and can be picked twice. Wasteful rather
      // than wrong - fixing it needs remembered state, which is the job the old
      // `zukPairForceTarget` did. Deliberately not rebuilt yet.
      // FURTHEST FIRST AMONG THE UNTAGGED, not nearest.
      //
      // Everything in this band is already in reach, so nearness buys nothing - both are one hit
      // and both flip permanently. What separates them is which shot is about to STOP being
      // available: the near one stays comfortably inside range while the far one sits at the edge
      // of it, and the shield carries us a tile a tick, so the far one is the shot that expires.
      // Taking the near one first spends the tick on the shot that would still have been there.
      //
      // This is the correct form of an earlier attempt that ordered by who fires soonest. That one
      // was wrong for the same reason inverted - it deferred a mob already in reach in favour of
      // one about to fire, the deferred mob drifted out of range, and its tag went from +5 to +38.
      // Imminence of the SHOT is what matters, not imminence of their attack.
      // Which way the shield will be carrying us by the time a tag could land - a tag is about
      // four ticks from click to landing, and `projectShield` replays any bounce inside that
      // window, so near a wall this answers with the direction that will actually hold rather
      // than the one about to flip. Null when the shield is gone and there is no drift to read.
      const shieldNow = findShield(region);
      const shieldHeadingEast =
        shieldNow === null ? null : projectShield(shieldNow, 4).direction;
      const offUs: { mob: Mob; distance: number; expiring: boolean }[] = [];
      let closestHealer: Mob | null = null;
      let closestHealerDistance = Infinity;
      let closestRanger: Mob | null = null;
      let closestRangerDistance = Infinity;
      let closestMager: Mob | null = null;
      let closestMagerDistance = Infinity;
      for (const mob of visibleMobs(region)) {
        const name = mob.mobName();
        const healer =
          name === EntityNames.JAL_MEJ_JAK || name === EntityNames.YT_HUR_KOT;
        // HEALERS ARE A BLOWPIPE JOB OR NOTHING - no long weapon fallback.
        //
        // One dart is the whole cost: they flip aggro on the first hit and stop healing, so what
        // matters is tags per tick, not damage, and that is the blowpipe's 2-tick speed against
        // the bow's 5. Letting the bow take them at range would spend five ticks doing a job the
        // blowpipe does in two, from a tile the bot could have walked to in the meantime.
        //
        // Out of blowpipe range is therefore not a target at all rather than a slower one. The
        // scorer already pulls towards them - ZUK_HEALER_REACH_BONUS is +1 for any tile inside
        // blowpipe range of one - so refusing here is what makes that pull mean something instead
        // of being quietly satisfied from six tiles away with the wrong weapon.
        const reachNeeded = healer ? blowpipeReach : furthest;
        if (
          mob.dying !== -1 ||
          (name !== EntityNames.JAL_ZEK &&
            name !== EntityNames.JAL_XIL &&
            name !== EntityNames.JAL_TOK_JAD &&
            !healer) ||
          !isAttackable(region, player, mob, reachNeeded)
        ) {
          continue;
        }
        // JAD IS TAGGED ONCE AND THEN LEFT ALONE. It spawns on the shield like the pair, so the
        // one hit that pulls it off is worth taking - but only that one. `TzKalZuk.damageTaken`
        // kills every other mob in the region the instant Zuk reaches zero, so a second hit on
        // Jad is damage that Zuk's own death was going to deliver for free, and Jad's 350
        // hitpoints are 350 not being spent on the thing that ends the wave. It also has three
        // healers waiting on `hitpoint < stats.hitpoint / 2` - one tag is nowhere near that, and
        // committing to the kill wakes them.
        if (name === EntityNames.JAL_TOK_JAD && mob.aggro === player) {
          continue;
        }
        // Nearest by Chebyshev, which is how OSRS measures distance.
        const distance = Math.max(
          Math.abs(mob.location.x - player.location.x),
          Math.abs(mob.location.y - player.location.y),
        );
        if (mob.aggro !== player) {
          // THE EXPIRING SHOT WINS THE UNTAGGED BAND, and expiring is a matter of DIRECTION,
          // not distance. Distance only changes because the shield drags us, so the shot that
          // is going away is the one at a mob on the side the shield is moving AWAY from -
          // whatever the two distances happen to read this tick. A mager momentarily a tile
          // further but dead ahead of the drift is a shot that is IMPROVING; the nearer ranger
          // behind the drift is the one about to stop existing. Furthest-first was only ever a
          // proxy for this - right whenever the far mob was also the abandoned one - and it
          // still decides between two shots expiring together, or everything when the shield
          // is gone and nothing drifts.
          //
          // Measured both ways round: seed 7 set 4, from 25,14 with the shield heading west,
          // the eastern ranger was the abandoned shot, list order tagged the mager first, and
          // the ranger sat on the shield for 35 ticks and 208 damage; seed 84 set 2, from
          // 27,14 heading EAST, the western mager was abandoned, ranger-first was the wrong
          // fix, and the mager went unshootable for 19 ticks. Heading east, mobs at or west of
          // us expire; heading west, mobs at or east of us. Remaining ties go to the ranger -
          // the mob the kill order takes first anyway.
          const expiring =
            shieldHeadingEast !== null &&
            (shieldHeadingEast
              ? mob.location.x <= player.location.x
              : mob.location.x >= player.location.x);
          offUs.push({ mob, distance, expiring });
        } else if (healer) {
          if (distance < closestHealerDistance) {
            closestHealer = mob;
            closestHealerDistance = distance;
          }
        } else if (name === EntityNames.JAL_XIL) {
          if (distance < closestRangerDistance) {
            closestRanger = mob;
            closestRangerDistance = distance;
          }
        } else if (distance < closestMagerDistance) {
          closestMager = mob;
          closestMagerDistance = distance;
        }
      }

      // The band's order: expiring shots, then furthest, then the directional / ranger tie -
      // the same beats-logic the loop used to fold inline, expressed once so the whole band can
      // be ranked rather than only its winner kept.
      const beatsOffUs = (
        a: { mob: Mob; distance: number; expiring: boolean },
        b: { mob: Mob; distance: number; expiring: boolean },
      ): boolean => {
        if (a.expiring !== b.expiring) {
          return a.expiring;
        }
        if (a.distance !== b.distance) {
          return a.distance > b.distance;
        }
        return shieldHeadingEast === null
          ? a.mob.mobName() === EntityNames.JAL_XIL &&
              b.mob.mobName() === EntityNames.JAL_ZEK
          : shieldHeadingEast
            ? a.mob.location.x < b.mob.location.x
            : a.mob.location.x > b.mob.location.x;
      };
      offUs.sort((a, b) => (beatsOffUs(a, b) ? -1 : beatsOffUs(b, a) ? 1 : 0));

      // THE GATE VOTES BEFORE THE BAND SETTLES. Holding the best candidate is only right when
      // there is nothing else to do with the tick - and there usually is: the OTHER half of the
      // pair. Measured on seed 16 t428: the ranger's tag was held (its range would have landed
      // on the old, deliberately-kept-alive mager's magic cadence), the westbound shield
      // dragged the player out of ranger reach one tick later, and the ranger sat on the shield
      // for 19 ticks - while the fresh mager, whose magic stacks on the old mager's magic under
      // one prayer, was tag-safe on that exact tick and got nothing. So the band takes the best
      // candidate whose tag can go NOW, and only holds when every untagged candidate is
      // blocked. The verdict is re-asked downstream on the final target; same tick, same
      // inputs, same answer - this is selection, not a second gate.
      let furthestOffUs: Mob | null = null;
      for (const candidate of offUs) {
        const verdict = TagCollisionGate.evaluate(region, player, candidate.mob);
        if (verdict.safe) {
          furthestOffUs = candidate.mob;
          break;
        }
        // Say WHO was passed over and why. "attacking Jal-Zek" alone reads as picking the
        // wrong mob when the replay viewer can see an untagged ranger standing right there;
        // the truth - it was evaluated first and refused for cause - was invisible.
        heldOverNote += ` [${candidate.mob.mobName()} held: ${verdict.reason}]`;
      }
      if (furthestOffUs === null && offUs.length > 0) {
        furthestOffUs = offUs[0].mob;
        heldOverNote = "";
      }

      // THE ORDER, and every band of it reads off live state rather than a remembered phase, so
      // it self-corrects if automation is toggled off mid-fight:
      //
      //  1. ANYTHING STILL ON THE SHIELD - tag it. One hit, permanent, and it stops eating cover.
      //  2. THE RANGER, once tagged - killed outright, before anything else, while it lives.
      //  3. THE MAGER is deliberately left alive-but-tagged while Zuk is at or above
      //     ZUK_MAGER_KILL_HP. Tagged, it is already doing its worst and dying does not undo any
      //     of it; the hitpoints spent on it buy nothing, whereas the same hitpoints spent on Zuk
      //     buy the set timer pausing and no FURTHER pair arriving at all.
      //  4. Nothing from the set - Zuk. Which is also what steps 2 and 3 fall through to when the
      //     ranger is dead and the mager is being left alone, so "fight Zuk until the next set"
      //     is not a rule anywhere, it is what is left when the others decline.
      // A tagged Jad has already dropped out of the candidate list above, so it can only ever
      // reach `furthestOffUs` - the tag - and never the kill bands below it.
      // HEALERS OUTRANK EVERYTHING ALREADY TAGGED, because they are the only thing on the board
      // that undoes work already done. `JalMejJak` spawns from Zuk's enrage aggroed to Zuk and
      // heals it; `YtHurKot` does the same for Jad. Every tick one lives is damage being handed
      // back, so they are worth interrupting a mager or ranger kill for.
      //
      // An untagged one is caught a band earlier, by `furthestOffUs` - which is right, because
      // `JalMejJak.attackStyleForNewAttack` returns "heal" while its aggro is Zuk and "aoe" once
      // it is ours, so the tag itself is what stops the healing. This band is the follow-up: kill
      // what has already been pulled.
      const pick =
        furthestOffUs ??
        closestHealer ??
        closestRanger ??
        (zukHp < InfernoAutomation.ZUK_MAGER_KILL_HP ? closestMager : null);
      // NO SET MOB MEANS ZUK, NOT NOTHING. `engageSet` is true from the moment the first set is
      // due and never goes false again, so a hard return here stopped the bot attacking anything
      // at all in two entirely normal situations: the ticks before the pair actually spawns, and -
      // permanently - every tick after they are killed. Falling through leaves `target` as the Zuk
      // it was initialised to.
      if (pick) {
        target = pick;
        hasSetMob = true;
      }
      // Which band won, recorded in the same order the pick fell through. Instrumentation only.
      InfernoAutomation.zukDecision.target = (pick ?? zuk)?.mobName() ?? null;
      InfernoAutomation.zukDecision.band = furthestOffUs
        ? "untagged-tag"
        : closestHealer
          ? "healer"
          : closestRanger
            ? "ranger-kill"
            : pick
              ? "mager-kill"
              : "zuk";
    }

    // Nothing from the set, so it falls to Zuk - and only HERE does Zuk's own reach matter. With
    // neither available there is nothing to shoot at all. Aggro is cleared only while standing:
    // `applyAttackPlan` pins destinationLocation to the current tile when it drops a target,
    // which would cancel a walk in progress.
    if (!hasSetMob) {
      // Nothing in reach and something outstanding: stand there. Aggro has to actually be dropped
      // rather than just left unclicked - it is sticky, and the engine re-fires at a standing
      // target on its own every time the cooldown expires - and clicking the tile already stood on
      // is how a player drops it, `moveTo` calling `interruptCombat` and moving nobody.
      //
      // ONLY WHILE STANDING, for the same reason `applyAttackPlan(null)` is gated below it: that
      // click writes destinationLocation, so issuing it mid-walk cancels the walk to the shield.
      // A walk in progress therefore keeps whatever aggro it has and may let one more auto-shot
      // go; the walk is worth more than the shot.
      if (holdOffZuk) {
        if (player.aggro && !repositioning) {
          InfernoAutomation.walkTo(player, player.location.x, player.location.y);
          InfernoAutomation.target = null;
        }
        say(`wave 69: holding off zuk (${holdReason})`);
        return;
      }
      if (!zuk || !option) {
        if (!repositioning) {
          InfernoAutomation.target = applyAttackPlan(
            region,
            player,
            null,
            InfernoAutomation.target,
          );
        }
        say(zuk ? "wave 69: zuk out of reach, no set mob" : "wave 69: on station");
        return;
      }
      target = zuk;
    }

    // HOLD THE WEAPON FOR THE SORTIE, NOT THE KILL. A sortie is only offered when the weapon
    // will be ready on arrival (`untilShot <= arrivalTicks + 1` in the scorer), and every shot
    // spent on a kill target restarts that clock - so the two decisions are coupled, and this
    // is the attack layer's half of it. Measured on seed 6 set 4: the shield parked at the east
    // wall with the mager 12+ from every covered tile, the trip out genuinely fit Zuk's cycle,
    // and the sortie was refused for the weapon every single window - the bot fed each crossbow
    // shot to the tagged ranger at its feet while the mager put ~250 into the shield. The
    // ranger was not going anywhere; the shield was.
    //
    // Only while the pick is a KILL: an untagged mob in reach is already the target and the
    // shot goes to it. Healers stay exempt - their band outranks tagged kills for a reason and
    // their deaths are two darts each. And only while the scorer reports some tile can shoot
    // the stranded mob at all (`canTag`), so an impossible tag never starves the kill forever.
    // Aggro is dropped the same way every other hold drops it - the engine re-fires at a
    // standing target on its own - and never mid-walk, where the click would cancel the walk
    // that may itself be the sortie going out.
    {
      const targetName = target.mobName();
      const targetIsHealer =
        targetName === EntityNames.JAL_MEJ_JAK ||
        targetName === EntityNames.YT_HUR_KOT;
      const pickIsKill = !hasSetMob || target.aggro === player;
      if (
        untaggedSetMobOnBoard &&
        pickIsKill &&
        !targetIsHealer &&
        sortieDebug().canTag > 0
      ) {
        if (player.aggro && !repositioning) {
          InfernoAutomation.walkTo(player, player.location.x, player.location.y);
          InfernoAutomation.target = null;
        }
        const sortieState = sortieDebug();
        say(
          `wave 69: weapon held for sortie tag ` +
            `(trip ${sortieState.bestTrip ?? "-"} vs budget ${sortieState.walkTicks ?? "-"})`,
        );
        return;
      }
    }

    // PREFER THE BLOWPIPE, FALL BACK TO THE LONG WEAPON ONLY WHEN IT CANNOT REACH.
    //
    // And with nothing to shoot yet, still put it on. That is the pre-swap: the set is due, it is
    // about to land, and the blowpipe wants to be in hand when it does rather than costing a tick
    // afterwards. Previously the set was only chosen inside `if (closest)`, so the gear waited on
    // a target that does not exist until the pair spawns - which made the trigger timing do
    // nothing at all, however early it was set.
    // BLOWPIPE ON THE SET, EITHER OF THEM, WHENEVER IT REACHES.
    //
    // Reach is the only thing that decides the weapon once there is something real to shoot.
    // Which side of the arena we are on gates the PRE-SWAP below - getting it on early, before
    // the pair exists - and nothing else: a mager standing three tiles away is a blowpipe target
    // whichever half of the arena it is in, and refusing on the strength of where the shield had
    // carried us is how it ended up plinking the set with the bow.
    //
    // The fallback is the long weapon, whatever the loadout carries - crossbow at 7, twisted bow
    // at 10 - so a mob outside the blowpipe's 5 is still shot, just not with the blowpipe.
    //
    // NO SET MOB MEANS ZUK, ON ZUK'S WEAPON. There was a pre-swap here that put the blowpipe on
    // early, ready for the pair to land - but `dueBlowpipe` never goes false again, so it held the
    // blowpipe for every tick the set was not up, and the blowpipe does not reach Zuk. The bot
    // stood holding the wrong weapon doing nothing instead of putting hitpoints on the boss.
    // Getting it on costs a tick when the set actually arrives, which is the cheaper of the two.
    let set: GearSetName = hasSetMob
      ? isAttackable(region, player, target, blowpipeReach)
        ? "blowpipe"
        : "tbow"
      : preSwap
        ? "blowpipe"
        : option?.set ?? "tbow";

    // THE WEAPON IN HAND OUTRANKS THE BETTER WEAPON WHILE THE SET STILL NEEDS TAGGING.
    //
    // A tag is one hit from ANY weapon - the flip is `shouldChangeAggro`, not damage - so the
    // blowpipe preference above is only ever buying DPS, and DPS is worth nothing against the
    // tick the swap costs while a set mob is still pouring damage into 600 hitpoints of shield
    // that never come back. Measured on seed 7: at t1250 the bot spent three ticks putting the
    // blowpipe on for the mager it had ALREADY tagged, the ranger entered crossbow reach in the
    // middle of that, and the swap had to be undone before the ranger could be shot - two
    // shield hits, 75 damage, for a weapon upgrade on a mob it was not urgent to kill. Set 7 of
    // the same seed died of the same pattern with the shield at zero.
    //
    // So while anything from the set is still untagged, the worn weapon shoots whatever it
    // reaches: the tag itself (an untagged target), or the kill in progress (a tagged target,
    // so the weapon is ready the moment the untagged one comes into reach). When the whole set
    // is tagged there is nothing urgent left and the blowpipe upgrade goes back to normal.
    //
    // Healers are deliberately not part of this: their band is blowpipe-or-nothing for tag
    // CADENCE (three or four of them, two ticks apart on the blowpipe against five on the bow),
    // and that reasoning survives this one.
    if (hasSetMob) {
      const targetName = target.mobName();
      const wornSet: GearSetName | null = isWearing(player, "blowpipe")
        ? "blowpipe"
        : isWearing(player, "tbow")
          ? "tbow"
          : null;
      if (
        wornSet !== null &&
        set !== wornSet &&
        (targetName === EntityNames.JAL_ZEK ||
          targetName === EntityNames.JAL_XIL ||
          targetName === EntityNames.JAL_TOK_JAD) &&
        isAttackable(
          region,
          player,
          target,
          wornSet === "blowpipe" ? blowpipeReach : bowReach,
        )
      ) {
        if (target.aggro !== player || untaggedSetMobOnBoard) {
          set = wornSet;
        }
      }
    }

    // LATE, ON THE TICK BEFORE THE SHOT. See ZUK_SWAP_LEAD.
    //
    // Not a delay for its own sake: it is the difference between changing gear for the shot that
    // is about to happen and changing gear for a shot four ticks away, whose target and distance
    // will both have moved by the time it arrives. A cooldown tick spent swapping is a tick the
    // bot cannot use, and it was spending most of them.
    //
    // `earliestShotOffset` is floored at 1 - `attackStep` has already run - so 1 means "the shot
    // can go next tick" and 2 means "the tick after". Swapping at 2 puts the weapon on with the
    // cooldown still running and the shot goes out at 1, costing nothing. Swapping at 1 is still
    // allowed and does cost the shot, but refusing there would leave the wrong weapon on forever.
    const untilShot = PlayerAttackClock.earliestShotOffset() ?? 1;

    // OFF-TICK GATE, judged before either attack path can fire. A first tag on a set mob or
    // Jad chooses that mob's attack phase for the rest of its life - the flinch at the tag's
    // landing is what sets it - so the click is held until the phase it would produce fits the
    // prayer timeline: never two different overheads demanded on the same tick, and nothing
    // ever sharing a tick with Jad, whose style cannot be known in time. Waiting moves the
    // landing and therefore the phase, so a safe tick is always a few ticks out at most.
    // Everything else - Zuk, healers, a mob already ours or already committed to - passes
    // straight through. See TagCollisionGate for the full mechanics.
    const tagGate = TagCollisionGate.evaluate(region, player, target);
    InfernoAutomation.zukDecision.tagGate = { safe: tagGate.safe, reason: tagGate.reason };

    // A SHOT IN HAND BEATS A BETTER WEAPON. See ZUK_SWAP_LEAD for the timing this sits on top of.
    //
    // At `untilShot` 1 the shot goes out NEXT tick, so a swap here does not delay it by a tick -
    // it cancels it, and the cooldown starts again from the swap. Measured on seed 38: six of the
    // thirteen missed tag opportunities were exactly this, the bot dropping a ready crossbow to
    // put on a blowpipe for a mob it had not tagged yet.
    //
    // The upgrade is only ever DPS - the blowpipe is faster, not more able - and DPS on an
    // untagged mob is worth nothing next to the tag itself, which is permanent, costs one hit, and
    // is the entire reason the shield is still alive. So on the last tick the preference is
    // dropped and whatever is in hand takes the shot, provided it can reach.
    //
    // Only on that last tick. At 2 and above there is no shot to lose and the better weapon is
    // simply put on, which is what ZUK_SWAP_LEAD is for.
    if (
      untilShot === 1 &&
      tagGate.safe &&
      !isWearing(player, set) &&
      isAttackable(region, player, target)
    ) {
      say(`wave 69: shooting ${target.mobName()} with what is in hand, not swapping to ${set}`);
      InfernoAutomation.target = applyAttackPlan(
        region,
        player,
        target,
        InfernoAutomation.target,
        (mob) =>
          InfernoAutomation.clickLog.push({
            tile: { x: mob.location.x, y: mob.location.y },
          }),
      );
      if (tagGate.prediction && InfernoAutomation.target === target) {
        TagCollisionGate.noteTag(target, tagGate.prediction);
      }
      return;
    }

    if (!isWearing(player, set) && untilShot <= InfernoAutomation.ZUK_SWAP_LEAD) {
      // The switch costs this tick. Commit to the target before returning so next tick does not
      // re-decide from nothing and reverse a change we just paid for.
      InfernoAutomation.equipAndShow(player, set);
      InfernoAutomation.target = target;
      const side = onRangerSide ? "east/ranger" : "west/mager";
      say(
        `wave 69: switching to ${set} for ${target.mobName()} ` +
          `(set in ${untilSet ?? "-"}, ${side})`,
      );
      return;
    }

    // THE OFF-TICK HOLD. Below the swap branch on purpose: a blocked tick is exactly the tick
    // a pending gear change is free to happen in, so the swap gets first refusal and the hold
    // takes whatever ticks remain. The aggro drop is the same one every other hold here makes,
    // and for the same reason - aggro is sticky and the engine re-fires at a standing target on
    // its own, so leaving it set would take the colliding shot anyway. Kept off during a walk,
    // exactly like the holds above: the tile click would cancel the walk. The weapon sits ready
    // through the hold (nothing is firing), so the tag goes out on the first tick the gate
    // clears with no cooldown to wait through.
    if (!tagGate.safe) {
      InfernoAutomation.zukDecision.band = "held";
      if (player.aggro && !repositioning) {
        InfernoAutomation.walkTo(player, player.location.x, player.location.y);
        InfernoAutomation.target = null;
      }
      say(`wave 69: holding tag on ${target.mobName()} (${tagGate.reason})`);
      return;
    }

    // MAGER SIDE SPENDS THE SAME TICK, ON ITS OWN TILE.
    //
    // East, the set coming due costs a tick to put the blowpipe on. West there is nothing to
    // swap - the bow is already in hand - so that tick would otherwise be free, and the two sides
    // would arrive at the set a tick out of step with each other. Clicking the tile already stood
    // on spends it identically: `moveTo` on the current location moves nobody, so position is
    // untouched, and the tick lands on the same boundary the swap would have.
    //
    // It is not free, and that is the point rather than a cost to work around - `moveTo` calls
    // `interruptCombat`, so aggro drops exactly as it does when the swap side re-clicks its
    // target afterwards. Both sides re-acquire on the following tick.
    //
    // Once only, latched: this marks the moment the set arrives, not a thing to do every tick.
    // HOLD FIRE ACROSS THE WHOLE WINDOW, not for one tick of it.
    //
    // The point is to arrive at the spawn with the weapon OFF COOLDOWN, so the pair can be tagged
    // the tick it appears. A single click that cancels the attack achieves nothing if the next
    // tick starts another one - the bow goes straight back onto its five-tick cooldown and the
    // mager gets a free hit while it runs down. So this holds for every tick of the window, not
    // just the first.
    //
    // Only the mager side needs it stated. East, the blowpipe goes on and CANNOT reach Zuk, so
    // holding fire is a side effect of the swap - `setHasLOS` fails on range and nothing fires.
    // West keeps the bow, which reaches Zuk perfectly well, so the hold has to be explicit.
    //
    // NOT SIMPLY DECLINING TO CLICK. Aggro is sticky and the engine re-fires at a standing target
    // on its own every time the cooldown expires, so "do not call applyAttackPlan" is not the same
    // as "do not attack". The aggro has to actually be dropped, and clicking the tile already
    // stood on is how a player drops it - `moveTo` calls `interruptCombat` and moves nobody.
    // Issued once, because once aggro is null nothing below re-sets it while this branch holds.
    if (inBlowpipeWindow && !hasSetMob) {
      if (player.aggro) {
        InfernoAutomation.walkTo(player, player.location.x, player.location.y);
        InfernoAutomation.target = null;
      }
      say(
        `wave 69: holding fire for the spawn (set in ${untilSet ?? "-"}, ` +
          `${onRangerSide ? "east" : "west"})`,
      );
      return;
    }

    // Holding a weapon that cannot reach the target - the blowpipe waiting on a spawn, with only
    // Zuk on the board six tiles away. Nothing to do but hold. NOT routed through
    // `applyAttackPlan`, which pins destinationLocation to the current tile when it drops a
    // target and would cancel a walk in progress.
    if (!isWearing(player, set)) {
      say(`wave 69: want ${set} for ${target.mobName()}, swapping in ${untilShot - 1}`);
      return;
    }

    if (!isAttackable(region, player, target)) {
      say(`wave 69: ${set} on, ${target.mobName()} out of its reach (set in ${untilSet ?? "-"})`);
      return;
    }

    // DO NOT CLICK THE NPC WHILE THE WEAPON IS STILL COUNTING DOWN.
    //
    // Aggro is sticky - `applyAttackPlan` only clicks when it is not already on the target, and
    // the engine fires by itself the moment the cooldown expires - so a click on a cooldown tick
    // buys nothing the engine was not going to do anyway. Click on the tick the shot can land,
    // and no other.
    //
    // "CAN LAND NEXT TICK", not "the cooldown has already reached zero". `Player.attackStep`
    // decrements attackDelay and THEN tests it, so a delay still reading 1 here fires next tick
    // all the same - waiting for 0 would throw that shot away every cycle.
    if (PlayerAttackClock.earliestShotOffset() !== 1) {
      say("wave 69: weapon on cooldown");
      return;
    }

    InfernoAutomation.target = applyAttackPlan(
      region,
      player,
      target,
      InfernoAutomation.target,
      (mob) =>
        InfernoAutomation.clickLog.push({
          tile: { x: mob.location.x, y: mob.location.y },
        }),
    );
    // A first tag the gate just approved: remember the cadence it was approved with, so the
    // ticks between this click and the projectile landing judge any second tag against what
    // this mob is ABOUT to do rather than the shield cadence it is still showing.
    if (tagGate.prediction && InfernoAutomation.target === target) {
      TagCollisionGate.noteTag(target, tagGate.prediction);
    }
    const why =
      target.aggro !== player
        ? " (pulling off shield)"
        : target.mobName() === EntityNames.JAL_ZEK
          ? " (zuk under 600)"
          : "";
    say(
      `wave 69: ${repositioning ? "shooting mid-walk at" : "attacking"} ${target.mobName()}${why}${heldOverNote}`,
    );
  }

  private static decide(region: Region, player: Player) {
    // Wave 69 forks here, before anything else is even set up. See `decideZukWave`.
    if (((region as unknown as { wave?: number }).wave ?? 0) === 69) {
      InfernoAutomation.decideZukWave(region, player);
      return;
    }

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
      InfernoAutomation.chosenIsSafeSpot = false;
      InfernoAutomation.arrivalSettled = false;
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

        const chosen = InfernoAutomation.chosenTile;
        const standingOnChosen =
          chosen !== null &&
          chosen.x === player.location.x &&
          chosen.y === player.location.y;

        if (
          standingOnChosen &&
          InfernoAutomation.chosenIsSafeSpot &&
          !InfernoAutomation.arrivalSettled
        ) {
          // First tick standing on the safe tile we chose. The mobs have not reacted to us
          // being here yet, so this tick's verdict would be judged against an unsettled board -
          // hold the decision for one tick instead, see `arrivalSettled`. The scored grid stays
          // fresh for the debug view; only the adoption of a new move waits.
          InfernoAutomation.arrivalSettled = true;
          // The walk is over, so the plan the prayer layer follows is standing still.
          InfernoAutomation.chosenPath = [{ x: player.location.x, y: player.location.y }];
        } else {
          const move = bestMove(region, player, InfernoAutomation.scoredTiles);
          const sameTile =
            chosen !== null &&
            move !== null &&
            chosen.x === move.tile.x &&
            chosen.y === move.tile.y;
          InfernoAutomation.chosenTile = move?.tile ?? null;
          InfernoAutomation.chosenPath = move?.route;
          InfernoAutomation.chosenIsSafeSpot = (move?.parts?.safeSpot ?? 0) > 0;
          if (!sameTile) {
            // A new destination earns a fresh settle on arrival. Re-confirming the tile the
            // bot is already standing on must NOT re-arm it - see `arrivalSettled`.
            InfernoAutomation.arrivalSettled = false;
          }
        }
      } catch (e) {
        InfernoAutomation.scoredTiles = [];
        InfernoAutomation.chosenTile = null;
        InfernoAutomation.chosenPath = undefined;
        InfernoAutomation.chosenIsSafeSpot = false;
        InfernoAutomation.arrivalSettled = false;
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
    InfernoAutomation.prayThisTick(region, player, InfernoAutomation.chosenPath);

    // Run back on, before anything can issue a walk this tick.
    InfernoAutomation.restoreRun(player);

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
      const nibbler = InfernoAutomation.nibblerTarget(region, player);
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

      // Bloblet landing stack - strictly after nibblers, whose pillar damage is permanent.
      // One ice barrage into the fresh trio: the three land on a diagonal whose middle the
      // blast covers entirely, at 15 hitpoints each, and whatever survives is frozen IN the
      // stack for the blood autocast below. The hold is capped at STACK_HOLD_TICKS, unlike
      // the nibbler hold above: this one runs mid-wave under fire, and if the cast has not
      // happened by then the stack has broken - stop waiting, and the next walk clears the
      // selection on its own.
      const stack = InfernoAutomation.bestBarrageBloblet(region, player);
      if (stack && stack.covered >= 2) {
        InfernoAutomation.stackHoldTicks++;
        if (InfernoAutomation.stackHoldTicks <= InfernoAutomation.STACK_HOLD_TICKS) {
          if (player.aggro !== stack.mob) {
            player.setAggro(stack.mob);
            InfernoAutomation.clickLog.push({
              tile: { x: stack.mob.location.x, y: stack.mob.location.y },
            });
          }
          InfernoAutomation.target = stack.mob;
          InfernoAutomation.attackState = `stack barrage x${stack.covered}`;
          InfernoAutomation.reportThreats(region, player);
          return;
        }
      }
    } else {
      InfernoAutomation.stackHoldTicks = 0;
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

    // The force-attack backstop - the last resort for a standoff neither the scorer nor the
    // reach fallback resolves, and INSTRUMENTED so it can never quietly hide one: every
    // engagement is counted, named in the tick log, and surfaced per wave by the harness.
    //
    // The idle clock counts consecutive live-wave ticks without a shot fired. At
    // FORCE_ATTACK_IDLE_TICKS the bot does what a stuck player eventually does: clicks the
    // highest-priority mob on the board REGARDLESS of reach and lets the engine chase.
    // `Player.determineDestination()` paths towards aggro whenever line of sight is missing -
    // the exact behaviour `applyAttackPlan` exists to suppress becomes the tool, on purpose,
    // because closing distance until the shot exists is the one move that always ends a
    // mutual stalemate. While forcing, the tile scorer's movement is skipped (a moveTo would
    // cancel the chase); prayer has already run, and scoring still fills the debug grid.
    const mobsAlive = visibleMobs(region).some((mob) => mob.dying === -1);
    if (!mobsAlive) {
      InfernoAutomation.idleTicks = 0;
      InfernoAutomation.forceTarget = null;
      InfernoAutomation.forceTicks = 0;
    } else if ((player.attackDelay ?? 0) > 0) {
      // A shot within the weapon's cooldown window - the fight is live, nothing is stuck.
      InfernoAutomation.idleTicks = 0;
      InfernoAutomation.forceTarget = null;
      InfernoAutomation.forceTicks = 0;
    } else {
      InfernoAutomation.idleTicks++;
    }

    if (InfernoAutomation.forceTarget) {
      const target = InfernoAutomation.forceTarget;
      InfernoAutomation.forceTicks++;
      if (
        target.dying > -1 ||
        !visibleMobs(region).includes(target) ||
        InfernoAutomation.forceTicks > InfernoAutomation.FORCE_ATTACK_CHASE_TICKS
      ) {
        // Dead, gone, or the chase itself has gone on implausibly long - stand down and let
        // the ordinary layers try again; the idle clock will re-trigger if nothing changes.
        InfernoAutomation.forceTarget = null;
        InfernoAutomation.forceTicks = 0;
        InfernoAutomation.idleTicks = 0;
      } else {
        const set = requiredSetFor(target);
        if (!isWearing(player, set)) {
          InfernoAutomation.equipAndShow(player, set);
        }
        if (player.aggro !== target) {
          player.setAggro(target);
          InfernoAutomation.clickLog.push({
            tile: { x: target.location.x, y: target.location.y },
          });
        }
        InfernoAutomation.target = target;
        InfernoAutomation.attackState = `FORCED: chasing ${target.mobName()}`;
        InfernoAutomation.reportThreats(region, player);
        return;
      }
    } else if (
      mobsAlive &&
      InfernoAutomation.idleTicks >= InfernoAutomation.FORCE_ATTACK_IDLE_TICKS
    ) {
      let pick: Mob | null = null;
      for (const mob of visibleMobs(region)) {
        if (mob.dying > -1) {
          continue;
        }
        if (!pick || killPriority(mob) > killPriority(pick)) {
          pick = mob;
        }
      }
      if (pick) {
        InfernoAutomation.forceTarget = pick;
        InfernoAutomation.forceTicks = 0;
        InfernoAutomation.forcedAttacks++;
      }
    }

    // GHOST-STACK PREP. Between a blob starting to die and its bloblets landing there are
    // four ticks - exactly a gear switch plus a spell select. If the pending bloblets
    // (priority 7) outrank everything alive and reachable, the window is spent getting the
    // ice barrage ready instead of committing to a lesser target: previously the bot spent
    // it attacking the OTHER blob, arriving at the landing tick in the wrong gear and
    // pushing a second trio towards spawning on top of the first (measured, wave 7).
    //
    // Prayer has already run - it sits above everything and never waits on this. The hold is
    // bounded by the window itself: a dying blob exists for at most four ticks, so this can
    // never become a standoff. Movement pauses only once there is a selection to protect
    // (moveTo nulls manualSpellCastSelection), and aggro is cleared so the Kodai does not
    // autocast at whatever the previous target was while we wait.
    if (hasDyingBlob(region)) {
      const bestLive = chooseByPriority(region, player, InfernoAutomation.target);
      const blobletPriority = killPriority({
        mobName: () => EntityNames.JAL_AK_REK_XIL,
      } as unknown as Mob);
      if (!bestLive || killPriority(bestLive) < blobletPriority) {
        if (player.aggro) {
          player.setAggro(null);
          player.destinationLocation = player.location;
        }
        InfernoAutomation.target = null;
        if (!isWearing(player, "mage")) {
          InfernoAutomation.attackState = "stack prep: mage";
          InfernoAutomation.equipAndShow(player, "mage");
          InfernoAutomation.reportThreats(region, player);
          return;
        }
        if (!hasIceBarrageSelected(player)) {
          if (!InfernoAutomation.isMoving(player)) {
            InfernoAutomation.preloadIceBarrage(player);
          }
          InfernoAutomation.attackState = "stack prep: barrage";
          InfernoAutomation.reportThreats(region, player);
          return;
        }
        InfernoAutomation.attackState = "stack prep: ready";
        InfernoAutomation.reportThreats(region, player);
        return;
      }
    }

    // ---- GO AND TAG THE FAR HEALER. Above the trap, because the trap does not start until every
    // healer is on us, and above movement because it is a committed walk. See
    // `HealerTrap.planHealerApproach`.
    InfernoAutomation.stepHealerApproach(region, player);

    // ---- THE HEALER TRAP. Above movement and attacking both, because it is a committed
    // sequence rather than a per-tick preference. See HealerTrap.
    if (!InfernoAutomation.approachHealer) {
      InfernoAutomation.stepTrap(region, player);
    }

    // Movement and attacking are NOT independent, and the engine enforces it both ways:
    //   Player.moveTo()  -> interruptCombat() -> setAggro(null)   walking drops the target
    //   setAggro(inRangeMob)                                      attacking stops the walk
    // They are both left-clicks on the world and in OSRS the later one wins, so only one can
    // happen per tick. Movement takes precedence: repositioning decides which mobs can hit us
    // and on which ticks, and a delayed attack only costs a little damage output.
    //
    // THE JAD-WAVE WEAVE IS THE EXCEPTION, and it inverts that precedence for one specific tick:
    // the one where the weapon is off cooldown and something is already in reach. See
    // `weaveHoldsWalk` for why the general rule is wrong there and stays right everywhere else.
    const repositioning = InfernoAutomation.weaveHoldsWalk(region, player)
      ? false
      : InfernoAutomation.stepMovement(player, region);
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
      // Jad waves use the tag-and-turn instead of the priority table: blowpipe each healer
      // still healing (aggro not yet on us), then Jad once all are pulled - and never the
      // tagged ones. No fallback to the table while a Jad lives, or tagged healers would
      // come straight back as its top-ranked targets.
      const jadWave = visibleMobs(region).some(
        (mob) => mob.dying === -1 && mob.mobName() === EntityNames.JAL_TOK_JAD,
      );
      // Nibblers are taken AHEAD of the priority table, and not because they outrank it -
      // JAL_NIB is already 10, the top of it. It is `chooseByPriority`'s stickiness that has
      // to be defeated: equal priority is never a reason to switch, so a FROZEN nibbler
      // already held as the target keeps focus while a loose one walks into a pillar. Asking
      // `nibblerTarget` first means the freeze-aware pick wins, and it is the same pick the
      // ice cast makes - one answer, two consumers.
      //
      // Not on Jad waves: the tag-and-turn owns targeting entirely there, and nibblers do
      // not spawn on them anyway.
      const nibbler = jadWave ? null : InfernoAutomation.nibblerTarget(region, player);
      const intended: Mob | null =
        nibbler ??
        (jadWave
          ? chooseJadWaveTarget(region, player)
          : chooseByPriority(region, player, InfernoAutomation.target));

      if (!intended) {
        InfernoAutomation.attackState = "no target";
      } else {
        // Surviving bloblet stacks are blood-barraged: the mage set's Kodai autocasts Blood
        // Barrage, so a stacked target is purely a GEAR choice - no manual cast, no hold,
        // nothing blocked - and the 3x3 both damages and heals off every stacked bloblet.
        // Singles fall through to the blowpipe as always.
        const stacked =
          InfernoAutomation.isBloblet(intended) &&
          InfernoAutomation.blobletsCovered(region, intended) >= 2;
        // HEAL MODE: when only the last two monsters of the wave are left and hitpoints are
        // not full, blood barrage until they are. Same mechanism as the stack - the Kodai
        // autocasts blood, so sustain is purely a gear choice. Kill speed on the tail of a
        // wave is worth less than walking into the next one at full health.
        //
        // NOT on 67/68. Those waves already have dedicated positioning logic (the healer
        // tag-and-turn) that a mage-set switch has no business competing with, and
        // "alive <= 2" trips constantly there for the wrong reason - Jad's own healers count
        // towards it. Kill speed against a boss is worth more than topping up, unlike the tail
        // of a regular wave. Wave 69 never reaches here; it stops after prayer.
        const wave = (region as unknown as { wave?: number }).wave ?? 0;
        const healing =
          wave < 67 &&
          (player.currentStats?.hitpoint ?? 0) < (player.stats?.hitpoint ?? 0) &&
          visibleMobs(region).filter((mob) => mob.dying === -1).length <= 2;
        let set: GearSetName;
        if (stacked || healing) {
          set = "mage";
        } else {
          // Otherwise: the SAME decision canReach made - preferred set, or the long-bow
          // fallback that made this mob a candidate at all. Reading requiredSetFor here
          // instead re-opened the switch-then-drop deadlock the moment the fallback picked a
          // target the preferred set cannot reach.
          set = attackOptionFor(region, player, intended)?.set ?? requiredSetFor(intended);
        }
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
        InfernoAutomation.attackState = `${healing ? "blood-heal " : ""}attacking ${intended.mobName()}`;
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
