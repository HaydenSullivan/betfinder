// Sofascore API access + response parsing.
const fs = require('fs');
const path = require('path');

// "11/25" -> 1.44 (decimal odds). Returns null for unparseable input.
function fractionalToDecimal(fraction) {
  if (typeof fraction !== 'string') return null;
  const match = fraction.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const denominator = Number(match[2]);
  if (denominator === 0) return null;
  return 1 + Number(match[1]) / denominator;
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Bulk 1X2/moneyline odds for every odds-bearing event of a sport on a date.
// Returns { [eventId]: market } where market.choices have name (1/X/2) and fractional values.
async function fetchBulkOdds(client, sport, date, providerId) {
  const data = await client.getJson(`/api/v1/sport/${sport}/odds/${providerId}/${dateKey(date)}`);
  return (data && data.odds) || {};
}

async function fetchEventDetails(client, eventId) {
  const data = await client.getJson(`/api/v1/event/${eventId}`);
  return data && data.event ? data.event : null;
}

async function fetchVotes(client, eventId) {
  const data = await client.getJson(`/api/v1/event/${eventId}/votes`);
  return data && data.vote ? data.vote : null;
}

// Last-5 form, league position and points for both sides. Only served pre-kickoff.
// form arrays are NEWEST-FIRST (index 0 = most recent result).
function parsePregameForm(data) {
  if (!data || !data.homeTeam || !data.awayTeam) return null;
  const side = (t) => ({
    form: Array.isArray(t.form) ? t.form : [],
    position: t.position ?? null,
    value: t.value ?? null,
  });
  return { home: side(data.homeTeam), away: side(data.awayTeam) };
}

function parseLineups(data) {
  if (!data) return null;
  return {
    confirmed: Boolean(data.confirmed),
    homeMissing: ((data.home && data.home.missingPlayers) || []).length,
    awayMissing: ((data.away && data.away.missingPlayers) || []).length,
  };
}

// Closing (or current) full-time odds for one event: { '1': 1.44, 'X': 4.33, '2': 6.5 }
function parseEventOdds(data) {
  const market = ((data && data.markets) || []).find((m) => m.marketName === 'Full time');
  if (!market || !Array.isArray(market.choices)) return null;
  const odds = {};
  for (const choice of market.choices) {
    const decimal = fractionalToDecimal(choice.fractionalValue);
    if (decimal !== null) odds[choice.name] = decimal;
  }
  return Object.keys(odds).length >= 2 ? odds : null;
}

function parseMarket(market) {
  if (!market || market.suspended || !Array.isArray(market.choices)) return null;
  const outcomes = [];
  for (const choice of market.choices) {
    const decimal = fractionalToDecimal(choice.fractionalValue);
    if (decimal === null) return null;
    outcomes.push({
      name: choice.name, // "1" | "X" | "2"
      odds: decimal,
      openingOdds: fractionalToDecimal(choice.initialFractionalValue),
      change: choice.change || 0,
    });
  }
  if (outcomes.length < 2) return null;
  return { marketName: market.marketName, outcomes };
}

function parseEvent(event) {
  if (!event) return null;
  const sport =
    event.tournament &&
    event.tournament.category &&
    event.tournament.category.sport &&
    event.tournament.category.sport.slug;
  return {
    id: event.id,
    slug: event.slug,
    customId: event.customId,
    home: event.homeTeam && event.homeTeam.name,
    away: event.awayTeam && event.awayTeam.name,
    homeTeamId: (event.homeTeam && event.homeTeam.id) || null,
    awayTeamId: (event.awayTeam && event.awayTeam.id) || null,
    homeFollowers: (event.homeTeam && event.homeTeam.userCount) || null,
    awayFollowers: (event.awayTeam && event.awayTeam.userCount) || null,
    startTimestamp: event.startTimestamp,
    statusType: event.status && event.status.type,
    // present once finished: 1 = home won, 2 = away won, 3 = draw
    winnerCode: event.winnerCode ?? null,
    homeScore: event.homeScore && event.homeScore.current !== undefined ? event.homeScore.current : null,
    awayScore: event.awayScore && event.awayScore.current !== undefined ? event.awayScore.current : null,
    tournament: event.tournament && event.tournament.name,
    country: event.tournament && event.tournament.category && event.tournament.category.name,
    sport,
  };
}

// vote payload: { vote1, voteX, vote2 } (voteX null/absent for two-way sports)
function parseVotes(vote) {
  if (!vote) return null;
  const counts = {
    '1': Number(vote.vote1) || 0,
    X: Number(vote.voteX) || 0,
    '2': Number(vote.vote2) || 0,
  };
  const total = counts['1'] + counts.X + counts['2'];
  if (total === 0) return null;
  return { counts, total };
}

function matchUrl(event) {
  return `https://www.sofascore.com/${event.sport}/match/${event.slug}/${event.customId}#id:${event.id}`;
}

// Simple per-day disk cache for immutable event details.
class EventCache {
  constructor(dir, date) {
    this.file = path.join(dir, `events-${dateKey(date)}.json`);
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(eventId) {
    return this.data[eventId] || null;
  }

  set(eventId, event) {
    this.data[eventId] = event;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}

module.exports = {
  fractionalToDecimal,
  dateKey,
  fetchBulkOdds,
  fetchEventDetails,
  fetchVotes,
  parseMarket,
  parseEvent,
  parseVotes,
  parsePregameForm,
  parseLineups,
  parseEventOdds,
  matchUrl,
  EventCache,
};
