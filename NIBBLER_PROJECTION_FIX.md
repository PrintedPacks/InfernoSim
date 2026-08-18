# Nibbler projection — what I'd change

Plan only. Nothing implemented. Spec is yours, verbatim; this is where each piece lands in
the client, where the client doesn't match its assumptions, and one intentional divergence.

**Sequence — two sweeps, not one:**

1. **The cooldown parity fix (§C) on its own commit and its own sweep.** It is a
   prerequisite for change 4, but it stands alone and it moves two unrelated lanes.
2. **Then the nibbler work** — change 2 first (the bug fix the other two require), then
   1, 3 and 4.

---

## The edits

| # | file | change |
| --- | --- | --- |
| 1 | `PillarDefence.NibblerThreat` | `pillar` becomes the **origin** tile; add `pillarSize`. Keep the short ctor so `KillPriorityPillarTest` still compiles. |
| 2 | `PillarDefence` | new `distanceToFootprint(x, y, originX, originY, size)` — clamp into the box, sim convention `x ∈ [x, x+size-1]`, `y ∈ [y-size+1, y]`. |
| 2 | `WorldTracker:902-908` | `ticksToReach = max(0, distanceToFootprint(...) - 1)`, replacing the chebyshev-to-corner. |
| 3 | `PillarDefence` | new `nibblerAt(threat, ticks)` — direction from `sign(nearestFootprintPoint - nibbler)` per axis (**not** the corner — see §D), steps capped at `ticksToReach`, freeze delays via `ticks - frozen`. |
| 4 | `TileScorer` | `NIBBLER_LEAD_TICKS = 1`; `barrageReach` takes `cooldownTicks`, computes `shotTick = max(arrivalTicks, cooldownTicks) + LEAD`, tests LOS against `nibblerAt(focus, shotTick)`. |
| 4 | `TileScorer.Board`, `TickState` | carry `cooldownTicks`, computed once per pass (§C). |

`arrivalTicks` reuses the existing expression verbatim — `ceil((route.size() - 1) / (double) PLAYER_TILES_PER_TICK)`, same as `routeLeavesShieldCover` (`TileScorer.java:443-444`).

Unchanged as specified: `BARRAGE_REACH_BONUS = 13`, `BARRAGE_RANGE = 10`, `focusNibbler`'s
selector, the whole targeting lane, the first-visible-tick withholding. `expectedPillarDamage`
stays dead (`NIBBLERS.md` §5).

---

## Three mismatches with the spec — your call on each

**A. `pillar` is the CENTRE today, not the origin.** `WorldTracker:423` stores
`new SimTile(anchor.x + 1, anchor.y - 1)` and the field javadoc says "centre tile". So
change 1 isn't already done — it's the opposite of done. Origin is recoverable
(`centre.x - 1, centre.y + 1`, size 3), and that reproduces your check list exactly:
centres `12,22 / 29,20 / 22,36` → origins `11,23 / 28,21 / 21,37`. **Plan:** store origin +
size on the threat, leave the `pillars` map on centres (it's identity-compared against
`PILLAR_CENTRES` for the capture string, and `pillarByOrientation` reads it).

**B. The overlay draws to that field.** `InfernoOverlay:238` draws the nibbler→pillar line
to `nibbler.pillar`; switching it to the origin moves the endpoint from the pillar's middle
to its south-west corner. Cosmetic only. **Plan:** derive the centre back for drawing, so
the overlay looks identical. Say if you'd rather it point at the corner the nibbler is
actually walking at.

**C. There is no `player.attackDelay` in the client — resolved: use the firing weapon's
speed.** The client never reads a cooldown field. It infers one from an observed attack
animation: `playerLastAttackTick` plus a flat `PLAYER_ATTACK_COOLDOWN_TICKS = 6`
(`WorldTracker:106`, `:989-990`), surfaced only as the boolean `playerAttacking`. Per your
direction this becomes per-weapon, landing **before** the nibbler work:

```java
cooldownTicks = max(0, weaponSpeed - (now - playerLastAttackTick))   // 0 when never fired
```

*Where `weaponSpeed` comes from.* There is no item-stats lookup anywhere in the plugin —
no `getItemStats`, no `getAspeed`, and `WorldTracker` is constructed with `Client` alone
(`WorldTracker:349`), so adding one means threading a new dependency through the plugin.
It isn't needed: `PLAYER_ATTACK_ANIMS` (`WorldTracker:96`) is already a per-weapon table,
and the anim that fired **is** the weapon that fired. So the int array becomes an
anim → speed lookup and `playerLastAttackSpeed` is recorded alongside
`playerLastAttackTick`, resetting with it.

Speeds confirmed — **range weapons are always on rapid**:

| anim | weapon | speed |
| --- | --- | --- |
| 10092 | blood barrage | 5 |
| 5061 | toxic blowpipe | 2 (rapid) |
| 1156 | dragon crossbow | 5 (rapid) |
| 7552 | never identified | 6 — kept from the old constant |

7552 keeps the old conservative 6, so the one anim whose weapon was never identified
retains exactly the old behaviour.

*Knock-on — this is a second parity fix, not a risk being accepted.* `playerAttacking` goes
from a flat 6-tick window to a weapon-speed one (2–5), i.e. **narrower**, and it gates
standoff-decay forgiveness (`TileScorer:628`) and the force-attack idle backstop
(`InfernoScript:1425`). The sim's equivalent is *already* weapon-speed-width:
`TileScorer.updateStandStillDecay` reads `(player.attackDelay ?? 0) > 0`, and the same
value resets the force-attack backstop. So both lanes move **toward** the sim, not away —
the old flat 6 was the divergence, and the wide-is-safe comment on it is wrong.

That makes it a self-contained parity fix that happens to be a prerequisite. Its own commit
and its own sweep, before the nibbler work — as sequenced.

Nothing here blocks the port. **A**, **B** and **C** are all settled — the crossbow speed
was the last open input and is answered above (5, rapid).

---

## D. Steering target — an intentional sim/client divergence

**Not a mismatch to fix. A difference to record.**

The spec steers `nibblerAt` at the pillar's **corner**, because that is literally what the
sim's engine does: `Mob.getNextMovementStep` is `sign(aggro.location.x - location.x)` per
axis, corner and all. Real OSRS NPC pathing does not work that way — a nibbler heads for
the nearest tile of the pillar's box.

**Client takes the clamped nearest footprint point.** A projection that is wrong in the
engine it actually runs on is worse than a parity gap with the sim. The sim keeps the
corner rule, faithful to *its* engine. Both are correct in their own house.

Worked example — nibbler at `30,31` against the south pillar (origin `21,37`, so
`x ∈ 21..23`, `y ∈ 35..37`); `ticksToReach = 6`, so 6 steps:

| steering | target | lands |
| --- | --- | --- |
| corner (sim) | `21,37` | `24,37` |
| nearest face (client) | `23,35` | `24,35` |

Both land **exactly 1 tile clear of the footprint**, which is the invariant that matters:
the `ticksToReach` cap keeps either version outside the box, so neither reintroduces the
bug change 2 exists to fix. The endpoints differ by up to `size - 1` (≈2 tiles here).

*Why that holds for nearest-face steering specifically* — worth writing down, since it is
the thing keeping the original bug dead. Greedy sign-per-axis toward the clamped point
stops **1 short on the dominant axis** and **arrives exactly on the other**, because
`ticksToReach` is the Chebyshev distance minus one and Chebyshev is the max of the two axis
gaps. So if x dominates you land on a column just outside the box; if y dominates you land
inside the box's x-range but one row outside its y-range. Either way outside — the same
reason the corner version is.

Falls out nicely: the clamp from change 2 is reused as the steering target, so
`distanceToFootprint` and `nibblerAt` share one piece of geometry rather than disagreeing
about where the pillar is.

### D.1 The divergence never fires in practice — measured, both sides

Sim side: the model reproduced its engine exactly on all 27 spawn×pillar combinations, so
`distanceToFootprint` + `nibblerAt` are **confirmed, not adjusted**.

Client side, re-run here in client coordinates (arena bounds `11..39 / 14..43` from
`TileScorer`, spawns from `WorldTracker:123-127`) rather than inherited — see D.3. Domain:
every tile any nibbler stands on during any of the nine walks, at every tick 0–14, at
freeze 0–2:

| pillar | path tiles | projections compared | disagreements |
| --- | --- | --- | --- |
| south | 17 | 765 | 0 |
| west | 23 | 1,035 | 0 |
| north-east | 32 | 1,440 | 0 |

Identical to the sim's numbers, tile count included. **Over the whole reachable state space
the two rules are indistinguishable**, so client and sim project the same nibbler tile on
every nibbler wave. §D is real in principle and never fires in practice.

### D.2 It is NOT structural — do not restate this as "the rules are equivalent"

Across *all* walkable arena tiles the two rules disagree **28.8%** of the time, by up to
**2 tiles** (per pillar: south 28.9%, west 30.4%, north-east 26.9%; 116,235 projections).
The agreement in D.1 is a property of *this* spawn block against *this* pillar layout —
nibblers approach all three pillars along a line that happens to make corner and
nearest-face collinear. Move the spawns or the pillars and it breaks immediately.

### D.3 The client re-ran it rather than inheriting the result

The sim's equivalence proves nothing about the client unless the coordinates match. They
do — `NIBBLER_SPAWN_TILES` is `x 19–21 / y 25–27` (`WorldTracker:123-127`), the same block
the sim swept — and the sweep above was re-run against the client's own constants to
establish it here. **If the live spawn tiles ever change, this has to be re-established, not
assumed.**

### D.4 The invariant, checked exhaustively

Across all 116,235 projections **neither steering rule ever landed inside a pillar** — the
thing the footprint fix exists to guarantee, now measured rather than argued from geometry.
(The sim's count is 113,805; it excluded all three footprints from the domain, this sweep
excludes only the pillar under test. Superset, same result.)

**Logged as a known, intentional divergence** — sim steers at the corner, client at the
nearest face. If a capture ever shows the two projecting different tiles, that is this and
D.2 is why, not drift.

---

## E. Where nibblers actually come to rest

Every one of the nine spawn tiles converges on **one** resting tile per pillar — the tile
the nibbler stops moving on and bites from:

| pillar | footprint | resting tile | face | ticksToReach |
| --- | --- | --- | --- | --- |
| west `11,23` | x11–13, y21–23 | **`14,23`** | east, south end | 5–7 |
| north-east `28,21` | x28–30, y19–21 | **`27,21`** | west, south end | 6–8 |
| south `21,37` | x21–23, y35–37 | **`21,34`** | north, west end | 7–9 |

All three are orthogonally adjacent to their footprint (`Trajectory.withinMeleeRange`), so
all three genuinely bite. The `ticksToReach` spread is only which of the nine tiles it
rolled; the destination does not move. They converge because the spawn block sits far
enough north-west of every pillar that greedy sign-per-axis saturates the minor axis long
before arrival.

Useful consequence: the three resting tiles are known ahead of the wave, so once a nibbler
is walking, `barrageReach` reduces to "is this candidate within 10 of `14,23` / `27,21` /
`21,34`".

**Two edges of the geometry, neither introduced by this change:**

- The **west pillar has no west face** — that would be `x10`, and `ARENA_MIN_X = 11`. It
  sits flush against the boundary, so nothing can ever bite it from that side: 9 biting
  tiles, not 12.
- On a **perfect-diagonal approach** (`|dx| == |dy|`) the projection parks the nibbler on a
  diagonal corner of the ring, which is *not* orthogonally adjacent — it cannot bite there.
  So `ticksToReach` is one tick optimistic on that approach: it needs `d` steps, not
  `d - 1`. Inherent to the Chebyshev-minus-one formula and present under corner-steering
  too. It does not arise from the spawn block (see the table above), only from a nibbler
  displaced mid-wave.

---

## Verification

`distanceToFootprint` and `nibblerAt` are pure and worth pinning directly — a nibbler on
each face of a 3×3 (north and east are the ones the old formula got wrong), a frozen one,
one already adjacent, and the §D worked example, which pins the steering choice so a future
"tidy-up" to corner-steering fails loudly instead of silently.

Two more worth pinning as a harness test, since both are cheap and both guard a claim this
document makes:

- **The three §E resting tiles**, from all nine spawn tiles — one assertion that catches any
  change to the spawn block, the pillar layout, or the steering rule at once.
- **Zero steering disagreements over the reachable domain** (D.1) plus **never inside a
  pillar** (D.4). The second is the invariant the whole footprint fix exists for; the first
  fails loudly if the spawn constants move, which is exactly what D.3 warns about.

### Blast radius — behaviour moves, not just test numbers

`ticksToReach` is **`focusNibbler`'s ordering key**, not only `expectedPillarDamage`'s delay
term (`TileScorer:261-282`). Once change 2 lands, a nibbler biting a north or east face
reads `0` and starts winning focus over one still walking — where before it read 2–3 and
lost. That reorders which nibbler the tile score chases, and through §4 which tile is
picked. It is the fix working, and it will show up in live behaviour before it shows up in
any assertion.

The visible test movement is narrower: `KillPriorityPillarTest` pins
`expectedPillarDamage`, whose delay term reads `ticksToReach`, so its numbers move too —
also the fix, not a regression. Nothing pins `focusNibbler` ordering today, so the larger
of the two changes is the one the suite will stay silent about.
