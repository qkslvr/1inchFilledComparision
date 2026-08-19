import assert from 'node:assert/strict';
import test from 'node:test';
import { booksSince } from '../src/bebop/relay-protocol.js';
import type { BebopBook } from '../src/bebop/feed.js';

const book = (base: string, quote: string, tsMs: number): BebopBook => ({
  base,
  quote,
  bids: [1900, 2],
  asks: [1901, 2],
  tsMs,
  streamTsMs: tsMs,
});

const books = new Map<string, BebopBook>([
  ['a|b', book('a', 'b', 1000)],
  ['c|d', book('c', 'd', 2000)],
  ['e|f', book('e', 'f', 3000)],
]);

test('a first sync asks for everything', () => {
  const r = booksSince(books, 0);
  assert.equal(r.books.length, 3);
  assert.equal(r.maxTsMs, 3000);
});

test('only books that moved since the watermark are sent', () => {
  const r = booksSince(books, 1000);
  assert.deepEqual(
    r.books.map(([k]) => k),
    ['c|d', 'e|f']
  );
  assert.equal(r.maxTsMs, 3000);
});

test('a quiet interval sends nothing and does not rewind the watermark', () => {
  // If maxTsMs started at 0, an empty poll would hand the client a watermark of
  // 0 and trigger a full resync of every book on the very next call.
  const r = booksSince(books, 3000);
  assert.equal(r.books.length, 0);
  assert.equal(r.maxTsMs, 3000);
});

test('a book that stops quoting is not resent, so the client must keep its own', () => {
  // This is why the client merges rather than replaces: 'a|b' never appears
  // again, and dropping it would silently lose the pair forever.
  const r = booksSince(books, 2500);
  assert.deepEqual(
    r.books.map(([k]) => k),
    ['e|f']
  );
});

test('the relay and a live socket agree on how a book is keyed', async () => {
  // bookFor() looks up `${base}|${quote}` in either orientation. If the relay
  // ever changed that key the venue would silently return "no data" for every
  // pair, which is exactly the failure this whole relay exists to fix.
  const { BebopRelayFeed } = await import('../src/bebop/relay-client.js');
  const feed = new BebopRelayFeed();
  feed.books.set('a|b', book('a', 'b', 1000));
  assert.equal(feed.bookFor('a', 'b')?.aIsBase, true);
  assert.equal(feed.bookFor('b', 'a')?.aIsBase, false);
  assert.equal(feed.bookFor('a', 'z'), null);
});
