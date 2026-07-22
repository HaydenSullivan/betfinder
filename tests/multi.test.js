const test = require('node:test');
const assert = require('node:assert');
const { buildLegPool, searchCombos, selectDiverse, buildMultis, DEFAULTS } = require('../src/multi');

const NOW = 1_700_000_000;

// A game whose single outcome `1` is a strong-ish pick at the given price.
// Each game gets its own sport so the per-sport cap only binds when a test
// assigns shared sports deliberately.
function game(id, odds, estProb, overrides = {}) {
  return {
    id,
    sport: 'sport' + id,
    home: 'Home' + id,
    away: 'Away' + id,
    tournament: 'League' + id,
    country: 'AU',
    url: 'https://example.test/' + id,
    startTimestamp: NOW + 3600,
    totalVotes: 5000,
    outcomes: [
      { name: '1', odds, estProb, marketProb: 1 / odds, ev: estProb * odds - 1, voteShare: 0.7, flagged: true, warnings: [] },
      { name: '2', odds: 6, estProb: 0.2, marketProb: 1 / 6, ev: 0.2, voteShare: 0.3, flagged: false, warnings: [] },
    ],
    ...overrides,
  };
}

const pool = (games, over = {}) =>
  buildLegPool(games, { ...DEFAULTS, hours: 24, ...over }, NOW);

test('leg pool keeps only confident, in-window, in-price-range outcomes', () => {
  const games = [
    game(1, 1.5, 0.72), // qualifies
    game(2, 1.05, 0.95), // odds below minLegOdds
    game(3, 8, 0.55), // odds above maxLegOdds
    game(4, 1.5, 0.35), // probability below minLegProb
    game(5, 1.5, 0.72, { totalVotes: 10 }), // too few votes
    game(6, 1.5, 0.72, { startTimestamp: NOW + 40 * 3600 }), // outside the window
    game(7, 1.5, 0.72, { startTimestamp: NOW - 3600 }), // already started
  ];
  const legs = pool(games);
  assert.deepStrictEqual(legs.map((l) => l.eventId), [1]);
  assert.strictEqual(legs[0].pick, 'Home1');
});

test('leg probability is shrunk toward the market before compounding', () => {
  const legs = pool([game(1, 2, 0.7)], { shrinkToMarket: 0.5 });
  // market prob 0.5, model 0.7 → halfway is 0.6
  assert.ok(Math.abs(legs[0].prob - 0.6) < 1e-9);
  assert.ok(Math.abs(legs[0].ev - 0.2) < 1e-9);
  const none = pool([game(1, 2, 0.7)], { shrinkToMarket: 0 });
  assert.ok(Math.abs(none[0].prob - 0.7) < 1e-9);
});

test('draws are excluded unless includeDraws', () => {
  const drawGame = {
    ...game(1, 1.5, 0.72),
    outcomes: [{ name: 'X', odds: 2, estProb: 0.8, marketProb: 0.5, ev: 0.6, voteShare: 0.8, flagged: true, warnings: [] }],
  };
  assert.strictEqual(pool([drawGame]).length, 0);
  assert.strictEqual(pool([drawGame], { includeDraws: true }).length, 1);
});

test('search respects the odds band, leg count, and one leg per match', () => {
  const games = [];
  for (let i = 1; i <= 8; i++) games.push(game(i, 1.8, 0.75));
  const legs = pool(games);
  const { combos } = searchCombos(legs, { ...DEFAULTS, minOdds: 10, maxOdds: 20 });
  assert.ok(combos.length > 0);
  for (const m of combos) {
    assert.ok(m.odds >= 10 && m.odds <= 20, 'odds in band: ' + m.odds);
    assert.ok(m.legCount >= DEFAULTS.minLegs && m.legCount <= DEFAULTS.maxLegs);
    const events = new Set(m.legs.map((l) => l.eventId));
    assert.strictEqual(events.size, m.legCount, 'no two legs from the same match');
  }
  // 1.8^4 = 10.5 and 1.8^5 = 18.9 fit; 1.8^6 = 34 does not.
  assert.deepStrictEqual([...new Set(combos.map((m) => m.legCount))].sort(), [4, 5]);
});

test('legs from the same competition are capped', () => {
  const games = [];
  for (let i = 1; i <= 8; i++) games.push(game(i, 1.8, 0.75, { tournament: i <= 4 ? 'Same' : 'Other' + i }));
  const { combos } = searchCombos(pool(games), { ...DEFAULTS, maxPerTournament: 2 });
  assert.ok(combos.length > 0);
  for (const m of combos) {
    const same = m.legs.filter((l) => l.tournament === 'Same').length;
    assert.ok(same <= 2, 'at most 2 legs from one competition, got ' + same);
  }
});

test('legs from the same sport are capped at maxPerSport', () => {
  const games = [];
  for (let i = 1; i <= 8; i++) {
    games.push(game(i, 1.8, 0.75, { sport: i <= 4 ? 'tennis' : 'football' }));
  }
  const { combos } = searchCombos(pool(games), { ...DEFAULTS, maxPerSport: 2 });
  assert.ok(combos.length > 0);
  for (const m of combos) {
    const perSport = {};
    for (const l of m.legs) perSport[l.sport] = (perSport[l.sport] || 0) + 1;
    for (const [sport, count] of Object.entries(perSport)) {
      assert.ok(count <= 2, 'at most 2 legs from ' + sport + ', got ' + count);
    }
  }
  // With only two sports and max 2 each, nothing longer than 4 legs can exist.
  assert.ok(combos.every((m) => m.legCount === 4));
});

test('pool share per sport is capped so one sport cannot crowd out the rest', () => {
  const games = [];
  // Tennis legs have the best EV and would fill the whole pool uncapped…
  for (let i = 1; i <= 10; i++) games.push(game(i, 2, 0.8, { sport: 'tennis' }));
  // …while slightly worse football legs still deserve slots.
  for (let i = 11; i <= 14; i++) games.push(game(i, 2, 0.7, { sport: 'football' }));
  const legs = pool(games, { poolPerSport: 3, poolSize: 6 });
  assert.strictEqual(legs.length, 6);
  assert.strictEqual(legs.filter((l) => l.sport === 'tennis').length, 3);
  assert.strictEqual(legs.filter((l) => l.sport === 'football').length, 3);
});

test('combined probability and EV are the products of the legs', () => {
  const games = [];
  for (let i = 1; i <= 4; i++) games.push(game(i, 2, 0.8));
  const { combos } = searchCombos(pool(games, { shrinkToMarket: 0 }), { ...DEFAULTS, minOdds: 10, maxOdds: 20 });
  assert.strictEqual(combos.length, 1); // exactly one 4-leg combination at 2^4 = 16
  const m = combos[0];
  assert.ok(Math.abs(m.odds - 16) < 1e-9);
  assert.ok(Math.abs(m.prob - 0.8 ** 4) < 1e-9);
  assert.ok(Math.abs(m.ev - (0.8 ** 4 * 16 - 1)) < 1e-9);
  assert.ok(Math.abs(m.fairOdds - 1 / 0.8 ** 4) < 1e-9);
});

test('diverse selection skips near-identical multis', () => {
  const leg = (id) => ({ eventId: id, outcome: '1' });
  const ranked = [
    { legs: [leg(1), leg(2), leg(3), leg(4)] },
    { legs: [leg(1), leg(2), leg(3), leg(5)] }, // shares 3 legs — skipped
    { legs: [leg(1), leg(6), leg(7), leg(8)] }, // shares 1 leg — kept
  ];
  const picked = selectDiverse(ranked, 5, 1);
  assert.strictEqual(picked.length, 2);
  assert.strictEqual(picked[1].legs[1].eventId, 6);
});

test('a short window can carry its own relaxed leg rules', () => {
  // Games an hour out with small crowds — typical of a 3 h window.
  const soon = [1, 2, 3].map((i) =>
    game(i, 1.9, 0.6, { startTimestamp: NOW + 3600, totalVotes: 120 }));

  // Default rules (300 votes, 4 legs, $10 min) cannot build anything from these.
  const strict = buildMultis(soon, { multi: { windows: [3] } }, NOW);
  assert.strictEqual(strict, null, 'standard filters reject small-crowd games');

  // The same games with a per-window override do build a multi.
  const relaxed = buildMultis(soon, {
    multi: { windows: [{ hours: 3, minLegs: 3, minOdds: 5, minLegVotes: 100 }] },
  }, NOW);
  assert.ok(relaxed, 'per-window overrides let the short window build');
  const w = relaxed.windows.find((x) => x.hours === 3);
  assert.ok(w.multis.length >= 1);
  assert.strictEqual(w.multis[0].legCount, 3, 'three legs, per the override');
  assert.ok(w.multis[0].odds >= 5);
  assert.strictEqual(w.opts.minLegVotes, 100, 'window carries its own settings for the UI');
});

test('an empty window is kept so the UI can explain why it is empty', () => {
  const games = [1, 2, 3, 4].map((i) => game(i, 1.9, 0.62));
  // 3 h window has nothing (games are 1 h out but crowd is fine, so raise the bar);
  // 24 h window still builds, and both windows survive into the result.
  const result = buildMultis(games, {
    multi: { windows: [{ hours: 3, minLegVotes: 99999 }, 24] },
  }, NOW);
  assert.ok(result, 'result exists because one window built');
  assert.strictEqual(result.windows.length, 2, 'the empty window is retained');
  const short = result.windows.find((w) => w.hours === 3);
  assert.strictEqual(short.multis.length, 0);
  assert.strictEqual(short.poolSize, 0, 'pool size is reported so the UI can say why');
});

test('buildMultis returns a shortlist per window and honours enabled:false', () => {
  const games = [];
  for (let i = 1; i <= 10; i++) games.push(game(i, 1.7, 0.72));
  const result = buildMultis(games, { multi: { windows: [12, 24] } }, NOW);
  assert.strictEqual(result.windows.length, 2);
  for (const w of result.windows) {
    assert.ok(w.multis.length > 0 && w.multis.length <= DEFAULTS.count * 2);
    assert.ok(w.multis.every((m) => m.odds >= 10 && m.odds <= 20));
    // shortlist is probability-ranked
    for (let i = 1; i < w.multis.length; i++) assert.ok(w.multis[i - 1].prob >= w.multis[i].prob);
  }
  assert.strictEqual(buildMultis(games, { multi: { enabled: false } }, NOW), null);
  assert.strictEqual(buildMultis([game(1, 1.7, 0.72)], {}, NOW), null); // too few legs
});
