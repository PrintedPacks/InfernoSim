# Nibblers — how the client handles them now

Reference for porting **client → sim**, the opposite direction to `PORTING.md`. The sim
still runs the old three-mechanism model described in §6; this file is what it should
become.

Nothing here is a proposal. Every rule below is in the code today, with the call sites
named.

---

## 1. The shape of it

Old: **three** mechanisms answered nibbler questions, and they did not agree with each
other. Now: **two lanes that share one pool and one freeze reading**, plus **one mechanism
retired from the live path**.

| question | old | now |
| --- | --- | --- |
| where to stand | `barrageReach` → focus nibbler | `barrageReach` → `TileScorer.focusNibbler` (unchanged in shape) |
| what to kill | `expectedPillarDamage`, priced | **retired** — no production caller (§5) |
| which one to click | `bestBarrageNibbler`, coverage only | `InfernoScript.nibblerTarget` — freeze-aware, coverage only in one branch (§4) |

The reconciliation is the point. Positioning and targeting now read the same
`NibblerThreat` list, the same `frozen` field, and the same `ticksToReach` ordering, so
the tile we walk to and the nibbler we shoot agree in the cases that decide a wave.

---

## 2. The data — `PillarDefence.NibblerThreat`

Nibblers **never enter the trajectory simulation**. Their aggro is a pillar, not the
player, so they contribute nothing to `damageTaken`, nothing to prayer, nothing to
`npcReachSoon`. They live in their own list (`WorldTracker.java:889-913`) and are
excluded from `scorerMobs` entirely — exactly as the sim's `snapshotMobs` does.

The record carries: position, `size`, `ticksToReach`, `frozen`, `npcIndex` (the live NPC,
`-1` in tests), and the assigned `pillar` tile.

Three observation rules worth porting verbatim:

- **Pillar assigned once, from orientation.** A live interaction with a pillar overrides
  it when the client provides one (`WorldTracker.java:891-898`).
- **The pillar is withheld for the nibbler's first visible tick** — a real nibbler only
  turns to its pillar on its second — **but the nibbler itself is always added.** Gating
  the whole entry on knowing the pillar was a real bug: it made a brand-new nibbler
  invisible to *attack targeting*, not just to pillar scoring, and with an empty board a
  closer bat could win a target it should never have been a candidate for
  (`WorldTracker.java:879-888`).
- **Unknown pillar ⇒ `ticksToReach = 0`**, i.e. maximally urgent, rather than omitting
  the threat. Conservative: never under-prices the wall for the one tick this holds.

`ticksToReach = max(0, chebyshev(nibbler, pillar) - 1)` — walking ticks before it is
adjacent and can start biting.

**With every pillar down**, nibblers hunt the player instead (user-verified) and fall
through to the ordinary combat-mob path — no threat list, no special casing.

---

## 3. Positioning lane — `focusNibbler` + `barrageReach`

`TileScorer.focusNibbler` (`TileScorer.java:261-282`): the most urgent **loose** nibbler
while any is loose; the whole pool otherwise. A frozen nibbler is not advancing on a
pillar, so it is not what you reposition for.

```java
List<NibblerThreat> pool = loose.isEmpty() ? threats : loose;
// then: min ticksToReach over the pool
```

`barrageReach` (`TileScorer.java:353-364`): a flat `BARRAGE_REACH_BONUS = 13` if a barrage
from the route's **end** reaches that focus, at `BARRAGE_RANGE = 10`. Binary, not priced.

The 13 is deliberately an order above every tie-breaker — a tile that can barrage the
nibblers outranks any amount of positional prettiness, and only real damage outweighs it
(`TileScorer.java:63-68`). This is the term the file's header comment does *not* describe:
pillar damage in the tile score is what the design was drawn around; the flat reach bonus
is what is actually there.

---

## 4. Targeting lane — `nibblerTarget`

`InfernoScript.nibblerTarget` (`InfernoScript.java:953-992`) is **the one answer**, shared
by the ice cast and the ordinary magic attack so the two can never disagree (user rule,
2026-08-15):

| board | pick | why |
| --- | --- | --- |
| some frozen, something loose | the **loose one nearest to biting** | a frozen nibbler is neutralised for up to 32 ticks, so it is not the threat |
| all frozen | the **most urgent** overall | coverage cannot decide it (below) |
| none frozen | **best-coverage stack centre** (`bestBarrageNibbler`) | nothing is neutralised, so the 3×3 is the whole point |

The all-frozen branch is the subtle one and is commented as such in the code: coverage
counts only *unfrozen* nibblers, so with the whole pack frozen every candidate scores
zero, they all tie, and the tie-break falls through to distance **from the player** —
which is the wrong question. Nothing is moving, so the only thing that ranks them is how
close each already sits to its pillar.

`bestBarrageNibbler` (`InfernoScript.java:994-1024`) is unchanged from the old model: for
each candidate centre, count unfrozen nibblers within Chebyshev 1 (the 3×3 lands **on the
target**, so the cast is really a choice of centre); most covered wins, nearest to the
player breaks ties. Frozen nibblers are excluded from coverage but remain valid centres.

Two consumers, both going through that one function:

- **`spendBarrage`** (`InfernoScript.java:1084`) — spends a loaded barrage, but only on the
  first chance each wave, or when nothing else is being fought. The cast lane **arms only,
  never clicks**; the attack lane owns every target decision.
- **The attack lane** (`InfernoScript.java:1355`) — taken *ahead* of
  `KillPriority.chooseByPriority`, specifically to defeat its stickiness. Nibblers are
  priority 10 (`KillPriority.java:31`, "pillar damage is permanent") so one always wins on
  priority anyway — but equal priority is never a reason to switch inside
  `chooseByPriority`, so a frozen incumbent would hold us while another nibbler is loose
  and walking into a pillar.

Nibblers join the clickable board from the threat list rather than `scorerMobs`
(`clickableMobs`, `InfernoScript.java:1131-1156`), shared by ordinary targeting and the
force-attack backstop so the two cannot disagree about what "something to shoot at" means.
Attacking one blood-barrages the pack, since the mage set autocasts blood spells.

---

## 5. What was retired — `expectedPillarDamage`

`PillarDefence.expectedPillarDamage` (`PillarDefence.java:79-104`) still exists, still
compiles, and is still pinned by `KillPriorityPillarTest`. **It has no production
caller** — verified by grep across `src/`: the only references outside its own file are
four assertions in that test.

It is worth understanding before porting, because the old framing of it was slightly
wrong. It was never purely "what to attack": it is evaluated at the **destination of the
route it is handed**, so it prices *"given where I will be standing, which nibblers can I
still reach"*. It answers a positional question inside a targeting decision. Nobody ever
asked it the tile-scoring question directly — `TileScorer` imports `NibblerThreat`,
`focusNibbler` and `BARRAGE_RANGE` from `PillarDefence`, and pointedly not that.

The model it encodes, for reference:

- A nibbler reachable from the tile counts as **neutralised** — at 10 HP a barrage that
  touches it kills it, and one that somehow does not still freezes it for 32 ticks.
  Deliberately binary; pricing it properly would mean simulating our own damage output,
  which the trajectory sim does not do.
- Otherwise `bitingTicks = horizon - frozen - ticksToReach` (frozen and walking delays
  add, since a frozen nibbler has not started walking), `attacks = bitingTicks / 4`, and
  each attack costs `4 / 2 = 2` mean damage.
- Scale: ~half a point of pillar HP per tick, against a pillar's 255. Three nibblers alive
  for twenty ticks is ~30 HP — trivial in one wave, decisive across sixty-two.

**Porting decision to make explicitly:** either port the retirement (two lanes, no pricing)
or port the function and wire it up. Do not port it dark, as the client currently has it —
a priced model with no caller is exactly the kind of thing that reads as live when someone
next opens the file.

---

## 6. The difference, old → now

1. **Three voices became two.** `expectedPillarDamage` left the live path. Nothing
   consumes a priced pillar-damage number any more; urgency is carried entirely by
   `ticksToReach` ordering.
2. **Targeting became freeze-aware.** The old `bestBarrageNibbler` was coverage-only, so a
   frozen pack tied at zero coverage and the tie-break silently became "nearest to the
   player". Now freeze is read first and coverage only decides the none-frozen board.
3. **Positioning and targeting share a pool and a freeze reading.** Old: you could be
   positioned for the most urgent nibbler and then barrage a different, better-covered
   one, with nothing reconciling them. Now they agree by construction on every board where
   any nibbler is frozen.
4. **Targeting jumps the priority queue's stickiness.** New: the nibbler pick is taken
   ahead of `chooseByPriority` so a frozen incumbent cannot hold focus while a loose one
   walks into a pillar.
5. **A new nibbler is targetable on its first visible tick**, even though its pillar is
   withheld until its second.

---

## 7. The residual seam — read this before claiming they agree

The code comment at `InfernoScript.java:947-949` says positioning and targeting "agree by
construction". That is exactly true for the frozen branches and **not** exactly true when
**no** nibbler is frozen: positioning takes the most urgent (`focusNibbler` → min
`ticksToReach`), targeting takes the best-covered stack centre. Same pool, different
selector, so they can name different nibblers.

In practice both are usually inside barrage range of the chosen tile, so the cast still
lands — but it is a real seam, it is the *original* bug's shape in miniature, and it is the
first thing to look at if the sim shows a wave where the bot walks for one nibbler and
casts at another. Port it as-is if you want parity with the client; just port it
knowingly.

---

## 8. Open note, not current behaviour

`KNOWN_ISSUES.MD:42` records an idea — *"Nibbler reach scoring redone simply as +2 reach,
no damage for ticks or anything; use the player's attack cooldown for distance to move"* —
which is **not implemented**. Current is the flat `BARRAGE_REACH_BONUS = 13` of §3. Flagged
here so the sim port does not pick up the note as though it were the state of the client.
