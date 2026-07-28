import { NATIVE_SENTINEL } from '../../config.js';
import { ethCall } from './rpc.js';

const SYMBOL_SELECTOR = '0x95d89b41'; // symbol()
const MAX_RESOLVES_PER_TICK = 3;

/** rpcUrl -> (address -> symbol); null = resolution failed (don't retry).
 *  Keyed per RPC so a combined multi-chain reader resolves against the right chain. */
const caches = new Map<string, Map<string, string | null>>();
const inFlight = new Set<string>();
let startedThisTick = 0;

function cacheFor(rpcUrl: string | undefined): Map<string, string | null> {
  const key = rpcUrl ?? 'default';
  let c = caches.get(key);
  if (!c) {
    c = new Map();
    caches.set(key, c);
  }
  return c;
}

/** Decode a symbol() return: standard ABI string or legacy bytes32 (MKR-style). */
function decodeSymbol(hex: string): string | null {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (raw.length === 0) return null;
  let bytes: Buffer;
  if (raw.length === 64) {
    bytes = Buffer.from(raw, 'hex'); // bytes32, right-padded
  } else if (raw.length >= 128) {
    const len = Number(BigInt('0x' + raw.slice(64, 128)));
    if (len === 0 || len > 32) return null;
    bytes = Buffer.from(raw.slice(128, 128 + len * 2), 'hex');
  } else {
    return null;
  }
  const s = bytes.toString('utf8').replace(/\0+$/, '').trim();
  return /^[\x21-\x7e]{1,20}$/.test(s) ? s : null;
}

/** Synchronous cache read; a miss kicks off background resolution so the
 *  symbol appears on a later dashboard refresh. Resets the per-call budget
 *  counter via resetResolveBudget() once per data collection. */
export function symbolFor(address: string, rpcUrl?: string): string | null {
  const addr = address.toLowerCase();
  if (addr === NATIVE_SENTINEL) return 'ETH';
  const cache = cacheFor(rpcUrl);
  if (cache.has(addr)) return cache.get(addr)!;
  const flightKey = `${rpcUrl ?? 'default'}|${addr}`;
  if (!inFlight.has(flightKey) && startedThisTick < MAX_RESOLVES_PER_TICK) {
    inFlight.add(flightKey);
    startedThisTick++;
    void ethCall(addr, SYMBOL_SELECTOR, rpcUrl)
      .then((res) => cache.set(addr, decodeSymbol(res)))
      .catch(() => cache.set(addr, null))
      .finally(() => inFlight.delete(flightKey));
  }
  return null;
}

export function resetResolveBudget(): void {
  startedThisTick = 0;
}

/** Display helper: resolved symbol or a short address stub. */
export function tokenLabel(address: string, rpcUrl?: string): string {
  return symbolFor(address, rpcUrl) ?? address.slice(0, 8) + '..';
}
