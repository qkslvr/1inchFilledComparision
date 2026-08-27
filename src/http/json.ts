/** HTTP for the venue and protocol APIs, deliberately not using fetch.
 *
 *  Node's fetch is refused by whatever sits in front of api.cow.fi. Measured on
 *  the same host, same second, same headers:
 *
 *    fetch (undici)              200 429 429 429 429
 *    https, new connection       200 200 200 200 200
 *    https, keep-alive reused    200 200 200 200 200
 *
 *  So it is not our rate, not connection reuse, and not the User-Agent — every
 *  header variant of fetch is refused equally. It is something about undici's
 *  request fingerprint, most likely that it negotiates HTTP/2 where the https
 *  module speaks HTTP/1.1, and Cloudflare treats the two differently.
 *
 *  The same is true of KyberSwap, which had been answering 429 to the app while
 *  serving curl from the same box with 28 of 30 requests still on the clock —
 *  so the chronic "Kyber rate limit" this project has worked around for days
 *  was never a rate limit either.
 *
 *  This cost a day. The Arbitrum dataset seeded on its very first request and
 *  then failed every single poll for eight hours, while curl from the same box
 *  answered perfectly — which sent me chasing rate limits, poll intervals,
 *  shared budgets and gates, none of which were the problem.
 *
 *  Keep-alive is on: it made no difference to the outcome and costs a handshake
 *  per request to disable. */
import https from 'node:https';
import { logError } from '../log.js';

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** GET a JSON document, or throw CowHttpError with the status. */
export function getJson<T>(
  url: string,
  timeoutMs = 20_000,
  headers: Record<string, string> = {}
): Promise<T> {
  const u = new URL(url);
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        host: u.host,
        path: u.pathname + u.search,
        method: 'GET',
        agent,
        headers: { Accept: 'application/json', ...headers },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume(); // drain, or the socket is never released
          reject(new HttpStatusError(status));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.end();
  });
}

/** GET returning null on any failure, for callers that treat absence as data. */
export async function getJsonOrNull<T>(url: string, timeoutMs = 20_000): Promise<T | null> {
  try {
    return await getJson<T>(url, timeoutMs);
  } catch (err) {
    if (!(err instanceof HttpStatusError) || err.status !== 404) {
      logError(`GET failed: ${url.slice(0, 80)}`, err);
    }
    return null;
  }
}
