// Turns odds, crowd votes, fanbase sizes, and team form into value-bet signals.
//
// Per outcome i of a game:
//   marketProb_i — implied probability via POWER de-vig (corrects favourite-
//                  longshot bias: proportional de-vig overstates longshots).
//   voteShare_i  — crowd vote share, debiased by relative fanbase size
//                  (popular teams get votes from fans, not from information).
//   estProb_i    = w · voteShare_i + (1 − w) · marketProb_i,
//                  w = voteWeight(sport) · votes / (votes + votePrior);
//                  voteWeight comes from calibration when enough history exists.
//   form         — recent-form differential nudges estProb toward the in-form side.
//   EV_i         = estProb_i · odds_i − 1, minus penalties for market drift
//                  against the pick and for missing players on the pick side.
const { voteWeightFor, effectiveVoteWeight } = require('./calibrate');

// Find k such that sum((1/odds_i)^k) = 1 (bisection), probabilities = (1/odds)^k.
function powerDeVig(outcomes) {
  const raw = outcomes.map((o) => 1 / o.odds);
  const total = (k) => raw.reduce((s, p) => s + Math.pow(p, k), 0);
  let lo = 0.5;
  let hi = 5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const sum = total(k);
  return outcomes.map((o, i) => ({ ...o, marketProb: Math.pow(raw[i], k) / sum }));
}

// Newest-first form array ("W"/"D"/"L") -> score in [0,1], recent games weighted more.
function formScore(form) {
  if (!Array.isArray(form) || form.length < 3) return null;
  const value = { W: 1, D: 0.5, L: 0 };
  let weighted = 0;
  let weightSum = 0;
  form.slice(0, 5).forEach((r, i) => {
    if (!(r in value)) return;
    const weight = 5 - i; // index 0 = most recent
    weighted += value[r] * weight;
    weightSum += weight;
  });
  return weightSum ? weighted / weightSum : null;
}

// Divide each side's vote share by its share of the combined fanbase, then
// renormalize. Fan share is clipped so extreme follower gaps can't explode votes.
function debiasVotes(counts, total, event, config) {
  const shares = { '1': counts['1'] / total, X: counts.X / total, '2': counts['2'] / total };
  const { homeFollowers, awayFollowers } = event;
  if (!config.fanbaseDebias || !homeFollowers || !awayFollowers) return shares;
  const clip = config.fanShareClip;
  const fanHome = Math.min(1 - clip, Math.max(clip, homeFollowers / (homeFollowers + awayFollowers)));
  const adjusted = {
    '1': shares['1'] / (fanHome * 2), // ÷2 so equal fanbases leave shares unchanged
    X: shares.X,
    '2': shares['2'] / ((1 - fanHome) * 2),
  };
  const sum = adjusted['1'] + adjusted.X + adjusted['2'];
  return { '1': adjusted['1'] / sum, X: adjusted.X / sum, '2': adjusted['2'] / sum };
}

const clampProb = (p) => Math.min(0.98, Math.max(0.02, p));

function analyzeGame(game, config, calibration = null) {
  const priced = powerDeVig(game.market.outcomes);
  const votes = game.votes; // { counts, total } or null
  const voteWeight = voteWeightFor(game.sport, calibration, config);
  const w = votes ? effectiveVoteWeight(voteWeight, votes.total, config) : 0;
  const shares = votes ? debiasVotes(votes.counts, votes.total, game, config) : null;

  // Quality-adjusted form (margins + opponent strength) when computed;
  // otherwise the plain last-5 W/D/L letters.
  const rich = game.richForm && game.richForm.home && game.richForm.away;
  const homeForm = rich ? game.richForm.home.score : game.form ? formScore(game.form.home.form) : null;
  const awayForm = rich ? game.richForm.away.score : game.form ? formScore(game.form.away.form) : null;
  const formAvailable = homeForm !== null && awayForm !== null;

  const analyzed = priced.map((outcome) => {
    const voteShareRaw = votes ? (votes.counts[outcome.name] || 0) / votes.total : null;
    const voteShare = shares ? shares[outcome.name] || 0 : null;
    let estProb = voteShare === null ? outcome.marketProb : w * voteShare + (1 - w) * outcome.marketProb;

    // Form nudge: positive when the picked side is in better recent form.
    let formEdge = null;
    if (formAvailable && outcome.name !== 'X') {
      formEdge = outcome.name === '1' ? homeForm - awayForm : awayForm - homeForm;
      estProb = clampProb(estProb + config.formWeight * formEdge);
    }

    const evRaw = estProb * outcome.odds - 1;
    const warnings = [];
    let penalty = 0;

    // Market drifting out against the pick usually means news the crowd hasn't priced.
    if (outcome.openingOdds && outcome.odds >= outcome.openingOdds * (1 + config.driftThreshold)) {
      penalty += config.driftPenalty;
      warnings.push('drift');
    }
    // Missing players on the pick side (teams only, not draws).
    if (game.lineups && outcome.name !== 'X') {
      const own = outcome.name === '1' ? game.lineups.homeMissing : game.lineups.awayMissing;
      const other = outcome.name === '1' ? game.lineups.awayMissing : game.lineups.homeMissing;
      if (own - other >= config.lineupMissingDiff) {
        penalty += config.lineupPenalty;
        warnings.push('absences');
      }
    }

    const ev = evRaw - penalty;
    const isDraw = outcome.name === 'X';
    const flagged =
      voteShare !== null &&
      votes.total >= config.minVotes &&
      outcome.odds <= config.maxOdds &&
      (!isDraw || config.flagDraws) &&
      ev >= config.evThreshold;

    return {
      ...outcome,
      voteShareRaw,
      voteShare,
      voteCount: votes ? votes.counts[outcome.name] || 0 : null,
      formEdge,
      estProb,
      evRaw,
      penalty,
      warnings,
      ev,
      flagged,
    };
  });

  return {
    ...game,
    outcomes: analyzed,
    voteWeightUsed: voteWeight,
    homeFormScore: homeForm,
    awayFormScore: awayForm,
    formSource: formAvailable ? (rich ? 'rich' : 'letters') : null,
    totalVotes: votes ? votes.total : 0,
    bestEv: Math.max(...analyzed.map((o) => (o.voteShare === null ? -1 : o.ev))),
    flags: analyzed.filter((o) => o.flagged),
  };
}

function analyzeAll(games, config, calibration = null) {
  const analyzed = games.map((game) => analyzeGame(game, config, calibration));
  analyzed.sort((a, b) => b.bestEv - a.bestEv);
  return analyzed;
}

module.exports = { powerDeVig, formScore, debiasVotes, analyzeGame, analyzeAll };
