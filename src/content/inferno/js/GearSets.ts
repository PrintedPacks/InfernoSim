"use strict";

import { EntityNames, ItemName, Mob, Player } from "osrs-sdk";

import { clickInventoryItem, findInventoryItem, InventoryClickReporter } from "./GearSwitcher";

/**
 * Which gear the bot should be wearing for a given target, and how to get into it.
 *
 * A set is just a list of item names. Switching means clicking each item in the set that is
 * currently sitting in the inventory - anything already worn is not in the inventory, so it
 * is skipped automatically and the set is self-correcting.
 *
 * The cost of a switch is very uneven, which matters for strategy:
 *
 *   Tbow <-> Blowpipe   1 click   (they share all the armour)
 *   range <-> mage      4-5 clicks
 *
 * Both bows are two-handed, so equipping one removes the Kodai Wand and the Crystal Shield
 * together; going back to mage has to put both back.
 */

// Use ItemName rather than string literals. Hand-written names silently do not match -
// "Ancestral Robetop" vs the real "Ancestral Robe top", and "Occult Necklace" vs
// "Occult necklace" - and a name that matches nothing is simply never found in the
// inventory, so the piece is skipped without any error.
export const MAGE_SET = [
  ItemName.KODAI_WAND,
  ItemName.CRYSTAL_SHIELD,
  ItemName.ANCESTRAL_ROBETOP,
  ItemName.ANCESTRAL_ROBEBOTTOM,
  ItemName.OCCULT_NECKLACE,
];

const RANGE_ARMOUR = [
  ItemName.MASORI_BODY_F,
  ItemName.MASORI_CHAPS_F,
  ItemName.NECKLACE_OF_ANGUISH,
];

export const TBOW_SET = [ItemName.TWISTED_BOW, ...RANGE_ARMOUR];
export const BLOWPIPE_SET = [ItemName.TOXIC_BLOWPIPE, ...RANGE_ARMOUR];

export type GearSetName = "mage" | "tbow" | "blowpipe";

export const GEAR_SETS: Record<GearSetName, string[]> = {
  mage: MAGE_SET,
  tbow: TBOW_SET,
  blowpipe: BLOWPIPE_SET,
};

/**
 * The weapon each set fights with.
 *
 * Named rather than taken as "the first entry of the set", so the ordering of those arrays stays
 * a presentational detail instead of load-bearing.
 */
export const WEAPON_FOR_SET: Record<GearSetName, string> = {
  mage: ItemName.KODAI_WAND,
  tbow: ItemName.TWISTED_BOW,
  blowpipe: ItemName.TOXIC_BLOWPIPE,
};

/**
 * The set's weapon, whether it is currently worn or still sitting in the inventory.
 *
 * This is what lets a target be priced by the weapon we WOULD use on it rather than the one in
 * hand. Asking the worn weapon makes the value of a target depend on the gear, and the gear
 * depend on which target won - a loop that oscillates rather than settling.
 */
export function weaponForSet(player: Player, set: GearSetName): unknown {
  const itemName = WEAPON_FOR_SET[set];
  const worn = player.equipment?.weapon as { itemName?: string } | null | undefined;
  if (worn?.itemName === itemName) {
    return worn;
  }
  const index = findInventoryItem(player, itemName);
  return index >= 0 ? player.inventory[index] : null;
}

/**
 * The set to kill this mob with.
 *
 * Blood barrage and the bloblet-stacking case are deliberately not modelled yet - those are
 * situational rather than per-target, and belong with the strategy layer.
 */
export function requiredSetFor(mob: Mob): GearSetName {
  switch (mob.mobName()) {
    case EntityNames.JAL_NIB:
      return "mage"; // barrage the nibblers
    // Bats, blobs and meleers, plus the three bloblets a blob leaves behind. The bloblets have
    // 15 hitpoints and arrive in a clump, so the Twisted Bow's accuracy buys nothing and its
    // speed 5 wastes the window - the blowpipe kills them faster. Stacking them for a single
    // barrage first is a separate decision and belongs with the strategy layer, not here.
    case EntityNames.JAL_MEJ_RAJ: // bat (the SDK spells it RAJ)
    case EntityNames.JAL_AK: // blob
    case EntityNames.JAL_IM_KOT: // meleer
    case EntityNames.JAL_AK_REK_KET: // melee bloblet
    case EntityNames.JAL_AK_REK_MEJ: // magic bloblet
    case EntityNames.JAL_AK_REK_XIL: // ranged bloblet
      return "blowpipe";
    default:
      // Rangers, magers, Jad, Zuk - anything worth the Twisted Bow's accuracy.
      return "tbow";
  }
}

/** True when every item of the set is already worn (none of them are in the inventory). */
export function isWearing(player: Player, set: GearSetName): boolean {
  return GEAR_SETS[set].every((itemName) => findInventoryItem(player, itemName) < 0);
}

/**
 * Click every piece of the set that is not already worn.
 *
 * All in one tick, which is what a switch actually is - a player rattles through four or five
 * slots inside the 600ms. Returns the item names clicked.
 *
 * Each click is re-resolved against the inventory as it goes, because equipping a two-handed
 * bow displaces the wand and shield and shuffles positions underneath us.
 */
export function equipSet(
  player: Player,
  set: GearSetName,
  report?: InventoryClickReporter,
): string[] {
  const clicked: string[] = [];
  for (const itemName of GEAR_SETS[set]) {
    const index = findInventoryItem(player, itemName);
    if (index < 0) {
      continue; // already worn
    }
    if (clickInventoryItem(player, index, report)) {
      clicked.push(itemName);
    }
  }
  return clicked;
}
