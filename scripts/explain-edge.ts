/** Print a worked example per venue: every component of one winning edge.
 *
 *   CHAIN=ethereum npm run explain
 *
 *  The dashboard shows a verdict and a bps figure. This shows the arithmetic
 *  behind one, so the number can be checked rather than trusted. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';
import { toFloat } from '../src/pricing/units.js';
import { VENUES } from '../src/report/outcome.js';

const db = await Db.open(config.chainId, { readonly: true, schemaOverride: config.schemaOverride });

/** Which columns carry each venue's proceeds, extra gas leg and fee. */
const COLS: Record<string, { out: string; gas: string | null; fee: string }> = {
  kalqix: { out: 'hedge_proceeds', gas: null, fee: 'fee_cost' },
  kyber: { out: 'kyber_out', gas: 'kyber_gas_cost', fee: 'kyber_fee' },
  bebop: { out: 'bebop_out', gas: 'bebop_gas_cost', fee: 'bebop_fee' },
  pancake: { out: 'pancake_out', gas: 'pancake_gas_cost', fee: 'pancake_fee' },
  // CoW settles its own swap, so it carries no separate gas leg.
  cow: { out: 'cow_out', gas: null, fee: 'cow_fee' },
};

const money = (v: bigint, d: number) =>
  toFloat(v, d).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log(`${config.chainLabel} — one winning example per venue\n`);

for (const venue of VENUES) {
  const c = COLS[venue];
  if (!c) continue;
  // The best win by margin, so the example is a clear one rather than marginal.
  const row = await db.get<Record<string, any>>(
    `SELECT d.order_hash, d.pair, d.size_usd, d.outcome, v.cls, v.margin_bps, o.direction,
            t.${c.out} AS venue_out, t.auction_cost, t.gas_cost_raw, t.notional_taker,
            t.${c.fee} AS venue_fee ${c.gas ? `, t.${c.gas} AS venue_gas` : ''}
     FROM decided_venue_outcomes v
     JOIN decided_outcomes d USING (order_hash)
     JOIN orders o USING (order_hash)
     JOIN LATERAL (SELECT * FROM ticks WHERE order_hash = v.order_hash
                     AND ${c.out} IS NOT NULL ORDER BY ts_ms LIMIT 1) t ON true
     WHERE v.venue = ? AND v.cls IN ('WIN','WIN_DEGRADED')
     ORDER BY v.margin_bps DESC NULLS LAST LIMIT 1`,
    [venue]
  );
  if (!row) {
    console.log(`${venue.toUpperCase().padEnd(9)} no winning example yet\n`);
    continue;
  }
  // Every amount is denominated in the TAKER asset — what we would have paid
  // out — and which asset that is depends on the direction. Reading them all as
  // the quote made a 0.42 USD trade print as 272 million.
  const pair = config.pairs.find((p) => p.ticker === row.pair);
  const takerIsBase = row.direction === 'BUY_BASE';
  const side = pair ? (takerIsBase ? pair.base : pair.quote) : null;
  const dec = side ? side.decimals : 6;
  const sym = side ? side.symbol : config.stableSymbol;

  const out = BigInt(row.venue_out);
  const cost = BigInt(row.auction_cost);
  const fillGas = BigInt(row.gas_cost_raw);
  const venueGas = row.venue_gas ? BigInt(row.venue_gas) : 0n;
  const fee = BigInt(row.venue_fee ?? '0');
  const notional = BigInt(row.notional_taker);
  const safety = (notional * config.safetyMarginBps + 9999n) / 10000n;
  const edge = out - cost - fillGas - venueGas - fee - safety;

  console.log(`${venue.toUpperCase()}  ${row.pair}  ${row.cls}  (order ${String(row.order_hash).slice(0, 14)}…)`);
  console.log(`  proceeds from the venue      + ${money(out, dec)} ${sym}`);
  console.log(`  paid to the order            - ${money(cost, dec)} ${sym}`);
  console.log(`  gas to settle the fill       - ${money(fillGas, dec)} ${sym}`);
  if (c.gas) console.log(`  gas for the ${venue} swap leg  - ${money(venueGas, dec)} ${sym}`);
  console.log(`  our markup fee               - ${money(fee, dec)} ${sym}`);
  console.log(`  safety margin (${config.safetyMarginBps} bps)      - ${money(safety, dec)} ${sym}`);
  console.log(`  ${'='.repeat(46)}`);
  console.log(`  edge                         = ${money(edge, dec)} ${sym}`);
  console.log(
    `  as bps of notional           = ${(Number((edge * 1_000_000n) / notional) / 100).toFixed(1)} bps` +
      `   (stored: ${row.margin_bps === null ? 'n/a' : Number(row.margin_bps).toFixed(1)} bps)`
  );
  console.log(`  trade size                   = ${row.size_usd === null ? 'n/a' : '$' + Number(row.size_usd).toFixed(2)}\n`);
}

await db.close();
