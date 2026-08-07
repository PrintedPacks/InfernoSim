"use strict";

import { EntityNames, Location, Mob, Player, Region } from "osrs-sdk";

import { ArenaSnapshot, snapshotPlayerCanSeeMob } from "./ArenaSnapshot";
import { planOverheads } from "./OverheadPlanner";
import { BARRAGE_RANGE, NibblerThreat, nibblerThreats } from "./PillarDefence";
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
import { visibleMobs } from "./Visibility";

/**
 * Where the bot should be standing.
 *
 * This owns two things that must never disagree: the set of tiles worth considering, and the
 * number attached to each one. The debug grid draws the exact same list this chooses from, so
 * what you see on screen is the decision's real input rather than a reconstruction of it.
 *
 * Four terms, in hitpoints over a twelve tick horizon except where noted:
 *
 *     score = barrageReach + npcReachSoon + safeSpot - damageTaken
 *
 * scored over the candidates that survive a filter: a tile is only a candidate at all if it is
 * inside the arena, walkable, reachable, and the walk to it does not enter the coin-flip melee
 * zone - see `routeEntersForbiddenZone`.
 *
 * `barrageReach` is 1 if a barrage thrown from this tile reaches the nibbler that matters.
 *
 * `npcReachSoon` is 1 if a fight is actually available: the tile is close enough to be standing on
 * within NPC_REACH_ARRIVAL_TICKS, and standing there the engine would let a shot off at some mob
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
 * One if a barrage from the end of this route reaches the focus nibbler, zero otherwise.
 *
 * Judged from where the route ENDS. Reach is the same test the engine uses for a player clicking
 * a mob - `snapshotPlayerCanSeeMob` - at the barrage's range of 10.
 */
function barrageReach(
  snapshot: ArenaSnapshot,
  focus: NibblerThreat | null,
  route: Location[],
): number {
  if (!focus) {
    return 0;
  }
  const destination = route[route.length - 1];
  return snapshotPlayerCanSeeMob(
    snapshot,
    destination.x,
    destination.y,
    focus.x,
    focus.y,
    focus.size,
    BARRAGE_RANGE,
  )
    ? 1
    : 0;
}

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
export const NPC_DISTANCE_PENALTY = 0.01;

/**
 * Floor under the distance penalty, so a safe tile far from every mob still keeps a meaningful
 * bonus over an unsafe one rather than being taxed down towards zero. SAFE_SPOT_BONUS is small
 * on purpose - it should not need defending from its own penalty term.
 */
export const SAFE_SPOT_MIN = 0.1;

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
  npcReachSoon: number;
  /** `LOS_BONUS` shared between everything that can shoot this tile; 0 without reach. */
  losBonus: number;
  safeSpot: number;
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
  // Everything that could possibly join the set, so the scan can stop once they all have.
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
      if (
        arrivesInWindow &&
        !destinationUnderMob &&
        npcReachSoon === 0 &&
        tick - arrivalTick <= NPC_REACH_WINDOW_TICKS
      ) {
        for (const mob of simMobs) {
          const reach = reaches.get(mob.name);
          if (reach === undefined) {
            continue;
          }
          if (snapshotPlayerCanSeeMob(snapshot, px, py, mob.x, mob.y, mob.size, reach)) {
            npcReachSoon = 1;
            break;
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
  const damageTaken = planOverheads(threats).damage;

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

  // Only where a shot is actually available - see LOS_BONUS. Divided by everything that gets
  // to shoot back across the whole post-arrival window, not by a single tick's worth.
  const losBonus = npcReachSoon > 0 ? LOS_BONUS / Math.max(1, watchers.size) : 0;

  const parts: ScoreParts = {
    barrageReach: barrageReach(snapshot, focus, route),
    npcReachSoon,
    losBonus,
    safeSpot,
    damageTaken,
    threats: threats.length,
  };

  return {
    score:
      parts.barrageReach +
      parts.npcReachSoon +
      parts.losBonus +
      parts.safeSpot -
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
export function scoreCandidates(
  region: Region,
  player: Player,
  snapshot: ArenaSnapshot = new ArenaSnapshot(region),
): ScoredTile[] {
  const startedAt = performance.now();

  // Advance the standoff clocks exactly once per world tick, before any score is assembled.
  updateStandStillDecay(region, player);

  const tiles = candidateTiles(region, player, snapshot);
  // Routes may leave the candidate box to get around a pillar, exactly as the engine's own
  // pathfinder would, so walkability is asked of the whole arena rather than of the 441.
  const routes = routesFrom(player.location, tiles, (x, y) =>
    isInsideArena(x, y) && snapshot.canStandAt(x, y),
  );
  const focus = focusNibbler(nibblerThreats(region));
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
    const { score, parts } = scoreRoute(snapshot, mobs, focus, targets, reaches, route);
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
