import { createHmac } from 'node:crypto';
import { config } from '../../config.js';

export function kalqixCreds(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.KALQIX_API_KEY;
  const apiSecret = process.env.KALQIX_API_SECRET;
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

/** HMAC-signed GET per KalqiX docs: canonical = METHOD|/v1/path|sortedQuery|body|timestamp,
 *  HMAC-SHA256 hex in x-api-signature. GETs sign with an empty body segment. */
export async function signedGet(
  path: string, // must include the /v1 prefix, no query string
  query: Record<string, string | number>,
  timeoutMs = 5000
): Promise<Response> {
  const creds = kalqixCreds();
  if (!creds) throw new Error('KALQIX_API_KEY / KALQIX_API_SECRET not set');
  const timestamp = Date.now();
  const sortedQuery = Object.entries(query)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = `GET|${path}|${sortedQuery}||${timestamp}`; // empty body segment
  const signature = createHmac('sha256', creds.apiSecret).update(canonical).digest('hex');
  const base = config.kalqixApiBase.replace(/\/v1$/, '');
  const url = `${base}${path}${sortedQuery ? '?' + sortedQuery : ''}`;
  return fetch(url, {
    headers: {
      'x-api-key': creds.apiKey,
      'x-api-signature': signature,
      'x-api-timestamp': String(timestamp),
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}
