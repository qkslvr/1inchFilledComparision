import { config } from '../../config.js';
import type { ReportData } from './compute.js';

function usd(n: number | null): string {
  if (n === null) return 'n/a';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function pct(n: number | null): string {
  return n === null ? 'n/a' : `${n.toFixed(1)}%`;
}

function bps(n: number | null): string {
  return n === null ? 'n/a' : `${n.toFixed(2)} bps`;
}

export function renderMarkdown(r: ReportData): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(`# Shadow Resolver Report: ${config.chainLabel} (chain ${config.chainId})`);
  push();
  push('## How to read this');
  push();
  push(
    'Shadow wins ignore our own fill broadcast latency and any reaction from competing resolvers. ' +
      'A WIN means our all-in cost went below the KalqiX hedge proceeds strictly before the observed fill ' +
      '(or before expiry/cancel when nobody filled). Real capture rate will be lower than reported here; ' +
      'this measures pricing headroom, not guaranteed capture.'
  );
  push();
  push(
    'Fill timestamps prefer onchain block time (2s granularity on Base) and fall back to WebSocket event receipt time. ' +
      'Winning resolver attribution is not implemented in v1 (fill tx hashes are stored for a later pass). ' +
      'Costs use an unwhitelisted taker, so any whitelist fee discount a real resolver enjoys is not applied (conservative). ' +
      'Ticks inside another resolver\'s exclusivity window are excluded from t_shadow.'
  );
  push();
  for (const caveat of config.reportCaveats) {
    push(caveat);
    push();
  }
  push(`Generated ${r.generatedAt}. Observed collection time: ${r.observedActiveHours.toFixed(1)} hours across ${r.runs.length} run(s).`);
  if (r.configWarning) {
    push();
    push(`WARNING: ${r.configWarning}`);
  }
  push();

  push('## Headline');
  push();
  push(`Capturable gross margin per day: ${usd(r.headline.capturableGrossMarginUsdcPerDay)} USDC`);
  push();
  push(`| Metric | Value |`);
  push(`| --- | --- |`);
  push(`| WIN count | ${r.headline.winCount} |`);
  push(`| WIN volume | ${usd(r.headline.winVolumeUsd)} USD |`);
  push(`| Addressable volume | ${usd(r.headline.addressableVolumeUsd)} USD |`);
  push(`| WIN volume share of addressable | ${pct(r.headline.winVolumeSharePct)} |`);
  push();

  push('## Funnel');
  push();
  push(`| Stage | Orders | Volume (USD) |`);
  push(`| --- | --- | --- |`);
  for (const f of r.funnel) {
    push(`| ${f.stage} | ${f.count} | ${usd(f.volumeUsd)} |`);
  }
  push();

  push('## Win rate and margins');
  push();
  push(`Overall win rate (of decided orders): ${pct(r.winRate.overallPct)}`);
  push();
  push(`| Pair | Decided orders | Wins | Win rate |`);
  push(`| --- | --- | --- | --- |`);
  for (const [ticker, p] of Object.entries(r.winRate.perPair)) {
    push(`| ${ticker} | ${p.orders} | ${p.wins} | ${pct(p.winRatePct)} |`);
  }
  push();
  push(`Win margin distribution: p10 ${bps(r.winRate.marginBpsP10)}, p50 ${bps(r.winRate.marginBpsP50)}, p90 ${bps(r.winRate.marginBpsP90)}`);
  push();
  push('How early we beat the actual fill (t_actual minus t_shadow):');
  push();
  push(`| Lead time | Wins |`);
  push(`| --- | --- |`);
  for (const b of r.winRate.leadTimeHistogram) {
    push(`| ${b.bucket} | ${b.count} |`);
  }
  push();

  push('## Loss anatomy');
  push();
  push(`| Class | Count |`);
  push(`| --- | --- |`);
  for (const [cls, count] of Object.entries(r.losses.counts)) {
    push(`| ${cls} | ${count} |`);
  }
  push();
  push(
    `LOSE_PRICE median shortfall: ${bps(r.losses.losePriceMedianShortfallBps)} ` +
      `(how far the best-ever edge stayed below zero, in bps of notional; small values mean near misses, large values mean structural).`
  );
  push();

  push('## Size analysis');
  push();
  if (r.sizeBuckets.length === 0) {
    push('No decided orders with a priceable notional.');
  } else {
    push(`| Notional bucket | Orders | Wins | Win rate | Median win margin |`);
    push(`| --- | --- | --- | --- | --- |`);
    for (const b of r.sizeBuckets) {
      push(`| ${b.bucket} | ${b.orders} | ${b.wins} | ${pct(b.winRatePct)} | ${bps(b.medianMarginBps)} |`);
    }
  }
  push();
  push('KalqiX depth ceiling over the run (top-of-book aggregate, USD):');
  push();
  push(`| Pair | Median bid depth | Max bid depth | Median ask depth | Max ask depth | Snapshots |`);
  push(`| --- | --- | --- | --- | --- | --- |`);
  for (const [ticker, d] of Object.entries(r.depthCeiling)) {
    push(
      `| ${ticker} | ${usd(d.p50BidDepthUsd)} | ${usd(d.maxBidDepthUsd)} | ${usd(d.p50AskDepthUsd)} | ${usd(d.maxAskDepthUsd)} | ${d.snapshots} |`
    );
  }
  push();

  push('## Venue comparison (default params)');
  push();
  push(
    'KalqiX hedges walk the order book and pay the account taker fee. Kyber hedges use the aggregator route quote ' +
      'for the exact remaining size, charge our assumed markup, and add the route\'s own swap gas on top of fill gas. ' +
      'Bebop hedges walk the market-maker depth stream (their sanctioned Price API), charge our markup, and add RFQ ' +
      'settlement gas. Kyber and Bebop prices are indicative (not firm executable quotes) and their coverage may ' +
      'start later than KalqiX ticks.'
  );
  push();
  push(`| Metric | KalqiX | Kyber | Bebop | Best of all |`);
  push(`| --- | --- | --- | --- | --- |`);
  const vc = r.venueComparison;
  push(`| WIN count | ${vc.kalqix.winCount} | ${vc.kyber.winCount} | ${vc.bebop.winCount} | ${vc.bestOf.winCount} |`);
  push(`| Capturable USDC/day | ${usd(vc.kalqix.capturableUsdcPerDay)} | ${usd(vc.kyber.capturableUsdcPerDay)} | ${usd(vc.bebop.capturableUsdcPerDay)} | ${usd(vc.bestOf.capturableUsdcPerDay)} |`);
  push(`| Median win margin | ${bps(vc.kalqix.marginBpsP50)} | ${bps(vc.kyber.marginBpsP50)} | ${bps(vc.bebop.marginBpsP50)} | |`);
  push(`| LOSE_SPEED | ${vc.kalqix.loseSpeedCount} | ${vc.kyber.loseSpeedCount} | ${vc.bebop.loseSpeedCount} | |`);
  push(`| LOSE_PRICE | ${vc.kalqix.losePriceCount} | ${vc.kyber.losePriceCount} | ${vc.bebop.losePriceCount} | |`);
  push(`| Median LOSE_PRICE shortfall | ${bps(vc.kalqix.medianShortfallBps)} | ${bps(vc.kyber.medianShortfallBps)} | ${bps(vc.bebop.medianShortfallBps)} | |`);
  push(`| WIN_DEGRADED | ${vc.kalqix.winDegradedCount} | ${vc.kyber.winDegradedCount} | ${vc.bebop.winDegradedCount} | |`);
  push();
  push(
    `Venue data coverage: ${pct(vc.kyberTickCoveragePct)} of pricing ticks carried a usable Kyber quote, ` +
      `${pct(vc.bebopTickCoveragePct)} carried Bebop depth.`
  );
  push();
  push('### Kyber-only expansion (orders with no KalqiX market)');
  push();
  push(
    'Sizeable KalqiX-unsupported orders are also shadow-priced through Kyber alone, capacity permitting. ' +
      'Gas for these converts to taker-asset units via the quote\'s own USD valuation, so treat margins as approximate.'
  );
  push();
  const ko = r.kyberOnly;
  push(`| Metric | Value |`);
  push(`| --- | --- |`);
  push(`| Orders tracked | ${ko.orders} |`);
  push(`| WIN | ${ko.winCount} (plus ${ko.winDegradedCount} degraded) |`);
  push(`| Capturable USDC/day | ${usd(ko.capturableUsdcPerDay)} |`);
  push(`| Median win margin | ${bps(ko.marginBpsP50)} |`);
  push(`| LOSE_SPEED / LOSE_PRICE | ${ko.loseSpeedCount} / ${ko.losePriceCount} |`);
  push(`| Median LOSE_PRICE shortfall | ${bps(ko.medianShortfallBps)} |`);
  push(`| Bebop WIN on these orders | ${ko.bebop.winCount} (${usd(ko.bebop.capturableUsdcPerDay)} USDC/day) |`);
  push(`| Bebop median shortfall | ${bps(ko.bebop.medianShortfallBps)} |`);
  push();

  push('## Sensitivity');
  push();
  push('KalqiX venue only. WIN count and capturable USDC per day, recomputed from stored ticks (no re-collection):');
  push();
  push(`| Safety margin | Gas 0.5x | Gas 1x | Gas 2x |`);
  push(`| --- | --- | --- | --- |`);
  const bySafety = new Map<number, Map<number, { winCount: number; capturableUsdcPerDay: number }>>();
  for (const cell of r.sensitivity) {
    if (!bySafety.has(cell.safetyMarginBps)) bySafety.set(cell.safetyMarginBps, new Map());
    bySafety.get(cell.safetyMarginBps)!.set(cell.gasMult, cell);
  }
  for (const [safety, row] of [...bySafety.entries()].sort((a, b) => a[0] - b[0])) {
    const cells = [0.5, 1, 2].map((g) => {
      const c = row.get(g);
      return c ? `${c.winCount} wins / ${usd(c.capturableUsdcPerDay)}` : 'n/a';
    });
    push(`| ${safety} bps | ${cells[0]} | ${cells[1]} | ${cells[2]} |`);
  }
  push();

  push('## Data quality');
  push();
  push(`| Metric | Value |`);
  push(`| --- | --- |`);
  const dq = r.dataQuality;
  push(`| WebSocket gaps | ${dq.wsGapCount} (${dq.wsDowntimeMinutes.toFixed(1)} min total) |`);
  push(`| Poll fallback activations | ${dq.pollFallbackCount} |`);
  push(`| Sampling gaps (over 2x interval) | ${dq.sampleGapCount} |`);
  push(`| Pricing ticks total | ${dq.totalTicks} |`);
  push(`| Degraded ticks (stale/missing book) | ${pct(dq.degradedTickPct)} |`);
  push(`| WIN_DEGRADED (excluded from headline) | ${dq.winDegradedCount} |`);
  push(`| Orders with no ticks | ${dq.noTicksCount} |`);
  push(`| Error-skipped orders | ${dq.errorSkips} |`);
  push(`| Late-seen orders (sweep/poll discovery) | ${dq.lateSeenOrders} |`);
  push(`| 1inch 429 responses | ${dq.rest429Count} |`);
  push(`| KalqiX 429 responses | ${dq.kalqix429Count} |`);
  push(`| Clock skew per run (ms) | ${dq.clockSkewsMs.join(', ') || 'n/a'} |`);
  push(`| Unsupported orders without USD pricing | ${dq.unpricedUnsupportedCount} |`);
  push();
  push(`Runs: ${r.runs.map((run) => `#${run.id} ${run.startedAt} to ${run.endedAt ?? 'open'}${run.clean ? '' : ' (unclean)'}`).join('; ')}`);
  push();

  const md = lines.join('\n');
  if (/[–—]/.test(md)) {
    throw new Error('report.md contains an em or en dash; refusing to write');
  }
  return md;
}
