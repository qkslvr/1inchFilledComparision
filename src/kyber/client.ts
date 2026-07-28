import { config } from '../../config.js';

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

/** GET /{chain}/api/v1/routes — quote only, never builds calldata. Amounts are
 *  base-unit decimal strings; native ETH sentinel is accepted directly. */
export async function fetchKyberQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<KyberQuote> {
  const url =
    `${config.kyber.apiBase}/${config.kyber.chainSlug}/api/v1/routes` +
    `?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&gasInclude=true`;
  const started = Date.now();
  const res = await fetch(url, {
    headers: { 'x-client-id': config.kyber.clientId },
    signal: AbortSignal.timeout(config.kyber.quoteTimeoutMs),
  });
  if (res.status === 429) throw new KyberRateLimitError();
  if (!res.ok) throw new Error(`Kyber quote HTTP ${res.status}`);
  const body = (await res.json()) as {
    code?: number;
    message?: string;
    data?: { routeSummary?: { amountOut?: string; gas?: string; amountOutUsd?: string } };
  };
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
