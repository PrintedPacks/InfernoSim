"use strict";

import * as THREE from "three";
import { ControlPanelController, Viewport } from "osrs-sdk";

/** Control panel tabs the automation clicks in. */
export type ControlPanelName = "INVENTORY" | "PRAYER" | "ANCIENTSSPELLBOOK";

/**
 * One click the automation made this tick, for replay on the simulated cursor.
 *
 * `panel` matters as much as the position: replaying it is what keeps the visible tab in step
 * with the cursor, instead of the tab jumping straight to whatever the tick's last action
 * touched while the cursor is still working through earlier ones.
 */
export interface ClickStep {
  panel?: ControlPanelName;
  /** Position in game-canvas pixels, for clicks on the control panel. */
  canvas?: { x: number; y: number };
  /** Position as a world tile, for clicks in the scene. */
  tile?: { x: number; y: number };
  /**
   * Move the cursor there without clicking.
   *
   * A real player parks the mouse over where they expect to click before they can click - most
   * of the opening of a wave is spent hovering, not clicking. Drawing that as a click would
   * claim an action the bot did not take.
   */
  hover?: boolean;
}

/**
 * Visual layer for automated play: swallows real input so the human and the bot cannot
 * fight over the same player, and draws a simulated cursor that moves to whatever tile the
 * automation is acting on.
 *
 * The overlay covers the world canvas but deliberately stops short of the right panel, so
 * the Disable Automation button stays reachable. Escape also switches automation off.
 */

const STYLE_ID = "automation-overlay-style";
const CSS = `
#automation_overlay {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 900;
  cursor: none;
}
#automation_overlay.hidden { display: none !important; }

/*
 * Hand the mouse back to the human. With pointer-events off the overlay is not hit-tested at
 * all, so the swallow listeners never fire and the real cursor reappears from the canvas
 * underneath - no need to detach anything.
 */
#automation_overlay.passthrough { pointer-events: none; }

#automation_cursor {
  position: absolute;
  width: 18px;
  height: 26px;
  margin: -2px 0 0 -2px;
  background: #ffffff;
  clip-path: polygon(0 0, 0 74%, 27% 58%, 45% 100%, 66% 90%, 48% 50%, 100% 43%);
  filter: drop-shadow(0 0 1px #000) drop-shadow(0 0 2px #000);
  transition: left 0.22s ease-out, top 0.22s ease-out;
  pointer-events: none;
}

#automation_click {
  position: absolute;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border: 2px solid #ffff00;
  border-radius: 50%;
  opacity: 0;
  pointer-events: none;
}
#automation_click.flash { animation: automation-click 0.4s ease-out; }
@keyframes automation-click {
  0%   { opacity: 1; transform: scale(0.3); }
  100% { opacity: 0; transform: scale(1.6); }
}

#automation_banner {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  font-family: "OSRS";
  color: #ffff00;
  font-size: 18px;
  pointer-events: none;
  text-shadow: 1px 1px 0 #000;
  text-align: center;
}

#automation_prayer {
  display: block;
  font-size: 22px;
  margin-top: 4px;
}
#automation_prayer.magic { color: #6fa8ff; }
#automation_prayer.range { color: #6fff8f; }
#automation_prayer.melee { color: #ff8f6f; }
#automation_prayer.none  { color: #888888; }

#automation_threats {
  display: block;
  font-size: 14px;
  color: #dddddd;
  margin-top: 2px;
  white-space: pre-line;
}
`;

const BLOCKED_MOUSE_EVENTS = [
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
  "wheel",
  "touchstart",
  "touchmove",
  "touchend",
];

export class AutomationOverlay {
  private static overlay: HTMLDivElement | null = null;
  private static cursor: HTMLDivElement | null = null;
  private static clickMarker: HTMLDivElement | null = null;
  private static keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private static onEscape: (() => void) | null = null;

  private static ensureBuilt() {
    if (AutomationOverlay.overlay) {
      return;
    }
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const overlay = document.createElement("div");
    overlay.id = "automation_overlay";
    overlay.className = "hidden";

    const banner = document.createElement("div");
    banner.id = "automation_banner";
    banner.innerText = "Automation running - press Esc to stop";

    const prayerLine = document.createElement("span");
    prayerLine.id = "automation_prayer";
    prayerLine.className = "none";
    prayerLine.innerText = "no prayer";

    const threatLine = document.createElement("span");
    threatLine.id = "automation_threats";
    threatLine.innerText = "";

    banner.appendChild(prayerLine);
    banner.appendChild(threatLine);

    const cursor = document.createElement("div");
    cursor.id = "automation_cursor";

    const clickMarker = document.createElement("div");
    clickMarker.id = "automation_click";

    overlay.appendChild(banner);
    overlay.appendChild(clickMarker);
    overlay.appendChild(cursor);
    document.body.appendChild(overlay);

    // Swallow every pointer interaction that reaches the overlay.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const type of BLOCKED_MOUSE_EVENTS) {
      overlay.addEventListener(type, swallow, { capture: true, passive: false });
    }

    AutomationOverlay.overlay = overlay;
    AutomationOverlay.cursor = cursor;
    AutomationOverlay.clickMarker = clickMarker;
  }

  /** Keep the overlay clear of the sidebar so its controls stay clickable. */
  private static layout() {
    const overlay = AutomationOverlay.overlay;
    if (!overlay) {
      return;
    }
    const panel = document.getElementById("right_panel");
    const reserved = panel
      ? Math.max(0, window.innerWidth - panel.getBoundingClientRect().left)
      : 234;
    overlay.style.right = `${reserved}px`;
  }

  static show(onEscape?: () => void) {
    AutomationOverlay.ensureBuilt();
    AutomationOverlay.layout();
    AutomationOverlay.overlay?.classList.remove("hidden");
    AutomationOverlay.onEscape = onEscape ?? null;

    if (!AutomationOverlay.keyHandler) {
      AutomationOverlay.keyHandler = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          AutomationOverlay.onEscape?.();
          return;
        }
        // Let the automation's own synthetic keypresses through; block the human's.
        if ((e as unknown as { __automation?: boolean }).__automation) {
          return;
        }
        e.stopPropagation();
      };
      window.addEventListener("keydown", AutomationOverlay.keyHandler, true);
      window.addEventListener("keyup", AutomationOverlay.keyHandler, true);
    }
  }

  /**
   * Whether the overlay swallows mouse input.
   *
   * Separate from show/hide on purpose. Enabling automation switches this on, but does not own
   * it - it can be turned back off mid-run to take the mouse back while the bot keeps praying
   * and the grid keeps showing what it would have picked.
   *
   * Only the mouse. The keyboard handler stays attached, so Escape still stops automation.
   */
  static setInputBlocked(blocked: boolean) {
    AutomationOverlay.ensureBuilt();
    AutomationOverlay.overlay?.classList.toggle("passthrough", !blocked);
  }

  static hide() {
    AutomationOverlay.overlay?.classList.add("hidden");
    if (AutomationOverlay.keyHandler) {
      window.removeEventListener("keydown", AutomationOverlay.keyHandler, true);
      window.removeEventListener("keyup", AutomationOverlay.keyHandler, true);
      AutomationOverlay.keyHandler = null;
    }
    AutomationOverlay.onEscape = null;
  }

  /**
   * Screen position of a tile, using the 3D camera when it is available. Returns null for
   * the 2D renderer, which exposes no projection - the cursor simply holds position there.
   */
  private static tileToScreen(tileX: number, tileY: number): { x: number; y: number } | null {
    const delegate = Viewport.viewport?.getDelegate() as unknown as {
      projectToScreen?: (v: THREE.Vector3) => { x: number; y: number };
    };
    if (!delegate?.projectToScreen) {
      return null;
    }
    const canvas = document.getElementById("world") as HTMLCanvasElement | null;
    if (!canvas) {
      return null;
    }
    try {
      const point = delegate.projectToScreen(new THREE.Vector3(tileX - 0.5, -0.49, tileY - 0.5));
      const rect = canvas.getBoundingClientRect();
      // projectToScreen works in the renderer's backing-store pixels; map those onto the
      // element's laid-out size.
      const scaleX = canvas.width ? rect.width / canvas.width : 1;
      const scaleY = canvas.height ? rect.height / canvas.height : 1;
      return { x: point.x * scaleX, y: point.y * scaleY };
    } catch (e) {
      return null;
    }
  }

  /**
   * Show which overhead is up and what it is covering.
   *
   * Flicks last a single tick, which is easy to miss on screen, so the prayer name is
   * colour-coded and the threats it is answering are listed underneath.
   */
  static setStatus(prayerName: string | null, threats: string, waveState = "") {
    const prayerLine = document.getElementById("automation_prayer");
    const threatLine = document.getElementById("automation_threats");
    if (prayerLine) {
      const style = prayerName?.includes("Magic")
        ? "magic"
        : prayerName?.includes("Range")
          ? "range"
          : prayerName?.includes("Melee")
            ? "melee"
            : "none";
      prayerLine.className = style;
      prayerLine.innerText = prayerName ?? "no prayer";
    }
    if (threatLine) {
      const lines = [threats ? `incoming: ${threats}` : "", waveState].filter(Boolean);
      threatLine.innerText = lines.join("\n");
    }
  }

  /** Glide the simulated cursor onto a tile. */
  static pointAtTile(tileX: number, tileY: number) {
    const pos = AutomationOverlay.tileToScreen(tileX, tileY);
    if (!pos || !AutomationOverlay.cursor) {
      return;
    }
    AutomationOverlay.cursor.style.left = `${pos.x}px`;
    AutomationOverlay.cursor.style.top = `${pos.y}px`;
  }

  /**
   * Move the cursor to a point in the game canvas's own coordinate space - used for UI
   * targets like prayer icons, which are drawn onto the canvas rather than being DOM nodes.
   */
  static pointAtCanvasPoint(canvasX: number, canvasY: number) {
    const canvas = document.getElementById("world") as HTMLCanvasElement | null;
    if (!canvas || !AutomationOverlay.cursor) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width ? rect.width / canvas.width : 1;
    const scaleY = canvas.height ? rect.height / canvas.height : 1;
    AutomationOverlay.cursor.style.left = `${canvasX * scaleX}px`;
    AutomationOverlay.cursor.style.top = `${canvasY * scaleY}px`;
  }

  /** Flash the click marker at a canvas-space point. */
  static flashClickAtCanvasPoint(canvasX: number, canvasY: number) {
    const canvas = document.getElementById("world") as HTMLCanvasElement | null;
    const marker = AutomationOverlay.clickMarker;
    if (!canvas || !marker) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width ? rect.width / canvas.width : 1;
    const scaleY = canvas.height ? rect.height / canvas.height : 1;
    marker.style.left = `${canvasX * scaleX}px`;
    marker.style.top = `${canvasY * scaleY}px`;
    marker.classList.remove("flash");
    void marker.offsetWidth;
    marker.classList.add("flash");
  }

  /**
   * Replay a tick's clicks on the cursor, spaced out in real time.
   *
   * A tick issues everything at once - tab switches included - because that is what the
   * engine needs. Drawing it at once is useless: the cursor is overwritten several times in a
   * single frame, so only the last position is ever seen, and the click flash restarts before
   * it can play. Worse, the tab jumps immediately to whatever the tick's final action touched,
   * so a five-piece gear switch ends up being drawn over an open magic tab.
   *
   * So the replay walks the cursor AND the tab through the sequence in order. Setting the tab
   * here is safe and purely cosmetic - ControlPanelController.setActiveControl is a bare
   * assignment, and the engine already has every click from this tick.
   */
  private static replayTimers: ReturnType<typeof setTimeout>[] = [];

  static replayClicks(steps: ClickStep[], windowMs = 550) {
    for (const timer of AutomationOverlay.replayTimers) {
      clearTimeout(timer);
    }
    AutomationOverlay.replayTimers = [];
    if (steps.length === 0) {
      return;
    }

    // Fit the whole sequence inside one tick. A busy tick is a prayer switch plus a five
    // piece gear switch plus a spell select, and fixed spacing would run that past 600ms and
    // straight into the next tick's replay.
    const spacing = steps.length > 1 ? Math.min(110, windowMs / steps.length) : 0;

    steps.forEach((step, index) => {
      const timer = setTimeout(() => AutomationOverlay.drawStep(step), index * spacing);
      AutomationOverlay.replayTimers.push(timer);
    });
  }

  private static drawStep(step: ClickStep) {
    if (step.panel) {
      ControlPanelController.controller?.setActiveControl(step.panel);
    }
    if (step.canvas) {
      AutomationOverlay.pointAtCanvasPoint(step.canvas.x, step.canvas.y);
      AutomationOverlay.flashClickAtCanvasPoint(step.canvas.x, step.canvas.y);
    } else if (step.tile) {
      AutomationOverlay.pointAtTile(step.tile.x, step.tile.y);
      if (!step.hover) {
        AutomationOverlay.flashClick(step.tile.x, step.tile.y);
      }
    }
  }

  /**
   * Fire a real keypress so the engine's own input handling opens the tab, rather than
   * setting the active tab behind the UI's back. Flagged so the overlay's key blocker lets
   * it past.
   */
  static pressKey(key: string) {
    for (const type of ["keydown", "keyup"]) {
      const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
      (event as unknown as { __automation: boolean }).__automation = true;
      document.dispatchEvent(event);
    }
  }

  /** Play the click marker where the cursor currently is. */
  static flashClick(tileX: number, tileY: number) {
    const pos = AutomationOverlay.tileToScreen(tileX, tileY);
    const marker = AutomationOverlay.clickMarker;
    if (!pos || !marker) {
      return;
    }
    marker.style.left = `${pos.x}px`;
    marker.style.top = `${pos.y}px`;
    marker.classList.remove("flash");
    // Force reflow so the animation restarts on repeated clicks.
    void marker.offsetWidth;
    marker.classList.add("flash");
  }
}
