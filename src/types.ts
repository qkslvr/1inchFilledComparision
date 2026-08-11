export interface AssetConfig {
  symbol: string;
  decimals: number;
  /** Lowercased token addresses that map to this asset (WETH + native sentinel both map to ETH). */
  addresses: readonly string[];
}

export interface PairConfig {
  ticker: string;
  base: AssetConfig;
  quote: AssetConfig;
  /** The KalqiX market this pair hedges on, when one exists.
   *
   *  KalqiX lists only cbBTC/USDC and ETH/USDC, both settling on Base, so a
   *  pair on another chain hedges against whichever of those matches its asset
   *  — BNB has no market at all and simply goes unhedged there.
   *
   *  Its decimals are recorded because they need not match the order's: BTCB is
   *  18dp against cbBTC's 8, and BSC's USDT is 18dp against USDC's 6. The book
   *  is rescaled into this pair's units when it is parsed, so nothing
   *  downstream has to know the difference. */
  kalqix?: {
    /** market ticker in the KalqiX URL, e.g. cbBTC_USDC */
    ticker: string;
    baseDecimals: number;
    quoteDecimals: number;
  };
}

/** SELL_BASE: maker sells base for quote, we hedge by selling base into bids.
 *  BUY_BASE: maker sells quote for base, we hedge by buying base from asks. */
export type Direction = 'SELL_BASE' | 'BUY_BASE';

export type HedgeAssetKind = 'native' | 'weth' | 'erc20';

/** price: quote base-units per whole base unit; qty: base asset base-units. */
export interface BookLevel {
  price: bigint;
  qty: bigint;
}

/** bids descending by price, asks ascending; best at index 0. */
export interface ParsedBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface SnapshotRecord {
  id: number;
  ticker: string;
  tsMs: number;
  book: ParsedBook;
}

export interface GasSample {
  tsMs: number;
  gasPriceWei: bigint;
  baseFeeWei: bigint;
}

export interface EligibilityResult {
  pair: PairConfig;
  direction: Direction;
  hedgeAssetKind: HedgeAssetKind;
}

export interface WalkResult {
  /** Proceeds in takerAsset base units; null when the book cannot absorb the full size. */
  proceeds: bigint | null;
  /** Amount of input actually consumed (== input unless insufficient depth). */
  consumed: bigint;
}

export type EventKind =
  | 'ws_connected'
  | 'ws_disconnected'
  | 'ws_gap'
  | 'poll_fallback_start'
  | 'poll_fallback_stop'
  | 'sample_gap'
  | 'rest_429'
  | 'kalqix_429'
  | 'kyber_429'
  | 'rpc_error'
  | 'error_skip'
  | 'sweep_done'
  | 'clock_skew'
  | 'price_scale_check'
  | 'fee_schedule'
  | 'book_source'
  | 'bebop_connected'
  | 'bebop_disconnected';
