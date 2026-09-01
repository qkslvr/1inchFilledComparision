/** Scoring a solution the way CoW scores one.
 *
 *  CoW ranks solvers by *score*: the surplus a solution delivers over the user's
 *  signed limit, valued in the chain's native token at the auction's own price
 *  vector. Reproducing it is what turns "a venue would have paid more" into
 *  "we would have outbid the winner" — the former is a price observation, the
 *  latter is a competitive claim, and only the second one is a business.
 *
 *  Verified against live auction 13627568: a winner delivering 34,771,618 USDT
 *  of surplus reported a score of 15,783,041,052,922,804 wei, and this arrives
 *  at 15,220,591,303,268,651 — 96.4%. The residual is almost certainly the
 *  order's protocolFees policy, which we do not yet apply, so a score computed
 *  here is slightly conservative and a win claimed near the margin is not safe.
 *  See SPEC-cowswap-solver.md. */

/** Prices are native wei per token atom, scaled by 1e18. */
const PRICE_SCALE = 10n ** 18n;

/** Which side of the trade the surplus lands on.
 *
 *  A SELL order fixes what the user gives and floors what they receive, so any
 *  improvement arrives as extra buyToken. A BUY order fixes what they receive
 *  and caps what they spend, so the improvement is sellToken they did not have
 *  to part with. Same idea, opposite side — and using the sell-order formula on
 *  a buy order yields exactly zero for everyone, because executedBuyAmount
 *  equals buyAmount by construction. */
export interface BuyScoreInput {
  /** what we (or a rival) would actually spend to fill it */
  spentSellAmount: bigint;
  /** the most the user agreed to spend */
  limitSellAmount: bigint;
  /** auction price for the sell token, since that is what is saved */
  sellTokenPrice: bigint | undefined;
}

/** Scale a limit to the portion of the order actually being filled.
 *
 *  A partially fillable order's limit covers the whole amount, so a solver
 *  filling 1.8% of it must only clear 1.8% of the floor. Comparing their
 *  absolute delivery against the whole-order limit makes every partial fill look
 *  like a failure — and makes anyone quoting the full size look spectacular.
 *
 *  Observed on a live order: rivals filled 1.8% at 0.00047 wstETH per EURe and
 *  scored zero; we quoted the full size at 0.00038 — a 19% WORSE price — and
 *  scored $8,595. The comparison did not just misprice, it inverted. */
export function proRataLimit(limitBuy: bigint, filledSell: bigint, limitSell: bigint): bigint {
  if (limitSell <= 0n) return limitBuy;
  return (limitBuy * filledSell) / limitSell;
}

/** Restate an offer at a common fill size, so two solvers are compared on rate.
 *
 *  A solver taking 1.8% of an order and one quoting the whole of it are not
 *  comparable in absolute terms — the second wins on volume no matter how much
 *  worse its price. Scaling both to the size that actually settled reduces the
 *  comparison to price per unit, which is the only part we can honestly claim.
 *
 *  Linear scaling is conservative for us: a smaller trade gets a better rate
 *  than a larger one, so applying our full-size rate to a small slice understates
 *  what we would really have achieved. */
export function atFillSize(offered: bigint, offeredFor: bigint, referenceSize: bigint): bigint | null {
  if (offeredFor <= 0n) return null;
  return (offered * referenceSize) / offeredFor;
}

/** Surplus on a BUY order: sellToken the user keeps, valued in native. */
export function scoreOfBuy({ spentSellAmount, limitSellAmount, sellTokenPrice }: BuyScoreInput): bigint | null {
  if (sellTokenPrice === undefined) return null;
  const saved = limitSellAmount - spentSellAmount;
  if (saved <= 0n) return 0n;
  return (saved * sellTokenPrice) / PRICE_SCALE;
}

export interface ScoreInput {
  /** what our bid would deliver to the user, in buyToken atoms */
  ourBuyAmount: bigint;
  /** the least the user signed for, in buyToken atoms */
  limitBuyAmount: bigint;
  /** auction price for the buy token */
  buyTokenPrice: bigint | undefined;
}

/** Surplus over the signed limit, in native wei. Null when the auction did not
 *  price the token — scoring it against anything else would invent a number. */
export function scoreOf({ ourBuyAmount, limitBuyAmount, buyTokenPrice }: ScoreInput): bigint | null {
  if (buyTokenPrice === undefined) return null;
  const surplus = ourBuyAmount - limitBuyAmount;
  // A solution that fails to clear the user's limit is not a worse bid, it is
  // not a bid: CoW would never accept it, so it must not be scored as negative.
  if (surplus <= 0n) return 0n;
  return (surplus * buyTokenPrice) / PRICE_SCALE;
}

/** How far our bid sat from the best rival's, in bps **of the trade's value**.
 *
 *  Expressing it against the rival's score — the obvious reading of "margin" —
 *  is unusable, because a rival's surplus is frequently near zero: 60 of 189
 *  rivals scored exactly 0 and another 26 scored under a tenth of ours. Dividing
 *  by that produced +6,185,770,007 bps on the dashboard.
 *
 *  Against the notional it is bounded, comparable between orders, and means
 *  something plain: how much more of the trade's value we would have handed the
 *  user than the best rival did. */
export function scoreMarginBps(
  ourScore: bigint,
  rivalScore: bigint,
  notionalNative: bigint
): number | null {
  if (notionalNative <= 0n) return null;
  // Scale before converting, not after. Bigint division truncates toward zero,
  // so dividing first collapsed every margin under 1 bps to exactly 0 in both
  // directions — 112 rows, one of them $34.26 of real edge on a $628k order,
  // recorded as no edge at all. Carrying four extra digits through the integer
  // division keeps four decimal places of bps, which is well inside the
  // precision the scores themselves have.
  const scaled = ((ourScore - rivalScore) * 100_000_000n) / notionalNative;
  return Number(scaled) / 10_000;
}

/** The order's value in native wei, which is what the margin is a fraction of. */
export function notionalNative(limitBuyAmount: bigint, buyTokenPrice: bigint | undefined): bigint | null {
  if (buyTokenPrice === undefined) return null;
  return (limitBuyAmount * buyTokenPrice) / PRICE_SCALE;
}

/** Did our bid beat the winner's?
 *
 *  Strictly greater: matching the winning score does not win an auction, and
 *  counting a tie as a victory is the kind of optimism that makes a backtest
 *  useless. */
export function wouldHaveWon(ourScore: bigint | null, winnerScore: bigint | null): boolean {
  if (ourScore === null || winnerScore === null) return false;
  return ourScore > winnerScore;
}
