/** One Bebop stream, shared by every collector on this chain.
 *
 *  The API key admits exactly one live pricing socket per chain. When the
 *  Ethereum collector and the cowswapResolver each opened their own, whichever
 *  connected first held it and the other got `503` on every attempt, forever —
 *  so the cow dataset recorded "no data" for Bebop on every trade while the
 *  Ethereum collector was fine. The two also traded the slot back and forth,
 *  which is what produced tens of thousands of reconnect lines in the logs.
 *
 *  This process owns the single allowed connection and serves what it hears
 *  over loopback. Bebop sees exactly one stream, as before; the number of
 *  consumers on our side stops being their problem.
 *
 *  Run one per chain that has more than one consumer:
 *
 *    CHAIN=ethereum npx tsx src/bebop/relay.ts
 */
import { createServer } from 'node:http';
import { config } from '../../config.js';
import { BebopFeed } from './feed.js';
import { booksSince } from './relay-protocol.js';
import { log, logError } from '../log.js';

const feed = new BebopFeed();
await feed.start();

/** Books change constantly, so a client asks only for what moved since its last
 *  poll. A full snapshot is ~300 KB; the deltas are a small fraction of that,
 *  and a client that has fallen behind simply gets more of them. */
function snapshot(sinceMs: number): string {
  const { books, maxTsMs } = booksSince(feed.books, sinceMs);
  return JSON.stringify({
    enabled: feed.enabled,
    state: feed.state,
    messageCount: feed.messageCount,
    staleReconnects: feed.staleReconnects,
    pairs: feed.books.size,
    decimals: sinceMs === 0 ? [...feed.decimals] : null,
    maxTsMs,
    books,
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/books') {
    res.writeHead(404).end();
    return;
  }
  const since = Number(url.searchParams.get('since') ?? 0);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(snapshot(Number.isFinite(since) ? since : 0));
});

server.listen(config.bebop.relayPort, '127.0.0.1', () => {
  log(`bebop relay listening on 127.0.0.1:${config.bebop.relayPort} (${config.bebop.chainSlug})`);
});
// A relay that cannot serve is worse than no relay: it holds the Bebop socket
// while every consumer reads nothing and reports "no data". Exiting hands the
// problem to the supervisor instead of hiding it. This is not hypothetical —
// 8790 was already bound by next-server, and the relay ran headless for
// fifteen minutes with a perfectly healthy stream nobody could reach.
server.on('error', (err) => {
  logError('bebop relay cannot listen, exiting', err);
  feed.stop();
  process.exit(1);
});

const status = setInterval(() => {
  log(
    `relay status: ${feed.state} pairs=${feed.books.size} msgs=${feed.messageCount} ` +
      `staleReconnects=${feed.staleReconnects}`
  );
}, 60_000);

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log('SIGINT: shutting down relay...');
  clearInterval(status);
  feed.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
process.on('SIGTERM', () => process.emit('SIGINT'));
