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
import { createBebopSource } from '../bebop/source.js';
import { PancakeQuoter } from '../pancake/quoter.js';
import { Lifecycle } from './lifecycle.js';
import { TokenResolver } from './tokens-job.js';
import { log, logError } from '../log.js';

const SDK_VERSION = '2.4.10';

const client = new FusionClient(); // fails fast if ONEINCH_API_KEY is missing
const db = await Db.open(config.chainId); // creates/migrates this chain's schema

const runId = await db.startRun(
  JSON.stringify(config, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  process.version,
  SDK_VERSION
);
log(`run ${runId} starting on ${config.chainLabel} (chain ${config.chainId}), schema chain_${config.chainId}`);

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
if (!config.hasKalqix) {
  log(`kalqix quotes no ${config.chainLabel} market; its columns stay empty and its book is not sampled`);
} else if (kalqixCreds()) {
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
const { fetcher: bookFetcher, source: bookSource } = config.hasKalqix
  ? await chooseBookFetcher(log)
  : { fetcher: undefined, source: 'none' };
db.event(runId, 'book_source', { source: bookSource });

// --- shared services ---
const gas = new GasPoller(
  (s) => db.insertGasSample(s.tsMs, s.gasPriceWei, s.baseFeeWei),
  () => db.event(runId, 'rpc_error', { source: 'gas_poll' })
);
const refPrices = new RefPriceLoop(db);
// No samplers on a chain KalqiX does not quote: the engine then sees no
// snapshot, leaves the kalqix tick columns null, and the venue simply reads
// "no data" rather than erroring once a second against a missing market.
// One sampler per pair that has a KalqiX market to hedge on. BNB has none, so
// BNB_USDT simply carries no KalqiX column while BTCB and ETH orders do.
const samplers = new Map<string, Sampler>(
  config.pairs.filter((p) => p.kalqix).map((p) => [p.ticker, new Sampler(p, db, () => runId, bookFetcher)])
);
const kyber = new KyberQuoter(() => db.event(runId, 'kyber_429', {}));
const bebop = createBebopSource((kind) => db.event(runId, kind, {}));
const pancake = new PancakeQuoter();
const engine = new PricingEngine(db, samplers, refPrices, gas, () => skewMs, () => runId, takerFeePpm, kyber, bebop, pancake);
const lifecycle = new Lifecycle(db, client, engine, () => runId, refPrices);
const tokenResolver = new TokenResolver(db, config.baseRpcUrl);

tokenResolver.start();
await gas.start();
await refPrices.start();
kyber.start();
pancake.start();
await bebop.start();
engine.start();

// --- boot recovery: resume non-terminal orders from previous runs ---
const openRows = await db.openOrders();
if (openRows.length > 0) {
  const lastEventTs = await db.lastRunEventTs();
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
      await lifecycle.handleOrderCreated(o, Date.now(), 'poll', true);
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
  onOrderCreated: (p, ts) => void lifecycle.handleOrderCreated(p, ts, 'ws', false),
  onOrderFilled: (h, ts) => void lifecycle.handleFilled(h, ts),
  onOrderFilledPartially: (h, rem, ts) => void lifecycle.handleFilledPartially(h, rem, ts),
  onOrderCancelled: (h) => void lifecycle.handleCancelled(h),
  onOrderInvalid: (h) => void lifecycle.handleInvalid(h),
  onBalanceChange: (h, rem) => void lifecycle.handleBalanceChange(h, rem),
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
        if (!(await db.orderExists(o.orderHash))) {
          await lifecycle.handleOrderCreated(o, Date.now(), 'sweep', true);
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
const reaper = setInterval(() => void lifecycle.reapExpired(Date.now(), config.reapGraceMs), 30_000);

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
      `ws=${feed.state} restq=${client.limiter.pending} terminals=${lifecycle.terminalFetches} kyberq=${kyber.quoteCount} pcs=${pancake.enabled ? pancake.quoteCount : 'off'} bebop=${bebop.enabled ? `${bebop.state}/${bebop.books.size}pairs` : 'off'}` +
      (db.storagePressure ? ` STORAGE-PRESSURE(${db.droppedTicks} ticks dropped)` : '')
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
  pancake.stop();
  tokenResolver.stop();
  lifecycle.stop();
  stopPollFallback();
  clearInterval(reaper);
  clearInterval(status);
  for (const s of samplers.values()) s.stop();
  refPrices.stop();
  gas.stop();
  // small delay lets in-flight writes reach the queue before it is drained
  setTimeout(() => {
    void (async () => {
      db.endRun(runId, true);
      await db.close(); // flushes the pending write batch
      log(`shutdown complete${db.writeErrors > 0 ? ` (${db.writeErrors} writes dropped)` : ''}`);
      process.exit(0);
    })();
  }, 500);
});
process.on('SIGTERM', () => process.emit('SIGINT'));

log('collector running (Ctrl+C to stop)');
