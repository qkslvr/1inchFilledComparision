import { readFileSync } from 'node:fs';
import type { PairConfig } from './src/types.js';

// Minimal .env loader: KEY=VALUE lines, no quoting rules, real env wins.
try {
  for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // no .env file, fine
}

/** Same sentinel on every EVM chain. */
export const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

interface ChainProfile {
  chainId: number;
  label: string;
  /** canonical wrapped-native address (WETH, WBNB), for hedge_asset_kind bookkeeping */
  wethAddress: string;
  pairs: PairConfig[];
  rpcEnvVar: string;
  rpcUrlDefault: string;
  dashPortDefault: number;
  /** KyberSwap aggregator chain slug */
  kyberChainSlug: string;
  /** pair ticker whose mid prices the gas asset, e.g. ETH_USDC or BNB_USDT */
  nativeTicker: string;
  /** symbol of the gas asset, and of the stable everything converts through */
  nativeSymbol: string;
  stableSymbol: string;
  /** How stale a venue quote may be before the comparison is called degraded.
   *  Defaults to degradedSnapshotAgeMs, which suits a live order book; a
   *  settlement-driven dataset only ever quotes after the block, so a 3s rule
   *  would mark every single comparison degraded and hide every win. */
  quoteLagToleranceMs?: number;
  /** Venues that apply to this dataset. PancakeSwap only exists where it is
   *  deployed, so showing its card on Ethereum just renders a permanent
   *  "no orders". */
  venues?: Array<'kalqix' | 'kyber' | 'bebop' | 'pancake'>;
  /** Postgres schema, when this dataset must not share the chain default. */
  schemaOverride?: string;
  /** Where orders come from. Fusion reads the 1inch feed; cow reads settled
   *  CoW trades from chain logs, which is a price comparison, not a race. */
  orderSource?: 'fusion' | 'cow' | 'cow-solver';
  /** CoW Protocol network slug, on chains where it runs. */
  cowChainSlug?: string;
  /** Bebop stream slug, where it differs from the Kyber one. */
  bebopChainSlug?: string;
  /** How this dataset gets Bebop books. The key allows one live socket per
   *  chain, so any chain with two collectors must put both behind the relay.
   *  Defaults to holding the socket directly. */
  bebopMode?: 'stream' | 'relay';
  /** A specific solver to measure ourselves against, rather than the field.
   *
   *  The cicada dataset exists to pitch one solver: for each order they bid on,
   *  could our liquidity have beaten the price *they* proposed? That is a
   *  different question from "would we have won", and it needs their own bid as
   *  the bar rather than the auction winner's. */
  targetSolver?: string;
  /** Override the auction poll interval where the chain warrants it. */
  competitionPollMs?: number;
  /** Consider orders already in the solvable set, not only new arrivals.
   *
   *  Ignoring the backlog is right on mainnet, where it is ~7,700 long-dated
   *  limit orders resting far from market and the live flow arrives as new
   *  uids. On Arbitrum the list lags: the uids that appear at the head are
   *  already fulfilled, expired or cancelled by the time we read them, while
   *  genuinely open orders with many minutes left sit in the standing set. Only
   *  bidding on arrivals there means bidding on nothing. */
  bidOnBacklog?: boolean;
  /** Quote at the moment an auction resolves, rather than while the order is
   *  open.
   *
   *  Forced by the data on Arbitrum: an order enters the solvable list only in
   *  the auction that settles it — verified on five consecutive settlements,
   *  present in that auction's list and absent from the one before. There is no
   *  window in which it is both visible and unsettled, so a pre-bid cannot
   *  exist. The comparison is still the one that matters for a pitch — on this
   *  order you bid X, our venues at that moment would have paid Y — but the
   *  quote is taken after the outcome, and drift between the two is a caveat
   *  rather than a measurement. */
  quoteOnResolve?: boolean;
  /** PancakeSwap V3 QuoterV2, on chains where it is deployed. */
  pancakeQuoter?: string;
  /** PancakeSwap V3 fee tiers, in hundredths of a bip. */
  pancakeFees?: number[];
  /** token pairs (unordered) excluded from kyber-only tracking, e.g. dull
   *  stable rotations that would hog the quote slots */
  kyberOnlySkipPairs: Array<[string, string]>;
  /** chain-specific honesty caveats, rendered in the report header */
  reportCaveats: string[];
}


const WETH_ETHEREUM = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC_ETHEREUM = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WBTC_ETHEREUM = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const USDT_ETHEREUM = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const DAI_ETHEREUM = '0x6b175474e89094c44da98b954eedeac495271d0f';

// BNB Chain. Note the decimals: unlike Ethereum, USDT and USDC here are 18dp,
// and BTCB is 18dp rather than WBTC's 8. Copying the Ethereum profile's
// decimals would put every USD figure out by a factor of 10^12.
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
const BTCB_BSC = '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c';
const ETH_BSC = '0x2170ed0880ac9a755fd29b2688956bd959f933f8';
/** PancakeSwap deploys its V3 QuoterV2 at the same address on every chain. */
const PANCAKE_QUOTER = '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997';

// Arbitrum. Different addresses entirely from Ethereum, and USDC here is the
// native one rather than the bridged USDC.e.
const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const USDT_ARB = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const WBTC_ARB = '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f';
const ARB_ARB  = '0x912ce59144191c1204e64559fe8253a0e49e6548';

const profiles: Record<string, ChainProfile> = {
  ethereum: {
    chainId: 1,
    label: 'Ethereum',
    wethAddress: WETH_ETHEREUM,
    pairs: [
      {
        ticker: 'ETH_USDC',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ETHEREUM] },
      kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        // WBTC hedged on KalqiX's cbBTC market: same URL ticker, different wrapper
        ticker: 'cbBTC_USDC',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ETHEREUM] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ETHEREUM] },
      kalqix: { ticker: 'cbBTC_USDC', baseDecimals: 8, quoteDecimals: 6 },
      },
    ],
    rpcEnvVar: 'ETH_RPC_URL',
    rpcUrlDefault: 'https://ethereum-rpc.publicnode.com',
    dashPortDefault: 8788,
    kyberChainSlug: 'ethereum',
    cowChainSlug: 'mainnet',
    // Shares chain 1 with cowswapResolver, and the key allows one socket per
    // chain: both read from the relay so neither can lock the other out.
    bebopMode: 'relay',
    venues: ['kalqix', 'kyber', 'bebop'],
    nativeTicker: 'ETH_USDC',
    nativeSymbol: 'ETH',
    stableSymbol: 'USDC',
    kyberOnlySkipPairs: [],
    reportCaveats: [
      'Orders are on Ethereum but the hedge venue (KalqiX) settles on Base; cross-chain inventory and rebalancing costs are ignored. This measures pricing headroom only.',
      'WBTC is hedged on the cbBTC order book. Unlike WETH and native ETH, WBTC and cbBTC are different custodial wrappers; the wrapper basis is ignored.',
    ],
  },
  bsc: {
    chainId: 56,
    label: 'BNB Chain',
    wethAddress: WBNB,
    pairs: [
      {
        ticker: 'BNB_USDT',
        base: { symbol: 'BNB', decimals: 18, addresses: [WBNB, NATIVE_SENTINEL] },
        quote: { symbol: 'USDT', decimals: 18, addresses: [USDT_BSC] },
      },
      {
        ticker: 'BTCB_USDT',
        base: { symbol: 'BTCB', decimals: 18, addresses: [BTCB_BSC] },
        quote: { symbol: 'USDT', decimals: 18, addresses: [USDT_BSC] },
      kalqix: { ticker: 'cbBTC_USDC', baseDecimals: 8, quoteDecimals: 6 },
      },
      {
        ticker: 'ETH_USDT',
        base: { symbol: 'ETH', decimals: 18, addresses: [ETH_BSC] },
        quote: { symbol: 'USDT', decimals: 18, addresses: [USDT_BSC] },
      kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
    ],
    rpcEnvVar: 'BSC_RPC_URL',
    rpcUrlDefault: 'https://bsc-dataseed.binance.org',
    dashPortDefault: 8789,
    kyberChainSlug: 'bsc',
    nativeTicker: 'BNB_USDT',
    nativeSymbol: 'BNB',
    stableSymbol: 'USDT',
    bebopChainSlug: 'bsc',
    venues: ['kalqix', 'kyber', 'bebop', 'pancake'],
    pancakeQuoter: PANCAKE_QUOTER,
    pancakeFees: [100, 500, 2500, 10000],
    kyberOnlySkipPairs: [],
    reportCaveats: [
      'BNB and BTCB/ETH differ here: KalqiX lists no BNB market, so BNB_USDT carries no KalqiX column, while BTCB and ETH orders are priced against its cbBTC and ETH books. Those settle on Base, so cross-chain inventory and rebalancing costs are ignored.',
      'USDT on BNB Chain is 18-decimal, unlike the 6-decimal USDC used on Ethereum. USD figures are converted accordingly but are not directly comparable line-for-line with the Ethereum report.',
    ],
  },
  // Same chain and same pairs as 'ethereum', but the orders come from settled
  // CoW trades rather than the 1inch feed, and land in their own schema. The
  // question inverts: not "could we have filled this Fusion order first", but
  // "did the winning CoW solver leave money on the table".
  cowswapResolver: {
    chainId: 1,
    label: 'CoW Swap Ethereum',
    schemaOverride: 'cowswap_1',
    orderSource: 'cow',
    // Above the ~15s structural floor, so it separates clean samples from
    // lagged ones. At 30s it sat below the old 41s floor and flagged every
    // single tick, which made the signal useless.
    quoteLagToleranceMs: 25_000,
    wethAddress: WETH_ETHEREUM,
    pairs: [
      {
        ticker: 'ETH_USDC',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ETHEREUM] },
        kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        ticker: 'cbBTC_USDC',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ETHEREUM] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ETHEREUM] },
        kalqix: { ticker: 'cbBTC_USDC', baseDecimals: 8, quoteDecimals: 6 },
      },
      // KalqiX lists only ETH/USDC and cbBTC/USDC, but a dollar is a dollar for
      // our purposes, so the USDT and DAI pairs are priced off the same books.
      // Note the decimals: DAI is 18dp against USDC's 6dp, which rescaleBook
      // handles — get that wrong and every DAI figure is out by 10^12.
      {
        ticker: 'ETH_USDT',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'USDT', decimals: 6, addresses: [USDT_ETHEREUM] },
        kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        ticker: 'ETH_DAI',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'DAI', decimals: 18, addresses: [DAI_ETHEREUM] },
        kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        ticker: 'WBTC_USDT',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ETHEREUM] },
        quote: { symbol: 'USDT', decimals: 6, addresses: [USDT_ETHEREUM] },
        kalqix: { ticker: 'cbBTC_USDC', baseDecimals: 8, quoteDecimals: 6 },
      },
      {
        // crypto-crypto, so there is no stable leg and its USD notional is null
        ticker: 'WBTC_ETH',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ETHEREUM] },
        quote: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM] },
      },
    ],
    rpcEnvVar: 'ETH_RPC_URL',
    rpcUrlDefault: 'https://ethereum.publicnode.com',
    dashPortDefault: 8790,
    kyberChainSlug: 'ethereum',
    cowChainSlug: 'mainnet',
    // Shares chain 1 with cowswapResolver, and the key allows one socket per
    // chain: both read from the relay so neither can lock the other out.
    bebopMode: 'relay',
    venues: ['kalqix', 'kyber', 'bebop'],
    nativeTicker: 'ETH_USDC',
    nativeSymbol: 'ETH',
    stableSymbol: 'USDC',
    kyberOnlySkipPairs: [],
    reportCaveats: [
      'Orders here are CoW trades that have already settled: CoW\'s open-order endpoint is solver-only, so they cannot be observed while live. This is therefore a price comparison, not a race — there is no lead time and no "profitable too late" verdict, because we never saw the order in flight.',
      'Venue quotes are necessarily taken after the settling block. The lag is recorded per tick and a comparison beyond the degraded threshold is marked as such.',
      'USDT and DAI orders are priced against KalqiX\'s USDC books, treating one dollar stablecoin as another. The basis between them is ignored, which at these edge sizes is not always negligible: a 5 bps USDC/DAI dislocation is a material fraction of a 10 bps edge.',
    ],
  },
  cowswapSolver: {
    chainId: 1,
    label: 'CoW Solver Simulation',
    schemaOverride: 'cowswap_solver_1',
    orderSource: 'cow-solver',
    // Above the ~15s structural floor, so it separates clean samples from
    // lagged ones. At 30s it sat below the old 41s floor and flagged every
    // single tick, which made the signal useless.
    quoteLagToleranceMs: 25_000,
    wethAddress: WETH_ETHEREUM,
    pairs: [
      {
        ticker: 'ETH_USDC',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ETHEREUM] },
        kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        ticker: 'cbBTC_USDC',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ETHEREUM] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ETHEREUM] },
        kalqix: { ticker: 'cbBTC_USDC', baseDecimals: 8, quoteDecimals: 6 },
      },
      // KalqiX lists only ETH/USDC and cbBTC/USDC, but a dollar is a dollar for
      // our purposes, so the USDT and DAI pairs are priced off the same books.
      // Note the decimals: DAI is 18dp against USDC's 6dp, which rescaleBook
      // handles — get that wrong and every DAI figure is out by 10^12.
      {
        ticker: 'ETH_USDT',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'USDT', decimals: 6, addresses: [USDT_ETHEREUM] },
        kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        ticker: 'ETH_DAI',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'DAI', decimals: 18, addresses: [DAI_ETHEREUM] },
        kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        ticker: 'WBTC_USDT',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ETHEREUM] },
        quote: { symbol: 'USDT', decimals: 6, addresses: [USDT_ETHEREUM] },
        kalqix: { ticker: 'cbBTC_USDC', baseDecimals: 8, quoteDecimals: 6 },
      },
      {
        // crypto-crypto, so there is no stable leg and its USD notional is null
        ticker: 'WBTC_ETH',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ETHEREUM] },
        quote: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM] },
      },
    ],
    rpcEnvVar: 'ETH_RPC_URL',
    rpcUrlDefault: 'https://ethereum.publicnode.com',
    dashPortDefault: 8791,
    kyberChainSlug: 'ethereum',
    cowChainSlug: 'mainnet',
    // Shares chain 1 with cowswapResolver, and the key allows one socket per
    // chain: both read from the relay so neither can lock the other out.
    bebopMode: 'relay',
    venues: ['kalqix', 'kyber', 'bebop'],
    nativeTicker: 'ETH_USDC',
    nativeSymbol: 'ETH',
    stableSymbol: 'USDC',
    kyberOnlySkipPairs: [],
    reportCaveats: [
      'This simulates bidding as a CoW solver. Quotes are taken while the order is open, before the winner is known; the bid is then compared with the winning solver\'s score; then the venues are re-quoted to see whether the price we bid on was still there once we knew we had won.',
      'We never actually submit a solution, so every win here is counterfactual. Our presence would have changed what rivals bid, which makes these win rates an upper bound rather than a forecast.',
      'Our score is reproduced from surplus valued at the auction\'s own native prices. It currently matches CoW\'s reported score to about 96%, so win rates near the margin are provisional until that gap closes.',
      'USDT and DAI orders are priced against KalqiX\'s USDC books, treating one dollar stablecoin as another. The basis between them is ignored.',
    ],

  },
  cicada: {
    chainId: 42161,
    label: 'Cicada — Arbitrum solver',
    schemaOverride: 'cicada_42161',
    orderSource: 'cow-solver',
    targetSolver: '0x4cdaf5df3afe11f1726b8975a925245ad14e9f3b',
    // Arbitrum decides an auction roughly every four minutes, against mainnet's
    // twenty-five seconds. Polling it every 20s asked twelve times more often
    // than it produces anything, and every one of those requests was refused
    // while the busier mainnet dataset's went through — so the waste was not
    // merely wasteful, it was the reason this dataset collected nothing.
    // Arbitrum decides an auction roughly every four minutes, but the orders in
    // it close far sooner than that: polling at 90s, every one of 1,034 new
    // uids was already notOpen by the time we looked it up. With the Ethereum
    // dataset stopped there is no budget to share, so poll fast enough to catch
    // an order while it is still live.
    competitionPollMs: 15_000,
    bidOnBacklog: true,
    quoteOnResolve: true,
    // Above the ~15s structural floor, so it separates clean samples from
    // lagged ones. At 30s it sat below the old 41s floor and flagged every
    // single tick, which made the signal useless.
    quoteLagToleranceMs: 25_000,
    wethAddress: WETH_ARB,
    pairs: [
      {
        ticker: 'ETH_USDC',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ARB, NATIVE_SENTINEL] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ARB] },
        kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        ticker: 'ETH_USDT',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ARB, NATIVE_SENTINEL] },
        quote: { symbol: 'USDT', decimals: 6, addresses: [USDT_ARB] },
        kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
      },
      {
        ticker: 'WBTC_USDC',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ARB] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ARB] },
        kalqix: { ticker: 'cbBTC_USDC', baseDecimals: 8, quoteDecimals: 6 },
      },
      {
        ticker: 'ARB_USDC',
        base: { symbol: 'ARB', decimals: 18, addresses: [ARB_ARB] },
        quote: { symbol: 'USDC', decimals: 6, addresses: [USDC_ARB] },
      },
    ],
    rpcEnvVar: 'ARB_RPC_URL',
    rpcUrlDefault: 'https://arb1.arbitrum.io/rpc',
    dashPortDefault: 8792,
    kyberChainSlug: 'arbitrum',
    cowChainSlug: 'arbitrum_one',
    // Shares chain 1 with cowswapResolver, and the key allows one socket per
    // chain: both read from the relay so neither can lock the other out.
    bebopChainSlug: 'arbitrum',
    bebopMode: 'stream',
    venues: ['kalqix', 'kyber', 'bebop'],
    nativeTicker: 'ETH_USDC',
    nativeSymbol: 'ETH',
    stableSymbol: 'USDC',
    kyberOnlySkipPairs: [],
    reportCaveats: [
      'This measures one Arbitrum solver, 0x4cdaf5df…, rather than the field. For every order they bid on we ask whether our liquidity could have beaten the price they themselves proposed — so the bar is their bid, not the auction winner\'s.',
      'KalqiX runs no Arbitrum market, so its ETH and BTC books are used as an independent price for the same assets settled elsewhere — the same cross-chain basis the Ethereum dataset already accepts for Base, and inventory and rebalancing costs are ignored. Bebop lists thirteen tokens on Arbitrum; Kyber quotes the rest.',
      'We never submit a solution. A win here means our price beat theirs on the same order, not that the auction would have resolved differently once other solvers responded.',
    ],


  },
};
profiles.eth = profiles.ethereum!;
profiles.bnb = profiles.bsc!;
profiles.cowswapresolver = profiles.cowswapResolver!;
profiles.cowswapsolver = profiles.cowswapSolver!;
profiles.cicada = profiles.cicada!;
profiles.cow = profiles.cowswapResolver!;

// `||`, not `??`: .env.example ships CHAIN= as an empty placeholder, and the
// loader above turns that into '' rather than leaving it unset.
const chainName = (process.env.CHAIN || 'ethereum').toLowerCase();
const profile = profiles[chainName];
if (!profile) {
  throw new Error(`unknown CHAIN "${chainName}" (expected: ethereum, bsc, cowswapresolver)`);
}

/** unordered-pair keys ("a|b", lowercase-sorted) for the kyber-only skip list */
const kyberOnlySkipKeys = new Set(
  profile.kyberOnlySkipPairs.map(([a, b]) => [a.toLowerCase(), b.toLowerCase()].sort().join('|'))
);

export function isKyberOnlySkipped(makerAsset: string, takerAsset: string): boolean {
  return kyberOnlySkipKeys.has([makerAsset.toLowerCase(), takerAsset.toLowerCase()].sort().join('|'));
}

export const config = {
  chainId: profile.chainId,
  chainLabel: profile.label,
  hasKalqix: profile.pairs.some((p) => p.kalqix !== undefined),
  schemaOverride: profile.schemaOverride ?? null,
  orderSource: profile.orderSource ?? 'fusion',
  quoteLagToleranceMs: profile.quoteLagToleranceMs ?? 3000,
  nativeTicker: profile.nativeTicker,
  nativeSymbol: profile.nativeSymbol,
  stableSymbol: profile.stableSymbol,
  pancakeQuoter: profile.pancakeQuoter ?? null,
  pancakeFees: profile.pancakeFees ?? [],
  wethAddress: profile.wethAddress,
  pairs: profile.pairs,
  reportCaveats: profile.reportCaveats,
  dashPortDefault: profile.dashPortDefault,
  /** KalqiX book levels per side to fetch and store. */
  bookDepth: 50,
  sampleIntervalMs: 1000,
  pricingIntervalMs: 1000,
  /** Cadence once an auction is past its floor. The taker amount no longer
   *  moves there, so 1 Hz only multiplies rows: BNB Chain's long-dated orders
   *  produced 86,400 near-identical ticks each per day at the full rate. */
  postAuctionIntervalMs: 30_000,
  refPriceIntervalMs: 30_000,
  gasPollIntervalMs: 30_000,
  /** Gas units for a hypothetical fill tx, incl. wrap/unwrap allowance for native-ETH takers. */
  gasUnits: 300_000n,
  kalqixTakerFeeBps: 5n,
  /** Set to zero deliberately: the solver simulation prices the trade as it
   *  would actually be filled, with no cushion held back. A margin here is a
   *  commercial choice, not a cost, and folding it in made every bid look worse
   *  than the price we could really have offered. */
  safetyMarginBps: 0n,
  /** A decision tick whose snapshot is older than this is degraded (no-lookahead rule). */
  degradedSnapshotAgeMs: 3000,
  oneInchApiBase: 'https://api.1inch.dev/fusion',
  oneInchWsBase: 'https://api.1inch.dev/fusion/ws',
  kalqixApiBase: 'https://api.kalqix.com/v1',
  baseRpcUrl: process.env[profile.rpcEnvVar] || profile.rpcUrlDefault,
  reportCurrency: profile.stableSymbol,
  /** Half the Dev Portal ~1 rps budget. Kept at half now that Ethereum is the
   *  only chain: the binding limit turned out to be the plan's total request
   *  allowance, not its rate, and three keys were exhausted in a week. Running
   *  one collector at this rate halves the burn rather than doubling throughput. */
  restRatePerSec: 0.5,
  restBurst: 2,
  activePollFallbackMs: 5000,
  /** force-reconnect a "connected" 1inch WS that has delivered nothing for this
   *  long (silent TCP death has no close event; Ethereum flow makes 5 min of
   *  true silence implausible, and a spurious reconnect costs ~2 REST calls) */
  wsStaleMs: 300_000,
  /** Terminal-status fetch grace after order deadline. */
  reapGraceMs: 60_000,
  sensitivity: {
    safetyMarginBps: [0n, 5n, 10n, 20n, 40n],
    gasMult: [0.5, 1, 2],
  },
  bebop: {
    wsBase: 'wss://api.bebop.xyz/pmm',
    restBase: 'https://api.bebop.xyz/pmm',
    chainSlug: profile.bebopChainSlug ?? profile.kyberChainSlug,
    /** our assumed markup on a Bebop-hedged fill */
    feeBps: 5n,
    /** settlement tx gas for an RFQ self-execution fill */
    gasUnits: 250_000n,
    /** a tick using stream data older than this is bebop-degraded */
    degradedAgeMs: 5000,
    /** the stream is chatty (all pairs, sub-second); a minute of silence = dead socket */
    staleReconnectMs: 60_000,
    /** Ceiling on reconnect backoff. Was 30s, which meant a stream returning
     *  503 for hours was still being knocked on 120 times an hour — and a
     *  reconnect storm is a plausible way to get throttled in the first place.
     *  Two minutes still notices a recovery quickly enough. */
    reconnectMaxMs: 120_000,
    mode: profile.bebopMode ?? 'stream',
    /** Loopback only — the relay must never be reachable from outside the box.
     *  8790 belongs to liqDashboard's next-server; this box also has the shadow
     *  dashboard on 5432 and Postgres on 5433, so check `ss -ltn` before
     *  assuming a port is free. */
    relayPort: Number(process.env.BEBOP_RELAY_PORT ?? 8793),
    /** Well inside degradedAgeMs, so a book is never called stale merely for
     *  having taken the loopback hop. */
    relayPollMs: 500,
    relayTimeoutMs: 4000,
  },
  // CoW Protocol. Kept for the order-source work: the quote endpoint is public
  // and needs no key. Note /auction — the open-order set — is solver-only (403).
  cow: {
    apiBase: 'https://api.cow.fi',
    chainSlug: profile.cowChainSlug ?? 'mainnet',
    targetSolver: profile.targetSolver?.toLowerCase() ?? null,
    bidOnBacklog: profile.bidOnBacklog === true,
    quoteOnResolve: profile.quoteOnResolve === true,
    /** quotes need a from/receiver to be returned; nothing is signed or sent */
    quoteFrom: '0x0000000000000000000000000000000000000001',
    feeBps: 5n,
    quoteIntervalMs: 2000,
    quoteTimeoutMs: 5000,
    degradedQuoteAgeMs: 5000,
    /** How often to look for newly settled trades. Every 12s meant a trade
     *  could sit unseen for a block; the comparison is only as good as how
     *  quickly we can price it. */
    settlementPollMs: 3_000,
    /** Blocks to stay behind the head. Three cost ~36s of price drift against a
     *  signal of 10-18 bps — the same order of magnitude — so the reorg
     *  protection was more expensive than the risk it bought. One block still
     *  rejects the common case; a deep reorg would leave a record of a trade
     *  that did not happen, which is the accepted trade. */
    confirmations: 1,
    /** cap on blocks per getLogs call, so a long outage backfills gradually */
    maxBlockSpan: 200,
    /** How often to ask for the solver-competition feed.
     *
     *  Twenty seconds, against feeds that advance every ~25s on mainnet and
     *  every ~4 minutes on Arbitrum. Three seconds — the previous value — asked
     *  roughly eighty times more often than Arbitrum produces anything, and two
     *  datasets doing that is ~40 requests a minute of ~200KB payloads. That is
     *  almost certainly what exhausted CoW's daily quota for this IP.
     *
     *  It also starved our own order lookups. The poll and the lookups draw on
     *  one per-dataset budget, and a poll that wants a slot every three seconds
     *  takes all of them: cicada saw 417 new orders and failed to look up all
     *  417 of them. Polling at the rate the data actually changes leaves the
     *  budget for the lookups, which are the scarce and valuable call. */
    competitionPollMs: profile.competitionPollMs ?? 20_000,
    /** Random delay before the first poll, so two processes started together by
     *  the supervisor do not line up and collide on every tick thereafter. */
    pollJitterMs: 7_000,
    /** Minimum gap between CoW requests by ANY process on this host — polls and
     *  order lookups alike, since they share one budget.
     *
     *  Measured with every one of our pollers stopped: the endpoint answered
     *  6 of 6 at 4s spacing on Arbitrum and 3 of 3 on mainnet. So the limit is
     *  roughly one request per four seconds from this IP, and every 429 we spent
     *  the afternoon fighting was self-inflicted.
     *
     *  This is the PER-DATASET interval, and there are two of them, so the pair
     *  sums to one request per four seconds. Sized this way rather than shared,
     *  because a shared gate is first-come-first-served and the busier dataset
     *  takes every slot. */
    sharedPollMinIntervalMs: 8_000,
    /** How long a lookup will queue for the shared slot before giving up. Past
     *  this the order has usually expired anyway. */
    lookupMaxWaitMs: 20_000,
    /** How many polls an order may be retried across before we stop trying. */
    maxLookupAttempts: 6,
    /** Largest USD size we will believe from a venue's own valuation.
     *
     *  Kyber reports what its output is worth, which is the only price we have
     *  for an unconfigured token — and on an illiquid pair it can be wildly
     *  wrong. One PYUSD/USDai order came back at $100,003,596 against a median
     *  trade of $200, and that single row was the entire "total volume" figure
     *  on the dashboard. Above this we record no size rather than a false one. */
    maxBelievableSizeUsd: 25_000_000,
    /** Ignore orders valid absurdly far into the future.
     *
     *  Not an asset filter — it says nothing about what is traded, only whether
     *  an order is plausibly live. Sized from what actually settles rather than
     *  from intuition: 25 settled Arbitrum orders were signed with windows of
     *  240 to 342 minutes, 23 of 25 in the 1h-1day band, and none under an hour.
     *
     *  An earlier 1-hour rule therefore rejected every order that settles —
     *  resting=702 while resolved stayed at zero. A day admits real flow and
     *  still excludes the genuinely resting orders, one of which was valid for
     *  362 days.
     */
    solverMaxValidToMs: 86_400_000,
    /** How long to stop polling after a 429, rather than retrying into it. */
    rateLimitBackoffMs: 30_000,
    /** How long the settlement backstop waits before claiming a trade.
     *
     *  Both feeds see the same trades, and whichever registers it first wins.
     *  The log path was winning nearly every race, which is backwards: it quotes
     *  ~15s after the block where the competition feed quotes ~3s after it, so
     *  the faster, score-carrying path was being crowded out by its own backup.
     *  /latest advances every ~13s, so this is one full chance to get there
     *  first. A trade the fast path genuinely missed is delayed, never dropped.
     *
     *  This MUST stay below quoteLagToleranceMs (25s). At 28s it pushed the
     *  backstop's own ticks past the staleness threshold and flagged 28 of 32
     *  degraded — a delay we chose to add, then marked the data down for. The
     *  fast path only won ~10% more rows for it, and now that by_tx_hash gives
     *  the backstop its scores anyway, lag is the only thing left to protect. */
    backstopGraceMs: 15_000,
    /** --- solver simulation --- */
    /** How often each open order is re-quoted while it waits for its auction.
     *  The bid is whatever the latest pre-resolution quote was, so this sets how
     *  stale a bid can be; orders live ~59s median, so this gives several. */
    solverQuoteIntervalMs: 4_000,
    /** Most solvable orders are long-dated resting limit orders that will never
     *  fill near touch. Quoting all 7,700 would flood the database for no
     *  signal, so only orders whose limit is within this of the current venue
     *  price are tracked. */
    solverMaxDistanceBps: 250n,
    /** Hard ceiling on orders quoted at once, whatever the filter admits. */
    solverMaxTracked: 60,
    /** A Kyber quote older than this is dropped rather than reused, so a starved
     *  order reports no Kyber price instead of a stale one. */
    kyberQuoteMaxAgeMs: 30_000,
    /** Wait after learning we won before re-quoting, to model the gap a real
     *  solver faces between winning and its settlement landing. */
    solverHoldDelaysMs: [0, 12_000],
    /** Drop a tracked order that has not resolved in this long.
     *
     *  Settled orders live ~59s median, so anything still open after several
     *  minutes is a resting limit order that may never fill near touch. Holding
     *  a slot for it starves the live flow the simulation exists to measure. */
    solverMaxTrackAgeMs: 300_000,
    /** Tolerance on the re-quote before a price counts as having slipped.
     *
     *  This used to key off safetyMarginBps, which is now zero — and a strict
     *  test marks a one-wei move as a failure, which is how 37 re-quotes came
     *  to read "slipped" beside 0.0 bps of slippage. One bp is measurement
     *  noise, not an economic cushion. */
    solverHoldToleranceBps: 1n,
    /** Keep watching an order for this long after its validTo passes.
     *
     *  Measured: orders arrive with only 6-26s of validity left once our ~13s
     *  detection lag has run, and the settlement lands at or just after validTo.
     *  Evicting the instant validTo passed dropped every order a moment before
     *  the auction that would have graded it — discovered=10, evicted=10,
     *  tracked=0, nothing ever resolved. */
    solverExpiryGraceMs: 90_000,
  },
  pancake: {
    /** our assumed markup on a PancakeSwap-hedged fill, same basis as the others */
    feeBps: 5n,
    /** a tick using a quote older than this, or for a stale size, is degraded */
    degradedQuoteAgeMs: 5000,
  },
  kyber: {
    apiBase: 'https://aggregator-api.kyberswap.com',
    chainSlug: profile.kyberChainSlug,
    clientId: 'shadow-resolver',
    /** our assumed markup on a Kyber-hedged fill */
    feeBps: 5n,
    /** fallback swap-leg gas units when the quote carries no estimate */
    fallbackGasUnits: 400_000n,
    quoteIntervalMs: 2000,
    quoteTimeoutMs: 4000,
    /** retries for one-shot callers on a 429 or timeout; the Fusion loop passes
     *  none, because its next tick is 2s away. */
    quoteRetries: 2,
    /** Requests per window, counted per HTTP call. Kyber's own headers report
     *  30 per 10s per IP; staying under it because a retry spends budget too. */
    budgetPerWindow: 25,
    budgetWindowMs: 10_000,
    /** a tick using a quote older than this (or for a stale size) is kyber-degraded */
    degradedQuoteAgeMs: 5000,
    /** cap on concurrent per-order quote loops (rate-limit guard) */
    maxTrackedOrders: 6,
    /** KalqiX-unsupported orders also get Kyber-only tracking when sizeable... */
    unsupportedMinUsd: 1000,
    /** ...but never more than this many at once (KalqiX-pair orders keep priority) */
    maxKyberOnlyTracked: 4,
  },
  notionalBucketsUsd: [1_000, 5_000, 25_000, 100_000],
} as const;

export function bebopApiKey(): string | null {
  return process.env.BEBOP_API_KEY || null;
}

/** All chain profiles resolved (env-aware), for cross-chain readers like the
 *  combined dashboard. The collector still uses the single CHAIN-selected view. */
export interface ResolvedChain {
  key: string;
  chainId: number;
  label: string;
  wethAddress: string;
  pairs: PairConfig[];
  rpcUrl: string;
  schemaOverride: string | null;
  orderSource: 'fusion' | 'cow' | 'cow-solver';
  venues: Array<'kalqix' | 'kyber' | 'bebop' | 'pancake'>;
}

/** What the dashboard serves.
 *
 *  Narrowed to the solver simulation on 2026-08-20. The Fusion collectors were
 *  stopped the same day, and cowswapResolver answered a weaker question — would
 *  some venue have paid more, after the fact — that the solver subsumes by
 *  asking whether we would actually have won. Their profiles and their data are
 *  kept; add a key back here to serve one again. */
export const allChains: ResolvedChain[] = ['cowswapSolver', 'cicada'].map((key) => {
  const p = profiles[key]!;
  return {
    key,
    chainId: p.chainId,
    label: p.label,
    wethAddress: p.wethAddress,
    pairs: p.pairs,
    rpcUrl: process.env[p.rpcEnvVar] || p.rpcUrlDefault,
    schemaOverride: p.schemaOverride ?? null,
    orderSource: p.orderSource ?? 'fusion',
    venues: p.venues ?? ['kalqix', 'kyber', 'bebop'],
  };
});

export function oneInchApiKey(): string {
  const key = process.env.ONEINCH_API_KEY;
  if (!key) {
    throw new Error('ONEINCH_API_KEY is not set (env or .env file). Get one at https://portal.1inch.dev');
  }
  return key;
}

export function pairForTokens(makerAsset: string, takerAsset: string): {
  pair: PairConfig;
  direction: 'SELL_BASE' | 'BUY_BASE';
} | null {
  const maker = makerAsset.toLowerCase();
  const taker = takerAsset.toLowerCase();
  for (const pair of config.pairs) {
    if (pair.base.addresses.includes(maker) && pair.quote.addresses.includes(taker)) {
      return { pair, direction: 'SELL_BASE' };
    }
    if (pair.quote.addresses.includes(maker) && pair.base.addresses.includes(taker)) {
      return { pair, direction: 'BUY_BASE' };
    }
  }
  return null;
}
