/** A poll slot shared between every process on this host.
 *
 *  CoW's rate limit is per-IP and shared across chains — a mainnet request
 *  followed a second later by an Arbitrum one is refused — so two solver
 *  processes cannot each keep to a safe interval and expect the pair of them to
 *  be safe. Slowing both to 15s did not fix it: the busier dataset kept the
 *  bucket drained and the quieter one lost every race, sitting at zero
 *  discovered orders while logging a 429 for almost every attempt.
 *
 *  Independent budgets cannot solve a shared limit. This is the smallest thing
 *  that can: one file whose modification time is the last poll by anybody, so
 *  the processes take turns rather than compete.
 *
 *  Not a true mutex — two processes can in principle read the same stale
 *  timestamp and both proceed. That costs one 429, which is the situation
 *  already, and the jittered start makes it rare. A lock daemon would be
 *  airtight and is not worth a second process to supervise. */
import { closeSync, openSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config.js';

const GATE = join(tmpdir(), 'cow-poll-gate');

/** Take the shared slot, or report that someone else has it. */
export function takePollSlot(minIntervalMs: number = config.cow.sharedPollMinIntervalMs): boolean {
  const now = Date.now();
  let lastMs = 0;
  try {
    lastMs = statSync(GATE).mtimeMs;
  } catch {
    // First run on this host: create it and take the slot.
    try {
      closeSync(openSync(GATE, 'w'));
    } catch {
      // If we cannot even create it, fall through and poll — losing the gate
      // should degrade to the old behaviour, not stop the collector entirely.
      return true;
    }
    return true;
  }
  if (now - lastMs < minIntervalMs) return false;
  try {
    const t = now / 1000;
    utimesSync(GATE, t, t);
  } catch {
    return true;
  }
  return true;
}

/** Wait for the slot instead of giving up on it.
 *
 *  Periodic polls should skip a denied tick — another will come. A one-off
 *  lookup should not: dropping it loses the order permanently, and discovery is
 *  the whole point. So lookups queue behind the gate rather than failing, up to
 *  a bound past which the order has usually expired anyway. */
export async function awaitPollSlot(minIntervalMs: number, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    if (takePollSlot(minIntervalMs)) return true;
    if (Date.now() >= deadline) return false;
    const wait = Math.min(pollSlotWaitMs(minIntervalMs) + 50, deadline - Date.now());
    await new Promise((r) => setTimeout(r, Math.max(50, wait)));
  }
}

/** How long until the slot frees up, for logging that is not just "denied". */
export function pollSlotWaitMs(minIntervalMs: number = config.cow.sharedPollMinIntervalMs): number {
  try {
    return Math.max(0, minIntervalMs - (Date.now() - statSync(GATE).mtimeMs));
  } catch {
    return 0;
  }
}
