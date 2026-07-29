/** Side-by-side WETH/USDC rate comparison on Base across four venues.
 *
 *   npm run compare              # default sizes 25 / 100 / 500 / 2000 USD
 *   npm run compare -- 50 5000   # custom sizes
 *
 *  Venues and what each number actually is:
 *    Bebop   indicative depth from the streaming PMM feed, walked at size. A
 *            firm RFQ would likely price tighter; their quote endpoint needs a
 *            registered origin we don't have.
 *    Kyber   aggregator route quote. It may itself route through Uniswap or
 *            PancakeSwap, so it is not independent of the two below — treat it
 *            as "best executable route", not a fifth venue.
 *    Uniswap V3 QuoterV2 eth_call, best of the deployed fee tiers.
 *    PCS     PancakeSwap V3 QuoterV2 eth_call, same method.
 *
 *  Quotes are gross: no gas, no slippage tolerance, no MEV. Gas is reported
 *  separately at the bottom because on a 25 USD trade it dominates everything
 *  the venues differ by.
 */
import { config, NATIVE_SENTINEL } from '../config.js';
import { ethCall, getGasPrice } from '../src/chain/rpc.js';
import { fetchKyberQuote } from '../src/kyber/client.js';
import { BebopFeed } from '../src/bebop/feed.js';
import { walkBuyBaseFloat, walkSellBaseFloat } from '../src/bebop/depth.js';
import { toFloat } from '../src/pricing/units.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// QuoterV2, deployed by each project on Base. Both are Uniswap V3 quoters by
// lineage, so they share the quoteExactInputSingle selector.
const UNISWAP_QUOTER = '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a';
const PCS_QUOTER = '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997';
// quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96))
const QUOTE_SELECTOR = '0xc6a5026a';
const UNI_FEES = [100, 500, 3000, 10000];
const PCS_FEES = [100, 500, 2500, 10000];

const pad = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0').toLowerCase();
const addr = (a: string): string => pad(a);
const uint = (n: bigint | number): string => pad(BigInt(n).toString(16));

/** One QuoterV2 call. Returns null when the pool doesn't exist or can't fill. */
async function quoterOut(
  quoter: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number
): Promise<bigint | null> {
  const data = QUOTE_SELECTOR + addr(tokenIn) + addr(tokenOut) + uint(amountIn) + uint(fee) + uint(0);
  try {
    const res = await ethCall(quoter, data);
    if (!res || res === '0x' || res.length < 66) return null;
    const out = BigInt('0x' + res.slice(2, 66)); // first word is amountOut
    return out > 0n ? out : null;
  } catch {
    return null; // reverts when the pool is missing or has no liquidity at size
  }
}

/** Best fill across a venue's fee tiers, with the tier that won. */
async function bestTier(
  quoter: string,
  fees: number[],
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<{ out: bigint; fee: number } | null> {
  const results = await Promise.all(
    fees.map(async (fee) => ({ fee, out: await quoterOut(quoter, tokenIn, tokenOut, amountIn, fee) }))
  );
  let best: { out: bigint; fee: number } | null = null;
  for (const r of results) {
    if (r.out !== null && (best === null || r.out > best.out)) best = { out: r.out, fee: r.fee };
  }
  return best;
}

interface Row {
  venue: string;
  /** USDC per whole ETH implied by this fill */
  price: number | null;
  note: string;
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printTable(title: string, rows: Row[], higherIsBetter: boolean): void {
  const priced = rows.filter((r) => r.price !== null) as Array<Row & { price: number }>;
  const best = priced.length
    ? priced.reduce((a, b) => ((higherIsBetter ? b.price > a.price : b.price < a.price) ? b : a)).price
    : null;
  console.log(`\n  ${title}`);
  console.log(`  ${'venue'.padEnd(10)} ${'price (USDC/ETH)'.padStart(18)} ${'vs best'.padStart(10)}  note`);
  for (const r of rows) {
    if (r.price === null) {
      console.log(`  ${r.venue.padEnd(10)} ${'—'.padStart(18)} ${''.padStart(10)}  ${r.note}`);
      continue;
    }
    // "worse than best" is always a positive bps number, whichever direction is good
    const bps =
      best === null ? 0 : (higherIsBetter ? (best - r.price) / best : (r.price - best) / best) * 10_000;
    const tag = Math.abs(bps) < 0.05 ? 'best' : `${bps > 0 ? '-' : '+'}${Math.abs(bps).toFixed(1)} bps`;
    console.log(`  ${r.venue.padEnd(10)} ${fmtUsd(r.price).padStart(18)} ${tag.padStart(10)}  ${r.note}`);
  }
}

// --- reference price, so USD sizes convert to an ETH amount for the sell side ---
const probe = await fetchKyberQuote(USDC, WETH, 1_000_000_000n); // 1000 USDC
const refPrice = 1000 / toFloat(probe.amountOut, 18);
console.log(`Base WETH/USDC rate comparison`);
console.log(`reference price ${fmtUsd(refPrice)} USDC/ETH (Kyber, 1000 USDC probe)`);

const bebop = new BebopFeed();
await bebop.start();
await new Promise((r) => setTimeout(r, 6000)); // let the stream deliver a snapshot
const found = bebop.bookFor(WETH, USDC);
if (!found) console.log('WARNING: no Bebop WETH/USDC book streamed; its rows will be blank');

const sizes = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const notionals = sizes.length > 0 ? sizes : [25, 100, 500, 2000];

for (const usd of notionals) {
  console.log(`\n${'='.repeat(78)}\n$${usd.toLocaleString('en-US')}`);

  // ---------- BUY: spend USDC, receive ETH. Higher USDC/ETH price = worse. ----------
  const usdcIn = BigInt(Math.round(usd * 1e6));
  const buy: Row[] = [];

  if (found) {
    const ethOut = found.aIsBase
      ? walkBuyBaseFloat(found.book.asks, usd)
      : walkSellBaseFloat(found.book.bids, usd);
    buy.push({
      venue: 'Bebop',
      price: ethOut && ethOut > 0 ? usd / ethOut : null,
      note: ethOut ? 'streamed depth (indicative)' : 'depth could not absorb size',
    });
  }
  try {
    const q = await fetchKyberQuote(USDC, WETH, usdcIn);
    buy.push({ venue: 'Kyber', price: usd / toFloat(q.amountOut, 18), note: 'aggregator route' });
  } catch (err) {
    buy.push({ venue: 'Kyber', price: null, note: (err as Error).message });
  }
  for (const [name, quoter, fees] of [
    ['Uniswap', UNISWAP_QUOTER, UNI_FEES],
    ['PCS', PCS_QUOTER, PCS_FEES],
  ] as const) {
    const b = await bestTier(quoter, fees, USDC, WETH, usdcIn);
    buy.push({
      venue: name,
      price: b ? usd / toFloat(b.out, 18) : null,
      note: b ? `V3 ${b.fee / 10_000}% tier` : 'no pool filled at size',
    });
  }
  printTable('BUY ETH  (spend USDC)', buy, false);

  // ---------- SELL: spend ETH, receive USDC. Higher USDC/ETH price = better. ----------
  const ethAmount = usd / refPrice;
  const wethIn = BigInt(Math.round(ethAmount * 1e18));
  const sell: Row[] = [];

  if (found) {
    const usdcOut = found.aIsBase
      ? walkSellBaseFloat(found.book.bids, ethAmount)
      : walkBuyBaseFloat(found.book.asks, ethAmount);
    sell.push({
      venue: 'Bebop',
      price: usdcOut && usdcOut > 0 ? usdcOut / ethAmount : null,
      note: usdcOut ? 'streamed depth (indicative)' : 'depth could not absorb size',
    });
  }
  try {
    const q = await fetchKyberQuote(WETH, USDC, wethIn);
    sell.push({
      venue: 'Kyber',
      price: toFloat(q.amountOut, 6) / ethAmount,
      note: 'aggregator route',
    });
  } catch (err) {
    sell.push({ venue: 'Kyber', price: null, note: (err as Error).message });
  }
  for (const [name, quoter, fees] of [
    ['Uniswap', UNISWAP_QUOTER, UNI_FEES],
    ['PCS', PCS_QUOTER, PCS_FEES],
  ] as const) {
    const b = await bestTier(quoter, fees, WETH, USDC, wethIn);
    sell.push({
      venue: name,
      price: b ? toFloat(b.out, 6) / ethAmount : null,
      note: b ? `V3 ${b.fee / 10_000}% tier` : 'no pool filled at size',
    });
  }
  printTable(`SELL ETH (${ethAmount.toFixed(6)} ETH)`, sell, true);
}

// --- gas, which is the whole story at the small end ---
const gasPriceWei = await getGasPrice();
const swapGasUsd = (units: number) => (toFloat(BigInt(units) * gasPriceWei, 18) * refPrice);
console.log(`\n${'='.repeat(78)}`);
console.log(`gas at ${toFloat(gasPriceWei, 9).toFixed(4)} gwei:`);
console.log(`  simple V3 swap  ~150k units  ~$${swapGasUsd(150_000).toFixed(3)}`);
console.log(`  aggregator swap ~250k units  ~$${swapGasUsd(250_000).toFixed(3)}`);
console.log(`  RFQ settlement  ~${config.bebop.gasUnits} units  ~$${swapGasUsd(Number(config.bebop.gasUnits)).toFixed(3)}`);
console.log(`\nnative ETH (${NATIVE_SENTINEL.slice(0, 8)}..) adds a wrap/unwrap on the V3 legs; Kyber and Bebop quote it directly.`);

bebop.stop();
process.exit(0);
