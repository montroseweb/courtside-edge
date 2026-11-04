/* ============================================================
   scout.js — matchup scouting from each team's last completed
   games (ESPN summaries): actual possessions by venue, transition
   and paint points, defense vs position, shot-zone and shot-type
   defense, and every player's own shot profile. All factors are
   relative to the opponent's own average and shrunk by sample size
   so they never double-count the team defensive rating.
   ============================================================ */

const SCOUT = (() => {
  const P = '/apis/site/v2/sports/basketball/nba';
  const MEM = new Map(), LOADING = new Map();
  const ZONES = ['rim', 'paint', 'mid', 'c3', 'ab3'], TYPES = ['cs', 'od', 'drive', 'cut', 'post'];
  // league baselines (self-calibrated below as teams are scouted)
  const LG = {
    zoneFG: { rim: 0.655, paint: 0.445, mid: 0.415, c3: 0.385, ab3: 0.355 },
    typeEFG: { cs: 0.56, od: 0.47, drive: 0.54, cut: 0.68, post: 0.48 },
    fb: 14.5, paint: 49,
    dvp: { G: { pts: 47, reb: 13, ast: 13, fg3m: 6.5 }, F: { pts: 41, reb: 17, ast: 8, fg3m: 4.5 }, C: { pts: 20, reb: 13, ast: 4, fg3m: 0.8 } },
  };
  const DEF_SHARE = { G: { rim: 0.2, paint: 0.1, mid: 0.12, c3: 0.12, ab3: 0.46 }, F: { rim: 0.27, paint: 0.13, mid: 0.12, c3: 0.14, ab3: 0.34 }, C: { rim: 0.55, paint: 0.22, mid: 0.1, c3: 0.04, ab3: 0.09 } };
  const grp = (pos) => INTEL.posGroup(pos || '') || 'F';

  function classify(p) {
    const text = String(p.text || '').toLowerCase(), type = String(p.type?.text || '').toLowerCase(), t = type + ' ' + text;
    if (/free throw/.test(t)) return null;
    const is3 = /three point|3-pt|3pt/.test(t) || +p.scoreValue === 3;
    const dm = text.match(/(\d+)-foot/); const dist = dm ? +dm[1] : null;
    let x = U.num(p.coordinate?.x), y = U.num(p.coordinate?.y);
    if (x == null || y == null || x < 0 || x > 50 || y < 0 || y > 100) { x = null; y = null; }
    if (y != null && y > 47) y = 94 - y;
    let zone;
    if (is3) zone = /corner/.test(t) || (x != null && (x <= 3.5 || x >= 46.5) && y <= 14) ? 'c3' : 'ab3';
    else if (dist != null) zone = dist <= 4 ? 'rim' : dist <= 9 ? 'paint' : 'mid';
    else if (/layup|dunk|tip|alley|putback|finger roll/.test(t)) zone = 'rim';
    else if (/hook|float|driving/.test(t)) zone = 'paint';
    else zone = 'mid';
    const assisted = /assist/.test(text);
    let st;
    if (/pull ?up|pull-up|step ?back|turnaround|fade|isolation/.test(t)) st = 'od';
    else if (/cutting|alley|putback|tip/.test(t) || (/dunk|layup/.test(t) && assisted)) st = 'cut';
    else if (/driving|float|finger roll/.test(t)) st = 'drive';
    else if (/hook|post/.test(t)) st = 'post';
    else if (/jump|three point|shot/.test(t)) st = assisted ? 'cs' : 'od';
    else st = zone === 'rim' ? 'drive' : 'od';
    const made = /makes|made/.test(text) || !!p.scoringPlay;
    return { zone, st, made, pts: is3 ? 3 : 2 };
  }
  const statMap = (arr) => { const o = {}; for (const x of arr || []) o[x.name || x.label] = x.displayValue ?? x.value; return o; };
  const att = (v) => { const m = String(v ?? '').match(/(\d+)-(\d+)/); return m ? [+m[1], +m[2]] : [null, null]; };
  const nz = (v) => { const n = U.num(v); return n == null ? null : n; };

  function parseGame(j, teamId) {
    const comp = j?.header?.competitions?.[0];
    if (!comp || !/post/.test(comp.status?.type?.state || 'post')) return null;
    const cs = comp.competitors || [];
    const me = cs.find((c) => String(c.team?.id || c.id) === teamId), op = cs.find((c) => String(c.team?.id || c.id) !== teamId);
    if (!me || !op) return null;
    const oppId = String(op.team?.id || op.id);
    const bt = {}; for (const t of j.boxscore?.teams || []) bt[String(t.team?.id)] = statMap(t.statistics);
    const poss = (s) => { if (!s) return null; const [, fga] = att(s['fieldGoalsMade-fieldGoalsAttempted']), [, fta] = att(s['freeThrowsMade-freeThrowsAttempted']); const or = nz(s.offensiveRebounds), to = nz(s.totalTurnovers ?? s.turnovers); return fga != null && fta != null && or != null && to != null ? fga + 0.44 * fta - or + to : null; };
    const pm = poss(bt[teamId]), po = poss(bt[oppId]);
    const g = { date: Date.parse(comp.date) || 0, home: me.homeAway === 'home', oppId, poss: pm != null && po != null ? (pm + po) / 2 : null,
      fbFor: nz(bt[teamId]?.fastBreakPoints), fbAg: nz(bt[oppId]?.fastBreakPoints), paintFor: nz(bt[teamId]?.pointsInPaint), paintAg: nz(bt[oppId]?.pointsInPaint),
      ptsAg: nz(op.score), dvp: {}, allowed: {}, allowedT: {}, own: {} };
    // defense vs position: what the opponent's players produced against this team
    const ix = (st, ...names) => { const ks = st.keys || st.names || []; for (const n of names) { const i = ks.indexOf(n); if (i >= 0) return i; const k = (st.names || []).indexOf(n); if (k >= 0) return k; } return -1; };
    for (const tp of j.boxscore?.players || []) {
      if (String(tp.team?.id) !== oppId) continue;
      for (const st of tp.statistics || []) {
        const iP = ix(st, 'points', 'PTS'), iR = ix(st, 'rebounds', 'totalRebounds', 'REB'), iA = ix(st, 'assists', 'AST'), i3 = ix(st, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', '3PT'), iM = ix(st, 'minutes', 'MIN');
        for (const a of st.athletes || []) {
          const s = a.stats || []; if (!s.length || (U.num(s[iM]) ?? 0) <= 0) continue;
          const G = grp(a.athlete?.position?.abbreviation); const d = g.dvp[G] || (g.dvp[G] = { pts: 0, reb: 0, ast: 0, fg3m: 0 });
          d.pts += U.num(s[iP]) ?? 0; d.reb += U.num(s[iR]) ?? 0; d.ast += U.num(s[iA]) ?? 0; d.fg3m += att(s[i3])[0] ?? 0;
        }
      }
    }
    // shot-zone / shot-type defense (opponent shots) and own players' shot profiles
    for (const p of j.plays || []) {
      if (!p.shootingPlay) continue;
      const c = classify(p); if (!c) continue;
      const tid = String(p.team?.id || '');
      if (tid === oppId) {
        const z = g.allowed[c.zone] || (g.allowed[c.zone] = [0, 0]); z[1]++; if (c.made) z[0]++;
        const t = g.allowedT[c.st] || (g.allowedT[c.st] = [0, 0, 0]); t[1]++; if (c.made) { t[0]++; t[2] += c.pts; }
      } else if (tid === teamId) {
        const aid = String(p.participants?.[0]?.athlete?.id || ''); if (!aid) continue;
        const o = g.own[aid] || (g.own[aid] = { z: {}, t: {}, n: 0 }); o.n++;
        o.z[c.zone] = (o.z[c.zone] || 0) + 1; o.t[c.st] = (o.t[c.st] || 0) + 1;
      }
    }
    return g;
  }

  function aggregate(games) {
    const A = { n: games.length, home: [], road: [], fbFor: [], fbAg: [], paintFor: [], paintAg: [], ptsAg: [], dvp: {}, allowed: {}, allowedT: {}, own: {} };
    for (const g of games) {
      if (g.poss != null) (g.home ? A.home : A.road).push(g.poss);
      for (const k of ['fbFor', 'fbAg', 'paintFor', 'paintAg', 'ptsAg']) if (g[k] != null) A[k].push(g[k]);
      for (const G in g.dvp) { const d = A.dvp[G] || (A.dvp[G] = { pts: 0, reb: 0, ast: 0, fg3m: 0, n: 0 }); d.n++; for (const k of ['pts', 'reb', 'ast', 'fg3m']) d[k] += g.dvp[G][k]; }
      for (const z in g.allowed) { const a = A.allowed[z] || (A.allowed[z] = [0, 0]); a[0] += g.allowed[z][0]; a[1] += g.allowed[z][1]; }
      for (const t in g.allowedT) { const a = A.allowedT[t] || (A.allowedT[t] = [0, 0, 0]); for (let i = 0; i < 3; i++) a[i] += g.allowedT[t][i]; }
      for (const id in g.own) { const o = A.own[id] || (A.own[id] = { z: {}, t: {}, n: 0 }); o.n += g.own[id].n; for (const z in g.own[id].z) o.z[z] = (o.z[z] || 0) + g.own[id].z[z]; for (const t in g.own[id].t) o.t[t] = (o.t[t] || 0) + g.own[id].t[t]; }
    }
    const mean = (a) => (a.length ? U.mean(a) : null);
    A.paceHome = mean(A.home); A.paceRoad = mean(A.road); A.pace = mean([...A.home, ...A.road]);
    for (const k of ['fbFor', 'fbAg', 'paintFor', 'paintAg', 'ptsAg']) A[k] = mean(A[k]);
    return A;
  }

  // self-calibrating league baselines from everything scouted so far
  function lgZone(z) { let m = 0, a = 0; for (const t of MEM.values()) { const x = t.agg.allowed[z]; if (x) { m += x[0]; a += x[1]; } } return (LG.zoneFG[z] * 60 + m) / (60 + a); }
  function lgType(t) { let p = 0, a = 0; for (const s of MEM.values()) { const x = s.agg.allowedT[t]; if (x) { p += x[2] / 2; a += x[1]; } } return (LG.typeEFG[t] * 60 + p) / (60 + a); }

  async function load(teamId, lastFive) {
    const key = 'scout3:' + teamId;
    if (MEM.has(teamId) && Date.now() - MEM.get(teamId).at < 6 * 3600e3) return MEM.get(teamId);
    const c = !NET.isDemo() && U.store.get(key);
    if (c && Date.now() - c.at < 6 * 3600e3) { MEM.set(teamId, c); return c; }
    if (LOADING.has(teamId)) return LOADING.get(teamId);
    const p = (async () => {
      const ids = (lastFive || []).filter((e) => e.id).sort((a, b) => b.date - a.date).slice(0, 4).map((e) => e.id);
      const games = [];
      for (let i = 0; i < ids.length; i += 2) {
        const res = await Promise.allSettled(ids.slice(i, i + 2).map((id) => NET.get('espn', `${P}/summary?event=${id}`)));
        for (const r of res) if (r.status === 'fulfilled') { const g = parseGame(r.value, teamId); if (g) games.push(g); }
      }
      if (!games.length) return null;
      const rec = { at: Date.now(), teamId, agg: aggregate(games) };
      MEM.set(teamId, rec);
      if (!NET.isDemo()) U.store.set(key, rec);
      return rec;
    })().finally(() => LOADING.delete(teamId));
    LOADING.set(teamId, p);
    return p;
  }

  const shrink = (ratio, n, k) => 1 + (ratio - 1) * (n / (n + k));
  /** Factors for one player: {pts, reb, ast, fg3m} multipliers + details for the evidence report. */
  function factors(pl, teamId, oppId) {
    const opp = MEM.get(oppId)?.agg, mine = MEM.get(teamId)?.agg;
    const out = { pts: 1, reb: 1, ast: 1, fg3m: 1, notes: [], have: !!opp };
    if (!opp) return out;
    const G = grp(pl.pos);
    // defense vs position (relative to the opponent's own total allowed, so the team rating isn't double-counted)
    const d = opp.dvp[G];
    if (d?.n) {
      const lg = LG.dvp[G], tot = U.sum(Object.values(opp.dvp).map((x) => x.pts / Math.max(1, x.n))), lgTot = LG.dvp.G.pts + LG.dvp.F.pts + LG.dvp.C.pts;
      const rel = (k) => U.clamp(shrink(((d[k] / d.n) / Math.max(1e-6, lg[k])) / (k === 'pts' ? Math.max(0.5, tot / lgTot) : 1), d.n, 5), 0.88, 1.12);
      const f = { pts: rel('pts'), reb: rel('reb'), ast: rel('ast'), fg3m: rel('fg3m') };
      for (const k in f) out[k] *= Math.pow(f[k], 0.5);
      out.dvp = { G, n: d.n, pts: d.pts / d.n, reb: d.reb / d.n, ast: d.ast / d.n, fg3m: d.fg3m / d.n, f };
    }
    // shot-zone matchup: this player's shot mix × opponent FG% allowed by zone, relative to opponent overall
    const own = mine?.own?.[pl.espnId];
    const share = {}; let nShots = own?.n || 0;
    for (const z of ZONES) share[z] = nShots >= 15 ? (own.z[z] || 0) / nShots : DEF_SHARE[G][z];
    let oM = 0, oA = 0; for (const z of ZONES) { const a = opp.allowed[z]; if (a) { oM += a[0]; oA += a[1]; } }
    if (oA >= 40) {
      const oFG = oM / oA, lgAll = U.sum(ZONES.map((z) => LG.zoneFG[z] * DEF_SHARE.F[z]));
      let zf = 0, z3 = 0, w3 = 0; const zd = {};
      for (const z of ZONES) {
        const a = opp.allowed[z] || [0, 0];
        const fg = a[1] ? (a[0] + lgZone(z) * 20) / (a[1] + 20) : lgZone(z); // shrink each zone toward league
        const rel = (fg / Math.max(0.2, oFG)) / (lgZone(z) / lgAll);
        zd[z] = { fg, att: a[1] }; zf += share[z] * rel;
        if (z === 'c3' || z === 'ab3') { z3 += share[z] * (fg / lgZone(z)); w3 += share[z]; }
      }
      const zoneF = U.clamp(zf / Math.max(0.01, U.sum(ZONES.map((z) => share[z]))), 0.9, 1.1);
      const threeF = U.clamp(w3 ? z3 / w3 : 1, 0.88, 1.12);
      out.pts *= Math.pow(zoneF, 0.6); out.fg3m *= threeF;
      out.zone = { share, nShots, zd, zoneF, threeF, oppFG: oFG, att: oA };
    }
    // shot-type (play-type proxy) matchup
    let tA = 0; const tsh = {};
    if (own && nShots >= 15) for (const t of TYPES) tsh[t] = (own.t[t] || 0) / nShots;
    if (Object.keys(tsh).length) {
      let tf = 0, ws = 0; const td = {};
      for (const t of TYPES) { const a = opp.allowedT[t]; if (!a || !tsh[t]) continue; tA += a[1]; const efg = (a[2] / 2 + lgType(t) * 15) / (a[1] + 15); td[t] = { efg, att: a[1] }; tf += tsh[t] * (efg / lgType(t)); ws += tsh[t]; }
      if (ws > 0.3) { const typeF = U.clamp(tf / ws, 0.92, 1.08); out.pts *= Math.pow(typeF, 0.5); out.type = { share: tsh, td, typeF }; }
    }
    // transition: own fast-break scoring × opponent fast-break points allowed
    if (mine?.fbFor != null && opp.fbAg != null) {
      const x = (mine.fbFor / LG.fb) * (opp.fbAg / LG.fb);
      const tr = U.clamp(1 + 0.15 * (x - 1), 0.97, 1.03);
      out.pts *= tr; out.trans = { fbFor: mine.fbFor, fbAg: opp.fbAg, f: tr };
    }
    if (opp.paintAg != null) out.paint = { ag: opp.paintAg, for: mine?.paintFor ?? null };
    for (const k of ['pts', 'reb', 'ast', 'fg3m']) out[k] = U.clamp(out[k], 0.88, 1.12);
    out.n = opp.n;
    return out;
  }
  // venue-specific possessions for the possession model
  function venuePace(teamId, home) { const a = MEM.get(teamId)?.agg; if (!a) return null; const v = home ? a.paceHome : a.paceRoad; const n = home ? a.home.length : a.road.length; return v != null ? { pace: v, n, all: a.pace } : null; }
  const get = (teamId) => MEM.get(teamId)?.agg || null;
  return { load, factors, venuePace, get, classify, parseGame, aggregate, LG };
})();
