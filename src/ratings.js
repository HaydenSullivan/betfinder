// Football team ratings — an edge source that depends on neither crowd
// sentiment nor market movement, unlike every other component in this tool.
//
// Elo-style ratings updated from match results, with margin-of-victory scaling
// and home advantage. Ratings convert to 1X2 probabilities via a draw model
// calibrated from the same history, so the output is directly comparable to a
// de-vigged market price.
const fs = require('fs');
const path = require('path');

const RATINGS_FILE = path.join(__dirname, '..', 'data', 'ratings.json');
const START = 1500;

// Expected score (win=1, draw=0.5) for A vs B on the Elo logistic curve.
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Goal margin dampens as it grows — a 5-0 is not 5x as informative as a 1-0.
// Floored at 1 so draws and one-goal games still move ratings: a draw against a
// much weaker side is real information, and roughly a quarter of football
// results are draws.
function marginMultiplier(goalDiff) {
  return 1 + Math.log(Math.max(1, Math.abs(goalDiff)));
}

// One result updates both teams. `homeAdv` is in rating points.
function updateRatings(ratings, match, opts) {
  const { k = 20, homeAdv = 60 } = opts || {};
  const home = ratings[match.homeId] ?? START;
  const away = ratings[match.awayId] ?? START;
  const exp = expectedScore(home + homeAdv, away);
  const diff = match.homeScore - match.awayScore;
  const actual = diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  const move = k * marginMultiplier(diff) * (actual - exp);
  ratings[match.homeId] = home + move;
  ratings[match.awayId] = away - move;
  return ratings;
}

// Build ratings from a chronological match list.
function buildRatings(matches, opts) {
  const ratings = {};
  const sorted = [...matches].sort((a, b) => a.startTimestamp - b.startTimestamp);
  for (const m of sorted) {
    if (m.homeScore == null || m.awayScore == null || !m.homeId || !m.awayId) continue;
    updateRatings(ratings, m, opts);
  }
  return ratings;
}

// Rating gap -> 1X2 probabilities. The draw share peaks when teams are level
// and decays as the gap widens; drawBase/drawDecay are fitted from history.
function ratingsToProbs(homeRating, awayRating, opts) {
  const { homeAdv = 60, drawBase = 0.28, drawDecay = 0.0016 } = opts || {};
  const gap = homeRating + homeAdv - awayRating;
  const pHomeIfDecisive = expectedScore(homeRating + homeAdv, awayRating);
  const pDraw = Math.max(0.05, Math.min(0.4, drawBase * Math.exp(-drawDecay * Math.abs(gap))));
  const rest = 1 - pDraw;
  return { '1': pHomeIfDecisive * rest, X: pDraw, '2': (1 - pHomeIfDecisive) * rest };
}

function saveRatings(ratings, meta) {
  fs.mkdirSync(path.dirname(RATINGS_FILE), { recursive: true });
  fs.writeFileSync(RATINGS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), ...meta, ratings }, null, 0));
}

function loadRatings() {
  try {
    return JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  START, expectedScore, marginMultiplier, updateRatings, buildRatings,
  ratingsToProbs, saveRatings, loadRatings, RATINGS_FILE,
};
