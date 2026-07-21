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

test('bigDrift signal fires on extreme drift regardless of crowd side', () => {
  const { SIGNALS } = require('../src/promotions');
  const g = { totalVotes: 50, votes: { counts: { '1': 10, X: 0, '2': 40 } }, b5: null };
  const r = researchFields(g, { name: '1', odds: 2.5, openingOdds: 2.0 }); // +25% drift, anti-crowd side
  assert.ok(SIGNALS.bigDrift.fires({ name: '1', odds: 2.5 }, r));
  assert.ok(!SIGNALS.bigDrift.fires({ name: '1', odds: 2.2 }, researchFields(g, { name: '1', odds: 2.2, openingOdds: 2.0 }))); // only +10%
  assert.ok(SIGNALS.bigDrift.settledMatch({ drift: 0.22, odds: 3.0, outcome: '2' }));
  assert.ok(!SIGNALS.bigDrift.settledMatch({ drift: 0.22, odds: 8.0, outcome: '2' })); // odds cap
});

test('voteSurge fires when crowd share jumps but the line stands still', () => {
  const g = { totalVotes: 900, votes: { counts: { '1': 600, X: 0, '2': 300 } }, b5: null };
  const o = { name: '1', odds: 2.0, openingOdds: 2.0, voteShareRaw: 0.67 };
  const surge = researchFields(g, o, { voteShareRaw: 0.6, odds: 2.0 });
  assert.ok(surge.shadowVoteSurge, 'share +7pts, odds unchanged');
  assert.ok(Math.abs(surge.voteShareDelta - 0.07) < 1e-9);
  const moved = researchFields(g, o, { voteShareRaw: 0.6, odds: 1.9 }); // line already moved 5%
  assert.ok(!moved.shadowVoteSurge);
  const noPrior = researchFields(g, o, undefined);
  assert.ok(!noPrior.shadowVoteSurge);
  assert.strictEqual(noPrior.voteShareDelta, null);
});

test('sport gate raises the EV bar only for clearly losing sports', () => {
  const { sportGatesFrom } = require('../src/calibrate');
  const mk = (sport, result, odds, i) => ({ eventId: 1000 + i, outcome: '1', sport, result, odds, settled: true, flagged: true, scanAt: 't' + i, startTimestamp: i });
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push(mk('baseball', i < 8 ? 'won' : 'lost', 1.9, i)); // 27% hit at 1.9 -> deep loss
  for (let i = 0; i < 30; i++) entries.push(mk('football', i < 16 ? 'won' : 'lost', 2.2, 100 + i)); // profitable
  for (let i = 0; i < 10; i++) entries.push(mk('darts', 'lost', 2.0, 200 + i)); // losing but too few
  const gates = sportGatesFrom(entries, { sportGateMinSettled: 25 });
  assert.ok(gates.baseball && gates.baseball.evBump >= 0.03);
  assert.ok(!gates.football);
  assert.ok(!gates.darts);

  const { analyzeGame } = require('../src/analyzer');
  const config = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf8'));
  const game = (sport) => ({
    id: 1, sport, home: 'H', away: 'A', homeFollowers: null, awayFollowers: null,
    market: { outcomes: [ { name: '1', odds: 2.6, openingOdds: 2.6, change: 0 }, { name: '2', odds: 1.5, openingOdds: 1.5, change: 0 } ] },
    votes: { counts: { '1': 8000, X: 0, '2': 2000 }, total: 10000 },
  });
  // Same sport, same game: only the gate differs.
  const openPick = analyzeGame(game('football'), config, { sportGates: {} }).outcomes.find((o) => o.name === '1');
  const gatedPick = analyzeGame(game('football'), config, { sportGates: { football: { evBump: 0.2 } } }).outcomes.find((o) => o.name === '1');
  assert.ok(openPick.flagged, 'ungated flags normally');
  assert.ok(Math.abs(openPick.ev - gatedPick.ev) < 1e-9, 'gate changes the bar, not the EV');
  assert.ok(!gatedPick.flagged, 'gated sport needs the higher bar');
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
