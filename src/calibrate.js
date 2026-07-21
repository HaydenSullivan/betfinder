// Fits the vote-blend weight from settled predictions by minimizing log loss.
// Output (data/calibration.json) overrides config.voteWeight, per sport where
// there is enough data, globally otherwise.
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');

const CALIBRATION_FILE = path.join(ledger.DATA_DIR, 'calibration.json');

function loadCalibration() {
  try {
    return JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function priorFor(sport, config) {
  if (config.voteWeightPriors && config.voteWeightPriors[sport] !== undefined) {
    return config.voteWeightPriors[sport];
  }
  return config.voteWeight;
}

// Empirical-Bayes shrinkage: the live fit is blended toward the backtest-seeded
// prior in proportion to how much live evidence exists. Without this, a single
// bad week can fit a sport's weight to zero and silence it entirely — which is
// exactly what one week of football did. Live data dominates as samples grow.
function voteWeightFor(sport, calibration, config) {
  const prior = priorFor(sport, config);
  const k = config.calibrationPriorStrength || 400;
  const fit = (calibration && calibration.sports && calibration.sports[sport])
    || (calibration && calibration.global)
    || null;
  if (!fit || !fit.samples) return prior;
  return (fit.samples * fit.voteWeight + k * prior) / (fit.samples + k);
}

// Effective crowd weight for a game: shrinks toward 0 for tiny vote counts
// (statistical noise) AND for huge ones — backtesting showed small-vote crowds
// (informed locals) beat big-vote crowds (casual fans of famous teams).
function effectiveVoteWeight(w, totalVotes, config) {
  const noise = totalVotes / (totalVotes + config.votePrior);
  const fame = config.voteCeiling / (config.voteCeiling + totalVotes);
  return w * noise * fame;
}

// Mean binary log loss of the blended probability at candidate weight w.
function logLossAt(w, samples, config) {
  let loss = 0;
  for (const s of samples) {
    const wEff = effectiveVoteWeight(w, s.totalVotes, config);
    let p = wEff * s.voteShare + (1 - wEff) * s.marketProb;
    p = Math.min(0.999, Math.max(0.001, p));
    loss -= s.won ? Math.log(p) : Math.log(1 - p);
  }
  return loss / samples.length;
}

function fitWeight(samples, config) {
  let best = { voteWeight: 0, logLoss: Infinity };
  for (let w = 0; w <= 0.6001; w += 0.025) {
    const loss = logLossAt(w, samples, config);
    if (loss < best.logLoss) best = { voteWeight: Number(w.toFixed(3)), logLoss: Number(loss.toFixed(5)) };
  }
  return best;
}

// Live per-sport flag gate: a sport whose settled flagged picks are clearly
// losing gets a raised EV bar until its record recovers. Data-driven and
// self-reversing — no hard-coded sport opinions.
function sportGatesFrom(entries, config) {
  const flagged = ledger.firstFlaggedSnapshots(entries).filter((e) => e.settled && e.result !== 'void');
  const bySport = new Map();
  for (const e of flagged) {
    if (!bySport.has(e.sport)) bySport.set(e.sport, []);
    bySport.get(e.sport).push(e);
  }
  const gates = {};
  for (const [sport, list] of bySport) {
    if (list.length < (config.sportGateMinSettled || 25)) continue;
    const units = list.reduce((s, e) => s + (e.result === 'won' ? e.odds - 1 : -1), 0);
    const roi = units / list.length;
    if (roi < -0.25) gates[sport] = { evBump: 0.06, n: list.length, roi: Number(roi.toFixed(3)) };
    else if (roi < -0.1) gates[sport] = { evBump: 0.03, n: list.length, roi: Number(roi.toFixed(3)) };
  }
  return gates;
}

// entries: full ledger. Uses the last snapshot per outcome, settled won/lost only,
// with vote data present.
function calibrate(entries, config, log = () => {}) {
  const usable = ledger
    .lastSnapshots(entries)
    .filter((e) => e.settled && (e.result === 'won' || e.result === 'lost'))
    .filter((e) => e.voteShare !== null && e.voteShare !== undefined && e.totalVotes > 0)
    .map((e) => ({
      sport: e.sport,
      voteShare: e.voteShare,
      marketProb: e.marketProb,
      totalVotes: e.totalVotes,
      won: e.result === 'won',
    }));

  const calibration = { updatedAt: new Date().toISOString(), samples: usable.length, global: null, sports: {} };
  if (usable.length >= config.calibrationMinSamplesGlobal) {
    calibration.global = { ...fitWeight(usable, config), samples: usable.length };
    const bySport = new Map();
    for (const s of usable) {
      if (!bySport.has(s.sport)) bySport.set(s.sport, []);
      bySport.get(s.sport).push(s);
    }
    for (const [sport, samples] of bySport) {
      if (samples.length >= config.calibrationMinSamplesSport) {
        calibration.sports[sport] = { ...fitWeight(samples, config), samples: samples.length };
      }
    }
    log(
      `  calibration: global voteWeight ${calibration.global.voteWeight} from ${usable.length} samples` +
        (Object.keys(calibration.sports).length ? `, per-sport: ${Object.keys(calibration.sports).join(', ')}` : '')
    );
  } else {
    log(`  calibration: ${usable.length}/${config.calibrationMinSamplesGlobal} settled samples — using config default`);
  }

  calibration.sportGates = sportGatesFrom(entries, config);
  const gated = Object.entries(calibration.sportGates);
  if (gated.length) {
    log(`  sport gates: ${gated.map(([s, g]) => `${s} +${(g.evBump * 100).toFixed(0)}% EV bar (roi ${(g.roi * 100).toFixed(0)}%, n=${g.n})`).join(', ')}`);
  }

  fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true });
  fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(calibration, null, 2));
  return calibration;
}

module.exports = { calibrate, loadCalibration, voteWeightFor, priorFor, effectiveVoteWeight, fitWeight, logLossAt, sportGatesFrom, CALIBRATION_FILE };
