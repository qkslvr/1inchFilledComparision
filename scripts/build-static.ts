/** Writes public/index.html from the PAGE template. Keeps src/dash/page.ts the
 *  single source of the dashboard shell: the local server serves it from
 *  memory, Vercel serves this file statically. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PAGE } from '../src/dash/page.js';

mkdirSync('public', { recursive: true });
writeFileSync('public/index.html', PAGE);
console.log(`public/index.html written (${PAGE.length} bytes)`);
