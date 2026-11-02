// Fetches every open NBA market from Kalshi's public API and force-pushes a compact snapshot
// (kalshi.json) to the `data` branch about once a minute. The web app reads it from
// raw.githubusercontent.com (CORS-enabled) when it can't reach Kalshi directly.
const { execSync } = require('child_process');
const fs = require('fs');
const BASES = ['https://external-api.kalshi.com/trade-api/v2', 'https://api.elections.kalshi.com/trade-api/v2'];
const FALLBACK = ['KXNBAGAME', 'KXNBASPREAD', 'KXNBATOTAL', 'KXNBAPTS', 'KXNBAREB', 'KXNBAAST', 'KXNBA3PT', 'KXNBAPRA', 'KXNBA1HWINNER', 'KXNBA1QWINNER', 'KXNBA2HWINNER', 'KXNBA1HSPREAD', 'KXNBA1HTOTAL', 'KXNBASTL', 'KXNBABLK'];
const NOT_GAME = /^KXNBA(MVP|ROY|DPOY|6MOY|MIP|COY|WINS|EAST|WEST|DIV|SERIES|DRAFT|FINALS|CHAMP|PLAYOFF|SEED|ALLSTAR|TRADE|COACH)|^KXNBA$/;
const RUN_MS = (+process.env.RUN_MINUTES || 28) * 60e3, EVERY_MS = (+process.env.EVERY_SECONDS || 55) * 1e3;
const DIR = process.env.SNAP_DIR || '/tmp/snap';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  for (const b of BASES) {
    try {
      const r = await fetch(b + path, { headers: { accept: 'application/json', 'user-agent': 'courtside-edge-snapshot' } });
      if (r.status === 429) { await sleep(2000); continue; }
      if (r.ok) return await r.json();
    } catch (e) { /* try next host */ }
  }
  return null;
}
async function seriesList() {
  const j = await get('/series?category=Sports');
  const found = (j?.series || []).map((s) => s.ticker).filter((t) => /^KXNBA/.test(t) && !NOT_GAME.test(t));
  return [...new Set([...FALLBACK, ...found])];
}
const keep = (m) => {
  const o = { ticker: m.ticker, event_ticker: m.event_ticker, title: m.title, yes_sub_title: m.yes_sub_title, subtitle: m.subtitle || undefined, status: m.status,
    yes_bid_dollars: m.yes_bid_dollars, yes_ask_dollars: m.yes_ask_dollars, no_bid_dollars: m.no_bid_dollars, no_ask_dollars: m.no_ask_dollars, last_price_dollars: m.last_price_dollars,
    volume: m.volume ?? m.volume_fp, open_interest: m.open_interest ?? m.open_interest_fp, floor_strike: m.floor_strike, cap_strike: m.cap_strike, strike_type: m.strike_type, custom_strike: m.custom_strike };
  // legacy integer-cent fields if the dollar strings are missing
  if (o.yes_bid_dollars == null && m.yes_bid != null) { o.yes_bid = m.yes_bid; o.yes_ask = m.yes_ask; o.no_bid = m.no_bid; o.no_ask = m.no_ask; o.last_price = m.last_price; }
  return o;
};
async function snapshot(series) {
  const markets = []; let okSeries = 0;
  for (const ser of series) {
    let cursor = '', pages = 0, any = false;
    do {
      const j = await get(`/markets?series_ticker=${ser}&status=open&limit=1000${cursor ? '&cursor=' + cursor : ''}`);
      if (!j) break;
      any = true;
      for (const m of j.markets || []) markets.push(keep(m));
      cursor = j.cursor || ''; pages++;
    } while (cursor && pages < 8);
    if (any) okSeries++;
    await sleep(120);
  }
  return { at: Date.now(), okSeries, series, markets };
}
function sh(cmd) { return execSync(cmd, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
(async () => {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  fs.mkdirSync(DIR, { recursive: true });
  if (repo && token) {
    sh('git init -q'); sh('git config user.name "kalshi-snapshot"'); sh('git config user.email "actions@users.noreply.github.com"');
    sh(`git remote add origin https://x-access-token:${token}@github.com/${repo}.git`);
  }
  const t0 = Date.now(); let series = await seriesList(), n = 0;
  while (Date.now() - t0 < RUN_MS) {
    const c0 = Date.now();
    try {
      if (n % 30 === 29) series = await seriesList();
      const snap = await snapshot(series);
      fs.writeFileSync(DIR + '/kalshi.json', JSON.stringify(snap));
      console.log(new Date().toISOString(), 'markets', snap.markets.length, 'series ok', snap.okSeries, '/', series.length);
      if (repo && token && snap.okSeries) {
        sh(`git checkout -q --orphan s${n}`); sh('git add -A'); sh('git commit -qm "kalshi snapshot"');
        sh('git push -qf origin HEAD:refs/heads/data');
      }
    } catch (e) { console.log('cycle failed:', e.message); }
    n++;
    if (!repo) break; // local run: single snapshot
    await sleep(Math.max(5000, EVERY_MS - (Date.now() - c0)));
  }
})();
