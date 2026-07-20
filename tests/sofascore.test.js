const test = require('node:test');
const assert = require('node:assert');
const { fractionalToDecimal, parseMarket, parseVotes, parseEvent, matchUrl } = require('../src/sofascore');

test('fractionalToDecimal converts bet365-style fractions', () => {
  assert.strictEqual(fractionalToDecimal('11/25'), 1.44);
  assert.ok(Math.abs(fractionalToDecimal('10/3') - 4.3333333333) < 1e-9);
  assert.strictEqual(fractionalToDecimal('11/2'), 6.5);
  assert.strictEqual(fractionalToDecimal('1/1'), 2);
  assert.strictEqual(fractionalToDecimal('not-a-fraction'), null);
  assert.strictEqual(fractionalToDecimal('3/0'), null);
  assert.strictEqual(fractionalToDecimal(undefined), null);
});

test('parseMarket keeps names, converts odds, and drops suspended markets', () => {
  const market = parseMarket({
    marketName: 'Full time',
    suspended: false,
    choices: [
      { name: '1', fractionalValue: '11/25', initialFractionalValue: '3/10', change: 1 },
      { name: 'X', fractionalValue: '10/3', initialFractionalValue: '4/1', change: -1 },
      { name: '2', fractionalValue: '11/2', initialFractionalValue: '8/1', change: -1 },
    ],
  });
  assert.strictEqual(market.outcomes.length, 3);
  assert.strictEqual(market.outcomes[0].odds, 1.44);
  assert.strictEqual(market.outcomes[0].openingOdds, 1.3);
  assert.strictEqual(parseMarket({ suspended: true, choices: [] }), null);
  assert.strictEqual(parseMarket(null), null);
  assert.strictEqual(
    parseMarket({ choices: [{ name: '1', fractionalValue: 'bad' }, { name: '2', fractionalValue: '1/2' }] }),
    null
  );
});

test('parseVotes totals three-way and two-way votes', () => {
  const threeWay = parseVotes({ vote1: 12168, voteX: 1377, vote2: 1386 });
  assert.strictEqual(threeWay.total, 14931);
  assert.strictEqual(threeWay.counts['1'], 12168);
  const twoWay = parseVotes({ vote1: 10218, vote2: 3473, voteX: null });
  assert.strictEqual(twoWay.total, 13691);
  assert.strictEqual(twoWay.counts.X, 0);
  assert.strictEqual(parseVotes(null), null);
  assert.strictEqual(parseVotes({ vote1: 0, vote2: 0, voteX: 0 }), null);
});

test('parseEvent + matchUrl reproduce the public match link', () => {
  const event = parseEvent({
    id: 16281109,
    slug: 'sport-huancayo-alianza-lima',
    customId: 'lWsVCn',
    homeTeam: { name: 'Alianza Lima' },
    awayTeam: { name: 'Sport Huancayo' },
    startTimestamp: 1784505600,
    status: { type: 'notstarted' },
    tournament: {
      name: 'Liga 1, Clausura',
      category: { name: 'Peru', sport: { slug: 'football' } },
    },
  });
  assert.strictEqual(event.home, 'Alianza Lima');
  assert.strictEqual(event.sport, 'football');
  assert.strictEqual(
    matchUrl(event),
    'https://www.sofascore.com/football/match/sport-huancayo-alianza-lima/lWsVCn#id:16281109'
  );
});
