# Shadow Resolver — consolidation and five venues

One dashboard, one chain, five venues, at the root URL. Written as discrete tasks
so each can be done, verified and abandoned independently.

Status: decisions taken (see bottom). **Two hard blockers found by research —
read Task 5 and Task 6 before starting.** Nothing implemented yet.

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

## Task 0 — Wipe and restart

Decision: delete the cicada dataset and collect fresh under the new rules, rather
than restating history. This removes the whole fee-backfill problem — no mixed
basis, no seam to explain.

- Drop `cicada_42161` and recreate from the schema. **`cowswap_solver_1` is kept**
  — that data was explicitly asked for.
- Back it up first anyway: a dump of `cicada_42161` is ~1 GB uncompressed and the
  box has 1.7 GB free, so dump compressed, or accept the loss deliberately.
- Do this **after** tasks 1, 2, 5 and 6 land, so the fresh data is collected under
  the final rules and never needs restating again.

## Task 1 — Fee 5 bps -> 2.5 bps

`config.ts`: `kalqixTakerFeeBps` and each venue's `feeBps` to `25n` in tenths, or
introduce `feeBps` at a finer unit. **Note:** the current field is whole bps as a
bigint, so 2.5 cannot be expressed. Needs `feeTenthBps: 25n` or a move to ppm.

Every score is net of this fee, so it changes surplus, edge and the win verdict.

- Touches: `config.ts`, `quoteVenues` in `src/cow/solver.ts`, `backfill-fees.ts`.
- Verify: `fee_usd` = 2.5 bps of settled size on new rows; win count moves up
  slightly, since a smaller fee means a better net price.
- No backfill: Task 0 discards the 5 bps history.

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

## Task 5 — Hashflow venue  **BLOCKED: needs an API key**

Every taker endpoint is key-gated, including indicative price levels. Without an
`Authorization` header Cloudflare returns 403 before the API is reached; with a
bad one, 401. Keys come from a manual vetting process (their intake form or
Discord) — there is no self-serve tier. **Someone has to request one before any
of this can be built or tested.**

Once a key exists, the shape mirrors Bebop's cheap-book/expensive-quote split:
- `GET /taker/v3/price-levels` — cumulative ladders per market maker, poll-safe
  at ~1/s. Human units, floating point, first level is the MM's minimum size.
- `POST /taker/v3/rfq` — the firm, signed, executable quote. Base-unit strings.
  Read `quoteData.quoteExpiry` for validity rather than assuming a TTL.
- Router on Arbitrum `0x55084eE0fEf03f14a305cd24286359A35D735151`, confirmed
  deployed. Budget ~200k gas units; v3 returns no gas estimate.
- Plain `https` with our explicit User-Agent, not the SDK — it pins axios 0.27
  and drags in ethers and solana/web3 for a wrapper that is ten lines.

**Fee handling — do not double count.** `quoteTokenAmount` is already net of the
market maker's spread *and* Hashflow's protocol fee; neither is broken out. Our
2.5 bps is expressed by sending `feesBps: 25` (tenths) so the MM widens the quote
and rebates us, **or** by subtracting locally — never both.

**Overlap with Kyber.** KyberSwap lists `hashflow-v3` among its DEX ids, so Kyber
may already be routing through Hashflow. Treating them as independent venues
would overstate depth on overlapping pairs. Check whether Kyber's route names
`hashflow-v3` before presenting a best-of-five as five independent sources.

## Task 6 — Hyperliquid venue  **it cannot fill on Arbitrum**

Research is unambiguous, and worse than the question assumed:

- HyperCore spot and perps live on Hyperliquid's own L1; balances are not
  reachable from an Arbitrum call frame. HyperEVM is chain 999, not Arbitrum.
- The Arbitrum bridge carries **USDC only**, validator-signed, 3–7 minutes each
  way, against an auction measured in seconds.
- **ETH and BTC do not bridge to Arbitrum at all** — HyperCore holds UETH/UBTC,
  Unit wrappers that redeem to Ethereum L1 and native Bitcoin.
- **There is no ARB spot market**, only a perp.
- Spot taker fee is 7 bps at tier 0 — roughly 20× the visible spread.

Decision taken: include it as a fifth fill venue anyway, as a counterfactual.
Implementing that means its quotes enter the same `max()` as venues that can
actually deliver, so a Hyperliquid win is a win we could not settle. **The
dashboard must say so on the venue card**, or the number is not defensible.

- `POST https://api.hyperliquid.xyz/info`, `{"type":"l2Book","coin":"@151"}`.
  No auth, weight 2 of 1200/min. Needs a POST helper — our http client is GET-only.
- Spot pairs are addressed by `@index`, not symbol: UETH/USDC is `@151`, UBTC
  `@142`, USDT0 `@166`. Passing `"ETH"` silently returns the **perp** book.
- 20 levels per side is a hard cap; books exhaust around $200–500k. A walk beyond
  visible depth must return no quote, not an extrapolation.
- Net 7 bps taker (≈1.4 bps on stable pairs).

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

## Decisions taken

- **Fee history** — delete the data and restart clean under 2.5 bps (Task 0).
- **Hyperliquid** — include as a fifth fill venue, as a counterfactual, despite
  it being unable to settle on Arbitrum. Label it as such on the venue card.
- **No-Kyber view** — delete entirely: matview, refresh cron, profile, script.
- **`/liquidity`** — stop routing it; leave the app process and its data running,
  so it is a one-line revert.

## Still open

- **A Hashflow API key.** Nothing in Task 5 can be built or tested without one,
  and it is a manual request, not a signup. This is the critical path.
- **Kyber/Hashflow overlap.** Whether to present them as independent venues.
