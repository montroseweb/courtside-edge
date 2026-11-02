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

## Build

```bash
node tools/build.js   # → dist/index.html (hosted) and dist/artifact.html
```

Sources are plain browser JS in `src/` concatenated in a fixed order (no dependencies).

No model guarantees profit. Kalshi player-prop rules for players who don't play vary by market —
check them before entering. Robinhood's event-contract prices can differ from Kalshi's.
