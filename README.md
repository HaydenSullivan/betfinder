# BetFinder

Scans every game starting in the next few hours, pulls the bet365-fed odds and the
"Who will win?" crowd votes from Sofascore, and flags outcomes where crowd conviction
beats the price — rendered as a local HTML dashboard.

## Why one data source?

Sofascore's odds widget is bet365's own feed (the widget is literally "Ad by bet365"
in AU), so games, odds, and votes all come from Sofascore's API. That removes the
fragile team-name matching between two sites. The trade-off: the feed can lag the
live bet365 site by a few minutes, so always verify the live price before betting.

Sofascore rejects plain HTTP clients (TLS fingerprinting), so requests run as
same-origin fetches inside a headless copy of your installed Chrome/Edge via
`puppeteer-core`. No login, no account, no API key.

## Usage

```
npm install
npm run scan                 # scan, write report.html, open it
node src/index.js --hours 6              # wider window
node src/index.js --sports football,tennis
node src/index.js --mock --no-open       # offline demo using test fixtures
```

## How the signal works

For each outcome of each game:

1. `marketProb` — implied probability from the bet365 odds, de-vigged
   (normalised so the overround is removed).
2. `voteShare` — that outcome's share of the Sofascore crowd vote.
3. Crowd votes over-favour popular teams, so the estimate shrinks toward the
   market: `estProb = w · voteShare + (1 − w) · marketProb`, where
   `w = voteWeight · votes / (votes + votePrior)` — few votes ⇒ trust the market.
4. `EV = estProb · odds − 1`. An outcome is flagged when EV ≥ `evThreshold`,
   the game has ≥ `minVotes` votes, odds ≤ `maxOdds`, and (by default) it isn't
   a draw — fans almost never vote for the draw, so draw EVs are unreliable.

## Config (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `windowHours` | 3 | How far ahead to scan |
| `sports` | 11 sports | Sofascore sport slugs to scan |
| `voteWeight` | 0.35 | Max weight of crowd votes vs market |
| `votePrior` | 1000 | Vote count at which crowd weight reaches half strength |
| `minVotes` | 300 | Minimum votes for a game to be flaggable |
| `evThreshold` | 0.05 | Minimum EV (+5%) to flag |
| `maxOdds` | 15 | Ignore long shots above this price |
| `flagDraws` | false | Allow draw outcomes to be flagged |
| `oddsProviderId` | 1 | Sofascore odds provider (1 = bet365 feed in AU) |
| `chromePath` | auto | Path to chrome.exe/msedge.exe if auto-detect fails |

Event details are cached per-day in `.cache/`, so repeat scans on the same day are
much faster and lighter on Sofascore.

## Notes

- This is a screening tool. Crowd votes are sentiment, not probability; treat
  flags as candidates to investigate, not instructions to bet.
- `npm test` runs the unit tests (odds parsing, de-vig, flagging rules).
