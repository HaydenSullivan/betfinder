// Renders the scan + track record as a self-contained HTML dashboard.
const ledger = require('./ledger');

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
};

// Assemble everything the dashboard shows: current scan + settled record + calibration.
function prepareReportData({ generatedAt, windowHours, config, games, calibration, ledgerEntries }) {
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
  const record = {
    picks: recordPicks,
    settled: decided.length,
    wins,
    hitRate: decided.length ? wins / decided.length : null,
    roi: decided.length ? units / decided.length : null,
    units: Number(units.toFixed(2)),
    avgClv: clvValues.length ? clvValues.reduce((s, x) => s + x, 0) / clvValues.length : null,
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

  return {
    generatedAt,
    windowHours,
    config,
    games,
    record,
    buckets,
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
  table { border-collapse: collapse; width: 100%; min-width: 900px; }
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
  .res-won { color: var(--good-text); font-weight: 650; } .res-lost { color: var(--loss); font-weight: 650; } .res-void { color: var(--muted); }
  .drift { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .bar { display: inline-flex; width: 130px; height: 10px; border-radius: 4px; overflow: hidden; gap: 2px; vertical-align: 1px; }
  .bar i { display: block; height: 100%; }
  .bar .h { background: var(--home); border-radius: 4px 0 0 4px; }
  .bar .d { background: var(--draw); }
  .bar .a { background: var(--away); border-radius: 0 4px 4px 0; }
  .form { font-family: inherit; font-size: 12px; letter-spacing: 1px; color: var(--ink-2); }
  .empty { padding: 18px 16px; color: var(--ink-2); }
  .chart { padding: 4px 16px 12px; }
  .chart svg { width: 100%; height: 150px; display: block; }
  footer { color: var(--muted); font-size: 12px; line-height: 1.6; }
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
    <span class="dim">Form reads newest → oldest</span>
  </div>
  <section>
    <h2>Flagged value bets — this scan</h2>
    <p class="note">Debiased crowd conviction + form beats the bet365 price by the required edge. Verify the live price on bet365 before betting.</p>
    <div class="scroller"><table id="flags"></table></div>
    <div class="empty" id="flagsEmpty" hidden>No outcomes cleared the EV threshold this scan.</div>
  </section>
  <section>
    <h2>All scanned games</h2>
    <p class="note">Every game in the window with bet365-fed odds, sorted by best expected value.</p>
    <div class="scroller"><table id="all"></table></div>
    <div class="empty" id="allEmpty" hidden>No games with odds in the current window.</div>
  </section>
  <section>
    <h2>Track record — settled picks</h2>
    <p class="note">Flat 1-unit stake at the first flagged price. CLV = price taken vs closing price; consistently positive CLV means the signal beats the market.</p>
    <div class="chart" id="chart" hidden></div>
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
const WARN_TEXT = { drift: '⚠ price drifting out', absences: '⚠ key absences', sharp: '⚠ Pinnacle sides with bet365' };

let sportFilter = null, query = '';

function driftCell(o) {
  if (o.openingOdds == null || o.openingOdds === o.odds) return '';
  const arrow = o.odds < o.openingOdds ? '▼' : '▲';
  return '<span class="drift" title="Opening price ' + fmtOdds(o.openingOdds) + '">' + arrow + ' from ' + fmtOdds(o.openingOdds) + '</span>';
}
function warnBadges(o) {
  return (o.warnings || []).map(w => '<span class="wbadge">' + (WARN_TEXT[w] || w) + '</span>').join('');
}
function formCell(g) {
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
function visibleGames() {
  return DATA.games.filter(g => {
    if (sportFilter && g.sport !== sportFilter) return false;
    if (query) {
      const hay = (g.home + ' ' + g.away + ' ' + g.tournament + ' ' + g.country).toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}
function matchCell(g) {
  return '<td><div class="teams"><a href="' + esc(g.url) + '" target="_blank" rel="noopener">' + esc(g.home) + ' v ' + esc(g.away) + '</a></div>'
    + '<div class="meta">' + esc(sportLabel(g.sport)) + ' · ' + esc(g.country) + ' · ' + esc(g.tournament) + '</div></td>';
}

function renderFlags() {
  const rows = [];
  for (const g of visibleGames()) for (const o of g.outcomes) if (o.flagged) rows.push({ g, o });
  rows.sort((x, y) => y.o.ev - x.o.ev);
  const table = document.getElementById('flags');
  document.getElementById('flagsEmpty').hidden = rows.length > 0;
  table.hidden = rows.length === 0;
  table.innerHTML = '<tr><th>Kickoff</th><th>Match</th><th>Pick</th><th class="num">bet365 odds</th>'
    + '<th class="num">Market %</th><th class="num">Crowd %</th><th>Form (H v A)</th><th class="num">Model %</th><th class="num">EV</th></tr>'
    + rows.map(({ g, o }) =>
      '<tr><td>' + kickoff(g.startTimestamp) + '</td>' + matchCell(g)
      + '<td class="pick">' + esc(outcomeLabel(g, o.name)) + warnBadges(o)
      + (o.pinnacle ? '<div class="meta">Pinnacle ' + fmtPct(o.pinnacle.prob) + ' @ ' + fmtOdds(o.pinnacle.odds) + '</div>' : '') + '</td>'
      + '<td class="num">' + fmtOdds(o.odds) + ' ' + driftCell(o) + '</td>'
      + '<td class="num">' + fmtPct(o.marketProb) + '</td>'
      + '<td class="num" title="Raw ' + fmtPct(o.voteShareRaw) + ' of ' + g.totalVotes.toLocaleString() + ' votes, debiased by fanbase">' + fmtPct(o.voteShare) + '</td>'
      + '<td>' + formCell(g) + '</td>'
      + '<td class="num">' + fmtPct(o.estProb) + '</td>'
      + '<td class="num"><span class="badge">↑ +' + fmtPct(o.ev) + '</span></td></tr>'
    ).join('');
}

function renderAll() {
  const games = visibleGames();
  const table = document.getElementById('all');
  document.getElementById('allEmpty').hidden = games.length > 0;
  table.hidden = games.length === 0;
  const oddsCell = (g, n) => {
    const o = g.outcomes.find(x => x.name === n);
    return '<td class="num">' + (o ? fmtOdds(o.odds) : '—') + '</td>';
  };
  table.innerHTML = '<tr><th>Kickoff</th><th>Match</th><th class="num">1</th><th class="num">X</th><th class="num">2</th>'
    + '<th>Crowd vote</th><th>Form</th><th class="num">Best EV</th></tr>'
    + games.map(g =>
      '<tr><td>' + kickoff(g.startTimestamp) + '</td>' + matchCell(g)
      + oddsCell(g, '1') + oddsCell(g, 'X') + oddsCell(g, '2')
      + '<td>' + voteBar(g) + '</td><td>' + formCell(g) + '</td>'
      + '<td class="num">' + (g.bestEv > -1 ? (g.bestEv >= 0 ? '+' : '') + fmtPct(g.bestEv) : '<span class="dim">—</span>') + '</td></tr>'
    ).join('');
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

  const rows = [...r.picks].reverse().slice(0, 60);
  document.getElementById('record').innerHTML =
    '<tr><th>Kickoff</th><th>Match</th><th>Pick</th><th class="num">Taken</th><th class="num">Close</th>'
    + '<th class="num">CLV</th><th>Result</th><th class="num">P/L</th></tr>'
    + rows.map(p =>
      '<tr><td>' + kickoff(p.startTimestamp) + '</td>'
      + '<td><div class="teams"><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.home) + ' v ' + esc(p.away) + '</a></div>'
      + '<div class="meta">' + esc(sportLabel(p.sport)) + ' · ' + esc(p.tournament) + (p.finalScore ? ' · ' + esc(p.finalScore) : '') + '</div></td>'
      + '<td class="pick">' + esc(p.pickTeam) + '</td>'
      + '<td class="num">' + fmtOdds(p.odds) + '</td>'
      + '<td class="num">' + fmtOdds(p.closingOdds) + '</td>'
      + '<td class="num">' + (p.clv == null ? '—' : (p.clv >= 0 ? '+' : '') + fmtPct(p.clv)) + '</td>'
      + '<td class="res-' + p.result + '">' + p.result.toUpperCase() + '</td>'
      + '<td class="num">' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2) + 'u</td></tr>'
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
    + '<tr><td colspan="4" class="dim">Vote weight in use: ' + esc(vw) + '</td></tr>';
}

function render() { renderFlags(); renderAll(); }

(function init() {
  const flaggedCount = DATA.games.reduce((s, g) => s + g.outcomes.filter(o => o.flagged).length, 0);
  const r = DATA.record;
  document.getElementById('sub').textContent =
    'Updated ' + new Date(DATA.generatedAt).toLocaleString() + ' · window ' + DATA.windowHours + ' h · odds: bet365 via Sofascore · auto-refreshes every 2 h';
  const tiles = [
    [String(flaggedCount), 'flagged now', ''],
    [String(DATA.games.length), 'games in window', ''],
    [r.settled ? (r.units >= 0 ? '+' : '') + r.units + 'u' : '—', 'profit (' + r.settled + ' settled picks)', r.settled ? (r.units >= 0 ? 'pos' : 'neg') : ''],
    [r.hitRate != null ? fmtPct(r.hitRate) : '—', 'hit rate', ''],
    [r.avgClv != null ? (r.avgClv >= 0 ? '+' : '') + fmtPct(r.avgClv) : '—', 'avg closing line value', r.avgClv != null ? (r.avgClv >= 0 ? 'pos' : 'neg') : ''],
  ];
  document.getElementById('tiles').innerHTML = tiles.map(([v, l, cls]) =>
    '<div class="tile"><div class="v ' + cls + '">' + v + '</div><div class="l">' + l + '</div></div>').join('');

  const sports = [...new Set(DATA.games.map(g => g.sport))];
  const controls = document.getElementById('controls');
  controls.innerHTML = '<button class="chip on" data-sport="">All sports</button>'
    + sports.map(s => '<button class="chip" data-sport="' + esc(s) + '">' + esc(sportLabel(s)) + '</button>').join('')
    + '<input type="search" id="q" placeholder="Search team or league…">';
  controls.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    controls.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
    chip.classList.add('on');
    sportFilter = chip.dataset.sport || null;
    render();
  });
  document.getElementById('q').addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });
  render();
  renderRecord();
  renderCalibration();
})();
</script>
</body>
</html>`;
}

module.exports = { buildReport, prepareReportData, SPORT_LABELS };
