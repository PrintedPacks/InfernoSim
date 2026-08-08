# Scoring / Attacking — What's Actually Wired

Tracks the live decision logic in `InfernoAutomation.decide()`, vs. code that exists but isn't
called. Update this table whenever a term is added, removed, or swapped in.

## Tile scoring — `TileScorer.ts`

`score = barrageReach + npcReachSoon + losBonus + safeSpot − damageTaken`

Scored only over candidates that survive the filter: inside the arena, walkable, reachable, and
**the walk does not enter the coin-flip melee zone** (see `routeEntersForbiddenZone` below).

| Term | Status | What it does |
|---|---|---|
| `barrageReach` | **Live** | 1 if Ice Barrage reaches the focus nibbler from the route's **final** tile |
| `npcReachSoon` | **Live** | 1 if the destination is reachable within `NPC_REACH_ARRIVAL_TICKS` and, within `NPC_REACH_WINDOW_TICKS` **of arrival** (post-arrival budget, so walking distance no longer eats mob patience), some mob's **projected** position is one the engine would actually fire at (`snapshotPlayerCanSeeMob`, same predicate as `isAttackable`). The projection became trustworthy 2026-08 when `stepMob` gained the engine's **"corner safespotting"** rule (`Mob.getNextMovementStep`: a step whose footprint would land on the target cancels its vertical component) — without it a corner-jammed bat was projected into view and the bot camped a reach-1 tile, firing at nothing, until prayer hit 0 |
| `losBonus` | **Live** (2026-08) | `LOS_BONUS` (1) divided by how many **distinct** attackers have the destination in line of sight *and* range at **any tick from arrival to the end of the 12-tick horizon** (`mobSeesPlayer`), floored at 1 so an unwatched tile scores a full point rather than infinity. **Only paid where `npcReachSoon` already is** — this picks *which* fight to take, and a tile you can't shoot from isn't a fight. Full value against 1 watcher, 0.5 against 2, 0.33 against 3. Counted over the window, not on the arrival tick: mobs are still closing when you arrive, so a one-tick sample called a tile quiet at the exact moment it was being surrounded. Distinct mobs rather than the worst single tick, so two attackers taking turns still count as two. Same gathering pass now also produces `safeSpot`'s exposure flag (`watchers.size > 0`), so the two can't disagree |
| `safeSpot` | **Live** | Up to `SAFE_SPOT_BONUS` (`0.8`) for a **true** safespot, three parts: clean walk (`damageTaken === 0` after planned overheads), destination out of every attacker's projected LOS+range for the whole 12-tick horizon, **and** the board *settles* — `settlesSafe` extends the simulation with the player parked (digs stripped) until mob positions reach a fixed point (two consecutive transient-free unchanged ticks), with the tile still unseen throughout; capped at `SAFE_SPOT_SETTLE_TICKS` (80), cap without settling = no bonus. Redesigned 2026-08 (second time): twelve quiet ticks handed the full bonus to tiles that were merely **far** — a mob arriving on tick 13 beat the old test. Requires ≥1 attacker on the board (nothing to be safe from = 0). Journey damage stays priced by `damageTaken`; the meleer's dig stays priced by `damageTaken` and deliberately does not void a safespot. Shaded down by `NPC_DISTANCE_PENALTY` (`0.01`/tile, Chebyshev) from the **nearest live mob**, floored at `SAFE_SPOT_MIN` (0.1) |
| `routeEntersForbiddenZone` | **Live** (candidate filter, not a term — 2026-08) | The tile is **dropped**, exactly like one walled off behind a pillar, if the walk to it enters or ends in the melee zone of a **mager, ranger, blob, or Jad** (`canMeleeIfClose`; meleer excluded — adjacency isn't a special state for it, it's the whole fight). **Exit is allowed, entry is not**: a route may start inside the zone and walk out, but may never step back in or finish inside — otherwise a mob walking up to the player puts the player's *own* tile in the zone and every candidate including holding position is rejected, which freezes the bot. Holding position (route length 1) is never blocked, since `bestMove` needs that baseline. Zone geometry from tick-0 mob positions; these mobs park on line of sight, which is what makes a static reading defensible. Honest only because `routesFrom` transcribes the engine's `Pathing.constructPaths`, so the route judged is the route `moveTo` walks |
| ~~`forbiddenAdjacency`~~ | Replaced 2026-08 | `-1000` on the **destination** only. Vetoed ending in the zone but left the journey merely *priced*: `damageTaken` charges the magic-or-stab flip at the **average** of its two outcomes, so a route clipping the zone for one tick was cheap enough for other terms to outweigh. A 50/50 can't be prayed, so pricing it at its mean is the one treatment that makes no sense — replaced by the whole-route filter above |
| `damageTaken` | **Live** | Full 12-tick (`HORIZON_TICKS`) simulation of the walk + best possible prayer plan against it; what's left over |
| `destinationUnderMob` | **Live** (gate, 2026-08) | A destination inside any mob's footprint earns **no `npcReachSoon`, no `losBonus` and no `safeSpot`** — judged at tick 0 against real positions. The engine refuses the shot in both directions there (`closestPointTo` returns your own tile, and `hasLineOfSight` from a tile to itself trips its `collisionMath` guard), so it is the one place neither side can act. Reach claimed it anyway because the test runs *inside* the sim, and `stepMob` shuffles the mob off you **before** the trace callback — so reach was banked on a shuffle whose direction is a coin flip. Safety claimed it because nothing fires and nothing watches while you are underneath. Measured on a size-4 meleer: its entire footprint scored 2–2.79 (reach 1, los 1, safe 0.78), the best tiles on the grid, from a position where the bot can neither hit nor be hit |
| `ghostBloblets` | **Live** (sim input, not a term — 2026-08) | A dying blob is modelled as the three bloblets it is about to become (`Trajectory.ghostBloblets`), instead of as empty floor. Offsets, styles, ranges and cooldown are fixed in `JalAk.removedFromWorld` — melee on the blob's own tile, ranged at +(1,−1), magic at +(2,−2), all 18 max hit, speed 4, `attackDelay 4` — so this is deduction from a visible death, not reading `newMobs`. First attack scheduled at `dying + 1 + 4` ticks. **Derived fresh each tick** from `dying > -1`, so there is no state to reset and the prediction follows `dying` if the death animation resolves early. Verified timing: the corpse leaves `region.mobs` only *after* `postTick` and `newMobs` merge at the *start* of the next tick, so ghosts cover exactly 4 automation ticks with no gap. Ghosts count for `damageTaken`, `safeSpot` (exposure + settle), **`npcReachSoon` and the distance shading** — a player knows they are landing and positions to fight them — but are **never targetable**: the attack layer reads `visibleMobs` and cannot see them |
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

# ATTACKING

## Target priority — `KillPriority.chooseByPriority`

Per-mob priority (`PRIORITY` in `KillPriority.ts`), highest killed first, distance breaking ties
within a score. `DEFAULT_PRIORITY` (5) catches anything not listed — every mob the Inferno
spawns is listed, so it only applies to something new.

| Score | NPC | Role |
|:-----:|-----|------|
| **10** | `Jal-Nib` | nibbler — eats pillars, damage is permanent |
| 8 | `Jal-ImKot` | meleer — 49 max hit, digs when starved |
| 7 | `Jal-MejRah` | bat |
| 7 | `Jal-AkRek-Ket` | melee bloblet — 15 hp |
| 7 | `Jal-AkRek-Mej` | magic bloblet — 15 hp |
| 7 | `Jal-AkRek-Xil` | ranged bloblet — 15 hp |
| 6 | `Jal-Zek` | mager — 70 max hit, resurrects dead mobs |
| 5 | `Jal-Xil` | ranger — 46 max hit |
| 2 | `Yt-HurKot` | Jad healer |
| 2 | `Jal-MejJak` | Zuk healer |
| 1 | `JalTok-Jad` | Jad |
| 1 | `TzKal-Zuk` | Zuk |
| 1 | `Jal-Ak` | blob — killing it spawns 3 bloblets, so not pure gain |
| **0** | `Inferno shield` | Zuk's moving shield — **never targeted**, excluded upstream |

**Selection rules, in order:** loaded Ice Barrage overrides everything (`bestBarrageNibbler`,
most unfrozen nibblers in the 3×3 blast) → filter to mobs visible, alive, **attackable**
(`canBeAttacked()`) and reachable *with that mob's own gear-set range* → highest priority →
nearest within that priority (Chebyshev) → **sticky** (current target held unless strictly
outranked or unreachable) → reset on every reposition, since `moveTo()` interrupts combat.

**Resolved 2026-08:** the shield is no longer targetable by us. `AttackPlanner.isAttackable`
now asks the mob's own `canBeAttacked()`, which `ZukShield` sets false — so it is filtered out
before priority is consulted (a 0 would still win when it is the only thing in reach). Nothing
about the mobs changed: the shield still blocks, and whatever the engine points at it still
attacks it.

## Bloblet stacks (2026-08)

A "stack" is ≥2 live bloblets inside one 3×3 (`blobletsCovered`). The full flow, in order:

1. **Ghost window prep** — when a blob starts dying and the pending bloblets (priority 7)
   outrank everything alive and reachable, the 4-tick window is spent switching to mage and
   selecting Ice Barrage (`stack prep:` states). Aggro is cleared so the Kodai doesn't
   autocast at the old target; movement pauses only once there's a selection to protect
   (`moveTo` nulls it); prayer always runs first and never waits. Bounded by the window itself.
2. **Ice on the landing** — the trio lands on a fixed diagonal whose middle the blast covers
   entirely (`bestBarrageBloblet`, most-covered then nearest): one cast, `stack barrage x3`,
   15 hp each, survivors frozen *in* the stack. Hold capped at `STACK_HOLD_TICKS` (6) — unlike
   the nibbler hold this runs mid-wave under fire, so if the cast hasn't happened the stack has
   broken: stop waiting, the next walk clears the selection.
3. **Blood on surviving stacks** — a stacked bloblet target flips the gear choice to mage;
   the Kodai **autocasts Blood Barrage**, so it's purely a gear decision — no manual cast, no
   hold, nothing blocked. Damages and heals off every stacked bloblet (measured: hp 53→64
   while clearing a trio). 
4. **Blowpipe on singles** — coverage < 2 falls through to the normal path.

**Heal mode (2026-08):** when **≤2 monsters** are alive and **hp is not full**, the gear choice
flips to mage and the Kodai blood-autocasts the priority target until hp is full (`blood-heal
attacking …` in the tick log; measured hp 73→90 in one cast). Same non-blocking mechanism as
the stack blood — kill speed on a wave's tail is worth less than entering the next wave full.

Nibblers keep absolute precedence: the nibbler barrage branch runs first, and prep never fires
while a reachable nibbler outranks the pending bloblets.

## Force attack + reach fallback (2026-08)

- **Reach fallback** (`attackOptionFor`): a mob's required set first; if its weapon can't
  reach, the "tbow" set's weapon *as the loadout actually carries it*. **Never for pures**
  (`Settings.loadout === "pure"`). Set and range decided together — candidacy (`canReach`),
  the gear switch, and the attack click all read the one answer, so the switch-then-drop
  deadlock can't reopen.
- **Force attack** (instrumented backstop): 50 live-wave ticks without a shot fired
  (`FORCE_ATTACK_IDLE_TICKS`) → click the highest-priority mob regardless of reach and let the
  engine chase (`determineDestination` paths towards aggro without LOS — the behaviour
  `applyAttackPlan` normally suppresses, used deliberately). Chase stands down on kill, shot
  fired, or 100 ticks. Every engagement is counted: `FORCED: chasing …` in the tick log,
  `| FORCED xN` per wave line, total in the run summary — a rising count in sweeps is a
  regression signal, never a silent mask.

**Known gaps**

- Nothing prices remaining hp, ticks-to-kill, gear-switch cost, or what a mob is about to do.
  `TargetPlanner.chooseTarget` does — built, not wired.

# STUCK TEST

http://localhost:8000/?wave=1&mager=[[0,16]]&ranger=[[0,12]]&blob=[[15,17]]&nibblers=false&x=11&y=14


1. Pillars dispear after wave 66 - Remove pillars after wave 66 - Wave 67 hometile 18, 25, wave 68 25, 27, wave 69 no home tile, - 3000 tick time out for these waves

2. Blood Barrrage - When HP is not max, we should switch to blood barrage. To do so is just switch to magic gear and staff and autocast does blood. 
I'm not sure how to handle when is correct time to do it, Last npc, last 2 npcs? 
I just dont want it be barraging healing when it should be doing DPS.


3. Barrage Nibblers - We should try and barrrage the bloblet stack similar to nibblers.
It should be non blocking, ideally it should cast ice barrage but normal mage and autocast blood barrage is fine for now.
If there isn't a stack available and or killing them individually we should use blowpipe.
I see we are not registering the ghost bloblets as potential targets, on wave 7 with double blob we are switching to the other blob and not waiting for ghost to spawn and be our higher priority target.

4. Force Attack - After N ticks, try using a longer ranger weapon if available 
Longer range weapon - Blowpipe monster normally but can i reach with tbow, runecbow, bowfa, barrage? We can use that
If we still can't reach add like N ticks to force an attack to land on the highest priority monster. 


More Bugs: - 

Nibbler tile choice
Pure Mage's book
Closet to player tile vs first scored tile





