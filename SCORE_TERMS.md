# Tile score terms — as they exist in `TileScorer.java` today

Everything added or changed in this session, plus the existing gate code the
`dragTicks` discussion depends on. Verbatim from the file.

```
score = barrageReach + blobletReach + healerReach + npcReachSoon + losBonus + safeSpot + dragTicks
      + homePull + shieldPenalty + healerAoePenalty - damageTaken
      - standStillDecayAt(tile)
```

| term | value |
|---|---|
| `barrageReach` | **13** or 0 |
| `dragTicks` | **0–11** — consecutive ticks of an attacker closing on the tile |
| `blobletReach` | 1 or 0 |
| `npcReachSoon` | 1, **0.5** (blob only), or 0 |
| `losBonus` | `LOS_BONUS / watchers.size()` if `npcReachSoon > 0` |
| `safeSpot` | 0.1–0.8 |

---

## Constants

```java
	static final int NPC_REACH_ARRIVAL_TICKS = 4;
	static final int NPC_REACH_WINDOW_TICKS = 4;
	static final double SAFE_SPOT_BONUS = 0.8;
	static final double NPC_DISTANCE_PENALTY = 0.01;
	static final double SAFE_SPOT_MIN = 0.1;
	static final double HOME_PULL_PER_TILE = 0.01;
	static final double LOS_BONUS = 1;
	/**
	 * What facing the focus nibbler is WORTH -- the score, not the reach (the range stays
	 * {@link PillarDefence#BARRAGE_RANGE} = 10). Deliberately an order above every tie-breaker:
	 * a tile that can barrage the nibblers outranks any amount of positional prettiness, and
	 * only real damage outweighs it. Sim-tested at 13.
	 */
	static final double BARRAGE_REACH_BONUS = 13;

	/** What one tick of undisturbed standing on a safespot is worth. */
	static final double DRAG_TICK_BONUS = 1;
	/** How far the drag scan looks -- its OWN horizon, independent of {@link Trajectory#HORIZON_TICKS}. */
	static final int DRAG_SCAN_TICKS = 12;
	static final int SAFE_SPOT_SETTLE_TICKS = 80;
```

`Trajectory.HORIZON_TICKS = 12`, `Trajectory.PLAYER_TILES_PER_TICK = 2`,
`PillarDefence.BARRAGE_RANGE = 10`.

---

## 1. `barrageReach` — 1 → 13

Reach untouched at 10; only the score changed.

```java
	/** {@link #BARRAGE_REACH_BONUS} if a barrage from the route's END reaches the focus nibbler. */
	private static double barrageReach(SimArena arena, PillarDefence.NibblerThreat focus,
		List<SimTile> route)
	{
		if (focus == null)
		{
			return 0;
		}
		SimTile destination = route.get(route.size() - 1);
		return SimLos.playerCanSeeMob(arena, destination.x, destination.y,
			focus.x, focus.y, focus.size, PillarDefence.BARRAGE_RANGE) ? BARRAGE_REACH_BONUS : 0;
	}
```

---

## 2. `blobletReach` — new, flat +1

Tick-0 positions, live or ghost, no focus pick, no under-mob gate. Stacks on
`npcReachSoon`, so a bloblet-facing tile is 2.

```java
	/**
	 * One if a barrage from the route's END reaches ANY bloblet -- live or ghost, tick-0 positions,
	 * no focus pick and no under-mob gate. Flat, and it STACKS on npcReachSoon: a tile that faces
	 * the bloblets is worth 2, which is what pulls the bot to the tile that can actually clear
	 * them before they spread.
	 */
	private static double blobletReach(SimArena arena, List<SimMob> mobs, List<SimTile> route)
	{
		SimTile destination = route.get(route.size() - 1);
		for (SimMob mob : mobs)
		{
			if (!isBloblet(mob.name))
			{
				continue;
			}
			if (SimLos.playerCanSeeMob(arena, destination.x, destination.y,
				mob.x, mob.y, mob.size, PillarDefence.BARRAGE_RANGE))
			{
				return 1;
			}
		}
		return 0;
	}

	private static boolean isBloblet(String name)
	{
		return SimNames.JAL_AK_REK_KET.equals(name)
			|| SimNames.JAL_AK_REK_MEJ.equals(name)
			|| SimNames.JAL_AK_REK_XIL.equals(name);
	}
```

---

## 3. `npcReachSoon` — flat 1 → max over reachable mobs, 0.5 blob-only

Declared `double[] npcReachSoon = {0};`. Outer gate went `== 0` → `< 1`, and the
loop no longer breaks on first hit — it stops once it holds a full point.
Inside the main `HORIZON_TICKS` trace:

```java
				// Player half: from arrival, the mobs get the window to be
				// somewhere the engine would let us shoot them -- at the reach
				// of the weapon each mob's own gear set carries. Not the FIRST
				// reachable mob but the BEST: a blob ALONE in reach is worth only
				// half a point (shooting the parent just spawns the bloblets); a
				// blob plus anything else is still the full one. Gated on < 1, not
				// == 0, so a half-point tile can upgrade later in the window.
				if (arrivesInWindow && !destinationUnderMob
					&& npcReachSoon[0] < 1 && tick - arrivalTick[0] <= NPC_REACH_WINDOW_TICKS)
				{
					for (SimMob mob : simMobs)
					{
						Integer reach = board.reaches.get(mob.name);
						if (reach == null)
						{
							continue;
						}
						if (SimLos.playerCanSeeMob(arena, px, py, mob.x, mob.y, mob.size, reach))
						{
							double worth = SimNames.JAL_AK.equals(mob.name) ? 0.5 : 1;
							npcReachSoon[0] = Math.max(npcReachSoon[0], worth);
							if (npcReachSoon[0] >= 1)
							{
								break;   // a full point -- nothing left to upgrade to
							}
						}
					}
				}
```

---

## 4. `dragTicks` — new, gated on `safeSpot > 0`

```java
Counts APPROACH, not line of sight. The first tick stood on the tile sets a
baseline and scores nothing; each later tick scores only while the nearest
attacking mob is strictly closer than it was last tick. Acquisition ends it,
and so does the approach stalling — so a tile nothing is walking toward scores
0 rather than a full window.

```java
		// What that safespot actually BUYS: consecutive ticks of something CLOSING on it. safeSpot
		// > 0 is the ENTIRE gate -- this term adds no condition of its own, it inherits every one
		// of safeSpot's (not under a mob, an attacker alive, the route arrives, unexposed across
		// the horizon, no damage, and the board settles).
		//
		// It counts APPROACH, not line of sight. The first tick stood on the tile only sets the
		// baseline distance and scores nothing; each later tick scores only while the nearest
		// attacking mob is strictly closer than it was last tick. Acquisition ends it, and so
		// does the approach stalling -- so a tile nothing is walking toward scores 0 rather than
		// a full window, and ticks spent walking there are ticks the tile never gets to bank.
		double dragTicks = 0;
		if (safeSpot > 0)
		{
			int[] held = {0};
			double[] previousNearest = {-1};   // < 0 until the baseline tick sets it
			Trajectory.simulateTrajectory(arena, mobs, route, DRAG_SCAN_TICKS,
				(tick, simMobs, px, py) -> {
					if (px != destination.x || py != destination.y)
					{
						return false;   // still walking -- buys nothing
					}
					for (SimMob mob : simMobs)
					{
						if (mob.attacks && Trajectory.mobSeesPlayer(arena, mob, px, py))
						{
							return true;   // acquired: the drag is over, and the probe stops here
						}
					}
					double nearest = nearestAttackerDistance(simMobs, destination);
					if (previousNearest[0] < 0)
					{
						previousNearest[0] = nearest;   // baseline: scores nothing
						return false;
					}
					if (nearest >= previousNearest[0])
					{
						return true;   // nothing closing any more -- the drag is over
					}
					previousNearest[0] = nearest;
					held[0]++;
					return false;
				});
			dragTicks = held[0] * DRAG_TICK_BONUS;
		}
```

with:

```java
	/**
	 * Chebyshev distance from a tile to the nearest ATTACKING mob -- the drag scan's approach
	 * measure. Infinite when nothing on the board attacks, which the scan reads as "not closing".
	 */
	private static double nearestAttackerDistance(List<SimMob> mobs, SimTile tile)
	{
		double nearest = Double.POSITIVE_INFINITY;
		for (SimMob mob : mobs)
		{
			if (!mob.attacks)
			{
				continue;
			}
			int distance = chebyshev(tile.x, tile.y, mob.x, mob.y);
			if (distance < nearest)
			{
				nearest = distance;
			}
		}
		return nearest;
	}
```

---

## The gate `dragTicks` inherits — existing code, unchanged

### `destinationExposed`, built in the main 12-tick trace

Runs only while standing on the destination:

```java
				// Mob half: geometric, not observational -- a mob mid-cooldown
				// fires nothing while holding the tile at gunpoint.
				if (watchers.size() < totalAttackers)
				{
					for (SimMob mob : simMobs)
					{
						if (!mob.attacks || watchers.contains(mob))
						{
							continue;
						}
						if (Trajectory.mobSeesPlayer(arena, mob, px, py))
						{
							watchers.add(mob);
						}
					}
				}
				return false;
			});
		boolean destinationExposed = !watchers.isEmpty();
```

### `safeSpot`

```java
		// Safe: something on the board to be safe FROM, the walk clean under the
		// planned overheads, nothing ever holding the tile in range, never under
		// a mob (safe for exactly one coin-flip tick), and the board SETTLES
		// with the tile still unseen.
		double safeSpot = 0;
		if (!destinationUnderMob && totalAttackers > 0 && arrived[0] && !destinationExposed
			&& damageTaken == 0 && settlesSafe(arena, mobs, route))
		{
			double distance = nearestMobDistance(destination, board.targets);
			double penalty = Double.isFinite(distance) ? NPC_DISTANCE_PENALTY * distance : 0;
			safeSpot = Math.max(SAFE_SPOT_MIN, SAFE_SPOT_BONUS - penalty);
		}
```

### `settlesSafe` — 80 ticks, digs stripped

```java
	private static boolean settlesSafe(SimArena arena, List<SimMob> mobs, List<SimTile> route)
	{
		// ... digs stripped into `undiggable` ...
		Trajectory.simulateTrajectory(arena, undiggable, route, SAFE_SPOT_SETTLE_TICKS,
			(tick, simMobs, px, py) -> {
				if (px != destination.x || py != destination.y)
				{
					return false; // still walking; the journey is damageTaken's business
				}
				for (SimMob mob : simMobs)
				{
					if (mob.attacks && Trajectory.mobSeesPlayer(arena, mob, px, py))
					{
						exposed[0] = true;
						return true;
					}
				}
				// ... fixed-point detection: two consecutive transient-free unchanged ticks ...
			});

		return settled[0] && !exposed[0];
	}
```

### Note on the LOS stop condition

`safeSpot > 0` already requires `!destinationExposed`, which is
`Trajectory.mobSeesPlayer` over the same route, same mob snapshot, same 12
ticks — and `settlesSafe` extends that to 80 ticks and a fixed point. So on a
gated tile the **acquisition** branch can never fire; it is belt and braces.
The approach branch is what actually ends the count, which is why the term
varies.

---

## Diagnostics

`InfernoScript` `movepick` line:

```java
                        line.append(String.format(
                            " | pickparts reach=%.2f blob=%.2f los=%.2f safe=%.2f drag=%.2f home=%.2f dmg=%.2f",
                            pick.parts.npcReachSoon, pick.parts.blobletReach, pick.parts.losBonus,
                            pick.parts.safeSpot, pick.parts.dragTicks, pick.parts.homePull,
                            pick.parts.damageTaken));
```

## Tests

`TileScorerTest`:

- `blobAloneInReachIsHalfAPointAndAnythingElseUpgradesIt`
- `blobletInBarrageRangeAddsAFlatPointOnTopOfReach` — live, ghost, and parent-blob-is-not-a-bloblet
- `dragTicksAreGatedOnSafeSpotAndScoreNothingWithoutApproach` — every non-safespot tile is exactly 0, and so is every safespot tile on that board, because its ranger is jammed against the pillar and nothing is closing
- `pillarHiddenTileEarnsSafeSpotAndExposedFightScoresHigher` — unchanged; a reach-1 fight still outranks a safe camp there, since no tile on that board earns drag

**Not covered:** a board where an attacker actually closes on a hidden tile,
i.e. a non-zero `dragTicks`. Needs a scenario where a mob walks several tiles
toward the destination and then jams without ever acquiring.
