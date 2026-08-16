"use strict";

import { EntityNames, Location, Mob, Player, Region } from "osrs-sdk";

import { ArenaSnapshot, snapshotHasLineOfSight } from "./ArenaSnapshot";
import { isJad } from "./JadTracker";
import { knownAttackStyle } from "./PrayerPlanner";
import { visibleMobs } from "./Visibility";

/**
 * Plays a candidate move forward tick by tick and reports what hits us on the way.
 *
 * The point of this file is that a tile is NOT the unit of evaluation. Teleporting the player
 * onto a candidate and asking who can see them there gives the wrong answer even about the
 * destination, for three separate reasons:
 *
 *  - mobs chase the player's position on each tick, not the tile they are heading for, so
 *    stepping them "towards where I will end up" puts them where they will never be;
 *  - every mob that gains line of sight en route fires and resets its cycle, so the attack
 *    phases on arrival are a product of the whole walk;
 *  - the player passes through real tiles at real ticks and takes real damage there.
 *
 * So the player occupies a concrete tile at every tick boundary and everything is evaluated
 * against that.
 *
 * Engine order per tick is mobs move, mobs attack, then the player moves (World.tickRegion) -
 * which is why moving away does not dodge the attack that was already coming this tick.
 */

export interface Threat {
  /** Ticks from now, 1-based. */
  tick: number;
  /**
   * Every style this attack might arrive as.
   *
   * One entry means it is settled. More than one means the engine has not decided yet and will
   * roll for it at fire time - an unscanned blob picking magic or range, or any mob with
   * canMeleeIfClose standing next to the player. Treated as equally likely, which is exact for
   * the two-way cases and only approximate if both apply at once.
   */
  styles: string[];
  maxHit: number;
  name: string;
  /**
   * For a blob that scanned DURING this simulation, the tick it scanned on.
   *
   * A blob throws the opposite of whatever overhead it saw, so its style is not a property of
   * the blob at all - it is a consequence of what we chose to pray three ticks earlier. The
   * scorer uses this to link the two, and can then plan the overhead sequence rather than
   * guessing at the style.
   *
   * Absent for a blob that had already scanned before the simulation began: that commitment is
   * made and cannot be changed, so its style is fixed.
   */
  scanTick?: number;
}

export interface SimMob {
  x: number;
  y: number;
  size: number;
  range: number;
  speed: number;
  delay: number;
  maxHit: number;
  style: string | null;
  name: string;
  /** Takes up space, so it blocks other mobs and is blocked by them. False for nibblers. */
  blocks: boolean;
  /** Chasing the player, as opposed to a pillar or Jad. */
  chasesPlayer: boolean;
  /** Where a mob that is not chasing the player is heading. */
  targetX: number;
  targetY: number;
  /** Whether it can actually hit us, and so contributes threats. */
  attacks: boolean;
  /** Ticks of spawn stun left. Blocks both moving and attacking while above zero. */
  stunned: number;
  /** Ticks of freeze left. Blocks movement only - a frozen mob still attacks. */
  frozen: number;
  /** Never moves at all: healers and Zuk override canMove() to false outright. */
  immobile: boolean;
  /** Blobs run a scan/attack cycle instead of firing every attackDelay expiry. */
  isBlob: boolean;
  /** A blob that has scanned and is now counting down to the attack it committed to. */
  pendingScan: boolean;
  /** Tick of the scan that set the pending commitment, or -1 if it predates the simulation. */
  lastScanTick: number;
  /** Previous tick's line of sight - a blob scans on the tick it first acquires. */
  hadLOS: boolean;
  /**
   * True when this mob would switch to a melee style if the player stood next to it.
   *
   * Blobs, rangers, magers and Jad all define canMeleeIfClose. Standing adjacent makes their
   * style a coin flip rather than a fact, which is a real cost - a coin flip cannot be prayed
   * reliably.
   */
  meleeIfClose: string | null;
  /** Meleers burrow to the player when kept out of reach. See the dig handling below. */
  canDig: boolean;
  /** Ticks left of a dig already in progress; 0 when not digging. */
  digTicks: number;
  /**
   * A mob that does not exist yet - a bloblet a dying blob is about to become.
   *
   * It fights like the real thing inside the simulation, because it will BE the real thing
   * before the horizon is out, but it must never be treated as something to shoot at: there is
   * nothing there to click. See `ghostBloblets`.
   */
  ghost: boolean;
  /**
   * Where a dig in progress will surface.
   *
   * Locked in at startDig from the player's position AT THAT MOMENT, and endDig just assigns
   * the stored value. So a dig does not track the player - moving during the six tick burrow
   * makes it surface on the tile you have already left, which is six ticks of free escape.
   */
  digX: number;
  digY: number;
}

/**
 * How far ahead to play things out.
 *
 * Twelve, because that is the LCM of the two attack speeds in the Inferno - 3 for blobs and
 * bats, 4 for magers, rangers, meleers and nibblers. Any pair of parked mobs repeats its
 * collision pattern every 12 ticks, so a shorter horizon can miss a collision entirely and a
 * longer one only re-counts what it already saw.
 */
export const HORIZON_TICKS = 12;

/**
 * Tiles the player covers per tick. Two, because we are running the whole way - stamina keeps
 * energy topped up, so the walk-speed fallback at zero energy never comes into play.
 */
export const PLAYER_TILES_PER_TICK = 2;

const key = (x: number, y: number) => `${x},${y}`;

/**
 * Freeze every mob that affects the outcome - which is more than just the ones shooting at us.
 *
 * A mob that cannot hurt us still shapes the fight by standing in the way. Healers chase Jad
 * rather than us but still occupy tiles the others have to path around.
 *
 * JAD is the one mob whose participation is a caller's choice, because the two things that
 * read this snapshot want opposite answers.
 *
 * The PRAYER planner must keep Jad out (`includeJad` false, the default). Its attackDelay
 * marks an animation START, not the attack that resolves three ticks later, and its style is
 * re-rolled every tick - so anything this file predicts about Jad is worse than what
 * JadTracker already knows by watching the animation and reading the committed style.
 * `plannedOverhead` folds that observation in itself, and a simulated coin flip alongside it
 * would only hedge against a question already answered.
 *
 * The TILE SCORER must let Jad in. With Jad excluded, `damageTaken` was zero on every tile in
 * the arena including the one under its fist, `safeSpot` was zero everywhere (it requires an
 * attacker to be safe FROM), and `npcReachSoon` paid 1 on every tile within tbow range - so
 * the whole reachable area tied at exactly 1.0, and `bestMove` needs a STRICT improvement to
 * move. Jad would walk up to a parked bot and it would stand there, not because melee range
 * scored well, but because nothing could beat a tie. Measured: hp 81 to 0 in one tick on wave
 * 67. Letting Jad generate threats prices adjacency, restores cover, and breaks the tie.
 *
 * What Jad contributes is deliberately a BAD attack to be standing near rather than a precise
 * schedule: its styles are left unknown, so `stylesAtFireTime` reports the range/magic coin
 * flip (plus stab when adjacent, which is what makes standing next to it properly expensive)
 * and `planOverheads` prices the cost of guessing. The ticks it lands on are the animation
 * ticks rather than the landing ticks three later - the total over a horizon is what the tile
 * score needs, and the exact tick only matters to the prayer plan, which does not use this.
 *
 * Nibblers are the exception and are dropped entirely: JalNib.consumesSpace returns null, so
 * they neither block anything nor get blocked - passing null as mobToAvoid makes the engine's
 * own check skip mob collision altogether - and their aggro is a pillar, so they never attack
 * us either. They are genuinely invisible to this simulation.
 *
 * Style is read through knownAttackStyle, never attackStyleForNewAttack. A blob that has not
 * scanned rolls RNG inside that call, so a scorer asking 441 times what a blob will throw
 * would change what it throws.
 */
/**
 * The three bloblets a dying blob is about to become, modelled from the moment it starts dying.
 *
 * A blob's death is not the end of a threat, it is the announcement of three more - and for the
 * four ticks it spends dying the simulation used to see clean, empty floor. `snapshotMobs`
 * drops anything with `dying > -1`, so the corpse tiles priced as perfectly safe, could earn
 * the full safe-spot bonus, and the bot could be standing on the spawn point when they landed.
 * The melee bloblet spawns on the blob's OWN tile, so that is not a hypothetical.
 *
 * Predicting them is not cheating, which is the first thing to settle given `Visibility`'s
 * rule. Nothing here is read from `newMobs` or from anything the renderer has not drawn: the
 * blob is visible, its death is visible, and what follows is fixed. `JalAk.removedFromWorld`
 * spawns exactly these three, at exactly these offsets from the blob's own location, each with
 * `cooldown: 4`. No RNG anywhere. This is the same class of knowledge as "a mager's range is
 * 15" - deduction from what is on screen, which is what a human player does too.
 *
 * TIMING, from the engine rather than guessed. `dead()` sets `dying` to the death animation
 * length (3 for a blob, which does not override it). `Mob.attackStep` calls `detectDeath` once
 * per tick, counting 3 -> 2 -> 1 -> 0, and at zero calls `removedFromWorld`, which pushes the
 * bloblets into `newMobs`. The corpse is only removed from `region.mobs` at the very END of
 * that tick - AFTER `postTick`, which is where the automation runs - and `newMobs` merges at
 * the very START of the next one. So the automation sees the dying blob on four consecutive
 * ticks and the real bloblets on the fifth, with no gap between the ghosts and the things they
 * were predicting.
 *
 * That is also why these are DERIVED every tick from the dying blob rather than registered in
 * a list when it dies. There is no state to keep, nothing to reset between waves, and nothing
 * to leak into the next region - and if anything ever changes how long a blob takes to die
 * (the death animation can resolve early through a DelayedAction), the ghosts simply follow
 * `dying` wherever it goes instead of holding a stale prediction.
 *
 * The first attack lands `dying + 1 + BLOBLET_COOLDOWN` ticks out: the remaining dying ticks,
 * one for the merge, then the cooldown they spawn with.
 */
const BLOBLET_COOLDOWN = 4;
const BLOBLET_MERGE_DELAY = 1;
const BLOBLET_MAX_HIT = 18;
const BLOBLET_SPEED = 4;

const GHOST_BLOBLETS: ReadonlyArray<{
  name: string;
  dx: number;
  dy: number;
  style: string;
  range: number;
}> = [
  // Straight out of JalAk.removedFromWorld. The blob is size 3 and its footprint runs east and
  // north from `location`, so these are its south-west corner, its centre and its north-east
  // corner - the melee one directly on the tile the corpse is standing on.
  { name: EntityNames.JAL_AK_REK_KET, dx: 0, dy: 0, style: "crush", range: 1 },
  { name: EntityNames.JAL_AK_REK_XIL, dx: 1, dy: -1, style: "range", range: 15 },
  { name: EntityNames.JAL_AK_REK_MEJ, dx: 2, dy: -2, style: "magic", range: 15 },
];

/**
 * A blob part-way through dying, and therefore three bloblets already committed.
 *
 * Exported so the automation's wave-state check and this file's ghost derivation ask the same
 * question in the same words. They must never disagree: if the wave reads as over while ghosts
 * are being modelled the bot walks home through them, and if it reads as live with no ghosts
 * the bot fights an empty arena.
 */
export function isDyingBlob(mob: Mob): boolean {
  return mob.dying > -1 && mob.mobName() === EntityNames.JAL_AK;
}

export function hasDyingBlob(region: Region): boolean {
  return visibleMobs(region).some((mob) => isDyingBlob(mob as Mob));
}

function ghostBloblets(blob: Mob): SimMob[] {
  const delay = Math.max(0, blob.dying) + BLOBLET_MERGE_DELAY + BLOBLET_COOLDOWN;
  return GHOST_BLOBLETS.map((spawn) => ({
    x: blob.location.x + spawn.dx,
    y: blob.location.y + spawn.dy,
    size: 1,
    range: spawn.range,
    speed: BLOBLET_SPEED,
    delay,
    maxHit: BLOBLET_MAX_HIT,
    // Fixed by which bloblet it is - unlike their parent, they never scan and never roll.
    style: spawn.style,
    name: spawn.name,
    blocks: true,
    chasesPlayer: true,
    targetX: blob.location.x,
    targetY: blob.location.y,
    attacks: true,
    stunned: 0,
    frozen: 0,
    immobile: false,
    isBlob: false,
    pendingScan: false,
    lastScanTick: -1,
    hadLOS: false,
    // None of the three define canMeleeIfClose, so there is no coin flip to price.
    meleeIfClose: null,
    canDig: false,
    digTicks: 0,
    digX: blob.location.x,
    digY: blob.location.y,
    ghost: true,
  }));
}

export function snapshotMobs(
  region: Region,
  player: Player,
  includeJad = false,
): SimMob[] {
  const snapshot: SimMob[] = [];
  // Only what the player can actually see - during the countdown this is empty, because the
  // renderer draws no mobs at all until it expires. See Visibility.
  for (const mob of visibleMobs(region) as Mob[]) {
    if (mob.dying > -1) {
      // A dying blob is not an absence, it is three bloblets with a countdown on them.
      if (isDyingBlob(mob)) {
        for (const ghost of ghostBloblets(mob)) {
          snapshot.push(ghost);
        }
      }
      continue;
    }
    // Mirrors Collision.collidesWithAnyMobs, which only treats a mob as an obstacle when its
    // consumesSpace is truthy.
    const blocks = !!(mob as unknown as { consumesSpace?: unknown }).consumesSpace;
    if (!blocks) {
      continue;
    }

    const chasesPlayer = mob.aggro === player;
    const target = mob.aggro?.location;
    snapshot.push({
      x: mob.location.x,
      y: mob.location.y,
      size: mob.size,
      range: mob.attackRange,
      speed: mob.attackSpeed,
      delay: mob.attackDelay,
      maxHit: mob.maxHit ?? 0,
      // Never asked of Jad. `knownAttackStyle` falls through to attackStyleForNewAttack(),
      // which for Jad is `Random.get() < 0.5 ? "range" : "magic"` - so asking would draw from
      // the seeded stream on every snapshot, several times a tick, and shift every roll that
      // follows it. Blobs are guarded inside knownAttackStyle for exactly this reason; Jad was
      // not. Null is also the honest answer: the flip has not happened yet.
      style: isJad(mob) ? null : knownAttackStyle(mob),
      name: mob.mobName(),
      blocks,
      chasesPlayer,
      // Static stand-in for whatever it is following. Good enough for a pillar, which never
      // moves, and for Jad, which barely does.
      targetX: target?.x ?? mob.location.x,
      targetY: target?.y ?? mob.location.y,
      attacks: chasesPlayer && (includeJad || !isJad(mob)),
      stunned: Math.max(0, (mob as unknown as { stunned?: number }).stunned ?? 0),
      frozen: Math.max(0, (mob as unknown as { frozen?: number }).frozen ?? 0),
      immobile: typeof mob.canMove === "function" ? !mob.canMove() && mob.hasLOS === false : false,
      isBlob: mob.mobName() === EntityNames.JAL_AK,
      pendingScan: !!(mob as unknown as { playerPrayerScan?: string | null }).playerPrayerScan,
      lastScanTick: -1,
      hadLOS: mob.hasLOS === true,
      meleeIfClose:
        typeof (mob as unknown as { canMeleeIfClose?: () => string }).canMeleeIfClose ===
        "function"
          ? (mob as unknown as { canMeleeIfClose: () => string }).canMeleeIfClose() || null
          : null,
      ghost: false,
      canDig: mob.mobName() === EntityNames.JAL_IM_KOT,
      digTicks: Math.max(
        0,
        (mob as unknown as { digSequenceTime?: number }).digSequenceTime ?? 0,
      ),
      // A dig already underway has its destination committed, so read it rather than guessing.
      digX: (mob as unknown as { digLocation?: Location }).digLocation?.x ?? mob.location.x,
      digY: (mob as unknown as { digLocation?: Location }).digLocation?.y ?? mob.location.y,
    });
  }
  return snapshot;
}

/** Axis-aligned overlap of two footprints, copied from Collision.collisionMath. */
function overlaps(
  ax: number,
  ay: number,
  as: number,
  bx: number,
  by: number,
  bs: number,
): boolean {
  return !(ax > bx + bs - 1 || ax + as - 1 < bx || ay - as + 1 > by || ay < by - bs + 1);
}

/**
 * The tiles a mob sweeps into when it steps, copied from Mob.getXMovementTiles and
 * getYMovementTiles.
 *
 * Not the destination footprint - the LEADING EDGE of it. Moving east, that is the single
 * column at `x + size`; moving west, the column at `x - 1`; south, the row at `y + 1`; north,
 * the row at `y - size`. A diagonal step sweeps both, and each is one tile longer, because the
 * corner tile has to be clear too (`start`/`end` in the engine's loops).
 *
 * The distinction is the whole of the overlapping-mobs bug. Everything already inside the
 * footprint is, by definition, something the mob is already standing in - the engine never
 * re-tests it, so a mob that begins overlapped can still walk.
 */
function sweptTiles(
  mob: SimMob,
  xOff: number,
  yOff: number,
): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];

  if (xOff !== 0) {
    const column = xOff === 1 ? mob.x + mob.size : mob.x - 1;
    const start = yOff === -1 ? -1 : 0;
    const end = yOff === 1 ? mob.size + 1 : mob.size;
    for (let i = start; i < end; i++) {
      tiles.push({ x: column, y: mob.y - i });
    }
  }

  if (yOff !== 0) {
    const row = yOff === -1 ? mob.y + 1 : mob.y - mob.size;
    const start = xOff === -1 ? -1 : 0;
    const end = xOff === 1 ? mob.size + 1 : mob.size;
    for (let i = start; i < end; i++) {
      tiles.push({ x: mob.x + i, y: row });
    }
  }

  return tiles;
}

/**
 * Can this mob step to this destination?
 *
 * Judged the way `Mob.movementStep` judges it: every tile the step SWEEPS INTO must be clear,
 * each tested at size 1, for walls and for other mobs alike. It is not a test of the
 * destination footprint, and the difference is not academic.
 *
 * Measured: a bat spawning inside a mager's 4x4 froze the mager for the whole projection.
 * Every direction it could step still overlapped the bat somewhere inside the destination
 * footprint, so the old footprint test refused all of them - while the engine, checking only
 * the row being swept into, let it walk. The scorer then priced a board with two paralysed
 * attackers: tiles quoting damage 0 and threats 3 that were really 138 and 6, the bot walked
 * onto one, and died there. Any two overlapping mobs did this to each other - bloblet stacks,
 * spawn clusters, anything jammed against something big.
 *
 * Mobs are checked against the SIMULATED positions rather than the live ones, which is the
 * whole point - a projection reading real positions would let the stack walk through itself.
 *
 * Exported only so the geometry can be pinned by a test. The sign convention below is the
 * kind of thing a tidy-up "fixes" - see `trajectoryBlocking.test.ts`, which fails if it is.
 */
export function canOccupy(
  snapshot: ArenaSnapshot,
  mob: SimMob,
  x: number,
  y: number,
  all: SimMob[],
): boolean {
  // The engine's two offsets do not share a sign convention - `movementStep` computes
  // `xOff = dx - location.x` but `yOff = location.y - dy`, so yOff is POSITIVE going north.
  // Getting that backwards swaps the row being tested for the one on the opposite side.
  const tiles = sweptTiles(mob, Math.sign(x - mob.x), Math.sign(mob.y - y));

  for (const tile of tiles) {
    if (!snapshot.canStandAt(tile.x, tile.y)) {
      return false;
    }
    for (const other of all) {
      if (other === mob || !other.blocks) {
        continue;
      }
      if (overlaps(tile.x, tile.y, 1, other.x, other.y, other.size)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Unit.isWithinMeleeRange, transcribed - strict orthogonal adjacency to the mob's footprint.
 *
 * Not a distance check: it tests the four sides of the footprint explicitly, so a diagonal
 * neighbour is NOT within melee range.
 */
export function withinMeleeRange(mob: SimMob, px: number, py: number): boolean {
  if (px === mob.x - 1 && py <= mob.y + 1 && py > mob.y - mob.size - 1) {
    return true;
  }
  if (py === mob.y + 1 && px >= mob.x && px < mob.x + mob.size) {
    return true;
  }
  if (px === mob.x + mob.size && py <= mob.y + 1 && py > mob.y - mob.size - 1) {
    return true;
  }
  if (py === mob.y - mob.size && px >= mob.x && px < mob.x + mob.size) {
    return true;
  }
  return false;
}

/**
 * Every style this attack might arrive as.
 *
 * Mob.attack() re-rolls the style at fire time:
 *
 *     if (canMeleeIfClose() && !isMeleeAttackStyle(attackStyle))
 *       if (isWithinMeleeRange() && Random.get() < 0.5) attackStyle = canMeleeIfClose();
 *
 * So a mager standing next to the player throws stab half the time and magic the other half.
 * That is a coin flip, not a prediction. Both outcomes are returned so the scorer can charge
 * the expected cost of guessing, rather than pretending either one is certain.
 *
 * Parking keeps this rare: a range 15 mob stops the moment it acquires, so it is only ever
 * adjacent if it acquired from adjacent. Rare is not never, and an unprayable hit is exactly
 * the thing this score exists to find.
 */
function stylesAtFireTime(mob: SimMob, px: number, py: number): string[] {
  // An unscanned blob has not rolled magic or range yet. Both are live possibilities.
  const base = mob.style === null ? ["magic", "range"] : [mob.style];

  // A mob that is already melee has nothing to flip to.
  if (!mob.meleeIfClose || mob.range <= 1) {
    return base;
  }
  if (!withinMeleeRange(mob, px, py)) {
    return base;
  }
  return base.includes(mob.meleeIfClose) ? base : [...base, mob.meleeIfClose];
}

/** Can a mob of this size stand with its corner here, ignoring other mobs? */
function fitsOnMap(snapshot: ArenaSnapshot, x: number, y: number, size: number): boolean {
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (!snapshot.canStandAt(x + i, y - j)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Earliest tick a meleer may burrow, counted on attackDelay.
 *
 * JalImKot.movementStep digs when it has no line of sight and either attackDelay <= -38 with a
 * one in ten roll, or attackDelay <= -50 outright. Since attackDelay only reaches -38 after
 * about forty ticks of being unable to attack, the dig is precisely a punishment for keeping it
 * away - which is what the tile scorer is learning to do, so it gets MORE relevant as
 * positioning improves, not less.
 *
 * Modelled at -50, the point the dig is GUARANTEED, not at -38 where it merely becomes possible.
 * Treating -38 as certain looked like the safe choice and was simply wrong: measured against the
 * engine it fired the dig eleven ticks early, which is most of a horizon. The one-in-ten roll
 * can still bring it forward by up to twelve ticks, so this is the late bound rather than the
 * expected one - see test/harness/meleerDig.test.ts, which pins it.
 */
const DIG_TRIGGER_DELAY = -50;
const DIG_SEQUENCE_TICKS = 6;

/**
 * Where a meleer surfaces, mirroring JalImKot.startDig's cascade of collision tests.
 *
 * Every branch lands it on or beside the player, so the effect is a teleport into melee range
 * however the geometry falls - but only relative to where the player stood when the dig BEGAN.
 * Called once, at that moment, never again.
 */
function digDestination(
  snapshot: ArenaSnapshot,
  size: number,
  px: number,
  py: number,
): { x: number; y: number } {
  if (fitsOnMap(snapshot, px - 3, py + 3, size)) {
    return { x: px - size + 1, y: py + size - 1 };
  }
  if (fitsOnMap(snapshot, px, py, size)) {
    return { x: px, y: py };
  }
  if (fitsOnMap(snapshot, px - 3, py, size)) {
    return { x: px - size + 1, y: py };
  }
  if (fitsOnMap(snapshot, px, py + 3, size)) {
    return { x: px, y: py + size - 1 };
  }
  return { x: px - 1, y: py + 1 };
}

/**
 * Is the player standing inside this mob's footprint?
 *
 * Mob.attackIfPossible calls this `isUnderAggro` and refuses to attack when it is true, and
 * getNextMovementStep replaces the greedy step with a random shuffle. So a mob with the player
 * under it neither closes nor hits - being underneath a big mob is genuinely a safe spot.
 */
export function playerIsUnder(mob: SimMob, px: number, py: number): boolean {
  return overlaps(mob.x, mob.y, mob.size, px, py, 1);
}

/**
 * Whether a mob at its current position can see the player at theirs, within its own attack
 * range - i.e. whether it could hit them.
 *
 * Exported for the tile scorer's safe-spot test, which asks it about PROJECTED mob positions
 * mid-simulation - the same predicate the simulation itself gates attacks on, so the scorer
 * cannot hold a different opinion about reach than the trajectory it is pricing.
 */
export function mobSeesPlayer(
  snapshot: ArenaSnapshot,
  mob: SimMob,
  px: number,
  py: number,
): boolean {
  return snapshotHasLineOfSight(snapshot, mob.x, mob.y, px, py, mob.size, mob.range, true);
}

/**
 * One greedy step towards the player, matching Mob.movementStep and getNextMovementStep.
 *
 * There is no pathfinding here in the engine either - it is literally Math.sign on each axis,
 * with a fallback to single-axis movement when the diagonal is blocked. That is exactly why
 * mobs jam against pillars, which is the whole basis of safespotting.
 *
 * The critical gate is Unit.canMove():
 *
 *     return !this.hasLOS && !this.isFrozen() && !this.isStunned() && !this.isDying();
 *
 * A mob that can SEE the player stops dead. Rangers and magers therefore park at the range
 * they first acquired from and never close further - which is exactly what makes their attack
 * phase stable, and why walking out of their sight is the only thing that re-phases them.
 * Simulating them as closing every tick made the projection crowd the player with mobs that
 * would really have stood still.
 */
function stepMob(
  snapshot: ArenaSnapshot,
  mob: SimMob,
  px: number,
  py: number,
  all: SimMob[],
) {
  // Unit.canMove(): !hasLOS && !isFrozen() && !isStunned() && !isDying(). Anything that can
  // already attack, or is held in place, does not move.
  if (mob.immobile || mob.stunned > 0 || mob.frozen > 0) {
    return;
  }
  if (mobSeesPlayer(snapshot, mob, px, py)) {
    return;
  }
  // Player underneath. The engine replaces the greedy step with a random shuffle - but note it
  // ALWAYS moves, one tile on one axis. Modelling that as holding position created a permanent
  // safe spot that does not exist, and the tile scorer duly found it and parked underneath mobs
  // forever: a mob standing over the player cannot attack, so those tiles scored zero.
  //
  // Standing under something buys exactly one tick. The direction of the shuffle is a coin flip
  // and unpredictable, so it steps off along the axis it is furthest out on, which lands it
  // adjacent and attacking from the next tick - which is the part that matters.
  if (playerIsUnder(mob, px, py)) {
    const offsetX = mob.x - px;
    const offsetY = mob.y - py;
    if (Math.abs(offsetX) >= Math.abs(offsetY)) {
      mob.x += offsetX >= 0 ? 1 : -1;
    } else {
      mob.y += offsetY >= 0 ? 1 : -1;
    }
    return;
  }
  // "No movement right after melee dig" - the engine freezes movement while the delay is
  // longer than the mob's own attack speed.
  if (mob.delay > mob.speed) {
    return;
  }
  // Only the player-chasers follow us. Anything aggroed elsewhere walks towards that instead,
  // which still matters because of where it ends up standing.
  const toX = mob.chasesPlayer ? px : mob.targetX;
  const toY = mob.chasesPlayer ? py : mob.targetY;

  const dx = mob.x + Math.sign(toX - mob.x);
  let dy = mob.y + Math.sign(toY - mob.y);

  // The engine's own "allows corner safespotting" rule, from Mob.getNextMovementStep: when the
  // greedy step would land the mob's footprint ON its target's tile, the vertical component is
  // cancelled and only the horizontal step is attempted. If a pillar blocks that horizontal
  // step too, the mob is PERMANENTLY jammed - it re-derives the same cancelled step every tick.
  //
  // This rule is the mechanism of corner safespotting itself, and omitting it was a real,
  // measured lie: a bat at 26,20 chasing a player at 28,18 has its diagonal to 27,19 cancelled
  // by this rule (footprint would cover the player), its horizontal step into 27,20 blocked by
  // the north pillar, and so it stands still forever - while this simulation, without the rule,
  // stepped it north to 26,19 and into view. The tile scorer then paid reach for a shot the
  // engine would never allow, and the bot camped that tile until its prayer ran out.
  if (overlaps(dx, dy, mob.size, toX, toY, 1)) {
    dy = mob.y;
  }

  // A diagonal step needs BOTH orthogonal neighbours open - you cannot cut a corner past a
  // blocker. `routesFrom` has always enforced this for the player ("exactly as the engine does
  // it"); this did not, and the asymmetry was load-bearing.
  //
  // Measured against the live engine: a bloblet at 28,22 chasing a player at 27,16 wants to step
  // north-west to 27,21. That corner is 28,21 - a pillar tile - so the engine refuses and steps
  // WEST to 27,22 instead, acquires line of sight there, and parks at distance 6. Without this
  // check the simulation took the diagonal, parked at 27,21, and reported distance 5 - inside
  // blowpipe range when the real mob is outside it. One tile, and it is the exact boundary
  // between a tile you can fight from and one where you can only be shot.
  //
  // It only shows up around pillars. A mob closing in the open has no corner to cut, which is
  // why this agreed with the engine everywhere except the tiles that matter for safespotting.
  const canX = canOccupy(snapshot, mob, dx, mob.y, all);
  const canY = canOccupy(snapshot, mob, mob.x, dy, all);
  const diagonal = dx !== mob.x && dy !== mob.y;

  if (canOccupy(snapshot, mob, dx, dy, all) && (!diagonal || (canX && canY))) {
    mob.x = dx;
    mob.y = dy;
  } else if (canX) {
    mob.x = dx;
  } else if (canY) {
    mob.y = dy;
  }
}

/**
 * Walk the player along `path` and report every attack that fires at them.
 *
 * `path` is tile-by-tile from the player's current position; the player consumes two of those
 * per tick and then stands still once it runs out.
 *
 * `trace` runs at the end of every tick. Returning `true` stops the simulation there, with the
 * threats gathered so far returned as usual. That exists for callers probing a condition past
 * the pricing horizon - the tile scorer's settle check runs under a cap of eighty ticks but
 * almost always decides in a handful - so a probe pays for the ticks it uses, not for its cap.
 */
export function simulateTrajectory(
  snapshot: ArenaSnapshot,
  mobs: SimMob[],
  path: Location[],
  horizon: number = HORIZON_TICKS,
  trace?: (tick: number, mobs: readonly SimMob[], px: number, py: number) => boolean | void,
): Threat[] {
  const threats: Threat[] = [];
  const sim: SimMob[] = mobs.map((mob) => ({ ...mob }));

  let step = 0;
  let px = path[0].x;
  let py = path[0].y;

  for (let tick = 1; tick <= horizon; tick++) {
    // 1. Mobs move, chasing where the player is standing right now.
    //
    // Sequentially and mutating in place, matching region.mobs.forEach(movementStep) - a mob
    // later in the list sees the ones before it already moved, so a stack unpacks in the same
    // order it really does.
    for (const mob of sim) {
      stepMob(snapshot, mob, px, py, sim);

      // JalImKot.movementStep runs the dig check straight after the normal move.
      if (!mob.canDig) {
        continue;
      }
      if (mob.digTicks > 0) {
        if (--mob.digTicks === 0) {
          // endDig surfaces it at the destination chosen SIX TICKS AGO, not at the player's
          // position now. It also calls player.interruptCombat(), cancelling whatever we were
          // attacking - a real cost, but not one a damage-only score can express.
          mob.x = mob.digX;
          mob.y = mob.digY;
          mob.delay = 6;
          mob.frozen = 2;
        }
        continue;
      }
      if (mob.delay <= DIG_TRIGGER_DELAY && !mobSeesPlayer(snapshot, mob, px, py)) {
        // Committed now, against where the player is standing on this tick.
        const destination = digDestination(snapshot, mob.size, px, py);
        mob.digX = destination.x;
        mob.digY = destination.y;
        // JalImKot.movementStep decrements digSequenceTime in the SAME call that starts the
        // dig, so a six tick sequence surfaces five ticks later, not six.
        mob.digTicks = DIG_SEQUENCE_TICKS - 1;
        mob.frozen = DIG_SEQUENCE_TICKS;
      }
    }

    // 2. Mobs attack - still against the pre-move position, because the player has not moved
    //    yet this tick. attackDelay is decremented unconditionally, so a mob out of sight
    //    counts down into negatives and fires the instant it re-acquires. That is what makes
    //    moving re-phase everything.
    for (const mob of sim) {
      mob.delay--;
      // canAttack() is `!isDying() && !isStunned()`, and Mob.attackStep decrements `stunned`
      // AFTER attackIfPossible - so a mob spawned with stun 1 misses exactly one tick. That
      // single tick is what lets the planner, which runs one tick ahead, pray a mob's opening
      // shot at all.
      const stunned = mob.stunned > 0;
      // Mob.attackStep decrements both counters after attackIfPossible, so this tick still
      // sees the pre-decrement values.
      if (mob.stunned > 0) {
        mob.stunned--;
      }
      if (mob.frozen > 0) {
        mob.frozen--;
      }
      if (!mob.attacks || stunned) {
        continue;
      }

      const sees = mobSeesPlayer(snapshot, mob, px, py);
      // isUnderAggro: a mob standing over the player does not attack at all.
      const under = playerIsUnder(mob, px, py);

      if (mob.isBlob) {
        // JalAk.attackIfPossible is a two phase cycle, so a blob's real fire period is twice
        // its attackSpeed - 6, not 3. Treating every attackDelay expiry as a hit double counted
        // blobs and put phantom damage on scan ticks.
        //
        //   scan:   hasLOS && (!hadLOS || (!playerPrayerScan && attackDelay <= 0))
        //           -> records our overhead, resets the delay, deals NOTHING
        //   attack: playerPrayerScan && attackDelay <= 0
        //
        // The attack branch is deliberately not gated on line of sight. Once a blob has
        // scanned, breaking sight does not save you - it still throws.
        //
        // `!mob.pendingScan` gates BOTH triggers, not just the delay one. Without it, a route
        // that lets the blob's sight flicker mid-countdown - lost then regained one tile later -
        // re-entered this branch on the `!mob.hadLOS` trigger alone, resetting delay back to
        // mob.speed and pushing the already-committed attack further out. Nothing about a
        // committed blob should be re-decided by a LOS blip; only the attack branch below is
        // allowed to end a pending commitment.
        if (!under && sees && !mob.pendingScan && (!mob.hadLOS || mob.delay <= 0)) {
          mob.pendingScan = true;
          mob.lastScanTick = tick;
          mob.delay = mob.speed;
          mob.hadLOS = sees;
          continue;
        }
        mob.hadLOS = sees;
        if (mob.pendingScan && mob.delay <= 0) {
          threats.push({
            tick,
            styles: stylesAtFireTime(mob, px, py),
            maxHit: mob.maxHit,
            name: mob.name,
            ...(mob.lastScanTick >= 0 ? { scanTick: mob.lastScanTick } : {}),
          });
          mob.pendingScan = false;
          mob.lastScanTick = -1;
          mob.delay = mob.speed;
        }
        continue;
      }

      mob.hadLOS = sees;
      if (mob.delay > 0 || !sees || under) {
        continue;
      }
      threats.push({
        tick,
        styles: stylesAtFireTime(mob, px, py),
        maxHit: mob.maxHit,
        name: mob.name,
      });
      mob.delay = mob.speed;
    }

    // 3. The player moves last.
    for (let i = 0; i < PLAYER_TILES_PER_TICK && step < path.length - 1; i++) {
      step++;
    }
    px = path[step].x;
    py = path[step].y;

    if (trace?.(tick, sim, px, py) === true) {
      break;
    }
  }

  return threats;
}

/**
 * Expansion order, copied verbatim from Pathing.constructPaths.
 *
 * This array is not cosmetic and it is not a detail - it IS the pathfinder's answer whenever more
 * than one shortest route exists, which on open floor is nearly always. Walking from 25,25 to
 * 28,27 takes three steps either way, but "south-east, south-east, south-east" and "east,
 * south-east, south-east" cross entirely different tiles, and the whole point of
 * `simulateTrajectory` is that the player stands on real tiles at real ticks and is shot at
 * there. Get the order wrong and the score is computed for a walk the player will not take.
 *
 * Orthogonals first, then diagonals - see the wiki's "Determining the target tile".
 */
const PATH_DIRECTIONS: ReadonlyArray<{ x: number; y: number }> = [
  { x: -1, y: 0 }, // w
  { x: 1, y: 0 }, // e
  { x: 0, y: 1 }, // s
  { x: 0, y: -1 }, // n
  { x: -1, y: 1 }, // sw
  { x: 1, y: 1 }, // se
  { x: -1, y: -1 }, // nw
  { x: 1, y: -1 }, // ne
];

/**
 * Shortest walking route from `start` to every tile in `tiles`, in one sweep.
 *
 * A breadth-first search from the player gives all 441 routes for the cost of one, which is the
 * difference between this being affordable and not: the engine's own `constructPaths` early-
 * returns on the first endpoint it reaches, so getting 441 routes out of it would mean 441
 * searches every tick.
 *
 * Everything else here is `constructPaths` transcribed rather than reimplemented:
 *
 *  - the same first-in-first-out queue, so nodes come off in discovery order;
 *  - the same eight directions in the same order, which fixes every tie;
 *  - the same diagonal rule - both orthogonal neighbours of the parent must be pathable, so a
 *    corner cannot be cut past a pillar;
 *  - the same walkability test, which is entities only and ignores mobs entirely, because the
 *    engine passes `null` as mobToAvoid when it expands.
 *
 * Running to completion rather than stopping at the first hit changes no individual route: a
 * node's parent is fixed the moment it is first discovered, and when the search stops cannot
 * reach back and alter that.
 *
 * `canWalk` is supplied by the caller rather than taken from a snapshot directly, so this file
 * stays ignorant of where the arena's edges are.
 *
 * The one thing deliberately NOT copied is the engine's `nodes.length < 1000` queue cap and the
 * backup-tile search that runs when it trips. Both exist to answer "you clicked somewhere
 * unreachable, where did you mean?", and every tile handed to this function is already known to
 * be a walkable candidate. The arena interior is 870 tiles, so the cap could not bind anyway.
 */
export function routesFrom(
  start: Location,
  tiles: Location[],
  canWalk: (x: number, y: number) => boolean,
): Map<string, Location[]> {
  const startKey = key(start.x, start.y);
  const previous = new Map<string, string | null>([[startKey, null]]);
  const positions = new Map<string, Location>([[startKey, start]]);

  // Index pointer rather than shift(), which is O(n) per call and turns this quadratic. The
  // traversal order is identical either way.
  const queue: Location[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const { x, y } = queue[head];
    for (let i = 0; i < PATH_DIRECTIONS.length; i++) {
      const direction = PATH_DIRECTIONS[i];
      const nx = x + direction.x;
      const ny = y + direction.y;
      if (!canWalk(nx, ny)) {
        continue;
      }
      // Diagonals, which are the last four. Both orthogonal neighbours of the PARENT have to be
      // open - checked against the map, not against the candidate set, exactly as the engine
      // does it.
      if (i >= 4 && (!canWalk(x, y + direction.y) || !canWalk(x + direction.x, y))) {
        continue;
      }
      const nextKey = key(nx, ny);
      if (previous.has(nextKey)) {
        continue;
      }
      previous.set(nextKey, key(x, y));
      positions.set(nextKey, { x: nx, y: ny });
      queue.push({ x: nx, y: ny });
    }
  }

  const routes = new Map<string, Location[]>();
  for (const tile of tiles) {
    const tileKey = key(tile.x, tile.y);
    if (!previous.has(tileKey)) {
      continue; // walled off from the player - not somewhere we can actually go
    }
    const route: Location[] = [];
    let cursor: string | null = tileKey;
    while (cursor) {
      route.push(positions.get(cursor) as Location);
      cursor = previous.get(cursor) ?? null;
    }
    route.reverse();
    routes.set(tileKey, route);
  }
  return routes;
}

export const routeKey = key;
