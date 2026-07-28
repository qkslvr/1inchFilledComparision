import { writeFileSync } from 'node:fs';
import { config } from '../../config.js';
import { Db } from '../db/db.js';
import { computeReport } from './compute.js';
import { renderMarkdown } from './render.js';
import { log } from '../log.js';

const db = await Db.open(config.chainId, { readonly: true });
const data = await computeReport(db);
await db.close();

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
