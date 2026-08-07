# Scoring / Attacking — What's Actually Wired

Tracks the live decision logic in `InfernoAutomation.decide()`, vs. code that exists but isn't
called. Update this table whenever a term is added, removed, or swapped in.

## Tile scoring — `TileScorer.ts`

`score = barrageReach + npcReachSoon + safeSpot + forbiddenAdjacency − damageTaken`

| Term | Status | What it does |
|---|---|---|
| `barrageReach` | **Live** | 1 if Ice Barrage reaches the focus nibbler from the route's **final** tile |
| `npcReachSoon` | **Live** | 1 if the destination is reachable within `NPC_REACH_ARRIVAL_TICKS` and, within `NPC_REACH_WINDOW_TICKS` **of arrival** (post-arrival budget, so walking distance no longer eats mob patience), some mob's **projected** position is one the engine would actually fire at (`snapshotPlayerCanSeeMob`, same predicate as `isAttackable`). The projection became trustworthy 2026-08 when `stepMob` gained the engine's **"corner safespotting"** rule (`Mob.getNextMovementStep`: a step whose footprint would land on the target cancels its vertical component) — without it a corner-jammed bat was projected into view and the bot camped a reach-1 tile, firing at nothing, until prayer hit 0 |
| `safeSpot` | **Live** | Up to `SAFE_SPOT_BONUS` (`0.8`) for a **true** safespot, three parts: clean walk (`damageTaken === 0` after planned overheads), destination out of every attacker's projected LOS+range for the whole 12-tick horizon, **and** the board *settles* — `settlesSafe` extends the simulation with the player parked (digs stripped) until mob positions reach a fixed point (two consecutive transient-free unchanged ticks), with the tile still unseen throughout; capped at `SAFE_SPOT_SETTLE_TICKS` (80), cap without settling = no bonus. Redesigned 2026-08 (second time): twelve quiet ticks handed the full bonus to tiles that were merely **far** — a mob arriving on tick 13 beat the old test. Requires ≥1 attacker on the board (nothing to be safe from = 0). Journey damage stays priced by `damageTaken`; the meleer's dig stays priced by `damageTaken` and deliberately does not void a safespot. Shaded down by `NPC_DISTANCE_PENALTY` (`0.01`/tile, Chebyshev) from the **nearest live mob**, floored at `SAFE_SPOT_MIN` (0.1) |
| `forbiddenAdjacency` | **Live** | `FORBIDDEN_ADJACENCY_PENALTY` (**-1000**, a hard veto, not a priced cost) if the route's destination is under or melee-adjacent to a **mager, ranger, blob, or Jad** — the mobs with `canMeleeIfClose`. Judged at the destination only (same as `barrageReach`), reuses `Trajectory.playerIsUnder`/`withinMeleeRange` directly. Meleer is deliberately excluded — adjacency isn't a special state for it, it's the whole fight |
| `damageTaken` | **Live** | Full 12-tick (`HORIZON_TICKS`) simulation of the walk + best possible prayer plan against it; what's left over |
| `standStillDecay` | **Live** (promoted from experiment 2026-08; toggle removed) | Score-only (never in `ScoreParts`): while the board is **settled** (no live mob moved since last tick — clocks pause, never reset, while mobs are still reacting) with mobs alive and the player **not firing**, the camped tile — and the previously camped tile; two slots so the A-B shuffle pays nothing, returning resumes the old clock — loses `TILE_DECAY_PER_STEP` (0.01) per `TILE_DECAY_INTERVAL_TICKS` (5). Incoming fire does not reset the clocks — that exception was exactly what the prayer camp exploited, and covering it is how this absorbed run-away pressure's job. One rule: only fighting back forgives a camp |
| ~~`npcReach`~~ | Removed | Old version judged reach at route destination instead of 1 tick ahead — replaced by `npcReachSoon` |
| ~~`runAwayPressure`~~ | Removed 2026-08 | Grid-wide tilt away from the mobs after 15 parked ticks without firing. Replaced by the revised `standStillDecay` clock above — one mechanism covering both the quiet standoff and the prayer camp |

`bestMove()` picks the top score, must beat holding position, ties broken by shorter route.

**Arrival settle (2026-08, decision layer — `InfernoAutomation`, scores untouched):** the first tick standing on a chosen **safe-spot** tile keeps the previous decision pinned instead of adopting a fresh `bestMove`. Mobs react to the player's position one tick later (engine order: mobs move, mobs attack, player moves), so a verdict rendered on the arrival tick is judged against a board that has not answered the arrival yet — measured producing a permanent two-tile oscillation (wave 55, two pillar-jammed bloblets). One settle per arrival; prayer and attacking never wait.

**Resolved 2026-08:** the empty-arena open item ("with nothing in the arena the bot holds position on a route of length one" scoring `0.8` instead of `0`) — `safeSpot` now requires at least one attacker on the board, so an empty arena scores an honest `0` and the test's original expectation of `0` is correct.

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
