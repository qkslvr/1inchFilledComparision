/** Live CoW auctions, read from the public solver-competition feed.
 *
 *  `/api/v1/auction` — the solvable-order set — is permissioned and answers 403,
 *  which is why this dataset began as a post-hoc reading of settlement logs. But
 *  `/api/v2/solver_competition/latest` is public, unauthenticated, and carries
 *  the same information in a more useful form:
 *
 *    - the winning solution's orders, with sellToken/buyToken/sellAmount/
 *      buyAmount inline, so no per-order lookup is needed;
 *    - every competing solver's score and ranking, which is the bar we would
 *      have had to clear;
 *    - the auction's start and deadline blocks, so a quote can be timed against
 *      the block the solvers were themselves solving.
 *
 *  It advances about once per block. Reading it instead of waiting for a `Trade`
 *  log removes the settlement lag that used to sit between the fill and our
 *  quote — the drift in that window was the same order of magnitude as the edge
 *  being measured.
 *
 *  Only the winner's orders are emitted. The auction also lists ~7,600 solvable
 *  order uids, but a sample of those is entirely long-dated resting limit
 *  orders; ticking them would flood the database for no signal, which is the
 *  failure long-dated BNB orders already caused once. */
import { config } from '../../config.js';
import { logError } from '../log.js';
import { blockTimestampMs, type CowTrade } from './settlements.js';

const LATEST = 'https://api.cow.fi/mainnet/api/v2/solver_competition/latest';

/** What the auction cost us to win, and who we would have had to beat. */
export interface CowCompetition {
  auctionId: number;
  startBlock: number;
  deadlineBlock: number;
  /** how many solvers submitted a solution */
  solverCount: number;
  winnerSolver: string | null;
  /** the winner's score, in wei of native token — surplus as CoW measures it */
  winnerScore: bigint | null;
  /** the runner-up bar the winner had to clear */
  referenceScore: bigint | null;
  txHash: string | null;
  /** when we read it, so the gap to the block can be measured */
  seenAtMs: number;
}

interface RawSolution {
  solverAddress?: string;
  score?: string;
  ranking?: number;
  isWinner?: boolean;
  txHash?: string | null;
  referenceScore?: string | null;
  orders?: Array<{
    id?: string;
    sellToken?: string;
    buyToken?: string;
    sellAmount?: string;
    buyAmount?: string;
  }>;
}

interface RawCompetition {
  auctionId?: number;
  auctionStartBlock?: number;
  auctionDeadlineBlock?: number;
  transactionHashes?: string[];
  solutions?: RawSolution[];
}

/** A CoW order uid is 56 bytes: a 32-byte order digest, then the 20-byte owner,
 *  then a 4-byte validTo. The competition feed never names the owner, but it is
 *  sitting in the uid, so no extra lookup is needed to recover it. */
export function ownerFromUid(uid: string): string {
  const hex = uid.startsWith('0x') ? uid.slice(2) : uid;
  if (hex.length < 104) return '0x';
  return '0x' + hex.slice(64, 104);
}

/** Pull the settled trades out of one competition payload.
 *
 *  Exported separately from the polling so it can be tested against a captured
 *  response without a network. */
export function tradesFromCompetition(
  raw: RawCompetition
): { competition: CowCompetition; trades: Omit<CowTrade, 'blockTsMs'>[] } | null {
  const auctionId = raw.auctionId;
  const deadlineBlock = raw.auctionDeadlineBlock;
  if (typeof auctionId !== 'number' || typeof deadlineBlock !== 'number') return null;

  const solutions = raw.solutions ?? [];
  const winner = solutions.find((s) => s.isWinner);
  const txHash = raw.transactionHashes?.[0] ?? winner?.txHash ?? null;

  const competition: CowCompetition = {
    auctionId,
    startBlock: raw.auctionStartBlock ?? deadlineBlock,
    deadlineBlock,
    solverCount: solutions.length,
    winnerSolver: winner?.solverAddress ?? null,
    winnerScore: winner?.score ? BigInt(winner.score) : null,
    referenceScore: winner?.referenceScore ? BigInt(winner.referenceScore) : null,
    txHash,
    seenAtMs: Date.now(),
  };

  // Only the winner's orders actually settle. A losing solver's bid describes a
  // trade that never happened, and pricing it would invent flow.
  const trades: Omit<CowTrade, 'blockTsMs'>[] = [];
  for (const o of winner?.orders ?? []) {
    if (!o.id || !o.sellToken || !o.buyToken || !o.sellAmount || !o.buyAmount) continue;
    trades.push({
      orderUid: o.id,
      owner: ownerFromUid(o.id),
      sellToken: o.sellToken.toLowerCase(),
      buyToken: o.buyToken.toLowerCase(),
      sellAmount: BigInt(o.sellAmount),
      buyAmount: BigInt(o.buyAmount),
      // The competition feed reports the economics, not the protocol fee. It is
      // not part of the edge — what we must pay the user is buyAmount — so a
      // zero here is accurate rather than a placeholder.
      feeAmount: 0n,
      blockNumber: deadlineBlock,
      txHash: txHash ?? '',
    });
  }
  return { competition, trades };
}

/** Polls the public competition feed for newly decided auctions. */
export class CompetitionFeed {
  private lastAuctionId = 0;
  auctionCount = 0;
  tradeCount = 0;
  lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(private readonly onTrade: (t: CowTrade, c: CowCompetition) => void) {}

  async start(): Promise<void> {
    this.timer = setInterval(() => void this.poll(), config.cow.competitionPollMs);
    await this.poll();
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
      const res = await fetch(LATEST, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = tradesFromCompetition((await res.json()) as RawCompetition);
      if (!parsed) return;
      const { competition, trades } = parsed;
      // The feed repeats the same auction between blocks; only act on a new one.
      if (competition.auctionId <= this.lastAuctionId) return;
      this.lastAuctionId = competition.auctionId;
      this.auctionCount++;
      this.lastError = null;
      if (trades.length === 0) return;

      // One RPC per auction, shared by every trade in it. This is the instant
      // being evaluated: the block the solvers solved against.
      const blockTsMs = await blockTimestampMs(competition.deadlineBlock);
      for (const t of trades) {
        if (this.stopped) return;
        this.tradeCount++;
        this.onTrade({ ...t, blockTsMs }, competition);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logError('cow competition poll failed', err);
    } finally {
      this.inFlight = false;
    }
  }
}
