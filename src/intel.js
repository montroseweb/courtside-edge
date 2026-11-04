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
    const sk = 'gl2:' + k;
    const c = !NET.isDemo() && U.store.get(sk);
    const ttl = current ? 3 * 3600e3 : 5 * 864e5;
    if (c && Date.now() - c.t < ttl) { LOGS.set(k, c.r); return c.r; }
    const r = await ESPN.gamelog(espnId, season).catch(() => []);
    LOGS.set(k, r);
    if (!NET.isDemo() && r.length) {
      // compact form for storage
      const slim = r.map(({ eventId, date, opp, home, result, season: s, post, min, pts, reb, ast, fg3m, fg3a, fga, fta, stl, blk, tov, pf }) => ({ eventId, date, opp, home, result, season: s, post, min, pts, reb, ast, fg3m, fg3a, fga, fta, stl, blk, tov, pf }));
      if (!U.store.set(sk, { t: Date.now(), r: slim })) { // storage full → evict old gamelogs
        try { Object.keys(localStorage).filter((x) => x.startsWith('ce:gl')).slice(0, 40).forEach((x) => localStorage.removeItem(x)); } catch { }
      }
    }
    return r;
  }
  // ---------- team pace / efficiency ----------
  const PACE = new Map(); // teamId → {pace, ...} | null
  async function teamPace(teamId) {
    if (PACE.has(teamId)) return PACE.get(teamId);
    const c = !NET.isDemo() && U.store.get('pace:' + teamId);
    if (c && Date.now() - c.t < 12 * 3600e3) { PACE.set(teamId, c.v); return c.v; }
    const v = await ESPN.teamStats(teamId).catch(() => null);
    PACE.set(teamId, v);
    if (!NET.isDemo() && v) U.store.set('pace:' + teamId, { t: Date.now(), v });
    return v;
  }
  const LG_PACE = 99.5, LG_PPP = 1.145;
  function lgPace() { const xs = [...PACE.values()].filter(Boolean).map((v) => v.pace); return (U.sum(xs) + LG_PACE * 4) / (xs.length + 4); }
  // possessions/game from the team stats feed, else estimated from scoring; ratings per 100 possessions
  function teamMetrics(teamId) {
    const st = STATE.standings, t = st?.teams?.[teamId], lgPts = st?.lgPts || 114.5;
    const shrink = (v, prior) => (t?.gp ? (t.gp * v + 6 * prior) / (t.gp + 6) : prior);
    const pf = t?.pf ? shrink(t.pf, lgPts) : lgPts, pa = t?.pa ? shrink(t.pa, lgPts) : lgPts;
    const fed = PACE.get(teamId);
    const lp = lgPace();
    const pace = fed?.pace ? shrink(fed.pace, lp) : U.clamp(((pf + pa) / 2) / LG_PPP, 94, 106);
    return { pace, src: fed?.pace ? 'team stats feed: FGA + 0.44·FTA − OREB + TOV' : 'estimated from scoring; team stats feed unavailable', ortg: pf / pace * 100, drtg: pa / pace * 100, pf, pa, offRank: t?.offRank, defRank: t?.defRank, gp: t?.gp || 0 };
  }
  function possModel(g) {
    const h = teamMetrics(g.home.id), a = teamMetrics(g.away.id), lp = lgPace();
    const lgRtg = (STATE.standings?.lgPts || 114.5) / lp * 100;
    return { poss: h.pace * a.pace / lp, paceH: h.pace, paceA: a.pace, lgPace: lp, lgRtg, h, a, src: h.src };
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
    tasks.push(teamPace(g.home.id), teamPace(g.away.id));
    if (!rec.rosters.home.length) tasks.push(roster(g.home.id).then((r) => (rec.rosters.home = r)));
    if (!rec.rosters.away.length) tasks.push(roster(g.away.id).then((r) => (rec.rosters.away = r)));
    await Promise.all(tasks);
    if (opts.props && !rec.loading) {
      rec.loading = true;
      try { await loadPlayers(g, rec); } finally { rec.loading = false; }
    }
    return rec;
  }

  // ---------- Phase 1: roster/injury verification (official game report only) ----------
  function normStatus(raw, detail) {
    const s = String(raw || '').toLowerCase(), t = s + ' ' + String(detail || '').toLowerCase();
    if (/doubt/.test(s)) return 'DOUBTFUL';
    if (/question|day-to-day|day to day|dtd|game.?time/.test(s)) return /minute|restrict/.test(t) ? 'MINUTES RESTRICTION' : 'QUESTIONABLE';
    if (/probable/.test(s)) return 'PROBABLE';
    if (/out|suspen|inactive|injured reserve/.test(s)) return 'OUT';
    if (/minute|restrict/.test(t)) return 'MINUTES RESTRICTION';
    return 'LISTED';
  }
  const reportLoaded = (rec) => !!rec?.summary && rec.summary.injuries != null;
  function injuriesFor(rec, g, side) {
    const list = rec?.summary?.injuries?.[g[side].id] || [];
    return list.map((x) => ({ ...x, code: normStatus(x.status, x.detail) }));
  }
  function statusFor(rec, g, side, espnId, name) {
    const box = STATE.box.get(g.id);
    const lb = box && (box.byEspn?.get(espnId) || box.players.find((x) => U.nameScore(x.name, name) >= 0.9));
    if (lb && (lb.min > 0 || lb.oncourt || lb.played)) return { code: 'ACTIVE', ok: true, src: 'in tonight\'s live box score' };
    if (!reportLoaded(rec)) return { code: 'UNVERIFIED', ok: false, src: 'game-day injury report not loaded yet' };
    const r = injuriesFor(rec, g, side).find((x) => x.espnId === espnId || U.nameScore(x.name, name) >= 0.95);
    if (r) return { code: r.code, ok: !/OUT|DOUBTFUL|LISTED/.test(r.code), src: 'official game-day injury report', raw: r.status, detail: r.detail };
    const ro = (rec.rosters[side] || []).find((x) => x.espnId === espnId);
    if (ro?.inj && /out|doubt/i.test(ro.inj)) return { code: 'CONFLICT', ok: false, src: `roster feed says "${ro.inj}" but the game report does not list him — props benched` };
    return { code: 'ACTIVE', ok: true, src: 'not on the game-day injury report' };
  }
  // play-probability for a player's own prop (DNP risk on non-protected markets)
  const PLAY_P = { ACTIVE: 1, PROBABLE: 0.97, QUESTIONABLE: 0.82, 'MINUTES RESTRICTION': 1 };
  function reportSummary(rec, g, side) {
    if (!reportLoaded(rec)) return `${g[side].abbr}: report not loaded`;
    const l = injuriesFor(rec, g, side);
    return `${g[side].abbr}: ${l.length ? l.map((x) => `${x.name} ${x.code}`).join(', ') : 'no designations'}`;
  }

  // ---------- Phase 2.3: schedule / travel fatigue matrix ----------
  function fatigue(rec, g, side) {
    const out = { known: false, minF: 1, effF: 1, marginPts: 0, flags: [] };
    const l5 = (rec?.summary?.lastFive?.[g[side].id] || []).filter((e) => e.date && e.date < g.date - 3 * 3600e3).sort((a, b) => b.date - a.date);
    if (!l5.length) return out;
    out.known = true;
    const tk = U.etDateKey(new Date(g.date));
    const dd = (ms) => { const k = U.etDateKey(new Date(ms)); return Math.round((Date.UTC(+tk.slice(0, 4), +tk.slice(4, 6) - 1, +tk.slice(6, 8)) - Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8))) / 864e5); };
    const venue = TEAMS.byCode[g.home.code], me = TEAMS.byCode[g[side].code];
    const last = l5[0], since = dd(last.date);
    const lastVenue = last.atVs === '@' ? TEAMS.find(last.opp) : me;
    const in4 = l5.filter((e) => dd(e.date) <= 3).length + 1;
    const road7 = l5.filter((e) => dd(e.date) <= 6 && e.atVs === '@').length + (side === 'away' ? 1 : 0);
    const tz = Math.abs((venue?.tz ?? -5) - (lastVenue?.tz ?? -5));
    const add = (t, minF, effF, pts) => { out.minF *= minF; out.effF *= effF; out.marginPts += pts; out.flags.push(t); };
    if (since === 1) add('2nd night of a back-to-back (minutes ×0.965, shooting eff ×0.980, −1.5 pts margin)', 0.965, 0.98, -1.5);
    if (in4 >= 3) add(`${in4 === 3 ? "3rd" : in4 + "th"} game in 4 nights (minutes ×0.985, eff ×0.990, −0.8 pts)`, 0.985, 0.99, -0.8);
    if (road7 >= 5) add(`${road7}th road game in 7 nights (eff ×0.990, −0.6 pts)`, 1, 0.99, -0.6);
    if (tz >= 2 && since <= 1) add(`${tz} time zones crossed in ≤24h (eff ×${tz >= 3 ? '0.985' : '0.990'}, −0.5 pts)`, 1, tz >= 3 ? 0.985 : 0.99, -0.5);
    if (venue?.elev >= 4000 && g[side].code !== g.home.code) add(`visiting altitude ${venue.elev.toLocaleString()} ft (minutes ×0.990, eff ×0.985, −1.0 pts)`, 0.99, 0.985, -1.0);
    if (since >= 3) add(`${since - 1} days rest (+0.3 pts)`, 1, 1, 0.3);
    out.since = since; out.in4 = in4; out.road7 = road7; out.tz = tz;
    return out;
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
    const outs = { home: injuriesFor(rec, g, 'home').filter((x) => /OUT|DOUBTFUL/.test(x.code)), away: injuriesFor(rec, g, 'away').filter((x) => /OUT|DOUBTFUL/.test(x.code)) };
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
    const pm = possModel(g);
    rec.poss = pm;
    rec.fat = { home: fatigue(rec, g, 'home'), away: fatigue(rec, g, 'away') };
    const outs = { home: [], away: [] };
    for (const o of rec.outLogs?.values() || []) {
      const live = injuriesFor(rec, g, o.side).find((x) => x.espnId === o.espnId);
      if (live && /OUT|DOUBTFUL/.test(live.code)) outs[o.side].push({ ...o, w: live.code === 'OUT' ? 1 : 0.75, code: live.code });
    }
    for (const [id, p] of rec.players) {
      const side = p.side, team = g[side], opp = g[side === 'home' ? 'away' : 'home'];
      const spreadTeam = side === 'home' ? pre.spread : -pre.spread;
      const impliedPts = (pre.total + spreadTeam) / 2;
      const avg = teamAvgPts(team.id);
      const hasMkt = pre.src.bookTotal != null || pre.src.kalshiTotal != null;
      const teamPaceV = side === 'home' ? pm.paceH : pm.paceA;
      const oppM = side === 'home' ? pm.a : pm.h;
      const paceF = U.clamp(pm.poss / teamPaceV, 0.9, 1.1);
      const defF = U.clamp(oppM.drtg / pm.lgRtg, 0.9, 1.1);
      const marketF = hasMkt ? U.clamp(impliedPts / avg, 0.85, 1.15) : null;
      const st = statusFor(rec, g, side, id, p.name);
      const ctx = { season, opp: opp.code, home: side === 'home', teamCode: team.code, impliedPts, teamAvgPts: avg, spreadTeam, paceF, defF, marketF, poss: pm.poss, teamPace: teamPaceV, oppDrtg: oppM.drtg, oppDefRank: oppM.defRank, lgRtg: pm.lgRtg, fat: rec.fat[side], outMates: outs[side].filter((o) => o.espnId !== id), status: st.code };
      p.ctx = ctx;
      p.st = st;
      p.status = st.code === 'ACTIVE' ? '' : st.code;
      p.proj = MODEL.projectPlayer(p.logs, ctx);
      p.splits = splits(p.logs, season);
    }
    // estimated primary defender: same position group on the other team, most projected minutes; per-36 defensive events
    const per36 = (q, k) => { const gm = (q.logs || []).filter((r) => r.min >= 4).slice(0, 20); const m = U.sum(gm.map((r) => r.min)); return m ? U.sum(gm.map((r) => r[k] || 0)) / m * 36 : null; };
    for (const [, p] of rec.players) {
      const grp = posGroup(p.pos);
      const oppSide = p.side === 'home' ? 'away' : 'home';
      const cands = [...rec.players.values()].filter((q) => q.side === oppSide && posGroup(q.pos) === grp && q.proj && q.st?.ok !== false);
      cands.sort((a, b) => b.proj.minProj - a.proj.minProj);
      const ro = (rec.rosters[oppSide] || []).find((q) => posGroup(q.pos) === grp && !outs[oppSide].some((o) => o.espnId === q.espnId));
      const d = cands[0];
      p.matchup = d ? { name: d.name, pos: d.pos, est: true, min: d.proj.minProj, stl36: per36(d, 'stl'), blk36: per36(d, 'blk'), pf36: per36(d, 'pf'), n: Math.min(20, d.proj.games.length) } : ro ? { name: ro.name, pos: ro.pos, est: true } : null;
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

  return { ensure, get, project, injuriesFor, statusFor, reportSummary, reportLoaded, fatigue, possModel, teamMetrics, PLAY_P, matchPlayer, teamAvgPts, posGroup };
})();
