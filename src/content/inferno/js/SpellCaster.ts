"use strict";

import { ControlPanelController, ItemName, Player, Settings } from "osrs-sdk";

/**
 * Selecting a spell from the ancient spellbook, the way a player does: open the magic tab
 * and click the spell.
 *
 * Two things make the ordering strict:
 *
 *  - `Player.attack()` clears `manualSpellCastSelection` after a single cast, so a selection
 *    is one shot rather than a mode;
 *  - `Player.moveTo()` also clears it, so moving between selecting and casting silently
 *    throws the spell away.
 *
 * So a manual cast has to be select -> cast -> move, with nothing in between.
 */

// Hit boxes taken from AncientsSpellbookControls.panelClickDown, which tests the raw panel
// coordinates after dividing by controlPanelScale.
const ICE_BARRAGE_CENTRE = { x: 31, y: 239 };
const BLOOD_BARRAGE_CENTRE = { x: 176, y: 204 };

export type SpellClickReporter = (canvasX: number, canvasY: number) => void;

function clickSpell(
  player: Player,
  centre: { x: number; y: number },
  report?: SpellClickReporter,
): boolean {
  const controller = ControlPanelController.controller;
  const spellbook = ControlPanelController.controls.ANCIENTSSPELLBOOK;
  if (!controller || !spellbook) {
    return false;
  }

  if (controller.selectedControl !== spellbook) {
    controller.setActiveControl("ANCIENTSSPELLBOOK");
  }

  const scale = Settings.controlPanelScale ?? 1;
  const localX = centre.x * scale;
  const localY = centre.y * scale;

  try {
    const panelPos = controller.controlPosition(spellbook);
    report?.(panelPos.x + localX, panelPos.y + localY);
  } catch (e) {
    // Cursor position is cosmetic.
  }

  spellbook.panelClickDown(localX, localY);
  return !!player.manualSpellCastSelection;
}

export function selectIceBarrage(player: Player, report?: SpellClickReporter): boolean {
  return clickSpell(player, ICE_BARRAGE_CENTRE, report);
}

export function selectBloodBarrage(player: Player, report?: SpellClickReporter): boolean {
  return clickSpell(player, BLOOD_BARRAGE_CENTRE, report);
}

/** Name of the spell currently queued for a manual cast, if any. */
export function selectedSpell(player: Player): string | null {
  const selection = player.manualSpellCastSelection as unknown as { itemName?: string } | null;
  return selection?.itemName ?? null;
}

export function hasIceBarrageSelected(player: Player): boolean {
  return selectedSpell(player) === ItemName.ICE_BARRAGE;
}
