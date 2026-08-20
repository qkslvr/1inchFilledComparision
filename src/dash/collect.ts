/** Dashboard data collection, shared by the local server and the Vercel
 *  function. Every figure is either a SQL aggregate or a bounded row set: a
 *  serverless reader gets no process-lifetime cache to amortise a full scan, so
 *  nothing here re-derives verdicts — the collector wrote them to
 *  decided_outcomes when each order finished. */
import { allChains, config, type ResolvedChain } from '../../config.js';
import { Db } from '../db/db.js';
import { schemaFor } from '../db/schema.js';
import { fmtUnits, toFloat } from '../pricing/units.js';
import type { Venue } from '../report/classify.js';

const VENUES: Array<{ venue: Venue; name: string }> = [
  { venue: 'kalqix', name: 'KalqiX order book' },
  { venue: 'kyber', name: 'Kyber aggregator' },
  { venue: 'bebop', name: 'Bebop market makers' },
  { venue: 'pancake', name: 'PancakeSwap V3' },
];

interface Chip {
  kind: 'win' | 'late' | 'short' | 'thin' | 'none';
  text: string;
}

function decidedChip(v: {
  cls: string;
  margin_bps: number | null;
  shortfall_bps: number | null;
  has_data: number;
}): Chip {
  if (v.has_data !== 1) return { kind: 'none', text: 'no data' };
  switch (v.cls) {
    // classify() can reach a verdict without a figure to put on it: a win whose
    // notional never resolved, or a LOSE_PRICE whose best tick fell outside the
    // decision horizon. Say so rather than rendering "undefined bps".
    case 'WIN':
      return { kind: 'win', text: v.margin_bps === null ? 'won' : `won +${v.margin_bps.toFixed(1)} bps` };
    case 'WIN_DEGRADED':
      return { kind: 'win', text: v.margin_bps === null ? 'won*' : `won* +${v.margin_bps.toFixed(1)} bps` };
    case 'LOSE_SPEED':
      return { kind: 'late', text: 'profitable too late' };
    case 'LOSE_PRICE':
      return {
        kind: 'short',
        text: v.shortfall_bps === null ? 'never profitable' : `${v.shortfall_bps.toFixed(1)} bps short`,
      };
    case 'NO_DEPTH':
      return { kind: 'thin', text: 'book too thin' };
    case 'UNFILLABLE':
      return { kind: 'none', text: 'unfillable' };
    default:
      return { kind: 'none', text: 'no data' };
  }
}

function liveChip(edge: string | null, notionalTaker: string | null, degraded: boolean): Chip {
  if (edge === null || notionalTaker === null || BigInt(notionalTaker) === 0n) {
    return { kind: 'none', text: 'no data' };
  }
  const bps = Number((BigInt(edge) * 1_000_000n) / BigInt(notionalTaker)) / 100;
  const star = degraded ? '*' : '';
  return bps > 0
    ? { kind: 'win', text: `+${bps.toFixed(1)} bps${star}` }
    : { kind: 'short', text: `${bps.toFixed(1)} bps${star}` };
}

const NO_MARKET: Chip = { kind: 'none', text: 'no market' };

function isToday(tsMs: number): boolean {
  return new Date(tsMs).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

async function collectChain(chain: ResolvedChain, db: Db): Promise<Record<string, unknown>> {
  // Every query below is independent, so they go out as one wave. Sequentially
  // this cost a full round trip each — 17 per chain, and against a hosted
  // database that was most of a 15-second response.
  const [
    tokenRows,
    run,
    runs,
    venueRows,
    counts,
    priced,
    won,
    liveRows,
    decidedRows,
    lastWs,
    activity,
    bookRows,
    unsupportedRows,
    eventRows,
    purged,
  ] = await Promise.all([
    db.tokens(),
    db.get(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`),
    // Observed time is the sum of per-run spans. A run with no ended_at_ms was
    // killed uncleanly, and ending it at "now" credited it every hour since —
    // 11 short runs read as 2,900 hours. End it at its own last recorded
    // activity instead, bounded by the next run's start, which is the rule the
    // report already uses.
    db.all(
      `SELECT started_at_ms,
              COALESCE(ended_at_ms, GREATEST(
                COALESCE((SELECT MAX(ts_ms) FROM ticks
                          WHERE ts_ms >= r.started_at_ms AND ts_ms < r.next_start), r.started_at_ms),
                COALESCE((SELECT MAX(received_at_ms) FROM orders
                          WHERE received_at_ms >= r.started_at_ms AND received_at_ms < r.next_start), r.started_at_ms),
                COALESCE((SELECT MAX(ts_ms) FROM events
                          WHERE ts_ms >= r.started_at_ms AND ts_ms < r.next_start), r.started_at_ms)
              )) AS ended_at_ms
       FROM (SELECT id, started_at_ms, ended_at_ms,
                    COALESCE(LEAD(started_at_ms) OVER (ORDER BY id), 9223372036854775807) AS next_start
             FROM runs) r`
    ) as Promise<Array<{ started_at_ms: number; ended_at_ms: number }>>,
    venueScoreboard(db),
    db.get(
      `SELECT COUNT(*) AS seen,
              COUNT(*) FILTER (WHERE eligible = 1 OR kyber_only = 1) AS hedgeable,
              COALESCE(SUM(size_usd) FILTER (WHERE eligible = 1 OR kyber_only = 1), 0) AS hedgeable_usd
       FROM orders`
    ) as Promise<Record<string, any>>,
    db.get(
      `SELECT COUNT(*) AS c FROM orders o WHERE (o.eligible = 1 OR o.kyber_only = 1)
       AND EXISTS (SELECT 1 FROM ticks t WHERE t.order_hash = o.order_hash)`
    ) as Promise<{ c: number }>,
    db.get(
      `SELECT COUNT(*) AS c, COALESCE(SUM(size_usd), 0) AS usd FROM decided_outcomes WHERE any_win = 1`
    ) as Promise<{ c: number; usd: number }>,
    db.all(
      `SELECT o.order_hash, o.pair, o.kyber_only, o.maker_asset, o.taker_asset,
              o.auction_start_ms, o.auction_duration_s, o.deadline_ms,
              t.edge_default, t.edge_kyber, t.edge_bebop, t.edge_pancake, t.degraded, t.kyber_degraded, t.bebop_degraded, t.pancake_degraded,
              t.insufficient_depth, t.notional_taker, t.notional_usdc
       FROM orders o
       -- LATERAL over idx_ticks_order(order_hash, ts_ms DESC). The old form
       -- selected MAX(id), which needed a second index on order_hash purely to
       -- stay fast, and that index cost more than the ticks table itself.
       LEFT JOIN LATERAL (
         SELECT * FROM ticks WHERE order_hash = o.order_hash ORDER BY ts_ms DESC LIMIT 1
       ) t ON true
       WHERE (o.eligible = 1 OR o.kyber_only = 1) AND o.terminal_status IS NULL
       ORDER BY o.received_at_ms DESC LIMIT 100`
    ) as Promise<Array<Record<string, any>>>,
    db.all(
      `SELECT d.order_hash, d.terminal_at_ms, d.pair, d.maker_asset, d.taker_asset,
              d.size_usd, d.outcome, d.lead_s,
              v.venue, v.cls, v.margin_bps, v.shortfall_bps, v.has_data
       FROM (SELECT * FROM decided_outcomes ORDER BY terminal_at_ms DESC LIMIT 20) d
       LEFT JOIN decided_venue_outcomes v ON v.order_hash = d.order_hash
       ORDER BY d.terminal_at_ms DESC`
    ) as Promise<Array<Record<string, any>>>,
    db.get(
      `SELECT kind FROM events WHERE kind IN ('ws_connected','ws_disconnected') ORDER BY id DESC LIMIT 1`
    ) as Promise<{ kind: string } | undefined>,
    db.get(
      `SELECT (SELECT MAX(received_at_ms) FROM orders) AS last_order,
              (SELECT MAX(ts_ms) FROM ticks) AS last_tick,
              (SELECT COUNT(*) FROM ticks) AS ticks_total,
              (SELECT COUNT(*) FROM decided_outcomes) AS decided_total`
    ) as Promise<Record<string, any>>,
    Promise.all(
      chain.pairs.map(async (p) => {
        const [snap, ref] = await Promise.all([
          db.get(
            `SELECT ts_ms, mid, bid_depth_base, ask_depth_base FROM snapshots WHERE ticker = ? ORDER BY id DESC LIMIT 1`,
            [p.ticker]
          ) as Promise<Record<string, any> | undefined>,
          db.get(`SELECT ts_ms, mid FROM ref_prices WHERE ticker = ? ORDER BY ts_ms DESC LIMIT 1`, [
            p.ticker,
          ]) as Promise<Record<string, any> | undefined>,
        ]);
        return { pair: p, snap, ref };
      })
    ),
    db.all(
      `SELECT asset, COUNT(*) AS c FROM (
         SELECT maker_asset AS asset FROM orders WHERE eligible = 0 AND kyber_only = 0
         UNION ALL SELECT taker_asset FROM orders WHERE eligible = 0 AND kyber_only = 0
       ) AS assets GROUP BY asset ORDER BY c DESC LIMIT 8`
    ) as Promise<Array<{ asset: string; c: number }>>,
    db.all(`SELECT ts_ms, kind, detail_json FROM events ORDER BY id DESC LIMIT 10`) as Promise<
      Array<Record<string, any>>
    >,
    // Retention deletes unhedgeable orders, which are most of the flow by count.
    // Adding back what it removed keeps "auctions seen" a true statement about
    // how much was observed rather than how much is still stored.
    db.get(`SELECT COALESCE(SUM(count), 0) AS c FROM purged_stats`) as Promise<{ c: number }>,
  ]);

  const symbols = new Map(tokenRows.map((t) => [t.address.toLowerCase(), t.symbol]));
  const tokenLabel = (address: string): string =>
    symbols.get(address.toLowerCase()) ?? address.slice(0, 8) + '..';
  const pairLabel = (o: Record<string, any>): string =>
    o.pair ? o.pair.replace('_', '/') : `${tokenLabel(o.maker_asset)} > ${tokenLabel(o.taker_asset)}`;

  // Everything the pruner removed still counts as observed flow.
  const seenTotal = Number(counts.seen) + Number(purged?.c ?? 0);

  let activeMs = 0;
  for (const r of runs) activeMs += Math.max(0, r.ended_at_ms - r.started_at_ms);

  // Only the venues this dataset actually uses: a PancakeSwap card on Ethereum
  // would read "no orders" forever.
  const venues = VENUES.filter(({ venue }) => chain.venues.includes(venue as never)).map(({ venue, name }) => {
    const r = venueRows.get(venue);
    const decidedCount = r?.decided ?? 0;
    const wins = r?.wins ?? 0;
    const losses = r?.losses ?? 0;
    return {
      name,
      decided: decidedCount,
      wins,
      losses,
      thin: decidedCount - wins - losses,
      medianWinBps: r?.median_win_bps ?? null,
      medianMissBps: r?.median_miss_bps ?? null,
      medianSizeUsd: r?.median_size_usd ?? null,
      totalSizeUsd: Number(r?.total_size_usd ?? 0),
    };
  });

  // Settled datasets have no live phase: a trade is already done when we see
  // it. Any row here would be one caught mid-write, so do not show it.
  const live = (chain.orderSource === 'cow' ? [] : liveRows).map((o) => {
    const now = Date.now();
    const durMs = (o.auction_duration_s ?? 0) * 1000;
    const elapsed = o.auction_start_ms !== null ? now - o.auction_start_ms : 0;
    const decayPct = durMs > 0 ? Math.min(100, Math.max(0, (100 * elapsed) / durMs)) : 0;
    const kalqixChip: Chip =
      o.insufficient_depth === 1
        ? { kind: 'thin', text: 'book too thin' }
        : liveChip(o.edge_default, o.notional_taker, o.degraded === 1);
    return {
      pair: pairLabel(o),
      sizeUsd: o.notional_usdc !== null ? toFloat(BigInt(o.notional_usdc), 6) : null,
      decayPct: Math.round(decayPct),
      decayLabel: decayPct >= 100 ? 'at floor' : 'decaying',
      kalqix: o.kyber_only === 1 ? NO_MARKET : kalqixChip,
      kyber: liveChip(o.edge_kyber, o.notional_taker, o.kyber_degraded === 1),
      bebop: liveChip(o.edge_bebop, o.notional_taker, o.bebop_degraded === 1),
      pancake: liveChip(o.edge_pancake, o.notional_taker, o.pancake_degraded === 1),
      expires: o.deadline_ms !== null ? `${Math.max(0, Math.round((o.deadline_ms - now) / 60000))} min` : '?',
    };
  });

  const decidedByHash = new Map<string, Record<string, any>>();
  for (const r of decidedRows) {
    let entry = decidedByHash.get(r.order_hash);
    if (!entry) {
      entry = {
        // Date included once a row isn't from today, otherwise a gap in
        // collection makes yesterday's rows look interleaved with this morning's.
        time: isToday(r.terminal_at_ms)
          ? new Date(r.terminal_at_ms).toISOString().slice(11, 19)
          : new Date(r.terminal_at_ms).toISOString().slice(5, 16).replace('T', ' '),
        pair: pairLabel(r),
        sizeUsd: r.size_usd,
        outcome: r.outcome === 'filled' ? 'filled by someone' : r.outcome,
        lead: r.lead_s !== null ? `${r.lead_s}s earlier` : '',
        kalqix: { kind: 'none', text: 'no data' } as Chip,
        kyber: { kind: 'none', text: 'no data' } as Chip,
        bebop: { kind: 'none', text: 'no data' } as Chip,
        pancake: { kind: 'none', text: 'no data' } as Chip,
      };
      decidedByHash.set(r.order_hash, entry);
    }
    if (r.venue) entry[r.venue] = decidedChip(r as any);
  }
  const decided = [...decidedByHash.values()];

  const healthy =
    run !== undefined &&
    run.ended_at_ms === null &&
    lastWs?.kind === 'ws_connected' &&
    (activity.last_order === null ||
      Date.now() - Math.max(activity.last_order, activity.last_tick ?? 0) < 20 * 60_000);

  const books = bookRows.map(({ pair: p, snap, ref }) => {
    const snapFresher = snap !== undefined && (ref === undefined || snap.ts_ms >= ref.ts_ms);
    const src = snapFresher ? snap : ref;
    return {
      ticker: p.ticker,
      mid: src ? `${fmtUnits(BigInt(src.mid), p.quote.decimals)} USDC` : null,
      age: src ? `${Math.round((Date.now() - src.ts_ms) / 1000)}s` : '?',
      bid: snapFresher ? `${fmtUnits(BigInt(snap!.bid_depth_base), p.base.decimals)} ${p.base.symbol}` : null,
      ask: snapFresher ? `${fmtUnits(BigInt(snap!.ask_depth_base), p.base.decimals)} ${p.base.symbol}` : null,
    };
  });

  const topUnsupported = unsupportedRows.map((r) => ({ token: tokenLabel(r.asset), orders: r.c }));

  const events = eventRows.map((e) => ({
    time: new Date(e.ts_ms).toISOString().slice(11, 19),
    kind: e.kind,
    detail: e.detail_json ? String(e.detail_json).slice(0, 90) : '',
  }));

  // The solver dataset answers different questions, so it carries its own
  // block rather than bending the shadow shapes: a win rate is not a win count,
  // and a quote-hold rate has no analogue at all in the other tabs.
  const solver = chain.orderSource === 'cow-solver' ? await collectSolver(db) : null;

  return {
    key: chain.key,
    label: chain.label,
    solver,
    orderSource: chain.orderSource,
    chainId: chain.chainId,
    observedHours: activeMs / 3_600_000,
    ordersSeen: seenTotal,
    healthy,
    venues,
    funnel: {
      seen: seenTotal,
      hedgeable: counts.hedgeable,
      hedgeableUsd: Number(counts.hedgeable_usd),
      priced: priced.c,
      won: won.c,
      wonUsd: Number(won.usd),
    },
    live,
    decided,
    ops: {
      counters: [
        ['run', `#${run?.id ?? '?'}`],
        ['live now', String(live.length)],
        ['pricing ticks', activity.ticks_total.toLocaleString('en-US')],
        ['decided', String(activity.decided_total)],
        ['clock skew', run?.clock_skew_ms != null ? `${run.clock_skew_ms}ms` : '?'],
        [
          'last order',
          activity.last_order ? `${Math.round((Date.now() - activity.last_order) / 60000)}m ago` : 'never',
        ],
      ],
      books,
      topUnsupported,
      events,
    },
  };
}

/** Note: these medians interpolate between the two middle values
 *  (percentile_cont). The SQLite dashboard took the lower of the two. */
async function venueScoreboard(db: Db): Promise<Map<string, Record<string, any>>> {
  const rows = (await db.all(
    `SELECT v.venue,
            COUNT(*) FILTER (WHERE cls <> 'NO_TICKS') AS decided,
            -- WIN_DEGRADED counts too: the venue would still have been
            -- profitable, the data behind it was just stale. Excluding it made
            -- the card read "won 0" while the row below showed a green won*,
            -- and on the CoW tab every comparison is degraded by construction.
            COUNT(*) FILTER (WHERE cls IN ('WIN', 'WIN_DEGRADED')) AS wins,
            COUNT(*) FILTER (WHERE cls IN ('LOSE_SPEED','LOSE_PRICE')) AS losses,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY margin_bps)
              FILTER (WHERE cls IN ('WIN', 'WIN_DEGRADED') AND margin_bps IS NOT NULL) AS median_win_bps,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY shortfall_bps)
              FILTER (WHERE cls = 'LOSE_PRICE' AND shortfall_bps IS NOT NULL) AS median_miss_bps,
            -- Size of the trades these percentages are computed over. Without
            -- it "40% won" says nothing about whether that was on 100 USD or
            -- 100,000.
            percentile_cont(0.5) WITHIN GROUP (ORDER BY d.size_usd)
              FILTER (WHERE d.size_usd IS NOT NULL) AS median_size_usd,
            COALESCE(SUM(d.size_usd), 0) AS total_size_usd
     FROM decided_venue_outcomes v JOIN decided_outcomes d USING (order_hash)
     WHERE v.has_data = 1 GROUP BY v.venue`
  )) as Array<Record<string, any>>;
  return new Map(rows.map((r) => [r.venue, r]));
}

/** Chains whose Postgres schema exists, i.e. that a collector has run for. */
async function liveChains(probe: Db): Promise<ResolvedChain[]> {
  const rows = (await probe.all(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY(?)`,
    [allChains.map((c) => schemaFor(c.chainId, c.schemaOverride))]
  )) as Array<{ schema_name: string }>;
  const present = new Set(rows.map((r) => r.schema_name));
  return allChains.filter((c) => present.has(schemaFor(c.chainId, c.schemaOverride)));
}

/** Connections are cached per module instance: a warm serverless instance
 *  reuses them, a cold one pays a single connect. */
/** Keyed by schema, not chain id: CoW and Fusion share chain 1. */
const pools = new Map<string, Db>();

async function dbFor(chain: { chainId: number; schemaOverride?: string | null }): Promise<Db> {
  const key = schemaFor(chain.chainId, chain.schemaOverride);
  let db = pools.get(key);
  if (!db) {
    // Each chain's queries go out as one parallel wave, so the pool needs room
    // for them; with max: 1 they would queue on a single connection and pay the
    // round trip serially anyway.
    db = await Db.open(chain.chainId, { readonly: true, max: 6, schemaOverride: chain.schemaOverride });
    pools.set(key, db);
  }
  return db;
}

/** Per-venue win and quote-hold rates, plus the decided bids behind them.
 *
 *  Win rate is over auctions we actually bid on — an order we never quoted is
 *  not a loss, and counting it as one would understate every venue. */
async function collectSolver(db: Db) {
  const [venueRows, holdRows, rows, coverage] = await Promise.all([
    db.all(`SELECT our_best_venue AS venue, count(*) AS bids,
                   sum(won) AS wins,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY score_margin_bps) AS median_margin_bps
            FROM orders WHERE resolved_at_ms IS NOT NULL AND our_best_venue IS NOT NULL
            GROUP BY 1`),
    db.all(`SELECT venue, delay_ms, count(*) AS checks, sum(held) AS held,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY slippage_bps) AS median_slippage_bps
            FROM quote_holds GROUP BY 1, 2`),
    db.all(`SELECT o.order_hash, o.pair, o.resolved_at_ms, o.won, o.score_margin_bps,
                   o.our_best_venue, o.our_score, o.cow_winner_score, o.cow_reference_score,
                   o.cow_solver_count, o.size_usd, o.bid_at_ms,
                   (SELECT count(*) FROM ticks t WHERE t.order_hash = o.order_hash) AS quote_rounds,
                   (SELECT bool_and(h.held = 1) FROM quote_holds h WHERE h.order_hash = o.order_hash) AS all_held,
                   (SELECT max(h.slippage_bps) FROM quote_holds h WHERE h.order_hash = o.order_hash) AS worst_slippage_bps
            FROM orders o WHERE o.resolved_at_ms IS NOT NULL
            ORDER BY o.resolved_at_ms DESC LIMIT 400`),
    db.get(`SELECT count(*) AS tracked,
                   count(*) FILTER (WHERE resolved_at_ms IS NOT NULL) AS resolved,
                   count(*) FILTER (WHERE our_score IS NOT NULL) AS bid
            FROM orders`),
  ]);

  const holdsByVenue = new Map<string, { checks: number; held: number; slip: number | null }>();
  for (const h of holdRows) {
    const cur = holdsByVenue.get(h.venue) ?? { checks: 0, held: 0, slip: null };
    cur.checks += Number(h.checks);
    cur.held += Number(h.held ?? 0);
    if (h.median_slippage_bps !== null) cur.slip = Number(h.median_slippage_bps);
    holdsByVenue.set(h.venue, cur);
  }

  const venues = ['kalqix', 'kyber', 'bebop'].map((venue) => {
    const v = venueRows.find((r) => r.venue === venue);
    const h = holdsByVenue.get(venue);
    const bids = Number(v?.bids ?? 0);
    const wins = Number(v?.wins ?? 0);
    return {
      venue,
      name: venue === 'kalqix' ? 'KalqiX' : venue === 'kyber' ? 'Kyber' : 'Bebop',
      bids,
      wins,
      // Null rather than 0% when nothing has been bid: an untested venue and a
      // venue that never wins must not look the same.
      winRatePct: bids > 0 ? (100 * wins) / bids : null,
      holdChecks: h?.checks ?? 0,
      heldPct: h && h.checks > 0 ? (100 * h.held) / h.checks : null,
      medianMarginBps: v?.median_margin_bps === null || v?.median_margin_bps === undefined ? null : Number(v.median_margin_bps),
      medianSlippageBps: h?.slip ?? null,
    };
  });

  return {
    venues,
    coverage: {
      tracked: Number(coverage?.tracked ?? 0),
      resolved: Number(coverage?.resolved ?? 0),
      bid: Number(coverage?.bid ?? 0),
    },
    rows: rows.map((r) => ({
      time: new Date(Number(r.resolved_at_ms)).toISOString().slice(11, 19),
      tsMs: Number(r.resolved_at_ms),
      pair: r.pair,
      sizeUsd: r.size_usd === null ? null : Number(r.size_usd),
      venue: r.our_best_venue,
      won: r.won === 1,
      marginBps: r.score_margin_bps === null ? null : Number(r.score_margin_bps),
      solverCount: r.cow_solver_count === null ? null : Number(r.cow_solver_count),
      quoteRounds: Number(r.quote_rounds ?? 0),
      // null when we lost: there was nothing to honour, so "did it hold" is not
      // a question that was asked.
      held: r.all_held === null ? null : r.all_held === true,
      slippageBps: r.worst_slippage_bps === null ? null : Number(r.worst_slippage_bps),
      bidLeadMs: r.bid_at_ms === null ? null : Number(r.resolved_at_ms) - Number(r.bid_at_ms),
    })),
  };
}

export async function collectAll(datasetKey?: string): Promise<Record<string, unknown>> {
  const probe = await dbFor(config);
  let chains = await liveChains(probe);
  // A scoped page asks for one dataset; an unknown key yields nothing rather
  // than silently falling back to everything.
  if (datasetKey !== undefined) chains = chains.filter((c) => c.key === datasetKey);
  const out = await Promise.all(
    chains.map(async (chain) => collectChain(chain, await dbFor(chain)))
  );
  return { now: new Date().toISOString(), chains: out };
}
