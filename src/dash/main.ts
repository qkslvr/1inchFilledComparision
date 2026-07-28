/** Local dashboard server. Same data and same page as the Vercel deployment —
 *  this is the one you run on the collector box when you don't want to go
 *  through the internet to look at your own machine. */
import { createServer } from 'node:http';
import { collectAll } from './collect.js';
import { PAGE } from './page.js';
import { log, logError } from '../log.js';

const PORT = Number(process.env.DASH_PORT ?? 8787);
const HOST = process.env.DASH_HOST ?? '127.0.0.1';

const server = createServer((req, res) => {
  if (req.url === '/data.json') {
    void (async () => {
      try {
        const data = await collectAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        logError('data collection failed', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    })();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE);
});

server.listen(PORT, HOST, () => {
  log(`dashboard: http://${HOST}:${PORT} (read-only, refreshes every 5s)`);
});
