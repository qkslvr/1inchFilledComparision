/** Chooses how this process gets Bebop books.
 *
 *  The API key allows one live pricing socket per chain. A chain with a single
 *  collector opens it directly; where two datasets share a chain — Ethereum has
 *  both the Fusion collector and the cowswapResolver — they must both read from
 *  the relay, or they will take the connection from each other and one will sit
 *  on a permanent 503. */
import { config } from '../../config.js';
import { BebopFeed, type BebopSource } from './feed.js';
import { BebopRelayFeed } from './relay-client.js';

export function createBebopSource(
  onStateEvent?: (kind: 'bebop_connected' | 'bebop_disconnected') => void
): BebopSource {
  return config.bebop.mode === 'relay' ? new BebopRelayFeed(onStateEvent) : new BebopFeed(onStateEvent);
}
