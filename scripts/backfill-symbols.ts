/** Fill sell_symbol / buy_symbol on orders written before those columns existed.
 *
 *   CHAIN=cowswapSolver npx tsx scripts/backfill-symbols.ts
 *
 *  The overview classifies each auction as BTC, ETH, stable-to-stable or other
 *  by symbol, so without this the percentages are computed over whatever handful
 *  of rows happen to post-date the change — which reads as a share of everything
 *  and is not. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';
import { tokenSymbol } from '../src/cow/tokens.js';
import { log } from '../src/log.js';

const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });

const rows = await db.all<{ order_hash: string; maker_asset: string; taker_asset: string }>(
  `SELECT order_hash, maker_asset, taker_asset FROM orders
   WHERE sell_symbol IS NULL OR buy_symbol IS NULL`
);
log(`${rows.length} orders need symbols`);

// One lookup per distinct token, not per order: a few hundred addresses cover
// thousands of rows, and tokenSymbol caches within the process anyway.
const addresses = [...new Set(rows.flatMap((r) => [r.maker_asset, r.taker_asset]))];
log(`${addresses.length} distinct tokens to resolve`);
const symbols = new Map<string, string | null>();
let done = 0;
for (const a of addresses) {
  symbols.set(a.toLowerCase(), await tokenSymbol(a));
  if (++done % 50 === 0) log(`  resolved ${done}/${addresses.length}`);
}

let updated = 0;
for (const r of rows) {
  const sell = symbols.get(r.maker_asset.toLowerCase()) ?? null;
  const buy = symbols.get(r.taker_asset.toLowerCase()) ?? null;
  if (sell === null && buy === null) continue;
  await db.all(`UPDATE orders SET sell_symbol = ?, buy_symbol = ? WHERE order_hash = ?`, [
    sell,
    buy,
    r.order_hash,
  ]);
  updated++;
}
log(`updated ${updated} orders`);
await db.close();
process.exit(0);
