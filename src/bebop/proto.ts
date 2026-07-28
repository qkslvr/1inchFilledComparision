/** Minimal protobuf decoder for Bebop's pricing stream. The schema is small and
 *  fixed (published inline in their quickstart), so a hand-rolled reader beats a
 *  protobuf dependency:
 *
 *    message PriceUpdate {
 *      optional bytes  base           = 1;
 *      optional bytes  quote          = 2;
 *      optional uint64 last_update_ts = 3;
 *      repeated float  bids           = 4 [packed = true];  // [p1,s1,p2,s2,...]
 *      repeated float  asks           = 5 [packed = true];
 *    }
 *    message BebopPricingUpdate { repeated PriceUpdate pairs = 1; }
 *
 *  Handles both packed and unpacked float encodings (proto3 allows either on
 *  the wire). Floats are float32: ~7 significant digits.
 */

export interface BebopPriceUpdate {
  /** lowercase 0x hex */
  base: string;
  quote: string;
  lastUpdateTs: bigint;
  /** alternating [price, size, price, size, ...] exactly as streamed */
  bids: number[];
  asks: number[];
}

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error('varint past end');
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('varint too long');
    }
  }

  bytes(): Buffer {
    const len = Number(this.varint());
    const out = this.buf.subarray(this.pos, this.pos + len);
    if (out.length !== len) throw new Error('bytes past end');
    this.pos += len;
    return out;
  }

  float32(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.bytes();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
}

function decodePriceUpdate(buf: Buffer): BebopPriceUpdate {
  const r = new Reader(buf);
  const out: BebopPriceUpdate = { base: '', quote: '', lastUpdateTs: 0n, bids: [], asks: [] };
  while (!r.eof) {
    const tag = Number(r.varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) out.base = '0x' + r.bytes().toString('hex');
    else if (field === 2 && wire === 2) out.quote = '0x' + r.bytes().toString('hex');
    else if (field === 3 && wire === 0) out.lastUpdateTs = r.varint();
    else if ((field === 4 || field === 5) && wire === 2) {
      const packed = new Reader(r.bytes());
      const arr = field === 4 ? out.bids : out.asks;
      while (!packed.eof) arr.push(packed.float32());
    } else if ((field === 4 || field === 5) && wire === 5) {
      (field === 4 ? out.bids : out.asks).push(r.float32());
    } else {
      r.skip(wire);
    }
  }
  return out;
}

export function decodePricingUpdate(buf: Buffer): BebopPriceUpdate[] {
  const r = new Reader(buf);
  const pairs: BebopPriceUpdate[] = [];
  while (!r.eof) {
    const tag = Number(r.varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) pairs.push(decodePriceUpdate(r.bytes()));
    else r.skip(wire);
  }
  return pairs;
}
