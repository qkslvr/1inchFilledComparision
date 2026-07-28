import type { OrderStatusResponse } from '@1inch/fusion-sdk';
import { config, isKyberOnlySkipped } from '../../config.js';
import type { Db } from '../db/db.js';
import type { FusionClient, ActiveOrder } from '../fusion/client.js';
import type { PricingEngine } from '../pricing/engine.js';
import type { RefPriceLoop } from '../kalqix/sampler.js';
import { decodeOrder, type DecodedOrder } from '../fusion/auction.js';
import { classifyOrder } from './eligibility.js';
import type { OrderCreatedPayload } from '../fusion/ws.js';
import { getBlockTimestampMs, getTransactionReceipt } from '../chain/rpc.js';
import { toFloat } from '../pricing/units.js';
import { log, logError } from '../log.js';

const TERMINAL_RETRY_MS = 10_000;
const TERMINAL_MAX_ATTEMPTS = 3;

/** Order state machine: created -> live (engine) -> pending-terminal -> terminal.
 *  Terminal-status fetches go through the shared 1inch rate limiter. */
export class Lifecycle {
  private stopped = false;
  terminalFetches = 0;

  constructor(
    private readonly db: Db,
    private readonly client: FusionClient,
    private readonly engine: PricingEngine,
    private readonly runId: () => number,
    private readonly refPrices: RefPriceLoop | null = null
  ) {}

  /** Rough USD size of an order from whichever leg is a token we can price.
   *  Used only to gate kyber-only tracking; null = unpriceable. */
  private estimateUsd(makerAsset: string, takerAsset: string, making: bigint, taking: bigint): number | null {
    const legUsd = (asset: string, amount: bigint): number | null => {
      const a = asset.toLowerCase();
      for (const p of config.pairs) {
        if (p.quote.addresses.includes(a)) return toFloat(amount, p.quote.decimals);
        if (p.base.addresses.includes(a)) {
          const m = this.refPrices?.latestMid.get(p.ticker);
          return m === undefined ? null : toFloat(amount, p.base.decimals) * toFloat(m.mid, p.quote.decimals);
        }
      }
      return null;
    };
    return legUsd(makerAsset, making) ?? legUsd(takerAsset, taking);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Shared entry for WS order_created, boot sweep, and poll fallback. */
  handleOrderCreated(
    payload: OrderCreatedPayload | ActiveOrder,
    receivedAtMs: number,
    source: 'ws' | 'sweep' | 'poll',
    lateSeen: boolean
  ): void {
    const { order, orderHash, extension } = payload;
    if (this.db.orderExists(orderHash)) return; // duplicate after reconnect/sweep

    const eligibility = classifyOrder(order.makerAsset, order.takerAsset);
    if (!eligibility) {
      // No KalqiX market. Sizeable orders still get Kyber-only shadow pricing
      // when a quoter slot is free; the rest are recorded for volume only.
      if (this.tryRegisterKyberOnly(payload, receivedAtMs, source, lateSeen)) return;
      this.db.insertOrder({
        orderHash,
        runId: this.runId(),
        receivedAtMs,
        source,
        lateSeen,
        makerAsset: order.makerAsset,
        takerAsset: order.takerAsset,
        makingAmount: BigInt(order.makingAmount),
        takingAmount: BigInt(order.takingAmount),
        remainingMaker: BigInt(payload.remainingMakerAmount),
        makerAddress: order.maker,
        pair: null,
        direction: null,
        hedgeAssetKind: null,
        eligible: false,
        kyberOnly: false,
        skipReason: 'unsupported_pair',
        auctionStartMs: null,
        auctionDurationS: null,
        initialRateBump: null,
        auctionPointsJson: null,
        gasBumpEstimate: null,
        gasPriceEstimate: null,
        allowPartialFills: null,
        allowMultipleFills: null,
        deadlineMs: null,
        extensionRaw: null,
        orderStructJson: null,
      });
      return;
    }

    let decoded: DecodedOrder;
    try {
      decoded = decodeOrder(order, extension);
    } catch (err) {
      logError(`extension decode failed for ${orderHash}, trying REST fallback`, err);
      void this.decodeFallback(payload, receivedAtMs, source, lateSeen);
      return;
    }
    this.registerDecoded(payload, decoded, receivedAtMs, source, lateSeen);
  }

  /** KalqiX-unsupported order: track via Kyber alone when sizeable enough and a
   *  quoter slot is free. Returns true when it was registered that way. */
  private tryRegisterKyberOnly(
    payload: OrderCreatedPayload | ActiveOrder,
    receivedAtMs: number,
    source: 'ws' | 'sweep' | 'poll',
    lateSeen: boolean
  ): boolean {
    const { order, orderHash, extension } = payload;
    if (isKyberOnlySkipped(order.makerAsset, order.takerAsset)) return false;
    const usd = this.estimateUsd(
      order.makerAsset,
      order.takerAsset,
      BigInt(order.makingAmount),
      BigInt(order.takingAmount)
    );
    if (usd === null || usd < config.kyber.unsupportedMinUsd) return false;

    let decoded: DecodedOrder;
    try {
      decoded = decodeOrder(order, extension);
    } catch {
      return false; // undecodable: fall back to the plain-unsupported path
    }
    const remaining = BigInt(payload.remainingMakerAmount);
    const registered = this.engine.register({
      orderHash,
      decoded,
      pair: null,
      direction: null,
      makerAsset: order.makerAsset,
      takerAsset: order.takerAsset,
      remainingMaker: remaining,
      allowPartialFills: decoded.allowPartialFills,
      deadlineMs: decoded.deadlineMs,
      kyberOnly: true,
      tShadowRecorded: false,
      maxEdge: null,
      tShadowKyberRecorded: false,
      maxEdgeKyber: null,
      tShadowBebopRecorded: false,
      maxEdgeBebop: null,
    });
    if (!registered) return false; // no quoter slot free

    this.db.insertOrder({
      orderHash,
      runId: this.runId(),
      receivedAtMs,
      source,
      lateSeen,
      makerAsset: order.makerAsset,
      takerAsset: order.takerAsset,
      makingAmount: BigInt(order.makingAmount),
      takingAmount: BigInt(order.takingAmount),
      remainingMaker: remaining,
      makerAddress: order.maker,
      pair: null,
      direction: null,
      hedgeAssetKind: null,
      eligible: false,
      kyberOnly: true,
      skipReason: 'unsupported_pair',
      auctionStartMs: decoded.auctionStartMs,
      auctionDurationS: decoded.auctionDurationS,
      initialRateBump: decoded.initialRateBump,
      auctionPointsJson: decoded.pointsJson,
      gasBumpEstimate: decoded.gasBumpEstimate,
      gasPriceEstimate: decoded.gasPriceEstimate,
      allowPartialFills: decoded.allowPartialFills,
      allowMultipleFills: decoded.allowMultipleFills,
      deadlineMs: decoded.deadlineMs,
      extensionRaw: extension,
      orderStructJson: JSON.stringify(order),
    });
    log(`registered ${orderHash} kyber-only ~$${usd.toFixed(0)} remaining=${remaining} (${source}${lateSeen ? ', late' : ''})`);
    return true;
  }

  /** One getOrderStatus attempt when local decode fails (should be rare). */
  private async decodeFallback(
    payload: OrderCreatedPayload | ActiveOrder,
    receivedAtMs: number,
    source: 'ws' | 'sweep' | 'poll',
    lateSeen: boolean
  ): Promise<void> {
    const { orderHash } = payload;
    try {
      const status = await this.client.getOrderStatus(orderHash);
      const decoded = decodeOrder(status.order, status.extension);
      this.registerDecoded(payload, decoded, receivedAtMs, source, lateSeen);
    } catch (err) {
      logError(`decode fallback failed for ${orderHash}, skipping`, err);
      this.insertSkipError(payload, receivedAtMs, source, lateSeen, 'decode_error');
      this.db.event(this.runId(), 'error_skip', { orderHash, reason: 'decode_error' });
    }
  }

  private insertSkipError(
    payload: OrderCreatedPayload | ActiveOrder,
    receivedAtMs: number,
    source: 'ws' | 'sweep' | 'poll',
    lateSeen: boolean,
    reason: string
  ): void {
    const { order } = payload;
    this.db.insertOrder({
      orderHash: payload.orderHash,
      runId: this.runId(),
      receivedAtMs,
      source,
      lateSeen,
      makerAsset: order.makerAsset,
      takerAsset: order.takerAsset,
      makingAmount: BigInt(order.makingAmount),
      takingAmount: BigInt(order.takingAmount),
      remainingMaker: BigInt(payload.remainingMakerAmount),
      makerAddress: order.maker,
      pair: null,
      direction: null,
      hedgeAssetKind: null,
      eligible: false,
      kyberOnly: false,
      skipReason: reason,
      auctionStartMs: null,
      auctionDurationS: null,
      initialRateBump: null,
      auctionPointsJson: null,
      gasBumpEstimate: null,
      gasPriceEstimate: null,
      allowPartialFills: null,
      allowMultipleFills: null,
      deadlineMs: null,
      extensionRaw: payload.extension,
      orderStructJson: JSON.stringify(order),
    });
  }

  private registerDecoded(
    payload: OrderCreatedPayload | ActiveOrder,
    decoded: DecodedOrder,
    receivedAtMs: number,
    source: 'ws' | 'sweep' | 'poll',
    lateSeen: boolean
  ): void {
    const { order, orderHash, extension } = payload;
    const eligibility = classifyOrder(order.makerAsset, order.takerAsset)!;
    const remaining = BigInt(payload.remainingMakerAmount);

    this.db.insertOrder({
      orderHash,
      runId: this.runId(),
      receivedAtMs,
      source,
      lateSeen,
      makerAsset: order.makerAsset,
      takerAsset: order.takerAsset,
      makingAmount: BigInt(order.makingAmount),
      takingAmount: BigInt(order.takingAmount),
      remainingMaker: remaining,
      makerAddress: order.maker,
      pair: eligibility.pair.ticker,
      direction: eligibility.direction,
      hedgeAssetKind: eligibility.hedgeAssetKind,
      eligible: true,
      kyberOnly: false,
      skipReason: null,
      auctionStartMs: decoded.auctionStartMs,
      auctionDurationS: decoded.auctionDurationS,
      initialRateBump: decoded.initialRateBump,
      auctionPointsJson: decoded.pointsJson,
      gasBumpEstimate: decoded.gasBumpEstimate,
      gasPriceEstimate: decoded.gasPriceEstimate,
      allowPartialFills: decoded.allowPartialFills,
      allowMultipleFills: decoded.allowMultipleFills,
      deadlineMs: decoded.deadlineMs,
      extensionRaw: extension,
      orderStructJson: JSON.stringify(order),
    });

    this.engine.register({
      orderHash,
      decoded,
      pair: eligibility.pair,
      direction: eligibility.direction,
      makerAsset: order.makerAsset,
      takerAsset: order.takerAsset,
      remainingMaker: remaining,
      allowPartialFills: decoded.allowPartialFills,
      deadlineMs: decoded.deadlineMs,
      kyberOnly: false,
      tShadowRecorded: false,
      maxEdge: null,
      tShadowKyberRecorded: false,
      maxEdgeKyber: null,
      tShadowBebopRecorded: false,
      maxEdgeBebop: null,
    });
    log(`registered ${orderHash} ${eligibility.pair.ticker} ${eligibility.direction} remaining=${remaining} (${source}${lateSeen ? ', late' : ''})`);
  }

  /** Re-register a non-terminal order from a DB row on boot. */
  resumeFromRow(row: Record<string, unknown>): boolean {
    const orderHash = row.order_hash as string;
    try {
      const order = JSON.parse(row.order_struct_json as string);
      const decoded = decodeOrder(order, row.extension_raw as string);
      if (row.kyber_only === 1) {
        return this.engine.register({
          orderHash,
          decoded,
          pair: null,
          direction: null,
          makerAsset: order.makerAsset,
          takerAsset: order.takerAsset,
          remainingMaker: BigInt(row.remaining_maker as string),
          allowPartialFills: decoded.allowPartialFills,
          deadlineMs: decoded.deadlineMs,
          kyberOnly: true,
          tShadowRecorded: false,
          maxEdge: null,
          tShadowKyberRecorded: row.t_shadow_kyber_ms !== null && row.t_shadow_kyber_ms !== undefined,
          maxEdgeKyber:
            row.max_edge_kyber !== null && row.max_edge_kyber !== undefined
              ? BigInt(row.max_edge_kyber as string)
              : null,
        tShadowBebopRecorded: row.t_shadow_bebop_ms !== null && row.t_shadow_bebop_ms !== undefined,
        maxEdgeBebop:
          row.max_edge_bebop !== null && row.max_edge_bebop !== undefined
            ? BigInt(row.max_edge_bebop as string)
            : null,
        });
      }
      const eligibility = classifyOrder(order.makerAsset, order.takerAsset);
      if (!eligibility) return false;
      this.engine.register({
        orderHash,
        decoded,
        pair: eligibility.pair,
        direction: eligibility.direction,
        makerAsset: order.makerAsset,
        takerAsset: order.takerAsset,
        remainingMaker: BigInt(row.remaining_maker as string),
        allowPartialFills: decoded.allowPartialFills,
        deadlineMs: decoded.deadlineMs,
        kyberOnly: false,
        tShadowRecorded: row.t_shadow_ms !== null,
        maxEdge: row.max_edge !== null ? BigInt(row.max_edge as string) : null,
        tShadowKyberRecorded: row.t_shadow_kyber_ms !== null && row.t_shadow_kyber_ms !== undefined,
        maxEdgeKyber:
          row.max_edge_kyber !== null && row.max_edge_kyber !== undefined
            ? BigInt(row.max_edge_kyber as string)
            : null,
        tShadowBebopRecorded: row.t_shadow_bebop_ms !== null && row.t_shadow_bebop_ms !== undefined,
        maxEdgeBebop:
          row.max_edge_bebop !== null && row.max_edge_bebop !== undefined
            ? BigInt(row.max_edge_bebop as string)
            : null,
      });
      return true;
    } catch (err) {
      logError(`resume failed for ${orderHash}`, err);
      this.db.markSkipError(orderHash, 'runtime_error');
      return false;
    }
  }

  handleFilled(orderHash: string, tsMs: number): void {
    if (!this.tracked(orderHash)) return;
    this.db.setActualWsTime(orderHash, tsMs);
    this.engine.unregister(orderHash);
    this.queueTerminalFetch(orderHash);
  }

  handleFilledPartially(orderHash: string, remainingMakerAmount: string, tsMs: number): void {
    if (!this.tracked(orderHash)) return;
    this.db.setActualWsTime(orderHash, tsMs); // first fill time
    const remaining = BigInt(remainingMakerAmount);
    this.db.updateRemaining(orderHash, remaining);
    this.engine.updateRemaining(orderHash, remaining);
  }

  handleCancelled(orderHash: string): void {
    if (!this.tracked(orderHash)) return;
    this.engine.unregister(orderHash);
    this.queueTerminalFetch(orderHash);
  }

  handleInvalid(orderHash: string): void {
    this.handleCancelled(orderHash);
  }

  handleBalanceChange(orderHash: string, remainingMakerAmount: string): void {
    if (!this.tracked(orderHash)) return;
    const remaining = BigInt(remainingMakerAmount);
    this.db.updateRemaining(orderHash, remaining);
    this.engine.updateRemaining(orderHash, remaining);
  }

  /** Only react to events for tracked, still-open orders (the WS feed is
   *  chain-wide; untracked unsupported orders must not consume 1inch budget).
   *  Kyber-only orders count: they need fill times for their verdicts. */
  private tracked(orderHash: string): boolean {
    if (this.engine.has(orderHash)) return true;
    const row = this.db.raw
      .prepare(
        `SELECT 1 FROM orders WHERE order_hash = ? AND (eligible = 1 OR kyber_only = 1) AND terminal_status IS NULL`
      )
      .get(orderHash);
    return row !== undefined;
  }

  queueTerminalFetch(orderHash: string, attempt = 0): void {
    if (this.stopped) return;
    void this.fetchTerminal(orderHash, attempt);
  }

  private async fetchTerminal(orderHash: string, attempt: number): Promise<void> {
    let status: OrderStatusResponse;
    try {
      status = await this.client.getOrderStatus(orderHash);
    } catch (err) {
      logError(`terminal status fetch failed for ${orderHash} (attempt ${attempt})`, err);
      if (attempt < TERMINAL_MAX_ATTEMPTS && !this.stopped) {
        setTimeout(() => this.queueTerminalFetch(orderHash, attempt + 1), TERMINAL_RETRY_MS);
      } else {
        this.db.event(this.runId(), 'error_skip', { orderHash, reason: 'status_fetch_failed' });
      }
      return;
    }
    if (this.stopped) return;

    // 'pending'/'partially-filled' right after a fill event is a race; retry.
    if ((status.status === 'pending' || status.status === 'partially-filled') && attempt < TERMINAL_MAX_ATTEMPTS) {
      setTimeout(() => this.queueTerminalFetch(orderHash, attempt + 1), TERMINAL_RETRY_MS);
      return;
    }

    let filledMaker = 0n;
    let filledTaker = 0n;
    for (const f of status.fills) {
      filledMaker += BigInt(f.filledMakerAmount);
      filledTaker += BigInt(f.filledAuctionTakerAmount);
      this.db.upsertFill(orderHash, f.txHash, f.filledMakerAmount, f.filledAuctionTakerAmount, f.takerFeeAmount);
    }
    this.db.setTerminal(orderHash, status.status, JSON.stringify(status), filledMaker, filledTaker);
    this.terminalFetches++;
    log(`terminal ${orderHash}: ${status.status}, ${status.fills.length} fills`);

    // Refine t_actual via fill block timestamps (own RPC, no 1inch budget).
    let earliest: number | null = null;
    for (const f of status.fills) {
      try {
        const receipt = await getTransactionReceipt(f.txHash);
        if (!receipt) continue;
        const tsMs = await getBlockTimestampMs(receipt.blockNumber);
        this.db.setFillBlock(orderHash, f.txHash, receipt.blockNumber, tsMs);
        if (earliest === null || tsMs < earliest) earliest = tsMs;
      } catch (err) {
        logError(`fill receipt lookup failed for ${f.txHash}`, err);
        this.db.event(this.runId(), 'rpc_error', { orderHash, txHash: f.txHash });
      }
    }
    if (earliest !== null) this.db.setActualChainTime(orderHash, earliest);
  }

  /** Orders past deadline + grace with no terminal event: fetch status directly. */
  reapExpired(nowMs: number, graceMs: number): void {
    for (const orderHash of this.engine.liveHashes()) {
      const row = this.db.raw
        .prepare(`SELECT deadline_ms FROM orders WHERE order_hash = ?`)
        .get(orderHash) as { deadline_ms: number | null } | undefined;
      const deadline = row?.deadline_ms;
      if (deadline !== null && deadline !== undefined && nowMs > deadline + graceMs) {
        log(`reaping expired ${orderHash}`);
        this.engine.unregister(orderHash);
        this.queueTerminalFetch(orderHash);
      }
    }
  }
}
