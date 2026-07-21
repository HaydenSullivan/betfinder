// Builds multibets (accumulators) from the analyzed single-game outcomes.
//
// Two things make a multi different from a single bet:
//   1) Errors compound. Five legs each 3 points too optimistic is a ~15% overstated
//      multi. So each leg's probability is first pulled back toward the de-vigged
//      market price (shrinkToMarket) before the legs are multiplied together.
//   2) Legs must be independent. Two outcomes of the same event are perfectly
//      correlated (and unbookable together), and legs from the same tournament move
//      together often enough to cap — see maxPerTournament.
//
// The search then finds leg combinations whose combined price lands in the target
// band (default $10–$20) at the requested leg count, ranked two ways:
//   likeliest — highest combined probability
//   value     — highest combined EV (prob × odds − 1)
const DEFAULTS = {
  enabled: true,
  windows: [12, 24],
  minOdds: 10,
  maxOdds: 20,
  minLegs: 4,
  maxLegs: 6,
  minLegProb: 0.5,
  minLegOdds: 1.2,
  maxLegOdds: 4,
  minLegEv: -0.02,
  minLegVotes: 300,
  includeDraws: false,
  maxPerTournament: 2,
  poolSize: 40,
  shrinkToMarket: 0.25,
  count: 6,
  maxSharedLegs: 2,
  nodeBudget: 4e6,
  keepPerRanking: 400,
};

const legKey = (leg) => leg.eventId + '|' + leg.outcome;

// One candidate leg per qualifying outcome, best-edge first, capped at poolSize.
function buildLegPool(games, opts, nowSec) {
  const windowEnd = nowSec + opts.hours * 3600;
  const legs = [];
  for (const game of games) {
    if (game.startTimestamp < nowSec - 300 || game.startTimestamp > windowEnd) continue;
    if (!game.totalVotes || game.totalVotes < opts.minLegVotes) continue;
    for (const o of game.outcomes) {
      if (o.voteShare === null) continue; // no crowd signal — model is just the market
      if (o.name === 'X' && !opts.includeDraws) continue;
      if (o.odds < opts.minLegOdds || o.odds > opts.maxLegOdds) continue;
      // Shrink toward the market before compounding, then re-judge the leg on the
      // shrunk number so the filters and the multi maths agree.
      const prob = (1 - opts.shrinkToMarket) * o.estProb + opts.shrinkToMarket * o.marketProb;
      if (prob < opts.minLegProb) continue;
      const ev = prob * o.odds - 1;
      if (ev < opts.minLegEv) continue;
      legs.push({
        eventId: game.id,
        outcome: o.name,
        pick: o.name === '1' ? game.home : o.name === '2' ? game.away : 'Draw',
        sport: game.sport,
        home: game.home,
        away: game.away,
        tournament: game.tournament,
        country: game.country,
        url: game.url,
        startTimestamp: game.startTimestamp,
        odds: o.odds,
        prob,
        estProb: o.estProb,
        marketProb: o.marketProb,
        singleEv: o.ev,
        ev,
        flagged: o.flagged,
        warnings: o.warnings || [],
      });
    }
  }
  legs.sort((a, b) => b.ev - a.ev);
  return legs.slice(0, opts.poolSize).sort((a, b) => a.odds - b.odds);
}

function summarize(legs) {
  let odds = 1;
  let prob = 1;
  let marketProb = 1;
  for (const leg of legs) {
    odds *= leg.odds;
    prob *= leg.prob;
    marketProb *= leg.marketProb;
  }
  return {
    key: legs.map(legKey).sort().join(','),
    legs: legs.slice(),
    legCount: legs.length,
    odds,
    prob,
    marketProb,
    fairOdds: 1 / prob,
    ev: prob * odds - 1,
    edge: prob - marketProb,
    flaggedLegs: legs.filter((l) => l.flagged).length,
    firstStart: Math.min(...legs.map((l) => l.startTimestamp)),
    lastStart: Math.max(...legs.map((l) => l.startTimestamp)),
  };
}

// A leaderboard of the best `size` multis by one measure, kept sorted descending.
// `floor` is the score to beat once full — the search uses it to skip building a
// summary object (and to abandon whole branches) for combos that cannot place.
function leaderboard(size, score) {
  const items = [];
  return {
    get floor() { return items.length < size ? -Infinity : score(items[items.length - 1]); },
    wants(value) { return items.length < size || value > score(items[items.length - 1]); },
    add(multi) {
      const value = score(multi);
      if (!this.wants(value)) return;
      let i = items.length;
      while (i > 0 && score(items[i - 1]) < value) i--;
      items.splice(i, 0, multi);
      if (items.length > size) items.pop();
    },
    items,
  };
}

// Depth-first over a pool sorted by ascending odds. Four prunes carry the search:
// combined odds only ever grow, so once a branch overshoots maxOdds every later
// (longer-priced) leg overshoots too; a branch that cannot reach minOdds even by
// taking the longest remaining legs is dead; and since probability only falls as
// legs are added — and EV is capped at prob × maxOdds − 1 — a branch that can no
// longer place on either leaderboard is dead too.
function searchCombos(pool, opts) {
  const n = pool.length;
  // tail[k] = product of the k longest odds in the pool (the last k, pool is ascending).
  const tail = [1];
  for (let k = 1; k <= n; k++) tail[k] = tail[k - 1] * pool[n - k].odds;

  const byProb = leaderboard(opts.keepPerRanking, (m) => m.prob);
  const byEv = leaderboard(opts.keepPerRanking, (m) => m.ev);
  const chosen = [];
  const usedEvents = new Set();
  const tourCount = new Map();
  let nodes = 0;
  let total = 0;

  function dfs(start, oddsProd, probProd) {
    if (nodes++ > opts.nodeBudget) return;
    if (chosen.length >= opts.minLegs && oddsProd >= opts.minOdds) {
      total++;
      if (byProb.wants(probProd) || byEv.wants(probProd * oddsProd - 1)) {
        const multi = summarize(chosen);
        byProb.add(multi);
        byEv.add(multi);
      }
    }
    if (chosen.length >= opts.maxLegs) return;
    // Nothing deeper in this branch can place on either leaderboard.
    if (probProd <= byProb.floor && probProd * opts.maxOdds - 1 <= byEv.floor) return;
    for (let i = start; i < n; i++) {
      const leg = pool[i];
      const odds = oddsProd * leg.odds;
      if (odds > opts.maxOdds) break; // ascending odds — nothing later fits either
      if (usedEvents.has(leg.eventId)) continue;
      if ((tourCount.get(leg.tournament) || 0) >= opts.maxPerTournament) continue;
      // Can this branch still reach minOdds with the legs it has room for?
      const room = opts.maxLegs - chosen.length - 1;
      if (odds * tail[Math.min(room, n - 1 - i)] < opts.minOdds) continue;

      chosen.push(leg);
      usedEvents.add(leg.eventId);
      tourCount.set(leg.tournament, (tourCount.get(leg.tournament) || 0) + 1);
      dfs(i + 1, odds, probProd * leg.prob);
      tourCount.set(leg.tournament, tourCount.get(leg.tournament) - 1);
      usedEvents.delete(leg.eventId);
      chosen.pop();
    }
  }
  dfs(0, 1, 1);
  const combos = new Map();
  for (const multi of [...byProb.items, ...byEv.items]) combos.set(multi.key, multi);
  return { combos: [...combos.values()], total, truncated: nodes > opts.nodeBudget };
}

// Greedy pick down a ranked list, skipping anything that reuses too many legs of an
// already-picked multi — otherwise the top six are the same bet with one leg swapped.
function selectDiverse(ranked, count, maxSharedLegs) {
  const picked = [];
  for (const cand of ranked) {
    const keys = new Set(cand.legs.map(legKey));
    const tooSimilar = picked.some(
      (p) => p.legs.filter((l) => keys.has(legKey(l))).length > maxSharedLegs
    );
    if (tooSimilar) continue;
    picked.push(cand);
    if (picked.length >= count) break;
  }
  return picked;
}

// One window (e.g. the next 12 h): pool → search → two rankings → merged shortlist.
function buildWindow(games, config, hours, nowSec) {
  const opts = { ...DEFAULTS, ...(config.multi || {}), hours };
  const pool = buildLegPool(games, opts, nowSec);
  const empty = { hours, poolSize: pool.length, multis: [], truncated: false };
  if (pool.length < opts.minLegs) return empty;

  const { combos, total, truncated } = searchCombos(pool, opts);
  if (!combos.length) return { ...empty, truncated };

  const byProb = combos.slice().sort((a, b) => b.prob - a.prob || b.ev - a.ev);
  const byEv = combos.slice().sort((a, b) => b.ev - a.ev || b.prob - a.prob);
  const shortlist = [];
  const seen = new Set();
  for (const list of [
    selectDiverse(byProb, opts.count, opts.maxSharedLegs),
    selectDiverse(byEv, opts.count, opts.maxSharedLegs),
  ]) {
    for (const multi of list) {
      if (seen.has(multi.key)) continue;
      seen.add(multi.key);
      shortlist.push(multi);
    }
  }
  shortlist.sort((a, b) => b.prob - a.prob);
  return { hours, poolSize: pool.length, candidates: total, truncated, multis: shortlist };
}

// Entry point: one shortlist per configured window, plus the settings used.
function buildMultis(games, config, nowSec = Date.now() / 1000) {
  const opts = { ...DEFAULTS, ...(config.multi || {}) };
  if (!opts.enabled) return null;
  const windows = opts.windows
    .filter((h) => h > 0)
    .map((hours) => buildWindow(games, config, hours, nowSec))
    .filter((w) => w.multis.length);
  if (!windows.length) return null;
  return {
    windows,
    settings: {
      minOdds: opts.minOdds,
      maxOdds: opts.maxOdds,
      minLegs: opts.minLegs,
      maxLegs: opts.maxLegs,
      shrinkToMarket: opts.shrinkToMarket,
      maxPerTournament: opts.maxPerTournament,
    },
  };
}

module.exports = { DEFAULTS, buildLegPool, searchCombos, selectDiverse, buildWindow, buildMultis };
