import { config } from '../../config.js';
import { RequestBudget } from './budget.js';
import { getJson, HttpStatusError } from '../http/json.js';

export class KyberRateLimitError extends Error {
  constructor() {
    super('Kyber aggregator 429');
  }
}

export interface KyberQuote {
  amountIn: bigint;
  amountOut: bigint;
  /** route gas estimate in units from the quote itself; fallback config value if absent */
  gasUnits: bigint;
  /** quote's own USD valuation of amountOut, as USDC-style 6dp (float-derived;
   *  used for gas conversion and USD display on kyber-only orders, not core math) */
  amountOutUsd6: bigint | null;
  receivedAtMs: number;
  fetchMs: number;
}

function parseUsd6(v: string | undefined): bigint | null {
  if (v === undefined) return null;
  const f = Number(v);
  if (!Number.isFinite(f) || f <= 0) return null;
  return BigInt(Math.round(f * 1e6));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared by every caller in this process, and counted per HTTP request rather
 *  than per quote — a retry is another request as far as Kyber is concerned. */
export const kyberBudget = new RequestBudget(
  config.kyber.budgetPerWindow,
  config.kyber.budgetWindowMs
);

export class KyberBudgetExhausted extends Error {
  constructor() {
    super('kyber budget exhausted');
  }
}

/** GET /{chain}/api/v1/routes — quote only, never builds calldata. Amounts are
 *  base-unit decimal strings; native ETH sentinel is accepted directly.
 *
 *  `retries` defaults to none. The Fusion collector re-quotes every 2s anyway,
 *  so a 429 there costs one tick out of hundreds and retrying would only add
 *  load to the thing that just rate-limited us. A one-shot caller — the CoW
 *  resolver, which gets exactly one chance at each settled trade — has the
 *  opposite trade-off: giving up writes a permanent "no data". */
export async function fetchKyberQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  opts: { retries?: number } = {}
): Promise<KyberQuote> {
  const retries = opts.retries ?? 0;
  for (let attempt = 0; ; attempt++) {
    if (!kyberBudget.take()) throw new KyberBudgetExhausted();
    try {
      return await quoteOnce(tokenIn, tokenOut, amountIn);
    } catch (err) {
      // Only back off for the transient shapes. An unusable quote or a 4xx that
      // is not 429 will fail identically next time.
      const transient =
        err instanceof KyberRateLimitError ||
        (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'));
      if (!transient || attempt >= retries) throw err;
      await sleep(400 * 3 ** attempt);
    }
  }
}

async function quoteOnce(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<KyberQuote> {
  const url =
    `${config.kyber.apiBase}/${config.kyber.chainSlug}/api/v1/routes` +
    `?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&gasInclude=true`;
  const started = Date.now();
  // Node's fetch is refused by Kyber's edge the same way CoW's refuses it — the
  // app saw a steady stream of 429s while curl from the same host had 28 of its
  // 30 requests still on the clock. See src/http/json.ts.
  let body: {
    code?: number;
    message?: string;
    data?: { routeSummary?: { amountOut?: string; gas?: string; amountOutUsd?: string } };
  };
  try {
    body = await getJson(url, config.kyber.quoteTimeoutMs, { 'x-client-id': config.kyber.clientId });
  } catch (err) {
    if (err instanceof HttpStatusError && err.status === 429) throw new KyberRateLimitError();
    throw err;
  }
  const rs = body.data?.routeSummary;
  if (!rs?.amountOut) {
    throw new Error(`Kyber quote unusable: code=${body.code} message=${body.message}`);
  }
  const receivedAtMs = Date.now();
  return {
    amountIn,
    amountOut: BigInt(rs.amountOut),
    gasUnits: rs.gas ? BigInt(rs.gas) : config.kyber.fallbackGasUnits,
    amountOutUsd6: parseUsd6(rs.amountOutUsd),
    receivedAtMs,
    fetchMs: receivedAtMs - started,
  };
}
