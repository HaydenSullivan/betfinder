const test = require('node:test');
const assert = require('node:assert');
const { nextStatus, applyPromotedSignals, researchFields } = require('../src/promotions');

const rules = { minSettled: 50, promoteRoi: 0.02, promoteClv: 0, demoteRoi: 0, demoteClv: -0.005 };

test('gate: stays shadow until n, roi and clv all clear the bar', () => {
  assert.strictEqual(nextStatus('shadow', { n: 30, roi: 0.2, clv: 0.05 }, rules), 'shadow'); // too few
  assert.strictEqual(nextStatus('shadow', { n: 60, roi: 0.01, clv: 0.05 }, rules), 'shadow'); // roi short
  assert.strictEqual(nextStatus('shadow', { n: 60, roi: 0.1, clv: -0.01 }, rules), 'shadow'); // clv negative
  assert.strictEqual(nextStatus('shadow', { n: 60, roi: 0.1, clv: null }, rules), 'shadow'); // clv unknown
  assert.strictEqual(nextStatus('shadow', { n: 60, roi: 0.1, clv: 0.01 }, rules), 'promoted');
});

test('gate: hysteresis — promoted survives a dip, demotes on decay', () => {
  assert.strictEqual(nextStatus('promoted', { n: 80, roi: 0.01, clv: -0.002 }, rules), 'promoted'); // dip within band
  assert.strictEqual(nextStatus('promoted', { n: 80, roi: -0.01, clv: 0.01 }, rules), 'shadow'); // roi decay
  assert.strictEqual(nextStatus('promoted', { n: 80, roi: 0.05, clv: -0.01 }, rules), 'shadow'); // clv decay
});

test('promoted drift signal flags a matching outcome; shadow does not', () => {
  const game = () => ({
    id: 9,
    home: 'A', away: 'B',
    totalVotes: 800,
    votes: { counts: { '1': 600, X: 0, '2': 200 }, total: 800 },
    b5: null,
    outcomes: [
      { name: '1', odds: 2.4, openingOdds: 2.0, voteShare: 0.7, flagged: false, ev: -0.02 }, // crowd side drifted +20%
      { name: '2', odds: 1.55, openingOdds: 1.7, voteShare: 0.3, flagged: false, ev: -0.05 },
    ],
    flags: [],
  });
  const promoted = { signals: { driftCrowd: { status: 'promoted' }, consensus: { status: 'shadow' } } };
  const g1 = game();
  const added = applyPromotedSignals([g1], promoted);
  assert.strictEqual(added, 1);
  const pick = g1.outcomes.find((o) => o.name === '1');
  assert.ok(pick.flagged && pick.signals.includes('driftCrowd'));
  assert.ok(!g1.outcomes.find((o) => o.name === '2').flagged);
  assert.strictEqual(g1.flags.length, 1);

  const shadow = { signals: { driftCrowd: { status: 'shadow' }, consensus: { status: 'shadow' } } };
  const g2 = game();
  assert.strictEqual(applyPromotedSignals([g2], shadow), 0);
  assert.ok(!g2.outcomes.find((o) => o.name === '1').flagged);
  assert.ok(g2.outcomes[0].research); // research fields still stashed for the ledger
});

test('researchFields computes drift and crowd majority', () => {
  const g = { totalVotes: 500, votes: { counts: { '1': 400, X: 0, '2': 100 } }, b5: null };
  const r = researchFields(g, { name: '1', odds: 2.2, openingOdds: 2.0 });
  assert.ok(Math.abs(r.drift - 0.1) < 1e-9);
  assert.strictEqual(r.crowdMajority, true);
  assert.strictEqual(r.shadowDriftCrowd, true);
  const r2 = researchFields(g, { name: '2', odds: 1.6, openingOdds: 1.7 });
  assert.strictEqual(r2.crowdMajority, false);
  assert.strictEqual(r2.shadowDriftCrowd, false);
});
