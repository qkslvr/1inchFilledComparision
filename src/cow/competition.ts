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
const BY_TX = 'https://api.cow.fi/mainnet/api/v2/solver_competition/by_tx_hash';

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
  auction?: { orders?: string[]; prices?: Record<string, string> };
}

/** Everything one auction tells us, including the parts the shadow dataset
 *  ignores: the open-order set and the native price vector.
 *
 *  `orders` is the solvable set — every order a solver could have included,
 *  most of which did not settle in this auction. That is the open-order feed
 *  the solver simulation bids into.
 *
 *  `prices` values a token atom in native wei, scaled by 1e18: a surplus is
 *  worth `amount * price / 1e18`. It is what makes our own score commensurable
 *  with the winner's rather than a proxy for it. */
export interface CowAuctionSnapshot {
  competition: CowCompetition;
  /** uids solvable in this auction */
  orderUids: string[];
  /** lowercased token address -> native price, 1e18-scaled */
  prices: Map<string, bigint>;
  /** the orders the winner actually settled, with executed amounts */
  settled: Array<{ uid: string; sellAmount: bigint; buyAmount: bigint; buyToken: string; sellToken: string }>;
  /** Every proposal made for each order, across all solutions.
   *
   *  A solution's `score` covers its whole bundle, so comparing our single-order
   *  bid against it is not like for like — a solver bundling five orders will
   *  out-score us on volume alone while possibly offering that user less. What
   *  each solution *does* report per order is the buyAmount it would deliver,
   *  and that is directly comparable: scored against the same limit and the same
   *  auction price, it is what a rival offered on the order we bid on. */
  proposalsByOrder: Map<string, Array<{ solver: string; buyAmount: bigint; sellAmount: bigint; isWinner: boolean }>>;
}

export function parseAuctionSnapshot(raw: RawCompetition): CowAuctionSnapshot | null {
  const parsed = tradesFromCompetition(raw);
  if (!parsed) return null;
  const prices = new Map<string, bigint>();
  for (const [token, px] of Object.entries(raw.auction?.prices ?? {})) {
    try {
      prices.set(token.toLowerCase(), BigInt(px));
    } catch {
      // a price we cannot parse is simply a token we cannot score
    }
  }
  const proposalsByOrder = new Map<string, Array<{ solver: string; buyAmount: bigint; sellAmount: bigint; isWinner: boolean }>>();
  for (const sol of raw.solutions ?? []) {
    for (const o of sol.orders ?? []) {
      if (!o.id || !o.buyAmount || !o.sellAmount) continue;
      const list = proposalsByOrder.get(o.id) ?? [];
      list.push({
        solver: (sol.solverAddress ?? '').toLowerCase(),
        buyAmount: BigInt(o.buyAmount),
        // The spend side, which is where a buy order's surplus lives.
        sellAmount: BigInt(o.sellAmount),
        isWinner: sol.isWinner === true,
      });
      proposalsByOrder.set(o.id, list);
    }
  }

  return {
    competition: parsed.competition,
    orderUids: raw.auction?.orders ?? [],
    prices,
    proposalsByOrder,
    settled: parsed.trades.map((t) => ({
      uid: t.orderUid,
      sellAmount: t.sellAmount,
      buyAmount: t.buyAmount,
      buyToken: t.buyToken,
      sellToken: t.sellToken,
    })),
  };
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

/** The competition behind a settlement we found on chain.
 *
 *  The live feed returns one auction at a time, so when several are decided
 *  between polls we lose the ones in between and only meet those trades later,
 *  in a Trade log. Looking the auction up by its settlement hash recovers the
 *  solver scores for exactly those, which is the difference between a row that
 *  can answer "would we have won" and one that cannot. */
const byTxCache = new Map<string, CowCompetition | null>();

export async function fetchCompetitionByTx(txHash: string): Promise<CowCompetition | null> {
  // One settlement can carry several trades, and each was firing its own
  // identical lookup — a burst per block, which is the shape most likely to
  // have earned the 429s.
  const hit = byTxCache.get(txHash);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(`${BY_TX}/${txHash}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    // Do not cache a rate-limited miss: it says nothing about the auction and
    // would make one unlucky moment permanent for that settlement.
    if (!res.ok) return null;
    const comp = tradesFromCompetition((await res.json()) as RawCompetition)?.competition ?? null;
    if (byTxCache.size > 500) byTxCache.clear();
    byTxCache.set(txHash, comp);
    return comp;
  } catch (err) {
    logError(`cow competition lookup failed for ${txHash.slice(0, 12)}`, err);
    return null;
  }
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
  /** Set when the API pushes back; polling resumes after it. */
  private backoffUntilMs = 0;

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
    if (this.inFlight || this.stopped || Date.now() < this.backoffUntilMs) return;
    this.inFlight = true;
    try {
      const res = await fetch(LATEST, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        // Sit out a whole advance cycle rather than retrying into the wall.
        this.backoffUntilMs = Date.now() + config.cow.rateLimitBackoffMs;
        throw new Error('HTTP 429');
      }
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
