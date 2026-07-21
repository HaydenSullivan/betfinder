const test = require('node:test');
const assert = require('node:assert');
const { resultForOutcome } = require('../src/settle');
const { fitWeight, effectiveVoteWeight } = require('../src/calibrate');
const { lastSnapshots, firstFlaggedSnapshots, dedupeAgainst } = require('../src/ledger');

test('dedupe drops unchanged snapshots but keeps movement and new outcomes', () => {
  const prior = [
    { eventId: 1, outcome: '1', scanAt: '2026-07-21T00:00:00Z', odds: 2.0, totalVotes: 500, flagged: false, settled: false },
    { eventId: 2, outcome: '1', scanAt: '2026-07-21T00:00:00Z', odds: 1.8, totalVotes: 900, flagged: false, settled: true },
  ];
  const fresh = [
    { eventId: 1, outcome: '1', scanAt: '2026-07-21T02:00:00Z', odds: 2.0, totalVotes: 500, flagged: false }, // unchanged -> drop
    { eventId: 1, outcome: '2', scanAt: '2026-07-21T02:00:00Z', odds: 1.9, totalVotes: 500, flagged: false }, // new outcome -> keep
    { eventId: 2, outcome: '1', scanAt: '2026-07-21T02:00:00Z', odds: 1.8, totalVotes: 900, flagged: false }, // prior settled -> keep
    { eventId: 3, outcome: '1', scanAt: '2026-07-21T02:00:00Z', odds: 2.4, totalVotes: 100, flagged: false }, // brand new -> keep
  ];
  const kept = dedupeAgainst(prior, fresh);
  assert.strictEqual(kept.length, 3);
  assert.ok(!kept.some((e) => e.eventId === 1 && e.outcome === '1'));
  // a price move on event 1 outcome 1 is kept
  const moved = dedupeAgainst(prior, [{ eventId: 1, outcome: '1', scanAt: '2026-07-21T02:00:00Z', odds: 2.1, totalVotes: 500, flagged: false }]);
  assert.strictEqual(moved.length, 1);
});

test('settlement maps winnerCode to outcome results', () => {
  assert.strictEqual(resultForOutcome('1', 1), 'won');
  assert.strictEqual(resultForOutcome('2', 1), 'lost');
  assert.strictEqual(resultForOutcome('X', 3), 'won');
  assert.strictEqual(resultForOutcome('1', 3), 'lost');
  assert.strictEqual(resultForOutcome('2', 2), 'won');
  assert.strictEqual(resultForOutcome('1', undefined), null);
});

test('calibration recovers the true blend weight from synthetic results', () => {
  const config = { votePrior: 500, voteCeiling: 15000 };
  const totalVotes = 2739; // near the peak of the noise×fame curve
  const wEff = effectiveVoteWeight(0.35, totalVotes, config);
  const trueP = wEff * 0.8 + (1 - wEff) * 0.5;
  const samples = [];
  for (let i = 0; i < 2000; i++) {
    samples.push({ voteShare: 0.8, marketProb: 0.5, totalVotes, won: i < Math.round(trueP * 2000) });
  }
  const fit = fitWeight(samples, config);
  assert.ok(Math.abs(fit.voteWeight - 0.35) <= 0.05, `fitted ${fit.voteWeight}, expected ~0.35`);
});

test('effective vote weight tapers for both tiny and huge vote counts', () => {
  const config = { votePrior: 500, voteCeiling: 15000 };
  const small = effectiveVoteWeight(0.5, 150, config);
  const mid = effectiveVoteWeight(0.5, 2739, config);
  const huge = effectiveVoteWeight(0.5, 200000, config);
  assert.ok(mid > small, 'mid-size crowds trusted more than tiny ones');
  assert.ok(mid > huge, 'mid-size crowds trusted more than huge (famous-team) ones');
  assert.ok(huge < 0.05, 'very famous games nearly ignore the crowd');
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
