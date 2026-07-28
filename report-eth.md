# Shadow Resolver Report: Ethereum (chain 1)

## How to read this

Shadow wins ignore our own fill broadcast latency and any reaction from competing resolvers. A WIN means our all-in cost went below the KalqiX hedge proceeds strictly before the observed fill (or before expiry/cancel when nobody filled). Real capture rate will be lower than reported here; this measures pricing headroom, not guaranteed capture.

Fill timestamps prefer onchain block time (2s granularity on Base) and fall back to WebSocket event receipt time. Winning resolver attribution is not implemented in v1 (fill tx hashes are stored for a later pass). Costs use an unwhitelisted taker, so any whitelist fee discount a real resolver enjoys is not applied (conservative). Ticks inside another resolver's exclusivity window are excluded from t_shadow.

Orders are on Ethereum but the hedge venue (KalqiX) settles on Base; cross-chain inventory and rebalancing costs are ignored. This measures pricing headroom only.

WBTC is hedged on the cbBTC order book. Unlike WETH and native ETH, WBTC and cbBTC are different custodial wrappers; the wrapper basis is ignored.

Generated 2026-07-14T06:03:41.993Z. Observed collection time: 18.1 hours across 8 run(s).

WARNING: runs in this database used differing configs; stored tick components are raw and comparable, but cached defaults may differ

## Headline

Capturable gross margin per day: 0.29 USDC

| Metric | Value |
| --- | --- |
| WIN count | 8 |
| WIN volume | 72.6 USD |
| Addressable volume | 1,851,381.97 USD |
| WIN volume share of addressable | 0.0% |

## Funnel

| Stage | Orders | Volume (USD) |
| --- | --- | --- |
| total Fusion orders seen | 807 | 11,610,812.34 |
| addressable (supported pair) | 58 | 1,851,381.97 |
| priced (at least one tick) | 58 | 1,851,381.97 |
| profitable at some point | 12 | 3,733.28 |
| WIN | 8 | 72.6 |

## Win rate and margins

Overall win rate (of decided orders): 13.8%

| Pair | Decided orders | Wins | Win rate |
| --- | --- | --- | --- |
| ETH_USDC | 53 | 7 | 13.2% |
| cbBTC_USDC | 5 | 1 | 20.0% |

Win margin distribution: p10 2.76 bps, p50 35.16 bps, p90 778.21 bps

How early we beat the actual fill (t_actual minus t_shadow):

| Lead time | Wins |
| --- | --- |
| 0-1s | 0 |
| 1-3s | 0 |
| 3-10s | 3 |
| 10-30s | 3 |
| 30-60s | 2 |
| over 60s | 0 |

## Loss anatomy

| Class | Count |
| --- | --- |
| LOSE_SPEED | 0 |
| LOSE_PRICE | 28 |
| NO_DEPTH | 18 |
| UNFILLABLE | 0 |
| NO_TICKS | 0 |
| WIN_DEGRADED | 4 |

LOSE_PRICE median shortfall: 33.81 bps (how far the best-ever edge stayed below zero, in bps of notional; small values mean near misses, large values mean structural).

## Size analysis

| Notional bucket | Orders | Wins | Win rate | Median win margin |
| --- | --- | --- | --- | --- |
| under 1,000 USD | 28 | 8 | 28.6% | 35.16 bps |
| under 5,000 USD | 11 | 0 | 0.0% | n/a |
| under 25,000 USD | 7 | 0 | 0.0% | n/a |
| under 100,000 USD | 7 | 0 | 0.0% | n/a |
| over 100,000 USD | 5 | 0 | 0.0% | n/a |

KalqiX depth ceiling over the run (top-of-book aggregate, USD):

| Pair | Median bid depth | Max bid depth | Median ask depth | Max ask depth | Snapshots |
| --- | --- | --- | --- | --- | --- |
| ETH_USDC | 5,292.07 | 10,283.34 | 4,503.9 | 7,624.78 | 2498 |
| cbBTC_USDC | 4,831.01 | 4,892.53 | 4,724.96 | 4,822.68 | 154 |

## Venue comparison (default params)

KalqiX hedges walk the order book and pay the account taker fee. Kyber hedges use the aggregator route quote for the exact remaining size, charge our assumed markup, and add the route's own swap gas on top of fill gas. Bebop hedges walk the market-maker depth stream (their sanctioned Price API), charge our markup, and add RFQ settlement gas. Kyber and Bebop prices are indicative (not firm executable quotes) and their coverage may start later than KalqiX ticks.

| Metric | KalqiX | Kyber | Bebop | Best of all |
| --- | --- | --- | --- | --- |
| WIN count | 8 | 5 | 5 | 13 |
| Capturable USDC/day | 0.29 | 6.55 | 47.87 | 49.85 |
| Median win margin | 35.16 bps | 0.46 bps | 0.31 bps | |
| LOSE_SPEED | 0 | 4 | 0 | |
| LOSE_PRICE | 28 | 44 | 32 | |
| Median LOSE_PRICE shortfall | 33.81 bps | 11.84 bps | 13.16 bps | |
| WIN_DEGRADED | 4 | 1 | 0 | |

Venue data coverage: 94.6% of pricing ticks carried a usable Kyber quote, 76.4% carried Bebop depth.

### Kyber-only expansion (orders with no KalqiX market)

Sizeable KalqiX-unsupported orders are also shadow-priced through Kyber alone, capacity permitting. Gas for these converts to taker-asset units via the quote's own USD valuation, so treat margins as approximate.

| Metric | Value |
| --- | --- |
| Orders tracked | 234 |
| WIN | 20 (plus 1 degraded) |
| Capturable USDC/day | 771.62 |
| Median win margin | 1.04 bps |
| LOSE_SPEED / LOSE_PRICE | 21 / 184 |
| Median LOSE_PRICE shortfall | 17.08 bps |
| Bebop WIN on these orders | 9 (77.08 USDC/day) |
| Bebop median shortfall | 22.81 bps |

## Sensitivity

KalqiX venue only. WIN count and capturable USDC per day, recomputed from stored ticks (no re-collection):

| Safety margin | Gas 0.5x | Gas 1x | Gas 2x |
| --- | --- | --- | --- |
| 0 bps | 13 wins / 1.47 | 11 wins / 0.82 | 2 wins / 0.15 |
| 5 bps | 11 wins / 0.92 | 9 wins / 0.4 | 0 wins / 0 |
| 10 bps | 10 wins / 0.66 | 8 wins / 0.29 | 0 wins / 0 |
| 20 bps | 9 wins / 0.57 | 7 wins / 0.22 | 0 wins / 0 |
| 40 bps | 9 wins / 0.53 | 7 wins / 0.2 | 1 wins / 0.01 |

## Data quality

| Metric | Value |
| --- | --- |
| WebSocket gaps | 37 (1.2 min total) |
| Poll fallback activations | 36 |
| Sampling gaps (over 2x interval) | 41 |
| Pricing ticks total | 3683 |
| Degraded ticks (stale/missing book) | 0.4% |
| WIN_DEGRADED (excluded from headline) | 4 |
| Orders with no ticks | 0 |
| Error-skipped orders | 1 |
| Late-seen orders (sweep/poll discovery) | 5 |
| 1inch 429 responses | 0 |
| KalqiX 429 responses | 0 |
| Clock skew per run (ms) | 49, -768, -100, -254, -50, 47, -274, -857 |
| Unsupported orders without USD pricing | 390 |

Runs: #1 2026-07-13T09:24:06.713Z to 2026-07-13T09:29:44.064Z; #2 2026-07-13T09:30:57.385Z to open (unclean); #3 2026-07-13T10:50:49.771Z to open (unclean); #4 2026-07-13T11:05:41.015Z to open (unclean); #5 2026-07-13T14:46:46.567Z to open (unclean); #6 2026-07-13T14:51:16.725Z to open (unclean); #7 2026-07-13T17:24:37.323Z to open (unclean); #8 2026-07-13T18:05:55.613Z to 2026-07-14T06:02:19.710Z
