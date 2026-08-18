"use strict";

import { EntityNames, Mob, Region } from "osrs-sdk";

import {
  distanceToFootprint,
  nibblerAt,
  NibblerThreat,
  nibblerThreats,
  observeNibblers,
} from "../../src/content/inferno/js/PillarDefence";
import { focusNibbler } from "../../src/content/inferno/js/TileScorer";

/**
 * Pins for the nibbler projection - the geometry `barrageReach` now spends as steps.
 *
 * These exist because the whole nibbler change was UNPINNED. The suite has a full-run
 * behavioural harness and a swept-edge geometry file, and neither asserts on
 * `distanceToFootprint`, `nibblerAt` or `ticksToReach` - so every test passed just as happily
 * with the footprint bug in place, and would keep passing if the projection were deleted.
 *
 * Deliberately unit tests of pure functions plus one stubbed-region test, rather than a wave
 * run. The bug these guard against is arithmetic, and a wave run reports it as "the pillar
 * died", several thousand ticks after the wrong number was computed.
 */

/** The real arena, from InfernoPillar.addPillarsToWorld. Origin is the SOUTH-WEST corner. */
const PILLARS = {
  south: { x: 21, y: 37 },
  west: { x: 11, y: 23 },
  north: { x: 28, y: 21 },
};
const PILLAR_SIZE = 3;

/** The nine tiles InfernoWaves.spawnNibblers draws from, in full. */
const SPAWNS: { x: number; y: number }[] = [];
for (let y = 25; y <= 27; y++) {
  for (let x = 19; x <= 21; x++) {
    SPAWNS.push({ x, y });
  }
}

const footprintTiles = (origin: { x: number; y: number }) => {
  const tiles: { x: number; y: number }[] = [];
  for (let x = origin.x; x < origin.x + PILLAR_SIZE; x++) {
    for (let y = origin.y - PILLAR_SIZE + 1; y <= origin.y; y++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
};

const insidePillar = (t: { x: number; y: number }, origin: { x: number; y: number }) =>
  t.x >= origin.x &&
  t.x < origin.x + PILLAR_SIZE &&
  t.y > origin.y - PILLAR_SIZE &&
  t.y <= origin.y;

/**
 * Can it actually bite from here?
 *
 * `JalNib.attackIfPossible` gates on `Pathing.dist(...) <= attackRange`, and `Pathing.dist` is
 * EUCLIDEAN - so a diagonal at 1.41 is out of range. Orthogonal adjacency only, which is why
 * this is not a Chebyshev check.
 */
const canBite = (t: { x: number; y: number }, origin: { x: number; y: number }) =>
  footprintTiles(origin).some((p) => Math.hypot(p.x - t.x, p.y - t.y) <= 1);

/** A threat with only the fields the projection reads. */
function threatAt(
  x: number,
  y: number,
  origin: { x: number; y: number } | null,
  frozen = 0,
): NibblerThreat {
  const ticksToReach = origin
    ? Math.max(0, distanceToFootprint(x, y, origin.x, origin.y, PILLAR_SIZE) - 1)
    : 0;
  return {
    mob: null as unknown as Mob,
    x,
    y,
    size: 1,
    pillar: origin,
    ticksToReach,
    frozen,
  };
}

describe("distanceToFootprint", () => {
  const { x: ox, y: oy } = PILLARS.south; // 21,37 -> x 21..23, y 35..37
  const distance = (x: number, y: number) => distanceToFootprint(x, y, ox, oy, PILLAR_SIZE);

  // All four faces at one tile out. The point of the test is that they all read 1: the old
  // chebyshev-to-corner formula agreed on south and west and was wrong by 2 on north and east,
  // because the origin IS the south-west corner.
  it("reads 1 from every face of a 3x3, including the two the corner formula got wrong", () => {
    expect(distance(22, 34)).toBe(1); // north face - corner formula said 3
    expect(distance(24, 36)).toBe(1); // east face  - corner formula said 3
    expect(distance(22, 38)).toBe(1); // south face - corner formula agreed
    expect(distance(20, 36)).toBe(1); // west face  - corner formula agreed
  });

  it("is 0 inside the footprint and 1 on a diagonal corner", () => {
    for (const tile of footprintTiles(PILLARS.south)) {
      expect(distance(tile.x, tile.y)).toBe(0);
    }
    expect(distance(24, 34)).toBe(1); // NE diagonal - Chebyshev 1, but cannot bite
  });

  it("degrades to plain Chebyshev at size 1", () => {
    expect(distanceToFootprint(25, 30, 21, 37, 1)).toBe(7);
  });
});

describe("nibblerAt", () => {
  // The worked example from NIBBLER_PROJECTION_FIX.md §D. The sim steers at the pillar's
  // CORNER because that is what Mob.getNextMovementStep does - `sign(aggro.location - location)`
  // per axis. The client steers at the nearest face and lands 24,35 instead. This assertion is
  // what makes a "tidy-up" to nearest-face steering fail loudly here instead of silently.
  it("steers at the pillar corner, not the nearest face", () => {
    const threat = threatAt(30, 31, PILLARS.south);
    expect(threat.ticksToReach).toBe(6);
    expect(nibblerAt(threat, 6)).toEqual({ x: 24, y: 37 }); // NOT 24,35
  });

  it("spends no steps while frozen, then walks normally", () => {
    const threat = threatAt(30, 31, PILLARS.south, 2);
    expect(nibblerAt(threat, 2)).toEqual({ x: 30, y: 31 }); // frozen through
    expect(nibblerAt(threat, 6)).toEqual({ x: 26, y: 35 }); // 4 of the 6 ticks spent walking
  });

  it("caps at ticksToReach rather than marching into the pillar", () => {
    const threat = threatAt(30, 31, PILLARS.south);
    expect(nibblerAt(threat, 100)).toEqual(nibblerAt(threat, 6));
  });

  it("holds position while the pillar is withheld", () => {
    const threat = threatAt(30, 31, null);
    expect(threat.ticksToReach).toBe(0);
    expect(nibblerAt(threat, 12)).toEqual({ x: 30, y: 31 });
  });
});

describe("where nibblers come to rest", () => {
  // Verified against the engine's own movementStep + getNextMovementStep with real pillar
  // collision: all nine spawns converge on one tile per pillar, and the model reproduced the
  // engine on all 27 combinations. This pins the model's half of that.
  const RESTING = [
    { name: "south", origin: PILLARS.south, tile: { x: 21, y: 34 } },
    { name: "west", origin: PILLARS.west, tile: { x: 14, y: 23 } },
    { name: "north", origin: PILLARS.north, tile: { x: 27, y: 21 } },
  ];

  for (const { name, origin, tile } of RESTING) {
    it(`${name}: every spawn converges on ${tile.x},${tile.y} and can bite from it`, () => {
      for (const spawn of SPAWNS) {
        const threat = threatAt(spawn.x, spawn.y, origin);
        expect(nibblerAt(threat, threat.ticksToReach)).toEqual(tile);
      }
      expect(canBite(tile, origin)).toBe(true);
    });
  }

  // The invariant the footprint fix exists for. A projection inside a pillar has no line of
  // sight from anywhere on the grid, so barrageReach reads 0 on all 441 candidates and the
  // nibbler is never scored at all - which is the bug that was reported.
  it("never projects a nibbler inside a pillar, at any tick or freeze", () => {
    for (const { origin } of RESTING) {
      for (const spawn of SPAWNS) {
        for (let frozen = 0; frozen <= 2; frozen++) {
          const threat = threatAt(spawn.x, spawn.y, origin, frozen);
          for (let ticks = 0; ticks <= 14; ticks++) {
            expect(insidePillar(nibblerAt(threat, ticks), origin)).toBe(false);
          }
        }
      }
    }
  });
});

describe("focusNibbler ordering", () => {
  /**
   * The behaviour change nothing else catches. `ticksToReach` is this selector's key, so the
   * footprint fix reorders it: a nibbler biting a north or east face used to read 2-3 and lose
   * focus to one still walking, and now reads 0 and wins. That is the fix working, but it moves
   * live behaviour with no assertion behind it anywhere - hence this one.
   */
  it("prefers the nibbler already biting over one still walking", () => {
    const biting = threatAt(22, 34, PILLARS.south); // ticksToReach 0
    const walking = threatAt(22, 29, PILLARS.south); // ticksToReach 5
    expect(walking.ticksToReach).toBeGreaterThan(0);
    expect(focusNibbler([walking, biting])).toBe(biting);
    expect(focusNibbler([biting, walking])).toBe(biting);
  });

  it("ignores frozen nibblers while anything is loose, and falls back when all are held", () => {
    const frozen = threatAt(22, 34, PILLARS.south, 8); // urgent but held
    const loose = threatAt(22, 29, PILLARS.south);
    expect(focusNibbler([frozen, loose])).toBe(loose);
    expect(focusNibbler([frozen])).toBe(frozen);
  });
});

describe("ticksToReach derivation", () => {
  /**
   * The blind spot itself: every other way of testing this hands `ticksToReach` in ready-made,
   * so the one line that DERIVES it - reading the pillar's size off `aggro` and measuring to
   * its footprint - was never executed by a test. That is the line the bug was on.
   */
  function regionWith(nibbler: { x: number; y: number }, pillar: { x: number; y: number }) {
    const mob = {
      mobName: () => EntityNames.JAL_NIB,
      dying: -1,
      location: { ...nibbler },
      size: 1,
      frozen: 0,
      aggro: { location: { ...pillar }, size: PILLAR_SIZE },
    };
    return { world: { getReadyTimer: 0 }, mobs: [mob] } as unknown as Region;
  }

  it("measures to the pillar's footprint, not its origin corner", () => {
    // One tile north of the south pillar's north face: already biting, so zero walking left.
    // Measured to the origin corner this read 2, and the projection then spent both steps.
    const region = regionWith({ x: 22, y: 34 }, PILLARS.south);
    observeNibblers(region); // the pillar is withheld until a nibbler has been seen once
    const [threat] = nibblerThreats(region);
    expect(threat.ticksToReach).toBe(0);
    expect(threat.pillar).toEqual(PILLARS.south);
  });

  it("withholds the pillar on the first visible tick", () => {
    const region = regionWith({ x: 22, y: 30 }, PILLARS.south);
    const [threat] = nibblerThreats(region); // no observeNibblers first
    expect(threat.pillar).toBeNull();
    expect(threat.ticksToReach).toBe(0); // unknown pillar means maximally urgent
  });
});
