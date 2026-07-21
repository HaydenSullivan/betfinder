// Renders the scan + track record as a self-contained HTML dashboard.
const ledger = require('./ledger');
const { SIGNALS } = require('./promotions');

const SPORT_LABELS = {
  football: 'Soccer',
  tennis: 'Tennis',
  basketball: 'Basketball',
  baseball: 'Baseball',
  volleyball: 'Volleyball',
  handball: 'Handball',
  esports: 'Esports',
  rugby: 'Rugby',
  'aussie-rules': 'AFL',
  'ice-hockey': 'Ice Hockey',
  'american-football': 'NFL',
  darts: 'Darts',
  'table-tennis': 'Table Tennis',
  cricket: 'Cricket',
};

// Assemble everything the dashboard shows: current scan + settled record + calibration.
function prepareReportData({ generatedAt, windowHours, config, games, calibration, ledgerEntries, multis, promotions }) {
  const entries = ledgerEntries || [];

  // Record: earliest flagged snapshot per outcome, settled only, flat 1-unit stakes.
  const picks = ledger
    .firstFlaggedSnapshots(entries)
    .filter((e) => e.settled)
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
  let units = 0;
  const recordPicks = picks.map((e) => {
    const pnl = e.result === 'won' ? e.odds - 1 : e.result === 'lost' ? -1 : 0;
    units += pnl;
    return {
      scanAt: e.scanAt,
      startTimestamp: e.startTimestamp,
      sport: e.sport,
      home: e.home,
      away: e.away,
      tournament: e.tournament,
      pickTeam: e.pickTeam,
      outcome: e.outcome,
      odds: e.odds,
      closingOdds: e.closingOdds,
      clv: e.clv,
      // CLV in implied-probability points. The odds-ratio form is dominated by
      // longshots (15.00 -> 5.75 reads as +161%), which made the headline
      // average meaningless; probability points weight every price fairly.
      clvPoints: e.closingOdds ? 1 / e.closingOdds - 1 / e.odds : null,
      result: e.result,
      finalScore: e.finalScore,
      pnl,
      cumulative: Number(units.toFixed(3)),
      url: e.url,
    };
  });
  const decided = recordPicks.filter((p) => p.result !== 'void');
  const wins = decided.filter((p) => p.result === 'won').length;
  const clvValues = recordPicks.filter((p) => p.clv !== null && p.clv !== undefined).map((p) => p.clv);
  const clvPointValues = recordPicks.filter((p) => p.clvPoints != null).map((p) => p.clvPoints);
  const record = {
    picks: recordPicks,
    settled: decided.length,
    wins,
    hitRate: decided.length ? wins / decided.length : null,
    roi: decided.length ? units / decided.length : null,
    units: Number(units.toFixed(2)),
    avgClv: clvValues.length ? clvValues.reduce((s, x) => s + x, 0) / clvValues.length : null,
    avgClvPoints: clvPointValues.length ? clvPointValues.reduce((s, x) => s + x, 0) / clvPointValues.length : null,
    beatCloseRate: clvPointValues.length ? clvPointValues.filter((x) => x > 0.0005).length / clvPointValues.length : null,
  };

  // Calibration buckets: every settled outcome (not just flagged), last snapshot.
  const settledAll = ledger
    .lastSnapshots(entries)
    .filter((e) => e.settled && (e.result === 'won' || e.result === 'lost') && e.estProb != null);
  const edges = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0001];
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const inBucket = settledAll.filter((e) => e.estProb >= edges[i] && e.estProb < edges[i + 1]);
    if (!inBucket.length) continue;
    buckets.push({
      label: `${Math.round(edges[i] * 100)}–${Math.round(Math.min(edges[i + 1], 1) * 100)}%`,
      n: inBucket.length,
      predicted: inBucket.reduce((s, e) => s + e.estProb, 0) / inBucket.length,
      actual: inBucket.filter((e) => e.result === 'won').length / inBucket.length,
    });
  }

  // Shadow-signal scoreboard: research signals logged on every entry, scored
  // live as games settle. A signal earns promotion only with positive live ROI.
  const settledLast = ledger
    .lastSnapshots(entries)
    .filter((e) => e.settled && (e.result === 'won' || e.result === 'lost'));
  const scoreShadow = (list) => {
    if (!list.length) return { n: 0, roi: null, clv: null };
    const pnl = list.reduce((s, e) => s + (e.result === 'won' ? e.odds - 1 : -1), 0);
    const clvs = list.filter((e) => e.closingOdds);
    return {
      n: list.length,
      roi: pnl / list.length,
      clv: clvs.length ? clvs.reduce((s, e) => s + (1 / e.closingOdds - 1 / e.odds), 0) / clvs.length : null,
    };
  };
  const shadows = {};
  for (const [key, sig] of Object.entries(SIGNALS)) {
    shadows[key] = { label: sig.label, ...scoreShadow(settledLast.filter(sig.settledMatch)) };
  }

  // Performance attribution: the settled record sliced by what generated each
  // pick (core model vs promoted signals) and by sport — so a blended total
  // can never hide which engine is earning and which is bleeding.
  const attribution = (() => {
    const groups = new Map();
    const add = (key, e) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    };
    for (const e of picks) {
      add('src:' + (e.signals && e.signals.length ? e.signals[0] : 'model'), e);
      add('sport:' + e.sport, e);
    }
    const rows = [];
    for (const [key, list] of groups) {
      const decided = list.filter((e) => e.result !== 'void');
      if (!decided.length) continue;
      const wins = decided.filter((e) => e.result === 'won').length;
      const units = decided.reduce((s, e) => s + (e.result === 'won' ? e.odds - 1 : -1), 0);
      const clvs = list.filter((e) => e.closingOdds);
      rows.push({
        key,
        n: decided.length,
        hit: wins / decided.length,
        units: Number(units.toFixed(2)),
        roi: units / decided.length,
        clv: clvs.length ? clvs.reduce((s, e) => s + (1 / e.closingOdds - 1 / e.odds), 0) / clvs.length : null,
      });
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : 1));
    return rows;
  })();

  return {
    generatedAt,
    windowHours,
    config,
    games,
    multis: multis || null,
    record,
    buckets,
    shadows,
    attribution,
    promotions: promotions || null,
    calibration: calibration || null,
    sportLabels: SPORT_LABELS,
  };
}

function buildReport(data) {
  const payload = JSON.stringify(data).replace(/<\//g, '<\\/');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BetFinder — value scan & record</title>
<style>
  :root {
    color-scheme: light;
    --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e;
    --muted: #898781; --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
    --home: #2a78d6; --draw: #c3c2b7; --away: #e34948;
    --good: #0ca30c; --good-text: #006300; --warn: #ec835a; --loss: #d03b3b; --chip: #f0efec;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
      --muted: #898781; --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
      --home: #3987e5; --draw: #383835; --away: #e66767;
      --good: #0ca30c; --good-text: #0ca30c; --warn: #ec835a; --loss: #d03b3b; --chip: #262624;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--ink-2); margin: 0 0 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile .v { font-size: 24px; font-weight: 650; }
  .tile .l { color: var(--ink-2); font-size: 12px; margin-top: 2px; }
  .tile .v.pos { color: var(--good-text); } .tile .v.neg { color: var(--loss); }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 14px; }
  .chip { background: var(--chip); border: 1px solid var(--border); color: var(--ink-2); border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: 13px; }
  .chip.on { background: var(--home); border-color: var(--home); color: #fff; }
  input[type=search] { background: var(--surface); color: var(--ink); border: 1px solid var(--grid); border-radius: 8px; padding: 6px 10px; font: inherit; min-width: 220px; }
  .legend { display: flex; gap: 16px; color: var(--ink-2); font-size: 12px; margin: 0 0 10px; align-items: center; flex-wrap: wrap; }
  .legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; border: 1px solid var(--border); }
  section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 6px 0 2px; margin-bottom: 22px; overflow: hidden; }
  section h2 { font-size: 14px; margin: 10px 16px; }
  section .note { color: var(--muted); font-size: 12px; margin: -6px 16px 10px; }
  .scroller { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 980px; }
  th, td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--grid); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; border-top: none; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td .teams { font-weight: 600; }
  td .meta, .dim { color: var(--ink-2); font-size: 12px; }
  a { color: var(--home); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .pick { font-weight: 650; }
  .badge { display: inline-block; border: 1px solid var(--good); color: var(--good-text); border-radius: 6px; padding: 1px 8px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .wbadge { display: inline-block; border: 1px solid var(--warn); color: var(--warn); border-radius: 6px; padding: 0 6px; font-size: 12px; margin-left: 4px; }
  .sbadge { display: inline-block; border: 1px solid var(--home); color: var(--home); border-radius: 6px; padding: 0 6px; font-size: 12px; margin-left: 4px; }
  #attr { min-width: 0; max-width: 640px; margin-bottom: 6px; }
  .res-won { color: var(--good-text); font-weight: 650; } .res-lost { color: var(--loss); font-weight: 650; } .res-void { color: var(--muted); }
  .drift { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .bar { display: inline-flex; width: 130px; height: 10px; border-radius: 4px; overflow: hidden; gap: 2px; vertical-align: 1px; }
  .bar i { display: block; height: 100%; }
  .bar .h { background: var(--home); border-radius: 4px 0 0 4px; }
  .bar .d { background: var(--draw); }
  .bar .a { background: var(--away); border-radius: 0 4px 4px 0; }
  .form { font-family: inherit; font-size: 12px; letter-spacing: 1px; color: var(--ink-2); }
  .sideDot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; border: 1px solid var(--border); }
  .sideDot.h { background: var(--home); } .sideDot.d { background: var(--draw); } .sideDot.a { background: var(--away); }
  .homeaway { color: var(--ink-2); font-size: 11px; font-weight: 400; margin-left: 5px; }
  .ringed { outline: 1.5px solid var(--good); border-radius: 6px; padding: 1px 5px; }
  .empty { padding: 18px 16px; color: var(--ink-2); }
  .staleWarn { border: 1px solid var(--warn); color: var(--warn); border-radius: 8px; padding: 8px 12px; margin: 0 0 16px; font-size: 13px; }
  #blocksWrap { margin: 0 0 22px; }
  .blocksH2 { font-size: 15px; margin: 8px 2px 2px; }
  .blocksNote { margin: 0 2px 10px !important; }
  .blocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .block { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .block.best { border-color: var(--good); }
  .block .hd { font-size: 11px; color: var(--muted); margin-bottom: 6px; font-variant-numeric: tabular-nums; }
  .block .pk { font-weight: 600; line-height: 1.5; }
  .block.none { opacity: 0.55; }
  .bestmark { color: var(--good-text); font-size: 11px; font-weight: 650; margin-left: 4px; white-space: nowrap; }
  .multiControls { margin: 0 16px 12px; }
  .multiFoot { margin: 12px 16px 10px !important; }
  .multis { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; padding: 0 16px 14px; }
  .multi { border: 1px solid var(--grid); border-radius: 10px; padding: 10px 12px; }
  .multi.top { border-color: var(--good); }
  .multi .mh { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
  .multi .mo { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .multi .ms { color: var(--ink-2); font-size: 12px; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
  .multi ol { margin: 0; padding: 0; list-style: none; counter-reset: leg; }
  .multi li { counter-increment: leg; border-top: 1px solid var(--grid); padding: 6px 0 6px 20px; position: relative; }
  .multi li::before { content: counter(leg); position: absolute; left: 0; top: 6px; color: var(--muted); font-size: 11px; }
  .multi li .lp { font-weight: 600; }
  .multi li .lo { float: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .chart { padding: 4px 16px 12px; }
  .chart svg { width: 100%; height: 150px; display: block; }
  footer { color: var(--muted); font-size: 12px; line-height: 1.6; }
  /* Mobile: the three main tables become stacked cards, no sideways scrolling */
  @media (max-width: 760px) {
    .wrap { padding: 14px 10px 40px; }
    table { min-width: 0; }
    .scroller { overflow-x: visible; }
    #flags, #all, #record { display: block; }
    #flags tr:first-child, #all tr:first-child, #record tr:first-child { display: none; }
    #flags tr, #all tr, #record tr { display: block; border: 1px solid var(--grid); border-radius: 10px; margin: 10px 0; padding: 8px 12px; }
    #flags td, #all td, #record td { display: inline-block; border: none; padding: 2px 12px 2px 0; white-space: normal; text-align: left; vertical-align: top; }
    #flags td:nth-child(-n+3), #record td:nth-child(-n+3), #all td:nth-child(-n+2), #all td:nth-child(6) { display: block; }
    td[data-l]::before { content: attr(data-l) ' '; color: var(--muted); font-size: 11px; }
    td.na { display: none !important; }
    section { padding: 4px 10px 2px; }
    .tile .v { font-size: 20px; }
    input[type=search] { min-width: 140px; flex: 1; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>BetFinder</h1>
  <p class="sub" id="sub"></p>
  <div class="tiles" id="tiles"></div>
  <div class="controls" id="controls"></div>
  <div class="legend">
    <span><span class="sw" style="background:var(--home)"></span>Home / player 1</span>
    <span><span class="sw" style="background:var(--draw)"></span>Draw</span>
    <span><span class="sw" style="background:var(--away)"></span>Away / player 2</span>
    <span class="dim">Form reads newest → oldest · ★ = quality-adjusted 0–100 (win margins + opponent rank)</span>
  </div>
  <div id="blocksWrap" hidden>
    <h2 class="blocksH2">Best pick per 3-hour window</h2>
    <p class="note blocksNote">The best available pick in each upcoming 3-hour block across the next 24 h. Green = a promoted flag;
      otherwise the top research candidate, preferring drift-crowd (the one signal with positive out-of-sample evidence). Respects the sport filter &amp; search.</p>
    <div class="blocks" id="blocks"></div>
  </div>
  <section id="multiSec" hidden>
    <h2 id="multiH2">Multibets</h2>
    <p class="note" id="multiNote"></p>
    <div class="controls multiControls" id="multiControls"></div>
    <div class="multis" id="multis"></div>
    <p class="note multiFoot" id="multiFoot"></p>
  </section>
  <section>
    <h2>Flagged picks — this scan</h2>
    <p class="note staleWarn" style="margin:0 16px 10px">⚠ <b>Unproven.</b> On a 9,381-game backtest (train + frozen test, at both opening and closing prices)
      the core vote-EV model returned <b>negative</b> ROI. The earlier positive result came from a 27-bet sample and did not survive the larger one.
      Treat these as research candidates, not value bets — see data/research/finding-2026-07-22-core-model.json.
      The drift-crowd signal is the only component with positive large-sample evidence, and it stays log-only until it earns promotion.</p>
    <div class="scroller"><table id="flags"></table></div>
    <div class="empty" id="flagsEmpty" hidden>No outcomes cleared the EV threshold this scan.</div>
  </section>
  <section>
    <h2>Research candidates — signals firing now</h2>
    <p class="note">Picks selected by the research signals, shown while they earn their live record. <b>Drift-crowd</b> is the only
      component with positive large-sample evidence (frozen test: +16.8% ROI over 110 bets); the others are unvalidated. None of these
      drive flags until the promotion gate clears them on live results.</p>
    <div class="scroller"><table id="cands"></table></div>
    <div class="empty" id="candsEmpty" hidden>No research signals firing in this window.</div>
  </section>
  <section>
    <h2>All scanned games</h2>
    <p class="note">Every game in the window with bet365-fed odds, nearest kickoff first.</p>
    <div class="scroller"><table id="all"></table></div>
    <div class="empty" id="allEmpty" hidden>No games with odds in the current window.</div>
  </section>
  <section>
    <h2>Track record — settled picks</h2>
    <p class="note">Flat 1-unit stake at the first flagged price. CLV = price taken vs closing price; consistently positive CLV means the signal beats the market.</p>
    <div class="chart" id="chart" hidden></div>
    <div class="scroller"><table id="attr" hidden></table></div>
    <div class="scroller"><table id="record"></table></div>
    <div class="empty" id="recordEmpty" hidden>No settled predictions yet — the record builds automatically as flagged games finish.</div>
  </section>
  <section>
    <h2>Model calibration</h2>
    <p class="note">All settled predictions (flagged or not), grouped by the model's estimated win probability. Well-calibrated = predicted ≈ actual.</p>
    <div class="scroller"><table id="calib"></table></div>
    <div class="empty" id="calibEmpty" hidden>Calibration appears after enough games settle. Vote weight in use: <span id="vw"></span>.</div>
  </section>
  <footer>
    Odds are bet365 prices via Sofascore's feed and can lag the live bet365 site by minutes.
    Crowd votes are debiased by fanbase size and shrunk toward the de-vigged market probability; recent form nudges the
    estimate; drift against the pick and confirmed absences reduce the edge. The vote weight is re-fitted from settled
    results as history accumulates. Screening tool, not betting advice.
  </footer>
</div>
<script>
const DATA = ${payload};
const fmtPct = (x) => (x * 100).toFixed(1) + '%';
const fmtOdds = (x) => x == null ? '—' : x.toFixed(2);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sportLabel = (s) => DATA.sportLabels[s] || s;
const kickoff = (ts) => new Date(ts * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const outcomeLabel = (g, name) => name === '1' ? g.home : name === '2' ? g.away : 'Draw';
const sideClass = (name) => name === '1' ? 'h' : name === '2' ? 'a' : 'd';
const sideTag = (name) => name === '1' ? 'home' : name === '2' ? 'away' : 'draw';
const pickLabel = (g, name) =>
  '<span class="sideDot ' + sideClass(name) + '"></span>' + esc(outcomeLabel(g, name))
  + '<span class="homeaway">(' + sideTag(name) + ')</span>';
const WARN_TEXT = { drift: '⚠ price drifting out', absences: '⚠ key absences', sharp: '⚠ Pinnacle sides with bet365' };
const shadowTxt = (s) => !s || !s.n
  ? 'collecting…'
  : s.n + ' settled, roi ' + (s.roi >= 0 ? '+' : '') + (s.roi * 100).toFixed(1) + '%'
    + (s.clv != null ? ', clv ' + (s.clv >= 0 ? '+' : '') + (s.clv * 100).toFixed(2) + 'pts' : '');
const SIGNAL_BADGE = { driftCrowd: '⚡ drift signal', consensus: '⚡ consensus signal', bigDrift: '⚡ big-drift signal', voteSurge: '⚡ vote-surge signal' };
const signalLine = (key, s) => {
  const p = DATA.promotions && DATA.promotions.signals && DATA.promotions.signals[key];
  return (p && p.status === 'promoted' ? '<b>PROMOTED</b> ' : 'shadow ') + shadowTxt(s);
};
// Evidence ranking: drift-crowd survived a frozen out-of-sample test; the
// others have not, so they only lead a window when nothing better fires.
const SIGNAL_RANK = { driftCrowd: 1, bigDrift: 2, consensus: 3, voteSurge: 4 };
const candRank = (o) => Math.min.apply(null, (o.candidateSignals || []).map(k => SIGNAL_RANK[k] || 9).concat([9]));
const ATTR_LABEL = { 'src:model': 'Core model', 'src:driftCrowd': 'Drift signal', 'src:consensus': 'Consensus signal', 'src:bigDrift': 'Big-drift signal', 'src:voteSurge': 'Vote-surge signal' };
const attrLabel = (key) => ATTR_LABEL[key] || (key.startsWith('sport:') ? sportLabel(key.slice(6)) : key);
const signalBadges = (o) => (o.signals || []).map(k => '<span class="sbadge">' + (SIGNAL_BADGE[k] || k) + '</span>').join('');

let sportFilter = null, query = '', scope = 'all';
// All time filtering is relative to when the page is VIEWED, not when it was
// generated — games that have kicked off since the last scan are hidden.
const NOW = () => Date.now() / 1000;
const hotCutoff = () => NOW() + (DATA.config.hotWindowHours || 3) * 3600;
const notStarted = (g) => g.startTimestamp > NOW() - 300;
function startsIn(ts) {
  const mins = Math.max(0, Math.round((ts - NOW()) / 60));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? 'in ' + h + 'h ' + (m ? m + 'm' : '') : 'in ' + m + 'm';
}

function driftCell(o) {
  if (o.openingOdds == null || o.openingOdds === o.odds) return '';
  const arrow = o.odds < o.openingOdds ? '▼' : '▲';
  return '<span class="drift" title="Opening price ' + fmtOdds(o.openingOdds) + '">' + arrow + ' from ' + fmtOdds(o.openingOdds) + '</span>';
}
function warnBadges(o) {
  return (o.warnings || []).map(w => '<span class="wbadge">' + (WARN_TEXT[w] || w) + '</span>').join('');
}
function formCell(g) {
  if (g.richForm && g.richForm.home && g.richForm.away) {
    const pct = (s) => Math.round(s.score * 100);
    const tip = (s) => (s.ranking ? '#' + s.ranking + ': ' : '')
      + s.detail.map(d => d.result + (d.oppRank ? ' v #' + d.oppRank : '') + ' (' + Math.round(d.quality * 100) + ')').join(', ');
    return '<span class="form" title="Quality-adjusted form 0–100 (margins + opponent strength), newest first. Home ' + esc(tip(g.richForm.home)) + ' — Away ' + esc(tip(g.richForm.away)) + '">★ '
      + pct(g.richForm.home) + ' v ' + pct(g.richForm.away) + '</span>';
  }
  if (!g.form) return '<span class="dim">—</span>';
  const f = (side) => (side.form || []).slice(0, 5).join('') || '—';
  return '<span class="form" title="Newest first">' + esc(f(g.form.home)) + ' v ' + esc(f(g.form.away)) + '</span>';
}
function voteBar(g) {
  if (!g.totalVotes) return '<span class="dim">no votes</span>';
  const get = (n) => { const o = g.outcomes.find(x => x.name === n); return o && o.voteShareRaw ? o.voteShareRaw : 0; };
  const seg = (cls, share, label) => share > 0.005
    ? '<i class="' + cls + '" style="width:' + (share * 100) + '%" title="' + esc(label) + ' ' + fmtPct(share) + '"></i>' : '';
  return '<span class="bar">' + seg('h', get('1'), outcomeLabel(g, '1')) + seg('d', get('X'), 'Draw') + seg('a', get('2'), outcomeLabel(g, '2')) + '</span>'
    + ' <span class="dim">' + g.totalVotes.toLocaleString() + ' votes</span>';
}
function filteredGames(applyScope) {
  return DATA.games.filter(g => {
    if (!notStarted(g)) return false;
    if (applyScope && scope === 'hot' && g.startTimestamp > hotCutoff()) return false;
    if (sportFilter && g.sport !== sportFilter) return false;
    if (query) {
      const hay = (g.home + ' ' + g.away + ' ' + g.tournament + ' ' + g.country).toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}
function visibleGames() { return filteredGames(true); }

// Best flagged pick in each upcoming 3-hour block across the full 24h window.
// Ignores the hot/all scope (the blocks ARE the time breakdown) but honours
// sport filter + search. Populates blockBestKeys so renderFlags can mark them.
let blockBestKeys = new Set();
function renderBlocks() {
  const games = filteredGames(false);
  const now = NOW();
  const blockH = DATA.config.hotWindowHours || 3;
  const blockSec = blockH * 3600;
  const spanSec = DATA.windowHours * 3600;
  const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  blockBestKeys = new Set();
  const cards = [];
  for (let i = 0; i * blockSec < spanSec; i++) {
    const bs = now + i * blockSec, be = bs + blockSec;
    const inBlock = games.filter(g => g.startTimestamp >= (i === 0 ? now - 300 : bs) && g.startTimestamp < be);
    if (!inBlock.length) continue;
    // Prefer a promoted flag; otherwise fall back to the best research
    // candidate, ranked by how much evidence backs its signal.
    let best = null;
    let kind = null;
    for (const g of inBlock) for (const o of g.outcomes) if (o.flagged && (!best || o.ev > best.o.ev)) best = { g, o };
    if (best) kind = 'flag';
    else {
      for (const g of inBlock) for (const o of g.outcomes) {
        if (!o.candidateSignals || !o.candidateSignals.length) continue;
        if (!best) { best = { g, o }; continue; }
        const r = candRank(o), rb = candRank(best.o);
        if (r < rb || (r === rb && o.ev > best.o.ev)) best = { g, o };
      }
      if (best) kind = 'candidate';
    }
    const label = (i === 0 ? 'Next ' + blockH + 'h' : (i * blockH) + '–' + ((i + 1) * blockH) + 'h from now') + ' · until ' + clock(be);
    if (best) {
      blockBestKeys.add(best.g.id + '|' + best.o.name);
      const tag = kind === 'flag'
        ? '<span class="badge">↑ +' + fmtPct(best.o.ev) + '</span>'
        : best.o.candidateSignals.map(k => '<span class="sbadge">' + (SIGNAL_BADGE[k] || k) + '</span>').join(' ');
      cards.push('<div class="block ' + (kind === 'flag' ? 'best' : '') + '"><div class="hd">' + label + '</div>'
        + '<div class="pk">' + pickLabel(best.g, best.o.name) + ' ' + tag + '</div>'
        + '<div class="meta">@ ' + fmtOdds(best.o.odds) + ' · ' + esc(sportLabel(best.g.sport)) + ' · ' + startsIn(best.g.startTimestamp) + '</div>'
        + '<div class="meta"><a href="' + esc(best.g.url) + '" target="_blank" rel="noopener">' + esc(best.g.home) + ' v ' + esc(best.g.away) + '</a></div></div>');
    } else {
      cards.push('<div class="block none"><div class="hd">' + label + '</div>'
        + '<div class="dim">nothing selected · ' + inBlock.length + ' game' + (inBlock.length > 1 ? 's' : '') + '</div></div>');
    }
  }
  document.getElementById('blocksWrap').hidden = cards.length === 0;
  document.getElementById('blocks').innerHTML = cards.join('');
}
// Multibets are built server-side (leg pool → pruned combination search); the page
// only re-sorts them and drops any whose legs have kicked off since the scan.
let multiWindow = 0, multiSort = 'prob';
function renderMultis() {
  const sec = document.getElementById('multiSec');
  if (!DATA.multis) { sec.hidden = true; return; }
  const win = DATA.multis.windows[multiWindow];
  const live = win.multis.filter(m => m.firstStart > NOW() - 300);
  live.sort((a, b) => multiSort === 'ev' ? b.ev - a.ev || b.prob - a.prob : b.prob - a.prob || b.ev - a.ev);
  sec.hidden = false;
  const s = DATA.multis.settings;
  document.getElementById('multiH2').textContent =
    'Multibets — ' + s.minLegs + '–' + s.maxLegs + ' legs, $' + s.minOdds + '–$' + s.maxOdds;
  document.getElementById('multiNote').innerHTML =
    'Best combinations of the model\\'s strongest picks across the next ' + win.hours + ' h. '
    + 'One leg per match, max ' + s.maxPerTournament + ' per competition, max ' + s.maxPerSport + ' per sport, and each leg\\'s probability is shrunk '
    + Math.round(s.shrinkToMarket * 100) + '% toward the market price before multiplying. '
    + '<b>Multi EV compounds model error</b> — six legs each 3 points optimistic is a multi ~20% overstated, so read the '
    + 'EV as a ranking, not a promise, and compare it with what the market implies. Re-check every leg on bet365.';
  document.getElementById('multiFoot').textContent = live.length
    ? win.poolSize + ' qualifying legs · ' + (win.candidates || 0).toLocaleString() + ' combinations searched'
    : '';
  const wrap = document.getElementById('multis');
  if (!live.length) {
    wrap.innerHTML = '<div class="dim">Every multi in this window has a leg that already kicked off — run a fresh scan.</div>';
    return;
  }
  wrap.innerHTML = live.map((m, i) =>
    '<div class="multi' + (i === 0 ? ' top' : '') + '">'
    + '<div class="mh"><span class="mo">$' + m.odds.toFixed(2) + '</span>'
    + '<span class="dim">' + m.legCount + ' legs</span>'
    + '<span class="badge">' + fmtPct(m.prob) + ' likely</span>'
    + (m.ev > 0 ? '<span class="badge">EV +' + fmtPct(m.ev) + '</span>' : '<span class="dim">EV ' + fmtPct(m.ev) + '</span>')
    + '</div>'
    + '<div class="ms">Fair price $' + m.fairOdds.toFixed(2) + ' · market says ' + fmtPct(m.marketProb)
    + ' · ' + m.flaggedLegs + '/' + m.legCount + ' legs flagged · last leg ' + startsIn(m.lastStart) + '</div>'
    + '<ol>' + m.legs.map(l =>
      '<li><span class="lo">' + fmtOdds(l.odds) + '</span>'
      + '<span class="lp"><span class="sideDot ' + sideClass(l.outcome) + '"></span>' + esc(l.pick) + '</span>'
      + ' <span class="dim">' + fmtPct(l.prob) + '</span>'
      + '<div class="meta"><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.home) + ' v ' + esc(l.away) + '</a>'
      + ' · ' + esc(sportLabel(l.sport)) + ' · ' + startsIn(l.startTimestamp) + '</div>'
      + (l.warnings.length ? '<div class="meta">' + warnBadges(l) + '</div>' : '')
      + '</li>').join('')
    + '</ol></div>'
  ).join('');
}
function matchCell(g) {
  return '<td><div class="teams"><a href="' + esc(g.url) + '" target="_blank" rel="noopener">' + esc(g.home) + ' v ' + esc(g.away) + '</a></div>'
    + '<div class="meta">' + esc(sportLabel(g.sport)) + ' · ' + esc(g.country) + ' · ' + esc(g.tournament) + '</div></td>';
}

function renderFlags() {
  const rows = [];
  for (const g of visibleGames()) for (const o of g.outcomes) if (o.flagged) rows.push({ g, o });
  rows.sort((x, y) => x.g.startTimestamp - y.g.startTimestamp || y.o.ev - x.o.ev);
  const table = document.getElementById('flags');
  document.getElementById('flagsEmpty').hidden = rows.length > 0;
  table.hidden = rows.length === 0;
  table.innerHTML = '<tr><th>Kickoff</th><th>Match</th><th>Pick</th><th class="num">bet365 odds</th>'
    + '<th class="num">Market %</th><th class="num">Crowd %</th><th>Form (H v A)</th><th class="num">Model %</th><th class="num">EV</th></tr>'
    + rows.map(({ g, o }) =>
      '<tr><td>' + kickoff(g.startTimestamp) + '<div class="dim">' + startsIn(g.startTimestamp) + '</div></td>' + matchCell(g)
      + '<td class="pick">' + pickLabel(g, o.name) + warnBadges(o) + signalBadges(o)
      + (blockBestKeys.has(g.id + '|' + o.name) ? ' <span class="bestmark" title="Best flagged pick in its 3-hour window">◆ best of window</span>' : '')
      + (o.pinnacle ? '<div class="meta">Pinnacle ' + fmtPct(o.pinnacle.prob) + ' @ ' + fmtOdds(o.pinnacle.odds) + '</div>' : '') + '</td>'
      + '<td class="num" data-l="bet365 odds"><span class="ringed">' + fmtOdds(o.odds) + '</span> ' + driftCell(o) + '</td>'
      + '<td class="num" data-l="Market %">' + fmtPct(o.marketProb) + '</td>'
      + '<td class="num" data-l="Crowd %" title="Raw ' + fmtPct(o.voteShareRaw) + ' of ' + g.totalVotes.toLocaleString() + ' votes, debiased by fanbase">' + fmtPct(o.voteShare) + '</td>'
      + '<td data-l="Form">' + formCell(g) + '</td>'
      + '<td class="num" data-l="Model %">' + fmtPct(o.estProb) + '</td>'
      + '<td class="num" data-l="EV"><span class="badge">↑ +' + fmtPct(o.ev) + '</span></td></tr>'
    ).join('');
}

function renderAll() {
  const games = visibleGames().sort((a, b) => a.startTimestamp - b.startTimestamp || b.bestEv - a.bestEv);
  const table = document.getElementById('all');
  document.getElementById('allEmpty').hidden = games.length > 0;
  table.hidden = games.length === 0;
  // The model's pick = the outcome it gives the highest win probability.
  const lean = (g) => g.outcomes.reduce((best, o) => (o.estProb > best.estProb ? o : best));
  const colLabel = { '1': 'Home (1)', X: 'Draw (X)', '2': 'Away (2)' };
  const oddsCell = (g, n) => {
    const o = g.outcomes.find(x => x.name === n);
    // Empty draw column collapses away on mobile via the .na class.
    if (!o) return '<td class="num na" data-l="' + colLabel[n] + '">—</td>';
    return '<td class="num" data-l="' + colLabel[n] + '">' + (o.flagged ? '<span class="ringed">' + fmtOdds(o.odds) + '</span>' : fmtOdds(o.odds)) + '</td>';
  };
  const leanCell = (g, leanOutcome) => {
    const flaggedPick = g.outcomes.find(o => o.flagged);
    return '<td class="pick">' + pickLabel(g, leanOutcome.name)
      + ' <span class="dim" title="Model win probability">' + fmtPct(leanOutcome.estProb) + '</span>'
      + (flaggedPick ? ' <span class="badge" title="Flagged value: ' + esc(outcomeLabel(g, flaggedPick.name)) + '">↑ +' + fmtPct(flaggedPick.ev) + '</span>' : '')
      + '</td>';
  };
  table.innerHTML = '<tr><th>Kickoff</th><th>Match</th><th class="num">1</th><th class="num">X</th><th class="num">2</th>'
    + '<th>Model pick</th><th>Crowd vote</th><th>Form</th></tr>'
    + games.map(g => {
      const l = lean(g);
      return '<tr><td>' + kickoff(g.startTimestamp) + '</td>' + matchCell(g)
        + oddsCell(g, '1') + oddsCell(g, 'X') + oddsCell(g, '2')
        + leanCell(g, l)
        + '<td data-l="Crowd vote">' + voteBar(g) + '</td><td data-l="Form">' + formCell(g) + '</td></tr>';
    }).join('');
}

function renderRecord() {
  const r = DATA.record;
  const empty = !r.picks.length;
  document.getElementById('recordEmpty').hidden = !empty;
  document.getElementById('record').hidden = empty;
  document.getElementById('chart').hidden = empty || r.picks.length < 2;
  if (empty) return;

  if (r.picks.length >= 2) {
    const pts = r.picks.map((p, i) => ({ x: i, y: p.cumulative }));
    const ys = pts.map(p => p.y).concat([0]);
    const yMin = Math.min(...ys), yMax = Math.max(...ys), span = (yMax - yMin) || 1;
    const W = 600, H = 140, PAD = 10;
    const px = (x) => PAD + x * (W - 2 * PAD) / Math.max(1, pts.length - 1);
    const py = (y) => H - PAD - (y - yMin) * (H - 2 * PAD) / span;
    const path = pts.map((p, i) => (i ? 'L' : 'M') + px(p.x).toFixed(1) + ' ' + py(p.y).toFixed(1)).join(' ');
    const zero = py(0);
    document.getElementById('chart').innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cumulative profit in units across settled picks">'
      + '<line x1="' + PAD + '" x2="' + (W - PAD) + '" y1="' + zero + '" y2="' + zero + '" stroke="var(--grid)" stroke-width="1"/>'
      + '<path d="' + path + '" fill="none" stroke="var(--home)" stroke-width="2" stroke-linejoin="round"/>'
      + pts.map((p, i) => '<circle cx="' + px(p.x).toFixed(1) + '" cy="' + py(p.y).toFixed(1) + '" r="6" fill="transparent"><title>Pick ' + (i + 1) + ': ' + (p.y >= 0 ? '+' : '') + p.y.toFixed(2) + 'u</title></circle>').join('')
      + '<text x="' + PAD + '" y="12" fill="var(--muted)" font-size="10">cumulative units (flat 1u stakes)</text>'
      + '</svg>';
  }

  const attr = document.getElementById('attr');
  attr.hidden = !DATA.attribution || !DATA.attribution.length;
  if (!attr.hidden) {
    const srcRows = DATA.attribution.filter((a) => a.key.startsWith('src:'));
    const sportRows = DATA.attribution.filter((a) => a.key.startsWith('sport:'));
    const row = (a) => '<tr><td>' + esc(attrLabel(a.key)) + '</td><td class="num">' + a.n + '</td>'
      + '<td class="num">' + fmtPct(a.hit) + '</td>'
      + '<td class="num">' + (a.units >= 0 ? '+' : '') + a.units.toFixed(2) + 'u</td>'
      + '<td class="num">' + (a.roi >= 0 ? '+' : '') + fmtPct(a.roi) + '</td>'
      + '<td class="num">' + (a.clv == null ? '—' : (a.clv >= 0 ? '+' : '') + (a.clv * 100).toFixed(2) + 'pts') + '</td></tr>';
    attr.innerHTML = '<tr><th>Where the results come from</th><th class="num">Settled</th><th class="num">Hit</th>'
      + '<th class="num">Units</th><th class="num">ROI</th><th class="num">Avg CLV</th></tr>'
      + srcRows.map(row).join('') + sportRows.map(row).join('');
  }

  const rows = [...r.picks].reverse().slice(0, 60);
  document.getElementById('record').innerHTML =
    '<tr><th>Kickoff</th><th>Match</th><th>Pick</th><th class="num">Taken</th><th class="num">Close</th>'
    + '<th class="num">CLV</th><th>Result</th><th class="num">P/L</th></tr>'
    + rows.map(p =>
      '<tr><td>' + kickoff(p.startTimestamp) + '</td>'
      + '<td><div class="teams"><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.home) + ' v ' + esc(p.away) + '</a></div>'
      + '<div class="meta">' + esc(sportLabel(p.sport)) + ' · ' + esc(p.tournament) + (p.finalScore ? ' · ' + esc(p.finalScore) : '') + '</div></td>'
      + '<td class="pick"><span class="sideDot ' + sideClass(p.outcome) + '"></span>' + esc(p.pickTeam)
      + '<span class="homeaway">(' + sideTag(p.outcome) + ')</span></td>'
      + '<td class="num" data-l="Taken">' + fmtOdds(p.odds) + '</td>'
      + '<td class="num" data-l="Close">' + fmtOdds(p.closingOdds) + '</td>'
      + '<td class="num" data-l="CLV">' + (p.clv == null ? '—' : (p.clv >= 0 ? '+' : '') + fmtPct(p.clv)) + '</td>'
      + '<td class="res-' + p.result + '" data-l="Result">' + p.result.toUpperCase() + '</td>'
      + '<td class="num" data-l="P/L">' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2) + 'u</td></tr>'
    ).join('');
}

function renderCalibration() {
  const table = document.getElementById('calib');
  const empty = !DATA.buckets.length;
  document.getElementById('calibEmpty').hidden = !empty;
  table.hidden = empty;
  const cal = DATA.calibration;
  const vw = cal && cal.global ? cal.global.voteWeight + ' (fitted from ' + cal.global.samples + ' results)' : DATA.config.voteWeight + ' (default)';
  if (empty) { document.getElementById('vw').textContent = vw; return; }
  table.innerHTML = '<tr><th>Model probability</th><th class="num">Predictions</th><th class="num">Predicted avg</th><th class="num">Actual win rate</th></tr>'
    + DATA.buckets.map(b =>
      '<tr><td>' + b.label + '</td><td class="num">' + b.n + '</td><td class="num">' + fmtPct(b.predicted) + '</td><td class="num">' + fmtPct(b.actual) + '</td></tr>'
    ).join('')
    + '<tr><td colspan="4" class="dim">Vote weight in use: ' + esc(vw) + '</td></tr>'
    + (DATA.calibration && DATA.calibration.sportGates && Object.keys(DATA.calibration.sportGates).length
      ? '<tr><td colspan="4" class="dim">Sport gates active (raised EV bar until the live record recovers): '
        + Object.entries(DATA.calibration.sportGates).map(([s, g]) =>
            esc(sportLabel(s)) + ' +' + (g.evBump * 100).toFixed(0) + '% (roi ' + (g.roi * 100).toFixed(0) + '%, n=' + g.n + ')').join(' · ')
        + '</td></tr>'
      : '')
    + '<tr><td colspan="4" class="dim">Research signals (auto-promote at 50+ settled with positive roi &amp; clv): '
    + Object.entries(DATA.shadows || {}).map(([k, s]) => esc(s.label) + ' — ' + signalLine(k, s)).join(' · ')
    + '</td></tr>';
}

function renderCandidates() {
  const rows = [];
  for (const g of visibleGames()) {
    for (const o of g.outcomes) {
      if (o.candidateSignals && o.candidateSignals.length) rows.push({ g, o });
    }
  }
  rows.sort((x, y) => x.g.startTimestamp - y.g.startTimestamp);
  const table = document.getElementById('cands');
  document.getElementById('candsEmpty').hidden = rows.length > 0;
  table.hidden = rows.length === 0;
  const rec = (k) => {
    const s = DATA.shadows && DATA.shadows[k];
    return s && s.n ? s.n + ' settled, roi ' + (s.roi >= 0 ? '+' : '') + (s.roi * 100).toFixed(0) + '%' : 'no record yet';
  };
  table.innerHTML = '<tr><th>Kickoff</th><th>Match</th><th>Pick</th><th class="num">odds</th><th>Signal</th><th>Signal live record</th></tr>'
    + rows.map(({ g, o }) =>
      '<tr><td>' + kickoff(g.startTimestamp) + '<div class="dim">' + startsIn(g.startTimestamp) + '</div></td>' + matchCell(g)
      + '<td class="pick">' + pickLabel(g, o.name) + '</td>'
      + '<td class="num" data-l="odds">' + fmtOdds(o.odds) + ' ' + driftCell(o) + '</td>'
      + '<td data-l="Signal">' + o.candidateSignals.map(k => '<span class="sbadge">' + (SIGNAL_BADGE[k] || k) + '</span>').join(' ') + '</td>'
      + '<td data-l="Record" class="dim">' + o.candidateSignals.map(rec).join(' · ') + '</td></tr>'
    ).join('');
}

function render() { renderBlocks(); renderFlags(); renderCandidates(); renderAll(); }

(function init() {
  const upcoming = DATA.games.filter(notStarted);
  const flaggedCount = upcoming.reduce((s, g) => s + g.outcomes.filter(o => o.flagged).length, 0);
  const hotFlagged = upcoming.filter(g => g.startTimestamp <= hotCutoff())
    .reduce((s, g) => s + g.outcomes.filter(o => o.flagged).length, 0);
  const started = DATA.games.length - upcoming.length;
  const ageHours = (Date.now() - Date.parse(DATA.generatedAt)) / 3.6e6;
  if (ageHours > 2.5) {
    const stale = document.createElement('div');
    stale.className = 'staleWarn';
    stale.textContent = '⚠ Last scan was ' + ageHours.toFixed(1) + ' h ago (laptop asleep?). '
      + (started ? started + ' game(s) that have since kicked off are hidden. ' : '')
      + 'A fresh scan starts automatically within minutes of the laptop waking.';
    document.getElementById('sub').after(stale);
  }
  const r = DATA.record;
  document.getElementById('sub').textContent =
    'Updated ' + new Date(DATA.generatedAt).toLocaleString() + ' · scanning ' + DATA.windowHours + ' h ahead · odds: bet365 via Sofascore · auto-refreshes every 2 h';
  const tiles = [
    [String(hotFlagged), 'flagged next ' + (DATA.config.hotWindowHours || 3) + ' h', ''],
    [String(flaggedCount), 'flagged in next ' + DATA.windowHours + ' h', ''],
    [String(upcoming.length), 'games in window', ''],
    [r.settled ? (r.units >= 0 ? '+' : '') + r.units + 'u' : '—', 'profit (' + r.settled + ' settled picks)', r.settled ? (r.units >= 0 ? 'pos' : 'neg') : ''],
    [r.hitRate != null ? fmtPct(r.hitRate) : '—', 'hit rate', ''],
    [r.avgClvPoints != null ? (r.avgClvPoints >= 0 ? '+' : '') + (r.avgClvPoints * 100).toFixed(2) + 'pts' : '—',
      'avg CLV' + (r.beatCloseRate != null ? ' · beat close ' + fmtPct(r.beatCloseRate) : ''),
      r.avgClvPoints != null ? (r.avgClvPoints >= 0 ? 'pos' : 'neg') : ''],
  ];
  document.getElementById('tiles').innerHTML = tiles.map(([v, l, cls]) =>
    '<div class="tile"><div class="v ' + cls + '">' + v + '</div><div class="l">' + l + '</div></div>').join('');

  const sports = [...new Set(DATA.games.map(g => g.sport))];
  const controls = document.getElementById('controls');
  controls.innerHTML = '<button class="chip on" data-scope="all">Today (' + DATA.windowHours + ' h)</button>'
    + '<button class="chip" data-scope="hot">Next ' + (DATA.config.hotWindowHours || 3) + ' h</button>'
    + '<span style="width:10px"></span>'
    + '<button class="chip on" data-sport="">All sports</button>'
    + sports.map(s => '<button class="chip" data-sport="' + esc(s) + '">' + esc(sportLabel(s)) + '</button>').join('')
    + '<input type="search" id="q" placeholder="Search team or league…">';
  controls.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const group = chip.dataset.scope !== undefined ? '[data-scope]' : '[data-sport]';
    controls.querySelectorAll('.chip' + group).forEach(c => c.classList.remove('on'));
    chip.classList.add('on');
    if (chip.dataset.scope !== undefined) scope = chip.dataset.scope;
    else sportFilter = chip.dataset.sport || null;
    render();
  });
  document.getElementById('q').addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });
  if (DATA.multis) {
    const mc = document.getElementById('multiControls');
    mc.innerHTML = DATA.multis.windows.map((w, i) =>
      '<button class="chip' + (i === 0 ? ' on' : '') + '" data-mwin="' + i + '">Next ' + w.hours + ' h</button>').join('')
      + '<span style="width:10px"></span>'
      + '<button class="chip on" data-msort="prob">Likeliest</button>'
      + '<button class="chip" data-msort="ev">Best value</button>';
    mc.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const group = chip.dataset.mwin !== undefined ? '[data-mwin]' : '[data-msort]';
      mc.querySelectorAll('.chip' + group).forEach(c => c.classList.remove('on'));
      chip.classList.add('on');
      if (chip.dataset.mwin !== undefined) multiWindow = Number(chip.dataset.mwin);
      else multiSort = chip.dataset.msort;
      renderMultis();
    });
  }

  render();
  renderMultis();
  renderRecord();
  renderCalibration();
})();
</script>
</body>
</html>`;
}

module.exports = { buildReport, prepareReportData, SPORT_LABELS };
