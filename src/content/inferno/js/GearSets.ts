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
 * together; going back to mage has to put both back. A rune crossbow is one-handed and so
 * does neither - see `gearSetItems`, which is where the difference is absorbed.
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

export const BLOWPIPE_SET = [ItemName.TOXIC_BLOWPIPE, ...RANGE_ARMOUR];

/**
 * The heavy ranged weapon a loadout might carry, in preference order.
 *
 * Same list and same order as `InfernoLoadout.getLoadout`'s wave-67 swap, deliberately: the
 * weapon that swap puts in the player's hand for the boss waves is the one this set has to be
 * able to equip. The "tbow" set is therefore the loadout's BIG BOW, whatever that happens to
 * be - a twisted bow, a bowfa, or a rune crossbow - not the twisted bow specifically. The set
 * keeps its name because it is the name every log line, comment and caller already uses.
 */
const HEAVY_RANGED_WEAPONS: string[] = [
  ItemName.TWISTED_BOW,
  ItemName.BOWFA,
  ItemName.RUNE_CROSSBOW,
];

export type GearSetName = "mage" | "tbow" | "blowpipe";

/** An equipment item as far as this module cares: a name, and whether it eats the offhand. */
type WeaponItem = { itemName?: string; isTwoHander?: boolean } | null;

/** Worn, or in the inventory, or nothing - the two places a carried item can be. */
function carriedItem(player: Player, itemName: string): WeaponItem {
  const worn = player.equipment?.weapon as WeaponItem;
  if (worn?.itemName === itemName) {
    return worn;
  }
  const index = findInventoryItem(player, itemName);
  return index >= 0 ? (player.inventory[index] as WeaponItem) : null;
}

/**
 * The heavy ranged weapon this loadout actually carries.
 *
 * Resolved from the player rather than hardcoded so a crossbow loadout is a loadout change and
 * nothing else. A loadout carrying none of them resolves to null, and every consumer below
 * degrades the same way it always did for a loadout without a big bow: no fallback reach, and
 * a "tbow" set that is trivially already worn.
 */
export function heavyRangedWeapon(player: Player): WeaponItem {
  for (const itemName of HEAVY_RANGED_WEAPONS) {
    const item = carriedItem(player, itemName);
    if (item) {
      return item;
    }
  }
  return null;
}

/**
 * The items a set is made of, for THIS player.
 *
 * Only the "tbow" set varies, and it varies twice. The weapon is whichever heavy bow the
 * loadout carries, and a ONE-HANDED one (the rune crossbow) leaves the offhand slot free, so
 * the Crystal Shield goes back on with it - the two-handed bows knock it off by equipping at
 * all, which is the only reason the set never had to mention it.
 *
 * The shield is listed AFTER the weapon and that ordering is load-bearing: coming off the
 * blowpipe, the two-hander has to be replaced before the offhand can be filled. Anything
 * already worn is not in the inventory and is skipped, so both halves stay self-correcting.
 */
export function gearSetItems(player: Player, set: GearSetName): string[] {
  if (set === "mage") {
    return MAGE_SET;
  }
  if (set === "blowpipe") {
    return BLOWPIPE_SET;
  }
  const heavy = heavyRangedWeapon(player);
  if (!heavy?.itemName) {
    return RANGE_ARMOUR;
  }
  return heavy.isTwoHander === false
    ? [heavy.itemName, ItemName.CRYSTAL_SHIELD, ...RANGE_ARMOUR]
    : [heavy.itemName, ...RANGE_ARMOUR];
}

/**
 * The set's weapon, whether it is currently worn or still sitting in the inventory.
 *
 * This is what lets a target be priced by the weapon we WOULD use on it rather than the one in
 * hand. Asking the worn weapon makes the value of a target depend on the gear, and the gear
 * depend on which target won - a loop that oscillates rather than settling.
 */
export function weaponForSet(player: Player, set: GearSetName): unknown {
  if (set === "tbow") {
    return heavyRangedWeapon(player);
  }
  return carriedItem(player, set === "mage" ? ItemName.KODAI_WAND : ItemName.TOXIC_BLOWPIPE);
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
    case EntityNames.YT_HUR_KOT: // Jad healer - tagged with the blowpipe, one hit each
    case EntityNames.JAL_TOK_JAD: // Jad is a blowpipe job, matching the client
      return "blowpipe";
    default:
      // Rangers, magers, Zuk - anything worth the Twisted Bow's accuracy.
      return "tbow";
  }
}

/** True when every item of the set is already worn (none of them are in the inventory). */
export function isWearing(player: Player, set: GearSetName): boolean {
  return gearSetItems(player, set).every((itemName) => findInventoryItem(player, itemName) < 0);
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
  for (const itemName of gearSetItems(player, set)) {
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
