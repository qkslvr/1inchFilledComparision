import { config } from '../../config.js';
import { Db } from '../db/db.js';
import { FusionClient } from '../fusion/client.js';
import { FusionFeed } from '../fusion/ws.js';
import { GasPoller } from '../gas/poller.js';
import { RefPriceLoop, Sampler } from '../kalqix/sampler.js';
import { chooseBookFetcher, fetchMyFees } from '../kalqix/client.js';
import { kalqixCreds } from '../kalqix/auth.js';
import { PricingEngine } from '../pricing/engine.js';
import { KyberQuoter } from '../kyber/quoter.js';
import { BebopFeed } from '../bebop/feed.js';
import { Lifecycle } from './lifecycle.js';
import { log, logError } from '../log.js';

const SDK_VERSION = '2.4.10';

const client = new FusionClient(); // fails fast if ONEINCH_API_KEY is missing
const db = new Db(config.dbPath);

const runId = db.startRun(
  JSON.stringify(config, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  process.version,
  SDK_VERSION
);
log(`run ${runId} starting on ${config.chainLabel} (chain ${config.chainId}), db ${config.dbPath}`);

// --- clock skew (Date header of first REST response) ---
let skewMs = 0;
try {
  await client.getActiveOrders(1, 1);
  if (client.skewMs !== null) {
    skewMs = client.skewMs;
    db.setRunSkew(runId, skewMs);
    db.event(runId, 'clock_skew', { skewMs });
    log(`clock skew (server - local): ${skewMs}ms${Math.abs(skewMs) > 2000 ? ' WARNING: large skew' : ''}`);
  }
} catch (err) {
  logError('startup skew probe failed (continuing, skew=0)', err);
}

// --- KalqiX account: effective taker fee + deepest working book source ---
let takerFeePpm = config.kalqixTakerFeeBps * 100n;
if (kalqixCreds()) {
  try {
    const fees = await fetchMyFees();
    takerFeePpm = fees.takerPpm;
    log(`kalqix effective taker fee: ${fees.takerPpm} ppm (tier ${fees.tier}); maker ${fees.makerPpm} ppm`);
  } catch (err) {
    logError(`kalqix fee fetch failed, using config default ${takerFeePpm} ppm`, err);
  }
} else {
  log(`kalqix creds not set, using config taker fee ${takerFeePpm} ppm`);
}
db.event(runId, 'fee_schedule', { takerFeePpm: takerFeePpm.toString(), source: kalqixCreds() ? 'account' : 'config' });
const { fetcher: bookFetcher, source: bookSource } = await chooseBookFetcher(log);
db.event(runId, 'book_source', { source: bookSource });

// --- shared services ---
const gas = new GasPoller(
  (s) => db.insertGasSample(s.tsMs, s.gasPriceWei, s.baseFeeWei),
  () => db.event(runId, 'rpc_error', { source: 'gas_poll' })
);
const refPrices = new RefPriceLoop(db);
const samplers = new Map<string, Sampler>(
  config.pairs.map((p) => [p.ticker, new Sampler(p.ticker, db, () => runId, bookFetcher)])
);
const kyber = new KyberQuoter(() => db.event(runId, 'kyber_429', {}));
const bebop = new BebopFeed((kind) => db.event(runId, kind, {}));
const engine = new PricingEngine(db, samplers, refPrices, gas, () => skewMs, () => runId, takerFeePpm, kyber, bebop);
const lifecycle = new Lifecycle(db, client, engine, () => runId, refPrices);

await gas.start();
await refPrices.start();
kyber.start();
await bebop.start();
engine.start();

// --- boot recovery: resume non-terminal orders from previous runs ---
const openRows = db.openOrders();
if (openRows.length > 0) {
  const lastEventTs = db.lastRunEventTs();
  db.event(runId, 'ws_gap', { fromMs: lastEventTs, toMs: Date.now(), reason: 'restart' });
  let resumed = 0;
  for (const row of openRows) {
    const deadline = row.deadline_ms as number | null;
    if (deadline !== null && Date.now() > deadline + config.reapGraceMs) {
      lifecycle.queueTerminalFetch(row.order_hash as string);
    } else if (lifecycle.resumeFromRow(row)) {
      resumed++;
    }
  }
  log(`boot recovery: ${openRows.length} open orders in db, ${resumed} resumed live`);
}

// --- WS feed with REST poll fallback while disconnected ---
let pollTimer: NodeJS.Timeout | null = null;
let pollInFlight = false;
let wsDownSinceMs: number | null = null;

async function pollActiveOrders(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const active = await client.getAllActiveOrders(3);
    const activeHashes = new Set(active.map((o) => o.orderHash));
    for (const o of active) {
      lifecycle.handleOrderCreated(o, Date.now(), 'poll', true);
    }
    // Live orders that vanished from the active list reached a terminal state
    // while the socket was down; we have no WS fill time for them.
    for (const hash of engine.liveHashes()) {
      if (!activeHashes.has(hash)) {
        engine.unregister(hash);
        lifecycle.queueTerminalFetch(hash);
      }
    }
  } catch (err) {
    logError('active-orders poll failed', err);
  } finally {
    pollInFlight = false;
  }
}

function startPollFallback(): void {
  if (pollTimer) return;
  db.event(runId, 'poll_fallback_start', {});
  pollTimer = setInterval(() => void pollActiveOrders(), config.activePollFallbackMs);
  void pollActiveOrders();
}

function stopPollFallback(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  db.event(runId, 'poll_fallback_stop', {});
}

const feed = new FusionFeed({
  onOrderCreated: (p, ts) => lifecycle.handleOrderCreated(p, ts, 'ws', false),
  onOrderFilled: (h, ts) => lifecycle.handleFilled(h, ts),
  onOrderFilledPartially: (h, rem, ts) => lifecycle.handleFilledPartially(h, rem, ts),
  onOrderCancelled: (h) => lifecycle.handleCancelled(h),
  onOrderInvalid: (h) => lifecycle.handleInvalid(h),
  onBalanceChange: (h, rem) => lifecycle.handleBalanceChange(h, rem),
  onStateChange: (connected) => {
    if (connected) {
      db.event(runId, 'ws_connected', {});
      if (wsDownSinceMs !== null) {
        db.event(runId, 'ws_gap', { fromMs: wsDownSinceMs, toMs: Date.now(), reason: 'disconnect' });
        wsDownSinceMs = null;
      }
      stopPollFallback();
      // one sweep to catch anything missed while down
      void pollActiveOrders();
    } else {
      wsDownSinceMs = Date.now();
      db.event(runId, 'ws_disconnected', {});
      startPollFallback();
    }
  },
});
feed.start();

// --- startup sweep: orders created before we connected ---
setTimeout(() => {
  void (async () => {
    try {
      const active = await client.getAllActiveOrders();
      let added = 0;
      for (const o of active) {
        if (!db.orderExists(o.orderHash)) {
          lifecycle.handleOrderCreated(o, Date.now(), 'sweep', true);
          added++;
        }
      }
      db.event(runId, 'sweep_done', { total: active.length, added });
      log(`startup sweep: ${active.length} active orders, ${added} new`);
    } catch (err) {
      logError('startup sweep failed', err);
    }
  })();
}, 2000);

// --- expiry reaper ---
const reaper = setInterval(() => lifecycle.reapExpired(Date.now(), config.reapGraceMs), 30_000);

// --- status line ---
let lastTickCount = 0;
let lastSampleCounts = new Map<string, number>();
const status = setInterval(() => {
  const ticksPerMin = engine.tickCount - lastTickCount;
  lastTickCount = engine.tickCount;
  const sampleBits: string[] = [];
  for (const [ticker, s] of samplers) {
    const prev = lastSampleCounts.get(ticker) ?? 0;
    sampleBits.push(`${ticker}=${s.sampleCount - prev}${s.active ? '' : ' (idle)'}`);
    lastSampleCounts.set(ticker, s.sampleCount);
  }
  log(
    `status: live=${engine.liveCount} ticks/min=${ticksPerMin} samples/min ${sampleBits.join(' ')} ` +
      `ws=${feed.state} restq=${client.limiter.pending} terminals=${lifecycle.terminalFetches} kyberq=${kyber.quoteCount} bebop=${bebop.enabled ? `${bebop.state}/${bebop.books.size}pairs` : 'off'}`
  );
}, 60_000);

// --- graceful shutdown ---
let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) {
    logError('second SIGINT, force exit');
    process.exit(1);
  }
  shuttingDown = true;
  log('SIGINT: shutting down...');
  feed.stop();
  engine.stop();
  kyber.stop();
  bebop.stop();
  lifecycle.stop();
  stopPollFallback();
  clearInterval(reaper);
  clearInterval(status);
  for (const s of samplers.values()) s.stop();
  refPrices.stop();
  gas.stop();
  // small delay lets in-flight synchronous writes settle
  setTimeout(() => {
    db.endRun(runId, true);
    db.checkpoint();
    db.close();
    log('shutdown complete');
    process.exit(0);
  }, 500);
});
process.on('SIGTERM', () => process.emit('SIGINT'));

log('collector running (Ctrl+C to stop)');
