"use strict";

import { ControlPanelController, Player, Settings } from "osrs-sdk";

/**
 * Equips items the way a player does: open the inventory tab, move the cursor to the slot,
 * click it.
 *
 * The click goes through InventoryControls.panelClickDown/panelClickUp - the same handlers a
 * real mouse reaches - which ends up queueing `inventoryLeftClick` on the InputController.
 * Calling `inventoryLeftClick` directly would work too, but would bypass the input queue and
 * so equip at a moment no player could.
 *
 * This is only the effector. Which weapon suits which mob is a strategy decision and lives
 * elsewhere.
 */

// Inventory grid, taken from InventoryControls.panelClickDown's own hit test:
//   itemX = 20 + (index % 4) * 43
//   itemY = 17 + (floor(index / 4) + 1) * 35
// Note the +1 on the row: the draw code omits it, but the CLICK handler applies it, and it
// is the click handler that decides what was hit.
const SLOT_ORIGIN_X = 20;
const SLOT_ORIGIN_Y = 17;
const SLOT_WIDTH = 43;
const SLOT_HEIGHT = 35;
const SLOT_COLUMNS = 4;

export type InventoryClickReporter = (canvasX: number, canvasY: number) => void;

/** Where an inventory slot sits, in panel-relative pixels. */
export function inventorySlotPosition(index: number): { x: number; y: number } {
  const scale = Settings.controlPanelScale ?? 1;
  const column = index % SLOT_COLUMNS;
  const row = Math.floor(index / SLOT_COLUMNS);
  return {
    x: (SLOT_ORIGIN_X + column * SLOT_WIDTH) * scale,
    y: (SLOT_ORIGIN_Y + (row + 1) * SLOT_HEIGHT) * scale,
  };
}

/** Index of the first inventory item whose name matches, or -1. */
export function findInventoryItem(player: Player, itemName: string): number {
  return player.inventory.findIndex(
    (item) => item && (item as unknown as { itemName?: string }).itemName === itemName,
  );
}

/**
 * Click an inventory item, equipping it if it is equippable.
 *
 * Returns true if a click was issued. `report` mirrors the click position on the simulated
 * cursor; it is cosmetic and never affects the outcome.
 */
export function clickInventoryItem(
  player: Player,
  index: number,
  report?: InventoryClickReporter,
): boolean {
  const controller = ControlPanelController.controller;
  const inventoryPanel = ControlPanelController.controls.INVENTORY;
  if (!controller || !inventoryPanel || index < 0 || !player.inventory[index]) {
    return false;
  }

  // Open the tab with its keybinding if it is not already showing.
  if (controller.selectedControl !== inventoryPanel) {
    controller.setActiveControl("INVENTORY");
  }

  const local = inventorySlotPosition(index);
  try {
    const panelPos = controller.controlPosition(inventoryPanel);
    report?.(panelPos.x + local.x, panelPos.y + local.y);
  } catch (e) {
    // Cursor position is cosmetic; never let it stop the equip.
  }

  // Down then up: panelClickDown only records what was pressed, panelClickUp is what queues
  // the actual inventoryLeftClick.
  inventoryPanel.panelClickDown(local.x, local.y);
  inventoryPanel.panelClickUp(local.x, local.y);
  return true;
}

/** Equip a named item from the inventory. Returns true if a click was issued. */
export function equipFromInventory(
  player: Player,
  itemName: string,
  report?: InventoryClickReporter,
): boolean {
  const index = findInventoryItem(player, itemName);
  if (index < 0) {
    return false;
  }
  return clickInventoryItem(player, index, report);
}
