const test = require('node:test');
const assert = require('node:assert');
const { powerDeVig, formScore, debiasVotes, analyzeGame } = require('../src/analyzer');

const config = {
  voteWeight: 0.35,
  votePrior: 500,
  voteCeiling: 15000,
  minVotes: 300,
  evThreshold: 0.05,
  maxOdds: 15,
  flagDraws: false,
  fanbaseDebias: true,
  fanShareClip: 0.2,
  formWeight: 0.08,
  driftThreshold: 0.15,
  driftPenalty: 0.03,
  lineupMissingDiff: 2,
  lineupPenalty: 0.03,
};

function game(overrides) {
  return {
    id: 1,
    sport: 'football',
    home: 'Home',
    away: 'Away',
    homeFollowers: null,
    awayFollowers: null,
    market: {
      marketName: 'Full time',
      outcomes: [
        { name: '1', odds: 2.6, openingOdds: 2.6, change: 0 },
        { name: 'X', odds: 3.3, openingOdds: 3.3, change: 0 },
        { name: '2', odds: 2.7, openingOdds: 2.7, change: 0 },
      ],
    },
    votes: { counts: { '1': 8000, X: 500, '2': 1500 }, total: 10000 },
    ...overrides,
  };
}

test('powerDeVig sums to 1 and shades favourites up vs proportional', () => {
  const outcomes = [
    { name: '1', odds: 1.44 },
    { name: 'X', odds: 4.33 },
    { name: '2', odds: 6.5 },
  ];
  const priced = powerDeVig(outcomes);
  const sum = priced.reduce((s, o) => s + o.marketProb, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
  // proportional would give 0.6435; power method corrects favourite-longshot bias upward
  assert.ok(priced[0].marketProb > 0.645 && priced[0].marketProb < 0.70);
  const proportionalLongshot = (1 / 6.5) / (1 / 1.44 + 1 / 4.33 + 1 / 6.5);
  assert.ok(priced[2].marketProb < proportionalLongshot);
});

test('formScore weights the newest results most (index 0 = most recent)', () => {
  const recentGood = formScore(['W', 'W', 'L', 'L', 'L']);
  const recentBad = formScore(['L', 'L', 'W', 'W', 'L']);
  assert.ok(recentGood > recentBad);
  assert.strictEqual(formScore(['W', 'L']), null); // fewer than 3 results
  assert.strictEqual(formScore(null), null);
});

test('debiasVotes discounts the team with the larger fanbase', () => {
  const counts = { '1': 9000, X: 500, '2': 500 };
  const even = debiasVotes(counts, 10000, { homeFollowers: 5000, awayFollowers: 5000 }, config);
  assert.ok(Math.abs(even['1'] - 0.9) < 1e-9); // equal fanbases leave shares unchanged
  const skewed = debiasVotes(counts, 10000, { homeFollowers: 900000, awayFollowers: 10000 }, config);
  assert.ok(skewed['1'] < 0.9);
  assert.ok(skewed['2'] > 0.05);
  const sum = skewed['1'] + skewed.X + skewed['2'];
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('heavily crowd-backed outcome at generous odds is flagged', () => {
  const result = analyzeGame(game(), config);
  const homePick = result.outcomes.find((o) => o.name === '1');
  assert.ok(homePick.ev > 0.1);
  assert.ok(homePick.flagged);
  assert.ok(!result.outcomes.find((o) => o.name === '2').flagged);
});

test('better recent form boosts the estimate, worse form dampens it', () => {
  const base = analyzeGame(game(), config);
  const inForm = analyzeGame(
    game({ form: { home: { form: ['W', 'W', 'W', 'W', 'W'] }, away: { form: ['L', 'L', 'L', 'L', 'L'] } } }),
    config
  );
  const outOfForm = analyzeGame(
    game({ form: { home: { form: ['L', 'L', 'L', 'L', 'L'] }, away: { form: ['W', 'W', 'W', 'W', 'W'] } } }),
    config
  );
  const est = (r) => r.outcomes.find((o) => o.name === '1').estProb;
  assert.ok(est(inForm) > est(base));
  assert.ok(est(outOfForm) < est(base));
  assert.ok(Math.abs(est(inForm) - est(base) - config.formWeight) < 1e-9); // full form gap = full weight
});

test('price drifting out against the pick is penalized and warned', () => {
  const drifted = analyzeGame(
    game({
      market: {
        marketName: 'Full time',
        outcomes: [
          { name: '1', odds: 2.6, openingOdds: 2.0, change: 1 },
          { name: 'X', odds: 3.3, openingOdds: 3.3, change: 0 },
          { name: '2', odds: 2.7, openingOdds: 2.9, change: -1 },
        ],
      },
    }),
    config
  );
  const pick = drifted.outcomes.find((o) => o.name === '1');
  assert.ok(pick.warnings.includes('drift'));
  assert.ok(Math.abs(pick.evRaw - pick.ev - config.driftPenalty) < 1e-9);
});

test('missing players on the pick side are penalized', () => {
  const result = analyzeGame(game({ lineups: { confirmed: true, homeMissing: 3, awayMissing: 0 } }), config);
  const pick = result.outcomes.find((o) => o.name === '1');
  assert.ok(pick.warnings.includes('absences'));
  const other = result.outcomes.find((o) => o.name === '2');
  assert.ok(!other.warnings.includes('absences'));
});

test('few votes shrink the estimate toward the market (no flag)', () => {
  const result = analyzeGame(game({ votes: { counts: { '1': 80, X: 5, '2': 15 }, total: 100 } }), config);
  const pick = result.outcomes.find((o) => o.name === '1');
  assert.ok(!pick.flagged);
  assert.ok(Math.abs(pick.estProb - pick.marketProb) < 0.03);
});

test('draws are not flagged unless flagDraws; no-vote games never flag', () => {
  const drawHeavy = game({ votes: { counts: { '1': 1000, X: 8000, '2': 1000 }, total: 10000 } });
  assert.ok(!analyzeGame(drawHeavy, config).outcomes.find((o) => o.name === 'X').flagged);
  assert.ok(analyzeGame(drawHeavy, { ...config, flagDraws: true }).outcomes.find((o) => o.name === 'X').flagged);
  const noVotes = analyzeGame(game({ votes: null }), config);
  assert.ok(noVotes.outcomes.every((o) => !o.flagged && o.voteShare === null));
  assert.strictEqual(noVotes.bestEv, -1);
});

test('calibration shrinks toward the prior instead of replacing it', () => {
  const cfg = { ...config, voteWeightPriors: { football: 0.5 }, calibrationPriorStrength: 400 };
  // A single bad week fits football to 0; shrinkage must keep it alive.
  const calibration = { global: { voteWeight: 0.1, samples: 2000 }, sports: { football: { voteWeight: 0, samples: 400 } } };
  const used = analyzeGame(game(), cfg, calibration).voteWeightUsed;
  assert.ok(Math.abs(used - 0.25) < 1e-9, `expected (400*0 + 400*0.5)/800 = 0.25, got ${used}`);
  assert.ok(used > 0, 'a zero fit must not silence the sport outright');

  // With overwhelming live evidence the fit dominates.
  const heavy = { sports: { football: { voteWeight: 0, samples: 40000 } } };
  assert.ok(analyzeGame(game(), cfg, heavy).voteWeightUsed < 0.01);

  // No fit at all -> pure prior.
  assert.strictEqual(analyzeGame(game(), cfg, null).voteWeightUsed, 0.5);
});
