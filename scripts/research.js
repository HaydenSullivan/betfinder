// Weekly research job: re-harvest recent finished games, re-validate every
// research signal out-of-sample, refit per-sport vote weights, and write a
// dated findings report to data/research/. Report-only — config changes stay
// a deliberate human/agent decision.
//
// Usage: node scripts/research.js [--days N] [--cap N]
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { BrowserClient } = require(path.join(ROOT, 'src', 'browserClient'));
const sofa = require(path.join(ROOT, 'src', 'sofascore'));
const { powerDeVig, debiasVotes } = require(path.join(ROOT, 'src', 'analyzer'));
const { fitWeight } = require(path.join(ROOT, 'src', 'calibrate'));
const ledger = require(path.join(ROOT, 'src', 'ledger'));

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf('--days') + 1]) || 7;
const CAP = Number(args[args.indexOf('--cap') + 1]) || 60;
const W = (c) => (c === 1 ? '1' : c === 2 ? '2' : 'X');

async function harvest(client) {
  const rows = [];
  for (let back = 1; back <= DAYS; back++) {
    const date = new Date(Date.now() - back * 86400000);
    for (const sport of config.sports) {
      let b1 = {};
      let b5 = {};
      try { b1 = await sofa.fetchBulkOdds(client, sport, date, config.oddsProviderId); } catch { continue; }
      try { b5 = await sofa.fetchBulkOdds(client, sport, date, config.consensusProviderId); } catch {}
      const ids = Object.keys(b1).slice(0, CAP);
      if (!ids.length) continue;
      const { results } = await client.getMany(ids.flatMap((id) => [`/api/v1/event/${id}`, `/api/v1/event/${id}/votes`]));
      for (const id of ids) {
        const ev = sofa.parseEvent((results.get(`/api/v1/event/${id}`) || {}).event);
        if (!ev || ev.statusType !== 'finished' || !ev.winnerCode) continue;
        const m1 = sofa.parseMarket(b1[id]);
        if (!m1) continue;
        rows.push({
          sport,
          date: sofa.dateKey(date),
          winner: W(ev.winnerCode),
          homeFollowers: ev.homeFollowers,
          awayFollowers: ev.awayFollowers,
          b1: m1.outcomes,
          b5: b5[id] ? (sofa.parseMarket(b5[id]) || {}).outcomes || null : null,
          votes: sofa.parseVotes((results.get(`/api/v1/event/${id}/votes`) || {}).vote),
        });
      }
    }
  }
  return rows;
}

const summary = (bets) => {
  if (!bets.length) return { n: 0 };
  const wins = bets.filter((b) => b.won).length;
  const pnl = bets.reduce((s, b) => s + (b.won ? b.odds - 1 : -1), 0);
  return { n: bets.length, hit: +(wins / bets.length).toFixed(3), roi: +(pnl / bets.length).toFixed(3), units: +pnl.toFixed(1) };
};

// Re-validate the odds-movement signals on fresh finished games.
function signalChecks(rows) {
  const drift = (o) => (o.openingOdds ? (o.odds - o.openingOdds) / o.openingOdds : null);
  const out = { driftCrowd: [], bigDrift: [], consensus: [] };
  for (const r of rows) {
    const crowdSide = r.votes && r.votes.total >= 100 ? ((r.votes.counts['1'] || 0) > (r.votes.counts['2'] || 0) ? '1' : '2') : null;
    const ref5 = r.b5 ? powerDeVig(r.b5) : null;
    for (const o of r.b1) {
      if (o.name === 'X' || o.odds > 6) continue;
      const d = drift(o);
      const won = o.name === r.winner;
      if (crowdSide === o.name && d !== null && d >= 0.05) out.driftCrowd.push({ won, odds: o.odds });
      if (d !== null && d >= 0.2) out.bigDrift.push({ won, odds: o.odds });
      if (ref5) {
        const p = ref5.find((x) => x.name === o.name);
        if (p && p.marketProb * o.odds - 1 >= 0.04) out.consensus.push({ won, odds: o.odds });
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, summary(v)]));
}

// Refit per-sport vote weights on fresh games (report-only).
function voteRefit(rows) {
  const bySport = new Map();
  for (const r of rows) {
    if (!r.votes || r.votes.total < 20 || r.winner === 'X') continue;
    const shares = debiasVotes(r.votes.counts, r.votes.total, r, config);
    const priced = powerDeVig(r.b1);
    for (const o of priced) {
      if (o.name === 'X') continue;
      if (!bySport.has(r.sport)) bySport.set(r.sport, []);
      bySport.get(r.sport).push({ voteShare: shares[o.name] || 0, marketProb: o.marketProb, totalVotes: r.votes.total, won: o.name === r.winner });
    }
  }
  const out = {};
  for (const [sport, samples] of bySport) {
    if (samples.length >= 60) out[sport] = { n: samples.length, ...fitWeight(samples, config) };
  }
  return out;
}

// Live-ledger analyses: CLV by flag lead time.
function clvByLead() {
  const flagged = ledger.firstFlaggedSnapshots(ledger.loadAllEntries()).filter((e) => e.settled && e.closingOdds);
  const out = {};
  for (const [lo, hi] of [[0, 2], [2, 6], [6, 12], [12, 48]]) {
    const sub = flagged.filter((e) => {
      const lead = (e.startTimestamp - Date.parse(e.scanAt) / 1000) / 3600;
      return lead >= lo && lead < hi;
    });
    if (sub.length) {
      const pts = sub.map((e) => 1 / e.closingOdds - 1 / e.odds);
      out[`${lo}-${hi}h`] = {
        n: sub.length,
        avgClvPoints: +(pts.reduce((s, x) => s + x, 0) / pts.length).toFixed(5),
        beatCloseRate: +(pts.filter((x) => x > 0.0005).length / pts.length).toFixed(3),
        units: +sub.reduce((s, e) => s + (e.result === 'won' ? e.odds - 1 : e.result === 'lost' ? -1 : 0), 0).toFixed(1),
      };
    }
  }
  return out;
}

(async () => {
  const client = new BrowserClient({ chromePath: config.chromePath || undefined, concurrency: 8, requestDelayMs: 40 });
  console.log(`research: harvesting ${DAYS} day(s), cap ${CAP}/sport/day…`);
  await client.start();
  let rows;
  try {
    rows = await harvest(client);
  } finally {
    await client.close();
  }
  const report = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    capPerSportDay: CAP,
    games: rows.length,
    withSecondBook: rows.filter((r) => r.b5).length,
    signals: signalChecks(rows),
    voteWeightRefit: voteRefit(rows),
    clvByFlagLead: clvByLead(),
  };
  const dir = path.join(ROOT, 'data', 'research');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `research-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  console.log(`saved ${file}`);
})().catch((e) => {
  console.error('research failed:', e.message);
  process.exit(1);
});
