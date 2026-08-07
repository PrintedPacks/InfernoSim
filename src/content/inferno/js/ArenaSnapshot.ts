"use strict";

import { LineOfSightMask, Region } from "osrs-sdk";

/**
 * A flat, per-tick copy of the arena's static geometry, so the trajectory simulation can stop
 * asking the engine the same questions tens of thousands of times.
 *
 * The engine's own lookups are linear scans. `Collision.collidesWithAnyLoSBlockingEntities`
 * loops every entity in the region for a SINGLE tile, and `LineOfSight.hasLineOfSight` calls
 * it once or twice per tile stepped along the ray. `Pathing.canTileBePathedTo` is cached but
 * keyed by a freshly built template string, so it allocates on every call. Scoring hundreds of
 * candidate trajectories multiplies both into the hundreds of milliseconds - and the debug tile
 * grid makes it dramatically worse, because its markers are entities too, so drawing the
 * instrument slows down the thing it is measuring.
 *
 * Nothing here changes what the answers are. It is the same geometry, read from an array
 * instead of scanned for. Only STATIC geometry lives here: mobs are deliberately excluded,
 * because players walk under them and mob-vs-mob blocking is checked against simulated
 * positions rather than the map.
 *
 * Rebuilt every tick. Pillars are destroyed mid-wave, which changes both grids - the same
 * reason World.tickRegion purges the pathing cache every tick.
 */
export class ArenaSnapshot {
  private readonly width: number;
  private readonly height: number;

  /** 1 where an entity with collision blocks movement. */
  private readonly blocked: Uint8Array;

  /**
   * Line-of-sight mask per tile, or -1 for "no entity here".
   *
   * -1 rather than 0 because those are different states and the engine treats them the same
   * way by accident: collidesWithAnyLoSBlockingEntities returns the mask of the FIRST
   * overlapping entity, so an entity with LineOfSightMask.NONE shadows anything behind it in
   * the list. Storing "unclaimed" separately is what lets first-wins be reproduced exactly
   * rather than accidentally turning it into an OR.
   */
  private readonly losMask: Int32Array;

  constructor(region: Region) {
    this.width = region.width;
    this.height = region.height;
    this.blocked = new Uint8Array(this.width * this.height);
    this.losMask = new Int32Array(this.width * this.height).fill(-1);

    for (const entity of region.entities) {
      const size = entity.size;
      const ex = entity.location.x;
      const ey = entity.location.y;
      const blocks = entity.collisionType !== 0; // CollisionType.NONE
      const mask = entity.lineOfSight;

      // Collision.collisionMath puts an entity's footprint east and north of its location.
      for (let x = ex; x <= ex + size - 1; x++) {
        for (let y = ey - size + 1; y <= ey; y++) {
          if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
            continue;
          }
          const index = y * this.width + x;
          if (blocks) {
            this.blocked[index] = 1;
          }
          // First entity to claim a tile wins, matching the engine's early return.
          if (this.losMask[index] === -1) {
            this.losMask[index] = mask;
          }
        }
      }
    }
  }

  /**
   * Equivalent of Pathing.canTileBePathedTo(region, x, y, 1) with no mobToAvoid - which tests
   * entities only, since that call skips mobs entirely unless it is given one to ignore.
   *
   * Off-map tiles are unwalkable. The arena is fenced by blockers well inside the region, so
   * this only matters as a guard.
   */
  canStandAt(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return false;
    }
    return this.blocked[y * this.width + x] === 0;
  }

  /**
   * Equivalent of Collision.collidesWithAnyLoSBlockingEntities, flattened.
   *
   * Returns 0 for both "no entity" and "an entity that does not block", which is safe because
   * the engine's callers treat null and NONE identically - `null || x` is falsy and
   * `null & mask` is 0.
   */
  losMaskAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return 0;
    }
    const mask = this.losMask[y * this.width + x];
    return mask < 0 ? 0 : mask;
  }
}

/**
 * LocationUtils.closestPointTo, transcribed.
 *
 * A mob is not a point, and the engine never treats it as one: every player-side reach test goes
 * through the NEAREST TILE OF THE FOOTPRINT, not the corner that `location` names. For a size 1
 * nibbler the two are the same, which is why using the corner went unnoticed - but a blob is 3x3
 * and Jad is 5x5, so asking about the corner mis-measures reach by up to size-1 tiles and reports
 * "cannot shoot it" while standing beside it.
 *
 * The footprint runs east and north of `location`, matching Collision.collisionMath.
 *
 * Distance is compared squared rather than rooted: the ordering is identical, and iterating x
 * then y and keeping the first strict minimum reproduces lodash minBy's tie-breaking exactly.
 */
export function closestFootprintTile(
  fromX: number,
  fromY: number,
  mobX: number,
  mobY: number,
  size: number,
): { x: number; y: number } {
  let best = { x: mobX, y: mobY };
  let bestDistance = Infinity;
  for (let dx = 0; dx < size; dx++) {
    for (let dy = 0; dy < size; dy++) {
      const x = mobX + dx;
      const y = mobY - dy;
      const distance = (x - fromX) * (x - fromX) + (y - fromY) * (y - fromY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * LineOfSight.playerHasLineOfSightOfMob, transcribed to read from a snapshot.
 *
 * Use this - not `snapshotHasLineOfSight` directly - for anything asking "could the player attack
 * that mob from here". It is the same call `isAttackable` makes against the live region, so the
 * scorer's idea of reach and the engine's cannot disagree.
 */
export function snapshotPlayerCanSeeMob(
  snapshot: ArenaSnapshot,
  fromX: number,
  fromY: number,
  mobX: number,
  mobY: number,
  size: number,
  range: number,
): boolean {
  const point = closestFootprintTile(fromX, fromY, mobX, mobY, size);
  return snapshotHasLineOfSight(snapshot, fromX, fromY, point.x, point.y, 1, range, false);
}

/** Collision.collisionMath, verbatim. */
function collisionMath(
  x: number,
  y: number,
  s: number,
  x2: number,
  y2: number,
  s2: number,
): boolean {
  return !(x > x2 + s2 - 1 || x + s - 1 < x2 || y - s + 1 > y2 || y < y2 - s2 + 1);
}

/**
 * LineOfSight.hasLineOfSight, transcribed to read from a snapshot.
 *
 * This is a deliberate line-by-line copy, fixed-point slope arithmetic and all, rather than a
 * cleaner rewrite - the whole point is that it agrees with the engine tile for tile. Any
 * "tidying" here silently changes who can see whom, and everything would keep running while
 * quietly producing false scores.
 *
 * Pinned by test/harness/lineOfSight.test.ts, which cross-checks it against the real
 * implementation across the arena.
 */
export function snapshotHasLineOfSight(
  snapshot: ArenaSnapshot,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  s = 1,
  r = 1,
  isNPC = false,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (
    snapshot.losMaskAt(x1, y1) ||
    snapshot.losMaskAt(x2, y2) ||
    collisionMath(x1, y1, s, x2, y2, 1)
  ) {
    return false;
  }

  // assume range 1 is melee
  if (r === 1) {
    return (
      (dx < s && dx >= 0 && (dy === 1 || dy === -s)) ||
      (dy > -s && dy <= 0 && (dx === -1 || dx === s))
    );
  }

  if (isNPC) {
    const tx = Math.max(x1, Math.min(x1 + s - 1, x2));
    const ty = Math.max(y1 - s + 1, Math.min(y1, y2));
    return snapshotHasLineOfSight(snapshot, x2, y2, tx, ty, 1, r, false);
  }

  const dxAbs = Math.abs(dx);
  const dyAbs = Math.abs(dy);
  if (dxAbs > r || dyAbs > r) {
    return false;
  }

  if (dxAbs > dyAbs) {
    let xTile = x1;
    let y = (y1 << 16) + 0x8000;
    const slope = Math.trunc((dy << 16) / dxAbs);

    let xInc: number;
    let xMask: number;
    let yMask: number;

    if (dx > 0) {
      xInc = 1;
      xMask = LineOfSightMask.WEST_MASK | LineOfSightMask.FULL_MASK;
    } else {
      xInc = -1;
      xMask = LineOfSightMask.EAST_MASK | LineOfSightMask.FULL_MASK;
    }
    if (dy < 0) {
      y -= 1; // For correct rounding
      yMask = LineOfSightMask.NORTH_MASK | LineOfSightMask.FULL_MASK;
    } else {
      yMask = LineOfSightMask.SOUTH_MASK | LineOfSightMask.FULL_MASK;
    }

    while (xTile !== x2) {
      xTile += xInc;
      const yTile = y >>> 16;
      if ((snapshot.losMaskAt(xTile, yTile) & xMask) !== 0) {
        return false;
      }
      y += slope;
      const newYTile = y >>> 16;
      if (newYTile !== yTile && (snapshot.losMaskAt(xTile, newYTile) & yMask) !== 0) {
        return false;
      }
    }
  } else {
    let yTile = y1;
    let x = (x1 << 16) + 0x8000;
    const slope = Math.trunc((dx << 16) / dyAbs);

    let yInc: number;
    let yMask: number;
    if (dy > 0) {
      yInc = 1;
      yMask = LineOfSightMask.SOUTH_MASK | LineOfSightMask.FULL_MASK;
    } else {
      yInc = -1;
      yMask = LineOfSightMask.NORTH_MASK | LineOfSightMask.FULL_MASK;
    }

    let xMask: number;
    if (dx < 0) {
      x -= 1; // For correct rounding
      xMask = LineOfSightMask.EAST_MASK | LineOfSightMask.FULL_MASK;
    } else {
      xMask = LineOfSightMask.WEST_MASK | LineOfSightMask.FULL_MASK;
    }

    while (yTile !== y2) {
      yTile += yInc;
      const xTile = x >>> 16;
      if ((snapshot.losMaskAt(xTile, yTile) & yMask) !== 0) {
        return false;
      }
      x += slope;
      const newXTile = x >>> 16;
      if (newXTile !== xTile && (snapshot.losMaskAt(newXTile, yTile) & xMask) !== 0) {
        return false;
      }
    }
  }
  return true;
}
