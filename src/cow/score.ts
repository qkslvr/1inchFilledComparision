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

/** How far our score sat from the winner's, in bps of the winner's score.
 *
 *  Positive means we were ahead. Expressed against the winner rather than
 *  against notional so it reads on the same axis as the ranking itself. */
export function scoreMarginBps(ourScore: bigint, winnerScore: bigint): number | null {
  if (winnerScore <= 0n) return null;
  return Number(((ourScore - winnerScore) * 10_000n) / winnerScore);
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
