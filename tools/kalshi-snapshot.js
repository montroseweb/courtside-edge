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
// only per-game markets for (ET) yesterday..+4 days, in a compact array form:
// [ticker, yes_sub_title, floor_strike, strike_type, yes_bid, yes_ask, last, volume, open_interest, extra]
const GAME_SERIES = /^KXNBA(GAME|SPREAD|TOTAL|TEAMTOTAL|PTS|REB|AST|3PT|PRA|PR|PA|RA|STL|BLK|WINMARGIN|OT|(1Q|2Q|3Q|4Q|1H|2H)(WINNER|SPREAD|TOTAL|TEAMTOTAL)?)(PROT)?$/;
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function dateCodes() {
  const out = new Set();
  for (let d = -1; d <= 4; d++) {
    const t = new Date(Date.now() + d * 864e5);
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: '2-digit', month: 'numeric', day: '2-digit' }).formatToParts(t);
    const o = {}; for (const x of et) o[x.type] = x.value;
    out.add(o.year + MON[+o.month - 1] + o.day);
  }
  return out;
}
const px = (d, c) => (d != null ? +(+d).toFixed(4) : c != null ? +(c / 100).toFixed(4) : null);
const keep = (m, codes) => {
  const parts = String(m.ticker).split('-');
  if (parts.length < 3 || !GAME_SERIES.test(parts[0]) || !codes.has(parts[1].slice(0, 7))) return null;
  if (m.status && !/active|open/.test(m.status)) return null;
  const cs = m.custom_strike || {};
  const extra = {};
  for (const [k, v] of Object.entries(cs)) if (!/basketball_/.test(k)) extra[k] = v;
  return [m.ticker, m.yes_sub_title || m.title || '', m.floor_strike ?? null, m.strike_type || null, px(m.yes_bid_dollars, m.yes_bid), px(m.yes_ask_dollars, m.yes_ask),
    px(m.last_price_dollars, m.last_price), Math.round(+(m.volume ?? m.volume_fp ?? 0)), Math.round(+(m.open_interest ?? m.open_interest_fp ?? 0)), Object.keys(extra).length ? extra : 0];
};
async function snapshot(series) {
  const markets = []; let okSeries = 0; const codes = dateCodes();
  for (const ser of series.filter((x) => GAME_SERIES.test(x))) {
    let cursor = '', pages = 0, any = false;
    do {
      const j = await get(`/markets?series_ticker=${ser}&status=open&limit=1000${cursor ? '&cursor=' + cursor : ''}`);
      if (!j) break;
      any = true;
      for (const m of j.markets || []) { const k = keep(m, codes); if (k) markets.push(k); }
      cursor = j.cursor || ''; pages++;
    } while (cursor && pages < 8);
    if (any) okSeries++;
    await sleep(120);
  }
  return { v: 2, at: Date.now(), okSeries, markets };
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
