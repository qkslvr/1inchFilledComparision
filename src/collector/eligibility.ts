import { NATIVE_SENTINEL, config, pairForTokens } from '../../config.js';
import type { EligibilityResult } from '../types.js';

/** Map an order's token pair to a KalqiX market, or null if unsupported.
 *  hedgeAssetKind records how the ETH leg (if any) was denominated. */
export function classifyOrder(makerAsset: string, takerAsset: string): EligibilityResult | null {
  const mapped = pairForTokens(makerAsset, takerAsset);
  if (!mapped) return null;
  const maker = makerAsset.toLowerCase();
  const taker = takerAsset.toLowerCase();
  const hedgeAssetKind =
    maker === NATIVE_SENTINEL || taker === NATIVE_SENTINEL
      ? 'native'
      : maker === config.wethAddress || taker === config.wethAddress
        ? 'weth'
        : 'erc20';
  return { pair: mapped.pair, direction: mapped.direction, hedgeAssetKind };
}
