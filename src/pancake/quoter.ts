/** PancakeSwap V3 quotes, per live order.
 *
 *  Unlike Kyber this is not an HTTP aggregator but an on-chain QuoterV2 read, so
 *  there is no API key, no shared rate budget and no 429 to back off from — only
 *  the RPC endpoint's own limits. That also means it prices a single venue's
 *  pools rather than a route across many, which is the point: it answers "what
 *  would PancakeSwap alone have paid" next to Kyber's best-of-everything.
 *
 *  quoteExactInputSingle reverts when a pool for the tier doesn't exist or can't
 *  absorb the size, so every tier is tried and the best fill wins. The winning
 *  tier is recorded because it is diagnostic: a large order falling back from
 *  the 0.05% pool to 1% is the depth story, not a pricing one.
 */
import { config } from '../../config.js';
import { ethCall } from '../chain/rpc.js';
import { logError } from '../log.js';

/** quoteExactInputSingle((address,address,uint256,uint24,uint160)) */
const QUOTE_SELECTOR = '0xc6a5026a';

export interface PancakeQuote {
  amountIn: bigint;
  amountOut: bigint;
  /** fee tier that produced the best fill, in hundredths of a bip */
  fee: number;
  /** QuoterV2 also returns a gas estimate; kept for the swap-leg cost */
  gasUnits: bigint;
  receivedAtMs: number;
}

interface Tracked {
  tokenIn: string;
  tokenOut: string;
  amount: () => bigint;
  inFlight: boolean;
}

const pad = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0').toLowerCase();

/** One tier's quote. Null covers both "no such pool" and "not enough
 *  liquidity", which the contract reports the same way: by reverting. */
async function quoteTier(
  quoter: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
  rpcUrl: string
): Promise<{ out: bigint; gasUnits: bigint } | null> {
  const data =
    QUOTE_SELECTOR +
    pad(tokenIn) +
    pad(tokenOut) +
    pad(amountIn.toString(16)) +
    pad(fee.toString(16)) +
    pad('0');
  try {
    const res = await ethCall(quoter, data, rpcUrl);
    if (!res || res.length < 66) return null;
    const out = BigInt(res.slice(0, 66));
    if (out <= 0n) return null;
    // QuoterV2 returns (amountOut, sqrtPriceX96After, initializedTicksCrossed,
    // gasEstimate); the gas estimate is the fourth word.
    const gasUnits = res.length >= 258 ? BigInt('0x' + res.slice(194, 258)) : 0n;
    return { out, gasUnits: gasUnits > 0n ? gasUnits : config.kyber.fallbackGasUnits };
  } catch {
    return null;
  }
}

/** Spot price of one whole `base` in `quote` units, best tier wins.
 *
 *  On a chain with no KalqiX market there is no order book to take a mid from,
 *  and gas still has to be converted from the native asset into the taker's
 *  asset. A one-unit swap quote is not a true mid — it carries the pool fee and
 *  a tick of slippage — but it is only ever used to value gas, where a few bps
 *  on a sub-cent figure changes nothing. */
export async function pancakeSpot(
  base: string,
  quote: string,
  baseDecimals: number
): Promise<bigint | null> {
  if (config.pancakeQuoter === null) return null;
  const one = 10n ** BigInt(baseDecimals);
  const results = await Promise.all(
    config.pancakeFees.map((fee) =>
      quoteTier(config.pancakeQuoter!, base, quote, one, fee, config.baseRpcUrl)
    )
  );
  let best: bigint | null = null;
  for (const r of results) if (r && (best === null || r.out > best)) best = r.out;
  return best;
}

export class PancakeQuoter {
  readonly latest = new Map<string, PancakeQuote>();
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  quoteCount = 0;

  get enabled(): boolean {
    return config.pancakeQuoter !== null && config.pancakeFees.length > 0;
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => this.pollAll(), config.kyber.quoteIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  track(orderHash: string, tokenIn: string, tokenOut: string, amount: () => bigint): void {
    if (!this.enabled) return;
    this.tracked.set(orderHash, { tokenIn, tokenOut, amount, inFlight: false });
    void this.poll(orderHash);
  }

  untrack(orderHash: string): void {
    this.tracked.delete(orderHash);
    this.latest.delete(orderHash);
  }

  private pollAll(): void {
    if (this.stopped) return;
    for (const hash of this.tracked.keys()) void this.poll(hash);
  }

  private async poll(orderHash: string): Promise<void> {
    const t = this.tracked.get(orderHash);
    if (!t || t.inFlight || this.stopped) return;
    const amountIn = t.amount();
    if (amountIn <= 0n) return;
    t.inFlight = true;
    try {
      // Native BNB has no pool; the wrapped token is what trades.
      const tokenIn = this.wrapped(t.tokenIn);
      const tokenOut = this.wrapped(t.tokenOut);
      const results = await Promise.all(
        config.pancakeFees.map(async (fee) => ({
          fee,
          r: await quoteTier(config.pancakeQuoter!, tokenIn, tokenOut, amountIn, fee, config.baseRpcUrl),
        }))
      );
      let best: PancakeQuote | null = null;
      for (const { fee, r } of results) {
        if (r && (best === null || r.out > best.amountOut)) {
          best = { amountIn, amountOut: r.out, fee, gasUnits: r.gasUnits, receivedAtMs: Date.now() };
        }
      }
      if (best && !this.stopped && this.tracked.has(orderHash)) {
        this.latest.set(orderHash, best);
        this.quoteCount++;
      }
    } catch (err) {
      logError(`pancake quote failed for ${orderHash}`, err);
    } finally {
      t.inFlight = false;
    }
  }

  private wrapped(addr: string): string {
    const a = addr.toLowerCase();
    return a === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? config.wethAddress : a;
  }
}
