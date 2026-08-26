/** A CoW order as its owner signed it.
 *
 *  The competition feed reports what the winner *executed*, never the limit that
 *  had to be beaten — so surplus, and therefore any score, is uncomputable from
 *  it alone. This endpoint is public and supplies the missing half. */
import { config } from '../../config.js';
import { logError } from '../log.js';
import { awaitPollSlot } from './pollgate.js';
import { cowGetJsonOrNull } from './http.js';

const ORDERS = `${config.cow.apiBase}/${config.cow.chainSlug}/api/v1/orders`;

export interface CowSignedOrder {
  uid: string;
  owner: string;
  sellToken: string;
  buyToken: string;
  /** the amounts the user signed — the limit, not an execution */
  sellAmount: bigint;
  buyAmount: bigint;
  kind: 'sell' | 'buy';
  validToMs: number;
  partiallyFillable: boolean;
  status: string;
  createdAtMs: number;
}

export async function fetchSignedOrder(uid: string): Promise<CowSignedOrder | null> {
  // Shares the host's CoW budget with the auction polls, and waits its turn
  // rather than being dropped: a skipped poll costs nothing because another
  // follows, but a skipped lookup loses that order for good.
  if (!(await awaitPollSlot(config.cow.sharedPollMinIntervalMs, config.cow.lookupMaxWaitMs))) {
    return null;
  }
  try {
    const o = await cowGetJsonOrNull<Record<string, string | boolean | undefined>>(
      `${ORDERS}/${uid}`,
      12_000
    );
    if (!o) return null;
    if (!o.sellToken || !o.buyToken || !o.sellAmount || !o.buyAmount) return null;
    return {
      uid,
      owner: String(o.owner ?? '').toLowerCase(),
      sellToken: String(o.sellToken).toLowerCase(),
      buyToken: String(o.buyToken).toLowerCase(),
      sellAmount: BigInt(String(o.sellAmount)),
      buyAmount: BigInt(String(o.buyAmount)),
      kind: o.kind === 'buy' ? 'buy' : 'sell',
      validToMs: Number(o.validTo ?? 0) * 1000,
      partiallyFillable: o.partiallyFillable === true,
      status: String(o.status ?? ''),
      createdAtMs: o.creationDate ? Date.parse(String(o.creationDate)) : 0,
    };
  } catch (err) {
    logError(`cow order lookup failed for ${uid.slice(0, 12)}`, err);
    return null;
  }
}
