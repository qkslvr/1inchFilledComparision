# Spec: cowswapSolver — simulating an actual CoW solver

## The question

`cowswapResolver` asks a *price* question about trades that already happened:

> For each settled CoW trade, would Kyber, KalqiX or Bebop have paid that user
> more than the winning solver did?

This asks the *competitive* question, live, before the outcome is known:

> If we had bid on this open order using our venues, **would we have won the
> auction** — and when we found out we had won, **would our quote still have
> been there** for us to honour?

The second half is the part that matters commercially. Winning an auction on a
quote that has evaporated by the time you must settle is not a win; it is a
loss you have to eat. No existing tab measures this.

This is a **live simulation only**. Replaying history is possible — see
[Appendix: history](#appendix-history-deliberately-unused) — and deliberately
not used.

## How this differs from cowswapResolver

|  | cowswapResolver (shadow) | cowswapSolver (this) |
| --- | --- | --- |
| when we see the order | after it settled | while it is open |
| what we compare against | the price the user got | the **winning solver's score** |
| the verdict | "a venue would have paid more" | "we would have won the auction" |
| quotes per order | exactly one | many, continuously, until it resolves |
| the novel metric | — | **does our quote still hold after we win** |
| dataset | `cowswap_1` | `cowswap_solver_1` |

They must stay separate. The shadow dataset's single-tick-per-order shape and
its `terminal_at_ms = blockTsMs + 1` trick exist precisely because it never sees
a live order; grafting a live simulation onto it would corrupt both.

## What is observable

Verified live, not assumed. All public, no key.

### `GET /api/v2/solver_competition/latest`

Advances roughly once per block. ~1 MB.

| field | type | what it gives us |
| --- | --- | --- |
| `auctionId` | int | monotonic; the join key for everything |
| `auctionStartBlock` / `auctionDeadlineBlock` | int | the window solvers had |
| `transactionHashes[]` | list | the settlement tx |
| `referenceScores{}` | map | solver → the bar it had to clear |
| `auction.orders[]` | **7,742 uids** | the solvable set — *this is the open-order feed* |
| `auction.prices{}` | **891 tokens** | native-denominated price per token — **this is what lets us score ourselves in CoW's own units** |
| `solutions[]` | 6–19 per auction | every rival's bid |

Per solution: `solverAddress`, `score`, `ranking`, `isWinner`, `filteredOut`,
`txHash`, `referenceScore`, and `orders[]` with `id` / `sellToken` / `buyToken`
/ `sellAmount` / `buyAmount` inline.

### `GET /api/v1/orders/{uid}`

Public. Gives the order **as the user signed it** — which the competition feed
does not: `sellAmount`, `buyAmount` (the limit we must beat), `kind`,
`validTo`, `partiallyFillable`, `status`, `class`, `owner`, `receiver`.

### `GET /api/v1/auction`

403, permissioned. Not needed — `auction.orders` carries the same order set.

## How the winner is determined

Fully transparent, and reproducible by us:

- `ranking` is 1..N ordered by `score` descending; `isWinner` is rank 1.
- `score` is **surplus over the user's limit price, valued in native token** at
  `auction.prices`.
- `referenceScore` is exactly the **rank-2 score** — confirmed against a live
  auction: winner's `referenceScore` (12,788,453,553,250,445) equalled rank 2's
  `score` to the wei. That is the number to beat.
- `filteredOut` marks solutions excluded from ranking.

### Reproducing a score

Worked against a live auction (ETH mainnet, auction 13627568):

```
user signed : sell 43,250 sUSD for at least 42,794,727,884 USDT
winner gave :                          42,829,499,502 USDT
surplus     =                              34,771,618 USDT
× auction.prices[USDT] / 1e18
            =                  15,220,591,303,268,651 wei native
winner's reported score          15,783,041,052,922,804 wei native
                                          → we reproduce 96.4%
```

**The 3.6% gap is an open question and must be closed before any win rate is
trusted.** Most likely the order's `protocolFees` policy (the competition feed
carries `surplus`/`volume` fee factors per order) which we are not yet applying.
A win rate computed on a score that is systematically 3.6% low would understate
our wins.

## Feasibility: can we bid before the outcome is known?

Yes — for effectively all of it. Measured two ways, because the first way was
wrong and the correction matters.

### The wrong measurement

Counting "did *we* see the order open in an earlier auction than the one that
settled it" gave 9/27 (33%), and it was reported as a hard coverage ceiling.
It is not. It measures **our sampling cadence**, not the order's lifetime.
`/latest` exposes one auction at a time and advances every ~13s; the earlier run
happened to capture a new auction only every ~36s. An order living 59s therefore
got one or two chances to appear in a sampled solvable set, and when its first
appearance was also the auction that settled it, it was bucketed as "no lead".

### The right measurement

`creationDate` on the order gives the true open lifetime, independent of how
often we look:

```
settled orders sampled                                 26
open lifetime (created -> settled)
  min 38s   p25 45s   median 59s   p75 70s   max 40 days
  open >=  10s :  26/26  (100%)
  open >=  30s :  26/26  (100%)
  open >=  60s :  11/26  (42%)
  open >= 300s :   4/26  (15%)
```

**Every settled order was biddable for at least 38 seconds.** Nothing arrives
and settles instantly. The ~38s floor is CoW's own pipeline — an order has to be
picked up into an auction, competed over, and settled.

### What actually constrains us

Not the flow: our own detection lag.

- `/latest` advances every **13s median** (min 5s, max 52s), and each payload
  carries the complete solvable set, so one observation captures every open
  order at that instant.
- Detection lag is therefore ~13s median against a ~59s median lifetime,
  leaving ~46s to quote and form a bid.

The metric to report is not "coverage" but **quote readiness**: what fraction of
an order's open life we had a live bid standing for. That is a measure of our
implementation quality, and improvable, rather than a property of CoW we are
stuck with.

## The invariant that makes this honest

Everything below hangs on one ordering, and any implementation that breaks it is
measuring something else:

```
   t0   order is open, winner NOT yet known
        └─ quote all venues  ─────────────────►  THE BID
                                                  (what we would have committed to)
   t1   auction resolves, winner published
        └─ compare our score to the winner's ──►  WON / LOST
   t2   immediately after
        └─ quote all venues AGAIN ────────────►  DID IT HOLD?
                                                  (could we actually have filled it)
```

The bid at `t0` must never be recomputed from a quote taken at or after `t1`.
A quote fetched once the winner is known is contaminated: it has seen the same
information the winner acted on. Storing the bid tick and the hold tick as
separate rows, each with its own timestamp, is what keeps them from being
conflated — a single mutable "latest quote" field would silently become the
post-outcome price.

`bid_at_ms < resolved_at_ms < hold_checked_at_ms` is asserted at write time,
and a bid whose quote arrived after the auction resolved is discarded rather
than scored.

## The simulation loop

### Phase A — discover open orders

1. Poll `/api/v2/solver_competition/latest` per block.
2. Diff `auction.orders` against the working set. Turnover is only ±6–13 uids
   per auction, so this is a handful of lookups, not 7,742.
3. For each new uid, `GET /api/v1/orders/{uid}` for the signed limit.
4. Keep only orders on pairs we can hedge, still `open`, and not expired.
5. **Never quote the standing set indiscriminately.** 7,742 orders are solvable
   at any moment and most are long-dated resting limit orders that will never
   fill near touch; ticking those is what filled the disk on BNB. Filter to
   orders within a configurable distance of market. Note that `class` does not
   help here — every settled order sampled was `class: limit`, so the field
   does not separate live flow from resting orders.

### Phase B — quote continuously

For every order in the working set, on an interval:

6. KalqiX book walk, Kyber quote, Bebop depth walk — the same three venues, the
   same cost model as the other datasets.
7. Write a tick per round. This is the "keep polling" behaviour: it produces
   both *what we would have committed to at bid time* and *the latest quote at
   the moment the outcome lands*.

### Phase C — form the bid

8. Best venue = the one maximising output after costs.
9. Our executable output: `venueOut − fillGas − venueGas − ourFee − safety`.
10. Our surplus: `ourOutput − order.buyAmount` (the signed limit).
11. Our score: `surplus × auction.prices[buyToken] / 1e18`.

### Phase D — the auction resolves

12. When the uid appears in a winner's solution, record `ourScore` and the bar.
13. **The bar is per order, not per solution.** Measured over 25 auctions: CoW
    picks **multiple non-overlapping winners** (1 winner in 15 auctions, 2 in 6,
    3 in 3, 4 in 1) and two winners never contended for the same order — not
    once. A solution's `score` covers its whole bundle, so comparing our
    single-order bid against it penalises us for volume we never bid on: a
    solver bundling five orders out-scores us while possibly offering *this*
    user less.

    Every solution reports the `buyAmount` it would deliver **per order**, so
    each rival is scored on exactly our order, against the same limit and the
    same auction price. The bar is the best of those. **WON** if
    `ourScore > bestRivalScore`.

    Residual caveat: CoW's actual selection maximises total surplus across
    non-overlapping solutions, so beating every rival on our order is a strong
    proxy for winning it rather than a proof.
14. Record which venue produced our best bid, so win rate is attributable.

### Phase E — does the quote hold? *(the point of the exercise)*

Only for auctions we would have won:

15. On learning we won, immediately re-quote all venues.
16. `held` = re-quoted output still covers what we committed to.
17. `slippageBps` = (bid output − requote output) / bid output.
18. Re-check again after a settlement-latency delay, because a real solver must
    survive the gap between winning and the tx landing, not just the instant.

## Metrics the dashboard must show

Per venue (KalqiX, Kyber, Bebop) and for best-of:

- **Win rate** — of auctions we bid on, how many we would have won.
- **Quote-hold %** — of auctions won, how often the quote survived to
  settlement. *This is the headline number.*
- Median score margin vs the winner, in bps.
- Median slippage on re-quote.
- **Quote readiness** — fraction of each order's open life we had a live bid
  standing for. Detection lag makes this less than 100%, and a win rate over
  orders we were slow to see is not the same as a win rate over all flow.

Also worth surfacing: **effective win rate = win rate × quote-hold %**. Winning
an auction you cannot honour is not a win.

## Data model

New schema `cowswap_solver_1`, new profile key `cowswapSolver`.

The existing `orders` / `ticks` tables carry most of it — ticks are already
"a venue quote at a moment", which is exactly Phase B. Additions:

`orders`:
- `cow_auction_id`, `cow_solver_count`, `cow_winner_solver`,
  `cow_winner_score`, `cow_reference_score` *(already exist)*
- `our_score`, `our_best_venue`, `bid_at_ms`, `won` (bool), `score_margin_bps`
- `limit_sell_amount`, `limit_buy_amount`, `valid_to_ms`, `partially_fillable`

New table `quote_holds` — one row per won auction per re-quote round:
- `order_hash`, `checked_at_ms`, `delay_ms`, `venue`
- `bid_out`, `requote_out`, `held`, `slippage_bps`

## The UI

- New page at `/cowswapSolver`, and an entry in the homepage navigation
  alongside Ethereum, BNB Chain and CoW Swap Ethereum.
- The trade table must be **sortable** (size, score margin, slippage, time) and
  **filterable** (venue, won/lost, held/slipped, pair).
- Three venue cards showing win rate and quote-hold %, not the current
  win/short framing.

## What this cannot tell us

State these on the page, not just here.

1. **We never actually bid.** Our presence would change rival behaviour — they
   would bid higher against us. A counterfactual win rate is an upper bound.
2. **We cannot submit solutions** without being a registered solver, so no
   result here is confirmable end-to-end.
3. **Quote readiness is not 100%.** Detection lag (~13s median) means we miss
   the opening seconds of an order's life. Report the fraction of each order's
   open life we had a standing bid for, and never imply we could have bid from
   the instant of creation.
4. **The score model is 96.4% reconciled.** Until the protocol-fee gap is
   closed, treat win rates as provisional.
5. Cross-chain inventory cost is ignored, as in the other datasets — KalqiX
   settles on Base.

## Verification plan

1. Unit tests: score computation against the worked example above; bid
   formation; hold/slippage arithmetic.
2. Reconcile our recomputed score against `score` for auctions we did *not*
   win, where the winner's surplus is known — target <1% error.
3. Run alongside `cowswapResolver` for several days; the two must agree on the
   trades they both see.
4. Sanity-check one won auction by hand, end to end.
5. Confirm quote readiness is reported, and re-measure open lifetimes over a
   longer window than the 26-order sample behind the numbers above.

## Open questions

- The 3.6% score gap — protocol fee policy is the prime suspect.
- Quote interval in Phase B: fast enough to be honest, slow enough not to
  exhaust Kyber's rate limit, which already 429s under current load.
- How to treat `partiallyFillable` orders — bid on the full amount, or model
  partial fills?
- Should losing bids be re-quoted too, as a control group for the hold rate?

## Appendix: history, deliberately unused

`/api/v2/solver_competition/{auctionId}` serves arbitrary past auctions
(verified 500 auctions back, HTTP 200 with full solutions), and
`by_tx_hash/{hash}` also resolves. A historical backtest is therefore possible.

It is **not** being built: venue quotes cannot be reconstructed for a past
moment — KalqiX books, Bebop depth and Kyber routes are only observable live —
so a historical replay could compare against the winner but could never produce
an honest bid. Live simulation is the only version of this that means anything.
