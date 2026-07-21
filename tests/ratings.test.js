const test = require('node:test');
const assert = require('node:assert');
const { expectedScore, marginMultiplier, updateRatings, buildRatings, ratingsToProbs, START } = require('../src/ratings');

test('expectedScore is symmetric and favours the higher rating', () => {
  assert.ok(Math.abs(expectedScore(1500, 1500) - 0.5) < 1e-9);
  assert.ok(expectedScore(1700, 1500) > 0.5);
  assert.ok(Math.abs(expectedScore(1700, 1500) + expectedScore(1500, 1700) - 1) < 1e-9);
});

test('margin multiplier grows with goal difference but with diminishing returns', () => {
  const one = marginMultiplier(1), three = marginMultiplier(3), five = marginMultiplier(5);
  assert.ok(three > one && five > three);
  assert.ok(five - three < three - one, 'diminishing: a 5-0 is not 5x a 1-0');
  assert.strictEqual(marginMultiplier(-3), marginMultiplier(3), 'direction handled by the sign of the error term');
  assert.strictEqual(marginMultiplier(0), 1, 'draws must still carry information');
});

test('a win raises the winner and lowers the loser by the same amount', () => {
  const r = {};
  updateRatings(r, { homeId: 'A', awayId: 'B', homeScore: 2, awayScore: 0 }, { k: 20, homeAdv: 0 });
  assert.ok(r.A > START && r.B < START);
  assert.ok(Math.abs((r.A - START) + (r.B - START)) < 1e-9, 'zero-sum');
});

test('home advantage means a home draw costs the home side rating', () => {
  const r = {};
  updateRatings(r, { homeId: 'A', awayId: 'B', homeScore: 1, awayScore: 1 }, { k: 20, homeAdv: 60 });
  assert.ok(r.A < START, 'expected to win at home, so a draw is a downgrade');
  assert.ok(r.B > START);
});

test('buildRatings separates a consistent winner from a consistent loser', () => {
  const matches = [];
  for (let i = 0; i < 10; i++) {
    matches.push({ homeId: 'strong', awayId: 'weak', homeScore: 3, awayScore: 0, startTimestamp: i });
  }
  const r = buildRatings(matches, { k: 20, homeAdv: 0 });
  assert.ok(r.strong > r.weak + 100);
});

test('ratingsToProbs sums to 1 and shrinks the draw as the gap widens', () => {
  const level = ratingsToProbs(1500, 1500, {});
  const lopsided = ratingsToProbs(1900, 1300, {});
  for (const p of [level, lopsided]) {
    assert.ok(Math.abs(p['1'] + p.X + p['2'] - 1) < 1e-9);
  }
  assert.ok(lopsided.X < level.X, 'mismatches draw less often');
  assert.ok(lopsided['1'] > level['1']);
});
