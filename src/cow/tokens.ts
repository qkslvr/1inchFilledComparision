/** Decimals for any ERC20, so the solver is not limited to configured pairs.
 *
 *  Most CoW flow is not on the handful of pairs we hedge — `noPair` was the
 *  largest rejection reason by far — but Kyber quotes any pair and Bebop streams
 *  hundreds, so the only thing actually missing was the decimals needed to turn
 *  raw amounts into money.
 *
 *  Three sources, cheapest first: our own pair config, Bebop's tokenlist, then
 *  the chain. The chain call is made once per token and cached for the life of
 *  the process — token decimals do not change. */
import { config } from '../../config.js';
import { logError } from '../log.js';

const cache = new Map<string, number | null>();

/** eth_call for `decimals()`, selector 0x313ce567. */
async function decimalsOnChain(token: string): Promise<number | null> {
  try {
    const res = await fetch(config.baseRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: token, data: '0x313ce567' }, 'latest'],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: string };
    if (!body.result || body.result === '0x') return null;
    const d = Number(BigInt(body.result));
    // A token claiming more than 36 decimals is not one we can price sanely.
    return d >= 0 && d <= 36 ? d : null;
  } catch (err) {
    logError(`decimals() failed for ${token.slice(0, 10)}`, err);
    return null;
  }
}

/** Decimals from config where we have them, else Bebop's list, else the chain. */
export async function tokenDecimals(
  token: string,
  fromBebop: (t: string) => number | null
): Promise<number | null> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  for (const pair of config.pairs) {
    for (const side of [pair.base, pair.quote]) {
      if (side.addresses.some((a) => a.toLowerCase() === key)) {
        cache.set(key, side.decimals);
        return side.decimals;
      }
    }
  }
  const bebop = fromBebop(key);
  if (bebop !== null) {
    cache.set(key, bebop);
    return bebop;
  }
  const chain = await decimalsOnChain(key);
  cache.set(key, chain);
  return chain;
}

/** Value `wei` of native token in `token` atoms, using Kyber's own USD figure.
 *
 *  For a configured pair we can go through the reference book, but for an
 *  arbitrary token the only price to hand is the one the quote already carries:
 *  it reports both the output amount and what that output is worth in dollars,
 *  which together give a dollar-per-atom rate for free. */
export function weiToTokenViaUsd(
  wei: bigint,
  nativeUsdMid: bigint | undefined,
  amountOut: bigint,
  amountOutUsd6: bigint | null
): bigint | null {
  if (nativeUsdMid === undefined || amountOutUsd6 === null || amountOutUsd6 <= 0n || amountOut <= 0n) {
    return null;
  }
  // nativeUsdMid is 6dp dollars per whole native token; wei is 18dp.
  const usd6 = (wei * nativeUsdMid) / 10n ** 18n;
  return (usd6 * amountOut) / amountOutUsd6;
}
