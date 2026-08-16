# Mob-mob blocking — `canOccupy` was stricter than the engine

**Landed.** Written as a plan, kept as the record of why. Shipped allocation-free (§3),
with `fitsOnMap` left whole-footprint (§3) and the no-op axis settled as inert (§5).

Scope: `Trajectory.canOccupy` and one new private helper. No call-site changes, no
scorer changes, no new constants.

---

## 1. The divergence

`canOccupy` (`Trajectory.java:143-168`) tests the **whole destination footprint** against
every other mob's footprint:

```java
if (overlaps(x, y, mob.size, other.x, other.y, other.size))
{
    return false;
}
```

`Mob.movementStep` does not. It builds `getXMovementTiles` / `getYMovementTiles` and tests
only those **swept edge tiles**, each at size 1, for entities and mobs alike. Nothing
*inside* the destination footprint is re-checked.

The two agree until two mobs overlap — and then they disagree completely.

**The failing board.** A bat spawning inside a mager's 4×4 froze the mager for the entire
projection: every direction it could step still overlapped the bat somewhere inside the
destination footprint, so the footprint test refused all of them, while the engine —
checking only the row being swept into — let it walk. The scorer then priced a board with
a paralysed attacker. Tiles quoting `damageTaken 0, threats 3` were really `138, 6`; the
bot walked onto one and died.

Not a one-board fluke. Any two overlapping mobs did this to each other — bloblet stacks,
spawn clusters, anything jammed against something big.

**The wall test changes shape too, and that part is a no-op.** `canStandAt` now runs on
the swept tiles rather than the whole destination footprint, which is worth stating
outright so a reviewer doesn't have to derive it: the destination footprint is the current
one minus the trailing edge plus the leading edge, and the current one is clear by
definition — the mob is standing in it. So footprint-clear and edge-clear are equivalent
for anything not already overlapping. It diverges only in the same overlap case this fix
exists for.

---

## 2. The swept tiles

For a step from the mob's corner to `(dx, dy)`, with `size = mob.size`:

| offset | tiles |
| --- | --- |
| `xOff = +1` | the column at `x + size` |
| `xOff = -1` | the column at `x - 1` |
| `yOff = -1` | the row at `y + 1` |
| `yOff = +1` | the row at `y - size` |

The column sweep runs rows `y - i`; the row sweep runs columns `x + i`, over the same
index range. That range extends by one on a diagonal so the corner tile is covered:

```
start = (other axis == -1) ? -1 : 0
end   = (other axis == +1) ? size + 1 : size
```

**The trap — the engine's two offsets do not share a sign convention.** `movementStep`
computes

```java
xOff = dx - location.x        // positive going EAST
yOff = location.y - dy        // positive going NORTH
```

Deriving both with the same subtraction tests the row on the **opposite side** of the mob.
It looks plausible and is wrong in every direction, on every board, silently. This is the
one line to review twice.

(Sim y increases southward, so `yOff = -1` is the step south and sweeps `y + 1`; the
mob's own north edge is `y - size + 1`, so the row swept into going north is `y - size`.
The table above is already in sim coordinates.)

---

## 3. The code

Shipped allocation-free: the two sweeps are inlined into `canOccupy` and each tile is
tested **at size 1** as it is derived, with no `List<SimTile>` anywhere. One private
helper carries the per-tile test.

```java
static boolean canOccupy(SimArena arena, SimMob mob, int x, int y, List<SimMob> all)
{
    // The engine's own asymmetry, transcribed rather than tidied: movementStep
    // computes xOff = dx - location.x but yOff = location.y - dy, so yOff is
    // positive going NORTH. Deriving both with the same subtraction sweeps the
    // row on the FAR side of the mob -- plausible, and wrong in every direction
    // on every board.
    int xOff = x - mob.x;
    int yOff = mob.y - y;
    int size = mob.size;

    if (xOff != 0)
    {
        int column = xOff > 0 ? mob.x + size : mob.x - 1;
        // A diagonal extends the sweep one tile, so the corner being cut is covered.
        int start = yOff < 0 ? -1 : 0;
        int end = yOff > 0 ? size + 1 : size;
        for (int i = start; i < end; i++)
        {
            if (tileBlocked(arena, mob, column, mob.y - i, all))
            {
                return false;
            }
        }
    }
    if (yOff != 0)
    {
        int row = yOff < 0 ? mob.y + 1 : mob.y - size;
        int start = xOff < 0 ? -1 : 0;
        int end = xOff > 0 ? size + 1 : size;
        for (int i = start; i < end; i++)
        {
            if (tileBlocked(arena, mob, mob.x + i, row, all))
            {
                return false;
            }
        }
    }
    return true;
}

/** One swept tile, at size 1: the arena first, then every other blocking mob. */
private static boolean tileBlocked(SimArena arena, SimMob mob, int x, int y, List<SimMob> all)
{
    if (!arena.canStandAt(x, y))
    {
        return true;
    }
    for (SimMob other : all)
    {
        if (other == mob || !other.blocks)
        {
            continue;
        }
        if (overlaps(x, y, 1, other.x, other.y, other.size))
        {
            return true;
        }
    }
    return false;
}
```

A diagonal step tests its corner tile twice (once per sweep). Harmless — the test is a
pure predicate — and the engine does the same.

`fitsOnMap` is a separate whole-footprint test used only by `digDestination`. It stays as
it is: a surfacing meleer is placed, not stepped, so the footprint really must fit.

---

## 4. Call sites — unchanged

All three in `stepMob` (`Trajectory.java:350-354`): `canX`, `canY`, and the diagonal.
`canOccupy` has no other caller in the codebase. The corner-safespotting rule
(`Trajectory.java:339-342`) and the diagonal-needs-both-orthogonals rule
(`Trajectory.java:354`) are untouched, and both keep working off the new predicate exactly
as they did off the old one.

---

## 5. Two questions raised in review, both settled

**A no-op axis now returns `true` — inert, not merely believed inert.** `stepMob` calls
`canOccupy(arena, mob, dx, mob.y, all)` where `dx` may equal `mob.x` (both `signum`
components can be zero). Old behaviour: the footprint test ran against the mob's *current*
square and could return `false`. New behaviour: both sweeps are skipped and the result is
`true`. That cannot move anything — the only branch that can follow assigns `mob.x = dx`,
the value the mob already holds. Nothing can move that would not have moved before.
A comment on the `return true` records this.

**Allocation on the hottest path in the file — resolved by inlining.** `canOccupy` runs
three times per mob per tick, across `HORIZON_TICKS = 12` and all 441 candidate routes, so
a `List<SimTile>` there would churn millions of short-lived objects per scoring pass while
`scoreCandidates` tracks its own duration (`TileScorer.java:949`, `:981`). Shipped with the
sweeps inlined and no list — same arithmetic, same comments (§3).

---

## 6. Verification

Verified numerically on the failing board, before and after — mager at 28,28 size 4, bat
at 29,26 size 2 inside it, ranger at 28,24 size 3:

| step | old | new | |
| --- | --- | --- | --- |
| north | block | block | ranger genuinely on the swept row |
| west | block | **allow** | |
| east | block | **allow** | |
| south | block | **allow** | |
| north-west | block | block | |
| bat, all directions | block | block | correct — a 2×2 wholly inside a 4×4 |

That table is now executable rather than a one-off: `TrajectoryTest >
overlappingMobsBlockOnlyTheSweptEdge` asserts all nine cells against the same board, and
its javadoc says which rows carry the sign trap. It passes — the three previously-refused
mager steps are allowed, north and north-west still block on the ranger, and the bat stays
blocked all four ways.

The sim side is tested and swept clean.

---

## 7. Release discipline

Blast radius is **every projection**, so `damageTaken` moves on every tile of every wave.
Ship this on its own sweep — not bundled with a scorer change, or nothing that follows can
be attributed. The inferno unit suite is `./gradlew :client:runUnitTests --tests
"net.runelite.client.plugins.runevision.inferno.*"` (the default `test` task is disabled
in `runelite-client/build.gradle.kts`). All 61 inferno tests pass and **nothing needed
re-baselining** — no existing expectation encoded the old stricter blocking, because none
of the fixtures put two mobs inside each other. Read that as "the old behaviour was
untested", not "the change is small": the suite passing is much weaker evidence here than
the §6 table, which is why the table became a test.
