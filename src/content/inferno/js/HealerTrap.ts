"use strict";

import { EntityNames, Location, Mob, Player, Region } from "osrs-sdk";

import { ArenaSnapshot } from "./ArenaSnapshot";
import { committedJad } from "./KillPriority";
import { ARENA_BOUNDS, isInsideArena } from "./TileScorer";
import { visibleMobs } from "./Visibility";

/**
 * THE WALL-AND-CROSS: back into a wall until a healer commits to a swing, then cross to the far
 * side of Jad and let its body break the line.
 *
 * WHY THE ENGINE ALLOWS THIS AT ALL. Mob movement here is greedy, not routed -
 * `Mob.getNextMovementStep`, reproduced in `Trajectory.stepMob`, takes ONE sign-based step
 * towards its target, permits the diagonal only when both orthogonals are clear, and otherwise
 * tries x alone, then y alone, then nothing. There is no going around. A chaser whose line runs
 * through a body stops dead, and Jad is a 5x5 with `consumesSpace` truthy (only `JalNib` opts
 * out) that never meaningfully moves - `attackRange` 50 means it acquires line of sight on tick
 * one and parks. A stationary wall of that size is unsolvable for a greedy chaser.
 *
 * WHY THE WALL FIRST, AND WHY WAIT FOR THE SWING. Healers only jam if they are BEHIND the body
 * when we cross - strung out on the approach, they round the corner one at a time and arrive
 * anyway. Two things fix that, and this is the order they have to happen in:
 *
 *   The wall COLLECTS them. With our back to it there is nowhere for them to spread to; they
 *   close from one side and bunch against us instead of surrounding us.
 *
 *   The swing PROVES they are there. A healer that has just attacked is adjacent, out of
 *   movement for that tick, and its next step will be computed from where it stands now rather
 *   than from somewhere still on the approach. Crossing before the swing is crossing on a guess
 *   about where the stack is; crossing on the swing is crossing on a fact.
 *
 * Then the cross puts Jad between the whole bunched stack and us in one move, and the greedy
 * rule does the rest.
 *
 * A trapped healer is worth more than a dodged one. Tagged healers have aggro on US, so one
 * stuck behind Jad is neither meleeing us nor healing its Jad - it does nothing at all until
 * `YtHurKot.attackStep` kills it outright the moment its Jad dies. Every point of damage taken
 * on the measured wave-68 runs came from Yt-HurKot, so this removes the wave's damage source
 * rather than trimming it.
 */

/**
 * Tiles of clearance from Jad's footprint. Two, and it cannot be one.
 *
 * One tile out is the melee ring, where `canMeleeIfClose` turns Jad's attack into a
 * magic/range/stab coin flip no single overhead covers - the band
 * `TileScorer.routeEntersForbiddenZone` deletes outright for every other decision the bot makes.
 * Two is therefore what "as close to him as possible" actually means here: the closest legal
 * ring, hugged the whole way round.
 */
export const TRAP_CLEARANCE = 2;

export type TrapPhase = "idle" | "to-wall" | "at-wall" | "crossing" | "done";

/** A Jad's footprint. `location` is the SOUTH-WEST corner: x runs east, y runs north from it. */
function footprint(mob: Mob): { minX: number; maxX: number; minY: number; maxY: number } {
  const size = mob.size ?? 1;
  return {
    minX: mob.location.x,
    maxX: mob.location.x + size - 1,
    minY: mob.location.y - size + 1,
    maxY: mob.location.y,
  };
}

function chebyshev(a: Location, b: Location): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function taggedHealers(region: Region, player: Player): Mob[] {
  return visibleMobs(region).filter(
    (mob) =>
      mob.dying <= -1 && mob.mobName() === EntityNames.YT_HUR_KOT && mob.aggro === player,
  );
}

export function untaggedHealers(region: Region, player: Player): Mob[] {
  return visibleMobs(region).filter(
    (mob) =>
      mob.dying <= -1 && mob.mobName() === EntityNames.YT_HUR_KOT && mob.aggro !== player,
  );
}

/**
 * Which way the trap runs, by how many Jads are still up.
 *
 * THREE JADS: north to south. Two of them sit on the same northern row (18,24 and 28,24) with the
 * third south at 23,35, so backing north puts the wall behind us and the whole board in front.
 *
 * FEWER: south to north. With one of the northern pair gone the board is no longer symmetric
 * about the spawn, and reversing the run keeps it crossing the fight rather than away from it.
 *
 * Fixed for the length of a trap in practice - the wall tile and the crossing are each planned
 * once - so a Jad dying mid-run cannot flip the direction under a walk already committed to.
 */
export function trapRunsSouthward(region: Region): boolean {
  return (
    visibleMobs(region).filter(
      (mob) => mob.dying <= -1 && mob.mobName() === EntityNames.JAL_TOK_JAD,
    ).length >= 3
  );
}

/**
 * The nearest arena wall, as the tile against it closest to where we stand.
 *
 * THE MIDDLE OF THE STARTING WALL - not the nearest wall, and not straight out from wherever
 * the bot happens to be standing.
 *
 * Fixed at both ends on purpose. North wall on a three-Jad run, south on a two-Jad one (see
 * `trapRunsSouthward`); the wall end being a constant
 * tile means the healers bunch in the same place every time and the crossing that follows starts
 * from a known position rather than from whatever column the fight drifted into. The middle is
 * the one column with room on both sides, so the corner it then rounds can be either.
 *
 * `y` increases southward, so north is `ARENA_BOUNDS.minY`. `ARENA_BOUNDS` is the walkable
 * interior, so the tile is standable - the blocker ring sits one tile outside it.
 */
export function nearestWallTile(region: Region): Location {
  return {
    x: Math.floor((ARENA_BOUNDS.minX + ARENA_BOUNDS.maxX) / 2),
    y: trapRunsSouthward(region) ? ARENA_BOUNDS.minY : ARENA_BOUNDS.maxY,
  };
}


/**
 * EVERY WALK ON THIS WAVE HAS TO BE STEPPED AND MOB-AWARE, and neither is optional.
 *
 * The player's own pathfinder IGNORES MOBS - `routesFrom` walks entities only, exactly as the
 * engine does - so a single click at a distant tile does not go around a Jad, it goes straight
 * through the middle of it. That is what a "blind run" is: one click, a straight line across the
 * arena, through every body in the way, with the healers following the same line and blocked by
 * nothing.
 *
 * So routes here are built by a search that treats Jad footprints AND their melee rings as solid,
 * then handed over a few tiles at a time. Each waypoint is re-clicked on arrival, so the walk is
 * a sequence of short committed hops that actually bend around the bodies instead of one long
 * promise that cuts through them.
 */

/** Tiles no walk may cross: inside any Jad's footprint, or in its melee ring. */
function blockedByJads(region: Region): (x: number, y: number) => boolean {
  const boxes = visibleMobs(region)
    .filter((mob) => mob.dying <= -1 && mob.mobName() === EntityNames.JAL_TOK_JAD)
    .map((mob) => footprint(mob));
  return (x: number, y: number) =>
    boxes.some(
      (box) =>
        x >= box.minX - 1 && x <= box.maxX + 1 && y >= box.minY - 1 && y <= box.maxY + 1,
    );
}

/**
 * Tiles per waypoint. Two, which is exactly `PLAYER_TILES_PER_TICK`.
 *
 * One click per tick, and each click is precisely the ground a running player covers in that
 * tick - so the bot walks the tiles the search chose, in order, at full speed. Longer strides
 * hand the gaps back to the engine's pathfinder, which ignores mobs and cuts the corner it was
 * routed around; shorter ones waste ticks arriving early.
 */
export const STEP_STRIDE = 2;

/**
 * A stepped route to `to` that goes AROUND the Jads, as a handful of waypoints.
 *
 * Breadth-first over standable tiles with the Jad boxes removed, so the path it finds is one the
 * bot can actually walk without crossing a body or clipping a melee ring. The result is thinned
 * to every `STEP_STRIDE` tiles plus the destination - those are the clicks.
 *
 * Empty when there is no such path, which the caller must treat as "not now" rather than walking
 * blindly: a straight click would be exactly the failure this exists to prevent.
 */
export function steppedRoute(region: Region, from: Location, to: Location): Location[] {
  const snapshot = new ArenaSnapshot(region);
  const blocked = blockedByJads(region);
  const key = (x: number, y: number) => `${x},${y}`;

  const cameFrom = new Map<string, string | null>();
  cameFrom.set(key(from.x, from.y), null);
  let frontier: Location[] = [{ x: from.x, y: from.y }];
  let found = false;

  while (frontier.length > 0 && !found) {
    const next: Location[] = [];
    for (const tile of frontier) {
      for (let dx = -1; dx <= 1 && !found; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const x = tile.x + dx;
          const y = tile.y + dy;
          const id = key(x, y);
          if (cameFrom.has(id) || !isInsideArena(x, y) || !snapshot.canStandAt(x, y)) {
            continue;
          }
          // NEVER UNDER A JAD, DESTINATION INCLUDED. This used to exempt the target tile, which
          // meant a destination could sit inside a footprint or its melee ring - the two places
          // the whole walk exists to stay out of.
          if (blocked(x, y)) {
            continue;
          }
          // THE ENGINE'S DIAGONAL RULE: a corner can only be cut when BOTH orthogonal
          // neighbours are passable. Without this the search returns paths the player cannot
          // actually walk, the engine re-routes between the waypoints - ignoring mobs, as it
          // always does - and the "safe" path goes straight through a body after all.
          if (dx !== 0 && dy !== 0) {
            const sideA = { x: tile.x + dx, y: tile.y };
            const sideB = { x: tile.x, y: tile.y + dy };
            const open = (t: Location) =>
              isInsideArena(t.x, t.y) && snapshot.canStandAt(t.x, t.y) && !blocked(t.x, t.y);
            if (!open(sideA) || !open(sideB)) {
              continue;
            }
          }
          cameFrom.set(id, key(tile.x, tile.y));
          if (x === to.x && y === to.y) {
            found = true;
            break;
          }
          next.push({ x, y });
        }
      }
    }
    frontier = next;
  }

  if (!found) {
    return [];
  }

  const path: Location[] = [];
  let cursor: string | null = key(to.x, to.y);
  while (cursor) {
    const [x, y] = cursor.split(",").map((n) => parseInt(n, 10));
    path.push({ x, y });
    cursor = cameFrom.get(cursor) ?? null;
  }
  path.reverse();
  path.shift(); // drop the tile we are standing on

  const waypoints: Location[] = [];
  for (let i = STEP_STRIDE - 1; i < path.length; i += STEP_STRIDE) {
    waypoints.push(path[i]);
  }
  const last = path[path.length - 1];
  const tail = waypoints[waypoints.length - 1];
  if (!tail || tail.x !== last.x || tail.y !== last.y) {
    waypoints.push(last);
  }
  return waypoints;
}

/**
 * The four corners of the clearance ring, clockwise from south-west.
 *
 * `location` is the SOUTH-WEST corner of a footprint here: x runs east from it, y runs north
 * (y increases southward, and a footprint spans `y` down to `y - size + 1`).
 */
export function clearanceCorners(jad: Mob): Location[] {
  const box = footprint(jad);
  const west = box.minX - TRAP_CLEARANCE;
  const east = box.maxX + TRAP_CLEARANCE;
  const north = box.minY - TRAP_CLEARANCE;
  const south = box.maxY + TRAP_CLEARANCE;
  return [
    { x: west, y: south },
    { x: west, y: north },
    { x: east, y: north },
    { x: east, y: south },
  ];
}

/**
 * Every tile of the clearance ring around Jad - the candidates for where to cross TO.
 */
function clearanceRing(jad: Mob): Location[] {
  const box = footprint(jad);
  const west = box.minX - TRAP_CLEARANCE;
  const east = box.maxX + TRAP_CLEARANCE;
  const north = box.minY - TRAP_CLEARANCE;
  const south = box.maxY + TRAP_CLEARANCE;

  const ring: Location[] = [];
  for (let y = south; y > north; y--) {
    ring.push({ x: west, y });
  }
  for (let x = west; x < east; x++) {
    ring.push({ x, y: north });
  }
  for (let y = north; y < south; y++) {
    ring.push({ x: east, y });
  }
  for (let x = east; x > west; x--) {
    ring.push({ x, y: south });
  }
  return ring;
}

/**
 * Has a tagged healer swung at us since the last call?
 *
 * Read off `attackDelay` jumping UP to the mob's full `attackSpeed`, which is the same signal
 * `ShieldAttackerClock` uses and the only thing that writes the full cooldown back - a healer
 * chasing us counts DOWN, and past zero once it has nothing in reach. So an upward jump to
 * exactly `attackSpeed` is an attack having just happened, and nothing else produces it.
 *
 * Per-mob, by identity, so a second healer arriving does not read as the first one swinging.
 */
const lastDelay = new WeakMap<Mob, number>();

export function healerSwungThisTick(region: Region, player: Player): boolean {
  let swung = false;
  for (const mob of taggedHealers(region, player)) {
    const delay = (mob as unknown as { attackDelay?: number }).attackDelay ?? 0;
    const previous = lastDelay.get(mob);
    lastDelay.set(mob, delay);
    if (previous !== undefined && delay > previous && delay === (mob.attackSpeed ?? 4)) {
      swung = true;
    }
  }
  return swung;
}

/** The trap's premise is gone: no wall to hide behind, or nothing left chasing us. */
export function trapIsSpent(region: Region, player: Player, jad: Mob | null): boolean {
  if (!jad || jad.dying > -1) {
    return true;
  }
  return taggedHealers(region, player).length === 0;
}

/**
 * The trap's entry condition: tagging finished, and more than one Jad still up.
 *
 * NOT ON THE LAST JAD. The run costs the whole time it takes and every shot not fired during it,
 * and it is worth that while two or three bodies are on the board - the healers cannot be fought
 * off and out-positioned at the same time. With ONE Jad left there is nothing to be caught
 * between: the fight is a single body, the prayer is a flick, and the tile scorer has healers
 * back in it (see `HEALERS_MOVE_US_BELOW`) so it can price standing away from one directly.
 * Running a lap for that trades kill speed for a problem the score already solves.
 */
export function readyToTrap(region: Region, player: Player): boolean {
  const jads = visibleMobs(region).filter(
    (mob) => mob.dying <= -1 && mob.mobName() === EntityNames.JAL_TOK_JAD,
  ).length;
  return (
    jads >= 2 &&
    committedJad(region) !== null &&
    taggedHealers(region, player).length > 0 &&
    untaggedHealers(region, player).length === 0
  );
}

/**
 * A stepped walk to somewhere the nearest untagged healer can actually be blowpiped from.
 *
 * THIS IS WHY THE SCORING PULL WAS NEVER GOING TO WORK. `healerReach` is worth one point, and the
 * tile the bot is already standing on is usually earning a point of reach plus a share of
 * `losBonus` - so a tile out by the healer, which earns neither until it is arrived at, cannot
 * outbid standing still. Worse, `npcReachSoon` refuses to pay at all for a tile more than
 * `NPC_REACH_ARRIVAL_TICKS` of walking away, which is exactly the tiles a distant healer needs.
 * The pull was a nudge in a fight the other terms had already won.
 *
 * So going to tag is a COMMITTED WALK, like the trap, not a preference expressed in points. The
 * destination is the closest standable tile from which the healer is inside blowpipe reach, and
 * the route to it is stepped and bends around the Jads - see `steppedRoute`.
 *
 * Null when every untagged healer is already in reach (nothing to walk for), when there are none,
 * or when no clean path exists.
 */
export function planHealerApproach(
  region: Region,
  player: Player,
  blowpipeReach: number,
): { healer: Mob; route: Location[] } | null {
  const untagged = untaggedHealers(region, player);
  if (untagged.length === 0) {
    return null;
  }

  let target: Mob | null = null;
  let bestDistance = Infinity;
  for (const mob of untagged) {
    const distance = chebyshev(mob.location, player.location);
    if (distance < bestDistance) {
      target = mob;
      bestDistance = distance;
    }
  }
  if (!target || bestDistance <= blowpipeReach) {
    return null; // already close enough to click it
  }

  const snapshot = new ArenaSnapshot(region);
  const blocked = blockedByJads(region);
  let stand: Location | null = null;
  let standDistance = Infinity;
  for (let dx = -blowpipeReach; dx <= blowpipeReach; dx++) {
    for (let dy = -blowpipeReach; dy <= blowpipeReach; dy++) {
      const x = target.location.x + dx;
      const y = target.location.y + dy;
      if (!isInsideArena(x, y) || !snapshot.canStandAt(x, y) || blocked(x, y)) {
        continue;
      }
      if (chebyshev({ x, y }, target.location) > blowpipeReach) {
        continue;
      }
      const distance = chebyshev({ x, y }, player.location);
      if (distance < standDistance) {
        stand = { x, y };
        standDistance = distance;
      }
    }
  }
  if (!stand) {
    return null;
  }

  const route = steppedRoute(region, player.location, stand);
  return route.length > 0 ? { healer: target, route } : null;
}

/**
 * The crossing: get around Jad's NORTH CORNER, safely, by whatever path that takes.
 *
 * Coming from the middle of the north wall, the healers are stacked north of us and Jad is south.
 * Rounding one of its north corners and stepping down the side is all it takes to put a full face
 * of the body between the stack and us - which is what the greedy chaser cannot solve. Crossing
 * all the way to the far south side is further to walk for the same block.
 *
 * WHICH corner is the one AWAY from the healers, so the walk does not go back through the stack
 * it is stranding. The destination is one tile down the side from that corner rather than the
 * corner itself: standing on the corner leaves us on the footprint's diagonal, where the line
 * back to a healer clips the corner tile and a greedy step can still find its way round.
 *
 * The route is `steppedRoute`, a search with every Jad footprint AND melee ring removed from the
 * map - so it goes AROUND the bodies, which the engine's own pathfinder would not, since it
 * ignores mobs entirely. However many moves that is: one, ten, a hundred and fifty. Handed over
 * two tiles at a time so the bot walks exactly those tiles.
 */
export function planSteppedCrossing(
  region: Region,
  player: Player,
  healers: Mob[],
  jad: Mob,
): Location[] {
  const snapshot = new ArenaSnapshot(region);
  const box = footprint(jad);

  // THE RUN ENDS ON THE FAR FACE, squarely off Jad's middle column - south on a
  // north-to-south run, north on a south-to-north one.
  //
  // Rounding the north corner is how the walk GETS there - the direct line south is through the
  // body, so the search goes round - but it is not where it stops. Stopping beside the corner
  // leaves us level with the body, where a healer coming down the same side has a clear line and
  // nothing is blocked. The south face puts the full 5x5 between us and everything that stacked
  // up at the north wall, and it is the tile the fight carries on from, so the trap ends with the
  // bot in position rather than mid-manoeuvre.
  const farFace = {
    x: Math.floor((box.minX + box.maxX) / 2),
    y: trapRunsSouthward(region) ? box.maxY + TRAP_CLEARANCE : box.minY - TRAP_CLEARANCE,
  };
  const candidates: Location[] = [farFace];
  // Nudged along that face if the middle is unstandable - another Jad, or the arena edge.
  for (let offset = 1; offset <= TRAP_CLEARANCE + box.maxX - box.minX; offset++) {
    candidates.push({ x: farFace.x - offset, y: farFace.y });
    candidates.push({ x: farFace.x + offset, y: farFace.y });
  }
  for (const destination of candidates) {
    if (!isInsideArena(destination.x, destination.y) || !snapshot.canStandAt(destination.x, destination.y)) {
      continue;
    }
    const route = steppedRoute(region, player.location, destination);
    if (route.length > 0) {
      return route;
    }
  }
  return [];
}
