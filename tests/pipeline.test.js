const test = require('node:test');
const assert = require('node:assert');
const { resultForOutcome } = require('../src/settle');
const { fitWeight } = require('../src/calibrate');
const { lastSnapshots, firstFlaggedSnapshots } = require('../src/ledger');

test('settlement maps winnerCode to outcome results', () => {
  assert.strictEqual(resultForOutcome('1', 1), 'won');
  assert.strictEqual(resultForOutcome('2', 1), 'lost');
  assert.strictEqual(resultForOutcome('X', 3), 'won');
  assert.strictEqual(resultForOutcome('1', 3), 'lost');
  assert.strictEqual(resultForOutcome('2', 2), 'won');
  assert.strictEqual(resultForOutcome('1', undefined), null);
});

test('calibration recovers the true blend weight from synthetic results', () => {
  // True process: p = 0.35 * vote + 0.65 * market (huge vote counts, so shrinkage ≈ none)
  const samples = [];
  const trueP = 0.35 * 0.8 + 0.65 * 0.5; // 0.605
  for (let i = 0; i < 1000; i++) {
    samples.push({ voteShare: 0.8, marketProb: 0.5, totalVotes: 1e9, won: i < Math.round(trueP * 1000) });
  }
  const fit = fitWeight(samples, 1000);
  assert.ok(Math.abs(fit.voteWeight - 0.35) <= 0.03, `fitted ${fit.voteWeight}, expected ~0.35`);
});

test('ledger views pick latest snapshot and earliest flagged snapshot', () => {
  const entries = [
    { eventId: 1, outcome: '1', scanAt: '2026-07-20T00:00:00Z', flagged: false, ev: 0.01 },
    { eventId: 1, outcome: '1', scanAt: '2026-07-20T02:00:00Z', flagged: true, ev: 0.08, odds: 2.6 },
    { eventId: 1, outcome: '1', scanAt: '2026-07-20T04:00:00Z', flagged: true, ev: 0.06, odds: 2.4 },
    { eventId: 1, outcome: '2', scanAt: '2026-07-20T04:00:00Z', flagged: false, ev: -0.1 },
  ];
  const last = lastSnapshots(entries);
  assert.strictEqual(last.length, 2);
  assert.strictEqual(last.find((e) => e.outcome === '1').scanAt, '2026-07-20T04:00:00Z');
  const flagged = firstFlaggedSnapshots(entries);
  assert.strictEqual(flagged.length, 1);
  assert.strictEqual(flagged[0].scanAt, '2026-07-20T02:00:00Z'); // first flag = price you could bet
  assert.strictEqual(flagged[0].odds, 2.6);
});
