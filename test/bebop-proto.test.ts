import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePricingUpdate } from '../src/bebop/proto.js';

/** Hand-encode the Bebop schema to lock in our decoder. */
function encodeVarint(n: bigint): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function lenDelim(field: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint(BigInt((field << 3) | 2)), encodeVarint(BigInt(payload.length)), payload]);
}

function floats(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
}

function encodePriceUpdate(base: string, quote: string, ts: bigint, bids: number[], asks: number[]): Buffer {
  return Buffer.concat([
    lenDelim(1, Buffer.from(base.slice(2), 'hex')),
    lenDelim(2, Buffer.from(quote.slice(2), 'hex')),
    Buffer.concat([encodeVarint(BigInt(3 << 3)), encodeVarint(ts)]),
    lenDelim(4, floats(bids)),
    lenDelim(5, floats(asks)),
  ]);
}

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

test('decodes a packed pricing update', () => {
  const update = encodePriceUpdate(WETH, USDC, 1783940000123n, [1850.5, 2.5, 1849.0, 10.0], [1851.0, 3.0]);
  const msg = lenDelim(1, update);
  const pairs = decodePricingUpdate(msg);
  assert.equal(pairs.length, 1);
  const p = pairs[0]!;
  assert.equal(p.base, WETH);
  assert.equal(p.quote, USDC);
  assert.equal(p.lastUpdateTs, 1783940000123n);
  assert.equal(p.bids.length, 4);
  assert.ok(Math.abs(p.bids[0]! - 1850.5) < 0.01);
  assert.ok(Math.abs(p.asks[1]! - 3.0) < 0.001);
});

test('decodes multiple pairs and skips unknown fields', () => {
  const u1 = encodePriceUpdate(WETH, USDC, 1n, [1.0, 2.0], []);
  const u2 = encodePriceUpdate(USDC, WETH, 2n, [], [3.0, 4.0]);
  // unknown field 9 (varint) between pairs must be skipped
  const unknown = Buffer.concat([encodeVarint(BigInt(9 << 3)), encodeVarint(42n)]);
  const msg = Buffer.concat([lenDelim(1, u1), unknown, lenDelim(1, u2)]);
  const pairs = decodePricingUpdate(msg);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[1]!.asks.length, 2);
});

test('decodes unpacked (non-packed) repeated floats', () => {
  // field 4 wire type 5 (fixed32), one float at a time
  const f = Buffer.alloc(4);
  f.writeFloatLE(7.5, 0);
  const unpacked = Buffer.concat([
    lenDelim(1, Buffer.from(WETH.slice(2), 'hex')),
    Buffer.concat([encodeVarint(BigInt((4 << 3) | 5)), f]),
    Buffer.concat([encodeVarint(BigInt((4 << 3) | 5)), f]),
  ]);
  const pairs = decodePricingUpdate(lenDelim(1, unpacked));
  assert.equal(pairs[0]!.bids.length, 2);
  assert.ok(Math.abs(pairs[0]!.bids[0]! - 7.5) < 0.001);
});
