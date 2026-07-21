// Prediction ledger: one JSONL line per (scan, event, outcome), monthly files
// under data/. Settlement rewrites lines in place; nothing is ever discarded.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ledgerFile(date) {
  return path.join(DATA_DIR, `ledger-${monthKey(date)}.jsonl`);
}

function listLedgerFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^ledger-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => path.join(DATA_DIR, f));
}

function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeEntries(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function appendEntries(entries, now = new Date()) {
  if (!entries.length) return;
  const file = ledgerFile(now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// Load every entry across all monthly files (they stay small: ~500 lines/day).
function loadAllEntries() {
  return listLedgerFiles().flatMap((file) => readEntries(file));
}

const outcomeKey = (e) => `${e.eventId}|${e.outcome}`;

// Latest snapshot per (event, outcome) — the most informed prediction; used for calibration.
function lastSnapshots(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const prev = byKey.get(outcomeKey(e));
    if (!prev || e.scanAt > prev.scanAt) byKey.set(outcomeKey(e), e);
  }
  return [...byKey.values()];
}

// Earliest FLAGGED snapshot per (event, outcome) — the price you could actually
// have bet when the tool first flagged it; used for ROI and CLV.
function firstFlaggedSnapshots(entries) {
  const byKey = new Map();
  for (const e of entries) {
    if (!e.flagged) continue;
    const prev = byKey.get(outcomeKey(e));
    if (!prev || e.scanAt < prev.scanAt) byKey.set(outcomeKey(e), e);
  }
  return [...byKey.values()];
}

// Drop snapshots identical to the newest prior one for the same outcome — they
// carry no trajectory information and bloat the monthly files.
function dedupeAgainst(prior, entries) {
  const last = new Map();
  for (const e of prior) {
    const k = outcomeKey(e);
    const p = last.get(k);
    if (!p || e.scanAt > p.scanAt) last.set(k, e);
  }
  return entries.filter((e) => {
    const p = last.get(outcomeKey(e));
    if (!p || p.settled) return true;
    return !(p.odds === e.odds && p.totalVotes === e.totalVotes && p.flagged === e.flagged);
  });
}

module.exports = {
  DATA_DIR,
  dedupeAgainst,
  ledgerFile,
  listLedgerFiles,
  readEntries,
  writeEntries,
  appendEntries,
  loadAllEntries,
  lastSnapshots,
  firstFlaggedSnapshots,
};
