// Quality-adjusted ("rich") form: recent results weighted by margin of victory
// and, where rankings exist (tennis), by opponent strength. A 6-3 6-1 win over
// the #45 counts far more than a third-set tiebreak over the #236.
const fs = require('fs');
const path = require('path');

// Typical decisive margin per sport, used to normalise score margins to [-1, 1].
const MARGIN_SCALE = {
  football: 3,
  tennis: 6, // games
  basketball: 15,
  baseball: 5,
  'ice-hockey': 4,
  'american-football': 21,
  handball: 8,
  volleyball: 2, // sets
  'aussie-rules': 40,
  rugby: 21,
  darts: 4, // legs/sets
  'table-tennis': 2, // sets
  cricket: 50, // runs — mutes margin, result dominates
};

// 7-day disk cache for team lookups (rankings move slowly).
class TeamCache {
  constructor(dir) {
    this.file = path.join(dir, 'teams.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }
  get(teamId) {
    const hit = this.data[teamId];
    if (!hit || Date.now() - hit.at > 7 * 24 * 3600 * 1000) return null;
    return hit;
  }
  set(teamId, info) {
    this.data[teamId] = { ...info, at: Date.now() };
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}

async function teamInfo(client, teamCache, teamId) {
  const cached = teamCache.get(teamId);
  if (cached) return cached;
  let info = { ranking: null };
  try {
    const data = await client.getJson(`/api/v1/team/${teamId}`);
    if (data && data.team) info = { ranking: data.team.ranking ?? null };
  } catch {}
  teamCache.set(teamId, info);
  return info;
}

// Margin from the subject's perspective. Tennis prefers total games across sets.
function matchMargin(match, isHome, sport) {
  const mine = isHome ? match.homeScore || {} : match.awayScore || {};
  const theirs = isHome ? match.awayScore || {} : match.homeScore || {};
  let forPts = mine.current;
  let againstPts = theirs.current;
  if (sport === 'tennis') {
    let games = 0;
    let oppGames = 0;
    let found = false;
    for (const p of ['period1', 'period2', 'period3', 'period4', 'period5']) {
      if (mine[p] !== undefined && theirs[p] !== undefined) {
        games += mine[p];
        oppGames += theirs[p];
        found = true;
      }
    }
    if (found) {
      forPts = games;
      againstPts = oppGames;
    }
  }
  if (typeof forPts !== 'number' || typeof againstPts !== 'number') return null;
  const scale = MARGIN_SCALE[sport] || 5;
  return Math.max(-1, Math.min(1, (forPts - againstPts) / scale));
}

// Quality of one result in [0,1]: result dominates, margin refines.
// A win never scores below 0.6, a loss never above 0.4, a draw is 0.5.
function matchQuality(won, drawn, marginNorm) {
  if (drawn) return 0.5;
  if (marginNorm === null) return won ? 0.75 : 0.25;
  return won
    ? 0.5 + 0.5 * Math.max(0.2, marginNorm)
    : 0.5 + 0.5 * Math.min(-0.2, marginNorm);
}

// Opponent-strength weight (rankings only, i.e. tennis): beating better-ranked
// opponents counts more. Lower ranking number = better player.
function strengthWeight(subjectRank, oppRank) {
  if (!subjectRank || !oppRank) return 1;
  return Math.max(0.6, Math.min(1.8, Math.sqrt(subjectRank / oppRank)));
}

// Rich form score in [0,1] for one team, from its recent finished matches.
async function teamRichForm(client, teamCache, teamId, sport, maxMatches) {
  let events;
  try {
    const data = await client.getJson(`/api/v1/team/${teamId}/events/last/0`);
    events = (data && data.events) || [];
  } catch {
    return null;
  }
  const finished = events.filter((e) => e.status && e.status.type === 'finished' && e.winnerCode);
  const recent = finished.slice(-maxMatches).reverse(); // newest first
  if (recent.length < 3) return null;

  const subject = await teamInfo(client, teamCache, teamId);
  let weighted = 0;
  let weightSum = 0;
  const detail = [];
  for (let i = 0; i < recent.length; i++) {
    const match = recent[i];
    const isHome = match.homeTeam.id === teamId;
    const opp = isHome ? match.awayTeam : match.homeTeam;
    const drawn = match.winnerCode === 3;
    const won = !drawn && match.winnerCode === (isHome ? 1 : 2);
    const marginNorm = matchMargin(match, isHome, sport);
    const oppRank = sport === 'tennis' ? (await teamInfo(client, teamCache, opp.id)).ranking : null;
    const quality = matchQuality(won, drawn, marginNorm);
    const weight = (recent.length - i) * strengthWeight(subject.ranking, oppRank);
    weighted += quality * weight;
    weightSum += weight;
    detail.push({ opp: opp.name, oppRank, result: drawn ? 'D' : won ? 'W' : 'L', quality: +quality.toFixed(2) });
  }
  return { score: +(weighted / weightSum).toFixed(3), ranking: subject.ranking, detail };
}

// Attach rich form to a game (mutates). Returns true when both sides resolved.
async function fetchRichForm(client, teamCache, game, maxMatches) {
  if (!game.homeTeamId || !game.awayTeamId) return false;
  const home = await teamRichForm(client, teamCache, game.homeTeamId, game.sport, maxMatches);
  const away = await teamRichForm(client, teamCache, game.awayTeamId, game.sport, maxMatches);
  if (!home || !away) return false;
  game.richForm = { home, away };
  return true;
}

module.exports = { TeamCache, fetchRichForm, teamRichForm, matchMargin, matchQuality, strengthWeight, MARGIN_SCALE };
