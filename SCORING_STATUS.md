# Scoring / Attacking — What's Actually Wired

Tracks the live decision logic in `InfernoAutomation.decide()`, vs. code that exists but isn't
called. Update this table whenever a term is added, removed, or swapped in.

## Tile scoring — `TileScorer.ts`

`score = barrageReach + npcReachSoon + safeSpot + forbiddenAdjacency − damageTaken`

| Term | Status | What it does |
|---|---|---|
| `barrageReach` | **Live** | 1 if Ice Barrage reaches the focus nibbler from the route's **final** tile |
| `npcReachSoon` | **Live** | 1 if the destination is reachable within `NPC_REACH_ARRIVAL_TICKS` and, within `NPC_REACH_WINDOW_TICKS` **of arrival** (post-arrival budget, so walking distance no longer eats mob patience), some mob's **projected** position is one the engine would actually fire at (`snapshotPlayerCanSeeMob`, same predicate as `isAttackable`). The projection became trustworthy 2026-08 when `stepMob` gained the engine's **"corner safespotting"** rule (`Mob.getNextMovementStep`: a step whose footprint would land on the target cancels its vertical component) — without it a corner-jammed bat was projected into view and the bot camped a reach-1 tile, firing at nothing, until prayer hit 0 |
| `safeSpot` | **Live** | Up to `SAFE_SPOT_BONUS` (`0.8`) if the move survives its walk clean (`damageTaken === 0` after planned overheads) **and** the destination stays out of every attacking mob's LOS+range from arrival to the end of the 12-tick horizon, judged geometrically against projected mob positions (`mobSeesPlayer`). Redesigned 2026-08: the old test required zero attacks fired across the **whole** trajectory, walk included — under any incoming fire no tile could qualify, the grid scored flat, and the bot camped mid-arena flicking prayer until it drained (the recurring full-hp-mob / prayer-0 wedge). Journey damage is priced by `damageTaken`, not by safety. Shaded down by `NPC_DISTANCE_PENALTY` (`0.01`/tile, Chebyshev) from the **nearest live mob**, floored at `SAFE_SPOT_MIN` (0.1) |
| `forbiddenAdjacency` | **Live** | `FORBIDDEN_ADJACENCY_PENALTY` (**-1000**, a hard veto, not a priced cost) if the route's destination is under or melee-adjacent to a **mager, ranger, blob, or Jad** — the mobs with `canMeleeIfClose`. Judged at the destination only (same as `barrageReach`), reuses `Trajectory.playerIsUnder`/`withinMeleeRange` directly. Meleer is deliberately excluded — adjacency isn't a special state for it, it's the whole fight |
| `damageTaken` | **Live** | Full 12-tick (`HORIZON_TICKS`) simulation of the walk + best possible prayer plan against it; what's left over |
| ~~`npcReach`~~ | Removed | Old version judged reach at route destination instead of 1 tick ahead — replaced by `npcReachSoon` |

`bestMove()` picks the top score, must beat holding position, ties broken by shorter route.

**Open item:** `test/harness/tileScoring.test.ts` — "with nothing in the arena the bot holds position on a route of length one" — still expects score `0`, now gets `0.8` (`SAFE_SPOT_BONUS`). Not fixed yet; waiting on confirmation of whether `0.8` is intentional (see conversation) before updating the test to match.

## Target selection

| Function | File | Status | Logic |
|---|---|---|---|
| `chooseByPriority` | `KillPriority.ts` | **Live** | Fixed bands: nibblers(10) > other(5) > blobs(1); nearest in band; sticky |
| `chooseTarget` | `TargetPlanner.ts` | Built, not wired | Prices each mob by simulated damage-prevented + progress; not called from `InfernoAutomation` |

## Prayer

| Function | File | Status | Logic |
|---|---|---|---|
| `plannedOverhead` / `applyPrayerPlan` | `PrayerPlanner.ts` | **Live** | Plans 1 tick ahead via `Trajectory.simulateTrajectory` against the chosen route |
| `willAttackNextTick` / `requiredPrayer` | `PrayerPlanner.ts` | Display/test only | Feeds `reportThreats` (on-screen summary) and harness tests — not the real prayer decision |

## Reach checks

| Check | Range used | Applies to |
|---|---|---|
| Nibbler barrage reach | `BARRAGE_RANGE` = 10, fixed | Nibblers only (`barrageReach`, `PillarDefence.expectedPillarDamage`) |
| General mob "fires next tick" | `mob.attackRange` (no lookahead padding) | Non-nibbler mobs, `willAttackNextTick` (display/test path) |
| `npcReachSoon` | Each mob's own gear-set weapon range (`attackReachFor`) | Any live mob, judged 1 tick into the route |

## Debug tooling

| Tool | File | Status | Shows |
|---|---|---|---|
| Tile grid (`Show tile grid` checkbox) | `TileGrid.ts` | **Live** | In-world overlay of all 441 scored tiles, coloured by score, labelled to 1 decimal — coarse by design, 441 labels share the screen |
| Debug Panel (`Debug Panel` button, sidebar) | `DebugPanel.ts` | **Live** | Floating panel, exact (unrounded) numbers. Currently one row: distance (Chebyshev) from the player to the nearest live mob, via `TileScorer.distanceToNearestMob` — same input `safeSpot`'s penalty reads, just not rounded for a tile label. Add more rows in `InfernoRegion.updateDebugPanel()` as needed |
