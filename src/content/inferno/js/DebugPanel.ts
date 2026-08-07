"use strict";

/**
 * Floating panel of exact scoring numbers, for whenever the tile grid's rounded, recoloured
 * labels are not enough to tell two nearby values apart.
 *
 * Self-contained the same way AutomationOverlay is: builds its own DOM and stylesheet on first
 * show rather than depending on markup living in sidebar.html, so a caller only ever needs
 * `show`/`hide`/`toggle` and a row-update method. Only the toggle button itself lives in the
 * sidebar, matching every other debug control there.
 */

const STYLE_ID = "debug-panel-style";
const CSS = `
#debug_panel {
  position: fixed;
  top: 60px;
  right: 250px;
  z-index: 950;
  background: black;
  border: 1px solid #ffff00;
  color: #ffff00;
  font-family: "OSRS", monospace;
  font-size: 14px;
  padding: 10px 12px;
  min-width: 200px;
}
#debug_panel.hidden { display: none !important; }

#debug_panel_header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 16px;
}

#debug_panel_close {
  font-family: "OSRS", monospace;
  background: none;
  border: 1px solid #ffff00;
  color: #ffff00;
  cursor: pointer;
  padding: 0 6px;
  margin-left: 12px;
}

#debug_panel_body {
  white-space: pre;
  font-size: 12px;
  line-height: 1.35;
  max-height: 45vh;
  overflow-y: auto;
}
`;

export class DebugPanel {
  private static panel: HTMLDivElement | null = null;
  private static body: HTMLDivElement | null = null;
  private static shown = false;

  private static ensureBuilt() {
    if (DebugPanel.panel) {
      return;
    }
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const panel = document.createElement("div");
    panel.id = "debug_panel";
    panel.className = "hidden";

    const header = document.createElement("div");
    header.id = "debug_panel_header";
    const title = document.createElement("span");
    title.innerText = "Debug Panel";
    const close = document.createElement("button");
    close.id = "debug_panel_close";
    close.type = "button";
    close.innerText = "X";
    close.addEventListener("click", () => DebugPanel.hide());
    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement("div");
    body.id = "debug_panel_body";
    body.innerText = "-";

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    DebugPanel.panel = panel;
    DebugPanel.body = body;
  }

  static isVisible(): boolean {
    return DebugPanel.shown;
  }

  static show() {
    DebugPanel.ensureBuilt();
    DebugPanel.shown = true;
    DebugPanel.panel?.classList.remove("hidden");
  }

  static hide() {
    DebugPanel.shown = false;
    DebugPanel.panel?.classList.add("hidden");
  }

  static toggle() {
    if (DebugPanel.shown) {
      DebugPanel.hide();
    } else {
      DebugPanel.show();
    }
  }

  /**
   * Replace the panel body with one line per entry.
   *
   * Takes plain label/value pairs rather than reaching into scoring itself, so this file stays
   * ignorant of what it is displaying - the caller decides what is worth showing.
   */
  static update(rows: { label: string; value: string }[]) {
    if (!DebugPanel.shown || !DebugPanel.body) {
      return;
    }
    DebugPanel.body.innerText = rows.map((row) => `${row.label}: ${row.value}`).join("\n");
  }

  /**
   * Rolling per-tick log, newest at the bottom.
   *
   * A running sequence rather than a snapshot, because the interesting thing is the ORDER -
   * which tick the player moved on, which tick a mob fired, which tick something was reachable.
   * A single-value readout cannot show a relationship between them.
   */
  private static lines: string[] = [];

  private static readonly MAX_LINES = 60;

  static append(line: string) {
    if (!DebugPanel.shown || !DebugPanel.body) {
      return;
    }
    DebugPanel.lines.push(line);
    if (DebugPanel.lines.length > DebugPanel.MAX_LINES) {
      DebugPanel.lines.shift();
    }
    DebugPanel.body.innerText = DebugPanel.lines.join("\n");
    DebugPanel.body.scrollTop = DebugPanel.body.scrollHeight;
  }

  static clearLog() {
    DebugPanel.lines = [];
  }
}
