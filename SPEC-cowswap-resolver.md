# Spec: cowswapResolver — CoW Swap as the order source

## The question

The two existing tabs ask: *given a 1inch Fusion order, could we have filled it
profitably by hedging on KalqiX, Kyber or Bebop?*

This asks the inverted question of CoW Swap:

> For each trade a CoW solver settled, could Kyber, KalqiX or Bebop have paid
> that user more than the winning solver did?

A positive edge means the solver left money on the table.

## The constraint that shapes everything

**CoW's open orders are not publicly observable.** Verified, not assumed:

| endpoint | result |
| --- | --- |
| `GET /api/v1/auction` (the open-order set) | **403 from nginx** — solver-only, and not a User-Agent block; a browser UA is refused identically |
| `GET /api/v1/solvable_orders` | 404, no such route |
| `GET /api/v1/orders` | 405 — that path only accepts submission |
| `GET /api/v1/account/{owner}/orders` | 200, but needs the owner known in advance |

So we cannot watch a CoW order while it is live. What we *can* see is every
settled trade, on-chain. Confirmed against mainnet: `GPv2Settlement` emits
`Trade`, ~**1.2 trades/min**, with `owner`, `sellToken`, `buyToken`,
`sellAmount`, `buyAmount` and `feeAmount` all parsing.

**This is therefore a price comparison, not a speed one.** There is no lead
time, no `LOSE_SPEED`, and no "would we have won the auction" — we never saw the
order in flight. The tab must not imply otherwise.

## Method

1. Poll `eth_getLogs` on `GPv2Settlement`
   (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`) for `Trade`, topic
   `0xa07a543a…cc17`, one block at a time.
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

We necessarily quote **after** settlement — the trade must be mined before we
see it. Prices move in between, so a naive comparison flatters or punishes us at
random.

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
| `source` | `'chain'` (new, alongside ws/sweep/poll) |

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
