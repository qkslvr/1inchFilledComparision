/** Pure float depth-walk over Bebop stream levels. Levels arrive as alternating
 *  [price, size, price, size, ...] float32 pairs, best-first, in HUMAN units
 *  (price = quote per base, size = base amount; verified in the live smoke).
 *  Float math is acceptable here: the stream itself is float32 (~7 significant
 *  digits), well inside bps-level measurement tolerance. */

/** Sell `amountBase` of base into the bids. Returns quote proceeds, or null
 *  when the streamed depth cannot absorb the full size. */
export function walkSellBaseFloat(bids: number[], amountBase: number): number | null {
  let remaining = amountBase;
  let proceeds = 0;
  for (let i = 0; i + 1 < bids.length && remaining > 0; i += 2) {
    const price = bids[i]!;
    const size = bids[i + 1]!;
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(remaining, size);
    proceeds += take * price;
    remaining -= take;
  }
  return remaining > 1e-12 * amountBase ? null : proceeds;
}

/** Spend `amountQuote` of quote into the asks, buying base. Returns base
 *  received, or null when depth cannot absorb the full spend. */
export function walkBuyBaseFloat(asks: number[], amountQuote: number): number | null {
  let remaining = amountQuote;
  let received = 0;
  for (let i = 0; i + 1 < asks.length && remaining > 0; i += 2) {
    const price = asks[i]!;
    const size = asks[i + 1]!;
    if (!(price > 0) || !(size > 0)) continue;
    const levelQuote = size * price;
    const spend = Math.min(remaining, levelQuote);
    received += spend / price;
    remaining -= spend;
  }
  return remaining > 1e-12 * amountQuote ? null : received;
}
