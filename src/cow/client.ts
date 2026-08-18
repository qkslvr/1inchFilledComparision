import { config } from '../../config.js';

export class CowRateLimitError extends Error {
  constructor() {
    super('CoW quote 429');
  }
}

export interface CowQuote {
  amountIn: bigint;
  /** buyAmount: proceeds in taker-asset units, ALREADY net of CoW's own fee */
  amountOut: bigint;
  /** CoW's fee, in sell-token units. Diagnostic — it is already inside amountOut. */
  feeAmount: bigint;
  /** CoW's gas estimate. Diagnostic: it does NOT enter the edge, because CoW
   *  settles the swap itself and has already charged for it in feeAmount. */
  gasUnits: bigint;
  receivedAtMs: number;
  fetchMs: number;
}

/** POST /quote for an exact-sell order.
 *
 *  `sellAmountBeforeFee` is the gross amount we hand over; CoW deducts its fee
 *  from that and returns the resulting `buyAmount`. So buyAmount is the all-in
 *  figure to compare against the other venues' proceeds, and no swap-leg gas is
 *  added on top — see SPEC-cowswap.md.
 *
 *  `from`/`receiver` must be set for the API to quote, but nothing is signed or
 *  submitted: this only ever reads a price. */
export async function fetchCowQuote(
  sellToken: string,
  buyToken: string,
  sellAmountBeforeFee: bigint
): Promise<CowQuote> {
  const started = Date.now();
  const res = await fetch(`${config.cow.apiBase}/${config.cow.chainSlug}/api/v1/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sellToken,
      buyToken,
      from: config.cow.quoteFrom,
      receiver: config.cow.quoteFrom,
      kind: 'sell',
      sellAmountBeforeFee: sellAmountBeforeFee.toString(),
    }),
    signal: AbortSignal.timeout(config.cow.quoteTimeoutMs),
  });
  if (res.status === 429) throw new CowRateLimitError();
  if (!res.ok) {
    // The API describes unroutable pairs and dust sizes in the body; keep a
    // little of it, since "no route" and "server broke" want different reactions.
    const detail = (await res.text().catch(() => '')).slice(0, 120);
    throw new Error(`CoW quote HTTP ${res.status} ${detail}`);
  }
  const body = (await res.json()) as {
    quote?: { buyAmount?: string; feeAmount?: string; gasAmount?: string };
  };
  const q = body.quote;
  if (!q?.buyAmount) throw new Error('CoW quote had no buyAmount');
  const receivedAtMs = Date.now();
  return {
    amountIn: sellAmountBeforeFee,
    amountOut: BigInt(q.buyAmount),
    feeAmount: q.feeAmount ? BigInt(q.feeAmount) : 0n,
    gasUnits: q.gasAmount ? BigInt(q.gasAmount) : 0n,
    receivedAtMs,
    fetchMs: receivedAtMs - started,
  };
}
