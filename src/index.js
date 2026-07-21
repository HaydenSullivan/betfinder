// BetFinder pipeline: settle past predictions → recalibrate → scan upcoming
// games → log predictions → render the dashboard.
//
// Usage: node src/index.js [--hours N] [--sports football,tennis] [--out file]
//                          [--mock] [--no-open] [--ci]
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { BrowserClient } = require('./browserClient');
const sofa = require('./sofascore');
const { analyzeAll, powerDeVig } = require('./analyzer');
const { buildMultis } = require('./multi');
const { buildReport, prepareReportData } = require('./report');
const ledger = require('./ledger');
const { settle } = require('./settle');
const { calibrate } = require('./calibrate');
const { sharpCheck } = require('./sharpCheck');
const { TeamCache, fetchRichForm } = require('./richForm');

const ROOT = path.join(__dirname, '..');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

function parseArgs(argv) {
  const args = { open: true, mock: false, ci: false, out: path.join(ROOT, 'docs', 'index.html') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hours') args.hours = Number(argv[++i]);
    else if (a === '--sports') args.sports = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--mock') args.mock = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '--ci') { args.ci = true; args.open = false; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node src/index.js [--hours N] [--sports a,b] [--out file] [--mock] [--no-open] [--ci]');
      process.exit(0);
    }
  }
  return args;
}

const log = (msg) => process.stdout.write(msg + '\n');

function progressLine(label) {
  let lastShown = -1;
  return (done, total) => {
    const pct = Math.floor((done / total) * 10);
    if (pct > lastShown) {
      lastShown = pct;
      process.stdout.write(`\r  ${label}: ${done}/${total}`);
      if (done === total) process.stdout.write('\n');
    }
  };
}

async function collectGames(client, config, windowHours) {
  const now = Date.now() / 1000;
  const windowEnd = now + windowHours * 3600;
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000);
  const cache = new sofa.EventCache(path.join(ROOT, '.cache'), today);

  // 1) Bulk odds per sport (today + tomorrow, since the window can cross midnight).
  // A second bookmaker's prices feed the consensus-outlier research signal.
  const marketsByEvent = new Map();
  const consensusByEvent = new Map();
  for (const sport of config.sports) {
    for (const date of [today, tomorrow]) {
      try {
        const odds = await sofa.fetchBulkOdds(client, sport, date, config.oddsProviderId);
        for (const [eventId, rawMarket] of Object.entries(odds)) {
          const market = sofa.parseMarket(rawMarket);
          if (market) marketsByEvent.set(Number(eventId), market);
        }
      } catch (e) {
        log(`  warning: bulk odds failed for ${sport} ${sofa.dateKey(date)}: ${e.message}`);
      }
      if (config.consensusProviderId) {
        try {
          const odds = await sofa.fetchBulkOdds(client, sport, date, config.consensusProviderId);
          for (const [eventId, rawMarket] of Object.entries(odds)) {
            const market = sofa.parseMarket(rawMarket);
            if (market) consensusByEvent.set(Number(eventId), market);
          }
        } catch {}
      }
    }
  }
  log(`  events with odds: ${marketsByEvent.size} (2nd book: ${consensusByEvent.size})`);

  // 2) Event details (cached per day on disk) for kickoff times and teams.
  const allIds = [...marketsByEvent.keys()];
  // Entries cached by an older parser version lack the follower fields the
  // fanbase debiasing needs — treat them as uncached so they refetch once.
  const uncachedIds = allIds.filter((id) => {
    const cached = cache.get(id);
    return !cached || !('homeFollowers' in cached) || !('homeTeamId' in cached);
  });
  if (uncachedIds.length) {
    const paths = uncachedIds.map((id) => `/api/v1/event/${id}`);
    const { results, errors } = await client.getMany(paths, progressLine('event details'));
    for (const [, data] of results) {
      const event = sofa.parseEvent(data && data.event);
      if (event) cache.set(event.id, event);
    }
    if (errors.length) log(`  warning: ${errors.length} event detail requests failed`);
    cache.save();
  }

  // 3) Keep games that start inside the window and have not started.
  const inWindow = [];
  for (const id of allIds) {
    const event = cache.get(id);
    if (!event) continue;
    if (event.statusType !== 'notstarted') continue;
    if (event.startTimestamp < now - 300 || event.startTimestamp > windowEnd) continue;
    inWindow.push({ ...event, url: sofa.matchUrl(event), market: marketsByEvent.get(id), b5: consensusByEvent.get(id) || null });
  }
  log(`  games in the next ${windowHours} h: ${inWindow.length}`);

  // 4) Votes, recent form, and lineups for the games that made the cut.
  if (inWindow.length) {
    const paths = inWindow.flatMap((g) => [
      `/api/v1/event/${g.id}/votes`,
      `/api/v1/event/${g.id}/pregame-form`,
      `/api/v1/event/${g.id}/lineups`,
    ]);
    const { results } = await client.getMany(paths, progressLine('votes, form, lineups'));
    for (const game of inWindow) {
      const votesData = results.get(`/api/v1/event/${game.id}/votes`);
      game.votes = sofa.parseVotes(votesData && votesData.vote);
      game.form = sofa.parsePregameForm(results.get(`/api/v1/event/${game.id}/pregame-form`));
      game.lineups = sofa.parseLineups(results.get(`/api/v1/event/${game.id}/lineups`));
    }
  }
  return inWindow;
}

// Log-only research fields for the shadow-signal program: stored on every
// entry so settled results score each signal live before any promotion.
function researchFields(game, o) {
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
  return {
    drift,
    b5Odds,
    consensusEv,
    crowdMajority,
    // H2 (validated out-of-sample): crowd-majority side whose price drifted out >=5%
    shadowDriftCrowd: Boolean(crowdMajority && drift !== null && drift >= 0.05 && game.totalVotes >= 100),
  };
}

function toLedgerEntries(analyzed, scanAt) {
  const entries = [];
  for (const game of analyzed) {
    for (const o of game.outcomes) {
      if (o.voteShare === null) continue;
      entries.push({
        scanAt,
        eventId: game.id,
        sport: game.sport,
        home: game.home,
        away: game.away,
        tournament: game.tournament,
        country: game.country,
        startTimestamp: game.startTimestamp,
        outcome: o.name,
        pickTeam: o.name === '1' ? game.home : o.name === '2' ? game.away : 'Draw',
        odds: o.odds,
        openingOdds: o.openingOdds,
        marketProb: Number(o.marketProb.toFixed(4)),
        voteShareRaw: Number(o.voteShareRaw.toFixed(4)),
        voteShare: Number(o.voteShare.toFixed(4)),
        totalVotes: game.totalVotes,
        formEdge: o.formEdge === null ? null : Number(o.formEdge.toFixed(3)),
        estProb: Number(o.estProb.toFixed(4)),
        ev: Number(o.ev.toFixed(4)),
        formSource: game.formSource || null,
        penalty: o.penalty,
        warnings: o.warnings,
        flagged: o.flagged,
        ...researchFields(game, o),
        url: game.url,
        settled: false,
      });
    }
  }
  return entries;
}

async function main() {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const windowHours = args.hours || config.windowHours;
  if (args.sports) config.sports = args.sports;
  const scanAt = new Date().toISOString();

  let analyzed;
  let calibration = null;
  let priorEntries = [];
  if (args.mock) {
    const games = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'games.json'), 'utf8'));
    log(`mock mode: ${games.length} fixture games`);
    analyzed = analyzeAll(games, config, calibration);
  } else {
    const client = new BrowserClient({
      chromePath: config.chromePath || undefined,
      concurrency: config.concurrency,
      requestDelayMs: config.requestDelayMs,
    });
    log('launching browser…');
    const { executablePath, base } = await client.start();
    log(`  using ${executablePath} via ${base}`);
    try {
      await settle(client, log);
      priorEntries = ledger.loadAllEntries();
      calibration = calibrate(priorEntries, config, log);
      const games = await collectGames(client, config, windowHours);
      analyzed = analyzeAll(games, config, calibration);

      // Second pass: quality-adjusted form (margins + opponent strength) for
      // games near or over the flag threshold, then re-analyze those.
      if (config.deepForm) {
        const floor = config.evThreshold - config.deepFormMargin;
        const candidates = analyzed.filter((g) =>
          g.outcomes.some((o) => o.voteShare !== null && o.ev >= floor)
        );
        if (candidates.length) {
          const teamCache = new TeamCache(path.join(ROOT, '.cache'));
          let enriched = 0;
          for (const game of candidates) {
            if (await fetchRichForm(client, teamCache, game, config.deepFormMatches)) enriched++;
          }
          teamCache.save();
          log(`  quality form: ${enriched}/${candidates.length} candidate game(s)`);
          if (enriched) analyzed = analyzeAll(analyzed, config, calibration);
        }
      }
    } finally {
      await client.close();
    }
  }

  const flagCount = analyzed.reduce((s, g) => s + g.flags.length, 0);

  if (!args.mock && process.env.ODDS_API_KEY && flagCount) {
    await sharpCheck(analyzed, process.env.ODDS_API_KEY, log);
  }
  if (!args.mock) {
    const fresh = toLedgerEntries(analyzed, scanAt);
    const deduped = ledger.dedupeAgainst(priorEntries, fresh);
    ledger.appendEntries(deduped);
    log(`  ledger: ${deduped.length}/${fresh.length} snapshot(s) carried new information`);
  }

  const multis = buildMultis(analyzed, config);

  const reportData = prepareReportData({
    generatedAt: scanAt,
    windowHours,
    multis,
    config: {
      minVotes: config.minVotes,
      evThreshold: config.evThreshold,
      voteWeight: config.voteWeight,
      hotWindowHours: config.hotWindowHours,
    },
    games: analyzed.map(({ flags, market, votes, lineups, ...g }) => g),
    calibration,
    ledgerEntries: args.mock ? [] : ledger.loadAllEntries(),
  });
  const html = buildReport(reportData);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, html);

  log(`\n${flagCount} flagged value bet(s) across ${analyzed.length} game(s)`);
  log(`report: ${args.out}`);
  for (const game of analyzed) {
    for (const o of game.flags) {
      const pick = o.name === '1' ? game.home : o.name === '2' ? game.away : 'Draw';
      const warn = o.warnings.length ? `  [${o.warnings.join(', ')}]` : '';
      log(`  +${(o.ev * 100).toFixed(1)}%  ${pick} @ ${o.odds.toFixed(2)}  (${game.home} v ${game.away}, ${game.tournament})${warn}`);
    }
  }

  if (multis) {
    for (const w of multis.windows) {
      const best = w.multis[0];
      log(`\nbest ${w.hours} h multi — ${best.legCount} legs @ ${best.odds.toFixed(2)}  (${(best.prob * 100).toFixed(1)}% likely, EV ${best.ev >= 0 ? '+' : ''}${(best.ev * 100).toFixed(0)}%)`);
      for (const leg of best.legs) {
        log(`  ${leg.pick} @ ${leg.odds.toFixed(2)}  (${leg.home} v ${leg.away})`);
      }
    }
  }

  if (args.open) {
    execFile('cmd', ['/c', 'start', '', args.out], { windowsHide: true });
  }
}

main().catch((e) => {
  console.error('scan failed:', e.message);
  process.exit(1);
});
