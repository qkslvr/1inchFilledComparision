import { writeFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { config } from '../../config.js';
import { ensureMigrated } from '../db/db.js';
import { computeReport } from './compute.js';
import { renderMarkdown } from './render.js';
import { log } from '../log.js';

if (!existsSync(config.dbPath)) {
  console.error(`database not found at ${config.dbPath}; run the collector first`);
  process.exit(1);
}

ensureMigrated(config.dbPath);
const db = new Database(config.dbPath, { readonly: true });
const data = computeReport(db);
db.close();

const md = renderMarkdown(data);
writeFileSync('report.md', md);

// report.json: same numbers, machine readable; keep per-order outcomes but
// serialize bigints as strings
const json = JSON.stringify(
  data,
  (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  2
);
writeFileSync('report.json', json);

log(
  `report written: report.md, report.json ` +
    `(${data.headline.winCount} wins, ${data.headline.capturableGrossMarginUsdcPerDay.toFixed(2)} USDC/day over ${data.observedActiveHours.toFixed(1)}h)`
);
