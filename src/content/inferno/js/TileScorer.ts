"use strict";

import { EntityNames, Location, Mob, Player, Region } from "osrs-sdk";

import { ArenaSnapshot, snapshotPlayerCanSeeMob } from "./ArenaSnapshot";
import { weaponForSet } from "./GearSets";
import { planOverheads } from "./OverheadPlanner";
import { BARRAGE_RANGE, nibblerAt, NibblerThreat, nibblerThreats } from "./PillarDefence";
import { attackReachFor, attackReachForName } from "./TargetPlanner";
import {
  mobSeesPlayer,
  PLAYER_TILES_PER_TICK,
  playerIsUnder,
  routeKey,
  routesFrom,
  SimMob,
  simulateTrajectory,
  snapshotMobs,
  withinMeleeRange,
} from "./Trajectory";
import { PlayerAttackClock } from "./PlayerAttackClock";
import { visibleMobs } from "./Visibility";
import { ZukAttackClock } from "./ZukAttackClock";
import { ZukSetTimer } from "./ZukSetTimer";

/**
 * Where the bot should be standing.
 *
 * This owns two things that must never disagree: the set of tiles worth considering, and the
 * number attached to each one. The debug grid draws the exact same list this chooses from, so
 * what you see on screen is the decision's real input rather than a reconstruction of it.
 *
 * WAVE 69 USES NONE OF IT. That wave is being rebuilt from the ground up and gets
 * `scoreZukTiles` instead - one term, the shield - reached by an early return in
 * `scoreCandidates`. Everything below describes waves 1 to 68.
 *
 * The terms, in hitpoints over a twelve tick horizon except where noted:
 *
 *     score = barrageReach + blobletReach + healerReach + npcReachSoon + quietTicks + losBonus
 *             + safeSpot + homePull - damageTaken
 *
 * `quietTicks` applies ONLY to tiles `safeSpot` has already accepted, and is zero everywhere
 * else - the loud version of that bonus. On a safespot it is QUIET_TICK_BONUS per tick of the
 * count in `quietTicksFor`, which since nothing can see such a tile comes down to how much of
 * the twelve tick window the walk there leaves behind.
 *
 * `healerReach` is 1 if the nearest still-healing Jad healer can be tagged from this tile -
 * the Jad-wave analogue of `barrageReach`, pulling the bot around Jad to where a blowpipe
 * reaches the healers. `losBonus` divides a point by how many attackers get to shoot back
 * from here, so of two tiles offering the same fight the quieter one wins.
 *
 * scored over the candidates that survive a filter: a tile is only a candidate at all if it is
 * inside the arena, walkable, reachable, and the walk to it does not enter the coin-flip melee
 * zone - see `routeEntersForbiddenZone`.
 *
 * `barrageReach` is BARRAGE_REACH_BONUS if a barrage thrown from this tile reaches the nibbler
 * that matters - not where it stands now, but where it will be standing on the tick the shot can
 * actually be taken: the later of arriving here and the weapon coming off cooldown, plus a step
 * of lead. See `barrageReach`, which is the only term in this file that simulates its target.
 *
 * `blobletReach` is BLOBLET_REACH_BONUS if a barrage from this tile reaches ANY bloblet - the
 * same shape as `barrageReach` with the focus pick dropped, since the three land together and
 * one blast is meant for all of them. Note it deliberately overlaps `npcReachSoon`, which
 * already scores a bloblet as something reachable: the point of the term is not to discover
 * the bloblets but to rank a tile facing them ABOVE a tile facing anything else.
 *
 * `npcReachSoon` prices the fight this tile makes available: NPC_REACH_BONUS for the mager or
 * a bloblet, NPC_REACH_LESSER_BONUS for anything else worth shooting, BLOB_REACH_BONUS when a
 * blob is the only thing in reach - the best of what is reachable, not the first found. A fight is available when the tile is close enough to be
 * standing on within NPC_REACH_ARRIVAL_TICKS, and standing there the engine would let a shot off at some mob
 * WHERE IT REALLY STANDS - `snapshotPlayerCanSeeMob` at the mobs' tick-0 positions, the same test
 * `isAttackable` makes, at the range of the weapon that mob's own gear set carries.
 *
 * Two things make that honest, and both were bugs first. The tile has to be one the walk can
 * DELIVER us to inside the window - otherwise a route long enough to still be near its own
 * starting point after two ticks banks a reach point for a destination twelve tiles from anything.
 * And the mobs have to be where they ACTUALLY are, not where the trajectory simulation steps them:
 * an earlier version judged reach against projected positions, and a bat jammed against a pillar
 * corner - blocked on both axes, never moving in reality - was projected one tile into view, so
 * the bot camped a tile scored reach 1, clicking attack at a mob the engine refused to fire at,
 * until its prayer ran out. Reach that cannot be cashed on the tick it is claimed is not reach.
 *
 * `safeSpot` is up to SAFE_SPOT_BONUS when the move ends on a TRUE safespot. Three parts. The
 * walk is clean: the twelve tick simulation's planned overheads stop everything that fires en
 * route (`damageTaken === 0`) - the journey is deliberately NOT part of the safety claim,
 * because getting shot at on the way to cover is what `damageTaken` prices, and demanding a
 * fire-free trajectory meant that under any incoming fire NO tile could earn the bonus, the grid
 * went flat, and the bot stood mid-arena flicking prayer until it died of it. The destination is
 * unexposed for the horizon: from arrival to tick twelve no attacking mob has it within line of
 * sight and range - judged geometrically against the PROJECTED positions, not by whether a shot
 * happened to fire, because a mob mid-cooldown fires nothing while holding the tile at gunpoint.
 * And the destination SETTLES: the simulation is extended with the player parked until the board
 * reaches a fixed point, with the tile still unseen the whole way - see `settlesSafe`. Twelve
 * quiet ticks are not safety: a mob thirteen ticks away passed the old test, so a tile that was
 * merely FAR earned the same bonus as one behind a pillar forever, and "far" is what the
 * distance penalty is for, not the bonus. No attackers on the board means no bonus - with
 * nothing to be safe from the term is 0, not a free 0.8, which also keeps the empty-arena
 * hold-position score at an honest zero. Among safe tiles it is shaded down by
 * NPC_DISTANCE_PENALTY per tile of Chebyshev distance to the NEAREST live mob - a pure
 * tie-breaker, since `damageTaken` cannot tell two safe tiles apart, and the closer one is the
 * tile the bot can actually do something from once it stops being safe - floored at
 * SAFE_SPOT_MIN (0.1) so a safe tile far from everything still beats an unsafe one. Deliberately
 * a small fraction throughout, never a full point - it exists to break ties `damageTaken` already
 * scores identically, not to compete with real damage avoided.
 *
 * `damageTaken` is the real one. Every candidate gets its own twelve tick simulation of the walk
 * to it - mobs stepping or parking as they gain line of sight, attack delays counting down and
 * firing, meleers digging - and then the best possible prayer sequence is planned against what
 * comes out. What is left is the damage prayer cannot stop. That is 441 simulations a tick, and
 * it is the reason the mob snapshot and the routes are built once and shared.
 *
 * The coin-flip melee zone - under or melee-adjacent to a mager, ranger, blob or Jad, the mobs
 * whose ranged attack becomes a magic-or-stab flip up close - is not a term at all any more. It
 * used to be a -1000 on the DESTINATION, which vetoed ending there while leaving the journey
 * merely expensive: `damageTaken` charges a flip at the average of its two outcomes, and a
 * route clipping the zone for one tick could be outweighed by anything else on the board. A
 * 50/50 cannot be prayed, so pricing it at its mean is the one treatment that makes no sense.
 * Now the whole route is judged and a walk that enters the zone removes the tile from the
 * candidate set outright - see `routeEntersForbiddenZone`, which also covers why walking OUT of
 * the zone has to stay allowed.
 *
 * Note the remaining terms are not on the same scale: reach is 0 or 1, safeSpot is 0 or
 * 0.1-0.8, damage runs to tens. Damage therefore decides nearly every comparison and the other
 * terms only break ties between equally safe tiles. That is a real consequence, not a hidden
 * one - if reach should outrank safety it needs a weight, and that weight belongs here as a
 * named number rather than buried in the arithmetic.
 */

/**
 * Must be odd, so the player stands on the exact centre tile whenever the grid is not being
 * pushed off-centre by a wall. 21x21 = 441 candidates.
 *
 * The arena interior is 29x30, so a 21x21 box always fits inside it somewhere. That is what
 * makes sliding viable: the count stays at its full 441 no matter where the player stands,
 * and the bot never has fewest options at the exact moment it is most cornered.
 */
export const GRID_SIZE = 21;
const RADIUS = (GRID_SIZE - 1) / 2;

/**
 * The walkable interior of the arena, inclusive: SW corner 11,43 and NE corner 39,14.
 * (y increases southward in this engine, so the NE corner has the smaller y.)
 *
 * This has to be checked separately from walkability. The arena is fenced by a ring of
 * InvisibleMovementBlocker entities at y=13, y=44, x=10 and x=40, and that ring is one tile
 * thick - so the wall itself collides correctly, but the empty space beyond it contains no
 * entities at all and `canTileBePathedTo` happily reports it as walkable. The region is
 * 51x57, so without this the candidates would spill well past the arena onto tiles the player
 * can never reach.
 */
export const ARENA_BOUNDS = { minX: 11, maxX: 39, minY: 14, maxY: 43 };

export function isInsideArena(x: number, y: number): boolean {
  return (
    x >= ARENA_BOUNDS.minX &&
    x <= ARENA_BOUNDS.maxX &&
    y >= ARENA_BOUNDS.minY &&
    y <= ARENA_BOUNDS.maxY
  );
}

/**
 * South-west corner of the candidate box: centred on the player, then slid back inside the
 * arena.
 *
 * Without the slide the box keeps its centre and simply loses whatever hangs over the wall,
 * so the candidate set collapses precisely when the player is cornered and needs the most
 * options. Sliding trades the player's centring - which is cosmetic - for a candidate count
 * that never drops.
 *
 * The clamp is written so that a GRID_SIZE larger than the arena degrades to "start at the
 * wall and overflow" rather than inverting.
 */
function gridOrigin(player: Player): { originX: number; originY: number } {
  const maxOriginX = ARENA_BOUNDS.maxX - (GRID_SIZE - 1);
  const maxOriginY = ARENA_BOUNDS.maxY - (GRID_SIZE - 1);
  return {
    originX: Math.max(ARENA_BOUNDS.minX, Math.min(player.location.x - RADIUS, maxOriginX)),
    originY: Math.max(ARENA_BOUNDS.minY, Math.min(player.location.y - RADIUS, maxOriginY)),
  };
}

/**
 * Every tile the bot is allowed to consider standing on this tick.
 *
 * No mobToAvoid is passed to canTileBePathedTo: it only tests against mobs when it is given
 * one, which matches the player, since players walk under mobs. So this is walls and pillars
 * only - and because pillars are entities, the set opens up on its own as they are destroyed.
 */
export function candidateTiles(
  region: Region,
  player: Player,
  snapshot: ArenaSnapshot = new ArenaSnapshot(region),
): Location[] {
  const { originX, originY } = gridOrigin(player);
  const tiles: Location[] = [];

  for (let row = 0; row < GRID_SIZE; row++) {
    for (let column = 0; column < GRID_SIZE; column++) {
      const x = originX + column;
      const y = originY + row;
      if (isInsideArena(x, y) && snapshot.canStandAt(x, y)) {
        tiles.push({ x, y });
      }
    }
  }
  return tiles;
}

/**
 * How much better a tile has to be before it is worth walking to.
 *
 * Repositioning is not free: moveTo() interrupts combat, so every tick spent walking is a tick
 * not attacking. Without a margin the bot would chase tiny score differences and vibrate on
 * the spot. At zero it does nothing, because a strict `>` already means a tie holds position -
 * which is all that is needed while every score is zero.
 */
export const IMPROVEMENT_MARGIN = 0;

/**
 * The nibbler worth repositioning for: the one nearest to actually eating a pillar.
 *
 * Urgency is distance still to walk, so a FROZEN nibbler has none - it is not advancing at all,
 * and will not be for the length of the freeze. So the focus is the most urgent LOOSE one while
 * any are loose, and only falls back to the frozen ones when everything is held.
 *
 * That is not the same as ignoring frozen nibblers, which is the mistake this replaced. They stay
 * in the list and stay worth hitting - a barrage kills a frozen nibbler exactly as dead - they
 * simply cannot be the most urgent thing on the board while something else is walking.
 */
export function focusNibbler(threats: NibblerThreat[]): NibblerThreat | null {
  const loose = threats.filter((threat) => threat.frozen <= 0);
  const pool = loose.length > 0 ? loose : threats;

  let focus: NibblerThreat | null = null;
  for (const threat of pool) {
    if (!focus || threat.ticksToReach < focus.ticksToReach) {
      focus = threat;
    }
  }
  return focus;
}

/**
 * BARRAGE_REACH_BONUS if a barrage from the end of this route reaches the focus nibbler ON THE
 * TICK THE SHOT ACTUALLY HAPPENS, zero otherwise.
 *
 * Judged from where the route ENDS. Reach is the same test the engine uses for a player clicking
 * a mob - `snapshotPlayerCanSeeMob` - at the barrage's range of 10.
 *
 * The tick is the whole change. This used to ask whether the tile reaches the nibbler where it
 * stands RIGHT NOW, which is a question about a shot nobody is taking: the nibbler is walking,
 * and by the time we have got to the tile and the weapon is off cooldown it is somewhere else.
 * Scored that way the bot shadows the nibbler a step at a time, re-deciding every tick, always
 * positioned for the shot it could have taken a tick ago.
 *
 * So the shot is placed on a clock, and both halves of it are things we already know:
 *
 *  - THE WALK. `arrivalTicks`, the route's length at PLAYER_TILES_PER_TICK. Zero for holding
 *    position. Walking is not attacking - a reposition clears aggro (`moveTo` interrupts
 *    combat) and the automation attacks only on ticks it is not repositioning - so no shot
 *    exists before this.
 *  - THE COOLDOWN. `player.attackDelay`, the weapon's own countdown from the last shot, floored
 *    at zero because it keeps counting past it while nothing is being fought.
 *
 * Whichever is LATER is when the barrage leaves, so a far tile is judged further into the
 * nibbler's walk than a near one, and a tile chosen while the weapon is mid-cooldown is judged
 * at the tick the cooldown ends rather than now. That is what turns a step-at-a-time shadow into
 * a move to somewhere the shot can be taken FROM.
 *
 * Then NIBBLER_LEAD_TICKS on top - see there. Nothing here is a prediction of the nibbler's
 * choices: it has none, its aggro is a pillar and it walks straight at it.
 */
function barrageReach(
  snapshot: ArenaSnapshot,
  focus: NibblerThreat | null,
  cooldownTicks: number,
  route: Location[],
): number {
  if (!focus) {
    return 0;
  }
  const destination = route[route.length - 1];
  const arrivalTicks = Math.ceil((route.length - 1) / PLAYER_TILES_PER_TICK);
  const shotTick = Math.max(arrivalTicks, cooldownTicks) + NIBBLER_LEAD_TICKS;
  const at = nibblerAt(focus, shotTick);
  return snapshotPlayerCanSeeMob(
    snapshot,
    destination.x,
    destination.y,
    at.x,
    at.y,
    focus.size,
    BARRAGE_RANGE,
  )
    ? BARRAGE_REACH_BONUS
    : 0;
}

/**
 * How far PAST the shot tick the nibbler is simulated, so the tile stays ahead of its move.
 *
 * One. The shot tick is the earliest tick the barrage can leave, not a guarantee it leaves
 * exactly then: a click can slip a tick, the walk can be a tile longer than the route says once
 * the engine's own pathing has its say, and the automation has other work competing for the same
 * tick. Judging the tile at the earliest possible tick therefore picks tiles the nibbler is
 * about to walk out of - the edge of range is exactly where "reaches" and "just missed" are one
 * tile apart.
 *
 * Simulating one step further asks for a tile that still reaches after the nibbler's next step,
 * so the answer is stable across the tick it is cashed on rather than true only at the instant
 * it was computed. It costs nothing on a nibbler that is frozen or already adjacent to its
 * pillar - both are capped by `nibblerAt` - so this only bites while one is actually walking.
 *
 * Set to 0 to judge at the shot tick exactly.
 */
export const NIBBLER_LEAD_TICKS = 1;

/**
 * What reaching the focus nibbler is worth.
 *
 * Thirteen, so the pull towards a nibbler outweighs a tick of quiet rather than being lost
 * inside one. Pillar damage is permanent - see PillarDefence - and the tile score is the only
 * place that gets to trade a tick of safety for stopping it.
 */
export const BARRAGE_REACH_BONUS = 13;

/**
 * A mob as the reach test needs it: where it is, and how close we must be to hit it.
 *
 * Reach comes from the mob's OWN gear set, not from what is in hand, so the answer does not move
 * when the gear does. Built once per pass - only the tile varies.
 */
interface ReachTarget {
  x: number;
  y: number;
  size: number;
  reach: number;
}

/**
 * What a tile is worth for having a bloblet in barrage range.
 *
 * One point, the same as `barrageReach`, so the two pulls cannot outbid each other - and like
 * every other reach term it is a tie-breaker rather than a rival to `damageTaken`, which runs
 * to tens. Named so the whole term can be switched off by setting it to zero, without the
 * arithmetic or the dump changing shape.
 */
export const BLOBLET_REACH_BONUS = 1;

/** The three a dying blob leaves behind. Ghosts carry these names too - see `ghostBloblets`. */
const BLOBLET_NAMES: string[] = [
  EntityNames.JAL_AK_REK_KET, // melee
  EntityNames.JAL_AK_REK_MEJ, // magic
  EntityNames.JAL_AK_REK_XIL, // ranged
];

/**
 * Every bloblet on the board, as the reach test needs it, at barrage range.
 *
 * Read off the shared mob snapshot, so GHOST bloblets are included on exactly the terms the
 * rest of the score already includes them on: a blob is dying, three bloblets are landing on
 * known tiles, and a player watching that positions for the landing rather than for the
 * corpse. Built once and handed to all 441 scores, like `targets` and `reaches`.
 */
function blobletTargets(mobs: SimMob[]): ReachTarget[] {
  const bloblets: ReachTarget[] = [];
  for (const mob of mobs) {
    if (BLOBLET_NAMES.includes(mob.name)) {
      bloblets.push({ x: mob.x, y: mob.y, size: mob.size, reach: BARRAGE_RANGE });
    }
  }
  return bloblets;
}

/**
 * BLOBLET_REACH_BONUS if a barrage from the end of this route reaches any bloblet, else zero.
 *
 * Any, not the best stack: the attack layer already picks the centre that catches the most
 * (`bestBarrageBloblet`), and the tile score's job is only to be standing somewhere that cast
 * is legal from. Judged from where the route ENDS, at tick-0 positions, with the same
 * `snapshotPlayerCanSeeMob` test as `barrageReach` - and, like `barrageReach`, without the
 * under-mob refusal that `healerReach` carries, so the two nibbler-shaped pulls stay identical.
 */
function blobletReach(
  snapshot: ArenaSnapshot,
  bloblets: ReachTarget[],
  route: Location[],
): number {
  const destination = route[route.length - 1];
  const reached = bloblets.some((bloblet) =>
    snapshotPlayerCanSeeMob(
      snapshot,
      destination.x,
      destination.y,
      bloblet.x,
      bloblet.y,
      bloblet.size,
      bloblet.reach,
    ),
  );
  return reached ? BLOBLET_REACH_BONUS : 0;
}

/**
 * The Jad healer worth repositioning for: the nearest one still healing (aggro not yet on the
 * player). The Jad-wave analogue of `focusNibbler` - healers cluster on Jad's far side, and
 * the whole tag-and-turn depends on standing somewhere a blowpipe can actually reach them, so
 * the tile score needs a pull towards such tiles just as `barrageReach` pulls towards the
 * nibblers. Tagged healers need nothing: they come to us.
 */
function focusHealer(region: Region, player: Player): ReachTarget | null {
  let best: Mob | null = null;
  let bestDistance = Infinity;
  for (const mob of visibleMobs(region)) {
    if (
      mob.dying > -1 ||
      mob.mobName() !== EntityNames.YT_HUR_KOT ||
      mob.aggro === player
    ) {
      continue;
    }
    const distance = chebyshevDistance(player.location, mob.location);
    if (distance < bestDistance) {
      best = mob;
      bestDistance = distance;
    }
  }
  if (!best) {
    return null;
  }
  return {
    x: best.location.x,
    y: best.location.y,
    size: best.size,
    reach: attackReachForName(player, EntityNames.YT_HUR_KOT),
  };
}

/**
 * Zuk's shield, and why standing behind it is not optional.
 *
 * TzKalZuk.attack() is unambiguous: it fires at the SHIELD - zero damage - only while the
 * target's x falls inside the shield's 5-tile footprint (`shield.x` to `shield.x + 4`) AND
 * y <= 16. Step outside either bound and the next shot targets the player directly for
 * `magicMaxHit()` (251) - not a graze, a near-certain kill. There is no partial credit and no
 * randomness left to model: the shield's only roll is its initial east/west choice, already
 * resolved by the time it exists on the board.
 *
 * The shield is invisible to `damageTaken` today - `attackRange` is 0, so the general
 * threat-generation loop's line-of-sight-and-range test never fires for it - so without this,
 * the tile scorer has no idea the 251 exists at all, on any tile.
 */
const ZUK_SHIELD_WIDTH = 5;
const ZUK_SHIELD_COVER_MAX_Y = 16;
/** ZukShield.movementStep bounces the instant x leaves these - see `bounceIsClose`. */
const ZUK_SHIELD_MIN_X = 11;
const ZUK_SHIELD_MAX_X = 35;
/** ZukShield.freeze(5) on a bounce, which projectShieldX has to replay to stay in step. */
const ZUK_SHIELD_BOUNCE_FREEZE = 5;

export interface ShieldState {
  x: number;
  /** ZukShield.movementDirection: true is east (x++), false is west. */
  direction: boolean;
  frozen: number;
}

export function findShield(region: Region): ShieldState | null {
  const shield = visibleMobs(region).find(
    (mob) => mob.dying <= -1 && mob.mobName() === EntityNames.INFERNO_SHIELD,
  );
  if (!shield) {
    return null;
  }
  const live = shield as unknown as { movementDirection?: boolean; frozen?: number };
  return {
    x: shield.location.x,
    direction: live.movementDirection ?? true,
    frozen: Math.max(0, live.frozen ?? 0),
  };
}

/**
 * The shield as it will be `ticks` from now - a straight replay of `ZukShield.movementStep`, in
 * the same order the engine runs it: movementStep decides whether to move (and freezes + flips on
 * a bounce) BEFORE attackStep's unconditional `this.frozen--` runs later that same tick, so the
 * check has to happen against the pre-decrement value and the decrement has to happen after -
 * reversing that order shifts every bounce by a tick.
 *
 * The whole state comes back, not just x. Which way it is heading and whether it is mid-bounce
 * are as time-dependent as its position, and every consumer here is asking about the deadline
 * rather than about now.
 */
export function projectShield(shield: ShieldState, ticks: number): ShieldState {
  let x = shield.x;
  let direction = shield.direction;
  let frozen = shield.frozen;
  for (let i = 0; i < ticks; i++) {
    if (frozen <= 0) {
      x += direction ? 1 : -1;
      if (x < ZUK_SHIELD_MIN_X || x > ZUK_SHIELD_MAX_X) {
        frozen = ZUK_SHIELD_BOUNCE_FREEZE;
        direction = !direction;
      }
    }
    frozen--;
  }
  return { x, direction, frozen };
}

/**
 * The x the bot aims for inside the band - the leading face, pulled SHIELD_LEAD_INSET tiles in.
 *
 * This is the whole of the wave's positioning. The band is `x` to `x + 4` and it steps one tile
 * per tick, so where you stand inside it decides how many ticks of cover you have banked: on the
 * trailing face you are uncovered by the shield's very next step, on the leading face you have
 * four. Standing "under the shield" is not the goal - staying on the side it is moving towards
 * is, and everything else about this wave's movement falls out of that one number.
 *
 * Correct through a bounce for free. `ZukShield.movementStep` freezes for 5 ticks AND flips
 * `movementDirection` in the same breath when it hits x < 11 or x > 35, so during the freeze the
 * direction already points the new way - and the leading face this returns is the one the shield
 * is about to move towards, which is exactly where the bot should already be walking.
 */
function leadAnchorX(shield: ShieldState): number {
  return shield.direction ? shield.x + ZUK_SHIELD_WIDTH - 1 : shield.x;
}

/**
 * The face the shield is moving AWAY from - the opposite end of the band to leadAnchorX.
 *
 * The one tile of the five that the shield's very next step uncovers.
 */
function trailAnchorX(shield: ShieldState): number {
  return shield.direction ? shield.x : shield.x + ZUK_SHIELD_WIDTH - 1;
}

/**
 * Is the shield about to turn round?
 *
 * `ZukShield.movementStep` bounces the tick x leaves 11..35, so heading east the last stride is
 * from 35 and heading west from 11. Symmetric at both walls because the shield's own rule is.
 */
function bounceIsClose(shield: ShieldState): boolean {
  const tilesLeft = shield.direction
    ? ZUK_SHIELD_MAX_X - shield.x
    : shield.x - ZUK_SHIELD_MIN_X;
  return tilesLeft < SHIELD_BOUNCE_PREP_TILES;
}

/** TzKalZuk.attack()'s own coverage test, unchanged. */
export function isCoveredByShield(px: number, py: number, shieldX: number): boolean {
  return px >= shieldX && px < shieldX + ZUK_SHIELD_WIDTH && py <= ZUK_SHIELD_COVER_MAX_Y;
}

/**
 * The entire wave-69 score, and deliberately the only one.
 *
 * Everything else the tile scorer knows how to price - reach, safe spots, quiet ticks, blob
 * steering, the damage simulation - is switched off on this wave. Wave 69 is being rebuilt from
 * the ground up and this is rung one: is the tile behind the shield, yes or no.
 *
 * CHARGED AT ZUK'S NEXT ATTACK TICK, NOT EVERY TICK. Zuk only threatens on the ticks it fires,
 * so cover is a deadline rather than a standing requirement - which is where the freedom of
 * movement comes from. Between attacks any tile is equal; the penalty appears on tiles that will
 * not be covered when the shot is aimed.
 *
 * TWO OFFSETS MAKE THIS WORK, AND BOTH ARE EASY TO GET WRONG.
 *
 *  - `TzKalZuk.attack()` picks its target at the moment it FIRES, reading `this.aggro.location`
 *    right then, and the projectile is aimed for the whole of its flight. So the tick that
 *    matters is the fire tick, not the landing tick four ticks later.
 *  - Inside a tick, `World.tickRegion` steps every mob before any player. On fire tick F, Zuk
 *    therefore reads the position the player held at the END of tick F-1. Being in cover on F
 *    itself is one tick too late, so the walk has `untilFire - 1` ticks to finish, not
 *    `untilFire`.
 *
 * The shield, in contrast, HAS moved by the time Zuk fires - its movementStep runs earlier in
 * the same tick - so it is projected the full `untilFire` ticks.
 *
 * Before the first observed attack `ZukAttackClock` has no phase and this falls back to the old
 * rule, cover judged right now, which is the safe reading when the deadline is unknown.
 */
export const ZUK_SHIELD_UNCOVERED_PENALTY = -1000;

/**
 * The only thing separating one safe tile from another: nearer the leading face wins.
 *
 * Wave 69 has no scoring left beyond "will this tile be behind the shield when Zuk fires". Safe
 * tiles are all worth the same 0, unsafe ones all cost ZUK_SHIELD_UNCOVERED_PENALTY, and there is
 * no gradient, no partial credit and no term that can trade cover away for anything else.
 *
 * A thousandth of a point, so the entire arena's worth of it cannot approach the cover penalty.
 * It exists purely to settle ties, which is the case `bestMove` cannot otherwise reach: it needs
 * STRICTLY better than holding, so without this the bot keeps whatever safe tile it happens to be
 * standing on - including the trailing edge of the band it is about to need.
 */
const SHIELD_FACE_TIEBREAK = 0.001;

/**
 * Where a tagged Zuk healer's AOE is about to land - a soft steer, not a veto, so it never
 * outweighs `shieldPenalty` and never pulls the bot out from under the shield to dodge it.
 *
 * `Jal-MejJak` only fires `AoeWeapon` once tagged (`attackStyleForNewAttack`: "aoe" iff
 * `aggro.type === UnitTypes.PLAYER`), and that attack registers three GROUND-TARGETED ghost
 * projectiles straight onto `region.projectiles` (`AoeWeapon.attack`, via
 * `region.addProjectile` with a fixed `{x,y,z}` `to`, not a unit) at the moment it casts - one
 * pinned to wherever the player was standing right then, two random within its box. Two of the
 * three are genuinely unpredictable before the cast (`Random.get()`), so this does not predict
 * a healer's next cast - it reads the exact landing tiles straight off public state the instant
 * they exist, the same way a player reacts to seeing the spark. They stay in `region.projectiles`
 * for `totalDelay` (4) ticks after casting (`Projectile.shouldDestroy`), comfortably covering
 * the actual hit check at cast+3 (`InfernoHealerSpark`'s own `DelayedAction` + one more tick).
 *
 * HALF A POINT MEANS SOMETHING DIFFERENT NOW than it did when this was one term among eight. The
 * only things left on this wave are a 1000 and a thousandth, so it sits cleanly between them: it
 * cannot be seen by cover, and it flattens the face tie-break completely. That ordering is the
 * intended one - stepping out of a spark is worth giving up the leading face for, and is never
 * worth giving up the shield for - but it is now the ONLY thing the face preference ever loses
 * to, so a mistuned value here has nowhere to hide.
 */
/**
 * Worth a point to be standing where a healer can be blowpiped.
 *
 * A healer is the only thing on this wave that gives Zuk hitpoints back, and the tag is what
 * stops it - `JalMejJak.attackStyleForNewAttack` returns "heal" while its aggro is Zuk and "aoe"
 * once it is ours - so being in range of one is worth moving for rather than waiting for it to
 * wander into reach. They spawn at y 9 in a row across the arena while cover sits at y 13-16, so
 * from most of the band they are outside the blowpipe's 5 and nothing else would ever pull the
 * bot towards them.
 *
 * The BLOWPIPE's range specifically, not `attackReachFor`: that answers with `requiredSetFor`,
 * which lists YtHurKot as a blowpipe target but leaves JalMejJak on the default bow - so it would
 * report the long weapon's reach for exactly the healer this wave cares about.
 *
 * A whole point, so it beats the face tie-break outright and cannot be seen by
 * ZUK_SHIELD_UNCOVERED_PENALTY. Note it also outweighs ZUK_HEALER_AOE_PENALTY, so the bot will
 * stand in a live spark to keep a healer in range - deliberate at 1 against 0.5, since the spark
 * is survivable and the healing is not, but it is the pair of numbers to look at first if that
 * trade turns out wrong.
 */
const ZUK_HEALER_REACH_BONUS = 1;

/**
 * Paid to a tile that can shoot a set mob still aggroed to the shield.
 *
 * A pair spawns stunned - `spawnDelay` 7 on the mager, 9 on the ranger - and a tag lands about
 * five ticks after the click, so a mob inside weapon range when it spawns never fires at all.
 * Measured on seed 67: five of ten were, and all five cost the shield nothing. Every point of the
 * 559 it lost came from the other five, which were out of range at spawn and stayed out of range
 * for 13 to 24 ticks.
 */
const ZUK_TAG_REACH_BONUS = 1;

/**
 * BE STANDING SOMEWHERE THAT REACHES THE PAIR BEFORE IT LANDS.
 *
 * Paid per spawn tile, so a tile covering both is worth twice one covering either - which pulls
 * towards the middle of the arena without naming a number to aim at.
 *
 * The two tiles never move: `TzKalZuk.attackIfPossible` constructs the pair at (20,21) and (29,21)
 * every single set, and `ZukSetTimer` already counts down to the tick they appear. The bot even
 * announces it - "holding fire for the spawn (set in 2)" - so it knows the moment is coming and
 * stops shooting for it. It just does not stand anywhere useful for it.
 *
 * Measured, seed 26 set 5: at t1955 the band was 22..26 and the bot was at x29. From x25, a
 * covered tile in that same band, the mager's spawn tile is exactly 7 away and in crossbow range.
 * It stood on the east end instead, the mager landed at d9 unreachable, the shield carried the bot
 * further east every tick, and the mager was still untagged 25 ticks later having put four hits
 * and 204 damage into the shield. Two tiles of standing position, at a tick when the bot was
 * deliberately doing nothing else.
 *
 * WHY THE EXISTING BONUS CANNOT DO THIS. `tagReach` needs a live untagged mob, and `visibleMobs`
 * withholds a spawn for one tick - so the earliest it can pay is the tick AFTER the pair lands, by
 * which point the distance is already fixed. This is the same bonus asked one tick earlier, of the
 * only thing that is knowable that early: the tiles themselves.
 */
const ZUK_SPAWN_REACH_BONUS = 1;

/** Where a pair always lands. Fixed in TzKalZuk, not derived from anything. */
const ZUK_SPAWN_TILES: Location[] = [
  { x: 20, y: 21 },
  { x: 29, y: 21 },
];

/**
 * How early to start caring, in ticks before the pair lands.
 *
 * Enough to cross the band and no more. It is five wide, the bot runs two tiles a tick, so three
 * ticks reaches any tile in it from any other. Starting earlier would trade away the leading face
 * for longer than the move needs.
 */
const ZUK_SPAWN_PREP_TICKS = 3;

/**
 * What it costs to be OUT OF COVER at the fire tick... which is a thing that never happens, and
 * that is the point.
 *
 * COVER IS ABOUT WHERE WE STAND WHEN ZUK FIRES, NOT ABOUT WHERE WE GO. The scorer used to treat
 * those as the same question, so a tile uncovered at the fire tick was refused outright even when
 * there were nine ticks to walk out, shoot, and walk back before the shot was aimed. That refusal
 * is what left half of every pair unshootable: the mob sits at y 21 and the band is often nowhere
 * near it, so the only tile that could tag it was one the bot was not allowed to stand on.
 *
 * A SORTIE is that trip, and it is only ever offered when the round trip fits inside the clock
 * with a tick to spare - see ZUK_SORTIE_SAFETY. The penalty is small because the trip is not
 * dangerous when it fits; it exists to keep a covered firing position preferred over a sortie to
 * the same target, and to stop the bot wandering out when standing still would do.
 *
 * It can never be earned by a tile that has nothing to shoot. Without that condition every
 * uncovered tile within a round trip becomes acceptable and the -1000 stops protecting anything.
 */
const ZUK_SORTIE_PENALTY = -0.25;

/**
 * Slack, in ticks, on top of the round trip.
 *
 * The return leg is priced with straight-line distance rather than a real route, because routing
 * every tile back to a moving band each tick is not affordable - and that estimate errs on the
 * fatal side, since a real path around a mob is longer than the line. One tick of margin covers
 * the difference. Two hundred and fifty-one damage is the price of being wrong here, so the margin
 * is not negotiable down to zero.
 */
const ZUK_SORTIE_SAFETY = 1;

/**
 * ZUK_TAG_REACH_BONUS's twin for the boss himself: paid to a tile that can shoot Zuk, while Zuk
 * is what the attack layer would actually spend the shot on - see `zukShotWanted` below.
 *
 * Reach on Zuk is the crossbow build's standing problem, not an edge case: Zuk's southern edge
 * is y 8, the covered row at y 16 is therefore distance 8, and the crossbow reaches 7 - so the
 * bot can sit covered, in the right band, on the one row it cannot shoot from, and nothing else
 * on the board ever pulls it a row closer. The same single point as the healer and tag bonuses,
 * so it beats the face tie-break, never beats cover, and - through the same `(safe || sortie)`
 * test the tag bonus uses - can be earned by a step OUT of cover when the round trip fits Zuk's
 * clock. That is what turns "covered but out of reach" from a dead cycle into a run-out hit.
 */
const ZUK_BOSS_REACH_BONUS = 1;

/**
 * The attack layer's hold ladder, mirrored so ZUK_BOSS_REACH_BONUS is only ever paid while Zuk
 * is the thing the shot would actually go to. Kept in step BY HAND with InfernoAutomation's
 * private ZUK_MAGER_KILL_HP / ZUK_ENRAGE_HP / ZUK_HOLD_SET_HP / ZUK_HOLD_SET_TICKS - the
 * automation imports this file, so the dependency cannot point the other way. A mismatch only
 * ever withholds the bonus, which costs a shot, never a position.
 */
const ZUK_CLEAR_SET_HP = 600;
const ZUK_ENRAGE_HP = 240;
const ZUK_HOLD_SET_HP = 280;
const ZUK_HOLD_SET_TICKS = 100;

/**
 * EXPERIMENT - flip to false to revert in one line.
 *
 * While an untagged set mob is stranded BEHIND the band - on the side the shield is moving away
 * from, out of the long weapon's reach from every covered column - the face preference flips to
 * the trailing side, and the trailing tile itself is allowed as cover. Both halves spend the
 * same currency: the four tiles of banked cover the leading face buys are handed over as four
 * tiles of proximity to the mob, shortening the eventual sortie or reach window by up to two
 * ticks each way. The trailing tile IS covered at the fire tick by TzKalZuk's own test - what
 * standing there costs is slack, and while a mob is pouring sixty-damage hits into the shield,
 * slack is the cheaper thing to spend.
 *
 * ONLY while the shield is leaving the mob behind. On the return leg the mob is on the LEADING
 * side and the normal preference already points at it, so this changes nothing there - which is
 * also why it cannot help a park the band is already swinging back from, only the drift out.
 *
 * Motivated by seed 26 set 8: the westbound band dragged the bot four leading-face tiles
 * further from a stranded ranger whose sortie trip then missed the enraged budget every cycle,
 * and the shield's last 72 hitpoints went to the floor before the band came back.
 */
const ZUK_STRANDED_FACE_FLIP = true;

/**
 * What the sortie test decided this tick, for the harness - and the automation - to read back.
 *
 * REPORTED BY THE CODE THAT DECIDES, not reconstructed afterwards. A harness-side copy would need
 * the same routes, the same projected band and the same reach test, and any drift between the two
 * makes the report describe a scorer that does not exist. No longer purely diagnostic: the
 * automation reads `canTag` to decide whether holding the weapon for a sortie is worth anything -
 * a sortie needs the weapon ready on arrival (`untilShot <= arrivalTicks + 1` above), and the
 * attack layer is the only thing that can keep it ready.
 */
export interface SortieDebug {
  /** Tiles from which something still on the shield could be shot. */
  canTag: number;
  /** Of those, tiles already covered at the fire tick - no trip needed. */
  canTagCovered: number;
  /** Of those, tiles offered as a step out. */
  sorties: number;
  /** The cheapest round trip among uncovered canTag tiles, and the budget it had to fit in. */
  bestTrip: number | null;
  walkTicks: number | null;
  /** Why the cheapest one was refused, when it was. */
  refusedFor: string | null;
}
let lastSortie: SortieDebug = {
  canTag: 0,
  canTagCovered: 0,
  sorties: 0,
  bestTrip: null,
  walkTicks: null,
  refusedFor: null,
};

export function sortieDebug(): SortieDebug {
  return lastSortie;
}

/** Wave 69 prices a route exactly as every other wave does. */
const ZUK_TILES_PER_TICK = PLAYER_TILES_PER_TICK;

const ZUK_HEALER_AOE_PENALTY = -0.5;
/** Chebyshev radius matching `InfernoHealerSpark`'s own hit check - a 3x3 box on the spark. */
const ZUK_HEALER_AOE_RADIUS = 1;

function healerAoeLandings(region: Region): Location[] {
  const landings: Location[] = [];
  for (const projectile of region.projectiles) {
    if (projectile.from?.mobName?.() !== EntityNames.JAL_MEJ_JAK) {
      continue;
    }
    const to = projectile.to as unknown as { x?: number; y?: number };
    if (to.x === undefined || to.y === undefined) {
      continue; // the healer's non-AOE heal-Zuk cast, or anything else keyed to a unit
    }
    landings.push({ x: to.x, y: to.y });
  }
  return landings;
}

function nearHealerAoeLanding(landings: Location[], destination: Location): boolean {
  return landings.some((landing) => chebyshevDistance(destination, landing) <= ZUK_HEALER_AOE_RADIUS);
}



/**
 * How many ticks past NOW a tile must stay covered for, while the attack clock has no sync.
 *
 * Only the unsynced opening needs this. Once Zuk has been seen to attack, cover is judged at the
 * exact tick the shot is aimed and a buffer would be superstition. Before that there is no
 * deadline, and "covered right now" is a strictly one-tick-too-late test: the shield steps at the
 * start of a tick and Zuk fires later in the SAME tick, so a tile that is covered when it is
 * scored can already be exposed when the shot is aimed. Measured, the bot sat exactly one tile
 * behind the band for the whole opening and took Zuk's first attack for 251, both directions,
 * every time.
 *
 * It also does the job the lead term cannot. `shieldLead` is zero on the tile underfoot, so the
 * bot holds the instant it is nominally covered - which is the trailing edge, the worst tile in
 * the band. Demanding the tile survive a few more shield steps makes the trailing edge score as
 * unsafe, so the walk continues to somewhere that actually keeps working.
 */
const ZUK_SHIELD_COVER_BUFFER_TICKS = 3;

/**
 * How close to a wall the shield has to be for the leading face to stop meaning anything.
 *
 * The leading face is worth chasing only while the shield keeps going that way, and this close
 * to a wall it does not: it bounces, freezes for 5 ticks, and the end the bot just walked to
 * becomes the TRAILING end - four ticks of cover thrown away for a walk that was wrong before it
 * finished. So inside this window the pull is switched off entirely and every tile in the band
 * scores the same 0. Nothing in the band is worse than anything else, `bestMove` breaks the tie
 * on walk length, and the nearest covered tile wins - which for a bot already under the shield
 * means standing still until the direction actually flips.
 *
 * Switched off rather than re-aimed at the far end: the bounce has not happened yet, and paying
 * a real walk for it early is the same mistake in the other direction. The moment
 * `movementDirection` flips, `leadAnchorX` follows it on its own.
 */
const SHIELD_BOUNCE_PREP_TILES = 3;

function reachTargets(player: Player, mobs: Mob[]): ReachTarget[] {
  const targets: ReachTarget[] = [];
  for (const mob of mobs) {
    if (mob.dying > -1) {
      continue;
    }
    targets.push({
      x: mob.location.x,
      y: mob.location.y,
      size: mob.size,
      reach: attackReachFor(player, mob),
    });
  }
  return targets;
}

/**
 * ARRIVAL: how soon the tile has to be somewhere we could be standing for it to count at all.
 * At PLAYER_TILES_PER_TICK this is a gate of 4 tiles of route.
 *
 * This is a constraint on the PLAYER, and it wants to stay tight. Scoring re-runs from scratch
 * every tick, so a long walk is a promise that gets re-decided several times before it can pay
 * out. It also stops a tile being credited for reach that only exists at some waypoint the route
 * passes through on the way to somewhere else.
 */
export const NPC_REACH_ARRIVAL_TICKS = 4;

/**
 * PATIENCE: how long the mobs are given, counted from the tick we ARRIVE on the tile, to be
 * somewhere the engine would actually let us shoot them.
 *
 * A separate number from arrival because it answers a different question - not "how far will I
 * commit to walking" but "will a fight actually materialise once I am there". Counted from
 * arrival rather than from the start of the simulation, so lengthening the walking budget does
 * not silently eat the mobs' approach budget.
 *
 * This window is a claim about where mobs WILL be, so it is only as honest as `stepMob`'s
 * agreement with the engine - see the corner-safespotting note there for the wedge that
 * happens when they disagree.
 */
export const NPC_REACH_WINDOW_TICKS = 4;

/**
 * What a reachable mob is worth, tiered by how much the fight it offers matters.
 *
 * `npcReachSoon` used to be a flat 1 for anything at all, which said a tile facing a blob was
 * as good a place to fight from as a tile facing a mager. It is not, and the tiers say why:
 *
 *   NPC_REACH_BONUS (1)         the mager, and the three bloblets - the fights worth walking
 *                               towards. The mager is the kill-priority head of every wave it
 *                               appears on, and bloblets are two-tick cleanup that only gets
 *                               more expensive the longer they live.
 *   NPC_REACH_LESSER_BONUS      everything else - a real fight, but not one worth outbidding a
 *   (0.75)                      mager tile for.
 *   BLOB_REACH_BONUS (0.5)      the blob, whose kill is not even pure gain - it lands three
 *                               bloblets in exchange (see KillPriority, where JAL_AK is 1).
 *
 * The term is the BEST thing this tile can reach rather than the first thing it happens to
 * find - a tile that reaches a blob AND something else scores as the something else, because
 * the blob is not what we would be shooting from there.
 *
 * Fractions of a point are deliberately a nudge and not a repulsion. What actually keeps the
 * bot off bad fights is `damageTaken` pricing their hits and `routeEntersForbiddenZone`
 * deleting melee zones outright; this only breaks ties those two leave equal. Set the lesser
 * bonuses to NPC_REACH_BONUS to turn the distinctions off without changing the arithmetic.
 */
export const NPC_REACH_BONUS = 1;
export const NPC_REACH_LESSER_BONUS = 0.75;
export const BLOB_REACH_BONUS = 0.5;

/**
 * How far a mob standing over the player can move next tick, in tiles.
 *
 * One, and it is not a heuristic - it is the engine's own outcome set. `getNextMovementStep`
 * replaces the chase with a coin flip whenever the player is inside the footprint:
 *
 *     if (Random.get() < 0.5) { dy = y; dx = x + (Random.get() < 0.5 ? 1 : -1); }
 *     else                    { dx = x; dy = y + (Random.get() < 0.5 ? 1 : -1); }
 *
 * Four outcomes at a quarter each - x+1, x-1, y+1, y-1 - drawn from a generator this scorer
 * cannot read without desyncing the run. So the direction is not merely hard to predict, it is
 * unknowable, and `stepMob` picking one of the four is right a quarter of the time. Measured:
 * at tick 18 the projection put him south, the engine rolled west, the escape tile it had
 * scored reach 1 was covered on arrival, and the bot walked back underneath. That is the
 * dance, and no sharper prediction can fix it because there is nothing there to predict.
 *
 * What IS knowable is the union: after one shuffle his footprint is somewhere inside itself
 * dilated by one tile. A destination outside that ring escapes every roll. So while standing
 * under a mob, reach is refused inside the dilation - see `withinShuffleReach`.
 *
 * Set to 0 to remove the rule.
 */
export const UNDER_MOB_SHUFFLE_TILES = 1;

/**
 * How far we could hit each KIND of mob, keyed by name.
 *
 * Reach comes from `requiredSetFor`, which depends only on what the mob IS, so every mob sharing
 * a name shares an answer and this can be built once per pass. Keyed by name rather than by
 * identity because the reach test runs against SimMob copies inside the trajectory, and those are
 * value snapshots with no link back to the live Mob they came from.
 */
function reachByMobName(player: Player, mobs: Mob[]): Map<string, number> {
  const byName = new Map<string, number>();
  for (const mob of mobs) {
    if (mob.dying > -1) {
      continue;
    }
    const name = mob.mobName();
    if (!byName.has(name)) {
      byName.set(name, attackReachFor(player, mob));
    }
  }
  return byName;
}

/**
 * Mobs whose melee-adjacency coin flip is dangerous enough that the tile scorer must never pick
 * a tile in that zone, regardless of what else it scores. Exactly the mobs `canMeleeIfClose`
 * covers - see KillPriority.canReach's sibling reasoning - except the meleer, which is not on
 * this list because standing next to it is not a special state, it is the entire fight.
 */
const FORBIDDEN_MELEE_MOBS: string[] = [
  EntityNames.JAL_ZEK, // mager
  EntityNames.JAL_XIL, // ranger
  EntityNames.JAL_AK, // blob
  EntityNames.JAL_TOK_JAD, // Jad
];

/**
 * Large enough to dominate every other term combined (the rest tops out around 2) and any
 * plausible `damageTaken`, so a forbidden tile can never win on points - it is a veto, not a
 * cost. Only loses to another forbidden tile, and only then by the ordinary tie-break rules.
 */
/** Is this tile under, or melee-adjacent to, any of the coin-flip mobs? */
function insideForbiddenZone(mobs: SimMob[], x: number, y: number): boolean {
  for (const mob of mobs) {
    if (!FORBIDDEN_MELEE_MOBS.includes(mob.name)) {
      continue;
    }
    if (playerIsUnder(mob, x, y) || withinMeleeRange(mob, x, y)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether this route is one the bot must not take at all - the walk ENTERS the coin-flip zone,
 * or ends inside it.
 *
 * This replaced a -1000 score on the destination, which was a veto in the wrong place. Judging
 * only the destination left the JOURNEY priced rather than forbidden: `damageTaken` walks the
 * route and charges the mager's magic-or-stab flip as an AVERAGE of the two outcomes, so a
 * path clipping the zone for a single tick was merely expensive, and any other term could
 * outweigh it. That is exactly the risk the veto exists to refuse - a 50/50 cannot be prayed,
 * and half-praying it is not a thing - so pricing it at its mean is the one treatment that
 * makes no sense. A tile whose only approach runs through a mager should not be an option at
 * all, and now it is not: the candidate is DROPPED, the same way a tile walled off behind a
 * pillar is dropped, rather than scored badly.
 *
 * Judging the route is only honest because `routesFrom` is a transcription of the engine's own
 * `Pathing.constructPaths` - same directions in the same order, same diagonal rule - so the
 * route tested here is the route `moveTo` will really walk. Blocking the zone inside the BFS
 * instead would have scored a detour around the mob that the engine, which paths mob-blind,
 * would never take.
 *
 * EXIT IS ALLOWED, ENTRY IS NOT. A mob that walks up to the player puts the player's OWN tile
 * in the zone, and a rule of "no zone tiles anywhere in the route" would then reject every
 * candidate the bot has, including standing still - a freeze, which is worse than the coin
 * flip it was avoiding. So the route may begin inside the zone and walk out of it; what it may
 * never do is step back in once it has left, or finish inside. Holding position is never
 * blocked for the same reason: `bestMove` needs that baseline to exist, and refusing to be
 * where you already are is not an option anybody can take.
 *
 * Zone geometry comes from the mobs' tick-0 positions, like the veto it replaces. Mobs do move
 * during a long walk, but the mobs on this list park the instant they gain line of sight,
 * which is what makes a static reading defensible.
 */
function routeEntersForbiddenZone(mobs: SimMob[], route: Location[]): boolean {
  if (route.length <= 1) {
    return false; // holding position - see above
  }

  let hasLeftZone = false;
  for (let i = 0; i < route.length; i++) {
    const inside = insideForbiddenZone(mobs, route[i].x, route[i].y);
    if (!inside) {
      hasLeftZone = true;
      continue;
    }
    // Inside the zone. Fine only while still on the way out of it.
    if (hasLeftZone) {
      return true; // stepped back in
    }
    if (i === route.length - 1) {
      return true; // never left, and this is where the walk stops
    }
  }
  return false;
}

/**
 * Bonus for a move that survives its walk unscathed and ends on a tile nothing can shoot for
 * the rest of the horizon - see the module comment for the exact two-part test.
 *
 * Deliberately a fraction, not a full point - see the module comment. It only distinguishes
 * between tiles `damageTaken` already ties at zero; it must never outweigh a single point of
 * real damage avoided.
 */
export const SAFE_SPOT_BONUS = 0.8;

/**
 * What one counted tick is worth on a safespot: one point, from `quietTicksFor`.
 *
 * A point a tick puts the term on the same scale as the reach bonuses rather than above them -
 * a full twelve ticks is 12, just under BARRAGE_REACH_BONUS, so a safespot that cannot barrage
 * the focus nibbler loses to one that can, and single-tick differences in the walk are worth
 * about what one reachable mob is. Damage still runs to tens and still outweighs all of it.
 *
 * Set to 0 to remove the term entirely without changing the arithmetic or the dump.
 */
export const QUIET_TICK_BONUS = 1;

/**
 * How long the count is allowed to run before it stops asking - and so the term's ceiling, at
 * QUIET_TICK_BONUS * QUIET_SCAN_TICKS = 12.
 *
 * Twelve, the horizon length. The one thing it costs: a mob further out than twelve ticks reads
 * the same as one exactly twelve ticks out, so the count only starts moving once the approach
 * is inside the window. Raising this is the single knob that changes that, and it raises the
 * ceiling with it.
 */
export const QUIET_SCAN_TICKS = 12;


/**
 * Cost per tile of Chebyshev distance to the nearest live mob, charged against a safe spot's
 * bonus.
 *
 * Every safe tile ties at exactly SAFE_SPOT_BONUS, and among ties the tile scorer only breaks
 * on route length - so of several equally safe tiles the bot could end up parked somewhere far
 * from the fight entirely. This nudges the tie towards the
 * safe tile nearest whatever is actually on the board, so a safe spot the bot picks is one it
 * can still do something useful from, not just the quietest corner of the arena.
 *
 * Small enough (0.01) that the debug grid's score doubles as a distance readout: at this rate
 * SAFE_SPOT_MIN is not reached until 40 tiles out, well past anything the 21x21 candidate box can
 * contain, so every safe tile's score directly reads back as SAFE_SPOT_BONUS minus its distance
 * in hundredths - e.g. 0.47 is 3 tiles from the nearest mob.
 */
export const NPC_DISTANCE_PENALTY = 0.00;

/**
 * Floor under the distance penalty, so a safe tile far from every mob still keeps a meaningful
 * bonus over an unsafe one rather than being taxed down towards zero. SAFE_SPOT_BONUS is small
 * on purpose - it should not need defending from its own penalty term.
 */
export const SAFE_SPOT_MIN = 0.1;

/**
 * The anchor tile for the waves that have one, or null for every wave that does not.
 *
 * 67 and 68 are fought in an open arena with no pillars, so nothing in the score anchors the
 * bot anywhere - equal tiles everywhere means drift, and drift on a Jad wave ends at a wall
 * with healers on both sides. These are the same tiles the spawn places the player on, and
 * the same map the between-waves station uses (via this function, so the two cannot disagree).
 */
export function waveHomeTile(wave: number): Location | null {
  if (wave === 67) {
    return { x: 18, y: 25 };
  }
  if (wave === 68) {
    return { x: 25, y: 27 };
  }
  return null;
}

/**
 * Cost per tile of Chebyshev distance from the wave's home tile - a nudge, deliberately on
 * the same tiny scale as NPC_DISTANCE_PENALTY: it breaks ties between otherwise-equal tiles
 * towards the centre of the arena and loses every argument with a real term. At 0.01/tile
 * the whole grid spans about 0.2, less than a third of one safe-spot bonus.
 */
export const HOME_PULL_PER_TILE = 0.01;

/**
 * Safe spot the bot returns to between waves, for every wave `waveHomeTile` has no answer for.
 *
 * Owned here rather than by the automation so the tile waited on between waves and the tile the
 * last-npc pull below anchors to are the same constant and cannot disagree. There are 9 ticks of
 * downtime after the last mob of a wave dies (InfernoRegion.waveCompleteTimer), though that
 * countdown is cancelled outright if bloblets spawn late - so the window is not guaranteed to
 * run its full length.
 */
export const HOME_TILE: Location = { x: 28, y: 17 };

/**
 * START THE WALK HOME WHILE THE LAST NPC IS STILL DYING, instead of after it is dead.
 *
 * The between-waves return only gets whatever is left of the 9-tick downtime window, so a wave
 * finished at the far wall spawns the next set with the bot still mid-walk, out of position.
 * With exactly ONE live npc in the arena the fight is already decided - nothing else needs
 * dodging or reaching - so distance from home becomes a cost the score can see.
 *
 * Free inside LAST_NPC_HOME_FREE_TILES of home, then LAST_NPC_HOME_PULL_PER_TILE per tile
 * beyond that, capped at LAST_NPC_HOME_PULL_CAP. The shape matters as much as the size: near
 * home it is silent and the normal terms decide; ten tiles out it reads a full point, enough to
 * outweigh a reach bonus and start the bot drifting back; and the cap keeps the far corner of
 * the arena from looking apocalyptic - past fifteen tiles every distant tile is equally wrong
 * and the real terms tell them apart again.
 */
export const LAST_NPC_HOME_PULL_PER_TILE = 0.1;
export const LAST_NPC_HOME_FREE_TILES = 5;
export const LAST_NPC_HOME_PULL_CAP = 1;

/**
 * Paid on tiles a shot can be taken from, divided by how many attackers can shoot BACK.
 *
 * `npcReachSoon` says a fight is available but nothing about the terms of it. Between two
 * tiles that both let us hit something, the one three mobs are looking at is a far worse place
 * to stand than the one where only the target can see us - and until now those scored
 * identically on reach and were separated only by whatever `damageTaken` happened to make of
 * them, which is nothing at all while every incoming attack is prayable.
 *
 * Full value when at most one attacker has the tile, halved at two, a third at three. It only
 * applies where reach already does: this is about choosing WHICH fight to take, and a tile we
 * cannot shoot from is not a fight.
 *
 * The divisor is floored at one so an unwatched tile is worth the same as a tile only the
 * target itself watches, rather than infinity. Reaching a mob that cannot reach back is
 * already the best case and gets the full point either way.
 */
export const LOS_BONUS = 1;

/**
 * Cap on the settle simulation behind the safe-spot claim.
 *
 * "Settled" is detected by fixed point, not by running the cap out, so this is a backstop
 * rather than a horizon: the longest freeze in the arena is 32 ticks, a mob crossing the whole
 * interior needs about 29 more, and the longest walk the bonus can gate on is 11 - so 80 is
 * past anything that can still be in flight. A pass that reaches the cap without settling or
 * being seen has proven nothing, and proven-nothing means no bonus.
 */
export const SAFE_SPOT_SETTLE_TICKS = 80;

/**
 * The other half of the safe-spot claim: parked on this destination, the mobs finish reacting
 * and the board reaches a fixed point with the tile still unseen. Twelve quiet ticks are not
 * that claim - a mob thirteen ticks away satisfies the horizon test from a tile that is merely
 * far - and the difference is exactly the one between "quiet for now" and a safespot.
 *
 * Fixed point means two consecutive ticks in which no mob moved and none is in a transient
 * state - frozen, stunned, mid-dig, or still in the post-dig movement freeze of delay > speed.
 * Two, not one: the transient counters decrement a phase AFTER movement reads them, so a single
 * unchanged tick can be a mob's last frozen breath rather than a jam. The simulation is
 * deterministic with the player parked, so an unchanged, transient-free transition repeats
 * itself forever - which is what lets a bounded check make an unbounded claim.
 *
 * Digs are stripped (`canDig` off) before simulating, deliberately. The meleer's dig triggers
 * precisely when it cannot reach you, so pricing it here would zero the bonus for every tile
 * exactly when the bot is starving the meleer - the moment this term matters most - and the dig
 * surfaces beside you wherever you stand, so it cannot tell tiles apart anyway. The dig stays
 * priced by `damageTaken` whenever it falls inside the twelve tick horizon.
 */
function settlesSafe(snapshot: ArenaSnapshot, mobs: SimMob[], route: Location[]): boolean {
  const undiggable = mobs.map((mob) => (mob.canDig ? { ...mob, canDig: false } : mob));
  const destination = route[route.length - 1];

  let exposed = false;
  let settled = false;
  let stableTicks = 0;
  let previous: string | null = null;

  simulateTrajectory(
    snapshot,
    undiggable,
    route,
    SAFE_SPOT_SETTLE_TICKS,
    (_tick, simMobs, px, py) => {
      if (px !== destination.x || py !== destination.y) {
        return; // still walking; the journey is damageTaken's business, not this claim's
      }
      for (const mob of simMobs) {
        if (mob.attacks && mobSeesPlayer(snapshot, mob, px, py)) {
          exposed = true;
          return true;
        }
      }
      let transient = false;
      const positions: string[] = [];
      for (const mob of simMobs) {
        if (mob.frozen > 0 || mob.stunned > 0 || mob.digTicks > 0 || mob.delay > mob.speed) {
          transient = true;
          break;
        }
        positions.push(`${mob.x},${mob.y}`);
      }
      if (transient) {
        stableTicks = 0;
        previous = null;
        return;
      }
      const board = positions.join(";");
      stableTicks = board === previous ? stableTicks + 1 : 0;
      previous = board;
      if (stableTicks >= 2) {
        settled = true;
        return true;
      }
    },
  );

  return settled && !exposed;
}

/**
 * Walk there, stand there, and count the ticks until an NPC has line of sight and range on the
 * tile. That is the whole rule.
 *
 * The count ends on LOS, or on the nearest attacker stopping getting closer:
 *
 *  - SEEN. Something that attacks has the tile in line of sight and range - `mobSeesPlayer`,
 *    the same test every other exposure question in this file asks.
 *  - NOT CLOSING. The nearest attacker is no nearer than it was last tick. Whether a mob MOVED
 *    is the wrong question and was scoring noise: one shuffling sideways, or pathing around a
 *    pillar at a constant distance, banked ticks for an approach that was not happening.
 *
 * The arrival tick sets the baseline distance and scores nothing, so a tile nothing is closing
 * on counts zero rather than a free tick.
 *
 * Counted from arrival, so it is the ticks the tile buys us once we are standing on it rather
 * than ticks the walk passed through.
 */
function quietTicksFor(
  snapshot: ArenaSnapshot,
  mobs: SimMob[],
  route: Location[],
): number {
  const destination = route[route.length - 1];

  let ticks = 0;
  let previousDistance: number | null = null;

  simulateTrajectory(
    snapshot,
    mobs,
    route,
    QUIET_SCAN_TICKS,
    (_tick, simMobs, px, py) => {
      if (px !== destination.x || py !== destination.y) {
        return; // still walking - the count is about standing there
      }

      let nearest = Infinity;
      for (const mob of simMobs) {
        if (!mob.attacks) {
          continue;
        }
        if (mobSeesPlayer(snapshot, mob, px, py)) {
          return true; // seen - the count ends here
        }
        nearest = Math.min(nearest, chebyshevDistance({ x: mob.x, y: mob.y }, { x: px, y: py }));
      }

      if (previousDistance === null) {
        previousDistance = nearest; // the baseline, not a tick of approach
        return;
      }
      if (nearest >= previousDistance) {
        return true; // nothing is getting closer, so there is nothing to count down
      }
      previousDistance = nearest;
      ticks++;
    },
  );
  return ticks;
}

/**
 * Stand-still decay - a standard part of the score since 2026-08, when it was promoted from an
 * experiment behind a sidebar toggle.
 *
 * While the board is SETTLED - no live mob moved since the previous tick - with mobs alive and
 * the player not fighting back, the score of the tile the player is STANDING ON decays by
 * TILE_DECAY_PER_STEP every TILE_DECAY_INTERVAL_TICKS. Nothing else changes: every other tile
 * keeps its honest score, so the decay only ever lowers the bar that "hold position" sets in
 * bestMove. The idea is to break standoffs - a wave cannot end while the bot contributes
 * nothing, so the longer that lasts, the less credible "stay put" becomes as an answer.
 *
 * The settled gate matters as much as the quiet one. A standoff is a claim about BOTH sides
 * having stopped: while the mobs are still reacting - unjamming, re-pathing, chasing - the
 * position is still resolving itself, and pressuring the bot to abandon a verdict the board
 * has not finished answering is exactly the churn that produced the oscillation bugs. So the
 * standoff clocks PAUSE (they do not reset) while any mob is moving, and only accrue once the
 * mobs have parked.
 *
 * Incoming fire deliberately does NOT reset the clocks. It used to, and that exception was
 * exactly what the prayer camp exploited: parked on one tile, firing nothing, praying against
 * everything that came in, the old decay read the incoming shots as "activity" and forgave the
 * camp every tick - so the one standoff that actually kills (full-hp mobs, prayer 0) was the
 * one it could not touch. A second mechanism existed to cover that case (run-away pressure, a
 * grid-wide tilt away from the mobs after 15 parked ticks); it is replaced by this clock, which
 * covers both standoffs with one rule: only the player fighting back forgives a camp.
 *
 * TWO slots, not one: the PREVIOUS camp keeps its accumulated charge while the current one
 * accrues. With a single slot the decay produced a two-tile shuffle - nudged off tile A, the
 * bot hopped to B, A instantly read clean again, so five ticks later it hopped straight back,
 * forever. Remembering A's charge means returning to it is no escape, and the bot has to find
 * a genuinely different answer. Two slots is deliberate and enough: the failure mode is the
 * A-B oscillation, and a third camp means the bot is actually exploring. Moving back onto the
 * remembered tile swaps the slots, so its clock RESUMES rather than restarts.
 *
 * The decay is applied to the SCORE only, not recorded in ScoreParts - so while it is active,
 * the dumped score of a charged tile reads lower than the sum of its columns. That gap IS the
 * decay.
 */
export const TILE_DECAY_PER_STEP = 0.01;
export const TILE_DECAY_INTERVAL_TICKS = 5;

/** A camped tile and how long it has been camped - see the two-slot note above. */
interface DecaySlot {
  x: number;
  y: number;
  ticks: number;
}

/** The tile being camped right now, and the one camped before it. */
let currentCamp: DecaySlot | null = null;
let previousCamp: DecaySlot | null = null;
/** World tick the clocks were last advanced on, so double scoring in one tick counts once. */
let idleObservedAtTick = -1;
/** Last tick's live-mob positions, for the settled gate - see the header above. */
let lastBoardSignature = "";

function updateStandStillDecay(region: Region, player: Player) {
  const tick = region.world?.globalTickCounter ?? -1;
  if (tick === idleObservedAtTick) {
    return; // the debug grid can score again in the same tick; the clocks only move once
  }
  idleObservedAtTick = tick;

  const mobs = visibleMobs(region);
  const mobsAlive = mobs.some((mob: Mob) => mob.dying === -1);
  // Fired recently: attackDelay is the weapon cooldown counting down from the last shot.
  const attacking = (player.attackDelay ?? 0) > 0;

  // Settled: no live mob moved since the previous tick. The clocks below are claims about a
  // standoff, and a standoff needs both sides stopped - see the header.
  const signature = mobs
    .filter((mob: Mob) => mob.dying === -1)
    .map((mob: Mob) => `${mob.location.x},${mob.location.y}`)
    .join(";");
  const settled = signature !== "" && signature === lastBoardSignature;
  lastBoardSignature = signature;

  // Only fighting back forgives a camp - incoming fire deliberately does not, see the header.
  if (!mobsAlive || attacking) {
    currentCamp = null;
    previousCamp = null;
    return;
  }
  if (!settled) {
    return; // the mobs are still reacting: the clocks pause, none resets
  }

  const px = player.location.x;
  const py = player.location.y;

  if (currentCamp && currentCamp.x === px && currentCamp.y === py) {
    // Still standing where we were - the camp deepens. A tick spent MOVING never lands here
    // (the tile changed), which is the lesson of the bloblet-kiting bug: a stand-still decay
    // may only count ticks spent standing.
    currentCamp.ticks++;
    return;
  }

  if (previousCamp && previousCamp.x === px && previousCamp.y === py) {
    // Back on the remembered tile: swap, and its clock RESUMES from where it left off -
    // returning must not read as a fresh start or the A-B shuffle pays out again.
    const swap = previousCamp;
    previousCamp = currentCamp;
    currentCamp = swap;
    return;
  }

  // A genuinely new tile: the old camp becomes the remembered one, keeping its charge.
  previousCamp = currentCamp;
  currentCamp = { x: px, y: py, ticks: 0 };
}

function slotDecay(slot: DecaySlot | null): number {
  if (!slot) {
    return 0;
  }
  return Math.floor(slot.ticks / TILE_DECAY_INTERVAL_TICKS) * TILE_DECAY_PER_STEP;
}

/** The decay charged against a specific tile: non-zero only for the two remembered camps. */
export function standStillDecayAt(x: number, y: number): number {
  if (currentCamp && currentCamp.x === x && currentCamp.y === y) {
    return slotDecay(currentCamp);
  }
  if (previousCamp && previousCamp.x === x && previousCamp.y === y) {
    return slotDecay(previousCamp);
  }
  return 0;
}

/** The decay on the current camp - kept for probes and debugging readouts. */
export function standStillDecay(): number {
  return slotDecay(currentCamp);
}

function chebyshevDistance(a: Location, b: Location): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Distance to the nearest of `targets`, or Infinity when there is nothing on the board. */
function nearestMobDistance(destination: Location, targets: ReachTarget[]): number {
  let nearest = Infinity;
  for (const target of targets) {
    const distance = chebyshevDistance(destination, target);
    if (distance < nearest) {
      nearest = distance;
    }
  }
  return nearest;
}

/**
 * Chebyshev distance from the player to the nearest live mob, or null when nothing is visible.
 *
 * The exact number `safeSpot` only ever shows through a rounded, recoloured tile label - this is
 * that same input read out directly, for DebugPanel.
 */
export function distanceToNearestMob(region: Region, player: Player): number | null {
  const distance = nearestMobDistance(player.location, reachTargets(player, visibleMobs(region)));
  return Number.isFinite(distance) ? distance : null;
}

/**
 * The score with its terms kept separate, purely so a dump can show WHY a tile scored what it
 * did. A total of 0 is ambiguous on its own - it can mean nothing applied, or that several terms
 * cancelled - and those are very different situations.
 *
 * `threats` is the raw count of attacks the simulation produced BEFORE prayer was planned against
 * them, which is the one thing the total can never show: it separates "nothing ever fired"
 * (0 threats) from "things fired and prayer covered them" (threats > 0, damageTaken 0). Both
 * score 0 on the damage term - and both can now earn safeSpot, provided the destination itself
 * stays out of everything's reach once the player is standing on it.
 */
export interface ScoreParts {
  barrageReach: number;
  /** BLOBLET_REACH_BONUS if any bloblet is in barrage range of here - see `blobletReach`. */
  blobletReach: number;
  /**
   * Waves 67/68: 1 if the nearest still-healing Jad healer can be tagged from here - see
   * `focusHealer`. Wave 69: ZUK_HEALER_REACH_BONUS if any healer is inside BLOWPIPE range AND the
   * weapon is off cooldown by the time this tile can be stood on - reach with no shot behind it
   * pays for a walk that buys nothing.
   */
  healerReach: number;
  npcReachSoon: number;
  /** QUIET_TICK_BONUS per counted tick, on safespot tiles only - zero everywhere else. */
  quietTicks: number;
  /** `LOS_BONUS` shared between everything that can shoot this tile; 0 without reach. */
  losBonus: number;
  safeSpot: number;
  /** Zero, or negative HOME_PULL_PER_TILE per tile from the wave's home tile (67/68 only). */
  homePull: number;
  /**
   * Zero, or negative LAST_NPC_HOME_PULL_PER_TILE per tile beyond LAST_NPC_HOME_FREE_TILES
   * from home, capped at LAST_NPC_HOME_PULL_CAP - and only while exactly one live npc is in
   * the arena. See the constants.
   */
  lastNpcHomePull: number;
  /** ZUK_SHIELD_UNCOVERED_PENALTY if this route ends uncovered; 0 on every wave but 69. */
  shieldPenalty: number;
  /** A thousandth of a point per tile of x from the shield's leading face; 69 only. */
  shieldLead: number;
  /** ZUK_BOSS_REACH_BONUS if Zuk can be shot from here while Zuk is the shot's target; 69 only. */
  zukReach: number;
  /** ZUK_HEALER_AOE_PENALTY if this tile is near a live tagged-healer AOE landing; 69 only. */
  healerAoePenalty: number;
  /** ZUK_TAG_REACH_BONUS if an untagged set mob can be shot from here; 69 only. */
  tagReach: number;
  /** ZUK_SORTIE_PENALTY if this tile is a step out of cover to take a shot; 69 only. */
  sortie: number;
  /** ZUK_SPAWN_REACH_BONUS per spawn tile this tile can shoot, with a pair due; 69 only. */
  spawnReach: number;
  damageTaken: number;
  threats: number;
}

/**
 * How good this move is. Higher is better.
 *
 * This scores a MOVE, not a tile: the damage taken walking there counts too, because the player
 * really does stand on those tiles on those ticks and really is shot at there.
 */
function scoreRoute(
  snapshot: ArenaSnapshot,
  mobs: SimMob[],
  focus: NibblerThreat | null,
  /** Ticks until the weapon is off cooldown - see `barrageReach`, its only consumer. */
  cooldownTicks: number,
  bloblets: ReachTarget[],
  healer: ReachTarget | null,
  home: Location | null,
  /** Home again, but only while one live npc remains - null otherwise. See the constants. */
  lastNpcHome: Location | null,
  targets: ReachTarget[],
  reaches: Map<string, number>,
  route: Location[],
): { score: number; parts: ScoreParts } {
  // Reach is judged INSIDE the trajectory, against mobs the simulation has already stepped
  // forward, on the ticks the player is genuinely standing on the tile being scored.
  //
  // Judging it outside - against mob.location frozen at tick 0 - meant one score was being
  // computed on two different clocks. The damage half knew a mob walks towards you and priced
  // three attacks for it; the reach half thought the same mob had never moved, and reported that
  // you could not hit something that was in the act of closing on you. Measured: a tile with
  // `threats: 3` and `reach: 0`, in range at 5 tiles with only a pillar corner between them,
  // where the mob steps out of that shadow within the window.
  //
  // Arrival and patience are separate constants - see their definitions. The arrival gate is what
  // stops a tile being credited for reach that exists only at a waypoint its route passes over.
  const destination = route[route.length - 1];
  const arrivesInWindow =
    route.length - 1 <= PLAYER_TILES_PER_TICK * NPC_REACH_ARRIVAL_TICKS;

  /**
   * Standing inside a mob's footprint. Nothing can be attacked from here.
   *
   * The engine is unambiguous: `LocationUtils.closestPointTo` returns the player's OWN tile
   * when the player is inside the footprint, and `hasLineOfSight` from a tile to itself trips
   * its `collisionMath` guard and returns false. `isAttackable` therefore refuses, and so does
   * the mob in the other direction - being underneath is the one place neither side can act.
   *
   * The reach test could not see that, because it runs INSIDE the simulation and the
   * simulation has already moved. `simulateTrajectory` steps mobs before it calls back, and
   * `stepMob` always shuffles a mob off a player standing under it - so by the time reach was
   * judged the mob had stepped aside and the tile banked a point for a shot that cannot be
   * taken while standing there, on the strength of a shuffle whose direction is a coin flip.
   *
   * Judged at tick 0, against where the mobs really are, for the same reason `barrageReach`
   * is: this is a claim about the tile as it is now, not about a future the projection made up.
   */
  const destinationUnderMob = mobs.some((mob) =>
    playerIsUnder(mob, destination.x, destination.y),
  );

  /**
   * The mobs we are standing inside RIGHT NOW - the ones that will shuffle blindly this tick.
   *
   * Read off route[0], the tile the player is on, so it is the same answer for all 441
   * candidates: it describes the situation being escaped from, not the tile being scored.
   * Empty on every tick that is not an escape, which is what keeps the rule below off the
   * rest of the board.
   */
  const shufflers = mobs.filter((mob) => playerIsUnder(mob, route[0].x, route[0].y));

  /**
   * Somewhere a shuffling mob could be standing next tick: its footprint dilated by
   * UNDER_MOB_SHUFFLE_TILES on every side, which is the union of the engine's four equally
   * likely outcomes. Claiming a shot from inside this ring is claiming one roll out of four.
   */
  const withinShuffleReach = (mob: SimMob, x: number, y: number) =>
    x >= mob.x - UNDER_MOB_SHUFFLE_TILES &&
    x <= mob.x + mob.size - 1 + UNDER_MOB_SHUFFLE_TILES &&
    y <= mob.y + UNDER_MOB_SHUFFLE_TILES &&
    y >= mob.y - mob.size + 1 - UNDER_MOB_SHUFFLE_TILES;

  /**
   * Escaping, and this destination is somewhere the shuffle can still reach - so it is not an
   * escape. Judged on tick-0 positions and pure geometry: unlike everything else that has been
   * tried here it asks nothing of the projection, which is precisely the part that was lying.
   */
  const insideShuffleRange = shufflers.some((mob) =>
    withinShuffleReach(mob, destination.x, destination.y),
  );

  // Reach means: standing on this tile, the engine would actually let a shot off at a mob -
  // either where it stands right now, or where the simulation walks it within
  // NPC_REACH_WINDOW_TICKS of our arrival. `snapshotPlayerCanSeeMob` is the same test
  // `isAttackable` makes against the live region, so a claimed shot is one the engine allows.
  //
  // Judging against projected positions is only honest because `stepMob` now carries the
  // engine's "corner safespotting" rule. Before it did, a bat jammed against a pillar corner -
  // its step cancelled by that rule every single tick - was projected one tile into view, the
  // tile scored reach 1 for a shot that could never be taken, and the bot camped it clicking
  // attack until its prayer ran out. The window is a claim about where mobs WILL be; it is only
  // as good as the movement model, and the movement model is only as good as its agreement
  // with the engine.
  let npcReachSoon = 0;

  // Safe-spot evidence, gathered from the simulation. `arrived` because a route the horizon
  // never delivers us to the end of has shown nothing about its destination; a tile we never
  // reached cannot be called safe.
  let arrived = false;
  let arrivalTick = 0;
  /**
   * Did the player end up inside a footprint at any point on this move?
   *
   * Two questions in one flag, because they turn out to be the same question asked on
   * different ticks:
   *
   *  - THE WALK. The shuffle is not a property of where we start, it is a property of the
   *    player being inside a footprint when the mob takes its step - and `stepMob` asks that
   *    every tick, so a route clipping a footprint on its way past rolls the dice mid-walk.
   *    From that tick on, every projected position is one of four outcomes rather than a
   *    prediction, and a reach claim resting on them describes a board with a one-in-four
   *    chance of existing.
   *  - ARRIVAL. Away from the player a mob's step has no RNG in it at all -
   *    `getNextMovementStep` is `sign(player - mob)` per axis with the corner rule - so the
   *    projection genuinely knows where a chaser ends up. A meleer closes a tile a tick while
   *    we cover two, which puts the tiles just outside his footprint exactly where he will be
   *    standing when we get there. Scored on tick-0 geometry they look like a shot and deliver
   *    us back underneath him.
   *
   * Tested before the walking ticks are discarded and before `arrived` is set, so the arrival
   * tick is included - which is why the separate arrival flag this replaced was redundant.
   *
   * Cheaper than it looks: it rides the trajectory that was going to run anyway.
   */
  let walkedUnderMob = false;

  /**
   * Every attacker that has this destination in sight and range at ANY tick from arrival to
   * the end of the horizon - the mobs that will get to shoot at us for standing here.
   *
   * Distinct mobs, over the whole window, and both halves of that matter. Counting a single
   * tick was wrong for the reason every other one-instant judgement in this file was wrong:
   * the mobs are still walking when we arrive, so a tile one mob can see on the arrival tick
   * and three can see four ticks later reads as quiet at exactly the moment it is being
   * surrounded. And counting the WORST tick rather than the distinct set would miss two mobs
   * that take turns - each alone on its tick, both shooting us.
   *
   * `mob.attacks` filters out anything that cannot hurt us (nibblers chase pillars), and
   * `mobSeesPlayer` is line of sight AND range, so this is "will shoot me here" rather than
   * "is pointing this way". Identity works as a set key because `simulateTrajectory` copies
   * the mobs once and steps the same objects every tick.
   */
  const watchers = new Set<SimMob>();
  // Everything that could possibly join the set - the losBonus divisor's ceiling, and the
  // "is there anything to be safe from at all" test both safeSpot and quietTicks gate on.
  const attackerCount = mobs.reduce((total, mob) => (mob.attacks ? total + 1 : total), 0);

  // Play the walk forward twelve ticks once, then plan the best overhead sequence against
  // whatever fires. What survives that plan is what this move actually costs - and whether
  // the DESTINATION stays out of everything's reach is what safeSpot reads off the same
  // simulation, for free.
  const threats = simulateTrajectory(
    snapshot,
    mobs,
    route,
    undefined,
    (tick, simMobs, px, py) => {
      // Asked before the walking ticks are discarded, because this one IS about them - and
      // before `arrived` is set, which is what makes the arrival tick fall out of the same
      // line rather than needing a flag of its own.
      //
      // Deliberately unguarded, so it keeps firing after arrival too: a mob that walks onto
      // us while we stand there has put the projection back on a coin flip, and a shot
      // claimed from a later tick of the window is exactly the claim this rule exists to
      // refuse. It can only ever withhold an upgrade, never retract a point - `npcReachSoon`
      // is a running max that nothing recomputes.
      if (simMobs.some((mob) => playerIsUnder(mob, px, py))) {
        walkedUnderMob = true;
      }

      // Judged standing on the destination; ticks spent walking say nothing about the tile.
      if (px !== destination.x || py !== destination.y) {
        return;
      }
      if (!arrived) {
        arrived = true;
        arrivalTick = tick;
      }

      // The player half: from arrival, the mobs get NPC_REACH_WINDOW_TICKS to be somewhere
      // the engine would let us shoot them. Counted FROM ARRIVAL rather than from the start
      // of the simulation, so the player's walking budget and the mobs' approach budget are
      // independent knobs - a far tile no longer spends its mob patience on its own walk.
      //
      // The scan runs until a FULL point is found rather than until any point is found - see
      // NPC_REACH_BONUS. Stopping at the first reachable mob would let a blob standing between
      // us and a bat decide the tile is a half-point one, when the shot we would actually take
      // from there is the bat.
      // Three refusals for the same fact - a tile with a mob standing on it is a tile nothing
      // can be shot from - asked of the three moments the answer can differ:
      //
      //   destinationUnderMob  now, real positions          (tick 0)
      //   walkedUnderMob       anywhere on the way, arrival included
      //   insideShuffleRange   anywhere the coin flip can land, and only while we are under
      //                        a mob, because that is the only time the engine rolls one
      //
      // The first two are cheap facts. The third is pessimism, confined to the case that
      // earns it - see UNDER_MOB_SHUFFLE_TILES.
      if (
        arrivesInWindow &&
        !destinationUnderMob &&
        !walkedUnderMob &&
        !insideShuffleRange &&
        npcReachSoon < NPC_REACH_BONUS &&
        tick - arrivalTick <= NPC_REACH_WINDOW_TICKS
      ) {
        for (const mob of simMobs) {
          const reach = reaches.get(mob.name);
          if (reach === undefined) {
            continue;
          }
          if (snapshotPlayerCanSeeMob(snapshot, px, py, mob.x, mob.y, mob.size, reach)) {
            // isBlob is the parent JAL_AK only - a ghost never sets it, and the three bloblets
            // it leaves are their own mobs at the full bonus, as `blobletReach` also treats
            // them. The full point goes to the mager and the bloblets; every other fight is
            // the lesser tier - see NPC_REACH_BONUS for the ladder.
            npcReachSoon = Math.max(
              npcReachSoon,
              mob.isBlob
                ? BLOB_REACH_BONUS
                : mob.name === EntityNames.JAL_ZEK ||
                    BLOBLET_NAMES.includes(mob.name)
                  ? NPC_REACH_BONUS
                  : NPC_REACH_LESSER_BONUS,
            );
            if (npcReachSoon >= NPC_REACH_BONUS) {
              break;
            }
          }
        }
      }

      // The mob-side half: from arrival to the end of the horizon, does anything that shoots
      // at us ever have this tile in its sights? Geometric, not observational - a mob mid
      // attack-cooldown fires no shot the sim could record, but it holds the tile at gunpoint
      // all the same. Judged against the PROJECTED positions on each tick, so a meleer that
      // will walk around the pillar during the window correctly spoils the tile.
      if (watchers.size < attackerCount) {
        for (const mob of simMobs) {
          if (!mob.attacks || watchers.has(mob)) {
            continue;
          }
          if (mobSeesPlayer(snapshot, mob, px, py)) {
            watchers.add(mob);
          }
        }
      }
    },
  );
  // Exposure is now just "did anything ever have it": one gathering pass, so the safe-spot
  // test and the watcher count can never disagree about who can see this tile.
  const destinationExposed = watchers.size > 0;

  /**
   * A healer's hit only prices if it lands on the very NEXT tick - discarded past that, no
   * matter how far into the horizon the projection sees one catching up.
   *
   * Everything else in `damageTaken` keeps the full 12 ticks; this is deliberately narrower,
   * because a healer is not like the rest of the board. Jad hits everywhere (range 50), a
   * mager or ranger parks once it acquires and stays a fixed threat - but a HEALER is a
   * chaser whose position twelve ticks out is the projection's guess, not a fact, and pricing
   * that guess as a real cost on every candidate tile is what sent the bot sprinting real
   * distance to dodge a hit still eight ticks away. Measured (wave 68, dump): every tile
   * within reach of a chasing healer's eventual catch-up scored worse than one seven tiles
   * further out, by exactly the avoided hit's max hit - the bot was buying a temporary
   * reprieve at the cost of DPS uptime against Jad, re-buying the same reprieve every tick,
   * forever.
   *
   * Scoring re-runs from scratch next tick with a real position instead of a projection, so a
   * catch-up eight ticks out will be priced honestly when it is actually one or two ticks out
   * - nothing is lost by not reacting to it now. Scoped to healers by name; every other
   * chaser's full-horizon price is untouched.
   */
  const priced = threats.filter(
    (threat) => threat.name !== EntityNames.YT_HUR_KOT || threat.tick <= 2,
  );
  const damageTaken = planOverheads(priced).damage;

  // Safe means: something is on the board to be safe FROM, the walk is clean (whatever fires
  // en route, the planned overheads stop all of it), nothing has the tile in range for the
  // rest of the horizon - and the tile stays that way once the mobs have finished reacting to
  // us standing on it, which is what `settlesSafe` extends the simulation to prove. The
  // horizon evidence runs first because it is already paid for; the settle pass only runs for
  // tiles that survive everything else.
  // Never under a mob. Being inside a footprint LOOKS perfectly safe - the mob cannot attack
  // what it is standing on, so nothing fires and nothing watches - but it is safe for exactly
  // one tick: `stepMob` reproduces the engine shuffling the mob off the player, and the
  // direction of that shuffle is a coin flip nothing can predict. Measured on a size 4 meleer:
  // its whole 4x4 footprint scored 2 to 2.79 - reach 1, los 1 (nothing can see you), safe 0.78
  // - the best tiles on the grid, from a position where the bot can neither hit nor be hit.
  let safeSpot = 0;
  if (
    !destinationUnderMob &&
    attackerCount > 0 &&
    arrived &&
    !destinationExposed &&
    damageTaken === 0 &&
    settlesSafe(snapshot, mobs, route)
  ) {
    const distance = nearestMobDistance(destination, targets);
    // No mob on the board at all - nothing to be far from, so the bonus applies untaxed.
    const penalty = Number.isFinite(distance) ? NPC_DISTANCE_PENALTY * distance : 0;
    safeSpot = Math.max(SAFE_SPOT_MIN, SAFE_SPOT_BONUS - penalty);
  }

  // Safespots only. The count is off on every other tile - the whole `safeSpot` test is the
  // gate, so it carries the under-a-mob refusal, the "something to be safe from" requirement,
  // the arrival check and the settle proof with it, and this term adds no conditions of its
  // own. On a tile that passes, what the count then measures is the walk: the scan clock runs
  // from now, so ticks spent getting there are ticks the tile does not get to bank, and a
  // safespot two tiles away is worth more than the same safespot eight tiles away.
  const quietTicks = safeSpot > 0 ? QUIET_TICK_BONUS * quietTicksFor(snapshot, mobs, route) : 0;

  // Only where a shot is actually available - see LOS_BONUS. Divided by everything that gets
  // to shoot back across the whole post-arrival window, not by a single tick's worth.
  const losBonus = npcReachSoon > 0 ? LOS_BONUS / Math.max(1, watchers.size) : 0;

  const parts: ScoreParts = {
    barrageReach: barrageReach(snapshot, focus, cooldownTicks, route),
    // The bloblet pull: the nibbler rule with the focus pick dropped, since one blast is meant
    // for the whole landing trio. Zero whenever no blob has died, so it costs nothing elsewhere.
    blobletReach: blobletReach(snapshot, bloblets, route),
    // The Jad-wave pull: 1 if the focus healer - nearest one still healing - can be tagged
    // from this destination. Same shape as barrageReach, same under-mob refusal as reach.
    healerReach:
      healer && !destinationUnderMob
        ? snapshotPlayerCanSeeMob(
            snapshot,
            destination.x,
            destination.y,
            healer.x,
            healer.y,
            healer.size,
            healer.reach,
          )
          ? 1
          : 0
        : 0,
    npcReachSoon,
    quietTicks,
    losBonus,
    safeSpot,
    // Negative or zero: the drift anchor for the open-arena waves - see HOME_PULL_PER_TILE.
    homePull: home ? -HOME_PULL_PER_TILE * chebyshevDistance(destination, home) : 0,
    // Negative or zero, and only with one live npc left - see LAST_NPC_HOME_PULL_PER_TILE.
    lastNpcHomePull: lastNpcHome
      ? -Math.min(
          LAST_NPC_HOME_PULL_CAP,
          LAST_NPC_HOME_PULL_PER_TILE *
            Math.max(
              0,
              chebyshevDistance(destination, lastNpcHome) - LAST_NPC_HOME_FREE_TILES,
            ),
        )
      : 0,
    // Both wave-69 terms live in `scoreZukTiles` now and cannot reach this path - wave 69
    // returns before the loop that calls this. Kept on ScoreParts at zero rather than deleted:
    // DebugPanel dumps every field, and the Zuk harness reads `shieldPenalty` to decide whether
    // the player was behind cover.
    shieldPenalty: 0,
    shieldLead: 0,
    zukReach: 0,
    healerAoePenalty: 0,
    tagReach: 0,
    spawnReach: 0,
    sortie: 0,
    damageTaken,
    // priced.length, not threats.length - the dump's threat count should match what was
    // actually charged, or a healer-chase-eight-ticks-out would read as a threat that costs
    // nothing, which is confusing to debug against.
    threats: priced.length,
  };

  return {
    score:
      parts.barrageReach +
      parts.blobletReach +
      parts.healerReach +
      parts.npcReachSoon +
      parts.quietTicks +
      parts.losBonus +
      parts.safeSpot +
      parts.homePull +
      parts.lastNpcHomePull +
      parts.shieldPenalty +

      parts.healerAoePenalty -
      parts.damageTaken,
    parts,
  };
}

export interface ScoredTile {
  tile: Location;
  score: number;
  /**
   * The walk this score was computed for.
   *
   * Carried rather than recomputed so the prayer layer can plan against the route the bot is
   * actually taking. Planning against standing still gets THIS tick right either way - mobs
   * fire before the player moves, so tick one is resolved from the current tile - but a blob
   * steer reaches three ticks ahead, where the two futures differ.
   */
  route: Location[];
  /**
   * The score's terms, kept separate for diagnostics. Optional so a caller building a
   * ScoredTile by hand - the harness tests do - does not have to supply them.
   */
  parts?: ScoreParts;
}

/**
 * Score every candidate move.
 *
 * Routes come from a single breadth-first sweep rather than one pathfind per tile, which is what
 * keeps this inside a tick once there is real scoring to do.
 *
 * `snapshot` is a parameter so a caller that already built one this tick can hand it over.
 * Constructing it walks every entity in the region, and both this and the target scorer need it.
 */
/** Every term at zero, for a scorer that only fills one of them in. */
function emptyParts(): ScoreParts {
  return {
    barrageReach: 0,
    blobletReach: 0,
    healerReach: 0,
    npcReachSoon: 0,
    quietTicks: 0,
    losBonus: 0,
    safeSpot: 0,
    homePull: 0,
    lastNpcHomePull: 0,
    shieldPenalty: 0,
    shieldLead: 0,
    zukReach: 0,
    healerAoePenalty: 0,
    tagReach: 0,
    spawnReach: 0,
    sortie: 0,
    damageTaken: 0,
    threats: 0,
  };
}

/**
 * Wave 69's score: ZUK_SHIELD_UNCOVERED_PENALTY on any tile the shield is not covering, zero on
 * the ones it is. Nothing else - see the note on ZUK_SHIELD_UNCOVERED_PENALTY.
 *
 * Routes come from the same breadth-first sweep the general scorer uses, so the walk the bot
 * takes is the engine's own pathing and `bestMove` can break ties on its real length. A tile the
 * player cannot path to is dropped rather than scored, exactly as it is on every other wave.
 *
 * With no shield on the board every tile scores zero and the grid goes flat - which is the
 * honest picture, since once the shield is gone there is no cover anywhere and no face to follow.
 */
export function scoreZukTiles(
  region: Region,
  player: Player,
  snapshot: ArenaSnapshot = new ArenaSnapshot(region),
): ScoredTile[] {
  const shield = findShield(region);
  // The mager/ranger/Jad melee zones, so the same veto waves 1-68 use applies here too. Nothing
  // else from the snapshot is read - no simulation, no damage - this is geometry only.
  const mobs = snapshotMobs(region, player, true);
  const tiles = candidateTiles(region, player, snapshot);
  const routes = routesFrom(player.location, tiles, (x, y) =>
    isInsideArena(x, y) && snapshot.canStandAt(x, y),
  );

  // The deadline. Null until Zuk has been seen to attack once - see the note above.
  const untilFire = ZukAttackClock.ticksUntilNextAttack();
  // The shield as it will be when the shot is aimed. EVERYTHING below reads this rather than the
  // shield's position now, including the leading face: the cover test and the pull towards the
  // face have to be answering the same question about the same tick, or they fight each other -
  // the face can even have flipped in between, if the shield bounces before the deadline.
  const shieldAtFire =
    shield === null ? null : untilFire === null ? shield : projectShield(shield, untilFire);
  // Unsynced only: the shield's x on each of the next few ticks, any of which could be the one
  // Zuk fires on. See ZUK_SHIELD_COVER_BUFFER_TICKS.
  const unsyncedBand: number[] = [];
  if (shield !== null && untilFire === null) {
    for (let ahead = 1; ahead <= ZUK_SHIELD_COVER_BUFFER_TICKS; ahead++) {
      unsyncedBand.push(projectShield(shield, ahead).x);
    }
  }
  // Ticks of walking available before the position is locked in - one less than the deadline,
  // because mobs step before players. Zero means "wherever you are now is what Zuk will see".
  const walkTicks = untilFire === null ? null : Math.max(0, untilFire - 1);
  // Null with no shield on the board, and null through a bounce window - both mean "no opinion
  // about x", which is exactly what a flat band is. See SHIELD_BOUNCE_PREP_TILES.
  // Null with no shield on the board, and null through a bounce window - both mean "no opinion
  // about x", which is exactly what a flat band is. See SHIELD_BOUNCE_PREP_TILES.
  const leading =
    shieldAtFire && !bounceIsClose(shieldAtFire) ? leadAnchorX(shieldAtFire) : null;
  // Empty unless a tagged healer has a live ghost projectile in flight - see the note above.
  const healerAoe = healerAoeLandings(region);
  // Both kinds: JalMejJak heals Zuk from the enrage, YtHurKot heals Jad. Asked once per tick.
  const healers = visibleMobs(region).filter(
    (mob) =>
      mob.dying <= -1 &&
      (mob.mobName() === EntityNames.JAL_MEJ_JAK || mob.mobName() === EntityNames.YT_HUR_KOT),
  );
  // Still on the shield, so still costing us. Aggro flips when our projectile LANDS, so a mob
  // already shot at stays here for the few ticks the shot is in the air - which is correct: it is
  // still hitting the shield until the tag actually resolves.
  const untagged = visibleMobs(region).filter(
    (mob) =>
      mob.dying <= -1 &&
      mob.aggro !== player &&
      (mob.mobName() === EntityNames.JAL_ZEK || mob.mobName() === EntityNames.JAL_XIL),
  );
  // Asked of the LONG weapon: tagging is the job and the long weapon is what reaches. The blowpipe
  // cannot reach the spawn row from y 14 at all - dy alone is 7 against its 5.
  // Asked unconditionally. It used to short-circuit to 0 when nothing was untagged, which is
  // precisely the state the spawn bonus works in - so every spawn tile would have been measured
  // against a reach of nothing and no tile would ever have earned it.
  const tagWeaponReach =
    (weaponForSet(player, "tbow") as { attackRange?: number } | null)?.attackRange ?? 0;

  // Is something untagged stranded BEHIND the band - see ZUK_STRANDED_FACE_FLIP. "Behind" is
  // the side the shield is moving away from, and "stranded" means the long weapon cannot reach
  // it from any covered column, judged against the same projected band the cover test uses.
  // Line of sight is deliberately not asked here: pretending a blocked shot is reachable only
  // fails towards the normal face preference, never towards giving up slack for nothing.
  const strandedBehind =
    ZUK_STRANDED_FACE_FLIP &&
    shieldAtFire !== null &&
    untagged.some((mob) => {
      const behind = shieldAtFire.direction
        ? mob.location.x < shieldAtFire.x
        : mob.location.x > shieldAtFire.x + ZUK_SHIELD_WIDTH - 1;
      if (!behind) {
        return false;
      }
      const lo = shieldAtFire.x;
      const hi = shieldAtFire.x + ZUK_SHIELD_WIDTH - 1;
      const dx = Math.max(lo - (mob.location.x + mob.size - 1), mob.location.x - hi, 0);
      const dy = Math.max(mob.location.y - ZUK_SHIELD_COVER_MAX_Y, 0);
      return Math.max(dx, dy) > tagWeaponReach;
    });
  // The x the tiebreak pulls towards: the trailing face while something is stranded behind the
  // band, the leading face otherwise. `leading` is null through a bounce window; the stranded
  // anchor deliberately is not - `trailAnchorX` is direction-correct mid-bounce, and the drift
  // away from a stranded mob is exactly when the pull is being paid for.
  const faceAnchor =
    strandedBehind && shieldAtFire !== null ? trailAnchorX(shieldAtFire) : leading;

  /**
   * Ticks to walk from a tile back into cover, for the shield as it will be when Zuk fires.
   *
   * The covered band at that tick is contiguous - `shieldAtFire.x` to `+4`, less the trailing tile
   * the next step abandons - so the return is just the distance to that range, plus whatever it
   * takes to get back under y 16.
   */
  const ticksBackToCover = (tile: Location): number | null => {
    if (shieldAtFire === null) {
      return 0; // no shield on the board: nothing to return to, and nothing to hide from
    }
    const trailing = trailAnchorX(shieldAtFire);
    const lo = shieldAtFire.direction ? shieldAtFire.x + 1 : shieldAtFire.x;
    const hi = shieldAtFire.direction
      ? shieldAtFire.x + ZUK_SHIELD_WIDTH - 1
      : shieldAtFire.x + ZUK_SHIELD_WIDTH - 2;
    if (lo > hi || trailing < lo - 1) {
      return null; // no covered tile to come back to
    }
    const dx = tile.x < lo ? lo - tile.x : tile.x > hi ? tile.x - hi : 0;
    const dy = tile.y > ZUK_SHIELD_COVER_MAX_Y ? tile.y - ZUK_SHIELD_COVER_MAX_Y : 0;
    return Math.ceil(Math.max(dx, dy) / ZUK_TILES_PER_TICK);
  };

  // Only inside the window, and only while there is nothing already on the board to shoot -
  // once a pair is live, `tagReach` is the better question because it knows where they actually
  // are rather than where they were going to be.
  const untilSet = ZukSetTimer.ticksUntilSet();
  const spawnDue =
    untagged.length === 0 &&
    untilSet !== null &&
    !ZukSetTimer.isPaused() &&
    untilSet <= ZUK_SPAWN_PREP_TICKS;

  // IS ZUK WHAT THE SHOT WOULD ACTUALLY GO TO? The boss-reach bonus and the sortie it can earn
  // are bribes to walk somewhere, so they are only paid while the attack layer would spend the
  // shot on Zuk on arrival. Its hold ladder is mirrored here - see ZUK_BOSS_REACH_BONUS:
  //
  //   - anything untagged or any healer alive: those bands outrank Zuk and have their own pulls
  //   - the ranger alive at all: it is killed outright before Zuk, wherever it stands
  //   - the mager alive under ZUK_CLEAR_SET_HP: the set is being cleared to the last one
  //   - pre-enrage, pair imminent, Zuk under ZUK_HOLD_SET_HP: hitpoints are being banked
  //   - `spawnDue`: the attack layer is holding fire for the spawn whatever is in reach
  //
  // Enrage is read as "under ZUK_ENRAGE_HP" rather than latched the way the automation latches
  // it - a healer can push Zuk back over the line after the latch fired - but any healer that
  // could is blocking this gate by being alive, and once the last one is dead hitpoints only
  // fall. At worst the mismatch withholds the bonus for a few ticks, never lures a walk out.
  let zukRangerAlive = false;
  let zukMagerAlive = false;
  let zukMob: Mob | undefined;
  for (const mob of visibleMobs(region)) {
    if (mob.dying > -1) {
      continue;
    }
    const name = mob.mobName();
    if (name === EntityNames.JAL_XIL) {
      zukRangerAlive = true;
    } else if (name === EntityNames.JAL_ZEK) {
      zukMagerAlive = true;
    } else if (name === EntityNames.TZ_KAL_ZUK) {
      zukMob = mob;
    }
  }
  const zukHp = zukMob?.currentStats?.hitpoint ?? 0;
  const setImminent =
    untilSet !== null && !ZukSetTimer.isPaused() && untilSet <= ZUK_HOLD_SET_TICKS;
  const zukShotWanted =
    zukMob !== undefined &&
    zukHp > 0 &&
    untagged.length === 0 &&
    healers.length === 0 &&
    !zukRangerAlive &&
    !(zukMagerAlive && zukHp < ZUK_CLEAR_SET_HP) &&
    !(zukHp >= ZUK_ENRAGE_HP && zukHp < ZUK_HOLD_SET_HP && setImminent) &&
    !spawnDue;

  const blowpipeReach =
    healers.length === 0
      ? 0
      : (weaponForSet(player, "blowpipe") as { attackRange?: number } | null)?.attackRange ?? 0;
  // Ticks until the weapon can fire again, which is what turns "reaches a healer" into "can
  // actually tag one from there". Null when nothing has been observed yet - treated as no
  // objection rather than as a refusal, since an unknown cooldown is not evidence of one.
  const untilShot = PlayerAttackClock.earliestShotOffset();

  const sortieReport: SortieDebug = {
    canTag: 0,
    canTagCovered: 0,
    sorties: 0,
    bestTrip: null,
    walkTicks,
    refusedFor: null,
  };

  const scored: ScoredTile[] = [];
  for (const tile of tiles) {
    const route = routes.get(routeKey(tile.x, tile.y));
    if (!route) {
      continue; // walled off from the player, so not actually a candidate
    }
    // DROPPED, NOT SCORED BADLY, exactly as on every other wave. Standing beside a mager makes
    // its attack a coin flip between magic and stab (`canMeleeIfClose` re-rolled at fire time),
    // and a 50/50 cannot be prayed - half-praying is not a thing. Pricing that at its average is
    // the one treatment that makes no sense, so the tile is not an option at all. Exit is still
    // allowed and holding position is never blocked - see routeEntersForbiddenZone.
    if (routeEntersForbiddenZone(mobs, route)) {
      continue;
    }
    const parts = emptyParts();
    // Reachable in time? A destination that is covered but cannot be stood on before the shot is
    // aimed protects nothing, so it is charged exactly like an uncovered one.
    const arrivalTicks = Math.ceil((route.length - 1) / ZUK_TILES_PER_TICK);
    const inPlace = walkTicks === null || arrivalTicks <= walkTicks;
    const safe =
      shieldAtFire === null ||
      (inPlace &&
        isCoveredByShield(tile.x, tile.y, shieldAtFire.x) &&
        // THE TRAILING TILE IS NOT COVER. It is inside the band by TzKalZuk's own test and the
        // shield's very next step leaves it behind, so treating it as safe banks zero ticks and
        // is what puts the bot one tile short when the window opens. EXCEPT while something is
        // stranded behind the band - then the zero ticks of slack are being spent on purpose.
        // See ZUK_STRANDED_FACE_FLIP.
        (strandedBehind || tile.x !== trailAnchorX(shieldAtFire)) &&
        unsyncedBand.every((x) => isCoveredByShield(tile.x, tile.y, x)));
    // Can this tile shoot something still on the shield? Asked before cover, because it is what
    // decides whether leaving cover is worth considering at all.
    const canTag =
      untagged.length > 0 &&
      untagged.some((mob) =>
        snapshotPlayerCanSeeMob(
          snapshot,
          tile.x,
          tile.y,
          mob.location.x,
          mob.location.y,
          mob.size,
          tagWeaponReach,
        ),
      );
    // The same question asked of the boss, in the ticks where the boss is the answer - see
    // zukShotWanted. Asked of the long weapon exactly like the tag, because Zuk is the fallback
    // set's target and on a crossbow build reach is the whole problem this term exists for.
    const canHitZuk =
      zukShotWanted &&
      zukMob !== undefined &&
      snapshotPlayerCanSeeMob(
        snapshot,
        tile.x,
        tile.y,
        zukMob.location.x,
        zukMob.location.y,
        zukMob.size,
        tagWeaponReach,
      );

    // THE ROUND TRIP. See ZUK_SORTIE_PENALTY.
    //
    //   out    reaching the firing tile
    //   shoot  one tick that clicks the NPC instead of a walk - a tick cannot do both
    //   back   returning to the band as it will be at the fire tick
    //
    // Plus ZUK_SORTIE_SAFETY. And the weapon has to be up by the time we are stood there, or the
    // trip buys nothing and we have left cover to watch a cooldown run down.
    //
    // A Zuk shot earns the trip on exactly the same terms as a tag - see ZUK_BOSS_REACH_BONUS.
    // The shot is worth less than a tag, but the trip is priced the same way and the budget is
    // the same clock; the after-the-shot cooldown is what walks the bot straight back, because
    // `untilShot` stops fitting and the tile falls back to the -1000.
    const backTicks = ticksBackToCover(tile);
    const sortie =
      !safe &&
      (canTag || canHitZuk) &&
      walkTicks !== null &&
      backTicks !== null &&
      shieldAtFire !== null &&
      arrivalTicks + 1 + backTicks + ZUK_SORTIE_SAFETY <= walkTicks &&
      (untilShot === null || untilShot <= arrivalTicks + 1);

    if (canTag) {
      sortieReport.canTag++;
      if (safe) {
        sortieReport.canTagCovered++;
      } else if (backTicks !== null && walkTicks !== null) {
        const trip = arrivalTicks + 1 + backTicks + ZUK_SORTIE_SAFETY;
        if (sortieReport.bestTrip === null || trip < sortieReport.bestTrip) {
          sortieReport.bestTrip = trip;
          sortieReport.refusedFor =
            trip > walkTicks
              ? `trip ${trip} > budget ${walkTicks}`
              : untilShot !== null && untilShot > arrivalTicks + 1
                ? `weapon ready in ${untilShot}, stood there at ${arrivalTicks + 1}`
                : null;
        }
      }
      if (sortie) {
        sortieReport.sorties++;
      }
    }

    parts.sortie = sortie ? ZUK_SORTIE_PENALTY : 0;
    // Safe tiles only. A tile that reaches the spawn but does not survive the next shot is not a
    // firing position, it is a death with good sightlines.
    parts.spawnReach =
      safe && spawnDue
        ? ZUK_SPAWN_TILES.filter((spawn) =>
            snapshotPlayerCanSeeMob(snapshot, tile.x, tile.y, spawn.x, spawn.y, 1, tagWeaponReach),
          ).length * ZUK_SPAWN_REACH_BONUS
        : 0;
    parts.tagReach = canTag && (safe || sortie) ? ZUK_TAG_REACH_BONUS : 0;
    parts.zukReach = canHitZuk && (safe || sortie) ? ZUK_BOSS_REACH_BONUS : 0;
    parts.shieldPenalty = safe || sortie ? 0 : ZUK_SHIELD_UNCOVERED_PENALTY;
    parts.shieldLead =
      faceAnchor === null ? 0 : -SHIELD_FACE_TIEBREAK * Math.abs(tile.x - faceAnchor);
    parts.healerAoePenalty = nearHealerAoeLanding(healerAoe, tile)
      ? ZUK_HEALER_AOE_PENALTY
      : 0;
    // REACHING A HEALER ONLY COUNTS IF THE SHOT EXISTS ON ARRIVAL.
    //
    // The bonus is a bribe to walk somewhere, so it has to be paid for a walk that buys something.
    // A tile that reaches a healer but is stood on with three ticks of cooldown still to run buys
    // nothing at the moment of arrival: the trip has been spent, the AOE has been walked into, the
    // lead on the shield face has been given up, and the dart cannot go out. The cooldown runs
    // whether the bot walks or stands, so those ticks are better spent travelling.
    //
    // STANDING STILL IS EXEMPT. `arrivalTicks` 0 is the tile already occupied, where there is no
    // trip to justify and the shot happens from here the moment the weapon comes up. Charging it
    // for the cooldown would strip the bonus off the very tile the shot is about to be taken from
    // and hand it to a tile further away - walking off a shot to go and set up for it.
    //
    // Reach is asked of the BLOWPIPE only, matching the automation's healers-are-a-blowpipe-job
    // rule, but the cooldown read is of whatever is in hand right now. A swap still to come costs
    // its own tick on top and is not modelled here.
    //
    // AND ONLY ON A TILE THAT SURVIVES ZUK, which is not the same statement as the -1000 already
    // outweighing the +1. The penalty separates a safe tile from an unsafe one; it does nothing
    // to separate two UNSAFE ones, because both carry it. Cover is a yes/no test against a single
    // future tick, so once the band has outrun the player every reachable tile scores -1000 alike
    // and the bonus becomes the only term on the board with an opinion.
    //
    // Observed, seed 9: the shield ran east while the bot traded ticks with four healers, and from
    // the moment it could no longer make the band the +1 pointed WEST, at the healers, and it
    // walked further from cover every tick until Zuk killed it. The score was buying blowpipe
    // range with a life.
    //
    // Costs nothing where it matters: a covered tile scores exactly as it did. All this removes is
    // a doomed tile being PREFERRED to another doomed tile, after which they tie and the shorter
    // walk wins - which at least stops the bot walking away from the shield.
    const shotOnArrival = arrivalTicks === 0 || untilShot === null || untilShot <= arrivalTicks;
    parts.healerReach =
      safe &&
      shotOnArrival &&
      healers.some((healer) =>
        snapshotPlayerCanSeeMob(
          snapshot,
          tile.x,
          tile.y,
          healer.location.x,
          healer.location.y,
          healer.size,
          blowpipeReach,
        ),
      )
        ? ZUK_HEALER_REACH_BONUS
        : 0;
    scored.push({
      tile,
      score:
        parts.shieldPenalty +
        parts.shieldLead +
        parts.healerAoePenalty +
        parts.tagReach +
        parts.zukReach +
        parts.spawnReach +
        parts.sortie +
        parts.healerReach,
      route,
      parts,
    });
  }
  lastSortie = sortieReport;
  return scored;
}

export function scoreCandidates(
  region: Region,
  player: Player,
  snapshot: ArenaSnapshot = new ArenaSnapshot(region),
): ScoredTile[] {
  const startedAt = performance.now();
  // WAVE 69 IS BEING REBUILT AND TAKES NONE OF THIS. Not a term switched off inside the loop
  // below - the whole 441-route simulation is skipped, so nothing downstream can quietly reach
  // it. Everything the wave used to add here (the shield lookahead, the healer AOE steer) went
  // with it; see scoreZukTiles.
  if (((region as unknown as { wave?: number }).wave ?? 0) === 69) {
    return scoreZukTiles(region, player, snapshot);
  }


  // Advance the standoff clocks exactly once per world tick, before any score is assembled.
  updateStandStillDecay(region, player);

  const tiles = candidateTiles(region, player, snapshot);
  // Routes may leave the candidate box to get around a pillar, exactly as the engine's own
  // pathfinder would, so walkability is asked of the whole arena rather than of the 441.
  const routes = routesFrom(player.location, tiles, (x, y) =>
    isInsideArena(x, y) && snapshot.canStandAt(x, y),
  );
  const focus = focusNibbler(nibblerThreats(region));
  // Ticks until the weapon is off cooldown, which is half of when the barrage at that focus
  // really leaves - see `barrageReach`. Floored at zero: `attackDelay` keeps counting DOWN past
  // zero while nothing is being fought, so a bot that has been walking for ten ticks reads -10,
  // and a negative would pull the shot tick backwards into the past.
  const cooldownTicks = Math.max(0, player.attackDelay ?? 0);
  // The Jad-wave analogue of the focus nibbler: null on every other wave, so this costs
  // nothing outside 67+.
  const healer = focusHealer(region, player);
  // The drift anchor for the open-arena waves; null everywhere else.
  const home = waveHomeTile((region as unknown as { wave?: number }).wave ?? 0);
  // Frozen once and shared by all 441 simulations. Rebuilt each call rather than cached, because
  // mobs move and pillars die.
  // Jad included: the tile score is the one consumer that has to see it hitting, or the grid
  // flattens and the bot parks in melee range. The prayer planner deliberately does not - see
  // snapshotMobs.
  const mobs = snapshotMobs(region, player, true);
  const targets = reachTargets(player, visibleMobs(region));
  const reaches = reachByMobName(player, visibleMobs(region));

  // Ghost bloblets count as mobs on the board for every purpose the SCORE has: they can be
  // reached (`npcReachSoon`), and they are something to be near or far from (the safe-spot
  // distance shading). A player watching a blob die knows three bloblets are landing on those
  // tiles and positions to fight them - refusing to score that made the grid discontinuous, as
  // the dying blob left `targets` empty, every safe tile tied at exactly SAFE_SPOT_BONUS with
  // no shading at all, and the whole ranking changed the tick they became real.
  //
  // Being scored as reachable is NOT being targetable: the attack layer reads `visibleMobs` and
  // has never heard of a ghost, so nothing tries to click one. The tile scorer positions for a
  // fight that is coming; the rest of the score still decides whether that is worth it.
  for (const ghost of mobs) {
    if (!ghost.ghost) {
      continue;
    }
    const reach = attackReachForName(player, ghost.name);
    targets.push({ x: ghost.x, y: ghost.y, size: ghost.size, reach });
    if (!reaches.has(ghost.name)) {
      reaches.set(ghost.name, reach);
    }
  }

  // Live and ghost alike, for the same reason the ghosts were added to `targets` above: the
  // tiles worth standing on for a landing trio are worth standing on before it lands.
  const bloblets = blobletTargets(mobs);

  // ONE LIVE NPC MEANS THE WALK HOME HAS STARTED - see LAST_NPC_HOME_PULL_PER_TILE. Ghost
  // bloblets count as npcs here exactly as they do everywhere else in this score: a dying blob
  // is three more npcs landing, not an arena about to be empty. Anchored to the same map the
  // between-waves station uses, so the pull and the station can never point at different tiles.
  const liveNpcs =
    visibleMobs(region).filter((mob) => mob.dying === -1).length +
    mobs.filter((mob) => mob.ghost).length;
  const lastNpcHome = liveNpcs === 1 ? home ?? HOME_TILE : null;

  const scored: ScoredTile[] = [];
  for (const tile of tiles) {
    const route = routes.get(routeKey(tile.x, tile.y));
    if (!route) {
      continue; // walled off from the player, so not actually a candidate
    }
    // Getting there means walking into a mager, ranger, blob or Jad's melee zone - so it is
    // not somewhere the bot can go, exactly like being walled off. Dropped rather than scored
    // badly, because the whole point is that no other term gets to outweigh it. See
    // routeEntersForbiddenZone, including why leaving the zone stays allowed.
    if (routeEntersForbiddenZone(mobs, route)) {
      continue;
    }
    const { score, parts } = scoreRoute(
      snapshot,
      mobs,
      focus,
      cooldownTicks,
      bloblets,
      healer,
      home,
      lastNpcHome,
      targets,
      reaches,
      route,
    );
    // The stand-still decay bites the two remembered camps only - the current tile and the
    // one camped before it - so a standoff lowers the bar for moving somewhere NEW without
    // distorting what any other tile is worth. See the constants for the rationale, including
    // why one slot was not enough.
    scored.push({ tile, score: score - standStillDecayAt(tile.x, tile.y), route, parts });
  }

  lastDurationMs = performance.now() - startedAt;
  return scored;
}

/**
 * Milliseconds the last scoring pass took.
 *
 * Surfaced rather than guessed at: this runs every tick inside a 600ms budget, and the cost is
 * hundreds of trajectories deep. If it ever approaches the tick, the horizon comes down before
 * the candidate box does.
 */
let lastDurationMs = 0;

export function lastScoreDurationMs(): number {
  return lastDurationMs;
}

/**
 * The best move to make, or holding position when nothing beats it.
 *
 * Standing still is scored as a real option rather than assumed: it is the route of length one,
 * so it goes through exactly the same simulation as every move and is directly comparable. A
 * candidate then has to clear it by the margin to win.
 *
 * The margin is measured against HOLDING POSITION, once, and is not re-applied as better
 * candidates are found. Folding it into the running maximum turned it into a ratchet - each
 * accepted candidate raised the bar for the next - so the winner depended on the order tiles
 * happened to be visited in. That was invisible only because the margin is currently zero.
 *
 * Returns the whole scored entry, route included: the caller needs the walk to plan prayer
 * against, and searching the list a second time to recover it is both wasteful and a chance for
 * the two to disagree.
 */
export function bestMove(
  region: Region,
  player: Player,
  scored?: ScoredTile[],
): ScoredTile | null {
  const candidates = scored ?? scoreCandidates(region, player);
  const here: Location = { x: player.location.x, y: player.location.y };

  const holding = candidates.find(
    (candidate) => candidate.tile.x === here.x && candidate.tile.y === here.y,
  );
  // The player's own tile is always inside the slid grid and always walkable, so this is a guard
  // rather than a case. Refusing to move is the right answer when the baseline is unknown -
  // otherwise every candidate would beat an -Infinity baseline, including a terrible one.
  if (!holding) {
    return null;
  }

  let best = holding;
  for (const candidate of candidates) {
    // Has to beat HOLDING by the margin to be worth moving to at all.
    if (candidate.score <= holding.score + IMPROVEMENT_MARGIN) {
      continue;
    }
    const better = candidate.score > best.score;
    // Ties break on the length of the walk. Without this the winner was simply whichever
    // qualifying tile came first out of candidateTiles - which scans y then x from the corner of
    // the box, so it was always the lowest-x, lowest-y tile that qualified. With a binary score
    // that ties hundreds of tiles at once, and measured, the bot walked 17 tiles to a tile that
    // scored exactly the same as one 6 tiles away.
    //
    // Route length rather than straight-line distance, because it is the real cost of getting
    // there: a tile six tiles off but behind a pillar is a longer walk than one eight tiles off
    // in the open, and the route is already computed.
    const equalButNearer =
      candidate.score === best.score && candidate.route.length < best.route.length;
    if (better || equalButNearer) {
      best = candidate;
    }
  }
  return best;
}

/** The tile `bestMove` picked, or the player's own when it has no opinion. */
export function bestTile(region: Region, player: Player, scored?: ScoredTile[]): Location {
  return (
    bestMove(region, player, scored)?.tile ?? { x: player.location.x, y: player.location.y }
  );
}
