"use strict";

import { AttackStyle, EntityNames, ItemName, Location, Mob, Player, Region, Settings } from "osrs-sdk";

import { ArenaSnapshot } from "./ArenaSnapshot";
import { isAttackable } from "./AttackPlanner";
import { planOverheads } from "./OverheadPlanner";
import { GearSetName, requiredSetFor, weaponForSet } from "./GearSets";
import { expectedPillarDamage, NibblerThreat, nibblerThreats } from "./PillarDefence";
import { HORIZON_TICKS, SimMob, simulateTrajectory, snapshotMobs } from "./Trajectory";
import { visibleMobs } from "./Visibility";

/**
 * What to attack, scored rather than ranked.
 *
 * A fixed priority list cannot express the thing that actually decides this. Killing a bat does
 * not just remove the bat's damage - it removes every COLLISION the bat was part of, and a
 * collision is worth more than either mob in it, because a collision is the only damage prayer
 * cannot answer. So a bat can be worth more than a mager while being worth far less on paper.
 * That value is not a property of the bat; it is a property of the bat plus everything else.
 *
 * So each candidate is priced by simulating the fight without it:
 *
 *     value = (damage prevented by its absence + health removed) / ticks it takes to kill
 *
 * Both halves are needed. Damage prevented alone goes to zero across the board whenever prayer
 * is covering everything, which is most of a well-played wave - and then the ordering is noise.
 * Health removed is the progress term: killing things is how a wave ends, and an unkilled wave
 * keeps hurting.
 *
 * The rest falls out. A mob that cannot currently reach us prevents nothing and ranks on
 * progress alone. Nibblers rise because pillar damage is in the damage model and they die in one
 * hit. Nothing needs a rule.
 *
 * Three things do NOT fall out, because the horizon cannot see them, and they are constants
 * here rather than being hidden in the arithmetic.
 */

/**
 * A dead blob is replaced by three bloblets, so killing one is not pure gain.
 *
 * JalAk.removedFromWorld spawns JalAkRekXil, JalAkRekKet and JalAkRekMej. Rather than a penalty
 * guessed at, they are handed to the simulation, so "kill blobs last" is computed - and correctly
 * says "kill it anyway" when the bloblets are the cheaper problem.
 *
 * Every field below is read off the mob classes rather than inherited from the blob, which is
 * what the first version did and got wrong in four ways at once: they are size 1 rather than the
 * blob's 3, they hit 18 rather than 15, they spawn on three different tiles rather than stacked
 * on the corner, and - most importantly - each throws a FIXED style. Modelling all three as the
 * blob's magic-or-range coin flip made every one of them half-unprayable and hid the melee one
 * entirely, so the cost of popping a blob was simultaneously overstated and mis-shaped.
 *
 * Offsets and the four tick cooldown are exactly what removedFromWorld passes.
 */
const BLOBLET_MAX_HIT = 18;
const BLOBLET_ATTACK_SPEED = 4;
const BLOBLET_SPAWN_COOLDOWN = 4;
const BLOBLET_SPAWNS = [
  /** JalAkRekXil, at location + (1, -1). */
  { dx: 1, dy: -1, style: "range", range: 15 },
  /** JalAkRekKet, on the blob's own corner. Melee, so range 1. */
  { dx: 0, dy: 0, style: "crush", range: 1 },
  /** JalAkRekMej, at location + (2, -2). */
  { dx: 2, dy: -2, style: "magic", range: 15 },
];

/**
 * Extra value for killing a mager, in damage.
 *
 * JalZek rolls Random.get() < 0.1 on each attack and, when it hits, revives a dead mob at half
 * health instead of attacking. That undoes work already done, and it pays out over the whole
 * wave rather than the twelve ticks the simulation can see - so a horizon-bounded model always
 * under-prices killing magers, no matter how good it gets.
 */
export const MAGER_REVIVE_VALUE = 40;

/**
 * Cost of a meleer completing its dig, in damage.
 *
 * JalImKot.endDig calls player.interruptCombat(), which cancels whatever we were attacking and
 * drops the target. That is lost ticks rather than lost health, so a damage-only score is blind
 * to it, but the tick it wastes is real.
 */
export const DIG_INTERRUPT_COST = 15;

/**
 * What a point of a mob's health is worth as progress, against a point of damage prevented.
 *
 * Without this the score is purely "damage this stops", and on a wave that is being prayed well
 * that number is ZERO for everything - protection blocks a whole style, so a lone attacker of
 * any size prevents nothing by dying. Every target then ties at zero and the pick is whatever
 * happens to come first in the mob list.
 *
 * Measured, that is what happened to bloblets. Fifteen hitpoints, one style each, always
 * prayable, so they prevented nothing and were never chosen while anything else was alive.
 *
 * But killing things is how a wave ENDS, and an unkilled wave keeps hurting. So health removed
 * counts as progress in its own right, and dividing the total by ticks-to-kill turns the whole
 * thing into a rate: a 15 hitpoint bloblet dying in a couple of attacks competes properly with
 * a 220 hitpoint mager that takes fifty ticks.
 */
export const PROGRESS_WEIGHT = 1;

/**
 * Base damage of a barrage, which is the only kind of spell this bot ever casts.
 *
 * BarrageSpell.cast hands the engine `{ magicBaseSpellDamage: 30, attackStyle: "magic" }` and
 * MagicWeapon._baseSpellDamage reads that field and nothing else. Omitting it does not give a
 * slightly wrong max hit - it gives NaN, NaN fails the `perAttack > 0` guard, and every target
 * we would have barraged came back unkillable and scored zero. So while a spell was loaded,
 * which is the whole of the downtime and the opening of every wave, the target scorer had no
 * opinion about anything at all.
 */
const BARRAGE_BASE_DAMAGE = 30;

/**
 * The thing that will actually do the damage to THIS mob.
 *
 * Deliberately the weapon of the mob's own gear set, not the one currently in hand. Pricing a
 * target with the worn weapon makes the score depend on the gear, while the gear is chosen from
 * the score - a loop with no fixed point, and measured it did exactly what that predicts:
 * holding the bow the meleer won and asked for the blowpipe; holding the blowpipe the ranger
 * won and asked for the bow; and so on for the whole wave, one switch per tick, never attacking.
 * Scoring against the weapon we WOULD use breaks the loop at its source, because the ranking
 * then does not move when the gear does.
 *
 * Three cases otherwise, matching Player.attack() and KodaiWand.attack():
 *
 *   - a manually selected spell is cast at whatever we click next and the weapon is untouched,
 *     so it wins outright;
 *   - a weapon set to AUTOCAST delegates to its own `autocastSpell` - the Kodai Wand casts Blood
 *     Barrage rather than swinging. Missing this mattered: a wand's melee `_hitChance` comes back
 *     NaN, so with the mage set every target looked unkillable;
 *   - otherwise the weapon itself.
 */
function attackingWeapon(player: Player, mob: Mob): unknown {
  if (player.manualSpellCastSelection) {
    return player.manualSpellCastSelection;
  }

  // Falls back to what is worn only if the set's weapon is nowhere to be found - it was dropped,
  // or the loadout does not carry it.
  const weapon = (weaponForSet(player, requiredSetFor(mob)) ?? player.equipment?.weapon ?? null) as
    | { autocastSpell?: unknown; attackStyle?: () => string; defaultStyle?: () => string }
    | null;

  if (weapon?.autocastSpell) {
    // An unequipped weapon may not be registered with AttackStylesController yet, so fall back to
    // the style it would take on being equipped.
    const style = weapon.attackStyle?.() ?? weapon.defaultStyle?.();
    if (style === AttackStyle.AUTOCAST) {
      return weapon.autocastSpell;
    }
  }
  return weapon;
}

/**
 * Attack bonuses built exactly as Weapon.attack() builds them.
 *
 * Copying only the Slayer helmet part from Player.attack() was not enough and threw outright:
 * Weapon.attack fills in the multipliers AND calls _calculatePrayerEffects before rolling, and
 * MagicWeapon._defenceRoll then reads `bonuses.effectivePrayers.defence`. With that missing the
 * whole scorer raised "cannot read properties of undefined" - which, because scoring now runs
 * before prayer, took prayer down with it and the bot did nothing at all.
 */
function attackBonuses(player: Player, weapon: unknown, mob: Mob): Record<string, unknown> {
  const bonuses: Record<string, unknown> = {};

  const helmet = player.equipment?.helmet;
  if (helmet && helmet.itemName === ItemName.SLAYER_HELMET_I) {
    bonuses.gearMeleeMultiplier = 7 / 6;
    bonuses.gearRangeMultiplier = 1.15;
    bonuses.gearMageMultiplier = 1.15;
  }

  const w = weapon as { _calculatePrayerEffects?: (f: Player, t: Mob, b: unknown) => void };
  w._calculatePrayerEffects?.(player, mob, bonuses);

  bonuses.styleBonus = bonuses.styleBonus ?? 0;
  bonuses.voidMultiplier = bonuses.voidMultiplier ?? 1;
  bonuses.gearMeleeMultiplier = bonuses.gearMeleeMultiplier ?? 1;
  bonuses.gearMageMultiplier = bonuses.gearMageMultiplier ?? 1;
  bonuses.gearRangeMultiplier = bonuses.gearRangeMultiplier ?? 1;
  bonuses.overallMultiplier = bonuses.overallMultiplier ?? 1;
  // Only MagicWeapon._baseSpellDamage reads this, so setting it unconditionally is invisible to
  // every other weapon type.
  bonuses.magicBaseSpellDamage = bonuses.magicBaseSpellDamage ?? BARRAGE_BASE_DAMAGE;

  return bonuses;
}

/**
 * What our attacks are worth against this mob, per attack and how often.
 *
 * Uses the weapon's own `_hitChance` and `_maxHit`, which are pure - only `_rollDamage` and
 * `_calculateHitDamage` touch Random.get(). So this consumes no RNG and cannot alter the fight.
 *
 * Expected damage per attack is `hitChance x maxHit / 2`, because a hit rolls uniformly over
 * 0..maxHit while a miss is zero.
 *
 * Wrapped defensively on purpose. These are internal engine methods with assumptions this code
 * does not fully own, and a throw here is not a wrong number - it is the whole automation
 * stopping dead, prayer included. An unkillable-looking target is a far cheaper failure.
 */
function attackProfile(player: Player, mob: Mob): { perAttack: number; speed: number } | null {
  const weapon = attackingWeapon(player, mob) as {
    _hitChance?: (from: Player, to: Mob, b: unknown) => number;
    _maxHit?: (from: Player, to: Mob, b: unknown) => number;
    attackSpeed?: number;
  } | null;
  if (!weapon?._hitChance || !weapon._maxHit) {
    return null;
  }

  try {
    const bonuses = attackBonuses(player, weapon, mob);
    const hitChance = weapon._hitChance(player, mob, bonuses);
    const maxHit = weapon._maxHit(player, mob, bonuses);
    const perAttack = hitChance * (maxHit / 2);
    if (!(perAttack > 0)) {
      return null;
    }
    return { perAttack, speed: Math.max(1, weapon.attackSpeed ?? 1) };
  } catch (e) {
    return null;
  }
}

/**
 * Sustained damage we deal to this mob, per tick.
 *
 * Split out from `ticksToKill` because the two are NOT the same question and one was standing in
 * for the other. `hitpoints / ticksToKill` looks like a rate and is not: the ceil in the attack
 * count means a 15 hitpoint bloblet we one-shot reports 15/4 rather than the ~20 per attack we
 * would really land, so anything small read as slow purely because it dies early.
 *
 * This is the rate; `ticksToKill` is the duration. Ask for whichever one you actually mean.
 */
export function damagePerTick(player: Player, mob: Mob): number {
  const profile = attackProfile(player, mob);
  return profile ? profile.perAttack / profile.speed : 0;
}

/**
 * Ticks of attacking this mob costs us.
 *
 * Rounded up to a whole number of attacks and charged at the weapon's full speed, including for
 * the last one: killing something on the first swing still spends the whole cooldown before the
 * next target can be engaged, so the attack is the unit of cost, not the tick the hit lands on.
 */
export function ticksToKill(player: Player, mob: Mob): number {
  const profile = attackProfile(player, mob);
  if (!profile) {
    return Infinity;
  }
  const hitpoints = mob.currentStats?.hitpoint ?? mob.stats?.hitpoint ?? 0;
  return Math.max(1, Math.ceil(hitpoints / profile.perAttack) * profile.speed);
}

/**
 * The three bloblets a dying blob leaves behind, as the simulation sees them.
 *
 * `blob` is the entry being removed, so its own position and stun state carry over - which is
 * what keeps the spawn tiles honest without inventing a mob from nothing.
 */
export function blobletsFrom(blob: SimMob): SimMob[] {
  return BLOBLET_SPAWNS.map((spawn) => ({
    ...blob,
    x: blob.x + spawn.dx,
    y: blob.y + spawn.dy,
    size: 1,
    range: spawn.range,
    style: spawn.style,
    maxHit: BLOBLET_MAX_HIT,
    speed: BLOBLET_ATTACK_SPEED,
    delay: BLOBLET_SPAWN_COOLDOWN,
    isBlob: false,
    pendingScan: false,
    lastScanTick: -1,
    hadLOS: false,
    // Only JalAk sets a spawn stun, and a frozen blob does not hand its freeze on. The bloblets
    // are live immediately.
    stunned: 0,
    frozen: 0,
    // None of the three define canMeleeIfClose, unlike the blob they came out of - so each one
    // throws its single style and stays prayable even standing next to us.
    meleeIfClose: null,
    canDig: false,
    digTicks: 0,
  }));
}

/** Total expected damage over the horizon, ours plus the pillars', for a given mob set. */
function damageWith(
  snapshot: ArenaSnapshot,
  route: Location[],
  allMobs: SimMob[],
  allThreats: NibblerThreat[],
  excluded: Mob | null,
  spawnsBloblets: boolean,
): number {
  // Mobs are matched by their corner tile. Footprints cannot overlap - snapshotMobs keeps only
  // entries with consumesSpace - so no two of them share one.
  const at = (x: number, y: number) =>
    !!excluded && x === excluded.location.x && y === excluded.location.y;

  const mobs: SimMob[] = [];
  let removed: SimMob | null = null;
  for (const mob of allMobs) {
    if (at(mob.x, mob.y)) {
      removed = mob;
      continue;
    }
    mobs.push(mob);
  }

  if (removed && spawnsBloblets) {
    mobs.push(...blobletsFrom(removed));
  }

  const ours = planOverheads(simulateTrajectory(snapshot, mobs, route)).damage;

  const threats = allThreats.filter((threat) => !at(threat.x, threat.y));
  const destination = route[route.length - 1];
  const pillars = expectedPillarDamage(
    snapshot,
    threats,
    destination.x,
    destination.y,
    HORIZON_TICKS,
  );

  return ours + pillars;
}

/**
 * Range used to decide what counts as a candidate.
 *
 * Deliberately the LONGEST reach we can equip - Twisted Bow and Ice Barrage both reach 10 -
 * rather than the range of whatever is in hand. Judging candidacy by the current weapon is
 * circular and deadlocks: holding a blowpipe (range 5) nothing further out is a candidate, so
 * nothing is ever intended, so the gear layer is never told to switch to the bow that would
 * have reached it, so the bot stands still next to a mob it could have shot.
 *
 * Anything picked beyond the current weapon's reach simply costs a tick while the gear layer
 * switches, and becomes genuinely attackable the tick after.
 */
export const MAX_EQUIPPABLE_RANGE = 10;

/**
 * How far we could actually hit this mob from where we stand.
 *
 * The reach of the weapon its own gear set uses - which is NOT the same as the longest range we
 * can equip, and the gap between those two was a hard stall. Candidacy was judged at 10 while
 * `applyAttackPlan` re-tested at `player.attackRange`, so a bloblet at 8 tiles was selected
 * (it needs the blowpipe), cost a tick to switch to the blowpipe, and was then dropped because
 * the blowpipe only reaches 5. Aggro cleared, target nulled, and the next tick did the same
 * thing. Measured, the bot sat on one tile repeating that forever.
 *
 * Reading the required set rather than the worn weapon keeps this free of the circularity the
 * blanket 10 was there to avoid: `requiredSetFor` does not depend on what we happen to hold, so
 * nothing deadlocks and the gear layer is still told to switch.
 */
export function attackReachFor(player: Player, mob: Mob): number {
  const weapon = attackingWeapon(player, mob) as { attackRange?: number } | null;
  return weapon?.attackRange ?? 1;
}

/**
 * The same answer for a mob we only have the NAME of - a ghost bloblet, which has no Mob in the
 * region to point at yet.
 *
 * A name really is all this needs: the reach comes from `requiredSetFor`, and that reads nothing
 * but `mobName()`. Deliberately routed through `attackReachFor` rather than reimplemented, so
 * the two can never drift into disagreeing about the same mob.
 */
export function attackReachForName(player: Player, mobName: string): number {
  return attackReachFor(player, { mobName: () => mobName } as unknown as Mob);
}

/**
 * The gear to attack this mob with FROM WHERE THE PLAYER STANDS, or null when nothing
 * permitted reaches it.
 *
 * Normally the mob's own required set. The fallback: when that set's weapon cannot reach - a
 * bloblet at 8 tiles wants the blowpipe's 5 - a longer bow that CAN reach is better than
 * standing there doing nothing, which is what the bot measurably did (the recurring
 * "no target" standoffs, blowpipe mobs parked just outside blowpipe range).
 *
 * The set and its range are decided TOGETHER and callers must use both halves. History:
 * candidacy judged at one range while `applyAttackPlan` re-tested at another was a hard
 * stall - target picked at 10, a tick spent switching, dropped at 5, forever. Everything
 * downstream of this function (canReach, the gear switch in decide()) reads the same answer,
 * so that split cannot reopen.
 *
 * PURES NEVER FALL BACK, by design: on the pure loadout the answer is the required set or
 * nothing. The fallback also only ever reaches for the "tbow" set's weapon as the loadout
 * actually carries it (`weaponForSet`), so a loadout without a big bow simply has no fallback
 * rather than a pretend one.
 */
export function attackOptionFor(
  region: Region,
  player: Player,
  mob: Mob,
): { set: GearSetName; range: number } | null {
  const preferredRange = attackReachFor(player, mob);
  if (isAttackable(region, player, mob, preferredRange)) {
    return { set: requiredSetFor(mob), range: preferredRange };
  }

  if (Settings.loadout === "pure") {
    return null;
  }

  // A HEALER IS A BLOWPIPE JOB OR NOTHING. The tag is one hit, and the fallback below would
  // answer with the heavy bow whenever the blowpipe cannot reach - so a healer at 6 or 7 tiles
  // was picked, the bot switched to the crossbow, and tagged it with that instead. The set and
  // the range are decided together here, so refusing the fallback for healers is what makes
  // "blowpipe only" true at the pick, the gear switch and the click alike.
  if (mob.mobName() === EntityNames.YT_HUR_KOT) {
    return null;
  }

  const bow = weaponForSet(player, "tbow") as { attackRange?: number } | null;
  const bowRange = bow?.attackRange ?? 0;
  if (bowRange > preferredRange && isAttackable(region, player, mob, bowRange)) {
    return { set: "tbow", range: bowRange };
  }
  return null;
}

export interface ScoredTarget {
  mob: Mob;
  value: number;
  prevented: number;
  ticks: number;
}

/**
 * Price every attackable mob by what killing it prevents, per tick spent killing it.
 *
 * Restricted to what is attackable from where we stand, because the bot never chases - movement
 * belongs to the tile scorer, and setting aggro on something out of reach walks the player
 * across the arena.
 */
export function scoreTargets(
  region: Region,
  player: Player,
  snapshot: ArenaSnapshot,
  route: Location[],
  range?: number,
): ScoredTarget[] {
  // Built once for the whole pass. Both of these are region-wide scans, and pricing a target
  // needs the same two lists every time - only the one entry being removed differs. Rebuilding
  // them inside the loop meant three scans per candidate mob for answers that could not change.
  const allMobs = snapshotMobs(region, player);
  const allThreats = nibblerThreats(region);

  const baseline = damageWith(snapshot, route, allMobs, allThreats, null, false);
  const scored: ScoredTarget[] = [];

  for (const mob of visibleMobs(region)) {
    // Per mob, because reach is a property of the weapon we would use on it. `range` overrides
    // for callers that want a fixed one.
    if (mob.dying > -1 || !isAttackable(region, player, mob, range ?? attackReachFor(player, mob))) {
      continue;
    }

    const isBlob = mob.mobName() === EntityNames.JAL_AK;
    const without = damageWith(
      snapshot,
      route,
      allMobs,
      allThreats,
      mob,
      isBlob,
    );

    let prevented = baseline - without;
    if (mob.mobName() === EntityNames.JAL_ZEK) {
      prevented += MAGER_REVIVE_VALUE;
    }
    if (mob.mobName() === EntityNames.JAL_IM_KOT) {
      const digging = ((mob as unknown as { digSequenceTime?: number }).digSequenceTime ?? 0) > 0;
      if (digging) {
        prevented += DIG_INTERRUPT_COST;
      }
    }

    const ticks = ticksToKill(player, mob);
    const hitpoints = mob.currentStats?.hitpoint ?? 0;
    const value = (prevented + hitpoints * PROGRESS_WEIGHT) / ticks;
    scored.push({ mob, value, prevented, ticks });
  }

  return scored.sort((a, b) => b.value - a.value);
}

/**
 * How much better a new target must be before we abandon the current one.
 *
 * Switching is not free: a different target can want a different gear set, and mage to range is
 * four or five clicks. Without a margin, two mobs of near-equal value trade places every tick as
 * their health ticks down, and the bot spends the wave changing clothes.
 *
 * A fraction of the held target's MAGNITUDE, not of its signed value. Scaling by the signed value
 * inverts the whole thing the moment the held score goes negative - which it does whenever
 * killing something makes matters worse in the short term, popping a blob being the obvious case.
 * A -2 held target then demanded the challenger beat -2.3, a bar every challenger clears, so the
 * margin stopped existing at exactly the moment it was protecting a deliberate choice.
 */
export const SWITCH_MARGIN = 0.15;

/**
 * Is the target we already have still good enough to keep?
 *
 * Named rather than inlined because it is the whole switching policy, and an inline comparison
 * on signed values is exactly where it went wrong once already.
 */
export function shouldKeepTarget(heldValue: number, bestValue: number): boolean {
  return bestValue <= heldValue + Math.abs(heldValue) * SWITCH_MARGIN;
}

export function chooseTarget(
  region: Region,
  player: Player,
  snapshot: ArenaSnapshot,
  route: Location[],
  current: Mob | null,
  range?: number,
): Mob | null {
  const scored = scoreTargets(region, player, snapshot, route, range);
  if (scored.length === 0) {
    return null;
  }

  const best = scored[0];
  const held = current ? scored.find((entry) => entry.mob === current) : undefined;
  if (held && shouldKeepTarget(held.value, best.value)) {
    return held.mob;
  }
  return best.mob;
}
