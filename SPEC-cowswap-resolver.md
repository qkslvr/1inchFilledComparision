# Spec: cowswapResolver — CoW Swap as the order source

## The question

The two existing tabs ask: *given a 1inch Fusion order, could we have filled it
profitably by hedging on KalqiX, Kyber or Bebop?*

This asks the inverted question of CoW Swap:

> For each trade a CoW solver settled, could Kyber, KalqiX or Bebop have paid
> that user more than the winning solver did?

A positive edge means the solver left money on the table.

## What is and is not observable

The original design recorded that **CoW's open orders are not publicly
observable**, and built the whole dataset around reading settlements after the
fact. The 403 is real, but the conclusion drawn from it was wrong: the same
information reaches the public through a different endpoint.

| endpoint | result |
| --- | --- |
| `GET /api/v1/auction` (the solvable-order set) | **403 from nginx.** Not a User-Agent block — a browser UA is refused identically. The spec says: *"currently permissioned. Reach out in discord if you need access."* |
| `GET /api/v2/solver_competition/latest` | **200, public, no key.** ~1 MB. Advances about once per block |
| `GET /api/v1/orders/{uid}` | 200, public — full economics and status for any uid |
| `GET /api/v1/solvable_orders` | 404, no such route |
| `GET /api/v1/orders` | 405 — that path only accepts submission |
| `GET /api/v1/account/{owner}/orders` | 200, but needs the owner known in advance |
| `barn.api.cow.fi/.../api/v1/auction` | 200 — but barn is staging and held **2** orders, one of them $3 of dust |

The local-solver tutorial runs `autopilot --shadow https://api.cow.fi/mainnet`,
which pulls exactly the 403'd endpoint. That path is closed to us without being
allowlisted, and pointing it at barn would price an empty book.

### The competition feed

`/api/v2/solver_competition/latest` carries, per auction:

- `solutions[]` — every solver's `score`, `ranking`, `isWinner`, `referenceScore`,
  and inline `orders[]` with `sellToken` / `buyToken` / `sellAmount` /
  `buyAmount`. Measured: 9–19 solvers per auction.
- `auctionStartBlock`, `auctionDeadlineBlock`, `transactionHashes`
- `auction.orders` — ~7,650 solvable order uids

**Only the winner's orders are consumed.** A losing solver's bid describes a
trade that never happened. And the 7,650-order solvable set is deliberately
ignored: a 60-order sample came back 100% `class: limit`, all long-dated and
resting away from market. Ticking those is precisely the failure that
long-dated BNB orders already caused once — 86,400 ticks/day each, and a full
disk. Measured turnover is only ±6–13 uids per auction, and solvers bid on
**one** order per auction, so the live flow is one order per block.

### What this buys, and what it does not

It buys **timing**, not a race. Reading the auction as it is decided means
quoting against the block the solvers themselves solved against, instead of
~15–27s after the fill. That matters because ETH drifting 0.1% over 46s is
10 bps against measured wins of 10–18 bps — the noise was the size of the
signal.

It does **not** buy lead time. CoW batches per block; an order that fills enters
and leaves the solvable set inside one poll. There is no Dutch-auction runway
like Fusion, so there is still no `LOSE_SPEED` and no "we would have been
first". `t_actual_*` stays null.

It also buys a **competitive benchmark**. With every solver's score and the
runner-up `referenceScore`, the question can move from *"would a venue have
beaten the executed price?"* to *"would we have won the auction?"*. The scores
are stored now; computing our own score in the same units is not yet done.

## Two feeds, reconciled

| feed | source column | role |
| --- | --- | --- |
| `CompetitionFeed` | `auction` | primary — the auction as decided |
| `SettlementFeed` | `chain` | backstop — `Trade` logs, catches what the primary missed during a restart or API outage |

Both write the same `order_hash`, so whichever arrives first wins. `orders.source`
records which, so coverage of one against the other is a query rather than a
guess. Because `orderExists()` is a database round trip, an in-flight
`registering` set guards the window in which both feeds could pass the check —
the duplicate-registration bug the Fusion collector already hit once.

## Method

1. Poll `/api/v2/solver_competition/latest` every 3s; on a new `auctionId`,
   take the winning solution's orders. Fall back to `eth_getLogs` on
   `GPv2Settlement` (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`) for `Trade`,
   topic `0xa07a543a…cc17`, for anything missed.
2. For each trade the user sold `sellAmount` of `sellToken` and received
   `buyAmount` of `buyToken`. That `buyAmount` is the number to beat.
3. Ask each venue what it would pay for the same `sellAmount`:
   Kyber quote, Bebop depth walk, KalqiX book walk where the pair maps.
4. Edge per venue:

```
edge = venueOut − buyAmount − gasCostRaw − ourMarkupFee − safetyMargin
```

`buyAmount` takes the place of `auctionCost` in the Fusion model: it is what we
must hand the user, and unlike a Dutch auction it does not decay.

## The honesty problem, and how it is handled

We still quote after the auction is decided — the winner is known before we ask
any venue anything. Prices move in between, so a naive comparison flatters or
punishes us at random. The competition feed shrinks that window from tens of
seconds to roughly a block; it does not close it.

- The lag between block timestamp and quote time is recorded in
  `snapshot_age_ms`, reusing the existing column and its meaning: *how stale was
  the data behind this decision*.
- A tick beyond `degradedSnapshotAgeMs` is marked `degraded`, exactly as a stale
  KalqiX snapshot is, so a lagged comparison shows as `won*` rather than `won`.
- `t_actual_ws_ms` and `t_actual_chain_ms` stay **null**. `classify()` computes
  lead time from those, so leaving them null makes it correctly report *no* lead
  time rather than inventing one.
- `ts_ms` is the settlement block timestamp — the instant being evaluated —
  and `terminal_at_ms` is one millisecond later so the tick falls inside the
  decision horizon. Without that, every CoW tick would sit after its own
  horizon and nothing could ever classify as a win.

## Storage — the existing database, a separate schema

`schemaFor()` currently derives `chain_<id>` from the chain id, which cannot
distinguish two datasets on the same chain. A profile gains an optional schema
override, so CoW lands in **`cowswap_1`** beside `chain_1` and `chain_56`.

Every table is reused unchanged, so `classify()`, `decided_outcomes`, the prune
job and the dashboard all work without modification. Fusion-specific columns
(`rate_bump`, `auction_start_ms`, `exclusive`) stay null — they describe a Dutch
auction that CoW does not have.

Mapping:

| orders column | from |
| --- | --- |
| `order_hash` | `orderUid` from the event |
| `maker_asset` / `making_amount` | `sellToken` / `sellAmount` — what we receive |
| `taker_asset` / `taking_amount` | `buyToken` / `buyAmount` — what we pay |
| `terminal_status` | `'filled'` — it settled by definition |
| `source` | `'auction'` or `'chain'` (both new, alongside ws/sweep/poll) |
| `cow_auction_id`, `cow_solver_count`, `cow_winner_solver`, `cow_winner_score`, `cow_reference_score` | the competition, when the auction feed saw it |

## The tab

`allChains` gains an entry keyed `cowswapResolver`, labelled **CoW Swap
Ethereum**, so the dashboard renders a third tab automatically. No UI code
changes — the page already iterates whatever `allChains` returns.

## Budget

No 1inch usage at all: the order feed is on-chain logs. That matters, since the
1inch allowance has already exhausted three keys. Kyber and CoW quoting are the
only rate-limited calls, both already handled.

## Verification

1. `npm test` — unit tests for log decoding and for the edge formula using
   `buyAmount` in place of `auctionCost`.
2. Decode a real settled trade and check the implied rate against an independent
   price for the same pair.
3. Run it, confirm `cowswap_1` fills with orders and ticks, and that the tab
   appears with sane win/decided counts.
4. Hand-check one decided trade: recompute its edge from stored components.
5. Reconcile the feeds: with both running, `orders.source` should be mostly
   `auction`, and `snapshot_age_ms` for those rows should sit near a block time
   rather than the 41-46s the settlement-only feed produced.
