/** Background symbol resolution for the dashboard's unsupported-token table.
 *
 *  The SQLite dashboard resolved these lazily, in-process, while rendering. A
 *  serverless reader can't: its module cache dies with the instance and it has
 *  no business making RPC calls on a page load. So the collector — which owns
 *  an RPC endpoint and runs forever — fills the tokens table instead. */
import type { Db } from '../db/db.js';
import { resolveSymbol } from '../chain/tokens.js';
import { log } from '../log.js';

const INTERVAL_MS = 300_000;
const PER_PASS = 10;

export class TokenResolver {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  resolved = 0;

  constructor(private readonly db: Db, private readonly rpcUrl?: string) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pass(), INTERVAL_MS);
    this.timer.unref();
    void this.pass();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const addrs = await this.db.unresolvedTokens(PER_PASS);
      for (const addr of addrs) {
        // Recorded either way: a null symbol marks the address as tried, so the
        // next pass moves on to tokens we haven't seen yet.
        this.db.upsertToken(addr, await resolveSymbol(addr, this.rpcUrl));
        this.resolved++;
      }
      if (addrs.length > 0) log(`resolved ${addrs.length} token symbols`);
    } catch {
      // transient RPC or DB trouble; the next pass retries
    } finally {
      this.running = false;
    }
  }
}
