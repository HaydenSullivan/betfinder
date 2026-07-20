// Settles past predictions: fills in results, closing odds, and closing line value.
const ledger = require('./ledger');
const sofa = require('./sofascore');

const SETTLE_GRACE_SECONDS = 90 * 60; // don't ask about a game until 90 min after kickoff

function resultForOutcome(outcome, winnerCode) {
  const winning = winnerCode === 1 ? '1' : winnerCode === 2 ? '2' : winnerCode === 3 ? 'X' : null;
  if (!winning) return null;
  return outcome === winning ? 'won' : 'lost';
}

// Mutates matching entries across files; returns count of newly settled entries.
async function settle(client, log = () => {}) {
  const now = Date.now() / 1000;
  const files = ledger.listLedgerFiles().map((file) => ({ file, entries: ledger.readEntries(file) }));
  const due = new Map(); // eventId -> representative entry
  for (const { entries } of files) {
    for (const e of entries) {
      if (!e.settled && e.startTimestamp + SETTLE_GRACE_SECONDS < now) due.set(e.eventId, e);
    }
  }
  if (!due.size) return 0;
  log(`  settling: checking ${due.size} finished game(s)`);

  const ids = [...due.keys()];
  const detailPaths = ids.map((id) => `/api/v1/event/${id}`);
  const oddsPaths = ids.map((id) => `/api/v1/event/${id}/odds/1/all`);
  const { results: detailResults } = await client.getMany(detailPaths);
  const { results: oddsResults } = await client.getMany(oddsPaths);

  const outcomes = new Map(); // eventId -> { statusType, winnerCode, score, closing }
  for (const id of ids) {
    const detail = detailResults.get(`/api/v1/event/${id}`);
    const event = sofa.parseEvent(detail && detail.event);
    if (!event) continue;
    const closing = sofa.parseEventOdds(oddsResults.get(`/api/v1/event/${id}/odds/1/all`));
    outcomes.set(id, { event, closing });
  }

  let settledCount = 0;
  const settledAt = new Date().toISOString();
  for (const { file, entries } of files) {
    let changed = false;
    for (const e of entries) {
      if (e.settled || !outcomes.has(e.eventId)) continue;
      const { event, closing } = outcomes.get(e.eventId);
      const status = event.statusType;
      if (status === 'notstarted' || status === 'inprogress') continue; // check again next run
      let result;
      if (status === 'finished' && event.winnerCode) {
        result = resultForOutcome(e.outcome, event.winnerCode);
      } else {
        result = 'void'; // canceled / postponed / walkover without winner
      }
      if (!result) continue;
      e.settled = true;
      e.settledAt = settledAt;
      e.result = result;
      e.finalScore = event.homeScore !== null ? `${event.homeScore}-${event.awayScore}` : null;
      e.closingOdds = (closing && closing[e.outcome]) || null;
      e.clv = e.closingOdds ? e.odds / e.closingOdds - 1 : null;
      changed = true;
      settledCount++;
    }
    if (changed) ledger.writeEntries(file, entries);
  }
  if (settledCount) log(`  settled ${settledCount} prediction line(s)`);
  return settledCount;
}

module.exports = { settle, resultForOutcome, SETTLE_GRACE_SECONDS };
