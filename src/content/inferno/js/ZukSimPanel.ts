"use strict";

import { PlayerAttackClock } from "./PlayerAttackClock";
import { prayerForAttackStyle } from "./OverheadPlanner";
import { ShieldAttackerClock, UNKNOWN_STYLE } from "./ShieldAttackerClock";
import { ZukAttackClock } from "./ZukAttackClock";
import { ZukSetTimer } from "./ZukSetTimer";

/**
 * The Zuk timeline: what is about to happen, tick by tick, in lanes.
 *
 * The wave's whole problem is scheduling - which tick Zuk fires on, which tick the weapon is off
 * cooldown, which overhead has to be up when - and none of that is legible from a 3D scene or a
 * tile grid. This draws it as a strip of ticks so the plan can be read at a glance and, more
 * importantly, so a plan that disagrees with what actually happens is visible immediately.
 *
 * PURELY A RENDERER. The clock it draws lives in `ZukAttackClock`, which the tile scorer reads
 * too - so what is on screen is literally the schedule the bot is positioning against, not a
 * second opinion that could drift from it. Nothing here observes anything or decides anything.
 *
 * The clock knows no more than a player watching the screen: it syncs off attacks it has SEEN,
 * so until Zuk has fired once the lane is empty rather than guessing. That is what makes the
 * strip worth having - a prediction taken from Zuk's private countdown would be right by
 * construction and could never disagree with reality. Taken from the last observed fire it CAN
 * be wrong, and when it is, the solid mark lands where the dashed one is not.
 *
 * A view, never a decision: built the same way TileGrid and DebugPanel are, updated from
 * InfernoRegion.postTick so it works with automation off, and `pointer-events: none` means it can
 * never intercept a click meant for the game underneath. Nothing here writes to the region.
 */

/** Tick columns drawn, including the trailing one. */
const TICKS = 12;
/** How many of those columns are already in the past. Column 0 is tick -1; column 1 is now. */
const TRAILING = 1;

const STYLE_ID = "zuk-sim-panel-style";

/**
 * Lane colours follow the ones already in use elsewhere so the same thing is never two colours:
 * the prayer palette matches AutomationOverlay's banner, and Zuk's orange is the colour of its
 * own projectile in TzKalZuk.
 */
const CSS = `
#zuk_sim_panel {
  position: fixed;
  bottom: 0;
  left: 0;
  z-index: 950;
  display: flex;
  justify-content: center;
  pointer-events: none;
  font-family: "OSRS";
}
#zuk_sim_panel.hidden { display: none !important; }

#zuk_sim_box {
  margin-bottom: 10px;
  padding: 8px 10px 7px;
  background: rgba(12, 10, 8, 0.86);
  border: 1px solid #5a4a32;
  border-radius: 3px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.55);
}

#zuk_sim_title {
  color: #ffff00;
  font-size: 13px;
  letter-spacing: 1px;
  margin-bottom: 6px;
  text-shadow: 1px 1px 0 #000;
}
#zuk_sim_state {
  color: #c8bda8;
  float: right;
  letter-spacing: 0;
  margin-left: 18px;
}
#zuk_sim_state.enraged { color: #ff6f4f; }
#zuk_sim_state.absent  { color: #7a6a52; }

#zuk_sim_grid {
  display: grid;
  /* label gutter, then one column per tick */
  grid-template-columns: 78px repeat(${TICKS}, 28px);
  gap: 2px;
  align-items: center;
}

.zuk_sim_label {
  color: #c8bda8;
  font-size: 12px;
  text-align: right;
  padding-right: 6px;
  white-space: nowrap;
}
/* A lane with nothing behind it yet, so an empty row never reads as "nothing is happening". */
.zuk_sim_label.idle { color: #5a4e3c; }

.zuk_sim_tick {
  color: #7a6a52;
  font-size: 11px;
  text-align: center;
}
/* The tick that has already resolved - drawn, but visibly behind us. */
.zuk_sim_tick.past { color: #4a4038; }
.zuk_sim_tick.now  { color: #ffff00; }

.zuk_sim_cell {
  height: 20px;
  border: 1px solid #33291d;
  border-radius: 2px;
  background: #17130e;
  box-sizing: border-box;
}
/* Everything left of NOW is history: same layout, dimmed, so the eye starts at the right place. */
.zuk_sim_cell.past { opacity: 0.4; }
/* NOW is a column, not a cell - the seam the whole strip is read from. */
.zuk_sim_cell.now { border-color: #ffff00; }

/* OBSERVED: it happened. Solid fill. */
.zuk_sim_cell.zuk { background: #ffaa00; border-color: #ffcc55; }
.zuk_sim_cell.attack { background: #d8d8d8; border-color: #ffffff; }

/*
 * The tick the weapon comes off cooldown, and every tick after it.
 *
 * Two states rather than one because a cooldown is not an event: it expires at a known tick and
 * then STAYS expired until something spends it. The bright edge is the moment it clears; the wash
 * behind it is "still sitting there, unused". A single mark would have said the shot happens on
 * that tick, which is a decision nobody has made.
 */
.zuk_sim_cell.ready {
  background: rgba(216, 216, 216, 0.16);
  border-color: #8a8a8a;
  border-style: dashed;
}
.zuk_sim_cell.ready_held { background: rgba(216, 216, 216, 0.07); }

/*
 * Prayer lane. Colours match AutomationOverlay's banner so magic is magic everywhere.
 *
 * The both state is the whole reason this lane is worth drawing: one overhead is up at a time, so a tick
 * carrying magic AND range has an unblockable half whichever way it is prayed. It is drawn as its
 * own loud state rather than a blend of the two, because it is a different KIND of fact - not
 * "two things happen here" but "this one costs hitpoints no matter what".
 */
.zuk_sim_cell.magic { background: #6fa8ff; border-color: #a8ccff; }
.zuk_sim_cell.range { background: #6fff8f; border-color: #a8ffbf; }
.zuk_sim_cell.melee { background: #ff8f6f; border-color: #ffbfa8; }
/* Something lands here and no overhead is known to stop it - Jad, before it has rolled. */
.zuk_sim_cell.unknown { background: #b083ff; border-color: #d0b6ff; }
.zuk_sim_cell.both  { background: #ff4444; border-color: #ff9090; }

/* Projected rather than watched - same hue, hollowed out, as with zuk_predicted. */
.zuk_sim_cell.magic_predicted {
  background: rgba(111, 168, 255, 0.16);
  border-color: #46689f;
  border-style: dashed;
}
.zuk_sim_cell.range_predicted {
  background: rgba(111, 255, 143, 0.16);
  border-color: #469f5a;
  border-style: dashed;
}
.zuk_sim_cell.melee_predicted {
  background: rgba(255, 143, 111, 0.16);
  border-color: #9f5a46;
  border-style: dashed;
}
.zuk_sim_cell.unknown_predicted {
  background: rgba(176, 131, 255, 0.16);
  border-color: #6b4f9f;
  border-style: dashed;
}
.zuk_sim_cell.both_predicted {
  background: rgba(255, 68, 68, 0.2);
  border-color: #a02b2b;
  border-style: dashed;
}
/*
 * PREDICTED: read off Zuk's attackDelay, has not happened yet. Outlined rather than filled, so
 * "the sim thinks" and "the engine did" can never be mistaken for one another at a glance.
 */
.zuk_sim_cell.zuk_predicted {
  background: rgba(255, 170, 0, 0.16);
  border-color: #a86f00;
  border-style: dashed;
}

#zuk_sim_footer {
  margin-top: 6px;
  color: #6a5a42;
  font-size: 10px;
  text-align: center;
}
`;

/** The three lanes, top to bottom, in the order they were asked for. */
const LANES: { key: string; label: string }[] = [
  { key: "zuk_attack", label: "zuk attack" },
  { key: "player_attack", label: "player attack" },
  { key: "prayer", label: "prayer" },
];

/** Lanes with nothing wired to them yet - greyed labels, empty cells. */
const IDLE_LANES = new Set<string>();

/** What one cell is showing. Null is an empty tick. */
type Mark =
  | "zuk"
  | "zuk_predicted"
  | "attack"
  | "ready"
  | "ready_held"
  | "magic"
  | "range"
  | "melee"
  | "unknown"
  | "both"
  | "magic_predicted"
  | "range_predicted"
  | "melee_predicted"
  | "unknown_predicted"
  | "both_predicted"
  | null;

export class ZukSimPanel {
  private static panel: HTMLDivElement | null = null;
  private static state: HTMLSpanElement | null = null;
  private static footer: HTMLDivElement | null = null;
  /** Cells by lane, left to right. Held so an update restyles rather than rebuilds. */
  private static cells = new Map<string, HTMLDivElement[]>();
  private static shown = false;


  private static ensureBuilt() {
    if (ZukSimPanel.panel) {
      return;
    }
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const panel = document.createElement("div");
    panel.id = "zuk_sim_panel";
    panel.className = "hidden";

    const box = document.createElement("div");
    box.id = "zuk_sim_box";

    const title = document.createElement("div");
    title.id = "zuk_sim_title";
    title.innerText = "ZUK SIM";
    const state = document.createElement("span");
    state.id = "zuk_sim_state";
    state.className = "absent";
    state.innerText = "no zuk";
    title.appendChild(state);

    const grid = document.createElement("div");
    grid.id = "zuk_sim_grid";

    // Header row: an empty label gutter, then the tick offsets. Negative is the past, 0 is now.
    const corner = document.createElement("div");
    corner.className = "zuk_sim_label";
    grid.appendChild(corner);
    for (let column = 0; column < TICKS; column++) {
      const offset = column - TRAILING;
      const tick = document.createElement("div");
      tick.className = `zuk_sim_tick${offset < 0 ? " past" : offset === 0 ? " now" : ""}`;
      tick.innerText = offset === 0 ? "now" : String(offset);
      grid.appendChild(tick);
    }

    for (const lane of LANES) {
      const label = document.createElement("div");
      label.className = `zuk_sim_label${IDLE_LANES.has(lane.key) ? " idle" : ""}`;
      label.innerText = lane.label;
      grid.appendChild(label);

      const row: HTMLDivElement[] = [];
      for (let column = 0; column < TICKS; column++) {
        const cell = document.createElement("div");
        cell.dataset.lane = lane.key;
        cell.dataset.offset = String(column - TRAILING);
        grid.appendChild(cell);
        row.push(cell);
      }
      ZukSimPanel.cells.set(lane.key, row);
    }

    const footer = document.createElement("div");
    footer.id = "zuk_sim_footer";
    footer.innerText = "";

    box.appendChild(title);
    box.appendChild(grid);
    box.appendChild(footer);
    panel.appendChild(box);
    document.body.appendChild(panel);

    ZukSimPanel.panel = panel;
    ZukSimPanel.state = state;
    ZukSimPanel.footer = footer;
    ZukSimPanel.paint(() => null);
  }

  /** Apply `mark(offset)` to one lane's cells, keeping the past/now column styling intact. */
  private static paintLane(lane: string, mark: (offset: number) => Mark) {
    const row = ZukSimPanel.cells.get(lane);
    if (!row) {
      return;
    }
    for (let column = 0; column < row.length; column++) {
      const offset = column - TRAILING;
      const value = mark(offset);
      row[column].className =
        "zuk_sim_cell" +
        (offset < 0 ? " past" : offset === 0 ? " now" : "") +
        (value ? ` ${value}` : "");
    }
  }

  /** Apply `mark(lane, offset)` to every cell, keeping the past/now column styling intact. */
  private static paint(mark: (lane: string, offset: number) => Mark) {
    ZukSimPanel.cells.forEach((row, lane) => {
      for (let column = 0; column < row.length; column++) {
        const offset = column - TRAILING;
        const value = mark(lane, offset);
        row[column].className =
          "zuk_sim_cell" +
          (offset < 0 ? " past" : offset === 0 ? " now" : "") +
          (value ? ` ${value}` : "");
      }
    });
  }

  /**
   * One tick of the strip. Called from InfernoRegion.postTick, after everything else has read the
   * tick - the strip reports, it never feeds anything.
   *
   * Registered marks (solid) are fires `ZukAttackClock` watched happen. Predicted marks (dashed)
   * are whole multiples of the cycle past the last one it saw. Before the first sighting there is
   * no phase and the lane is deliberately empty.
   */
  static update() {
    if (!ZukSimPanel.shown) {
      return;
    }
    ZukSimPanel.ensureBuilt();

    const zuk = ZukAttackClock.zuk();
    if (!zuk) {
      // Dead, or a wave without one. Clear rather than freeze on the last reading - a stale strip
      // that looks live is worse than an empty one.
      ZukSimPanel.paint(() => null);
      ZukSimPanel.setState("no zuk", "absent");
      ZukSimPanel.setFooter("");
      return;
    }

    const sinceFire = ZukAttackClock.ticksSinceLastAttack();
    const untilFire = ZukAttackClock.ticksUntilNextAttack();

    ZukSimPanel.paintLane("zuk_attack", (offset) => {
      // Registered: we watched it happen, on this tick or the one before.
      if (offset <= 0) {
        return ZukAttackClock.firedOnTickOffset(offset) ? "zuk" : null;
      }
      // Predicted: whole multiples of the cycle past the last one we SAW. Nothing at all before
      // the first sighting - there is no phase to project from and a guess would be a lie.
      if (sinceFire === null) {
        return null;
      }
      return (offset + sinceFire) % zuk.speed === 0 ? "zuk_predicted" : null;
    });

    // PRAYER LANE: which style is landing on each tick, from the mager and ranger.
    //
    // Aggregated across every attacker on the board rather than shown per mob, because the thing
    // being decided is a single overhead - what matters is the SET of styles arriving on a tick,
    // not how many mobs contributed. Two magers on one tick is one Protect from Magic and costs
    // nothing; a mager and a ranger on one tick is unblockable whichever is prayed, and that is
    // the case the lane exists to make visible.
    //
    // Observed and projected are kept apart even when they collide on the same tick: a watched
    // attack is a fact, a projected one is the cadence talking, and a cell that mixes them would
    // claim more certainty than it has. Observed wins the cell when both land there.
    const fires = ShieldAttackerClock.firesInWindow(-TRAILING, TICKS - TRAILING - 1);
    ZukSimPanel.paintLane("prayer", (offset) => {
      const here = fires.filter((fire) => fire.offset === offset);
      if (here.length === 0) {
        return null;
      }
      const watched = here.filter((fire) => fire.observed);
      const shown = watched.length > 0 ? watched : here;

      // Collapse to PRAYERS, not styles. Two magers on a tick want one Protect from Magic and
      // cost nothing; a mager and a ranger want two and one of them lands. And a single mager
      // standing next to us is already two prayers on its own, because `canMeleeIfClose` has not
      // been rolled yet - which is the case a style-only view would have shown as settled magic.
      const prayers: string[] = [];
      let unknown = false;
      for (const fire of shown) {
        for (const style of fire.styles) {
          if (style === UNKNOWN_STYLE) {
            unknown = true;
            continue;
          }
          const prayer = prayerForAttackStyle(style);
          if (prayer && prayers.indexOf(prayer) < 0) {
            prayers.push(prayer);
          }
        }
      }
      if (prayers.length === 0 && !unknown) {
        return null;
      }

      // Ordered by how bad the tick is, worst first.
      //
      // Two known prayers is the only CERTAIN loss - whichever is up, the other lands - so it
      // outranks the unknown even when Jad is also firing. An unknown alone is not a loss, it is a
      // coin flip: one overhead does cover it, we just cannot say which yet, and calling that
      // "both" would overstate it. It still takes the slot, which is the point.
      const known = shown.find(
        (fire) => fire.styles.some((style) => style !== UNKNOWN_STYLE),
      );
      const only = known?.styles.find((style) => style !== UNKNOWN_STYLE);
      const mark: Mark =
        prayers.length > 1
          ? "both"
          : unknown
            ? "unknown"
            : only === "magic"
              ? "magic"
              : only === "range"
                ? "range"
                : "melee";
      return watched.length > 0 ? mark : (`${mark}_predicted` as Mark);
    });

    ZukSimPanel.paintLane("player_attack", (offset) => {
      // Registered: a shot we watched go out.
      if (offset <= 0) {
        return PlayerAttackClock.firedOnTickOffset(offset) ? "attack" : null;
      }
      const earliest = PlayerAttackClock.earliestShotOffset();
      if (earliest === null || offset < earliest) {
        return null; // still on cooldown
      }
      // NOT a predicted shot - an available one. Nothing has decided to spend it, and on this
      // wave nothing ever does yet, so drawing a firm mark on the ready tick would claim an
      // attack that is not going to happen. The bright edge is where it clears; the wash after is
      // the shot still sitting there.
      return offset === earliest ? "ready" : "ready_held";
    });

    const set = ZukSetTimer.display();
    const setNote =
      set === null ? "" : ` | set ${set}${ZukSetTimer.isPaused() ? " PAUSED" : ""}`;
    ZukSimPanel.setState(
      `${zuk.hp} hp | spd ${zuk.speed}${zuk.enraged ? " ENRAGED" : ""}${setNote}`,
      zuk.enraged ? "enraged" : "",
    );
    const weapon = PlayerAttackClock.weapon();
    const weaponNote =
      weapon === null
        ? ""
        : PlayerAttackClock.isReadyNow()
          ? " | weapon ready"
          : ` | weapon ready in ${weapon.delay}`;
    const attackers = ShieldAttackerClock.counts();
    const attackerNote =
      attackers.total === 0
        ? ""
        : ` | ${attackers.fired}/${attackers.total} attackers fired`;
    ZukSimPanel.setFooter(
      (untilFire === null
        ? "not seen zuk attack yet - nothing to sync to"
        : `next zuk attack in ${untilFire}`) +
        weaponNote +
        attackerNote,
    );
  }

  private static setState(text: string, className: string) {
    if (ZukSimPanel.state && ZukSimPanel.state.innerText !== text) {
      ZukSimPanel.state.innerText = text;
    }
    if (ZukSimPanel.state) {
      ZukSimPanel.state.className = className;
    }
  }

  private static setFooter(text: string) {
    if (ZukSimPanel.footer && ZukSimPanel.footer.innerText !== text) {
      ZukSimPanel.footer.innerText = text;
    }
  }

  /**
   * Centre the strip on the GAME area rather than the window, so the sidebar does not push it
   * visually off to one side. Same measurement AutomationOverlay.layout uses, and the same 234px
   * fallback for when the panel is not in the document yet.
   */
  private static layout() {
    const panel = ZukSimPanel.panel;
    if (!panel) {
      return;
    }
    const sidebar = document.getElementById("right_panel");
    const reserved = sidebar
      ? Math.max(0, window.innerWidth - sidebar.getBoundingClientRect().left)
      : 234;
    panel.style.right = `${reserved}px`;
  }

  static isVisible(): boolean {
    return ZukSimPanel.shown;
  }

  static setVisible(shown: boolean) {
    ZukSimPanel.shown = shown;
    if (!shown) {
      ZukSimPanel.panel?.classList.add("hidden");
      return;
    }
    ZukSimPanel.ensureBuilt();
    ZukSimPanel.layout();
    // Nothing to reset: the clock has been running whether or not this was drawn, so a fight
    // already in progress keeps the cadence it has earned.
    ZukSimPanel.panel?.classList.remove("hidden");
  }

  /** Re-centre after a resize. Cheap, and only does anything while the panel is up. */
  static onResize() {
    if (ZukSimPanel.shown) {
      ZukSimPanel.layout();
    }
  }
}
