/** The relay's wire format, kept apart from the process that serves it.
 *
 *  relay.ts opens a socket at import time, so the selection logic lives here
 *  where it can be exercised without one. */
import type { BebopBook } from './feed.js';

export interface RelayPayload {
  enabled: boolean;
  state: string;
  messageCount: number;
  staleReconnects: number;
  pairs: number;
  /** only on a full sync; the token list is static and would dwarf the deltas */
  decimals: Array<[string, number]> | null;
  maxTsMs: number;
  books: Array<[string, BebopBook]>;
}

/** Books that changed after `sinceMs`, and the watermark to ask from next time.
 *
 *  The watermark starts at `sinceMs` rather than 0 so that a poll returning
 *  nothing does not rewind the client to a full resync on the following call. */
export function booksSince(
  books: Map<string, BebopBook>,
  sinceMs: number
): { books: Array<[string, BebopBook]>; maxTsMs: number } {
  const out: Array<[string, BebopBook]> = [];
  let maxTsMs = sinceMs;
  for (const [key, b] of books) {
    if (b.tsMs <= sinceMs) continue;
    if (b.tsMs > maxTsMs) maxTsMs = b.tsMs;
    out.push([key, b]);
  }
  return { books: out, maxTsMs };
}
