/* ============================================================
   intel.js — per-game deep data: summary (injuries, H2H, last 5,
   predictor, book lines), rosters, game logs (2 seasons), and
   player projections with full context
   ============================================================ */

const INTEL = (() => {
  const C = new Map();          // gameId → intel record
  const LOGS = new Map();       // `${espnId}:${season}` → rows
  const ROSTERS = new Map();    // teamId → roster
  let standingsAt = 0, standingsP = null;
  const posGroup = (p) => (/C/.test(p) && !/F/.test(p) ? 'C' : /G/.test(p) ? 'G' : /F/.test(p) ? 'F' : /C/.test(p) ? 'C' : '');

  async function standings() {
    if (STATE.standings && Date.now() - standingsAt < 30 * 60e3) return STATE.standings;
    if (!standingsP) {
      standingsP = ESPN.standings().then((s) => { STATE.standings = s; standingsAt = Date.now(); return s; }).catch(() => STATE.standings).finally(() => { standingsP = null; });
    }
    return standingsP;
  }
  async function roster(teamId) {
    if (ROSTERS.has(teamId)) return ROSTERS.get(teamId);
    const key = 'roster:' + teamId;
    const c = !NET.isDemo() && U.store.get(key);
    if (c && Date.now() - c.t < 12 * 3600e3) { ROSTERS.set(teamId, c.r); return c.r; }
    const r = await ESPN.roster(teamId).catch(() => []);
    ROSTERS.set(teamId, r);
    if (!NET.isDemo() && r.length) U.store.set(key, { t: Date.now(), r });
    return r;
  }
  async function logs(espnId, season, current) {
    const k = `${espnId}:${season}`;
    if (LOGS.has(k)) return LOGS.get(k);
    const sk = 'gl:' + k;
    const c = !NET.isDemo() && U.store.get(sk);
    const ttl = current ? 3 * 3600e3 : 5 * 864e5;
    if (c && Date.now() - c.t < ttl) { LOGS.set(k, c.r); return c.r; }
    const r = await ESPN.gamelog(espnId, season).catch(() => []);
    LOGS.set(k, r);
    if (!NET.isDemo() && r.length) {
      // compact form for storage
      const slim = r.map(({ eventId, date, opp, home, result, season: s, post, min, pts, reb, ast, fg3m, fg3a, stl, blk, tov, pf }) => ({ eventId, date, opp, home, result, season: s, post, min, pts, reb, ast, fg3m, fg3a, stl, blk, tov, pf }));
      if (!U.store.set(sk, { t: Date.now(), r: slim })) { // storage full → evict old gamelogs
        try { Object.keys(localStorage).filter((x) => x.startsWith('ce:gl:')).slice(0, 40).forEach((x) => localStorage.removeItem(x)); } catch { }
      }
    }
    return r;
  }
  async function playerLogs(espnId, season) {
    const [a, b] = await Promise.all([logs(espnId, season, true), logs(espnId, season - 1, false)]);
    return [...a, ...b].sort((x, y) => y.date - x.date);
  }

  function get(id) { return C.get(id); }

  // match a name to roster entries on either team
  function matchPlayer(name, rosters) {
    let best = null, bs = 0;
    for (const side of ['home', 'away']) for (const p of rosters[side] || []) {
      const s = U.nameScore(name, p.name);
      if (s > bs) { bs = s; best = { ...p, side }; }
    }
    return bs >= 0.8 ? best : null;
  }

  /**
   * Ensure deep data for a game. opts.props: load player logs. Returns the record.
   */
  async function ensure(g, opts = {}) {
    let rec = C.get(g.id);
    if (!rec) { rec = { id: g.id, summary: null, sumAt: 0, rosters: { home: [], away: [] }, players: new Map(), projAt: 0, loading: false, err: '' }; C.set(g.id, rec); }
    const live = g.state === 'in';
    const sumTTL = live ? (opts.focus ? 12000 : 45000) : 180000;
    const tasks = [];
    if (Date.now() - rec.sumAt > sumTTL) {
      rec.sumAt = Date.now();
      tasks.push(ESPN.summary(g.id, g).then((s) => { if (s) rec.summary = s; }).catch((e) => { rec.err = e.message; rec.sumAt = Date.now() - sumTTL + 8000; }));
    }
    tasks.push(standings());
    if (!rec.rosters.home.length) tasks.push(roster(g.home.id).then((r) => (rec.rosters.home = r)));
    if (!rec.rosters.away.length) tasks.push(roster(g.away.id).then((r) => (rec.rosters.away = r)));
    await Promise.all(tasks);
    if (opts.props && !rec.loading) {
      rec.loading = true;
      try { await loadPlayers(g, rec); } finally { rec.loading = false; }
    }
    return rec;
  }

  function injuriesFor(rec, g, side) {
    const tid = g[side].id;
    const list = rec.summary?.injuries?.[tid] || [];
    const fromRoster = (rec.rosters[side] || []).filter((p) => p.inj).map((p) => ({ espnId: p.espnId, name: p.name, pos: p.pos, status: p.inj, detail: '' }));
    const m = new Map();
    for (const x of [...fromRoster, ...list]) m.set(x.espnId || x.name, x);
    return [...m.values()];
  }

  async function loadPlayers(g, rec) {
    const season = U.seasonFor(g.dateKey);
    const mk = KALSHI.marketsFor(g.kkey).filter((m) => m.kind === 'prop' && m.player);
    const want = new Map();
    for (const m of mk) {
      const p = matchPlayer(m.player, rec.rosters);
      if (p) { want.set(p.espnId, p); m.espnId = p.espnId; m.pside = p.side; }
    }
    // if no tradable props yet, project each team's leaders so the screen still shows fair lines
    if (want.size < 4) {
      for (const side of ['home', 'away']) {
        const L = rec.summary?.leaders?.[g[side].id] || {};
        for (const cat of ['points', 'rebounds', 'assists']) for (const l of (L[cat] || []).slice(0, 2)) {
          const r = (rec.rosters[side] || []).find((p) => p.espnId === l.espnId) || { espnId: l.espnId, name: l.name, pos: '' };
          if (r.espnId) want.set(r.espnId, { ...r, side });
        }
      }
    }
    const outs = { home: injuriesFor(rec, g, 'home').filter((x) => /^out/i.test(x.status)), away: injuriesFor(rec, g, 'away').filter((x) => /^out/i.test(x.status)) };
    // logs for prop players
    const ids = [...want.keys()].filter((id) => !rec.players.has(id) || Date.now() - rec.players.get(id).at > 3 * 3600e3);
    for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(async (id) => { rec.players.set(id, { ...want.get(id), logs: await playerLogs(id, season), at: Date.now() }); }));
    // logs for OUT players (with/without splits) — up to 4 per team
    rec.outLogs = rec.outLogs || new Map();
    for (const side of ['home', 'away']) for (const o of outs[side].slice(0, 4)) {
      if (o.espnId && !rec.outLogs.has(o.espnId)) rec.outLogs.set(o.espnId, { ...o, side, logs: await playerLogs(o.espnId, season) });
    }
    project(g, rec);
  }

  function teamAvgPts(teamId) {
    const st = STATE.standings, t = st?.teams?.[teamId];
    const lg = st?.lgPts || 114.5;
    if (!t?.pf) return lg;
    return (t.gp * t.pf + 6 * lg) / (t.gp + 6);
  }

  function project(g, rec) {
    const season = U.seasonFor(g.dateKey);
    const pre = g.pre || MODEL.pregame(g, rec.summary, KALSHI.marketsFor(g.kkey));
    const outs = { home: [], away: [] };
    for (const o of rec.outLogs?.values() || []) outs[o.side].push(o);
    const yday = U.addDaysKey(g.dateKey, -1);
    for (const [id, p] of rec.players) {
      const side = p.side, team = g[side], opp = g[side === 'home' ? 'away' : 'home'];
      const spreadTeam = side === 'home' ? pre.spread : -pre.spread;
      const impliedPts = (pre.total + spreadTeam) / 2;
      const avg = teamAvgPts(team.id);
      const env = U.clamp(impliedPts / avg, 0.85, 1.15);
      const lastDate = p.logs[0]?.date;
      const b2b = !!lastDate && U.etDateKey(new Date(lastDate)) === yday;
      const inj = injuriesFor(rec, g, side).find((x) => x.espnId === id || U.nameScore(x.name, p.name) >= 0.95);
      const ctx = { season, opp: opp.code, home: side === 'home', teamCode: team.code, env, impliedPts, teamAvgPts: avg, spreadTeam, b2b, outMates: outs[side].filter((o) => o.espnId !== id), status: inj?.status || '' };
      p.ctx = ctx;
      p.status = inj?.status || '';
      p.proj = MODEL.projectPlayer(p.logs, ctx);
      p.splits = splits(p.logs, season);
    }
    // estimated primary matchup: same position group on the other team, most projected minutes
    for (const [, p] of rec.players) {
      const grp = posGroup(p.pos);
      const oppSide = p.side === 'home' ? 'away' : 'home';
      const cands = [...rec.players.values()].filter((q) => q.side === oppSide && posGroup(q.pos) === grp && q.proj);
      cands.sort((a, b) => b.proj.minProj - a.proj.minProj);
      const ro = (rec.rosters[oppSide] || []).find((q) => posGroup(q.pos) === grp && !outs[oppSide].some((o) => o.espnId === q.espnId));
      p.matchup = cands[0] ? { name: cands[0].name, pos: cands[0].pos, est: true } : ro ? { name: ro.name, pos: ro.pos, est: true } : null;
    }
    rec.projAt = Date.now();
  }

  function splits(rows, season) {
    const st = STATE.standings;
    const defRank = (code) => { const t = Object.values(st?.teams || {}).find((x) => TEAMS.toCode(x.abbr) === code); return t?.defRank; };
    const g = rows.filter((r) => r.min >= 4).slice(0, 60);
    const grp = (f) => { const a = g.filter(f); return a.length ? { n: a.length, pts: U.mean(a.map((r) => r.pts)), reb: U.mean(a.map((r) => r.reb)), ast: U.mean(a.map((r) => r.ast)), fg3m: U.mean(a.map((r) => r.fg3m)), min: U.mean(a.map((r) => r.min)) } : null; };
    const dates = g.map((r) => r.date);
    const rest = (i) => (i + 1 < dates.length ? (dates[i] - dates[i + 1]) / 864e5 : 9);
    return {
      home: grp((r) => r.home === true), away: grp((r) => r.home === false),
      win: grp((r) => r.result === 'W'), loss: grp((r) => r.result === 'L'),
      topD: grp((r) => (defRank(r.opp) || 99) <= 10), botD: grp((r) => (defRank(r.opp) || 0) >= 21),
      b2b: grp((r) => rest(g.indexOf(r)) < 1.6), rested: grp((r) => rest(g.indexOf(r)) >= 1.6),
      cur: grp((r) => r.season === season), prev: grp((r) => r.season === season - 1),
    };
  }

  return { ensure, get, project, injuriesFor, matchPlayer, teamAvgPts, posGroup };
})();
