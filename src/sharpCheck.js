// Optional cross-check of flagged picks against Pinnacle (the sharpest public
// bookmaker) via The Odds API. Runs only when ODDS_API_KEY is set. Display-only:
// annotates flagged outcomes with Pinnacle's de-vigged probability and warns
// when Pinnacle sides with bet365 against the crowd.
const { powerDeVig } = require('./analyzer');

const API = 'https://api.the-odds-api.com/v4';
const GROUP_BY_SPORT = {
  football: 'Soccer',
  basketball: 'Basketball',
  tennis: 'Tennis',
  baseball: 'Baseball',
  'ice-hockey': 'Ice Hockey',
  'american-football': 'American Football',
  'aussie-rules': 'Aussie Rules',
  rugby: 'Rugby League',
};

function normalize(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !['fc', 'cf', 'sc', 'ac', 'afc', 'cd', 'club', 'de'].includes(t));
}

function similarity(a, b) {
  const ta = new Set(normalize(a));
  const tb = new Set(normalize(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`odds api ${res.status}`);
  return res.json();
}

// games: analyzed games with flagged outcomes. Mutates flagged outcomes in place.
async function sharpCheck(games, apiKey, log = () => {}) {
  const flaggedGames = games.filter((g) => g.flags && g.flags.length && GROUP_BY_SPORT[g.sport]);
  if (!flaggedGames.length) return;
  let sports;
  try {
    sports = await getJson(`${API}/sports/?apiKey=${apiKey}`);
  } catch (e) {
    log(`  sharp check skipped: ${e.message}`);
    return;
  }
  const keyCache = new Map();
  for (const game of flaggedGames) {
    const group = GROUP_BY_SPORT[game.sport];
    const keys = sports.filter((s) => s.group === group && s.active && !s.has_outrights).map((s) => s.key);
    const from = new Date((game.startTimestamp - 900) * 1000).toISOString().replace(/\.\d+Z/, 'Z');
    const to = new Date((game.startTimestamp + 900) * 1000).toISOString().replace(/\.\d+Z/, 'Z');
    let matched = null;
    for (const key of keys) {
      const cacheKey = `${key}|${from}`;
      if (!keyCache.has(cacheKey)) {
        try {
          keyCache.set(
            cacheKey,
            await getJson(
              `${API}/sports/${key}/odds/?apiKey=${apiKey}&markets=h2h&bookmakers=pinnacle&oddsFormat=decimal&commenceTimeFrom=${from}&commenceTimeTo=${to}`
            )
          );
        } catch {
          keyCache.set(cacheKey, []);
        }
      }
      for (const event of keyCache.get(cacheKey)) {
        const direct = similarity(game.home, event.home_team) + similarity(game.away, event.away_team);
        const swapped = similarity(game.home, event.away_team) + similarity(game.away, event.home_team);
        if (Math.max(direct, swapped) >= 1.0) {
          matched = { event, swapped: swapped > direct };
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) continue;
    const bookmaker = matched.event.bookmakers.find((b) => b.key === 'pinnacle');
    const market = bookmaker && bookmaker.markets.find((m) => m.key === 'h2h');
    if (!market) continue;
    const priced = powerDeVig(market.outcomes.map((o) => ({ name: o.name, odds: o.price })));
    for (const pick of game.flags) {
      const teamName = pick.name === '1' ? game.home : pick.name === '2' ? game.away : 'Draw';
      const target =
        pick.name === 'X'
          ? priced.find((p) => /draw/i.test(p.name))
          : priced.reduce((best, p) => (similarity(teamName, p.name) > similarity(teamName, (best || {}).name || '') ? p : best), null);
      if (!target) continue;
      pick.pinnacle = { odds: target.odds, prob: target.marketProb };
      if (target.marketProb <= pick.marketProb + 0.01) pick.warnings.push('sharp');
    }
    log(`  sharp check: matched ${game.home} v ${game.away} on Pinnacle`);
  }
}

module.exports = { sharpCheck, similarity };
