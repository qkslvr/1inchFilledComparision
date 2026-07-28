import { NATIVE_SENTINEL } from '../../config.js';
import { ethCall } from './rpc.js';

const SYMBOL_SELECTOR = '0x95d89b41'; // symbol()

/** Decode a symbol() return: standard ABI string or legacy bytes32 (MKR-style). */
export function decodeSymbol(hex: string): string | null {
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

/** One symbol() call. null means the token doesn't answer usefully — the caller
 *  records that too, so a dead token isn't retried on every pass. */
export async function resolveSymbol(address: string, rpcUrl?: string): Promise<string | null> {
  const addr = address.toLowerCase();
  if (addr === NATIVE_SENTINEL) return 'ETH';
  try {
    return decodeSymbol(await ethCall(addr, SYMBOL_SELECTOR, rpcUrl));
  } catch {
    return null;
  }
}
