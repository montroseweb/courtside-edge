/* ============================================================
   app.js — state, feed loops, ESPN/NBA merge (fastest wins),
   scoring events, market calibration, routing, demo fallback
   ============================================================ */

const STATE = { todayKey: '', dateKey: '', dates: [], games: new Map(), list: [], box: new Map(), statAt: new Map(), pbp: new Map(), standings: null, focus: null, loaded: false, gen: 0 };

const APP = (() => {
  const timers = [];
  let running = false;
  const inArtifact = () => !!window.claude || /claude\.ai|claudeusercontent|anthropic/.test(location.hostname);

  function progress(state, period, clockSec, total) {
    const r = state === 'pre' ? 0 : state === 'in' ? 1 : 2;
    return r * 1e9 + (period || 0) * 1e6 + (period ? (720 - (clockSec ?? 720)) * 100 : 0) + (total || 0);
  }

  function makeGame(p) {
    const dateKey = U.etDateKey(new Date(p.date));
    const g = { ...p, dateKey, kkey: KALSHI.gameKey(U.kalshiDateCode(dateKey), p.away.code, p.home.code), events: [], shots: [], lastScoreAt: 0, pre: null, wp: null, kp: null, eval: null };
    g.ls = MODEL.liveState(g);
    return g;
  }

  function applyScore(g, hs, as, src, extra = {}) {
    const dh = hs - g.home.score, da = as - g.away.score;
    if (dh === 0 && da === 0) return;
    const prevMargin = g.home.score - g.away.score;
    g.home.score = hs; g.away.score = as;
    if (dh < 0 || da < 0 || !STATE.loaded || g.state === 'pre') return; // corrections / first load: no fx
    const now = Date.now();
    g.lastScoreAt = now;
    const el = U.minutesElapsed(g.period, g.clockSec);
    const newMargin = hs - as;
    const lead = (prevMargin > 0 && newMargin < 0) || (prevMargin < 0 && newMargin > 0);
    for (const [side, d] of [['home', dh], ['away', da]]) {
      if (d <= 0) continue;
      g.events.push({ t: now, side, pts: d, el });
      const shot = g.hasPbp ? null : COURT.synthShot(side, Math.min(3, d), Math.random);
      if (shot && d >= 2) g.shots.push({ ...shot, side, made: true, t: now });
      UI.scoreFx(g, side, Math.min(d, 3), { leadChange: lead });
    }
    if (g.events.length > 200) g.events.splice(0, g.events.length - 200);
    if (g.shots.length > 200) g.shots.splice(0, g.shots.length - 200);
    computeRun(g);
  }
  function computeRun(g) {
    const el = U.minutesElapsed(g.period, g.clockSec);
    const win = g.events.filter((e) => el - e.el <= 4.5);
    const h = U.sum(win.filter((e) => e.side === 'home').map((e) => e.pts)), a = U.sum(win.filter((e) => e.side === 'away').map((e) => e.pts));
    g.run = h >= a ? { side: 'home', pts: h, opp: a } : { side: 'away', pts: a, opp: h };
  }

  function mergeEspn(list) {
    for (const p of list) {
      let g = STATE.games.get(p.id);
      if (!g) { g = makeGame(p); STATE.games.set(p.id, g); continue; }
      const cur = progress(g.state, g.period, g.clockSec, g.home.score + g.away.score);
      const inc = progress(p.state, p.period, p.clockSec, p.home.score + p.away.score);
      Object.assign(g, { odds: p.odds || g.odds, espnWP: p.espnWP ?? g.espnWP, lastPlay: p.lastPlay || g.lastPlay, broadcast: p.broadcast || g.broadcast, venue: p.venue?.name ? p.venue : g.venue });
      for (const side of ['home', 'away']) { g[side].record = p[side].record || g[side].record; if (p[side].logo) g[side].logo = p[side].logo; }
      if (inc >= cur) {
        Object.assign(g, { state: p.state, statusName: p.statusName, detail: p.detail, shortDetail: p.shortDetail, period: p.period, clockSec: p.clockSec, displayClock: p.displayClock, completed: p.completed });
        g.home.line = p.home.line; g.away.line = p.away.line;
        applyScore(g, p.home.score, p.away.score, 'espn');
      }
    }
  }
  function mergeNba(sb) {
    if (!sb) return;
    for (const n of sb.games) {
      const g = STATE.list.find((x) => x.home.code === n.home.code && x.away.code === n.away.code && Math.abs(x.date - n.timeUTC) < 20 * 3600e3) || [...STATE.games.values()].find((x) => x.home.code === n.home.code && x.away.code === n.away.code && x.dateKey === STATE.todayKey);
      if (!g) continue;
      g.nbaId = n.gameId;
      const st = n.status === 2 ? 'in' : n.status === 3 ? 'post' : 'pre';
      const cur = progress(g.state, g.period, g.clockSec, g.home.score + g.away.score);
      const inc = progress(st, n.period, n.clockSec, n.home.score + n.away.score);
      if (inc > cur || (inc === cur && st !== 'pre')) {
        const was = g.state;
        g.state = st; g.period = n.period || g.period;
        if (n.clockSec != null) g.clockSec = n.clockSec;
        if (st === 'in') {
          const txt = n.statusText || '';
          g.statusName = /half/i.test(txt) ? 'STATUS_HALFTIME' : /end/i.test(txt) ? 'STATUS_END_PERIOD' : 'STATUS_IN_PROGRESS';
          if (g.clockSec === 0 && !/half|end/i.test(txt) && n.period < 4) g.statusName = 'STATUS_END_PERIOD';
        }
        if (st === 'post') { g.statusName = 'STATUS_FINAL'; g.detail = n.statusText || 'Final'; }
        if (n.home.line.length) g.home.line = n.home.line;
        if (n.away.line.length) g.away.line = n.away.line;
        applyScore(g, n.home.score, n.away.score, 'nba');
        if (was !== st) g.srcFlip = Date.now();
      }
    }
  }

  function resort() {
    const rank = { in: 0, pre: 1, post: 2 };
    STATE.list = [...STATE.games.values()].sort((a, b) => rank[a.state] - rank[b.state] || a.date - b.date);
    KALSHI.setGames(STATE.list);
  }

  // ---------- derived numbers per game ----------
  function derive(g) {
    g.ls = MODEL.liveState(g);
    const mk = KALSHI.marketsFor(g.kkey);
    const rec = INTEL.get(g.id);
    // pregame consensus: once the game tips, freeze the last pregame snapshot (live Kalshi
    // prices must not leak into the "pregame" anchor); if we never saw pregame, use book + BPI only
    if (g.state === 'pre') { g.pre = MODEL.pregame(g, rec?.summary, mk); g.preSnap = g.pre; }
    else g.pre = g.preSnap || MODEL.pregame(g, rec?.summary, []);
    const mlH = mk.find((m) => m.kind === 'ml' && !m.seg && m.side === 'home'), mlA = mk.find((m) => m.kind === 'ml' && !m.seg && m.side === 'away');
    let kp = MODEL.mid(mlH); if (kp == null && MODEL.mid(mlA) != null) kp = 1 - MODEL.mid(mlA);
    g.kp = kp;
    const now = Date.now();
    if (g.state === 'in') {
      // calibrate strength to the market only when it is settled (no scoring in the last 20s)
      const quiet = !g.lastScoreAt || now - g.lastScoreAt > 20000;
      // late in games the strength inversion amplifies noise (÷τ), so only calibrate with >~10 min left
      if (kp != null && quiet && g.ls.tau > 0.2 && (mlH || mlA).seenAt > now - 15000) {
        const sm = (MODEL.marginDist(g.ls, 0).sd * U.normInv(U.clamp(kp, 0.02, 0.98)) - g.ls.margin) / g.ls.tau;
        const smc = U.clamp(sm, g.pre.spread - 8, g.pre.spread + 8);
        g.sMkt = g.sMkt == null ? smc : g.sMkt * 0.85 + smc * 0.15;
      }
      const tl = mk.filter((m) => m.kind === 'total' && !m.seg && m.th).map((m) => ({ line: m.th.line, p: MODEL.mid(m) }));
      if (quiet && tl.length && g.ls.rem > 3) {
        const sd = MODEL.SIG_T * Math.sqrt(g.ls.tau);
        let s = 0, w = 0; for (const r of tl) { if (r.p == null || r.p < 0.05 || r.p > 0.95) continue; const mu = r.line + sd * U.normInv(r.p); const wt = r.p * (1 - r.p); s += mu * wt; w += wt; }
        if (w) {
          const rm = U.clamp((s / w - g.ls.total) / g.ls.rem, 3.4, 6.0);
          g.rMkt = g.rMkt == null ? rm : g.rMkt * 0.85 + rm * 0.15;
        }
      }
    }
    g.sEff = g.sMkt != null ? 0.5 * g.pre.spread + 0.5 * g.sMkt : g.pre.spread;
    g.tEff = g.pre.total;
    g.wp = g.state === 'pre' ? g.pre.pHome : MODEL.pHomeWin(g.ls, g.sEff);
    if (g.state === 'in') computeRun(g);
  }

  // ---------- loops ----------
  function every(ms, fn, gen) {
    const run = async () => {
      if (gen !== STATE.gen) return;
      const t0 = Date.now();
      try { if (!document.hidden) await fn(); } catch (e) { console.warn(e); }
      if (gen !== STATE.gen) return;
      const d = typeof ms === 'function' ? ms() : ms;
      timers.push(setTimeout(run, Math.max(50, d - (Date.now() - t0))));
    };
    run();
  }
  const anyLive = () => STATE.list.some((g) => g.state === 'in' || (g.state === 'pre' && g.date - Date.now() < 5 * 60e3 && g.date - Date.now() > -30 * 60e3));
  const soon = () => STATE.list.some((g) => g.state === 'pre' && g.date - Date.now() < 3 * 3600e3);

  async function pollScores() {
    const keys = [...new Set([STATE.todayKey, STATE.dateKey])];
    const res = await Promise.allSettled(keys.map((k) => ESPN.scoreboard(k)));
    let ok = false;
    for (const r of res) if (r.status === 'fulfilled') { mergeEspn(r.value); ok = true; }
    if (ok) { resort(); STATE.loaded = true; }
    return ok;
  }
  async function pollNba() {
    const sb = await NBA.scoreboard();
    mergeNba(sb);
  }

  async function pollFocus() {
    const g = STATE.focus && STATE.games.get(STATE.focus);
    if (!g) return;
    const live = g.state === 'in';
    const tasks = [];
    if (live || g.state === 'post') {
      if (g.nbaId && (!g._boxAt || Date.now() - g._boxAt > (live ? 2000 : 30000))) {
        g._boxAt = Date.now();
        tasks.push(NBA.box(g.nbaId).then((b) => setBox(g, b, 'nba')).catch(() => { g._boxFail = (g._boxFail || 0) + 1; }));
      }
      if (g.nbaId && (!g._pbpAt || Date.now() - g._pbpAt > (live ? 3000 : 60000))) {
        g._pbpAt = Date.now();
        tasks.push(NBA.pbp(g.nbaId).then((a) => setPbp(g, a)).catch(() => { }));
      }
    }
    const rec = INTEL.get(g.id);
    const propsWaiting = rec && !rec.loading && rec.players.size === 0 && Date.now() - (g._intelAt || 0) > 5000 && KALSHI.marketsFor(g.kkey).some((m) => m.kind === 'prop');
    if (!rec || propsWaiting || Date.now() - (g._intelAt || 0) > (live ? 15000 : 90000)) {
      g._intelAt = Date.now();
      tasks.push(INTEL.ensure(g, { props: true, focus: true }).then((r) => {
        if ((!g.nbaId || (g._boxFail || 0) > 2) && r.summary?.box?.length && g.state !== 'pre') setBox(g, { players: r.summary.box, at: Date.now() }, 'espn');
        if (!g.hasPbp && r.summary?.plays?.length) seedFromEspnPlays(g, r.summary.plays);
      }));
    } else if (rec && Date.now() - rec.projAt > 30000) INTEL.project(g, rec);
    await Promise.all(tasks);
  }

  function setBox(g, b, src) {
    if (!b) return;
    const rec = INTEL.get(g.id);
    const byEspn = new Map();
    for (const p of b.players) {
      if (src === 'espn') { byEspn.set(p.espnId, p); continue; }
      let id = null;
      if (rec) {
        for (const q of rec.players.values()) if (U.nameScore(q.name, p.name) >= 0.9) { id = q.espnId; break; }
        if (!id) for (const side of ['home', 'away']) for (const q of rec.rosters[side] || []) if (!id && U.nameScore(q.name, p.name) >= 0.9) id = q.espnId;
      }
      if (id) { p.espnId = id; byEspn.set(id, p); }
    }
    // remember when each player's stats last changed (drives per-prop stale-quote detection)
    const prev = STATE.box.get(g.id);
    if (prev) {
      const now = Date.now();
      for (const [id, p] of byEspn) {
        const o = prev.byEspn.get(id); if (!o) continue;
        for (const k of ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk']) if ((p[k] || 0) > (o[k] || 0)) STATE.statAt.set(`${id}:${k}`, now);
      }
    }
    STATE.box.set(g.id, { players: b.players, byEspn, at: Date.now(), src });
  }
  function setPbp(g, acts) {
    if (!acts) return;
    g.hasPbp = true;
    const shots = [];
    let poss = null;
    for (const a of acts) {
      if (a.shot && a.x != null && a.y != null) {
        const side = a.team === g.home.code ? 'home' : a.team === g.away.code ? 'away' : null;
        if (side) { const p = COURT.mapShot(side, { src: 'nba', x: a.x, y: a.y }); shots.push({ ...p, side, made: a.made, t: a.ts || Date.now() }); }
      }
    }
    const last = acts[acts.length - 1];
    if (last?.poss) { const tid = String(last.poss); poss = acts.find((a) => String(a.teamId) === tid)?.team; }
    g.poss = poss ? (poss === g.home.code ? 'home' : 'away') : null;
    g.shots = shots.slice(-200);
    // reconstruct scoring events for momentum
    const ev = []; let ph = 0, pa = 0;
    for (const a of acts) {
      if (a.hs == null || a.as == null) continue;
      const el = U.minutesElapsed(a.period, a.clockSec ?? 0);
      if (a.hs > ph) ev.push({ t: a.ts || 0, side: 'home', pts: a.hs - ph, el });
      if (a.as > pa) ev.push({ t: a.ts || 0, side: 'away', pts: a.as - pa, el });
      ph = Math.max(ph, a.hs); pa = Math.max(pa, a.as);
    }
    if (ev.length) { g.events = ev.slice(-200); computeRun(g); }
  }
  function seedFromEspnPlays(g, plays) {
    if (g._seeded) return; g._seeded = true;
    const ev = []; let ph = 0, pa = 0; const shots = [];
    for (const p of plays) {
      if (p.hs == null) continue;
      const el = U.minutesElapsed(p.period, p.clockSec ?? 0);
      if (p.hs > ph) ev.push({ t: 0, side: 'home', pts: p.hs - ph, el });
      if (p.as > pa) ev.push({ t: 0, side: 'away', pts: p.as - pa, el });
      ph = Math.max(ph, p.hs); pa = Math.max(pa, p.as);
      if (p.x != null && p.y != null && /shot|jumper|layup|dunk|three|hook|tip/i.test(p.type + ' ' + p.text) && p.x >= 0 && p.x <= 50) {
        const side = p.teamId === g.home.id ? 'home' : p.teamId === g.away.id ? 'away' : null;
        if (side) shots.push({ ...COURT.mapShot(side, { src: 'espn', x: p.x, y: p.y }), side, made: /makes/i.test(p.text), t: Date.now() - 60e3 });
      }
    }
    if (ev.length) { g.events = ev.slice(-200); computeRun(g); }
    if (shots.length && !g.shots.length) g.shots = shots.slice(-200);
  }

  // background: deep data + boxes for games that matter soon, so the ticker can include props
  let bgBusy = false;
  async function background() {
    if (bgBusy) return; bgBusy = true;
    try {
      const cands = STATE.list.filter((g) => g.state === 'in' || (g.state === 'pre' && g.date - Date.now() < 6 * 3600e3));
      for (const g of cands) {
        if (g.id === STATE.focus) continue;
        const rec = INTEL.get(g.id);
        const hasProps = KALSHI.marketsFor(g.kkey).some((m) => m.kind === 'prop');
        const needProps = hasProps && rec && !rec.loading && rec.players.size === 0 && Date.now() - (g._bgAt || 0) > 10000;
        if (!rec || needProps || Date.now() - (g._bgAt || 0) > (g.state === 'in' ? 60000 : 300000)) {
          g._bgAt = Date.now();
          await INTEL.ensure(g, { props: hasProps });
          break; // one game per cycle to stay gentle
        }
        if (g.state === 'in' && g.nbaId && hasProps && (!g._boxAt || Date.now() - g._boxAt > 8000)) {
          g._boxAt = Date.now();
          await NBA.box(g.nbaId).then((b) => setBox(g, b, 'nba')).catch(() => { });
        }
      }
    } finally { bgBusy = false; }
  }

  let evalAt = new Map();
  function evaluateAll() {
    const now = Date.now();
    for (const g of STATE.list) {
      derive(g);
      const fast = g.id === STATE.focus || g.state === 'in';
      if (!evalAt.get(g.id) || now - evalAt.get(g.id) > (fast ? 900 : 4000)) {
        evalAt.set(g.id, now);
        if (KALSHI.hasGame(g.kkey)) g.eval = PICKS.evaluate(g);
      }
    }
  }

  function uiTick() {
    evaluateAll();
    UI.renderGames();
    UI.renderTicker();
    UI.updateFinder(false);
    UI.renderFeeds();
  }

  async function boot() {
    STATE.gen++;
    const gen = STATE.gen;
    timers.forEach(clearTimeout); timers.length = 0;
    STATE.games.clear(); STATE.list = []; STATE.box.clear(); STATE.statAt.clear(); STATE.loaded = false;
    STATE.todayKey = U.etDateKey();
    if (!STATE.dateKey || STATE.dateKey < STATE.todayKey) STATE.dateKey = STATE.todayKey;
    STATE.dates = Array.from({ length: 7 }, (_, i) => U.addDaysKey(STATE.todayKey, i));
    UI.renderDates();
    UI.renderGames();
    const first = await Promise.allSettled([pollScores(), pollNba()]);
    if (gen !== STATE.gen) return;
    const espnOk = first[0].status === 'fulfilled' && first[0].value;
    if (!espnOk && !NET.isDemo()) {
      if (inArtifact()) { startDemo(true); return; }
      UI.banner(`<b>Can't reach the live feeds from this page.</b> ESPN: ${U.esc(NET.health('espn').err || 'blocked')}. Host this app on Vercel or Netlify (the included config proxies ESPN, NBA and Kalshi), add a proxy in Settings, or <button class="gel" id="bDemo">run the demo simulation</button>.`, 'warn');
      document.getElementById('bDemo')?.addEventListener('click', () => startDemo());
    }
    resort();
    UI.renderGames();
    KALSHI.discover().catch(() => { });
    every(() => (anyLive() ? 1000 : 15000), pollScores, gen);
    every(() => (anyLive() ? 1000 : 30000), () => pollNba().catch(() => { }), gen);
    every(250, () => { const f = STATE.focus && STATE.games.get(STATE.focus); KALSHI.tick({ anyLive: anyLive(), soon: soon(), focusKey: f?.kkey, focusLive: f?.state === 'in' }); }, gen);
    every(1000, pollFocus, gen);
    every(3000, background, gen);
    every(500, uiTick, gen);
    route();
  }

  function startDemo(auto) {
    NET.setDemo(true);
    UI.banner(`<b>Demo simulation</b> — real teams and arenas, fictional players, simulated scores and Kalshi-style prices with deliberate lag.${auto ? ' claude.ai blocks live sports data inside artifacts; open the hosted app for real ESPN, NBA and Kalshi feeds.' : ''} <button class="gel" id="bLive">Try live feeds</button>`, 'demo');
    document.getElementById('bLive')?.addEventListener('click', startLive);
    boot();
  }
  function startLive() { NET.setDemo(false); UI.banner(''); boot(); }

  function route() {
    const m = location.hash.match(/^#game-(\d+)/);
    if (m) { if (!UI.openFinder(m[1])) setTimeout(route, 600); }
    else UI.closeFinder();
  }

  function focus(id) {
    STATE.focus = id;
    if (id) { const g = STATE.games.get(id); if (g) { g._intelAt = 0; pollFocus(); } }
  }
  function setDate(k) { STATE.dateKey = k; UI.renderDates(); pollScores().then(() => { resort(); UI.renderGames(); }); UI.renderGames(); }

  function start() {
    if (running) return; running = true;
    if (/debug/.test(location.hash)) window.__CE = { STATE, KALSHI, PICKS, MODEL, INTEL, NET, U };
    UI.init();
    document.fonts?.ready?.then(() => COURT.invalidate());
    window.addEventListener('hashchange', route);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && STATE.loaded) { pollScores(); pollNba().catch(() => { }); } });
    if (/demo/.test(location.hash) || new URLSearchParams(location.search).has('demo')) startDemo();
    else boot();
  }

  return { start, focus, setDate, startDemo, startLive, restart: boot };
})();
