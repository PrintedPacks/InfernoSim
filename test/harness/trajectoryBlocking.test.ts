"use strict";

/**
 * Mob-mob blocking geometry, pinned.
 *
 * `canOccupy` reproduces `Mob.movementStep`: a step is legal when the tiles it SWEEPS INTO
 * are clear, each tested at size 1 - not when the destination footprint is clear. The two
 * only disagree once two mobs overlap, and that disagreement was a real bug. A bat spawning
 * inside a mager's 4x4 froze the mager for an entire projection, because every direction it
 * could step still overlapped the bat somewhere inside the destination footprint. The tile
 * scorer then priced a board with a paralysed attacker - tiles quoting damage 0 and three
 * threats that were really 138 and six - and the bot walked onto one and died there.
 *
 * The board below is that board. Nine assertions, and the two NORTH rows are the ones that
 * catch the sign trap: the engine computes `xOff = dx - location.x` but
 * `yOff = location.y - dy`, so yOff is positive going north. Deriving both with the same
 * subtraction sweeps the row on the far side of the mob - which looks like a tidy-up, passes
 * a reading, and is wrong on every board in every direction. If someone "fixes" it, the
 * north and north-west cases here flip to allowed and this test fails.
 */

import { ArenaSnapshot } from "../../src/content/inferno/js/ArenaSnapshot";
import { canOccupy, SimMob } from "../../src/content/inferno/js/Trajectory";

/** Open floor: only mobs block, which is what these cases are about. */
const OPEN = { canStandAt: () => true } as unknown as ArenaSnapshot;

/** Only the fields `canOccupy` reads - position, footprint, and whether it takes up space. */
function mob(x: number, y: number, size: number): SimMob {
  return { x, y, size, blocks: true } as SimMob;
}

describe("canOccupy - overlapping mobs block only the swept edge", () => {
  // The failing board: the bat is INSIDE the mager's footprint (mager covers x28-31, y25-28).
  const mager = mob(28, 28, 4);
  const bat = mob(29, 26, 2);
  const ranger = mob(28, 24, 3);
  const all = [mager, bat, ranger];

  const step = (who: SimMob, x: number, y: number) => canOccupy(OPEN, who, x, y, all);

  describe("the mager, with a bat inside it", () => {
    // The whole point of the fix: three directions the footprint test refused.
    it("may step west", () => expect(step(mager, 27, 28)).toBe(true));
    it("may step east", () => expect(step(mager, 29, 28)).toBe(true));
    it("may step south", () => expect(step(mager, 28, 29)).toBe(true));

    // SIGN TRAP CANARIES. North sweeps the row at y - size = 24, which the ranger occupies
    // (x28-30, y22-24). Get yOff backwards and this sweeps y + 1 = 29 instead, which is
    // empty floor, and both of these flip to true.
    it("may not step north - the ranger is on the swept row", () =>
      expect(step(mager, 28, 27)).toBe(false));
    it("may not step north-west - same row, plus the corner", () =>
      expect(step(mager, 27, 27)).toBe(false));
  });

  describe("the bat, wholly inside the mager", () => {
    // A 2x2 inside a 4x4 has no legal step in any direction: every tile it could sweep into
    // is still the mager. Correct, and the engine agrees - this is not the case the fix
    // relaxes, and a version that let the bat out would be too permissive.
    it("may not step north", () => expect(step(bat, 29, 25)).toBe(false));
    it("may not step south", () => expect(step(bat, 29, 27)).toBe(false));
    it("may not step west", () => expect(step(bat, 28, 26)).toBe(false));
    it("may not step east", () => expect(step(bat, 30, 26)).toBe(false));
  });

  describe("the old footprint test, for contrast", () => {
    // Not a test of production code - a demonstration that the rule this replaced refused
    // ALL of the mager's steps, which is what froze it. If this ever stops being true the
    // board above has drifted and the assertions above stop meaning what they say.
    const footprintClear = (who: SimMob, x: number, y: number) =>
      !all.some(
        (other) =>
          other !== who &&
          !(
            x > other.x + other.size - 1 ||
            x + who.size - 1 < other.x ||
            y - who.size + 1 > other.y ||
            y < other.y - other.size + 1
          ),
      );

    it("refused every direction the swept test now allows", () => {
      expect(footprintClear(mager, 27, 28)).toBe(false);
      expect(footprintClear(mager, 29, 28)).toBe(false);
      expect(footprintClear(mager, 28, 29)).toBe(false);
    });
  });
});
