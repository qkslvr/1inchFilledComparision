import type { BookLevel, ParsedBook, WalkResult } from '../types.js';
import { baseForQuoteFloor, quoteForBaseCeil, quoteForBaseFloor } from '../pricing/units.js';

export function bestBid(book: ParsedBook): bigint | null {
  return book.bids[0]?.price ?? null;
}

export function bestAsk(book: ParsedBook): bigint | null {
  return book.asks[0]?.price ?? null;
}

/** Mid price in quote units per whole base; null on a one-sided/empty book. */
export function mid(book: ParsedBook): bigint | null {
  const bb = bestBid(book);
  const ba = bestAsk(book);
  if (bb === null || ba === null) return null;
  return (bb + ba) / 2n;
}

export function depthBase(levels: BookLevel[]): bigint {
  let total = 0n;
  for (const l of levels) total += l.qty;
  return total;
}

/** Sell `qtyBase` base into the bids. Proceeds in quote units, floored per level.
 *  proceeds === null when the book cannot absorb the full size. */
export function walkSellBase(bids: BookLevel[], qtyBase: bigint, baseDecimals: number): WalkResult {
  let remaining = qtyBase;
  let proceeds = 0n;
  for (const level of bids) {
    if (remaining <= 0n) break;
    const take = remaining < level.qty ? remaining : level.qty;
    proceeds += quoteForBaseFloor(take, level.price, baseDecimals);
    remaining -= take;
  }
  if (remaining > 0n) return { proceeds: null, consumed: qtyBase - remaining };
  return { proceeds, consumed: qtyBase };
}

/** Spend `spendQuote` quote into the asks, buying base. Base received floored,
 *  full-level costs ceiled (against ourselves). proceeds === null when the book
 *  cannot absorb the full spend. */
export function walkBuyBase(asks: BookLevel[], spendQuote: bigint, baseDecimals: number): WalkResult {
  let remaining = spendQuote;
  let received = 0n;
  for (const level of asks) {
    if (remaining <= 0n) break;
    const levelCost = quoteForBaseCeil(level.qty, level.price, baseDecimals);
    if (levelCost <= remaining) {
      received += level.qty;
      remaining -= levelCost;
    } else {
      received += baseForQuoteFloor(remaining, level.price, baseDecimals);
      remaining = 0n;
    }
  }
  if (remaining > 0n) return { proceeds: null, consumed: spendQuote - remaining };
  return { proceeds: received, consumed: spendQuote };
}
