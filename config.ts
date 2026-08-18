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
  orderSource?: 'fusion' | 'cow';
  /** CoW Protocol network slug, on chains where it runs. */
  cowChainSlug?: string;
  /** Bebop stream slug, where it differs from the Kyber one. */
  bebopChainSlug?: string;
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
    quoteLagToleranceMs: 30_000,
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
      // KalqiX lists only ETH/USDC and cbBTC/USDC, so the pairs below carry no
      // kalqix mapping and its column reads "no data" for them — deliberately.
      // Kyber and Bebop quote all of them, and CoW's flow is far wider than two
      // pairs: with only those two, twelve consecutive settlements matched none.
      {
        ticker: 'ETH_USDT',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'USDT', decimals: 6, addresses: [USDT_ETHEREUM] },
      },
      {
        ticker: 'ETH_DAI',
        base: { symbol: 'ETH', decimals: 18, addresses: [WETH_ETHEREUM, NATIVE_SENTINEL] },
        quote: { symbol: 'DAI', decimals: 18, addresses: [DAI_ETHEREUM] },
      },
      {
        ticker: 'WBTC_USDT',
        base: { symbol: 'WBTC', decimals: 8, addresses: [WBTC_ETHEREUM] },
        quote: { symbol: 'USDT', decimals: 6, addresses: [USDT_ETHEREUM] },
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
    venues: ['kalqix', 'kyber', 'bebop'],
    nativeTicker: 'ETH_USDC',
    nativeSymbol: 'ETH',
    stableSymbol: 'USDC',
    kyberOnlySkipPairs: [],
    reportCaveats: [
      'Orders here are CoW trades that have already settled: CoW\'s open-order endpoint is solver-only, so they cannot be observed while live. This is therefore a price comparison, not a race — there is no lead time and no "profitable too late" verdict, because we never saw the order in flight.',
      'Venue quotes are necessarily taken after the settling block. The lag is recorded per tick and a comparison beyond the degraded threshold is marked as such.',
    ],
  },
};
profiles.eth = profiles.ethereum!;
profiles.bnb = profiles.bsc!;
profiles.cowswapresolver = profiles.cowswapResolver!;
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
  kalqixTakerFeeBps: 8n,
  safetyMarginBps: 10n,
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
    feeBps: 3n,
    /** settlement tx gas for an RFQ self-execution fill */
    gasUnits: 250_000n,
    /** a tick using stream data older than this is bebop-degraded */
    degradedAgeMs: 5000,
    /** the stream is chatty (all pairs, sub-second); a minute of silence = dead socket */
    staleReconnectMs: 60_000,
  },
  // CoW Protocol. Kept for the order-source work: the quote endpoint is public
  // and needs no key. Note /auction — the open-order set — is solver-only (403).
  cow: {
    apiBase: 'https://api.cow.fi',
    chainSlug: profile.cowChainSlug ?? null,
    /** quotes need a from/receiver to be returned; nothing is signed or sent */
    quoteFrom: '0x0000000000000000000000000000000000000001',
    feeBps: 3n,
    quoteIntervalMs: 2000,
    quoteTimeoutMs: 5000,
    degradedQuoteAgeMs: 5000,
    /** how often to look for newly settled trades; ~one Ethereum block */
    settlementPollMs: 12_000,
    /** cap on blocks per getLogs call, so a long outage backfills gradually */
    maxBlockSpan: 200,
  },
  pancake: {
    /** our assumed markup on a PancakeSwap-hedged fill, same basis as the others */
    feeBps: 3n,
    /** a tick using a quote older than this, or for a stale size, is degraded */
    degradedQuoteAgeMs: 5000,
  },
  kyber: {
    apiBase: 'https://aggregator-api.kyberswap.com',
    chainSlug: profile.kyberChainSlug,
    clientId: 'shadow-resolver',
    /** our assumed markup on a Kyber-hedged fill */
    feeBps: 3n,
    /** fallback swap-leg gas units when the quote carries no estimate */
    fallbackGasUnits: 400_000n,
    quoteIntervalMs: 2000,
    quoteTimeoutMs: 4000,
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
  orderSource: 'fusion' | 'cow';
  venues: Array<'kalqix' | 'kyber' | 'bebop' | 'pancake'>;
}

export const allChains: ResolvedChain[] = ['ethereum', 'bsc', 'cowswapResolver'].map((key) => {
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
