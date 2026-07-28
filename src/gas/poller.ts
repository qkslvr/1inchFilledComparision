import { config } from '../../config.js';
import type { GasSample } from '../types.js';
import { getBaseFee, getGasPrice } from '../chain/rpc.js';
import { logError } from '../log.js';

/** Polls Base gas every gasPollIntervalMs; keeps the latest sample in memory
 *  and hands each one to `persist`. Pricing ticks read `latest` synchronously. */
export class GasPoller {
  latest: GasSample | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly persist: (sample: GasSample) => void,
    private readonly onError?: (err: unknown) => void
  ) {}

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll(), config.gasPollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      const [gasPriceWei, baseFeeWei] = await Promise.all([getGasPrice(), getBaseFee()]);
      this.latest = { tsMs: Date.now(), gasPriceWei, baseFeeWei };
      this.persist(this.latest);
    } catch (err) {
      logError('gas poll failed', err);
      this.onError?.(err);
    }
  }
}
