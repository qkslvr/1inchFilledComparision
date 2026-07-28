# Shadow Resolver Report: Base (chain 8453)

## How to read this

Shadow wins ignore our own fill broadcast latency and any reaction from competing resolvers. A WIN means our all-in cost went below the KalqiX hedge proceeds strictly before the observed fill (or before expiry/cancel when nobody filled). Real capture rate will be lower than reported here; this measures pricing headroom, not guaranteed capture.

Fill timestamps prefer onchain block time (2s granularity on Base) and fall back to WebSocket event receipt time. Winning resolver attribution is not implemented in v1 (fill tx hashes are stored for a later pass). Costs use an unwhitelisted taker, so any whitelist fee discount a real resolver enjoys is not applied (conservative). Ticks inside another resolver's exclusivity window are excluded from t_shadow.

Generated 2026-07-14T06:03:41.168Z. Observed collection time: 31.5 hours across 11 run(s).

WARNING: runs in this database used differing configs; stored tick components are raw and comparable, but cached defaults may differ

## Headline

Capturable gross margin per day: 0 USDC

| Metric | Value |
| --- | --- |
| WIN count | 5 |
| WIN volume | 62.46 USD |
| Addressable volume | 401,157.63 USD |
| WIN volume share of addressable | 0.0% |

## Funnel

| Stage | Orders | Volume (USD) |
| --- | --- | --- |
| total Fusion orders seen | 52067 | 4,476,733.06 |
| addressable (supported pair) | 157 | 401,157.63 |
| priced (at least one tick) | 156 | 401,156.63 |
| profitable at some point | 9 | 2,713.81 |
| WIN | 5 | 62.46 |

## Win rate and margins

Overall win rate (of decided orders): 3.2%

| Pair | Decided orders | Wins | Win rate |
| --- | --- | --- | --- |
| ETH_USDC | 136 | 5 | 3.7% |
| cbBTC_USDC | 20 | 0 | 0.0% |

Win margin distribution: p10 0.00 bps, p50 0.27 bps, p90 0.72 bps

How early we beat the actual fill (t_actual minus t_shadow):

| Lead time | Wins |
| --- | --- |
| 0-1s | 0 |
| 1-3s | 0 |
| 3-10s | 0 |
| 10-30s | 0 |
| 30-60s | 0 |
| over 60s | 0 |

## Loss anatomy

| Class | Count |
| --- | --- |
| LOSE_SPEED | 2 |
| LOSE_PRICE | 145 |
| NO_DEPTH | 2 |
| UNFILLABLE | 0 |
| NO_TICKS | 1 |
| WIN_DEGRADED | 2 |

LOSE_PRICE median shortfall: 134.68 bps (how far the best-ever edge stayed below zero, in bps of notional; small values mean near misses, large values mean structural).

## Size analysis

| Notional bucket | Orders | Wins | Win rate | Median win margin |
| --- | --- | --- | --- | --- |
| under 1,000 USD | 150 | 5 | 3.3% | 0.27 bps |
| under 5,000 USD | 3 | 0 | 0.0% | n/a |
| under 25,000 USD | 1 | 0 | 0.0% | n/a |
| over 100,000 USD | 2 | 0 | 0.0% | n/a |

KalqiX depth ceiling over the run (top-of-book aggregate, USD):

| Pair | Median bid depth | Max bid depth | Median ask depth | Max ask depth | Snapshots |
| --- | --- | --- | --- | --- | --- |
| ETH_USDC | 5,334.27 | 10,901.67 | 4,641.17 | 7,359.8 | 2144 |
| cbBTC_USDC | 5,085.36 | 5,426.27 | 4,708.15 | 5,159.49 | 695 |

## Venue comparison (default params)

KalqiX hedges walk the order book and pay the account taker fee. Kyber hedges use the aggregator route quote for the exact remaining size, charge our assumed markup, and add the route's own swap gas on top of fill gas. Bebop hedges walk the market-maker depth stream (their sanctioned Price API), charge our markup, and add RFQ settlement gas. Kyber and Bebop prices are indicative (not firm executable quotes) and their coverage may start later than KalqiX ticks.

| Metric | KalqiX | Kyber | Bebop | Best of all |
| --- | --- | --- | --- | --- |
| WIN count | 5 | 2 | 2 | 5 |
| Capturable USDC/day | 0 | 0 | 0 | 0 |
| Median win margin | 0.27 bps | 0.46 bps | 0.25 bps | |
| LOSE_SPEED | 2 | 2 | 1 | |
| LOSE_PRICE | 145 | 125 | 17 | |
| Median LOSE_PRICE shortfall | 134.68 bps | 47.53 bps | 17.62 bps | |
| WIN_DEGRADED | 2 | 0 | 0 | |

Venue data coverage: 57.7% of pricing ticks carried a usable Kyber quote, 36.3% carried Bebop depth.

### Kyber-only expansion (orders with no KalqiX market)

Sizeable KalqiX-unsupported orders are also shadow-priced through Kyber alone, capacity permitting. Gas for these converts to taker-asset units via the quote's own USD valuation, so treat margins as approximate.

| Metric | Value |
| --- | --- |
| Orders tracked | 81 |
| WIN | 4 (plus 0 degraded) |
| Capturable USDC/day | 77.54 |
| Median win margin | 18.19 bps |
| LOSE_SPEED / LOSE_PRICE | 3 / 74 |
| Median LOSE_PRICE shortfall | 15.71 bps |
| Bebop WIN on these orders | 4 (55.3 USDC/day) |
| Bebop median shortfall | n/a |

## Sensitivity

KalqiX venue only. WIN count and capturable USDC per day, recomputed from stored ticks (no re-collection):

| Safety margin | Gas 0.5x | Gas 1x | Gas 2x |
| --- | --- | --- | --- |
| 0 bps | 7 wins / 0.01 | 7 wins / 0.01 | 3 wins / 0 |
| 5 bps | 7 wins / 0 | 5 wins / 0 | 2 wins / 0 |
| 10 bps | 3 wins / 0 | 5 wins / 0 | 2 wins / 0 |
| 20 bps | 4 wins / 0.01 | 4 wins / 0 | 2 wins / 0 |
| 40 bps | 5 wins / 0 | 4 wins / 0 | 2 wins / 0 |

## Data quality

| Metric | Value |
| --- | --- |
| WebSocket gaps | 19 (0.7 min total) |
| Poll fallback activations | 18 |
| Sampling gaps (over 2x interval) | 88 |
| Pricing ticks total | 3341 |
| Degraded ticks (stale/missing book) | 1.0% |
| WIN_DEGRADED (excluded from headline) | 2 |
| Orders with no ticks | 1 |
| Error-skipped orders | 0 |
| Late-seen orders (sweep/poll discovery) | 652 |
| 1inch 429 responses | 0 |
| KalqiX 429 responses | 0 |
| Clock skew per run (ms) | -144, -136, -574, -478, 205, -512, 316, 15, -370, -679, 121 |
| Unsupported orders without USD pricing | 35521 |

Runs: #1 2026-07-12T19:22:37.683Z to 2026-07-12T19:49:05.213Z; #2 2026-07-12T19:49:29.654Z to 2026-07-12T19:56:23.760Z; #3 2026-07-12T19:58:09.321Z to open (unclean); #4 2026-07-13T08:20:32.880Z to open (unclean); #5 2026-07-13T10:50:41.130Z to open (unclean); #6 2026-07-13T11:05:36.232Z to open (unclean); #7 2026-07-13T12:12:52.458Z to open (unclean); #8 2026-07-13T14:47:44.734Z to open (unclean); #9 2026-07-13T14:51:13.127Z to open (unclean); #10 2026-07-13T17:24:42.304Z to open (unclean); #11 2026-07-13T18:05:49.417Z to 2026-07-14T06:02:19.711Z
