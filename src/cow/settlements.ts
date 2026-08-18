/** Settled CoW trades, read from chain logs.
 *
 *  CoW's open-order set (`/api/v1/auction`) is solver-only — it answers 403 to
 *  everyone else — so an order cannot be watched while it is live. What is
 *  public is every settlement, because GPv2Settlement emits a Trade event per
 *  filled order. That is the feed here.
 *
 *  The consequence is baked into the analysis downstream: we compare prices
 *  after the fact, never speed. See SPEC-cowswap-resolver.md. */
import { config } from '../../config.js';
import { logError } from '../log.js';

/** GPv2Settlement, the same address on every network CoW runs on. */
export const SETTLEMENT_ADDRESS = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';

/** keccak("Trade(address,address,address,uint256,uint256,uint256,bytes)") */
export const TRADE_TOPIC = '0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17';

export interface CowTrade {
  /** the order's uid, unique per order — used as our order_hash */
  orderUid: string;
  owner: string;
  sellToken: string;
  buyToken: string;
  /** what the user gave up, including CoW's fee */
  sellAmount: bigint;
  /** what the user received — the number a rival venue has to beat */
  buyAmount: bigint;
  feeAmount: bigint;
  blockNumber: number;
  blockTsMs: number;
  txHash: string;
}

const word = (data: string, i: number): bigint => BigInt('0x' + data.slice(i * 64, (i + 1) * 64));
const addrAt = (data: string, i: number): string => '0x' + data.slice(i * 64 + 24, (i + 1) * 64);

/** Decode one Trade log.
 *
 *  Layout is (sellToken, buyToken, sellAmount, buyAmount, feeAmount, orderUid),
 *  with owner indexed in topic 1 and orderUid a dynamic `bytes` — so word 5 is
 *  its offset, and the length precedes the data at that offset. */
export function decodeTrade(log: {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}): CowTrade | null {
  try {
    const d = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
    if (d.length < 6 * 64) return null;
    const uidOffsetBytes = Number(word(d, 5));
    const uidStart = uidOffsetBytes * 2;
    const uidLen = Number(word(d, uidOffsetBytes / 32)) * 2;
    const orderUid = '0x' + d.slice(uidStart + 64, uidStart + 64 + uidLen);
    return {
      orderUid,
      owner: '0x' + (log.topics[1] ?? '').slice(26),
      sellToken: addrAt(d, 0),
      buyToken: addrAt(d, 1),
      sellAmount: word(d, 2),
      buyAmount: word(d, 3),
      feeAmount: word(d, 4),
      blockNumber: Number(BigInt(log.blockNumber)),
      blockTsMs: 0, // filled in by the caller, which knows the block
      txHash: log.transactionHash,
    };
  } catch {
    return null;
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.baseRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result as T;
}

/** Polls for newly settled trades.
 *
 *  Deliberately stays a few blocks behind the head: a log read at the tip can be
 *  reorged away, and a trade that never happened would pollute the comparison. */
export class SettlementFeed {
  private lastBlock = 0;
  tradeCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(
    private readonly onTrade: (t: CowTrade) => void,
    private readonly confirmations = 3
  ) {}

  async start(): Promise<void> {
    const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])));
    // Start a little behind so the first poll has something to report.
    this.lastBlock = head - this.confirmations - 5;
    this.timer = setInterval(() => void this.poll(), config.cow.settlementPollMs);
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])));
      const to = head - this.confirmations;
      if (to <= this.lastBlock) return;
      // Bound the span so a long outage doesn't ask for thousands of blocks at
      // once; the rest is picked up on subsequent polls.
      const from = Math.max(this.lastBlock + 1, to - config.cow.maxBlockSpan + 1);
      const logs = await rpc<Array<{ topics: string[]; data: string; blockNumber: string; transactionHash: string }>>(
        'eth_getLogs',
        [{ address: SETTLEMENT_ADDRESS, topics: [TRADE_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]
      );
      const tsCache = new Map<number, number>();
      for (const log of logs) {
        if (this.stopped) return;
        const trade = decodeTrade(log);
        if (!trade) continue;
        let ts = tsCache.get(trade.blockNumber);
        if (ts === undefined) {
          const block = await rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [
            '0x' + trade.blockNumber.toString(16),
            false,
          ]);
          ts = block ? Number(BigInt(block.timestamp)) * 1000 : Date.now();
          tsCache.set(trade.blockNumber, ts);
        }
        trade.blockTsMs = ts;
        this.tradeCount++;
        this.onTrade(trade);
      }
      this.lastBlock = to;
    } catch (err) {
      logError('cow settlement poll failed', err);
    } finally {
      this.inFlight = false;
    }
  }
}
