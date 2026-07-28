import type { Db } from '../db/db.js';
import { config } from '../../config.js';
import {
  classify,
  tickForVenue,
  type ClassifyParams,
  type ClassifyResult,
  type OrderClass,
  type OrderData,
  type TickData,
} from './classify.js';
import { toFloat, pow10 } from '../pricing/units.js';

export interface SensitivityCell {
  safetyMarginBps: number;
  gasMult: number;
  winCount: number;
  winDegradedCount: number;
  capturableUsdcPerDay: number;
}

export interface OrderOutcome {
  orderHash: string;
  pair: string | null;
  cls: OrderClass;
  result: ClassifyResult;
  kyberResult: ClassifyResult | null;
  bebopResult: ClassifyResult | null;
  kyberOnly: boolean;
  volumeUsd: number | null;
  notionalUsd: number | null;
  terminalStatus: string | null;
  lateSeen: boolean;
}

export interface VenueSummary {
  winCount: number;
  winDegradedCount: number;
  loseSpeedCount: number;
  losePriceCount: number;
  capturableUsdcPerDay: number;
  marginBpsP50: number | null;
  medianShortfallBps: number | null;
}

export interface ReportData {
  generatedAt: string;
  observedActiveHours: number;
  runs: Array<{ id: number; startedAt: string; endedAt: string | null; clean: boolean; skewMs: number | null }>;
  configWarning: string | null;
  headline: {
    capturableGrossMarginUsdcPerDay: number;
    winCount: number;
    winVolumeUsd: number;
    addressableVolumeUsd: number;
    winVolumeSharePct: number | null;
  };
  funnel: Array<{ stage: string; count: number; volumeUsd: number }>;
  winRate: {
    overallPct: number | null;
    perPair: Record<string, { orders: number; wins: number; winRatePct: number | null }>;
    marginBpsP10: number | null;
    marginBpsP50: number | null;
    marginBpsP90: number | null;
    leadTimeHistogram: Array<{ bucket: string; count: number }>;
  };
  losses: {
    counts: Record<string, number>;
    losePriceMedianShortfallBps: number | null;
  };
  sizeBuckets: Array<{
    bucket: string;
    orders: number;
    wins: number;
    winRatePct: number | null;
    medianMarginBps: number | null;
  }>;
  depthCeiling: Record<
    string,
    { maxBidDepthUsd: number; p50BidDepthUsd: number; maxAskDepthUsd: number; p50AskDepthUsd: number; snapshots: number }
  >;
  venueComparison: {
    kalqix: VenueSummary;
    kyber: VenueSummary;
    bebop: VenueSummary;
    bestOf: { winCount: number; capturableUsdcPerDay: number };
    /** share of ticks that carried usable venue data (coverage started later) */
    kyberTickCoveragePct: number | null;
    bebopTickCoveragePct: number | null;
  };
  /** KalqiX-unsupported orders shadow-priced via Kyber (and Bebop when the pair streams) */
  kyberOnly: VenueSummary & { orders: number; bebop: VenueSummary };
  sensitivity: SensitivityCell[];
  dataQuality: {
    wsGapCount: number;
    wsDowntimeMinutes: number;
    pollFallbackCount: number;
    sampleGapCount: number;
    degradedTickPct: number | null;
    totalTicks: number;
    errorSkips: number;
    lateSeenOrders: number;
    rest429Count: number;
    kalqix429Count: number;
    clockSkewsMs: number[];
    unpricedUnsupportedCount: number;
    winDegradedCount: number;
    noTicksCount: number;
  };
  outcomes: OrderOutcome[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function median(values: number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 50);
}

const LEAD_BUCKETS: Array<{ label: string; maxMs: number }> = [
  { label: '0-1s', maxMs: 1000 },
  { label: '1-3s', maxMs: 3000 },
  { label: '3-10s', maxMs: 10_000 },
  { label: '10-30s', maxMs: 30_000 },
  { label: '30-60s', maxMs: 60_000 },
  { label: 'over 60s', maxMs: Infinity },
];

interface RefPriceSeries {
  ts: number[];
  mid: bigint[];
}

/** Nearest stored mid for a ticker at a timestamp (binary search). */
function nearestMid(series: RefPriceSeries | undefined, tsMs: number): bigint | null {
  if (!series || series.ts.length === 0) return null;
  let lo = 0;
  let hi = series.ts.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (series.ts[m]! < tsMs) lo = m + 1;
    else hi = m;
  }
  const cand = [lo, lo - 1].filter((i) => i >= 0 && i < series.ts.length);
  let best = cand[0]!;
  for (const i of cand) {
    if (Math.abs(series.ts[i]! - tsMs) < Math.abs(series.ts[best]! - tsMs)) best = i;
  }
  return series.mid[best]!;
}

/** Orders per round trip when loading ticks. Bounds both the number of queries
 *  and how many ticks are resident at once. */
const TICK_CHUNK = 400;

export async function computeReport(db: Db): Promise<ReportData> {
  // --- runs / observed span ---
  const runRows = (await db.all(
    `SELECT id, started_at_ms, ended_at_ms, clean_shutdown, clock_skew_ms, config_json FROM runs ORDER BY id`
  )) as Array<{
    id: number;
    started_at_ms: number;
    ended_at_ms: number | null;
    clean_shutdown: number;
    clock_skew_ms: number | null;
    config_json: string;
  }>;

  // Observed time = sum of per-run spans. A run with no ended_at_ms was killed
  // uncleanly (network blip / hard kill); end it at its OWN last recorded
  // activity, bounded by the next run's start, NOT the global last tick (which
  // would credit an abandoned early run all the way to the end of collection).
  const LAST_ACTIVITY_SQL = `SELECT MAX(t) AS ts FROM (
       SELECT MAX(ts_ms) t FROM ticks WHERE ts_ms >= ? AND ts_ms < ?
       UNION ALL SELECT MAX(received_at_ms) FROM orders WHERE received_at_ms >= ? AND received_at_ms < ?
       UNION ALL SELECT MAX(ts_ms) FROM events WHERE ts_ms >= ? AND ts_ms < ?
     ) AS activity`;
  let activeMs = 0;
  for (let i = 0; i < runRows.length; i++) {
    const r = runRows[i]!;
    const cap = runRows[i + 1]?.started_at_ms ?? Date.now();
    let end = r.ended_at_ms;
    if (end === null) {
      const row = await db.get<{ ts: number | null }>(LAST_ACTIVITY_SQL, [
        r.started_at_ms, cap, r.started_at_ms, cap, r.started_at_ms, cap,
      ]);
      end = row?.ts ?? r.started_at_ms;
    }
    activeMs += Math.max(0, end - r.started_at_ms);
  }
  const configWarning =
    new Set(runRows.map((r) => r.config_json)).size > 1
      ? 'runs in this database used differing configs; stored tick components are raw and comparable, but cached defaults may differ'
      : null;

  // --- ref prices for USD conversion ---
  const refSeries = new Map<string, RefPriceSeries>();
  for (const pair of config.pairs) {
    const rows = (await db.all(`SELECT ts_ms, mid FROM ref_prices WHERE ticker = ? ORDER BY ts_ms`, [
      pair.ticker,
    ])) as Array<{ ts_ms: number; mid: string }>;
    refSeries.set(pair.ticker, { ts: rows.map((r) => r.ts_ms), mid: rows.map((r) => BigInt(r.mid)) });
  }

  /** Full-size maker-leg USD value of an order (float, display/bucketing).
   *  Priced only for tokens on a configured pair (quote = identity USDC,
   *  base = nearest ref mid for that pair); anything else is unpriced. */
  function orderVolumeUsd(makerAsset: string, makingAmount: bigint, tsMs: number): number | null {
    const a = makerAsset.toLowerCase();
    for (const pair of config.pairs) {
      if (pair.quote.addresses.includes(a)) return toFloat(makingAmount, pair.quote.decimals);
      if (pair.base.addresses.includes(a)) {
        const m = nearestMid(refSeries.get(pair.ticker), tsMs);
        return m === null ? null : toFloat(makingAmount, pair.base.decimals) * toFloat(m, pair.quote.decimals);
      }
    }
    return null;
  }

  // --- orders + ticks -> classification under default and sensitivity params ---
  const orderRows = (await db.all(`SELECT * FROM orders ORDER BY received_at_ms`)) as Record<string, any>[];
  // One query per TICK_CHUNK orders rather than per order: against a remote
  // database the per-order form spent all its time in round trips.
  const TICKS_SQL = `SELECT order_hash, ts_ms, degraded, exclusive, insufficient_depth, hedge_proceeds, auction_cost,
            gas_cost_raw, fee_cost, notional_taker, notional_usdc,
            kyber_out, kyber_degraded, kyber_gas_cost, kyber_fee,
            bebop_out, bebop_degraded, bebop_gas_cost, bebop_fee
     FROM ticks WHERE order_hash = ANY(?) ORDER BY order_hash, ts_ms`;

  const defaultParams: ClassifyParams = {
    safetyMarginBps: config.safetyMarginBps,
    gasMultNum: 1n,
    gasMultDen: 1n,
  };
  const sensParams: Array<{ cell: SensitivityCell; params: ClassifyParams }> = [];
  for (const s of config.sensitivity.safetyMarginBps) {
    for (const g of config.sensitivity.gasMult) {
      const [num, den] = g === 0.5 ? [1n, 2n] : g === 2 ? [2n, 1n] : [BigInt(Math.round(g)), 1n];
      sensParams.push({
        cell: { safetyMarginBps: Number(s), gasMult: g, winCount: 0, winDegradedCount: 0, capturableUsdcPerDay: 0 },
        params: { safetyMarginBps: s, gasMultNum: num, gasMultDen: den },
      });
    }
  }

  const outcomes: OrderOutcome[] = [];
  const sensUsdcTotals = new Map<number, number>();
  let degradedTicks = 0;
  let totalTicks = 0;
  let kyberCoveredTicks = 0;
  let bebopCoveredTicks = 0;

  // Ticks are loaded a chunk of orders ahead of the cursor and dropped as it
  // moves on, so only one chunk is resident at a time.
  const ticksByHash = new Map<string, Record<string, any>[]>();
  let prefetchedThrough = 0;
  const prefetchTicks = async (from: number): Promise<void> => {
    if (from < prefetchedThrough) return;
    ticksByHash.clear();
    const chunk = orderRows.slice(from, from + TICK_CHUNK);
    const wanted = chunk.filter((r) => r.eligible === 1 || r.kyber_only === 1).map((r) => r.order_hash);
    if (wanted.length > 0) {
      for (const t of await db.all(TICKS_SQL, [wanted])) {
        const list = ticksByHash.get(t.order_hash);
        if (list) list.push(t);
        else ticksByHash.set(t.order_hash, [t]);
      }
    }
    prefetchedThrough = from + TICK_CHUNK;
  };

  for (let orderIdx = 0; orderIdx < orderRows.length; orderIdx++) {
    const row = orderRows[orderIdx]!;
    await prefetchTicks(orderIdx);
    const order: OrderData = {
      orderHash: row.order_hash,
      eligible: row.eligible === 1,
      skipReason: row.skip_reason,
      terminalStatus: row.terminal_status,
      tActualMs: row.t_actual_chain_ms ?? row.t_actual_ws_ms ?? null,
      terminalAtMs: row.terminal_at_ms,
      lateSeen: row.late_seen === 1,
    };
    const kyberOnly = row.kyber_only === 1;
    let ticks: TickData[] = [];
    let kyberTicks: TickData[] = [];
    let bebopTicks: TickData[] = [];
    if (order.eligible || kyberOnly) {
      const raw = ticksByHash.get(row.order_hash) ?? [];
      ticks = raw.map((t) => tickForVenue(t, 'kalqix'));
      kyberTicks = raw.map((t) => tickForVenue(t, 'kyber'));
      bebopTicks = raw.map((t) => tickForVenue(t, 'bebop'));
      if (order.eligible) {
        totalTicks += ticks.length;
        degradedTicks += ticks.filter((t) => t.degraded).length;
        kyberCoveredTicks += kyberTicks.filter((t) => t.hedgeProceeds !== null).length;
        bebopCoveredTicks += bebopTicks.filter((t) => t.hedgeProceeds !== null).length;
      }
    }

    const result = classify(order, ticks, defaultParams);
    // kyber-only orders are SKIPPED for KalqiX but get a real Kyber verdict
    const kyberResult =
      order.eligible || kyberOnly
        ? classify({ ...order, eligible: true, skipReason: null }, kyberTicks, defaultParams)
        : null;
    const bebopResult =
      order.eligible || kyberOnly
        ? classify({ ...order, eligible: true, skipReason: null }, bebopTicks, defaultParams)
        : null;
    const volumeUsd = orderVolumeUsd(row.maker_asset, BigInt(row.making_amount), row.received_at_ms);
    const firstNotional = ticks.find((t) => t.notionalUsdc !== null)?.notionalUsdc ?? null;
    outcomes.push({
      orderHash: row.order_hash,
      pair: row.pair,
      cls: result.cls,
      result,
      kyberResult,
      bebopResult,
      kyberOnly,
      volumeUsd,
      notionalUsd: firstNotional !== null ? toFloat(firstNotional, 6) : volumeUsd,
      terminalStatus: row.terminal_status,
      lateSeen: order.lateSeen,
    });

    // sensitivity grid over the same in-memory ticks
    if (order.eligible) {
      for (let i = 0; i < sensParams.length; i++) {
        const { cell, params } = sensParams[i]!;
        const r = classify(order, ticks, params);
        if (r.cls === 'WIN') {
          cell.winCount++;
          if (r.edgeUsdc !== null) {
            sensUsdcTotals.set(i, (sensUsdcTotals.get(i) ?? 0) + toFloat(r.edgeUsdc, 6));
          }
        } else if (r.cls === 'WIN_DEGRADED') {
          cell.winDegradedCount++;
        }
      }
    }
  }

  const activeDays = activeMs / 86_400_000;
  for (let i = 0; i < sensParams.length; i++) {
    const { cell } = sensParams[i]!;
    cell.capturableUsdcPerDay = activeDays > 0 ? (sensUsdcTotals.get(i) ?? 0) / activeDays : 0;
  }

  // --- aggregates under default params ---
  const wins = outcomes.filter((o) => o.cls === 'WIN');
  const winUsdcTotal = wins.reduce((s, o) => s + (o.result.edgeUsdc !== null ? toFloat(o.result.edgeUsdc, 6) : 0), 0);
  const addressable = outcomes.filter((o) => !o.cls.startsWith('SKIPPED'));
  const decided = outcomes.filter((o) =>
    ['WIN', 'WIN_DEGRADED', 'LOSE_SPEED', 'LOSE_PRICE', 'NO_DEPTH'].includes(o.cls)
  );

  const sumVol = (list: OrderOutcome[]) => list.reduce((s, o) => s + (o.volumeUsd ?? 0), 0);
  const addressableVolumeUsd = sumVol(addressable);
  const winVolumeUsd = sumVol(wins);

  const priced = addressable.filter((o) => !['NO_TICKS', 'UNFILLABLE'].includes(o.cls));
  const everProfitable = priced.filter(
    (o) => o.cls === 'WIN' || o.cls === 'WIN_DEGRADED' || o.cls === 'LOSE_SPEED' || (o.result.maxEdge !== null && o.result.maxEdge > 0n)
  );

  const funnel = [
    { stage: 'total Fusion orders seen', count: outcomes.length, volumeUsd: sumVol(outcomes) },
    { stage: 'addressable (supported pair)', count: addressable.length, volumeUsd: addressableVolumeUsd },
    { stage: 'priced (at least one tick)', count: priced.length, volumeUsd: sumVol(priced) },
    { stage: 'profitable at some point', count: everProfitable.length, volumeUsd: sumVol(everProfitable) },
    { stage: 'WIN', count: wins.length, volumeUsd: winVolumeUsd },
  ];

  const perPair: Record<string, { orders: number; wins: number; winRatePct: number | null }> = {};
  for (const pair of config.pairs) {
    const pairDecided = decided.filter((o) => o.pair === pair.ticker);
    const pairWins = pairDecided.filter((o) => o.cls === 'WIN');
    perPair[pair.ticker] = {
      orders: pairDecided.length,
      wins: pairWins.length,
      winRatePct: pairDecided.length > 0 ? (100 * pairWins.length) / pairDecided.length : null,
    };
  }

  const marginList = wins.map((o) => o.result.marginBps!).sort((a, b) => a - b);
  const leadHist = LEAD_BUCKETS.map((b) => ({ bucket: b.label, count: 0 }));
  for (const w of wins) {
    const lead = w.result.leadTimeMs;
    if (lead === null) continue;
    const idx = LEAD_BUCKETS.findIndex((b) => lead < b.maxMs);
    leadHist[idx === -1 ? LEAD_BUCKETS.length - 1 : idx]!.count++;
  }

  const lossCounts: Record<string, number> = {};
  for (const cls of ['LOSE_SPEED', 'LOSE_PRICE', 'NO_DEPTH', 'UNFILLABLE', 'NO_TICKS', 'WIN_DEGRADED']) {
    lossCounts[cls] = outcomes.filter((o) => o.cls === cls).length;
  }
  const losePriceShortfalls = outcomes
    .filter((o) => o.cls === 'LOSE_PRICE' && o.result.shortfallBps !== null)
    .map((o) => o.result.shortfallBps!);

  // size buckets by USD notional
  const bucketEdges = config.notionalBucketsUsd;
  const bucketLabel = (usd: number): string => {
    for (const edge of bucketEdges) {
      if (usd < edge) return `under ${edge.toLocaleString('en-US')} USD`;
    }
    return `over ${bucketEdges[bucketEdges.length - 1]!.toLocaleString('en-US')} USD`;
  };
  const buckets = new Map<string, OrderOutcome[]>();
  for (const o of decided) {
    if (o.notionalUsd === null) continue;
    const label = bucketLabel(o.notionalUsd);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label)!.push(o);
  }
  const orderedLabels = [...bucketEdges.map((e) => `under ${e.toLocaleString('en-US')} USD`), `over ${bucketEdges[bucketEdges.length - 1]!.toLocaleString('en-US')} USD`];
  const sizeBuckets = orderedLabels
    .filter((l) => buckets.has(l))
    .map((label) => {
      const list = buckets.get(label)!;
      const bWins = list.filter((o) => o.cls === 'WIN');
      return {
        bucket: label,
        orders: list.length,
        wins: bWins.length,
        winRatePct: list.length > 0 ? (100 * bWins.length) / list.length : null,
        medianMarginBps: median(bWins.map((o) => o.result.marginBps!)),
      };
    });

  // depth ceiling per pair from snapshot derived columns
  const depthCeiling: ReportData['depthCeiling'] = {};
  for (const pair of config.pairs) {
    const rows = (await db.all(
      `SELECT mid, bid_depth_base, ask_depth_base FROM snapshots WHERE ticker = ? AND mid IS NOT NULL`,
      [pair.ticker]
    )) as Array<{ mid: string; bid_depth_base: string; ask_depth_base: string }>;
    if (rows.length === 0) continue;
    const bidUsd: number[] = [];
    const askUsd: number[] = [];
    for (const r of rows) {
      const mid = BigInt(r.mid);
      const denom = pow10(pair.base.decimals);
      bidUsd.push(toFloat((BigInt(r.bid_depth_base) * mid) / denom, 6));
      askUsd.push(toFloat((BigInt(r.ask_depth_base) * mid) / denom, 6));
    }
    bidUsd.sort((a, b) => a - b);
    askUsd.sort((a, b) => a - b);
    depthCeiling[pair.ticker] = {
      maxBidDepthUsd: bidUsd[bidUsd.length - 1]!,
      p50BidDepthUsd: percentile(bidUsd, 50)!,
      maxAskDepthUsd: askUsd[askUsd.length - 1]!,
      p50AskDepthUsd: percentile(askUsd, 50)!,
      snapshots: rows.length,
    };
  }

  // --- venue comparison (default params) ---
  const venueSummary = (results: ClassifyResult[]): VenueSummary => {
    const winList = results.filter((r) => r.cls === 'WIN');
    const usdcTotal = winList.reduce((s, r) => s + (r.edgeUsdc !== null ? toFloat(r.edgeUsdc, 6) : 0), 0);
    return {
      winCount: winList.length,
      winDegradedCount: results.filter((r) => r.cls === 'WIN_DEGRADED').length,
      loseSpeedCount: results.filter((r) => r.cls === 'LOSE_SPEED').length,
      losePriceCount: results.filter((r) => r.cls === 'LOSE_PRICE').length,
      capturableUsdcPerDay: activeDays > 0 ? usdcTotal / activeDays : 0,
      marginBpsP50: median(winList.map((r) => r.marginBps!)),
      medianShortfallBps: median(
        results.filter((r) => r.cls === 'LOSE_PRICE' && r.shortfallBps !== null).map((r) => r.shortfallBps!)
      ),
    };
  };
  const eligibleOutcomes = outcomes.filter((o) => o.kyberResult !== null && !o.kyberOnly);
  const kalqixSummary = venueSummary(eligibleOutcomes.map((o) => o.result));
  const kyberSummary = venueSummary(eligibleOutcomes.map((o) => o.kyberResult!));
  const bebopSummary = venueSummary(eligibleOutcomes.map((o) => o.bebopResult).filter((r): r is ClassifyResult => r !== null));
  const kyberOnlyOutcomes = outcomes.filter((o) => o.kyberOnly && o.kyberResult !== null);
  const kyberOnlySummary = venueSummary(kyberOnlyOutcomes.map((o) => o.kyberResult!));
  const kyberOnlyBebopSummary = venueSummary(
    kyberOnlyOutcomes.map((o) => o.bebopResult).filter((r): r is ClassifyResult => r !== null)
  );
  let bestOfWins = 0;
  let bestOfUsdc = 0;
  for (const o of eligibleOutcomes) {
    const candidates = [o.result, o.kyberResult!, o.bebopResult].filter(
      (r): r is ClassifyResult => r !== null && r.cls === 'WIN' && r.edgeUsdc !== null
    );
    if (candidates.length === 0) continue;
    bestOfWins++;
    bestOfUsdc += Math.max(...candidates.map((r) => toFloat(r.edgeUsdc!, 6)));
  }

  // --- data quality ---
  const eventCounts = new Map<string, number>(
    (
      (await db.all(`SELECT kind, COUNT(*) AS c FROM events GROUP BY kind`)) as Array<{
        kind: string;
        c: number;
      }>
    ).map((r) => [r.kind, r.c])
  );
  const eventCount = (kind: string): number => eventCounts.get(kind) ?? 0;
  const wsGaps = (await db.all(
    `SELECT detail_json FROM events WHERE kind = 'ws_gap'`
  )) as Array<{ detail_json: string }>;
  let wsDowntimeMs = 0;
  for (const g of wsGaps) {
    try {
      const d = JSON.parse(g.detail_json);
      if (typeof d.fromMs === 'number' && typeof d.toMs === 'number') wsDowntimeMs += Math.max(0, d.toMs - d.fromMs);
    } catch {
      // ignore malformed
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    observedActiveHours: activeMs / 3_600_000,
    runs: runRows.map((r) => ({
      id: r.id,
      startedAt: new Date(r.started_at_ms).toISOString(),
      endedAt: r.ended_at_ms ? new Date(r.ended_at_ms).toISOString() : null,
      clean: r.clean_shutdown === 1,
      skewMs: r.clock_skew_ms,
    })),
    configWarning,
    headline: {
      capturableGrossMarginUsdcPerDay: activeDays > 0 ? winUsdcTotal / activeDays : 0,
      winCount: wins.length,
      winVolumeUsd,
      addressableVolumeUsd,
      winVolumeSharePct: addressableVolumeUsd > 0 ? (100 * winVolumeUsd) / addressableVolumeUsd : null,
    },
    funnel,
    winRate: {
      overallPct: decided.length > 0 ? (100 * wins.length) / decided.length : null,
      perPair,
      marginBpsP10: percentile(marginList, 10),
      marginBpsP50: percentile(marginList, 50),
      marginBpsP90: percentile(marginList, 90),
      leadTimeHistogram: leadHist,
    },
    losses: {
      counts: lossCounts,
      losePriceMedianShortfallBps: median(losePriceShortfalls),
    },
    sizeBuckets,
    depthCeiling,
    venueComparison: {
      kalqix: kalqixSummary,
      kyber: kyberSummary,
      bebop: bebopSummary,
      bestOf: {
        winCount: bestOfWins,
        capturableUsdcPerDay: activeDays > 0 ? bestOfUsdc / activeDays : 0,
      },
      kyberTickCoveragePct: totalTicks > 0 ? (100 * kyberCoveredTicks) / totalTicks : null,
      bebopTickCoveragePct: totalTicks > 0 ? (100 * bebopCoveredTicks) / totalTicks : null,
    },
    kyberOnly: { ...kyberOnlySummary, orders: kyberOnlyOutcomes.length, bebop: kyberOnlyBebopSummary },
    sensitivity: sensParams.map((s) => s.cell),
    dataQuality: {
      wsGapCount: wsGaps.length,
      wsDowntimeMinutes: wsDowntimeMs / 60_000,
      pollFallbackCount: eventCount('poll_fallback_start'),
      sampleGapCount: eventCount('sample_gap'),
      degradedTickPct: totalTicks > 0 ? (100 * degradedTicks) / totalTicks : null,
      totalTicks,
      errorSkips: eventCount('error_skip'),
      lateSeenOrders: outcomes.filter((o) => o.lateSeen).length,
      rest429Count: eventCount('rest_429'),
      kalqix429Count: eventCount('kalqix_429'),
      clockSkewsMs: runRows.map((r) => r.clock_skew_ms).filter((s): s is number => s !== null),
      unpricedUnsupportedCount: outcomes.filter((o) => o.cls === 'SKIPPED_UNSUPPORTED' && o.volumeUsd === null).length,
      winDegradedCount: lossCounts.WIN_DEGRADED ?? 0,
      noTicksCount: lossCounts.NO_TICKS ?? 0,
    },
    outcomes,
  };
}
