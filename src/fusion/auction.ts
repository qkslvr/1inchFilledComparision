import {
  Address,
  AuctionDetails,
  Extension,
  FusionOrder,
  type LimitOrderV4Struct,
} from '@1inch/fusion-sdk';

/** Taker identity used for cost math. Not whitelisted, so any whitelist-gated fee
 *  discount does NOT apply — costs are the undiscounted (conservative) ones. */
const SHADOW_TAKER = Address.ZERO_ADDRESS;

export interface DecodedOrder {
  fusionOrder: FusionOrder;
  auctionStartMs: number;
  auctionDurationS: number;
  initialRateBump: number;
  pointsJson: string;
  gasBumpEstimate: bigint;
  gasPriceEstimate: bigint;
  allowPartialFills: boolean;
  allowMultipleFills: boolean;
  deadlineMs: number;
}

/** Decode auction params locally from the order struct + extension hex
 *  (no REST call). Throws on malformed extensions. */
export function decodeOrder(order: LimitOrderV4Struct, extensionHex: string): DecodedOrder {
  const extension = Extension.decode(extensionHex);
  const fusionOrder = FusionOrder.fromDataAndExtension(order, extension);
  const details = AuctionDetails.fromExtension(extension);
  return {
    fusionOrder,
    auctionStartMs: Number(details.startTime) * 1000,
    auctionDurationS: Number(details.duration),
    initialRateBump: Number(details.initialRateBump),
    pointsJson: JSON.stringify(details.points),
    gasBumpEstimate: details.gasCost.gasBumpEstimate,
    gasPriceEstimate: details.gasCost.gasPriceEstimate,
    allowPartialFills: fusionOrder.partialFillAllowed,
    allowMultipleFills: fusionOrder.multipleFillsAllowed,
    deadlineMs: Number(fusionOrder.deadline) * 1000,
  };
}

/** All-in taking amount (auction bump + resolver/integrator/protocol fees + surplus)
 *  required to fill `makingAmount` of the order at `timeSec`. */
export function costAt(
  decoded: DecodedOrder,
  makingAmount: bigint,
  timeSec: bigint,
  blockBaseFeeWei: bigint
): bigint {
  return decoded.fusionOrder.calcTakingAmount(SHADOW_TAKER, makingAmount, timeSec, blockBaseFeeWei);
}

/** Raw auction rate bump at `timeSec` (RATE_BUMP_DENOMINATOR = 10_000_000 = 100%). */
export function rateBumpAt(decoded: DecodedOrder, timeSec: bigint, blockBaseFeeWei: bigint): number {
  return decoded.fusionOrder.getCalculator().calcRateBump(timeSec, blockBaseFeeWei);
}

/** True while only the exclusive resolver may fill; our shadow resolver could not. */
export function isExclusiveAt(decoded: DecodedOrder, timeSec: bigint): boolean {
  try {
    return decoded.fusionOrder.isExclusivityPeriod(timeSec);
  } catch {
    return false;
  }
}
