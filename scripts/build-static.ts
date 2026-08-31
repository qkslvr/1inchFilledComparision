/** Writes public/ from the PAGE template. Keeps src/dash/page.ts the single
 *  source of the dashboard shell: the local server serves it from memory,
 *  Vercel serves these files statically.
 *
 *  One file per dataset as well as index.html. The page picks its dataset from
 *  location.pathname, so the HTML is identical — but Vercel only serves paths
 *  that exist, and with just index.html every /<dataset> URL 404s unless someone
 *  adds a rewrite by hand in the project settings. Emitting a file per dataset
 *  makes routing follow from the repo instead, so a new dataset works the moment
 *  it is added to allChains. `cleanUrls` in vercel.json is what lets /cicada
 *  resolve to cicada.html. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PAGE } from '../src/dash/page.js';
import { allChains } from '../config.js';

mkdirSync('public', { recursive: true });
writeFileSync('public/index.html', PAGE);
const written = ['index.html'];
for (const c of allChains) {
  writeFileSync(`public/${c.key}.html`, PAGE);
  written.push(`${c.key}.html`);
}
console.log(`public/: ${written.join(', ')} (${PAGE.length} bytes each)`);
