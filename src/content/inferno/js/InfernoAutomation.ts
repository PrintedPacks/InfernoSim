"use strict";

import { Player, Region, Location, Mob, Chrome, ControlPanelController, EntityNames, MapController, Random, Settings } from "osrs-sdk";

import { AutomationOverlay, ClickStep } from "./AutomationOverlay";
import { applyPrayerPlan, incomingThreats } from "./PrayerPlanner";
import { applyAttackPlan } from "./AttackPlanner";
import { equipSet, GearSetName, isWearing, requiredSetFor, weaponForSet } from "./GearSets";
import { hasIceBarrageSelected, selectedSpell, selectIceBarrage } from "./SpellCaster";
import { isAttackable } from "./AttackPlanner";
import { bestMove, focusNibbler, ScoredTile, scoreCandidates, waveHomeTile } from "./TileScorer";
import { hasDyingBlob } from "./Trajectory";
import { ArenaSnapshot } from "./ArenaSnapshot";
import { chooseByPriority, chooseJadWaveTarget, chooseZukWaveTarget, killPriority } from "./KillPriority";
import { nibblerThreats, observeNibblers } from "./PillarDefence";
import { attackOptionFor, chooseTarget } from "./TargetPlanner";
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
   * The Zuk-wave mager/ranger tag pairing: the OTHER one, once exactly one of the pair has
   * been tagged, forced ahead of normal priority until it too is tagged. See the comment at
   * the call site in `decide()` for the flinch-delay mechanic this exists to avoid.
   */
  private static zukPairForceTarget: Mob | null = null;

  /**
   * Every time the backstop has engaged this run - the instrumentation that keeps a forced
   * attack a measurement instead of a mask. The harness prints the per-wave delta, so a wave
   * that only cleared because the bot was shoved reads as exactly that in every sweep.
   */
  private static forcedAttacks = 0;

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
    InfernoAutomation.chosenTile = null;
    InfernoAutomation.chosenPath = undefined;
    InfernoAutomation.chosenIsSafeSpot = false;
    InfernoAutomation.arrivalSettled = false;
    InfernoAutomation.idleTicks = 0;
    InfernoAutomation.forceTarget = null;
    InfernoAutomation.forceTicks = 0;
    InfernoAutomation.zukPairForceTarget = null;
    InfernoAutomation.stackHoldTicks = 0;
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
   * The Zuk fight's target, as a boss-specific SEQUENCE rather than a flat ranking - `Jal-Xil`
   * (8) and `Jal-Zek` (6) already outrank Zuk (2) in `ZUK_WAVE_PRIORITY`, but a flat table
   * cannot express "attack Zuk instead of the mager you could otherwise reach", which is most
   * of what this fight actually asks for. Every rule below reads off CURRENT observable state
   * (Zuk's live hp, which mobs exist, whether each has been tagged) rather than remembered
   * phase - so it self-corrects if automation is toggled off mid-fight instead of resuming
   * from a stale memory of where the fight was.
   *
   * The sequence, and why each step is there:
   *
   *  1. MAGER/RANGER TAG PAIRING. Both spawn aggroed to the shield and switch to us the
   *     instant we hit either one - the engine's own flinch rule then floors their
   *     attackDelay at floor(attackSpeed/2)+1 (verified in the SDK: `Unit.
   *     processIncomingAttacks`), which for their shared 4-tick attackSpeed is exactly 3. So
   *     the TICK we land the tagging hit sets the phase of that mob's whole subsequent cycle
   *     against us - tag both on the same tick (or any tick 4 apart) and their identical
   *     4-tick cycles fire together FOREVER, magic and range on one tick neither overhead can
   *     cover. Tag them a tick apart and that never happens, permanently, since two
   *     same-period cycles that start offset stay offset by exactly that much every cycle
   *     after. The FIRST tag goes to whichever is physically closer (fastest off the shield);
   *     the instant that lands, the fix is not "wait before attacking the second one" -
   *     ordinary stickiness would happily keep hammering whichever got tagged first, since it
   *     is now the top-ranked reachable thing - it is the opposite: force an IMMEDIATE switch
   *     to the other one. Only one attack lands per tick, so switching as fast as possible IS
   *     a one-tick offset; there is no faster way to tag it, so this can never accidentally
   *     land both on the same tick.
   *  2. RANGER, fully committed, the instant tagging is settled: kill it before anything else
   *     while it lives - already the emergent result of 8 > 6, stated explicitly here so nothing
   *     else in this sequence can pull focus off it.
   *  3. MAGER is deliberately left alive-but-tagged until Zuk's hp drops under 600 - the exact
   *     threshold that permanently pauses `TzKalZuk`'s spawn timer in the real fight, so racing
   *     Zuk down first is racing to shut off any FURTHER mager/ranger pairs, which matters far
   *     more than finishing the one already on the board. Once Zuk is under 600, mager becomes
   *     the priority again and gets killed.
   *  4. JAD, once it spawns (Zuk < 480, also aggroed to the shield): tagged once, the same way
   *     mager and ranger were, then never engaged again - guarded by the SAME collision check,
   *     because Jad's 8-tick attackSpeed is exactly double mager/ranger's 4, not merely
   *     unrelated to it. Jad's `flinchDelay` is overridden to 2, the same floor of 3 mager
   *     and ranger get, and every one of Jad's future attack ticks (delay, delay+8, delay+16,
   *     ...) is also a multiple-of-4 step from its first, so it lands on the exact same
   *     residue mod 4 forever - meaning if that residue matches an already-tagged mager or
   *     ranger's, EVERY Jad attack from then on lands on one of THEIR attack ticks too,
   *     permanently, the identical unpickable-overhead problem step 1 exists to prevent, just
   *     one-directional (Jad collides with them each cycle; they still get their other cycles
   *     free). `TzKalZuk.damageTaken()` kills every other mob in the region the instant Zuk's
   *     hp hits zero, so a second hit on Jad is pure wasted DPS - Zuk's own death clears it
   *     for free.
   *  5. Otherwise, the flat table decides - which by this point in the fight is just Zuk
   *     against the enrage-phase healers (priority 10, correctly above Zuk's 2 with nothing
   *     to override it), with mager and Jad explicitly excluded so this fallback can never
   *     re-select what step 3 or step 4 already decided to leave alone.
   *
   * MULTIPLE PAIRS. `TzKalZuk`'s spawn timer resets to 350 and fires again every time it
   * expires, so a slow kill - one that takes longer than that to get Zuk under 600 - spawns a
   * SECOND mager+ranger pair while the first mager is still alive, tagged and deliberately
   * deferred. Tracking "the mager" and "the ranger" as single references was blind to this:
   * the second mager was invisible to steps 1 and 3, never tagged, never excluded from step
   * 5, and the flat fallback picked it up as an ordinary priority-6 target and killed it
   * outright - measured. So every step below operates on the full, filtered LIST of each type
   * currently alive, not a single `.find()`. Tag pairing (step 1) always processes the closest
   * UNTAGGED instance of EITHER type, and the collision check compares it against every
   * ALREADY-tagged instance of either type, not just one partner - a third simultaneous
   * attacker is exactly as much a collision risk as a second one.
   */
  private static decideZukTarget(region: Region, player: Player, zuk: Mob): Mob | null {
    const magers = visibleMobs(region).filter(
      (mob) => mob.dying === -1 && mob.mobName() === EntityNames.JAL_ZEK,
    );
    const rangers = visibleMobs(region).filter(
      (mob) => mob.dying === -1 && mob.mobName() === EntityNames.JAL_XIL,
    );
    const jad =
      visibleMobs(region).find(
        (mob) => mob.dying === -1 && mob.mobName() === EntityNames.JAL_TOK_JAD,
      ) ?? null;

    const isTagged = (mob: Mob) => mob.aggro === player;
    const shieldAttackers = [...magers, ...rangers];
    const dist = (mob: Mob) =>
      Math.max(
        Math.abs(mob.location.x - player.location.x),
        Math.abs(mob.location.y - player.location.y),
      );
    const nearest = (mobs: Mob[]) =>
      mobs.length === 0
        ? null
        : mobs.reduce((best, mob) => (dist(mob) < dist(best) ? mob : best));

    /**
     * Would attacking `candidate` RIGHT NOW sync its attack cycle with an ALREADY-tagged
     * shield attacker's, forever?
     *
     * The engine's flinch rule sets `attackDelay = max(current, flinchDelay+1)` the instant a
     * hit changes a mob's aggro (`Unit.processIncomingAttacks`), and flinchDelay = 2 for
     * mager, ranger AND Jad alike (mager/ranger via `floor(attackSpeed/2)` on their shared
     * attackSpeed 4; Jad via its own override, despite an attackSpeed of 8) - so the floor is
     * 3 for all three. The mod-4 test below is correct for Jad too, not just for mager-vs-
     * ranger: Jad's attackSpeed (8) is an exact multiple of theirs (4), so Jad's future attack
     * ticks (delay, delay+8, delay+16, ...) all land on the SAME residue mod 4 as its first -
     * meaning "same residue as an already-tagged mager/ranger" still means "collides on every
     * future attack", just one-directional (Jad hits every one of their cycles; they still
     * get every OTHER cycle free of Jad). A hit on an ALREADY-tagged mob does not re-trigger
     * the floor, so a collision, once landed, cannot be corrected afterward. Checked against
     * EVERY already-tagged attacker, not just one designated partner: with two pairs
     * overlapping, a fresh tag can collide with either pair's already-established mob, not
     * only its own pair-mate. Jad is included in the checked set alongside mager/ranger, not
     * just checked FROM Jad's own side (step 4) - a fresh mager/ranger tag (step 1) has to
     * avoid an already-tagged Jad exactly as much as an already-tagged mager/ranger has to be
     * avoided when tagging Jad. Without this half, a late second pair spawning after Jad was
     * already tagged (Zuk dipping back under 480 un-pauses the spawn timer) could still land
     * on Jad's residue with nothing to stop it.
     */
    const collisionTracked = jad ? [...shieldAttackers, jad] : shieldAttackers;

    /**
     * Ticks from THIS decision until our hit actually lands on `candidate` - read from the
     * real weapon (`attackOptionFor` gives the set, `weaponForSet` the real `Weapon`,
     * `Weapon.calculateHitDelay(distance)` the engine's own formula: blowpipe
     * `floor(distance/6)+1`, bow `floor((3+distance)/6)+1`) plus two fixed ticks, both
     * measured against the engine rather than assumed: `Projectile` itself adds 1 whenever
     * `from.isPlayer` (always us), and a further 1 for the input-queue gap between `decide()`
     * choosing a target and the click actually landing (the same latency the gear-switch
     * queue has, `InputController.queueAction` - see `waveRun.test.ts`'s header comment).
     * Verified directly: a decision-to-observed-tag gap of 5 ticks, where the weapon formula
     * alone predicted 4 - the missing tick was exactly this one.
     */
    const ticksUntilLanding = (candidate: Mob): number => {
      const option = attackOptionFor(region, player, candidate);
      const weapon = option
        ? (weaponForSet(player, option.set) as { calculateHitDelay?(distance: number): number } | null)
        : null;
      const hitDelay = weapon?.calculateHitDelay?.(dist(candidate)) ?? 1;
      return hitDelay + 1 + 1; // isPlayer bump + input-queue tick, both explained above
    };

    /**
     * Real absolute tick numbers, both sides read at the SAME instant (this call), not
     * relative-delay snapshots compared across two different moments - three rounds of that (a
     * wrong floor constant, a missed same-tick decrement, a stale established-side read) each
     * fixed one bug and left another, because every relative reading silently assumed "read
     * now" means "the same now" as whatever it was compared against, and across a multi-tick
     * decision-to-landing gap it never was. A fourth round tried tracking each mob's observed
     * fire tick across calls and hit a subtler version of the same mistake: `decide()` does not
     * run every world tick (confirmed: `InfernoAutomation.tickCount` itself never skips, but
     * `decideZukTarget` is not reached on every tick it's called from), so "the first tick I
     * happened to observe this mob tagged" is not reliably the actual tagging tick, and seeding
     * a fixed `+2` from an ARBITRARY observation tick produced the same bug in a new shape.
     *
     * The fix needs no history at all. `other.attackDelay`, read RIGHT NOW on an already-tagged
     * mob, already IS "real ticks until its next fire" - that is what the field means, honestly,
     * for a mob past its flinch (nothing re-floors it after the first tag). So
     * `InfernoAutomation.tickCount + other.attackDelay` is that mob's real next fire tick,
     * computed fresh, no tracking, no seeding, no staleness possible because both sides of
     * every comparison below are read in this same call, at this same tick.
     */
    const collidesIfTaggedNow = (candidate: Mob): boolean => {
      const candidateFireTick = InfernoAutomation.tickCount + ticksUntilLanding(candidate) + 2;
      for (const other of collisionTracked) {
        if (other === candidate || !isTagged(other)) {
          continue;
        }
        const otherDelay = (other as unknown as { attackDelay?: number }).attackDelay ?? 0;
        const otherFireTick = InfernoAutomation.tickCount + otherDelay;
        if ((((candidateFireTick - otherFireTick) % 4) + 4) % 4 === 0) {
          return true;
        }
      }
      return false;
    };

    // --- 1. Tag pairing: the closest UNTAGGED shield attacker, across every mager/ranger
    // currently alive, not just one fixed pair. ---
    if (
      InfernoAutomation.zukPairForceTarget &&
      (InfernoAutomation.zukPairForceTarget.dying > -1 ||
        isTagged(InfernoAutomation.zukPairForceTarget))
    ) {
      InfernoAutomation.zukPairForceTarget = null;
    }
    if (!InfernoAutomation.zukPairForceTarget) {
      InfernoAutomation.zukPairForceTarget = nearest(shieldAttackers.filter((mob) => !isTagged(mob)));
    }
    const forced = InfernoAutomation.zukPairForceTarget;
    if (forced) {
      if (!collidesIfTaggedNow(forced) && attackOptionFor(region, player, forced) !== null) {
        return forced;
      }
      // Either the collision guard held this tick, or it is not reachable yet - either way,
      // fall through rather than idle: a safe attack on whatever else applies is better than
      // nothing, and re-arming next tick re-evaluates with fresh delay values.
    }

    // --- 2. Rangers, fully committed once tagged - nearest tagged one. ---
    const taggedRanger = nearest(rangers.filter(isTagged));
    if (taggedRanger) {
      return taggedRanger;
    }

    // --- 3. Magers, deferred until Zuk < 600 - nearest tagged one, once safe to commit. ---
    const zukHp = zuk.currentStats?.hitpoint ?? 0;
    if (zukHp < 600) {
      const taggedMager = nearest(magers.filter(isTagged));
      if (taggedMager) {
        return taggedMager;
      }
    }

    // --- 4. Jad, tag once - guarded by the same collision check as mager/ranger tagging,
    // since Jad's 8-tick cycle is a multiple of their 4-tick one (see collidesIfTaggedNow).
    // No pairing partner of its own, so no "arm and wait" state needed: if this tick would
    // collide, skip to the fallback and retry next tick once the established delays have
    // moved on, exactly like step 1 falling through. ---
    if (jad && jad.aggro !== player && !collidesIfTaggedNow(jad)) {
      return jad;
    }

    // --- 5. Fallback: flat priority. Every mager is excluded while Zuk is still >= 600
    // (steps 3 owns them once it drops), every UNTAGGED shield attacker is excluded
    // unconditionally (step 1 owns tagging - this fallback has no collision guard of its
    // own, so it must never be handed one that is not yet safely tagged), and a tagged Jad
    // is excluded (step 4 already spent its one hit). ---
    const exclude: Mob[] = [];
    if (zukHp >= 600) {
      exclude.push(...magers);
    }
    for (const mob of shieldAttackers) {
      if (!isTagged(mob)) {
        exclude.push(mob);
      }
    }
    if (jad) {
      exclude.push(jad);
    }
    return chooseZukWaveTarget(region, player, InfernoAutomation.target, exclude);
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
    const line =
      `t${String(InfernoAutomation.tickCount).padStart(4)} ` +
      `@${player.location.x},${player.location.y} ` +
      `-> ${chosen ? `${chosen.x},${chosen.y}` : "home"} ` +
      `pray=${(overhead?.feature() ?? "-").padEnd(5)} ` +
      `hp=${player.currentStats?.hitpoint ?? "?"} ` +
      `run=${energy}% ${orb} ` +
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

    // Movement and attacking are NOT independent, and the engine enforces it both ways:
    //   Player.moveTo()  -> interruptCombat() -> setAggro(null)   walking drops the target
    //   setAggro(inRangeMob)                                      attacking stops the walk
    // They are both left-clicks on the world and in OSRS the later one wins, so only one can
    // happen per tick. Movement takes precedence: repositioning decides which mobs can hit us
    // and on which ticks, and a delayed attack only costs a little damage output.
    //
    // ZUK ONLY, this is inverted. The fight is long, every tbow hit against 1200 hp matters,
    // and the shield-coverage penalty already carries its own multi-tick buffer (see
    // ZUK_SHIELD_COVER_BUFFER_TICKS) specifically so a reposition can wait a tick without
    // losing cover. A "delayed attack" is not free the way it is everywhere else: on any tick
    // the weapon is ALREADY on cooldown, a move costs nothing (no swing was happening this
    // tick regardless), but on a tick the swing is actually ready, walking instead of firing
    // throws a real hit away for a reposition that had slack to wait for it. So on wave 69, if
    // Zuk is up, reachable RIGHT NOW and the weapon is off cooldown, take the swing and let
    // the reposition happen next tick instead - it is not being skipped, only sequenced after
    // the attack it would otherwise have pre-empted for nothing.
    //
    // Gated on ACTUALLY STILL COVERED, read straight off this tick's own score for the tile
    // we are standing on - not inferred from "the scorer wants to move" (buffered repositions
    // fire well before cover is lost, which is most of why chosenTile differs from here). The
    // one case that must never take the swing is the tile already carrying
    // ZUK_SHIELD_UNCOVERED_PENALTY: there, standing still to fire costs a 251 hit to save one
    // tbow swing, and no amount of DPS is worth that trade.
    const zuk = visibleMobs(region).find(
      (mob) => mob.dying === -1 && mob.mobName() === EntityNames.TZ_KAL_ZUK,
    );
    const stillCovered = !InfernoAutomation.scoredTiles.some(
      (scored) =>
        scored.tile.x === player.location.x &&
        scored.tile.y === player.location.y &&
        (scored.parts?.shieldPenalty ?? 0) !== 0,
    );
    const zukSwingReady =
      !!zuk &&
      stillCovered &&
      (player.attackDelay ?? 0) <= 0 &&
      attackOptionFor(region, player, zuk) !== null;

    const repositioning = zukSwingReady ? false : InfernoAutomation.stepMovement(player, region);
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
      // Zuk wave gets its own flat ranking, checked AHEAD of the Jad-wave case below: the
      // Zuk-phase Jad spawns with its own healers too, and without this precedence a live Jad
      // on wave 69 would incorrectly pull in the tag-and-turn mechanic built for a standalone
      // Jad wave, rather than being treated as one more entry (priority 4) in Zuk's own order.
      let intended: Mob | null;
      if (zuk) {
        intended = InfernoAutomation.decideZukTarget(region, player, zuk);
      } else {
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
        intended =
          nibbler ??
          (jadWave
            ? chooseJadWaveTarget(region, player)
            : chooseByPriority(region, player, InfernoAutomation.target));
      }

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
        // NOT on 67/68/69. Those waves already have dedicated positioning logic (the healer
        // tag-and-turn, the shield tracker) that a mage-set switch has no business competing
        // with, and "alive <= 2" trips constantly there for the wrong reason - Jad's own
        // healers count towards it, and on 69 the shield (which never dies) plus Zuk alone
        // already satisfies it for most of the fight. Kill speed against a boss is worth more
        // than topping up, unlike the tail of a regular wave.
        const wave = (region as unknown as { wave?: number }).wave ?? 0;
        const healing =
          wave < 67 &&
          (player.currentStats?.hitpoint ?? 0) < (player.stats?.hitpoint ?? 0) &&
          visibleMobs(region).filter((mob) => mob.dying === -1).length <= 2;
        // ZUK WAVE gear, the user's explicit call: blowpipe the ranger and Zuk's own healer
        // (Jal-MejJak, enrage phase) when in blowpipe range, tbow everything else - Jad's
        // healers, mager, Jad and Zuk alike. Overrides the general reach-fallback chain below
        // entirely for this wave; it does not feed into it.
        let set: GearSetName;
        if (stacked || healing) {
          set = "mage";
        } else if (zuk) {
          const blowpipe = weaponForSet(player, "blowpipe") as { attackRange?: number } | null;
          const blowpipeRange = blowpipe?.attackRange ?? 5;
          const blowpipeMob =
            intended.mobName() === EntityNames.JAL_XIL ||
            intended.mobName() === EntityNames.JAL_MEJ_JAK;
          set =
            blowpipeMob && isAttackable(region, player, intended, blowpipeRange)
              ? "blowpipe"
              : "tbow";
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
