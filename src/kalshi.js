/* ============================================================
   kalshi.js — Kalshi public market data: series discovery,
   event↔game matching, market classification, quote history,
   and an adaptive polling scheduler (fast for live/focused games)
   ============================================================ */

const KALSHI = (() => {
  const V = '/trade-api/v2';
  const FALLBACK_SERIES = ['KXNBAGAME', 'KXNBASPREAD', 'KXNBATOTAL', 'KXNBAPTS', 'KXNBAREB', 'KXNBAAST', 'KXNBA3PT', 'KXNBAPRA', 'KXNBASTL', 'KXNBABLK', 'KXNBA1HWINNER', 'KXNBA1QWINNER', 'KXNBA2HWINNER', 'KXNBA1HSPREAD', 'KXNBA1HTOTAL'];
  const NOT_GAME = /^KXNBA(MVP|ROY|DPOY|6MOY|MIP|COY|WINS|EAST|WEST|DIV|SERIES|DRAFT|FINALS|CHAMP|PLAYOFF|SEED|ALLSTAR|TRADE|COACH)|^KXNBA$/;

  const S = {
    series: [],            // candidate series tickers
    gameSeries: new Set(), // series that actually have per-game events
    events: new Map(),     // event ticker → {ticker, series, gameKey}
    markets: new Map(),    // market ticker → normalized market
    byGame: new Map(),     // gameKey → Map(ticker → market)
    games: new Map(),      // gameKey → game (from app)
    tasks: new Map(),      // task id → {last, busy}
    discovered: 0, lastEventScan: 0, ok: false, err: '', updated: 0,
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
      if (/^[A-Za-zÀ-ÿ.'\-]+(\s+[A-Za-zÀ-ÿ.'\-]+){1,3}$/.test(s)) return s;
    }
    return null;
  }

  function normalize(m, evInfo) {
    const g = S.games.get(evInfo.key);
    const series = evInfo.series;
    const text = [m.title, m.yes_sub_title, m.subtitle].filter(Boolean).join(' · ');
    const seg = segOf(series, [m.title, m.yes_sub_title].join(' '));
    let kind = 'other', side = null, stat = null, player = null;
    const th = threshold(m, text);
    if (/TEAMTOTAL|TEAMPTS/.test(series)) { kind = 'teamtotal'; side = teamSide(m, g, text); }
    else if (/SPREAD/.test(series) || /wins by (over|more than)/i.test(text)) { kind = 'spread'; side = teamSide(m, g, text); }
    else if (/TOTAL/.test(series) || (/total points|points scored/i.test(text) && !/:\s*\d/.test(m.yes_sub_title || ''))) { kind = 'total'; }
    else if (/GAME$|WINNER/.test(series) || /winner/i.test(m.title || '')) { kind = 'ml'; side = teamSide(m, g, text); }
    else { stat = statOf(series, text); if (stat) { kind = 'prop'; player = playerName(m); } }
    const prev = S.markets.get(m.ticker);
    const yesBid = dollars(m.yes_bid_dollars, m.yes_bid), yesAsk = dollars(m.yes_ask_dollars, m.yes_ask);
    let noBid = dollars(m.no_bid_dollars, m.no_bid), noAsk = dollars(m.no_ask_dollars, m.no_ask);
    if (noAsk == null && yesBid != null) noAsk = 1 - yesBid;
    if (noBid == null && yesAsk != null) noBid = 1 - yesAsk;
    const now = Date.now();
    const out = {
      ticker: m.ticker, event: m.event_ticker || evInfo.ticker, series, gameKey: evInfo.key, kind, seg, side, stat, player, th,
      title: m.title || '', sub: m.yes_sub_title || '', rules: m.rules_primary || '',
      yesBid, yesAsk, noBid, noAsk, last: dollars(m.last_price_dollars, m.last_price), prevPrice: dollars(m.previous_price_dollars, m.previous_price),
      vol: U.num(m.volume) ?? U.num(m.volume_fp) ?? 0, oi: U.num(m.open_interest) ?? U.num(m.open_interest_fp) ?? 0,
      status: m.status || '', close: Date.parse(m.close_time) || 0,
      seenAt: now, quoteAt: prev?.quoteAt || now, hist: prev?.hist || [],
      espnId: prev?.espnId,
    };
    const changed = !prev || prev.yesBid !== yesBid || prev.yesAsk !== yesAsk;
    if (changed) {
      out.quoteAt = now;
      out.hist.push({ t: now, bid: yesBid, ask: yesAsk });
      if (out.hist.length > 240) out.hist.splice(0, out.hist.length - 240);
    }
    return out;
  }

  function ingest(list, fallbackEvent) {
    const touched = new Set();
    for (const m of list || []) {
      if (!m?.ticker) continue;
      const et = m.event_ticker || fallbackEvent;
      let info = S.events.get(et);
      if (!info) { const p = parseEventTicker(et); if (!p) continue; info = { ticker: et, series: p.series, key: p.key }; S.events.set(et, info); }
      if (!S.games.has(info.key)) continue;
      const st = String(m.status || '').toLowerCase();
      if (st && !/active|open|initialized/.test(st)) { S.markets.delete(m.ticker); S.byGame.get(info.key)?.delete(m.ticker); continue; }
      const nm = normalize(m, info);
      S.markets.set(m.ticker, nm);
      if (!S.byGame.has(info.key)) S.byGame.set(info.key, new Map());
      S.byGame.get(info.key).set(m.ticker, nm);
      touched.add(info.key);
    }
    if (touched.size) { S.updated = Date.now(); S.ok = true; notify(touched); }
    return touched;
  }

  async function discover() {
    let series = null;
    const cached = !NET.isDemo() && U.store.get('kseries');
    if (cached && Date.now() - cached.t < 6 * 3600e3 && cached.list?.length) series = cached.list;
    if (!series) {
      try {
        const j = await NET.get('kalshi', `${V}/series?category=Sports`, { priority: 5 });
        series = (j?.series || []).map((s) => s.ticker).filter((t) => /^KXNBA/.test(t) && !NOT_GAME.test(t));
        if (!series.length) series = null;
      } catch (e) { S.err = e.message; }
      if (!series) series = FALLBACK_SERIES;
      else for (const f of FALLBACK_SERIES.slice(0, 7)) if (!series.includes(f)) series.push(f);
      if (!NET.isDemo()) U.store.set('kseries', { t: Date.now(), list: series });
    }
    S.series = series;
    await scanEvents();
    S.discovered = Date.now();
  }

  async function scanEvents() {
    S.lastEventScan = Date.now();
    const jobs = S.series.map(async (ser) => {
      try {
        let cursor = '', pages = 0, hit = false;
        do {
          const j = await NET.get('kalshi', `${V}/events?series_ticker=${ser}&status=open&with_nested_markets=true&limit=200${cursor ? '&cursor=' + cursor : ''}`, { priority: 4 });
          for (const ev of j?.events || []) {
            const p = parseEventTicker(ev.event_ticker);
            if (!p) continue;
            hit = true;
            S.events.set(ev.event_ticker, { ticker: ev.event_ticker, series: p.series, key: p.key, title: ev.title });
            if (ev.markets) ingest(ev.markets, ev.event_ticker);
          }
          cursor = j?.cursor || ''; pages++;
        } while (cursor && pages < 4);
        if (hit) S.gameSeries.add(ser);
      } catch (e) { if (e.code !== 404) S.err = e.message; }
    });
    await Promise.all(jobs);
  }

  async function pollSeries(ser, pri) {
    let cursor = '', pages = 0;
    do {
      const j = await NET.get('kalshi', `${V}/markets?series_ticker=${ser}&status=open&limit=1000${cursor ? '&cursor=' + cursor : ''}`, { priority: pri, fresh: true });
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
    run('scan', 5 * 60e3, scanEvents);
    const seriesList = [...S.gameSeries];
    for (const ser of seriesList) {
      const isLine = LINE_RE.test(ser);
      const every = isLine ? (ctx.anyLive ? 2000 : ctx.soon ? 8000 : 25000) : (ctx.anyLive ? 9000 : ctx.soon ? 20000 : 60000);
      run('s:' + ser, every, () => pollSeries(ser, isLine ? 3 : 1));
    }
    if (ctx.focusKey) {
      const evs = [...S.events.values()].filter((e) => e.key === ctx.focusKey).map((e) => e.ticker);
      if (evs.length) run('f:' + ctx.focusKey, ctx.focusLive ? 1200 : 6000, () => pollEvents(evs, 6));
    }
  }

  return {
    discover, tick,
    setGames(list) { S.games.clear(); for (const g of list) S.games.set(g.kkey, g); },
    marketsFor: (key) => [...(S.byGame.get(key)?.values() || [])],
    hasGame: (key) => (S.byGame.get(key)?.size || 0) > 0,
    onUpdate: (f) => { listeners.add(f); return () => listeners.delete(f); },
    status: () => ({ ok: S.ok, err: S.err, updated: S.updated, series: [...S.gameSeries], markets: S.markets.size }),
    gameKey, parseEventTicker, _S: S,
  };
})();
