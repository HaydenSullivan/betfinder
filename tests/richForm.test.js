const test = require('node:test');
const assert = require('node:assert');
const { matchMargin, matchQuality, strengthWeight } = require('../src/richForm');
const { analyzeGame } = require('../src/analyzer');

const config = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf8'));

test('tennis margins come from total games across sets, retirements included', () => {
  // Sherif d. Badosa 6-4 4-0 ret. — home perspective, big positive margin
  const match = {
    homeScore: { current: 1, period1: 6, period2: 4 },
    awayScore: { current: 0, period1: 4, period2: 0 },
  };
  const margin = matchMargin(match, true, 'tennis');
  assert.ok(margin === 1, `12-4 in games caps the +1 margin, got ${margin}`);
  assert.ok(matchMargin(match, false, 'tennis') === -1);
});

test('low-scoring sports do not treat 1-0 as a blowout', () => {
  const match = { homeScore: { current: 1 }, awayScore: { current: 0 } };
  const margin = matchMargin(match, true, 'football');
  assert.ok(Math.abs(margin - 1 / 3) < 1e-9);
});

test('quality: result dominates, margin refines within bounds', () => {
  assert.ok(matchQuality(true, false, 1) === 1); // blowout win
  assert.ok(matchQuality(true, false, -0.5) === 0.6); // scrappy win floors at 0.6
  assert.ok(matchQuality(false, false, -1) === 0); // blowout loss
  assert.ok(matchQuality(false, false, 0.4) === 0.4); // narrow loss caps at 0.4
  assert.strictEqual(matchQuality(false, true, 0), 0.5); // draw
});

test('beating better-ranked opponents weighs more', () => {
  // subject #73 beats #45 (better) vs beats #152 (worse)
  assert.ok(strengthWeight(73, 45) > 1);
  assert.ok(strengthWeight(73, 152) < 1);
  assert.strictEqual(strengthWeight(null, 45), 1); // no ranking (team sports)
  assert.ok(strengthWeight(300, 5) <= 1.8); // capped
});

test('analyzer prefers rich form over letter form', () => {
  const game = {
    id: 1,
    sport: 'tennis',
    home: 'A',
    away: 'B',
    homeFollowers: null,
    awayFollowers: null,
    market: {
      outcomes: [
        { name: '1', odds: 2.6, openingOdds: 2.6, change: 0 },
        { name: '2', odds: 1.5, openingOdds: 1.5, change: 0 },
      ],
    },
    votes: { counts: { '1': 5000, X: 0, '2': 5000 }, total: 10000 },
    // Letters say home is cold, but quality-adjusted says home is much stronger
    form: { home: { form: ['L', 'L', 'L', 'L', 'L'] }, away: { form: ['W', 'W', 'W', 'W', 'W'] } },
    richForm: { home: { score: 0.9, ranking: 73, detail: [] }, away: { score: 0.4, ranking: 93, detail: [] } },
  };
  const result = analyzeGame(game, config, null);
  assert.strictEqual(result.formSource, 'rich');
  assert.ok(Math.abs(result.homeFormScore - 0.9) < 1e-9);
  const homePick = result.outcomes.find((o) => o.name === '1');
  // formEdge = 0.9 - 0.4 = +0.5 for the home side
  assert.ok(Math.abs(homePick.formEdge - 0.5) < 1e-9);
});
