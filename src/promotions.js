// Shadow-signal promotion gate: research signals graduate to real flags only on
// live settled evidence (n, ROI and CLV thresholds), and are demoted when live
// performance decays. One place defines what each signal means, so logging,
// scoring and flagging can never drift apart.
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');
const { powerDeVig } = require('./analyzer');

const PROMOTIONS_FILE = path.join(ledger.DATA_DIR, 'promotions.json');

// Log-only research fields stored on every ledger entry. `prior` is the most
// recent previously-logged snapshot of the same outcome (dedupe means it is the
// last *changed* state), enabling between-scan deltas like the vote surge.
function researchFields(game, o, prior) {
  const drift = o.openingOdds ? Number(((o.odds - o.openingOdds) / o.openingOdds).toFixed(4)) : null;
  let b5Odds = null;
  let consensusEv = null;
  if (game.b5) {
    const match = game.b5.outcomes.find((x) => x.name === o.name);
    if (match) {
      b5Odds = match.odds;
      const priced = powerDeVig(game.b5.outcomes).find((x) => x.name === o.name);
      if (priced) consensusEv = Number((priced.marketProb * o.odds - 1).toFixed(4));
    }
  }
  const counts = game.votes ? game.votes.counts : null;
  const crowdMajority = counts ? ((counts['1'] || 0) > (counts['2'] || 0) ? '1' : '2') === o.name : false;
  // Vote surge: crowd share jumped since the last logged snapshot while the
  // price stood still — the crowd moving ahead of the bookmaker.
  let voteShareDelta = null;
  let oddsSincePrior = null;
  if (prior && prior.voteShareRaw != null && o.voteShareRaw != null && prior.odds) {
    voteShareDelta = Number((o.voteShareRaw - prior.voteShareRaw).toFixed(4));
    oddsSincePrior = Number(((o.odds - prior.odds) / prior.odds).toFixed(4));
  }
  return {
    drift,
    b5Odds,
    consensusEv,
    crowdMajority,
    voteShareDelta,
    // H2 (validated out-of-sample): crowd-majority side whose price drifted out >=5%
    shadowDriftCrowd: Boolean(crowdMajority && drift !== null && drift >= 0.05 && game.totalVotes >= 100),
    shadowVoteSurge: Boolean(
      voteShareDelta !== null &&
        voteShareDelta >= 0.03 &&
        Math.abs(oddsSincePrior) <= 0.01 &&
        (game.totalVotes || 0) >= 300 &&
        o.odds <= 6 &&
        o.name !== 'X'
    ),
  };
}

const SIGNALS = {
  driftCrowd: {
    label: 'crowd-side drifted out',
    badge: '⚡ drift signal',
    fires: (o, r) => r.shadowDriftCrowd && o.odds <= 6 && o.name !== 'X',
    settledMatch: (e) => e.shadowDriftCrowd && e.odds <= 6 && e.outcome !== 'X',
  },
  consensus: {
    label: 'bet365 outlier vs 2nd book',
    badge: '⚡ consensus signal',
    fires: (o, r) => r.consensusEv != null && r.consensusEv >= 0.04 && o.odds <= 6 && o.name !== 'X',
    settledMatch: (e) => e.consensusEv != null && e.consensusEv >= 0.04 && e.odds <= 6 && e.outcome !== 'X',
  },
  // H3 (whole-panel, not split-validated — the gate adjudicates live): any side
  // whose price blew out >=20% from open beat the close by ~+19% ROI.
  bigDrift: {
    label: 'extreme drift ≥20%',
    badge: '⚡ big-drift signal',
    fires: (o, r) => r.drift != null && r.drift >= 0.2 && o.odds <= 6 && o.name !== 'X',
    settledMatch: (e) => e.drift != null && e.drift >= 0.2 && e.odds <= 6 && e.outcome !== 'X',
  },
  // Novel: crowd share rose >=3pts between scans while the price moved <=1%.
  voteSurge: {
    label: 'crowd surged, line static',
    badge: '⚡ vote-surge signal',
    fires: (o, r) => r.shadowVoteSurge,
    settledMatch: (e) => e.shadowVoteSurge && e.odds <= 6 && e.outcome !== 'X',
  },
};

function scoreSignal(entries, match) {
  const list = ledger
    .lastSnapshots(entries)
    .filter((e) => e.settled && (e.result === 'won' || e.result === 'lost'))
    .filter(match);
  if (!list.length) return { n: 0, roi: null, clv: null };
  const pnl = list.reduce((s, e) => s + (e.result === 'won' ? e.odds - 1 : -1), 0);
  const clvs = list.filter((e) => e.clv != null);
  return {
    n: list.length,
    roi: Number((pnl / list.length).toFixed(4)),
    clv: clvs.length ? Number((clvs.reduce((s, e) => s + e.clv, 0) / clvs.length).toFixed(4)) : null,
  };
}

// Pure transition rule (tested in isolation). Promotion needs full evidence;
// demotion thresholds sit below promotion ones so the status doesn't flap.
function nextStatus(was, stats, rules) {
  if (was !== 'promoted') {
    const ready =
      stats.n >= rules.minSettled &&
      stats.roi !== null && stats.roi >= rules.promoteRoi &&
      stats.clv !== null && stats.clv >= rules.promoteClv;
    return ready ? 'promoted' : 'shadow';
  }
  const decayed = stats.roi !== null && (stats.roi < rules.demoteRoi || (stats.clv !== null && stats.clv < rules.demoteClv));
  return decayed ? 'shadow' : 'promoted';
}

function loadPromotions() {
  try {
    return JSON.parse(fs.readFileSync(PROMOTIONS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function evaluatePromotions(entries, config, log = () => {}) {
  const rules = config.promotion;
  const prev = loadPromotions() || { signals: {} };
  const state = { updatedAt: new Date().toISOString(), rules, signals: {} };
  for (const [key, sig] of Object.entries(SIGNALS)) {
    const stats = scoreSignal(entries, sig.settledMatch);
    const was = (prev.signals[key] && prev.signals[key].status) || 'shadow';
    const status = nextStatus(was, stats, rules);
    if (status !== was) {
      log(`  promotion gate: ${key} ${was} -> ${status} (n=${stats.n} roi=${stats.roi} clv=${stats.clv})`);
    }
    state.signals[key] = {
      status,
      label: sig.label,
      ...stats,
      since: status !== was ? state.updatedAt : (prev.signals[key] && prev.signals[key].since) || state.updatedAt,
    };
  }
  fs.mkdirSync(path.dirname(PROMOTIONS_FILE), { recursive: true });
  fs.writeFileSync(PROMOTIONS_FILE, JSON.stringify(state, null, 2));
  return state;
}

// Flag outcomes matched by promoted signals (mutates analyzed games).
// Stashes o.research so the ledger logs identical values.
function applyPromotedSignals(analyzed, promotions, priorLast = new Map()) {
  let added = 0;
  for (const game of analyzed) {
    for (const o of game.outcomes) {
      if (o.voteShare === null) continue;
      const r = researchFields(game, o, priorLast.get(`${game.id}|${o.name}`));
      o.research = r;
      const hits = Object.keys(SIGNALS).filter((key) => {
        const p = promotions.signals[key];
        return p && p.status === 'promoted' && SIGNALS[key].fires(o, r);
      });
      if (hits.length) {
        o.signals = hits;
        if (!o.flagged) {
          o.flagged = true;
          added++;
        }
      }
    }
    game.flags = game.outcomes.filter((x) => x.flagged);
  }
  return added;
}

module.exports = { researchFields, SIGNALS, scoreSignal, nextStatus, evaluatePromotions, applyPromotedSignals, loadPromotions, PROMOTIONS_FILE };
