/** Combined dashboard: one read-only server over every chain's DB, one page.
 *  Leads with the finding (per-venue scoreboard + funnel), keeps operations
 *  detail in a collapsed drawer. Verdicts are worded for mixed audiences. */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { allChains, config, type ResolvedChain } from '../../config.js';
import { fmtUnits, toFloat } from '../pricing/units.js';
import { classify, tickForVenue, type ClassifyResult, type Venue } from '../report/classify.js';
import { ensureMigrated } from '../db/db.js';
import { resetResolveBudget, tokenLabel } from '../chain/tokens.js';
import { PAGE } from './page.js';
import { log } from '../log.js';

const PORT = Number(process.env.DASH_PORT ?? 8787);
const VENUES: Array<{ venue: Venue; name: string }> = [
  { venue: 'kalqix', name: 'KalqiX order book' },
  { venue: 'kyber', name: 'Kyber aggregator' },
  { venue: 'bebop', name: 'Bebop market makers' },
];

interface Chip {
  kind: 'win' | 'late' | 'short' | 'thin' | 'none';
  text: string;
}

interface VenueOutcome {
  cls: string;
  marginBps: number | null;
  shortfallBps: number | null;
  hasData: boolean;
}

interface CachedOutcome {
  terminalAtMs: number;
  pairTicker: string | null;
  makerAsset: string;
  takerAsset: string;
  sizeUsd: number | null;
  outcome: string;
  leadS: number | null;
  venues: Record<Venue, VenueOutcome>;
}

const TICK_SQL = `SELECT ts_ms, degraded, exclusive, insufficient_depth, hedge_proceeds,
  auction_cost, gas_cost_raw, fee_cost, notional_taker, notional_usdc,
  kyber_out, kyber_degraded, kyber_gas_cost, kyber_fee,
  bebop_out, bebop_degraded, bebop_gas_cost, bebop_fee
  FROM ticks WHERE order_hash = ? ORDER BY ts_ms`;

class ChainView {
  readonly db: Database.Database;
  private readonly outcomeCache = new Map<string, CachedOutcome>();

  constructor(readonly chain: ResolvedChain) {
    ensureMigrated(chain.dbPath);
    this.db = new Database(chain.dbPath, { readonly: true });
  }

  private latestMids(): Map<string, bigint> {
    const mids = new Map<string, bigint>();
    for (const p of this.chain.pairs) {
      const snap = this.db
        .prepare(`SELECT ts_ms, mid FROM snapshots WHERE ticker = ? AND mid IS NOT NULL ORDER BY id DESC LIMIT 1`)
        .get(p.ticker) as { ts_ms: number; mid: string } | undefined;
      const ref = this.db
        .prepare(`SELECT ts_ms, mid FROM ref_prices WHERE ticker = ? ORDER BY ts_ms DESC LIMIT 1`)
        .get(p.ticker) as { ts_ms: number; mid: string } | undefined;
      const best = [snap, ref].filter(Boolean).sort((a, b) => b!.ts_ms - a!.ts_ms)[0];
      if (best) mids.set(p.ticker, BigInt(best.mid));
    }
    return mids;
  }

  private legUsd(mids: Map<string, bigint>, asset: string, amount: bigint): number | null {
    const a = asset.toLowerCase();
    for (const p of this.chain.pairs) {
      if (p.quote.addresses.includes(a)) return toFloat(amount, p.quote.decimals);
      if (p.base.addresses.includes(a)) {
        const m = mids.get(p.ticker);
        return m === undefined ? null : toFloat(amount, p.base.decimals) * toFloat(m, p.quote.decimals);
      }
    }
    return null;
  }

  private outcomeFor(row: Record<string, any>, mids: Map<string, bigint>): CachedOutcome {
    let cached = this.outcomeCache.get(row.order_hash);
    if (cached) return cached;
    const raw = this.db.prepare(TICK_SQL).all(row.order_hash) as Record<string, any>[];
    const orderData = {
      orderHash: row.order_hash,
      eligible: true,
      skipReason: null,
      terminalStatus: row.terminal_status,
      tActualMs: row.t_actual_chain_ms ?? row.t_actual_ws_ms ?? null,
      terminalAtMs: row.terminal_at_ms,
      lateSeen: row.late_seen === 1,
    };
    const params = { safetyMarginBps: config.safetyMarginBps, gasMultNum: 1n, gasMultDen: 1n };
    const venues = {} as Record<Venue, VenueOutcome>;
    let leadS: number | null = null;
    for (const { venue } of VENUES) {
      const ticks = raw.map((t) => tickForVenue(t, venue));
      const r: ClassifyResult = classify(orderData, ticks, params);
      venues[venue] = {
        cls: r.cls,
        marginBps: r.marginBps,
        shortfallBps: r.shortfallBps,
        hasData: ticks.some((t) => t.hedgeProceeds !== null || (venue === 'kalqix' && t.insufficientDepth)),
      };
      if (r.leadTimeMs !== null && r.cls === 'WIN') leadS = Math.round(r.leadTimeMs / 1000);
    }
    const firstUsd = raw.find((t) => t.notional_usdc !== null);
    const sizeUsd =
      firstUsd !== undefined
        ? toFloat(BigInt(firstUsd.notional_usdc), 6)
        : this.legUsd(mids, row.maker_asset, BigInt(row.making_amount)) ??
          this.legUsd(mids, row.taker_asset, BigInt(row.taking_amount));
    cached = {
      terminalAtMs: row.terminal_at_ms,
      pairTicker: row.pair,
      makerAsset: row.maker_asset,
      takerAsset: row.taker_asset,
      sizeUsd,
      outcome: row.terminal_status === 'filled' ? 'filled by someone' : row.terminal_status,
      leadS,
      venues,
    };
    this.outcomeCache.set(row.order_hash, cached);
    return cached;
  }

  private pairLabel(o: { pairTicker: string | null; makerAsset: string; takerAsset: string }): string {
    if (o.pairTicker) return o.pairTicker.replace('_', '/');
    return `${tokenLabel(o.makerAsset, this.chain.rpcUrl)} > ${tokenLabel(o.takerAsset, this.chain.rpcUrl)}`;
  }

  private decidedChip(v: VenueOutcome): Chip {
    if (!v.hasData) return { kind: 'none', text: 'no data' };
    switch (v.cls) {
      case 'WIN':
        return { kind: 'win', text: `won +${v.marginBps?.toFixed(1)} bps` };
      case 'WIN_DEGRADED':
        return { kind: 'win', text: `won* +${v.marginBps?.toFixed(1)} bps` };
      case 'LOSE_SPEED':
        return { kind: 'late', text: 'profitable too late' };
      case 'LOSE_PRICE':
        return { kind: 'short', text: `${v.shortfallBps?.toFixed(1)} bps short` };
      case 'NO_DEPTH':
        return { kind: 'thin', text: 'book too thin' };
      case 'UNFILLABLE':
        return { kind: 'none', text: 'unfillable' };
      default:
        return { kind: 'none', text: 'no data' };
    }
  }

  private liveChip(edge: string | null, notionalTaker: string | null, degraded: boolean): Chip {
    if (edge === null || notionalTaker === null || BigInt(notionalTaker) === 0n) {
      return { kind: 'none', text: 'no data' };
    }
    const bps = Number((BigInt(edge) * 1_000_000n) / BigInt(notionalTaker)) / 100;
    const star = degraded ? '*' : '';
    return bps > 0
      ? { kind: 'win', text: `+${bps.toFixed(1)} bps${star}` }
      : { kind: 'short', text: `${bps.toFixed(1)} bps${star}` };
  }

  collect(): Record<string, unknown> {
    const mids = this.latestMids();
    const run = this.db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`).get() as Record<string, any> | undefined;
    const runs = this.db.prepare(`SELECT started_at_ms, ended_at_ms FROM runs`).all() as Array<Record<string, any>>;
    const lastTick = (this.db.prepare(`SELECT MAX(ts_ms) t FROM ticks`).get() as any).t;
    let activeMs = 0;
    for (const r of runs) activeMs += Math.max(0, (r.ended_at_ms ?? Date.now()) - r.started_at_ms);

    // decided outcomes (all, cached per order)
    const decidedRows = this.db
      .prepare(
        `SELECT order_hash, pair, terminal_status, terminal_at_ms, t_actual_ws_ms, t_actual_chain_ms,
                late_seen, maker_asset, taker_asset, making_amount, taking_amount
         FROM orders WHERE (eligible = 1 OR kyber_only = 1) AND terminal_status IS NOT NULL
         ORDER BY terminal_at_ms DESC`
      )
      .all() as Record<string, any>[];
    const outcomes = decidedRows.map((r) => this.outcomeFor(r, mids));

    // venue scoreboard
    const venueCards = VENUES.map(({ venue, name }) => {
      const withData = outcomes.map((o) => o.venues[venue]).filter((v) => v.hasData && v.cls !== 'NO_TICKS');
      const wins = withData.filter((v) => v.cls === 'WIN');
      const losses = withData.filter((v) => v.cls === 'LOSE_SPEED' || v.cls === 'LOSE_PRICE');
      const thin = withData.length - wins.length - losses.length;
      const med = (xs: number[]) => {
        if (xs.length === 0) return null;
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor((s.length - 1) / 2)]!;
      };
      return {
        name,
        decided: withData.length,
        wins: wins.length,
        losses: losses.length,
        thin,
        medianWinBps: med(wins.map((v) => v.marginBps!).filter((x) => x !== null)),
        medianMissBps: med(withData.filter((v) => v.cls === 'LOSE_PRICE').map((v) => v.shortfallBps!)),
      };
    });

    // funnel
    const seen = (this.db.prepare(`SELECT COUNT(*) c FROM orders`).get() as any).c;
    const hedgeableRows = this.db
      .prepare(`SELECT order_hash, maker_asset, taker_asset, making_amount, taking_amount FROM orders WHERE eligible = 1 OR kyber_only = 1`)
      .all() as Record<string, any>[];
    let hedgeableUsd = 0;
    for (const r of hedgeableRows) {
      const u =
        this.legUsd(mids, r.maker_asset, BigInt(r.making_amount)) ??
        this.legUsd(mids, r.taker_asset, BigInt(r.taking_amount));
      if (u !== null) hedgeableUsd += u;
    }
    const priced = (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM orders o WHERE (o.eligible = 1 OR o.kyber_only = 1)
           AND EXISTS (SELECT 1 FROM ticks t WHERE t.order_hash = o.order_hash)`
        )
        .get() as any
    ).c;
    const wonOutcomes = outcomes.filter((o) => VENUES.some(({ venue }) => o.venues[venue].cls === 'WIN'));
    const wonUsd = wonOutcomes.reduce((s, o) => s + (o.sizeUsd ?? 0), 0);

    // live orders
    const live = (
      this.db
        .prepare(
          `SELECT o.order_hash, o.pair, o.kyber_only, o.maker_asset, o.taker_asset,
                  o.auction_start_ms, o.auction_duration_s, o.deadline_ms,
                  t.edge_default, t.edge_kyber, t.edge_bebop, t.degraded, t.kyber_degraded, t.bebop_degraded,
                  t.insufficient_depth, t.notional_taker, t.notional_usdc
           FROM orders o
           LEFT JOIN ticks t ON t.id = (SELECT MAX(id) FROM ticks WHERE order_hash = o.order_hash)
           WHERE (o.eligible = 1 OR o.kyber_only = 1) AND o.terminal_status IS NULL
           ORDER BY o.received_at_ms DESC`
        )
        .all() as Record<string, any>[]
    ).map((o) => {
      const now = Date.now();
      const durMs = (o.auction_duration_s ?? 0) * 1000;
      const elapsed = o.auction_start_ms !== null ? now - o.auction_start_ms : 0;
      const decayPct = durMs > 0 ? Math.min(100, Math.max(0, (100 * elapsed) / durMs)) : 0;
      const kalqixChip: Chip =
        o.insufficient_depth === 1
          ? { kind: 'thin', text: 'book too thin' }
          : this.liveChip(o.edge_default, o.notional_taker, o.degraded === 1);
      return {
        pair: this.pairLabel({ pairTicker: o.pair, makerAsset: o.maker_asset, takerAsset: o.taker_asset }),
        sizeUsd: o.notional_usdc !== null ? toFloat(BigInt(o.notional_usdc), 6) : null,
        decayPct: Math.round(decayPct),
        decayLabel: decayPct >= 100 ? 'at floor' : 'decaying',
        kalqix: o.kyber_only === 1 ? { kind: 'none', text: 'no market' } : kalqixChip,
        kyber: this.liveChip(o.edge_kyber, o.notional_taker, o.kyber_degraded === 1),
        bebop: this.liveChip(o.edge_bebop, o.notional_taker, o.bebop_degraded === 1),
        expires: o.deadline_ms !== null ? `${Math.max(0, Math.round((o.deadline_ms - now) / 60000))} min` : '?',
      };
    });

    // decided table (latest 20)
    const decided = outcomes.slice(0, 20).map((o) => ({
      time: new Date(o.terminalAtMs).toISOString().slice(11, 19),
      pair: this.pairLabel(o),
      sizeUsd: o.sizeUsd,
      outcome: o.outcome,
      kalqix: this.decidedChip(o.venues.kalqix),
      kyber: this.decidedChip(o.venues.kyber),
      bebop: this.decidedChip(o.venues.bebop),
      lead: o.leadS !== null ? `${o.leadS}s earlier` : '',
    }));

    // ops drawer
    const lastWs = this.db
      .prepare(`SELECT kind FROM events WHERE kind IN ('ws_connected','ws_disconnected') ORDER BY id DESC LIMIT 1`)
      .get() as any;
    const lastOrder = (this.db.prepare(`SELECT MAX(received_at_ms) t FROM orders`).get() as any).t;
    const healthy =
      run !== undefined &&
      run.ended_at_ms === null &&
      lastWs?.kind === 'ws_connected' &&
      (lastOrder === null || Date.now() - Math.max(lastOrder, lastTick ?? 0) < 20 * 60_000);

    const books = this.chain.pairs.map((p) => {
      const snap = this.db
        .prepare(`SELECT ts_ms, mid, bid_depth_base, ask_depth_base FROM snapshots WHERE ticker = ? ORDER BY id DESC LIMIT 1`)
        .get(p.ticker) as Record<string, any> | undefined;
      const ref = this.db
        .prepare(`SELECT ts_ms, mid FROM ref_prices WHERE ticker = ? ORDER BY ts_ms DESC LIMIT 1`)
        .get(p.ticker) as Record<string, any> | undefined;
      const snapFresher = snap && (!ref || snap.ts_ms >= ref.ts_ms);
      const src = snapFresher ? snap : ref;
      return {
        ticker: p.ticker,
        mid: src ? `${fmtUnits(BigInt(src.mid), p.quote.decimals)} USDC` : null,
        age: src ? `${Math.round((Date.now() - src.ts_ms) / 1000)}s` : '?',
        bid: snapFresher ? `${fmtUnits(BigInt(snap.bid_depth_base), p.base.decimals)} ${p.base.symbol}` : null,
        ask: snapFresher ? `${fmtUnits(BigInt(snap.ask_depth_base), p.base.decimals)} ${p.base.symbol}` : null,
      };
    });

    const topUnsupported = (
      this.db
        .prepare(
          `SELECT asset, COUNT(*) c FROM (
             SELECT maker_asset AS asset FROM orders WHERE eligible = 0 AND kyber_only = 0
             UNION ALL SELECT taker_asset FROM orders WHERE eligible = 0 AND kyber_only = 0
           ) GROUP BY asset ORDER BY c DESC LIMIT 8`
        )
        .all() as Array<{ asset: string; c: number }>
    ).map((r) => ({ token: tokenLabel(r.asset, this.chain.rpcUrl), orders: r.c }));

    const events = (
      this.db.prepare(`SELECT ts_ms, kind, detail_json FROM events ORDER BY id DESC LIMIT 10`).all() as Record<string, any>[]
    ).map((e) => ({
      time: new Date(e.ts_ms).toISOString().slice(11, 19),
      kind: e.kind,
      detail: e.detail_json ? String(e.detail_json).slice(0, 90) : '',
    }));

    const ticksTotal = (this.db.prepare(`SELECT COUNT(*) c FROM ticks`).get() as any).c;
    const liveCount = live.length;

    return {
      key: this.chain.key,
      label: this.chain.label,
      chainId: this.chain.chainId,
      observedHours: activeMs / 3_600_000,
      ordersSeen: seen,
      healthy,
      venues: venueCards,
      funnel: { seen, hedgeable: hedgeableRows.length, hedgeableUsd, priced, won: wonOutcomes.length, wonUsd },
      live,
      decided,
      ops: {
        counters: [
          ['run', `#${run?.id ?? '?'}`],
          ['live now', String(liveCount)],
          ['pricing ticks', ticksTotal.toLocaleString('en-US')],
          ['decided', String(outcomes.length)],
          ['clock skew', run?.clock_skew_ms !== null && run !== undefined ? `${run.clock_skew_ms}ms` : '?'],
          ['last order', lastOrder ? `${Math.round((Date.now() - lastOrder) / 60000)}m ago` : 'never'],
        ],
        books,
        topUnsupported,
        events,
      },
    };
  }
}

const views = allChains.filter((c) => existsSync(c.dbPath)).map((c) => new ChainView(c));
if (views.length === 0) {
  console.error('no chain databases found; start a collector first');
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.url === '/data.json') {
    try {
      resetResolveBudget();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ now: new Date().toISOString(), chains: views.map((v) => v.collect()) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`dashboard: http://127.0.0.1:${PORT} (${views.map((v) => v.chain.label).join(' + ')}, read-only, refreshes every 5s)`);
});
