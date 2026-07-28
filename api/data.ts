/** Vercel serverless reader. vercel.json rewrites /data.json here, so the page
 *  fetches a same-origin URL and no CORS is involved.
 *
 *  Read-only by construction: DATABASE_URL here should be the read-only role,
 *  and every query behind collectAll() is a SELECT. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectAll } from '../src/dash/collect.js';

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await collectAll();
    // The page polls every 5s; a 4s shared cache keeps several open tabs from
    // multiplying into connection pressure on a Postgres with no pooler.
    res.setHeader('Cache-Control', 's-maxage=4, stale-while-revalidate=30');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}
