import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config.js';
import { bpsOfCeil, ppmOfCeil } from '../src/pricing/units.js';

/** Our fee and Kyber's slippage haircut both change every score in the dataset,
 *  silently and everywhere. Pinning them here means a change to either has to be
 *  deliberate rather than incidental. */

test('our fee is 2.5 bps, expressed in ppm because bps cannot hold it', () => {
  // The field was whole-bps before, which is exactly why it had to move: 2.5 is
  // not expressible as a bigint number of bps.
  for (const [name, ppm] of [
    ['kalqix', config.kalqixTakerFeePpm],
    ['kyber', config.kyber.feePpm],
    ['bebop', config.bebop.feePpm],
  ] as const) {
    assert.equal(ppm, 250n, `${name} fee should be 250 ppm = 2.5 bps`);
  }
  // 250 ppm of 1,000,000 units is 250 — i.e. 2.5 bps, not 5.
  assert.equal(ppmOfCeil(1_000_000n, config.kyber.feePpm), 250n);
});

test('Kyber carries a slippage haircut the firm venues do not', () => {
  assert.equal(config.kyber.slippageBps, 10n);
  // 10 bps off a route quote of 1,000,000 is 1,000.
  assert.equal(bpsOfCeil(1_000_000n, config.kyber.slippageBps), 1_000n);
  // The other venues quote something firm, so they get no haircut at all.
  assert.ok(!('slippageBps' in config.bebop), 'Bebop RFQ quotes are firm');
});

test('slippage is taken off the output, not added to the fee', () => {
  // Order matters and the two are not interchangeable: slippage is a cost the
  // user bears, the fee is our revenue. Folding one into the other would
  // misreport both — and the fee is what we bill, so it must be charged on what
  // actually executes, which is the amount after slippage.
  const routeQuote = 1_000_000n;
  const slipped = routeQuote - bpsOfCeil(routeQuote, config.kyber.slippageBps);
  const fee = ppmOfCeil(slipped, config.kyber.feePpm);
  assert.equal(slipped, 999_000n);
  assert.equal(fee, 250n); // 2.5 bps of 999,000, ceiled
  // Charging the fee on the pre-slippage quote would over-bill, if only slightly.
  assert.ok(fee <= ppmOfCeil(routeQuote, config.kyber.feePpm));
});
