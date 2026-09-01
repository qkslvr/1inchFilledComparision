# Shadow Resolver — consolidation and five venues

One dashboard, one chain, five venues, at the root URL. Written as discrete tasks
so each can be done, verified and abandoned independently.

Status: **awaiting decisions on Q1–Q4 below.** Nothing here is implemented yet.

---

## Where we are

- Three dashboard tabs: `cowswapSolver` (Ethereum, stopped 27 Aug), `cicada`
  (Arbitrum, live), `cicadaNoKyber` (a derived view).
- Three venues: KalqiX, Kyber, Bebop. Our fee is 5 bps on all of them.
- Served by a Node reverse proxy at `~/workspace/liqDashboard/router.mjs`, which
  puts a landing page at `/` and our dashboard under `/shadow`.

## Where we are going

- One dataset, labelled **Shadow Resolver**, Arbitrum only.
- Five venues: KalqiX, Kyber (+10 bps slippage), Bebop, Hyperliquid, Hashflow.
- Our fee 2.5 bps.
- Served alone at the root URL.

---

## Task 1 — Fee 5 bps -> 2.5 bps

`config.ts`: `kalqixTakerFeeBps` and each venue's `feeBps` to `25n` in tenths, or
introduce `feeBps` at a finer unit. **Note:** the current field is whole bps as a
bigint, so 2.5 cannot be expressed. Needs `feeTenthBps: 25n` or a move to ppm.

Every score is net of this fee, so it changes surplus, edge and the win verdict.

- Touches: `config.ts`, `quoteVenues` in `src/cow/solver.ts`, `backfill-fees.ts`.
- Verify: `fee_usd` = 2.5 bps of settled size on new rows; win count moves up
  slightly, since a smaller fee means a better net price.
- **Open: Q1.**

## Task 2 — Kyber slippage haircut

Kyber returns an aggregator route quote, which is indicative: the executed
amount can be worse. Subtract a configurable haircut from its output before
netting, so the comparison against a real solver is not flattered.

- Add `slippageBps: 10n` to the Kyber venue config; apply in `quoteVenues`
  alongside gas and fee.
- Distinct from `safetyMarginBps` (currently 0), which is global. This is
  per-venue and models venue behaviour, not risk appetite.
- Verify: Kyber's `edge_kyber` in `ticks` drops ~10 bps; Kyber's win share falls.
- Also apply the same mechanism to the new venues where their quotes are
  indicative rather than firm.

## Task 3 — Collapse to one dashboard

- `allChains` keeps `cicada` only; relabel to `Shadow Resolver`.
- Remove the `cicadaNoKyber` profile, its materialised view, its refresh cron.
- Remove the tab bar when only one dataset exists.
- **Data for `cowswap_solver_1` and the no-Kyber schema is kept on disk** — only
  the routes and tabs go. Reversible by re-adding a key to `allChains`.
- **Open: Q3.**

## Task 4 — Root URL

`router.mjs`: `/` proxies to the shadow app instead of serving `landing.html`;
drop the `/liquidity` route and the `/cicada` special case. Keep `/shadow` as an
alias so existing links do not break.

- The liquidity app's process and data are left alone — only its route goes.
- This file belongs to `liqDashboard`, not this repo.
- **Open: Q4.**

## Task 5 — Hashflow venue

Pending the research agent. Expected shape, following `src/bebop/`:
- a client that requests a quote for (sellToken, buyToken, amount) on 42161,
- returning `VenueQuote` with `out` net of the maker's spread and our fee,
- gas netted off like every other venue,
- rate limiting via the same `RequestBudget` pattern as Kyber if a key is needed.

Risk: may require an API key we do not have. Flagged for the agent.

## Task 6 — Hyperliquid venue

Pending the research agent. The honest question the agent is answering first is
whether Hyperliquid can *fill* an Arbitrum order at all, or only *hedge* one —
a CoW solver must deliver tokens on Arbitrum within the auction. If it is a
hedging venue rather than a fill venue, it does not belong in the same
best-of-five comparison and should be presented separately.

- Spot book walked for a size-aware price, like KalqiX.
- Net of Hyperliquid's taker fee.
- **Open: Q2.**

## Task 7 — Correctness audit

A `general-purpose` agent is auditing the live data flow now: score recomputation
from stored inputs, fee against settled size, sign agreement between
`score_margin_bps` and `edge_usd`, buy-order handling, and `quote_holds`
slippage. Findings will be folded in as their own tasks.

## Task 8 — Post-change verification

Re-audit end to end on live data once 1–6 land: one order traced from arrival
through bid, ladder, verdict, surplus and fee, reconciled against CoW's API —
the same check that found the reconstruction bug.

---

## Decisions needed

**Q1 — Fee basis for history.** 2.5 bps going forward leaves the dashboard mixing
two fee regimes, so totals are not comparable across the change. Restate every
historical row to 2.5 bps for one consistent basis, or keep history at 5 bps and
accept the seam?

**Q2 — Hyperliquid's role.** If it turns out it cannot settle on Arbitrum inside
an auction, do you want it as a fifth *fill* venue anyway (a counterfactual: what
if we could source there), or shown separately as a hedging reference?

**Q3 — The no-Kyber view.** Delete it, or keep the schema and refresh cron so it
can be brought back as a tab later? It costs a 0.9s refresh every 5 minutes.

**Q4 — Removing `/liquidity`.** Confirm the AVAIL Liquidity Manager should stop
being reachable. I would stop routing it but leave the app and its data running,
so it is a one-line revert.
