# Melee escape — two new refusals on `npcReachSoon`

Plan only. Nothing in this doc is implemented yet.

Scope: `TileScorer.scoreRoute`. One new constant, two new locals, three lines of gate.
`safeSpot`, `damageTaken`, `dragTicks`, `barrageReach`, `blobletReach`, `homePull` and
every other term are untouched.

---

## 1. Root cause

`getNextMovementStep` replaces the chase with a coin flip whenever the player is inside
the mob's footprint:

```java
if (Random.get() < 0.5) { dy = y; dx = x + (Random.get() < 0.5 ? 1 : -1); }
else                    { dx = x; dy = y + (Random.get() < 0.5 ? 1 : -1); }
```

Four outcomes at 25% each, drawn from a generator the scorer cannot read without
desyncing the run. Our `Trajectory.stepMob` picks one of them deterministically —
`Trajectory.java:304-317`, "step off along the axis it is furthest out on" — so it is
right a quarter of the time. Every escape tile was therefore scored against a board that
usually didn't happen: the bot walked out from under a meleer, arrived back underneath,
re-scored, picked another tile, oscillated.

Away from the player there is no RNG at all (`Integer.signum` per axis plus the corner
rule, `Trajectory.java:329-342`), so that half was always predictable — and simply wasn't
being asked about.

The fix is not to predict the flip. It is to step outside its range, and to refuse to
score anything downstream of it.

---

## 2. Where it goes

Both conditions join the existing `destinationUnderMob` on the reach gate at
`TileScorer.java:738`. Any one of them zeroes `npcReachSoon`, and `losBonus` follows
for free — it is already gated on `npcReachSoon[0] > 0` at `TileScorer.java:852`.

```java
if (arrivesInWindow && !destinationUnderMob && !insideShuffleRange && !walkedUnderMob[0]
    && npcReachSoon[0] < 1 && tick - arrivalTick[0] <= NPC_REACH_WINDOW_TICKS)
```

`healerReach` (`TileScorer.java:857`) keeps only its own `destinationUnderMob` gate —
it is a tick-0 geometry test on the live board, it asks the projection nothing, so
neither new refusal has anything to say about it.

---

## 3. `walkedUnderMob` — the route clips a footprint

A `boolean[] walkedUnderMob = {false}` declared beside `arrived` / `arrivalTick`, set
inside the main `simulateTrajectory` callback:

```java
(tick, simMobs, px, py) -> {
    // Inside a footprint anywhere along the walk: from here the engine rolls the
    // shuffle, so every projected mob position after this tick is one guess in four.
    // Tested before the on-destination early return, so the ARRIVAL tick is covered
    // by the same line -- a chaser standing on the destination when we get there is
    // a fact the projection genuinely knows.
    for (SimMob mob : simMobs)
    {
        if (Trajectory.playerIsUnder(mob, px, py))
        {
            walkedUnderMob[0] = true;
            break;
        }
    }
    if (px != destination.x || py != destination.y)
    {
        return false;
    }
    if (!arrived[0]) { ... }
```

Ordering is load-bearing and is the whole reason no separate arrival flag is needed:

- **Before** the `px != destination` early return — otherwise mid-walk ticks never run it.
- **Before** `arrived[0]` is set — so the arrival tick itself is tested while still
  "up to and including arrival", rather than needing its own case.

Covers two failures with one check: a route that clips a footprint mid-walk rolls the
shuffle *there* and poisons every projected position after it; and a chaser occupying the
destination on the arrival tick is refused without a second test.

**Consequence worth signing off on.** The check is unconditional, so it also fires on
ticks *after* arrival, if a mob walks onto us while we stand there. Because
`npcReachSoon` is a running `Math.max` that is never recomputed, a late set cannot
retract a point already banked — it only blocks a further upgrade inside the remaining
window. That is consistent (once a mob is on us, the rest of the projection is a coin
flip again) but it is strictly more than "up to and including arrival". The alternative
is an extra `!arrived[0]` guard, which reintroduces the flag the ordering exists to
avoid. **Plan: ship it unconditional.**

---

## 4. `insideShuffleRange` — escaping from under a mob

Only when the player is *currently* inside a footprint, judged at tick 0 off the first
tile of the route (`route.get(0)` — the live player position). Computed next to
`destinationUnderMob`, before the trajectory call:

```java
/** The engine's shuffle moves a mob one tile on one axis, so its four outcomes are
 *  exactly the footprint dilated by one. A tile outside that dilation escapes EVERY
 *  roll; a tile inside it is a coin flip we cannot read. */
static final int UNDER_MOB_SHUFFLE_TILES = 1;
```

```java
// Escaping from under a mob: the projection is lying about where that mob lands, so
// this refusal deliberately asks it nothing. Pure tick-0 geometry -- for each mob we
// are standing under, its footprint dilated by UNDER_MOB_SHUFFLE_TILES on every side
// is a no-reach zone for the destination.
boolean shuffleRange = false;
SimTile start = route.get(0);
for (SimMob mob : mobs)
{
    if (Trajectory.playerIsUnder(mob, start.x, start.y)
        && Trajectory.overlaps(
            mob.x - UNDER_MOB_SHUFFLE_TILES,
            mob.y + UNDER_MOB_SHUFFLE_TILES,
            mob.size + 2 * UNDER_MOB_SHUFFLE_TILES,
            destination.x, destination.y, 1))
    {
        shuffleRange = true;
        break;
    }
}
final boolean insideShuffleRange = shuffleRange;
```

The dilation is just `Trajectory.overlaps` with the anchor shifted and the size grown.
Sim footprint convention (`Trajectory.java:132-135`): x runs `[mob.x, mob.x + size - 1]`,
y runs `[mob.y - size + 1, mob.y]`, y increasing southward. Shifting the anchor to
`(mob.x - 1, mob.y + 1)` and the size to `size + 2` gives `[mob.x - 1, mob.x + size]` ×
`[mob.y - size, mob.y + 1]` — one tile of margin on all four sides, which is precisely
the union of the four coin-flip outcomes. No new geometry helper.

**Keep it scoped to the under-a-mob case.** Applying the same pessimism when the mob's
move *is* knowable would blanket a no-reach ring around every meleer on the board,
chasing or not, and cost the bot every legitimate adjacent fighting tile.

---

## 5. Rejected — tried, measured, moved nothing

- **A `+1` reach margin against melee mobs.** Widens the reach test rather than the
  refusal; still scores against one guessed board.
- **Skipping the first tick(s) of the reach window while escaping.** The window is a
  5-tick OR-gate (`tick - arrivalTick[0] <= NPC_REACH_WINDOW_TICKS`, `NPC_REACH_WINDOW_TICKS = 4`),
  so trimming it from the front changes nothing a later tick also answers.

Both try to predict the coin flip. Neither steps outside its range. Do not re-derive them.

---

## 6. Verification

- `KillPriorityPillarTest` and the rest of the inferno suite stay green — no term
  changes value on a board with nobody underneath the player.
- Debug line at `InfernoScript.java:687` already prints `npcReachSoon` / `losBonus`;
  the signature of the fix is an escape pick whose reach reads 0 while the bot is under
  a meleer, and the oscillation (out, back under, re-pick) not recurring.
- `SCORE_TERMS.md` §3 gets the new gate line once this lands.
