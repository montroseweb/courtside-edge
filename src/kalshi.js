/* ============================================================
   kalshi.js — Kalshi public market data: series discovery,
   event↔game matching, market classification, quote history,
   and an adaptive polling scheduler (fast for live/focused games)
   ============================================================ */

const KALSHI = (() => {
  const V = '/trade-api/v2';
  const FALLBACK_SERIES = ['KXNBAGAME', 'KXNBASPREAD', 'KXNBATOTAL', 'KXNBAPTS', 'KXNBAREB', 'KXNBAAST', 'KXNBA3PT', 'KXNBAPRA', 'KXNBASTL', 'KXNBABLK', 'KXNBA1HWINNER', 'KXNBA1QWINNER', 'KXNBA2HWINNER', 'KXNBA1HSPREAD', 'KXNBA1HTOTAL'];
  const SNAP_REPO = 'montroseweb/courtside-edge'; // GitHub Actions publishes Kalshi prices here (data branch)
  // a "player" name that is really a team (e.g. "Los Angeles L" in race-to-N markets)
  const TEAM_WORDS = new RegExp('^(' + TEAMS.list.flatMap((t) => [t.city, t.name, t.city + ' ' + t.name]).concat(['Los Angeles L', 'Los Angeles C', 'LA Clippers', 'LA Lakers']).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$', 'i');
  const SEGWIN = /^KXNBA(1Q|2Q|3Q|4Q|1H|2H)(WINNER)?(PROT)?$/;
  const NOT_GAME = /^KXNBA(MVP|ROY|DPOY|6MOY|MIP|COY|WINS|EAST|WEST|DIV|SERIES|DRAFT|FINALS|CHAMP|PLAYOFF|SEED|ALLSTAR|TRADE|COACH)|^KXNBA$/;

  const S = {
    series: [],            // candidate series tickers
    gameSeries: new Set(), // series that actually have per-game events
    events: new Map(),     // event ticker → {ticker, series, gameKey}
    markets: new Map(),    // market ticker → normalized market
    byGame: new Map(),     // gameKey → Map(ticker → market)
    games: new Map(),      // gameKey → game (from app)
    tasks: new Map(),      // task id → {last, busy}
    discovered: 0, lastEventScan: 0, ok: false, err: '', updated: 0, reached: 0,
    diag: { events: 0, matched: new Set(), unmatched: new Set(), lastScanErrors: 0 },
  };
  const listeners = new Set();
  const notify = (keys) => listeners.forEach((f) => { try { f(keys); } catch (e) { console.error(e); } });

  const gameKey = (dateCode, away, home) => `${dateCode}${away}${home}`;
  function parseEventTicker(t) {
    const i = String(t || '').indexOf('-');
    if (i < 0) return null;
    const series = t.slice(0, i), rest = t.slice(i + 1);
    const date = rest.slice(0, 7);
    if (!/^\d{2}[A-Z]{3}\d{2}$/.test(date)) return null;
    const letters = (rest.slice(7).match(/^[A-Z]+/) || [''])[0];
    const pair = TEAMS.splitPair(letters);
    if (!pair) return null;
    return { series, date, away: pair[0], home: pair[1], key: gameKey(date, pair[0], pair[1]) };
  }

  // map a Kalshi event to one of our games: exact key, else same teams (either order) within ±1 day
  const MONI = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const codeToKey = (dc) => '20' + dc.slice(0, 2) + String(MONI[dc.slice(2, 5)] || 0).padStart(2, '0') + dc.slice(5, 7);
  const dayDiff = (a, b) => Math.round((Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8)) - Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8))) / 864e5);
  function resolveKey(p) {
    if (S.games.has(p.key)) return p.key;
    const dk = codeToKey(p.date);
    for (const g of S.games.values()) {
      const same = g.away.code === p.away && g.home.code === p.home, swap = g.away.code === p.home && g.home.code === p.away;
      if ((same || swap) && Math.abs(dayDiff(g.dateKey, dk)) <= 1) return g.kkey;
    }
    return null;
  }
  const dollars = (d, c) => { const v = U.num(d); if (v != null) return v; const cc = U.num(c); return cc != null ? cc / 100 : null; };

  function segOf(series, text) {
    const s = series.replace(/^KXNBA/, '') + ' ' + text;
    if (/\b1Q|Q1\b|1ST\s*QUARTER|FIRST\s*QUARTER/i.test(s)) return 'Q1';
    if (/\b2Q|Q2\b|2ND\s*QUARTER|SECOND\s*QUARTER/i.test(s)) return 'Q2';
    if (/\b3Q|Q3\b|3RD\s*QUARTER|THIRD\s*QUARTER/i.test(s)) return 'Q3';
    if (/\b4Q|Q4\b|4TH\s*QUARTER|FOURTH\s*QUARTER/i.test(s)) return 'Q4';
    if (/1H|1ST\s*HALF|FIRST\s*HALF/i.test(s)) return '1H';
    if (/2H|2ND\s*HALF|SECOND\s*HALF/i.test(s)) return '2H';
    return null;
  }
  const STAT_SERIES = [
    [/PRA$|PTSREBAST/, 'pra'], [/PTSREB$|PR$/, 'pr'], [/PTSAST$|PA$/, 'pa'], [/REBAST$|RA$/, 'ra'],
    [/PTS$|POINTS$/, 'pts'], [/REB$|REBOUNDS$/, 'reb'], [/AST$|ASSISTS$/, 'ast'], [/3PT$|3PM$|THREES?$|3S$|3PTM$/, 'fg3m'],
    [/STL$|STEALS$/, 'stl'], [/BLK$|BLOCKS$/, 'blk'], [/DD$|DOUBLEDOUBLE$/, 'dd'], [/TD$|TRIPLEDOUBLE$/, 'td'],
  ];
  function statOf(series, text) {
    const s = series.replace(/^KXNBA/, '');
    for (const [re, k] of STAT_SERIES) if (re.test(s)) return k;
    const t = text.toLowerCase();
    if (/points\s*\+\s*rebounds\s*\+\s*assists|pts\s*\+\s*reb\s*\+\s*ast|\bpra\b/.test(t)) return 'pra';
    if (/double[-\s]double/.test(t)) return 'dd';
    if (/triple[-\s]double/.test(t)) return 'td';
    if (/three|3-point|3pt|3pm/.test(t)) return 'fg3m';
    if (/rebound/.test(t)) return 'reb';
    if (/assist/.test(t)) return 'ast';
    if (/steal/.test(t)) return 'stl';
    if (/block/.test(t)) return 'blk';
    if (/\bpoints?\b|\bpts\b/.test(t)) return 'pts';
    return null;
  }
  function teamSide(m, g, text) {
    if (!g) return null;
    const suf = (String(m.ticker).split('-').pop() || '').match(/^[A-Z]+/);
    if (suf) {
      const c = TEAMS.toCode(suf[0]);
      if (c === g.home.code) return 'home';
      if (c === g.away.code) return 'away';
      // prefix match for codes followed by player initials etc.
      for (const side of ['home', 'away']) if (suf[0].startsWith(g[side].code)) return side;
    }
    const t = (m.yes_sub_title || text || '').toLowerCase();
    const has = (w) => w && new RegExp('\\b' + w.toLowerCase().replace(/[^a-z0-9 ]/g, '') + '\\b').test(t);
    const score = (tm) => {
      let s = 0;
      if (has(tm.name)) s += 2;
      if (has(tm.city)) s += 1;
      if (tm.code === 'LAL' && /los angeles l\b|la lakers/.test(t)) s += 3;
      if (tm.code === 'LAC' && /los angeles c\b|la clippers/.test(t)) s += 3;
      return s;
    };
    const sh = score(g.home), sa = score(g.away);
    if (sh > sa) return 'home'; if (sa > sh) return 'away';
    return null;
  }
  function threshold(m, text) {
    const fs = U.num(m.floor_strike), cs = U.num(m.cap_strike), st = m.strike_type;
    if (fs != null && (st === 'greater' || st === 'greater_or_equal' || !st || st === 'structured')) {
      return st === 'greater_or_equal' ? { op: '>=', line: fs, k: Math.ceil(fs) } : { op: '>', line: fs, k: Math.floor(fs) + 1 };
    }
    if (cs != null && (st === 'less' || st === 'less_or_equal')) return { op: '<', line: cs, kmax: st === 'less_or_equal' ? Math.floor(cs) : Math.ceil(cs) - 1 };
    let mm = text.match(/(\d+(?:\.\d+)?)\s*\+/);
    if (mm) return { op: '>=', line: +mm[1], k: Math.ceil(+mm[1]) };
    mm = text.match(/(?:over|more than|at least)\s+(\d+(?:\.\d+)?)/i);
    if (mm) { const v = +mm[1]; return /at least/i.test(mm[0]) ? { op: '>=', line: v, k: Math.ceil(v) } : { op: '>', line: v, k: Math.floor(v) + 1 }; }
    return null;
  }
  function playerName(m) {
    if (m.custom_strike && typeof m.custom_strike === 'object') {
      for (const v of Object.values(m.custom_strike)) if (typeof v === 'string' && /[a-z]{2,}\s+[a-z]/i.test(v)) return v.trim();
    }
    for (const src of [m.yes_sub_title, m.title, m.subtitle]) {
      if (!src) continue;
      let s = String(src);
      if (s.includes(':')) s = s.split(':')[0];
      s = s.replace(/^will\s+/i, '').replace(/\s*\d+(\.\d+)?\s*\+.*$/, '')
        .replace(/\b(record|score|scores|have|get|over|under|at least|or more|points?|rebounds?|assists?|threes?|3-pointers?|made|steals?|blocks?|double[- ]double|triple[- ]double)\b.*$/i, '').trim();
      if (/^[\p{L}.'’\-]+(\s+[\p{L}.'’\-]+){1,4}$/u.test(s) && !TEAM_WORDS.test(s)) return s;
    }
    return null;
  }

  function parseRange(t) {
    t = String(t || '');
    let mm = t.match(/(\d+)\s*(?:to|-|–)\s*(\d+)/i); if (mm) return [+mm[1], +mm[2]];
    mm = t.match(/(\d+)\s*(?:\+|or more)/i); if (mm) return [+mm[1], Infinity];
    mm = t.match(/(?:over|more than)\s*(\d+)/i); if (mm) return [+mm[1] + 1, Infinity];
    return null;
  }
  function normalize(m, evInfo, snapAt) {
    const g = S.games.get(evInfo.key);
    const series = evInfo.series;
    const text = [m.title, m.yes_sub_title, m.subtitle].filter(Boolean).join(' · ');
    const seg = segOf(series, [m.title, m.yes_sub_title].join(' '));
    let kind = 'other', side = null, stat = null, player = null;
    const th = threshold(m, text);
    const suffix = String(m.ticker).split('-').pop() || '';
    let range = null;
    if (/TEAMTOTAL|TEAMPTS/.test(series)) { kind = 'teamtotal'; side = teamSide(m, g, text); }
    else if (/WINMARGIN/.test(series)) { kind = 'margin'; side = teamSide(m, g, text); range = parseRange((m.custom_strike && (m.custom_strike['Winning Margin'] || m.custom_strike.margin)) || '') || parseRange(m.yes_sub_title || '') || parseRange(m.title || '') || parseRange(m.ticker.split('-').pop().replace(/^[A-Z]+/, '').replace('PLUS', '+').replace('TO', ' to ')); }
    else if (/^KXNBA(OT|OVERTIME)$/.test(series)) { kind = 'ot'; }
    else if (/RACE|LEADER|FIRST|H2H|ESCALATOR|LADDER/.test(series.replace(/^KXNBA/, ''))) { kind = 'other'; }
    else if (SEGWIN.test(series)) { kind = 'ml'; side = /^TIE$/i.test(suffix) || /^tie$/i.test(m.yes_sub_title || '') ? 'tie' : teamSide(m, g, text); }
    else if (/SPREAD/.test(series) || /wins by (over|more than)/i.test(text)) { kind = 'spread'; side = teamSide(m, g, text); }
    else if (/TOTAL/.test(series) || (/total points|points scored/i.test(text) && !/:\s*\d/.test(m.yes_sub_title || ''))) { kind = 'total'; }
    else if (/GAME$|WINNER/.test(series) || /winner/i.test(m.title || '')) { kind = 'ml'; side = teamSide(m, g, text); }
    else { stat = statOf(series, text); if (stat) { player = playerName(m); kind = player ? 'prop' : 'other'; } }
    const prev = S.markets.get(m.ticker);
    const yesBid = dollars(m.yes_bid_dollars, m.yes_bid), yesAsk = dollars(m.yes_ask_dollars, m.yes_ask);
    let noBid = dollars(m.no_bid_dollars, m.no_bid), noAsk = dollars(m.no_ask_dollars, m.no_ask);
    if (noAsk == null && yesBid != null) noAsk = 1 - yesBid;
    if (noBid == null && yesAsk != null) noBid = 1 - yesAsk;
    const now = Date.now();
    const out = {
      ticker: m.ticker, event: m.event_ticker || evInfo.ticker, series, gameKey: evInfo.key, kind, seg, side, stat, player, th, range, prot: /PROT$/.test(series),
      title: m.title || '', sub: m.yes_sub_title || '', rules: m.rules_primary || '',
      yesBid, yesAsk, noBid, noAsk, last: dollars(m.last_price_dollars, m.last_price), prevPrice: dollars(m.previous_price_dollars, m.previous_price),
      vol: U.num(m.volume) ?? U.num(m.volume_fp) ?? 0, oi: U.num(m.open_interest) ?? U.num(m.open_interest_fp) ?? 0,
      status: m.status || '', close: Date.parse(m.close_time) || 0,
      seenAt: now, quoteAt: prev?.quoteAt || now, hist: prev?.hist || [],
      espnId: prev?.espnId,
    };
    if (snapAt) out.snapAt = snapAt;
    const changed = !prev || prev.yesBid !== yesBid || prev.yesAsk !== yesAsk;
    if (changed) {
      out.quoteAt = snapAt || now;
      out.hist.push({ t: snapAt || now, bid: yesBid, ask: yesAsk });
      if (out.hist.length > 240) out.hist.splice(0, out.hist.length - 240);
    }
    return out;
  }

  function ingest(list, fallbackEvent, snapAt) {
    const touched = new Set();
    for (const m of list || []) {
      if (!m?.ticker) continue;
      const et = m.event_ticker || fallbackEvent;
      let info = S.events.get(et);
      if (!info || !S.games.has(info.key)) {
        const p = parseEventTicker(et); if (!p) continue;
        const key = resolveKey(p);
        info = { ticker: et, series: p.series, key: key || p.key }; S.events.set(et, info);
        if (!key) { S.diag.unmatched.add(et.split('-').slice(1, 2)[0]); continue; }
      }
      if (!S.games.has(info.key)) continue;
      S.diag.matched.add(info.key);
      const st = String(m.status || '').toLowerCase();
      if (st && !/active|open|initialized/.test(st)) { S.markets.delete(m.ticker); S.byGame.get(info.key)?.delete(m.ticker); continue; }
      const nm = normalize(m, info, snapAt);
      S.markets.set(m.ticker, nm);
      if (!S.byGame.has(info.key)) S.byGame.set(info.key, new Map());
      S.byGame.get(info.key).set(m.ticker, nm);
      touched.add(info.key);
    }
    if (touched.size) { S.updated = Date.now(); S.ok = true; notify(touched); }
    return touched;
  }

  async function discover() {
    const cached = !NET.isDemo() && U.store.get('kseries');
    S.series = cached && Date.now() - cached.t < 6 * 3600e3 && cached.list?.length ? cached.list : FALLBACK_SERIES.slice();
    // fetch the published snapshot at the same time, so prices show even if Kalshi blocks the browser
    const snapP = NET.isDemo() ? Promise.resolve() : loadSnapshot().catch(() => { });
    await scanEvents();            // core series first so prices appear fast
    S.discovered = Date.now();
    await snapP;
    if (!cached && !NET.viaRelay('kalshi')) {
      // the full Sports series list is large; skip it on slow public relays
      NET.get('kalshi', `${V}/series?category=Sports`, { priority: 2, timeout: 15000 }).then((j) => {
        const more = (j?.series || []).map((x) => x.ticker).filter((t) => /^KXNBA/.test(t) && !NOT_GAME.test(t));
        if (!more.length) return;
        const all = [...new Set([...FALLBACK_SERIES.slice(0, 7), ...more])];
        U.store.set('kseries', { t: Date.now(), list: all });
        const fresh = all.filter((t) => !S.series.includes(t));
        S.series = all;
        if (fresh.length) return scanEvents(fresh);
      }).catch(() => { });
    }
  }

  async function scanEvents(only) {
    S.lastEventScan = Date.now();
    let errs = 0;
    let list = only || S.series;
    if (!only && !NET.isDemo()) {
      // probe with one series first; if Kalshi is unreachable from this browser, don't fire the rest
      const first = list.includes('KXNBAGAME') ? 'KXNBAGAME' : list[0];
      try { await NET.get('kalshi', `${V}/events?series_ticker=${first}&status=open&limit=1`, { priority: 5, timeout: 7000 }); S.reached = Date.now(); }
      catch (e) { if (e.code !== 404) { S.err = e.message; S.diag.lastScanErrors = 1; return; } }
    }
    const jobs = list.map(async (ser) => {
      try {
        let cursor = '', pages = 0, hit = false;
        do {
          const j = await NET.get('kalshi', `${V}/events?series_ticker=${ser}&status=open&with_nested_markets=true&limit=200${cursor ? '&cursor=' + cursor : ''}`, { priority: 4 });
          S.reached = Date.now();
          for (const ev of j?.events || []) {
            const p = parseEventTicker(ev.event_ticker);
            if (!p) continue;
            hit = true; S.diag.events++;
            const key = resolveKey(p);
            S.events.set(ev.event_ticker, { ticker: ev.event_ticker, series: p.series, key: key || p.key, title: ev.title });
            if (!key) { S.diag.unmatched.add(ev.event_ticker.split('-')[1]); continue; }
            if (ev.markets) ingest(ev.markets, ev.event_ticker);
          }
          cursor = j?.cursor || ''; pages++;
        } while (cursor && pages < 4);
        if (hit) S.gameSeries.add(ser);
      } catch (e) { if (e.code !== 404) { S.err = e.message; errs++; } }
    });
    await Promise.all(jobs);
    S.diag.lastScanErrors = errs;
  }

  const decode = (a) => {
    if (!Array.isArray(a)) return a; // v1 snapshots stored raw market objects
    const [ticker, sub, fs, st, yb, ya, last, vol, oi, extra] = a, parts = ticker.split('-');
    return { ticker, event_ticker: parts[0] + '-' + parts[1], yes_sub_title: sub, title: sub, floor_strike: fs, strike_type: st, yes_bid_dollars: yb, yes_ask_dollars: ya, last_price_dollars: last, volume: vol, open_interest: oi, custom_strike: extra || null, status: 'active' };
  };
  async function loadSnapshot() {
    let sha = null;
    // GitHub's unauthenticated API allows 60 requests/hour per IP: check for a new snapshot at most every 75s
    if (S.snapSha && Date.now() - (S.ghapiAt || 0) < 75000) return;
    S.ghapiAt = Date.now();
    try { const b = await NET.get('ghapi', `/repos/${SNAP_REPO}/branches/data`, { fresh: true, timeout: 8000 }); sha = b?.commit?.sha || null; } catch { }
    if (sha && sha === S.snapSha && Date.now() - S.snapLoaded < 5 * 60e3) return;
    const path = sha ? `/${SNAP_REPO}/${sha}/kalshi.json` : `/${SNAP_REPO}/refs/heads/data/kalshi.json?m=${Math.floor(Date.now() / 60000)}`;
    const j = await NET.get('ghraw', path, { fresh: !sha, timeout: 20000 });
    if (!j?.markets?.length || !j.at) return;
    if (S.snapAt && j.at <= S.snapAt) return;
    S.snapSha = sha; S.snapAt = j.at; S.snapLoaded = Date.now();
    const live = S.reached && Date.now() - S.reached < 120e3;
    if (live) return; // direct prices are flowing; keep them
    ingest(j.markets.map(decode), null, j.at);
    for (const [t, m] of S.markets) if (m.snapAt && m.snapAt < j.at) { S.markets.delete(t); S.byGame.get(m.gameKey)?.delete(t); }
    S.gameSeries.size; // (series polling is irrelevant in snapshot mode)
  }

  async function pollSeries(ser, pri) {
    let cursor = '', pages = 0;
    do {
      const j = await NET.get('kalshi', `${V}/markets?series_ticker=${ser}&status=open&limit=1000${cursor ? '&cursor=' + cursor : ''}`, { priority: pri, fresh: true });
      S.reached = Date.now();
      ingest(j?.markets);
      cursor = j?.cursor || ''; pages++;
    } while (cursor && pages < 5);
  }
  async function pollEvents(evs, pri) {
    const size = S.noComma ? 1 : 10;
    for (let i = 0; i < evs.length; i += size) {
      const chunk = evs.slice(i, i + size);
      let got = null;
      try { const j = await NET.get('kalshi', `${V}/markets?event_ticker=${chunk.join(',')}&limit=1000`, { priority: pri, fresh: true }); got = ingest(j?.markets); } catch { got = null; }
      if ((!got || !got.size) && chunk.length > 1) {
        // comma-separated event lists unsupported → remember and fetch one event at a time
        S.noComma = true;
        for (const e of chunk) { try { const k = await NET.get('kalshi', `${V}/markets?event_ticker=${e}&limit=1000`, { priority: pri, fresh: true }); ingest(k?.markets, e); } catch { } }
      }
    }
  }

  function due(id, every) {
    const t = S.tasks.get(id) || { last: 0, busy: false };
    S.tasks.set(id, t);
    if (t.busy || Date.now() - t.last < every) return null;
    t.busy = true; t.last = Date.now();
    return () => { t.busy = false; };
  }
  const LINE_RE = /GAME$|WINNER|SPREAD|TOTAL/;

  // ctx: {anyLive, focusKey, focusLive, soon}
  function tick(ctx) {
    if (!S.discovered) return;
    const run = (id, every, fn) => { const done = due(id, every); if (done) fn().catch((e) => { S.err = e.message; }).finally(done); };
    const relay = NET.viaRelay('kalshi');
    // nothing found yet (blocked / slow relay / no games): keep retrying discovery every 30s
    const live = S.reached && Date.now() - S.reached < 120e3;
    run('scan', S.gameSeries.size ? 5 * 60e3 : live ? 30e3 : 3 * 60e3, () => scanEvents());
    if (!live && !NET.isDemo()) run('snap', 20000, loadSnapshot);
    const seriesList = [...S.gameSeries];
    for (const ser of seriesList) {
      const isLine = LINE_RE.test(ser);
      let every = isLine ? (ctx.anyLive ? 2000 : ctx.soon ? 8000 : 25000) : (ctx.anyLive ? 9000 : ctx.soon ? 20000 : 60000);
      if (relay) every = isLine ? (ctx.anyLive ? 8000 : 30000) : (ctx.anyLive ? 30000 : 90000);
      run('s:' + ser, every, () => pollSeries(ser, isLine ? 3 : 1));
    }
    if (ctx.focusKey) {
      const evs = [...S.events.values()].filter((e) => e.key === ctx.focusKey).map((e) => e.ticker);
      if (evs.length) run('f:' + ctx.focusKey, relay ? (ctx.focusLive ? 5000 : 20000) : (ctx.focusLive ? 1200 : 6000), () => pollEvents(evs, 6));
    }
  }

  return {
    discover, tick,
    setGames(list) { S.games.clear(); for (const g of list) S.games.set(g.kkey, g); },
    marketsFor: (key) => [...(S.byGame.get(key)?.values() || [])],
    hasGame: (key) => (S.byGame.get(key)?.size || 0) > 0,
    onUpdate: (f) => { listeners.add(f); return () => listeners.delete(f); },
    status: () => ({ snapAt: S.snapAt || 0, snapMode: !!S.snapAt && !(S.reached && Date.now() - S.reached < 120e3), ok: S.ok, err: S.err, updated: S.updated, reached: S.reached, discovered: S.discovered, series: [...S.gameSeries], markets: S.markets.size, events: S.diag.events, matched: S.diag.matched.size, unmatched: [...S.diag.unmatched].slice(0, 6), scanErrors: S.diag.lastScanErrors }),
    gameKey, parseEventTicker, _S: S, _ingest: (l, e, a) => ingest(l, e, a),
  };
})();
