/** Restates partial fills that were scored against the whole order.
 *
 *   CHAIN=cicada npx tsx scripts/backfill-partial-fills.ts [--apply]
 *
 *  Before the fix, a partially fillable order was scored as if we had filled all
 *  of it, while rivals were judged against the whole limit for the slice they
 *  actually took — so they scored zero and we looked unbeatable. One EURe/wstETH
 *  order carried $8,595 of surplus on an $11,585 trade: 7,420 bps, on a fill of
 *  1.8% at a rate 19% worse than the rival's.
 *
 *  The correction is the one already applied going forward: restate both sides at
 *  the size that actually settled. Our surplus scales exactly with the fill
 *  fraction, since our quote and the limit both scale by it —
 *
 *      (our_bid_out - limit_buy) * ref / limit_sell
 *
 *  — while rivals have to be rebuilt from the amounts they offered.
 *
 *  Only rows with no stored buy_token_price are touched: those are exactly the
 *  pre-fix rows, and the price is recovered by inverting the old whole-order
 *  score, which is only valid for a score that formula produced. Rows scoring
 *  zero cannot be inverted, but they also carry no surplus, so the totals close.
 *
 *  Dry run by default. Pass --apply to write. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';
import { atFillSize, proRataLimit, scoreOf } from '../src/cow/score.js';
import { recomputeBatchVerdicts } from '../src/cow/batchverdict.js';

const apply = process.argv.includes('--apply');
/** One-time repair for rows corrected by an earlier run that did not yet store
 *  the price. Their score is already on the fill-size basis, so the price comes
 *  from that basis instead — writing it takes them out of the selection above
 *  and stops a re-run from scaling them a second time. */
const seal = process.argv.includes('--seal');
const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });
const big = (s: string | null): bigint => BigInt(s ?? '0');

const rows = await db.all<{
  order_hash: string; pair: string; order_kind: string;
  our_bid_out: string; limit_buy: string; limit_sell: string;
  our_score: string; surplus_usd: number | null; edge_usd: number | null; ref: string; won: number;
}>(`
  SELECT o.order_hash, o.pair, o.order_kind,
         o.our_bid_out, o.limit_buy_amount AS limit_buy, o.limit_sell_amount AS limit_sell,
         o.our_score, o.surplus_usd, o.edge_usd, o.won,
         b.sell_amount AS ref
  FROM orders o
  JOIN solution_bids b ON b.order_hash = o.order_hash AND b.is_winner = 1
  WHERE o.partially_fillable = 1
    AND o.resolved_at_ms IS NOT NULL
    AND o.buy_token_price IS NULL
    AND o.our_bid_out IS NOT NULL
    AND b.sell_amount::numeric < o.limit_sell_amount::numeric
  ORDER BY o.surplus_usd DESC NULLS LAST`);

console.log(`${config.chainLabel}: ${rows.length} partial fill(s) scored at whole-order size\n`);

let surplusWas = 0, surplusNow = 0, fixed = 0, skippedZero = 0, skippedBuy = 0;

for (const r of rows) {
  surplusWas += r.surplus_usd ?? 0;

  const ourOut = big(r.our_bid_out);
  const limitBuy = big(r.limit_buy);
  const limitSell = big(r.limit_sell);
  const ref = big(r.ref);
  const oldScore = big(r.our_score);

  if (r.order_kind !== 'sell') { skippedBuy++; surplusNow += r.surplus_usd ?? 0; continue; }

  if (seal) {
    const owedS = proRataLimit(limitBuy, ref, limitSell);
    const ourAtRefS = atFillSize(ourOut, limitSell, ref);
    if (oldScore <= 0n || ourAtRefS === null || ourAtRefS <= owedS) { skippedZero++; continue; }
    const priceS = (oldScore * 10n ** 18n) / (ourAtRefS - owedS);
    console.log(`  seal ${r.order_hash.slice(0, 10)} ${r.pair.padEnd(20)} price ${priceS}`);
    if (apply) {
      await db.all(`UPDATE orders SET buy_token_price = $1 WHERE order_hash = $2`,
        [priceS.toString(), r.order_hash]);
    }
    fixed++;
    surplusNow += r.surplus_usd ?? 0;
    continue;
  }
  // Zero score cannot be inverted for a price — and carries no surplus either,
  // so leaving it costs the totals nothing.
  if (oldScore <= 0n || ourOut <= limitBuy) { skippedZero++; surplusNow += r.surplus_usd ?? 0; continue; }

  // The auction's buy-token price, recovered from the score it produced, and the
  // USD-per-native rate from the surplus that score was converted into.
  const price = (oldScore * 10n ** 18n) / (ourOut - limitBuy);
  const usdPerScoreWei = (r.surplus_usd ?? 0) / (Number(oldScore) / 1e18);

  const owed = proRataLimit(limitBuy, ref, limitSell);
  const ourAtRef = atFillSize(ourOut, limitSell, ref);
  if (ourAtRef === null) { skippedZero++; surplusNow += r.surplus_usd ?? 0; continue; }
  const newScore = scoreOf({ ourBuyAmount: ourAtRef, limitBuyAmount: owed, buyTokenPrice: price }) ?? 0n;

  // Rivals, restated at the same size — this is the half that used to read zero.
  const bids = await db.all<{ solver: string; buy_amount: string; sell_amount: string; score: string }>(
    `SELECT solver, buy_amount, sell_amount, score FROM solution_bids WHERE order_hash = $1`,
    [r.order_hash]
  );
  let bestRival = 0n;
  const rivalUpdates: Array<[string, string]> = [];
  for (const b of bids) {
    const theirAtRef = atFillSize(big(b.buy_amount), big(b.sell_amount), ref);
    if (theirAtRef === null) continue;
    const s = scoreOf({ ourBuyAmount: theirAtRef, limitBuyAmount: owed, buyTokenPrice: price }) ?? 0n;
    rivalUpdates.push([b.solver, s.toString()]);
    if (s > bestRival) bestRival = s;
  }

  const newSurplus = (Number(newScore) / 1e18) * usdPerScoreWei;
  const newEdge = (Number(newScore - bestRival) / 1e18) * usdPerScoreWei;
  surplusNow += newSurplus;
  fixed++;

  const fillPct = (100 * Number(ref)) / Number(limitSell);
  console.log(
    `  ${r.order_hash.slice(0, 10)} ${r.pair.padEnd(20)} fill ${fillPct.toFixed(2)}%  ` +
      `surplus $${(r.surplus_usd ?? 0).toFixed(2)} -> $${newSurplus.toFixed(2)}   ` +
      `edge $${(r.edge_usd ?? 0).toFixed(2)} -> $${newEdge.toFixed(2)}` +
      (r.won === 1 && newScore <= bestRival ? '   [was a win, now a loss]' : '')
  );

  if (apply) {
    await db.all(
      // Storing the recovered price is what makes this safe to re-run. The row
      // is selected by `buy_token_price IS NULL`, and the price is inverted from
      // a score the OLD formula produced — so a second pass over an already
      // corrected row would invert the new score against the old basis and
      // shrink it by the fill fraction all over again.
      `UPDATE orders SET our_score = $1, surplus_usd = $2, edge_usd = $3,
         best_rival_score = $4, won = $5, buy_token_price = $6 WHERE order_hash = $7`,
      [newScore.toString(), newSurplus, newEdge, bestRival.toString(),
       newScore > bestRival ? 1 : 0, price.toString(), r.order_hash]
    );
    for (const [solver, s] of rivalUpdates) {
      await db.all(`UPDATE solution_bids SET score = $1 WHERE order_hash = $2 AND solver = $3`,
        [s, r.order_hash, solver]);
    }
  }
}

console.log(
  `\n  restated ${fixed}, left ${skippedZero} zero-score and ${skippedBuy} buy order(s) alone\n` +
    `  surplus on these rows: $${surplusWas.toFixed(0)} -> $${surplusNow.toFixed(0)}`
);

if (apply) {
  const v = await recomputeBatchVerdicts(db);
  console.log(`\n  verdicts rerun: ${v.decided} decided, ${v.demoted} demoted, ${v.promoted} promoted`);
  const t = await db.get<{ surplus: number }>(
    `SELECT sum(surplus_usd) AS surplus FROM orders WHERE resolved_at_ms IS NOT NULL`);
  console.log(`  dataset surplus now $${Number(t?.surplus ?? 0).toFixed(0)}`);
} else {
  console.log('\n  dry run — pass --apply to write');
}

await db.close();
