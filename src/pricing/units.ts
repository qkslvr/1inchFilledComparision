/** Fixed-point bigint helpers. Rounding discipline: proceeds floored, costs ceiled
 *  (always against the shadow resolver). */

export function mulDivFloor(a: bigint, b: bigint, den: bigint): bigint {
  return (a * b) / den;
}

export function mulDivCeil(a: bigint, b: bigint, den: bigint): bigint {
  return (a * b + den - 1n) / den;
}

export function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** bps of a notional, ceiled (it is always a cost in this codebase). */
export function bpsOfCeil(amount: bigint, bps: bigint): bigint {
  return mulDivCeil(amount, bps, 10_000n);
}

/** parts-per-million of an amount, ceiled (KalqiX fees are quoted in ppm). */
export function ppmOfCeil(amount: bigint, ppm: bigint): bigint {
  return mulDivCeil(amount, ppm, 1_000_000n);
}

/** Format base units as a human-readable decimal string. Display only. */
export function fmtUnits(amount: bigint, decimals: number, maxFrac = 6): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const den = pow10(decimals);
  const whole = abs / den;
  const frac = (abs % den).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Base-unit amount -> float in whole units. Display/stats only. */
export function toFloat(amount: bigint, decimals: number): number {
  return Number(amount) / Number(pow10(decimals));
}

/** quote proceeds of selling `qtyBase` at `price` (quote units per whole base), floored. */
export function quoteForBaseFloor(qtyBase: bigint, price: bigint, baseDecimals: number): bigint {
  return mulDivFloor(qtyBase, price, pow10(baseDecimals));
}

/** quote cost of acquiring `qtyBase` at `price`, ceiled. */
export function quoteForBaseCeil(qtyBase: bigint, price: bigint, baseDecimals: number): bigint {
  return mulDivCeil(qtyBase, price, pow10(baseDecimals));
}

/** base received for spending `quoteAmount` at `price`, floored. */
export function baseForQuoteFloor(quoteAmount: bigint, price: bigint, baseDecimals: number): bigint {
  return mulDivFloor(quoteAmount, pow10(baseDecimals), price);
}

/** base equivalent of a `quoteAmount` cost at `price`, ceiled (cost conversions). */
export function baseForQuoteCeil(quoteAmount: bigint, price: bigint, baseDecimals: number): bigint {
  return mulDivCeil(quoteAmount, pow10(baseDecimals), price);
}

/** Move a fixed-point amount between decimal scales, flooring on the way down.
 *  Chains disagree about their stables — 6dp USDC on Ethereum, 18dp USDT on BNB
 *  Chain — so anything stored under a fixed convention has to be normalised. */
export function rescale(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  return fromDecimals > toDecimals
    ? amount / 10n ** BigInt(fromDecimals - toDecimals)
    : amount * 10n ** BigInt(toDecimals - fromDecimals);
}
