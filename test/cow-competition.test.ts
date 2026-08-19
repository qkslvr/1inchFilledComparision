import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerFromUid, tradesFromCompetition } from '../src/cow/competition.js';

/** Shaped after a real `/api/v2/solver_competition/latest` response: several
 *  solvers bid, exactly one wins, and only the winner carries a txHash. */
const OWNER = '9223c5888bc47ff3a6c671ef3de0c7e0c8637ca3';
const UID = '0x' + 'fe'.repeat(32) + OWNER + '6a85b3c8';

const payload = {
  auctionId: 13621398,
  auctionStartBlock: 25789460,
  auctionDeadlineBlock: 25789463,
  transactionHashes: ['0xbbd89e2b'],
  solutions: [
    {
      solverAddress: '0xLOSER',
      score: '105198234727171679',
      ranking: 2,
      isWinner: false,
      txHash: null,
      referenceScore: null,
      orders: [
        {
          id: '0xdeadbeef',
          sellToken: '0xAAA',
          buyToken: '0xBBB',
          sellAmount: '1',
          buyAmount: '2',
        },
      ],
    },
    {
      solverAddress: '0xB222DA0F9C22AD2ADDCB0B0D6B150F398E44157A',
      score: '17241030894039107',
      ranking: 1,
      isWinner: true,
      txHash: '0xbbd89e2b',
      referenceScore: '16914020230201071',
      orders: [
        {
          id: UID,
          sellToken: '0x78D11E37E890AF4589FC9D0F6F884FD165C5AA0A',
          buyToken: '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
          sellAmount: '55000000000000000000000',
          buyAmount: '109513665462344645',
        },
      ],
    },
  ],
};

test('the owner is recovered from the uid without a lookup', () => {
  // A CoW uid is digest(32) ++ owner(20) ++ validTo(4); the owner is in there.
  assert.equal(ownerFromUid(UID), '0x' + OWNER);
});

test('a uid too short to contain an owner does not yield a bogus address', () => {
  assert.equal(ownerFromUid('0xabcd'), '0x');
});

test('only the winning solution becomes a trade', () => {
  const r = tradesFromCompetition(payload)!;
  assert.equal(r.trades.length, 1);
  // A losing solver's bid describes a trade that never happened; pricing it
  // would invent flow that no user ever received.
  assert.equal(r.trades[0]!.orderUid, UID);
  assert.equal(r.trades[0]!.sellAmount, 55000000000000000000000n);
  assert.equal(r.trades[0]!.buyAmount, 109513665462344645n);
  assert.equal(r.trades[0]!.sellToken, '0x78d11e37e890af4589fc9d0f6f884fd165c5aa0a');
  assert.equal(r.trades[0]!.blockNumber, 25789463);
});

test('the competition context records the bar we would have had to clear', () => {
  const { competition: c } = tradesFromCompetition(payload)!;
  assert.equal(c.auctionId, 13621398);
  assert.equal(c.solverCount, 2);
  assert.equal(c.winnerScore, 17241030894039107n);
  assert.equal(c.referenceScore, 16914020230201071n);
  assert.equal(c.deadlineBlock, 25789463);
  assert.equal(c.txHash, '0xbbd89e2b');
});

test('an auction nobody won yields no trades but still parses', () => {
  const none = { ...payload, solutions: payload.solutions.map((s) => ({ ...s, isWinner: false })) };
  const r = tradesFromCompetition(none)!;
  assert.equal(r.trades.length, 0);
  assert.equal(r.competition.winnerScore, null);
  assert.equal(r.competition.solverCount, 2);
});

test('an order missing its economics is dropped, not half-built', () => {
  const partial = {
    ...payload,
    solutions: [{ ...payload.solutions[1]!, orders: [{ id: UID, sellToken: '0xAAA' }] }],
  };
  assert.equal(tradesFromCompetition(partial)!.trades.length, 0);
});

test('a payload without an auction id is rejected outright', () => {
  assert.equal(tradesFromCompetition({ solutions: [] }), null);
});
