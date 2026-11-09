# Courtside Edge

Live NBA slate as animated, arena-styled courts (Windows Vista Aero look, 2K-style badges), with live
scores, a win-probability gel bar, and a **Pick Finder** per game that ranks Kalshi markets (player
props, moneylines, spreads, totals, quarter/half markets) by edge after fees.

## Deploy so it works on your phone (2 minutes)

The page needs a same-origin proxy for ESPN, the NBA live CDN and Kalshi (browsers block direct
cross-site requests). `vercel.json` and `netlify.toml` already set that up.

**Vercel (recommended):** push this folder to a GitHub repo → vercel.com/new → Import the repo →
Deploy. No settings needed (build: `node tools/build.js`, output: `dist`). Open the `*.vercel.app`
URL on your phone and use Share → Add to Home Screen for a full-screen app.

**Netlify:** app.netlify.com → Add new site → Import from Git → pick the repo → Deploy.

**Hosted without a proxy (githack, GitHub Pages…):** Kalshi blocks direct browser requests, so a
GitHub Actions job (`.github/workflows/kalshi-snapshot.yml`) fetches every open NBA game market about
once a minute and force-pushes a compact `kalshi.json` to the `data` branch. The app reads it from
raw.githubusercontent.com (CORS-enabled) and labels those prices as delayed.

**Anywhere else (GitHub Pages, S3…):** deploy `proxy/worker.js` as a Cloudflare Worker, then paste
`https://<worker>.workers.dev/?url=` into the app's Settings.

`#demo` on the URL runs the built-in simulator (real teams, fictional players, simulated prices).

## Install on iPhone

Open `https://raw.githack.com/montroseweb/courtside-edge/main/dist/index.html` in Safari →
Share → Add to Home Screen. The app runs full-screen, launches from cache, and picks up new
versions automatically (network-first service worker).

## My Bets and the parlay builder

- Tap the green **+** on any Main Pick or Optimal Parlay, type the price you paid (cents), then
  **Add to my bets** (tracked on its own) or **Create parlay** (adds the leg to the builder).
- **My Bets** (first chip in the date bar) shows Paid price, Live Kalshi ask, Change and Hold
  confidence for every position, refreshed every second. Parlays show the ticket on top and every
  leg below; legs turn green the moment they are mathematically won (an over that cleared, a
  quarter or half that ended, a final).
- **SELL NOW** appears only when (a) a position is all but dead (≤ 6%) and a buyer still pays more
  than it is worth, or (b) the bid, after the fee, beats the real chance by ≥ 6¢ — locking a gain,
  or cutting a collapsing position (≤ 25%) before the price catches up. The card flashes red and
  the My Bets chip pulses from any screen.
- The bottom pill shows legs and the real joint probability; the builder shows the combined
  Kalshi ask (product of live leg asks — Kalshi's combo quote can differ), real probability,
  mathematical edge, the break-even price, and a strength analysis: conflicts, overlaps,
  same-player stacking, the leg whose removal or swap helps most, and adds that raise the ticket's
  long-run growth. Bets are stored in this browser only.

## Matchup scouting (opened game)

From each team's last 4 completed games (ESPN summaries): possessions by venue, fast-break and
paint points, defense vs position (G/F/C), FG% allowed by shot zone (rim, paint, mid, corner 3,
above-break 3), eFG% allowed by shot type (catch-and-shoot, off-dribble, drives, cuts/putbacks,
post-ups) weighted by each player's own scouted shot mix, and the estimated primary defender's
steal/block rates. Every factor is relative to the opponent's own average and shrunk by sample
size. ESPN team news (48h) feeds minute limits and starting-role changes; "ruled out" headlines
bench props until the official report agrees.

## Backtest

`#demo-debug-nofx-seedN` plus Playwright's clock fast-forwards whole simulated games; picks are
settled against final box scores to measure hit rate, calibration and ROI by gate and policy.

## Data sources

| Feed | Used for | Poll rate |
|---|---|---|
| NBA liveData CDN (`cdn.nba.com`) | scores, clock, box score, play-by-play shot chart | 1s scoreboard, 2s box, 3s pbp (focused game) |
| ESPN site API | slate, records, odds (sportsbook line), BPI, injuries, last 5, season series, rosters, 2 seasons of game logs, standings | 1s scoreboard when live |
| Kalshi trade API v2 (public) | every open NBA market: discovered from `/series`, matched to games by event ticker | 1.2s focused game, 2s lines, ~9s props when live |

The fastest score source wins: each update is compared on (state, period, clock, points), so the app
shows whichever feed is ahead. Nothing can be faster than the feeds themselves.

## Models

- **Pregame lines:** weighted consensus of sportsbook spread/total/no-vig moneyline (via ESPN),
  ESPN BPI, and Kalshi's own spread/total ladders (fitted to an implied mean).
- **Live lines:** score/clock random walk (σ≈12 pts per 48 min for margin, 18.5 for totals),
  anchored to the pregame consensus and re-calibrated to the market only during quiet stretches
  (no scoring in 20s). A quote that hasn't moved since the last basket while fair value moved ≥2.5¢
  is flagged **LAG**.
- **Quarters/halves:** the same model over the segment window, using linescores.
- **Player props:** two seasons of ESPN game logs, exponentially weighted to recent games; projected
  minutes (back-to-back, blowout risk); market-implied team total vs. team average; head-to-head
  rate vs. tonight's opponent; home/away split; with/without splits for injured teammates (date join
  of both players' logs) or a usage redistribution fallback. Normal (points/combos) or negative
  binomial (counts) distributions. Live props re-project from the box score: current stat + rate ×
  expected remaining minutes, adjusted for fouls and garbage time.
- **Market prior:** prop confidence blends the model with the Kalshi mid (45%→15% market weight,
  less when the quote is stale) so information the model lacks pulls it back toward the market.
- **Pricing:** Edge = confidence − ask − Kalshi taker fee (0.07·P·(1−P)). *Max entry* keeps a
  safety margin that grows with model uncertainty; *Great entry* adds 6¢. Kelly shown at ¼.

## Model validation on real NBA data

Player projections were tested walk-forward on 50,958 real ESPN player-games (503 players,
2024-25 → this season): every game is projected from the games before it only, then scored on
P(stat ≥ line) at the usual ladder lines. Settings were tuned on 2025-26 and checked on 2026-27
games the tuning never saw.

| | Old model | Current model |
|---|---|---|
| 2025-26 (Jan → Apr), calibration error | 2.20 pts | 1.83 pts |
| 2025-26 opening weeks, calibration error | 1.97 pts | 1.36 pts |
| 2026-27 so far (held out), log loss | 0.4706 | 0.4607 |
| 2026-27 so far (held out), calibration error | 4.27 pts | 2.34 pts |

What changed and why:
- **Minutes-aware spread.** The spread was measured on minute-normalised games, so foul trouble,
  blowouts and early exits were missing; overs called 75% hit 71%. Using the raw spread fixed the
  tails (85% → 84%, 7% → 8%).
- **League season drift.** The same 290 players are scoring 7.9% fewer points per minute and
  playing 5.2% fewer minutes than last season; last-season games are now rescaled by a drift
  factor pooled over every loaded player.
- **This season's minutes first.** Roles reset each October; this season's minutes take over after
  ~2 games.
- **Short-night scenario.** A blended chance (own history, shrunk to a role prior) that a player
  logs under 10 minutes — those nights almost never cash an over.
- Tested and rejected: capping big games (worse — big nights are real signal), shorter or longer
  recency half-lives, lower weight on last season.

Some early-season over-projection remains (lines called 55% have hit ~44% since Nov 1 on a small
sample), which is why pregame props for players with fewer than 10 games lean further on the
Kalshi price, and every pick still needs +4% edge after the blend.

### Stress test on tonight's live slate (Nov 9, 8 games, 5,754 priced contracts)

Run against live ESPN data and the live Kalshi feed before shipping:

- **Teammate absences were compounding.** Kyshawn George (3 Wizards teammates OUT) was projected
  at 41.6 PRA (season average 28) because each absence's with/without split multiplied the next one
  and also credited his role change from last season. Now: same-season splits, scaled by how much of
  his recent sample still had the teammate, added with caps. Real-data test on 12,373 games with
  absent teammates: calibration error 2.61 → 2.19 pts (old method) and the pile-up cases that made
  lines called 55% hit 39% are gone.
- **Ladders could run backwards** (his 30+ PRA showed 85.6%, above 25+ at 60.2%): each rung was
  blended with its own quote only when that quote was tight. Now one isotonic Kalshi curve per ladder
  and one model weight per ladder → 0 order violations across 572 ladders, 0 among line-stepper
  values.
- **299 pregame quarter/half "edges" were fabricated** by an even split of the game total across
  quarters. Real 2025-26 shares (1,231 games): Q1 25.5%, Q2 25.0%, Q3 25.4%, Q4 24.0%; pregame
  segment lines now lean 70% on their Kalshi ladder. 17 remain.
- **Market conflict gate:** 54 contracts where the model and a liquid ladder disagreed by more than
  22 points are blocked (mostly one player's whole ladder).
- **History charts** show real box scores again (the season-drift rescale had leaked into them).

Survivors went from 489 to 100 on the same slate — the removed ones were the fabricated edges above.

## Lines you choose

Every prop, spread, total and team total card has a line stepper (− / +) and chips for the lines
Kalshi lists. Moving the line re-prices the pick (Kalshi's real market at that line when it
exists; otherwise the model, adjusted by the same market blend the nearest listed lines get, so
probabilities stay ordered) and moves the line in the History charts. Optimal Parlay legs and
parlay-builder legs have the same steppers; edited parlays stay pinned until you reset them.
**Build Your Own Pick** (in each game, and inside the parlay builder for any game) prices any
spread, total, team total, moneyline or player-prop over, for the full game or any half/quarter.

## Build

```bash
node tools/build.js   # → dist/index.html (hosted) and dist/artifact.html
```

Sources are plain browser JS in `src/` concatenated in a fixed order (no dependencies).

No model guarantees profit. Kalshi player-prop rules for players who don't play vary by market —
check them before entering. Robinhood's event-contract prices can differ from Kalshi's.
