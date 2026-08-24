import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreOf, scoreOfBuy } from '../src/cow/score.js';

/** A real fulfilled BUY order, mainnet.
 *
 *  The user capped their spend at 848,195.645849 USDT to receive exactly
 *  352.058070368794712477 ETH, and the winner settled it for 845,638.467969 —
 *  2,557.177880 USDT they did not have to part with, about 30 bps. */
const LIMIT_SELL = 848_195_645_849n; // USDT, 6dp
const LIMIT_BUY = 352_058_070_368_794_712_477n; // ETH, 18dp
const WINNER_SPENT = 845_638_467_969n;
/** USDT priced in native wei per atom, 1e18-scaled. */
const USDT_PRICE = 437_730_315_088_261_092_710_727_467n;

test('the sell-order formula reports nothing on a buy order', () => {
  // This is the bug it replaces. On a buy order the user receives exactly what
  // they asked for, so delivered - limitBuy is zero by construction — for the
  // winner and for every rival alike, which handed us a free win on all of them.
  assert.equal(
    scoreOf({ ourBuyAmount: LIMIT_BUY, limitBuyAmount: LIMIT_BUY, buyTokenPrice: USDT_PRICE }),
    0n
  );
});

test('a buy order scores the sellToken the user keeps', () => {
  const s = scoreOfBuy({
    spentSellAmount: WINNER_SPENT,
    limitSellAmount: LIMIT_SELL,
    sellTokenPrice: USDT_PRICE,
  })!;
  const saved = LIMIT_SELL - WINNER_SPENT;
  assert.equal(saved, 2_557_177_880n, 'the user kept 2,557.177880 USDT');
  assert.equal(s, (saved * USDT_PRICE) / 10n ** 18n);
  assert.ok(s > 0n, 'a real fill must not score zero');
});

test('spending more than the cap is not a worse bid, it is no bid', () => {
  // CoW would reject it outright, so it must not score negative and creep up on
  // a genuine solution in the ranking.
  assert.equal(
    scoreOfBuy({ spentSellAmount: LIMIT_SELL + 1n, limitSellAmount: LIMIT_SELL, sellTokenPrice: USDT_PRICE }),
    0n
  );
});

test('spending exactly the cap is zero surplus', () => {
  assert.equal(
    scoreOfBuy({ spentSellAmount: LIMIT_SELL, limitSellAmount: LIMIT_SELL, sellTokenPrice: USDT_PRICE }),
    0n
  );
});

test('spending less beats spending more, so the ranking is the right way round', () => {
  const tighter = scoreOfBuy({ spentSellAmount: WINNER_SPENT - 1_000_000n, limitSellAmount: LIMIT_SELL, sellTokenPrice: USDT_PRICE })!;
  const looser = scoreOfBuy({ spentSellAmount: WINNER_SPENT, limitSellAmount: LIMIT_SELL, sellTokenPrice: USDT_PRICE })!;
  assert.ok(tighter > looser);
});

test('an unpriced sell token cannot be scored', () => {
  assert.equal(
    scoreOfBuy({ spentSellAmount: WINNER_SPENT, limitSellAmount: LIMIT_SELL, sellTokenPrice: undefined }),
    null
  );
});

test('the required input for an exact output scales the quote down, conservatively', () => {
  // Quoting the full cap returns more than the user needs; we only need enough
  // to reach limitBuy. Price impact is convex, so a smaller trade gets a rate
  // at least as good — the linear estimate over-states our spend and therefore
  // under-states our surplus.
  const quotedOut = LIMIT_BUY + LIMIT_BUY / 100n; // 1% more than needed
  const requiredIn = (LIMIT_SELL * LIMIT_BUY + quotedOut - 1n) / quotedOut;
  assert.ok(requiredIn < LIMIT_SELL, 'we need less than the cap');
  // ~1% less, since we asked for ~1% less output.
  assert.ok(requiredIn > (LIMIT_SELL * 98n) / 100n);
});
