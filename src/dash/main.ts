/** Local dashboard server.
 *
 *  Two shapes of page, one template:
 *    /                  every dataset, switched by the tab strip
 *    /<datasetKey>      that dataset alone, tabs hidden — e.g. /cowswapResolver
 *
 *  The scoped route exists because the datasets answer different questions:
 *  the chain tabs ask whether we could have beaten a 1inch Fusion auction,
 *  cowswapResolver asks whether a CoW solver left money on the table. Giving
 *  that its own URL makes it linkable rather than a tab someone has to find. */
import { createServer } from 'node:http';
import { allChains } from '../../config.js';
import { collectAll } from './collect.js';
import { PAGE } from './page.js';
import { log, logError } from '../log.js';

const PORT = Number(process.env.DASH_PORT ?? 8787);
const HOST = process.env.DASH_HOST ?? '127.0.0.1';

/** Dataset keys, matched case-insensitively so /cowswapresolver works too. */
const datasets = new Map(allChains.map((c) => [c.key.toLowerCase(), c.key]));

/** Inject the scope the page script reads. Escaped for `</script>` safety even
 *  though these keys are ours, because that is how the next one gets in. */
function scopedPage(key: string): string {
  const safe = JSON.stringify(key).replace(/</g, '\\u003c');
  return PAGE.replace('<nav class="tabs" id="tabs"></nav>', `<script>window.__DATASET__=${safe};</script>\n<nav class="tabs" id="tabs"></nav>`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/data.json') {
    void (async () => {
      try {
        const requested = url.searchParams.get('dataset');
        const key = requested === null ? undefined : datasets.get(requested.toLowerCase());
        if (requested !== null && key === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `unknown dataset "${requested}"` }));
          return;
        }
        const data = await collectAll(key);
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

  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }

  const key = datasets.get(path.slice(1).toLowerCase());
  if (key !== undefined) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(scopedPage(key));
    return;
  }

  // Anything else is a genuine 404 rather than the dashboard, so a typo in a
  // dataset name is obvious instead of silently showing the combined page.
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end(
    `<body style="background:#0E1114;color:#E7EAEE;font:14px system-ui;padding:40px">` +
      `<h1 style="font-size:20px">Not found</h1><p>Available: ` +
      ['/', ...allChains.map((c) => `/${c.key}`)].map((p) => `<a style="color:#8B9CF0" href="${p}">${p}</a>`).join(' · ') +
      `</p></body>`
  );
});

server.listen(PORT, HOST, () => {
  log(`dashboard: http://${HOST}:${PORT} (read-only, refreshes every 5s)`);
  for (const c of allChains) log(`  /${c.key} -> ${c.label}`);
});
