# Spec: CoW Swap as a fifth venue (Ethereum)

## The question

For every 1inch Fusion order on Ethereum, we already ask: could we have filled
it profitably by hedging on KalqiX, Kyber or Bebop? This adds CoW Swap to that
list.

It is the most interesting comparison of the four, because CoW is the only venue
here that is *the same kind of thing as the order itself*. Fusion and CoW are
both intent protocols settled by competing solvers in batch auctions. Kyber is a
router, Bebop is a market-maker stream, KalqiX is a central-limit order book. So
"would CoW have paid more than the Fusion auction cost" is close to asking
whether one solver network prices flow better than another.

## What was verified before writing this

All figures below came from live calls, not documentation.

| | |
| --- | --- |
| Endpoint | `POST https://api.cow.fi/mainnet/api/v1/quote` |
| Auth | none — no API key, no account |
| Rate limit | real, and a token bucket. Five back-to-back calls passed, so the first draft of this spec recorded "none" — then a later run was refused on its very first request, and 25 consecutive calls passed after it refilled. Treat it as a burst budget that recovers, not an absence of limits. No `Retry-After` or rate-limit headers are exposed |
| Size tolerance | 1 WETH → 1894.18 USDC/WETH; 100 WETH → 1894.27. Size barely moves it |
| Gas estimate | returned per quote (`gasAmount`, ~229k) |
| Protocol fee | `protocolFeeBps: 2` |

That CoW absorbs 100 WETH with no visible slippage is itself worth recording:
unlike a single pool, its price comes from solvers aggregating everything
available, so the depth story that dominates KalqiX and Bebop barely applies.

## The fee and gas decision, which is the crux

CoW quotes differently from every venue we already have, and getting this wrong
would silently bias the comparison.

Request `sellAmountBeforeFee = X`. The response returns:

- `sellAmount` — X minus CoW's fee
- `feeAmount` — that fee, denominated in the **sell** token
- `buyAmount` — what we receive, already net of the fee

So **`buyAmount` is the all-in proceeds**. Compare with Kyber, where the quote's
`amountOut` is gross and we add a swap-leg gas cost on top.

Therefore, for CoW:

```
edge = buyAmount
     − auctionCost            (what we pay the Fusion maker)
     − gasCostRaw             (gas to settle the Fusion fill ourselves)
     − ourMarkupFee           (the same 3bps assumption applied to every venue)
     − safetyMargin
```

with **no separate swap-leg gas term**. CoW's own settlement cost is already
inside `feeAmount`, and therefore already reflected in `buyAmount`. Adding
`gasAmount × gasPrice` as we do for Kyber would charge CoW twice for its gas and
make it look worse than it is by roughly the cost of a swap.

`gasAmount` is still recorded, for diagnosis, but it does not enter the edge.

## Schema

New tick columns, mirroring the existing venues:

```
cow_out        TEXT      -- buyAmount, in taker-asset units
cow_fee_amount TEXT      -- CoW's own fee, sell-token units (diagnostic)
cow_gas_units  TEXT      -- CoW's gas estimate (diagnostic, not in the edge)
cow_age_ms     INTEGER   -- quote age at tick time
cow_degraded   SMALLINT  -- stale quote, or quote for a size a partial fill moved past
cow_fee        TEXT      -- our markup, same basis as the other venues
edge_cow       TEXT
```

Plus `t_shadow_cow_ms`, `t_shadow_cow_edge`, `max_edge_cow` on `orders`, matching
the other venues. All additive with `IF NOT EXISTS`, so existing databases keep
working with the columns null.

## Code

| file | change |
| --- | --- |
| `src/cow/client.ts` | new — POST the quote, parse, surface rate limits |
| `src/cow/quoter.ts` | new — per-order quote loop, same shape as `KyberQuoter` |
| `src/db/schema.ts` | new columns + migrations |
| `src/db/db.ts` | `TickInsert` fields, insert statement, `setShadowCow`/`setMaxEdgeCow` |
| `src/report/classify.ts` | `'cow'` venue in `Venue` and `tickForVenue` |
| `src/pricing/engine.ts` | price the CoW leg in both tick paths |
| `src/report/outcome.ts` | `'cow'` in `VENUES`, columns in `OUTCOME_TICK_SQL` |
| `src/dash/collect.ts` | scoreboard card and live/decided chips |
| `src/collector/main.ts` | construct, start, stop, status line |
| `config.ts` | `cow` block: api base, fee bps, quote interval, degraded age |

Ethereum only for now. The chain profile gets a `cowChainSlug`; chains without
one simply never construct the quoter, exactly as PancakeSwap works today.

## Caveats to record in the report

1. **A CoW quote is indicative, not firm.** It is what solvers are expected to
   deliver, not a commitment — the same standing as Bebop's streamed depth, and
   weaker than KalqiX's order book, where we walk real resting size.
2. **CoW settles in batches.** A real fill waits for the next batch, so the
   speed comparison against a Fusion auction is not like-for-like even when the
   price comparison is.
3. **KalqiX does not quote Ethereum-native pairs.** Its column already carries
   the cross-chain caveat; nothing changes there.

## Budget

CoW needs no key, so it costs nothing against the 1inch allowance that has
already exhausted three keys. It does rate limit, so the quoter backs off for
10s on a 429 and gives up on a pair after five consecutive failures — long-tail
pairs CoW cannot route fail identically every time, and retrying them once a
second only fills the log. It polls on the same 2s interval as Kyber, per live
order.

## How it gets verified

1. `npm test` — unit tests for quote parsing and for the fee/gas rule above,
   since that is the part most likely to be silently wrong.
2. A dry run quoting real sizes against live CoW, checking the implied rate
   lands near the independently-measured ETH price.
3. Deploy, then confirm on the live dashboard that `cow_out` populates on
   Ethereum ticks and that a CoW column appears with a sane win/decided count.
4. Cross-check one decided order by hand: recompute its CoW edge from the stored
   components and confirm it matches `edge_cow`.
