/* ============================================================
   espn.js — ESPN public API parsers (scoreboard, summary,
   roster, gamelog, standings). Defensive: columns are matched
   by name, never by position.
   ============================================================ */

const ESPN = (() => {
  const P = '/apis/site/v2/sports/basketball/nba';

  function team(c) {
    const t = c?.team || {};
    const meta = TEAMS.find(t.abbreviation) || TEAMS.byId[String(t.id)] || {};
    const rec = (c.records || c.record || []).find((r) => r.type === 'total' || r.name === 'overall');
    return {
      id: String(t.id ?? c.id ?? ''),
      abbr: t.abbreviation || meta.espn || '?',
      code: TEAMS.toCode(t.abbreviation || meta.code),
      name: t.shortDisplayName || t.name || meta.name || '',
      full: t.displayName || ((meta.city || '') + ' ' + (meta.name || '')),
      city: t.location || meta.city || '',
      color: (t.color || meta.color || '666666').replace('#', ''),
      alt: (t.alternateColor || meta.alt || 'cccccc').replace('#', ''),
      logo: t.logo || t.logos?.[0]?.href || '',
      score: U.num(c.score?.value ?? c.score) ?? 0,
      line: (c.linescores || []).map((l) => U.num(l.value ?? l.displayValue) ?? 0),
      record: rec?.summary || '',
      meta,
    };
  }

  function parseOdds(o, home, away) {
    if (!o) return null;
    let spreadHome = null; // expected home margin (positive = home favored)
    const det = String(o.details || '').trim();
    const m = det.match(/^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)/);
    if (/^even|pk|pick/i.test(det)) spreadHome = 0;
    else if (m) {
      const fav = TEAMS.toCode(m[1]), v = Math.abs(+m[2]);
      if (fav === home.code) spreadHome = v; else if (fav === away.code) spreadHome = -v;
    }
    if (spreadHome == null && isFinite(+o.spread) && o.spread !== null) spreadHome = -(+o.spread);
    const ml = (side) => U.num(o[side + 'TeamOdds']?.moneyLine ?? o.moneyline?.[side === 'home' ? 'home' : 'away']?.close?.odds ?? o.moneyline?.[side]?.current?.odds);
    let total = U.num(o.overUnder);
    if (total == null) { const s = o.total?.over?.close?.line ?? o.total?.over?.current?.line; if (s) total = U.num(String(s).replace(/[ou]/i, '')); }
    const so = (side) => U.num(o[side + 'TeamOdds']?.spreadOdds ?? o.pointSpread?.[side]?.close?.odds);
    return { provider: o.provider?.name || 'Sportsbook', details: det, spreadHome, total, mlHome: ml('home'), mlAway: ml('away'),
      spOddsHome: so('home'), spOddsAway: so('away'), overOdds: U.num(o.overOdds ?? o.total?.over?.close?.odds), underOdds: U.num(o.underOdds ?? o.total?.under?.close?.odds) };
  }

  function parseStatus(s) {
    const t = s?.type || {};
    return {
      state: t.state || 'pre',
      statusName: t.name || '',
      detail: t.detail || t.description || '',
      shortDetail: t.shortDetail || t.detail || '',
      completed: !!t.completed,
      period: +s?.period || 0,
      clockSec: U.num(s?.clock) ?? U.clockStr(s?.displayClock) ?? 0,
      displayClock: s?.displayClock || '',
    };
  }

  function parseScoreboard(j) {
    const out = [];
    for (const e of j?.events || []) {
      const c = e.competitions?.[0];
      if (!c) continue;
      const comps = c.competitors || [];
      const hc = comps.find((x) => x.homeAway === 'home'), ac = comps.find((x) => x.homeAway === 'away');
      if (!hc || !ac) continue;
      const home = team(hc), away = team(ac);
      const st = parseStatus(c.status || e.status);
      const lp = c.situation?.lastPlay;
      const prob = lp?.probability;
      out.push({
        id: String(e.id), date: Date.parse(e.date), name: e.name, shortName: e.shortName,
        ...st,
        home, away,
        venue: { name: c.venue?.fullName || home.meta?.arena || '', city: c.venue?.address?.city || '', state: c.venue?.address?.state || '' },
        broadcast: (c.broadcasts || []).flatMap((b) => b.names || []).join(' · '),
        odds: parseOdds((c.odds || [])[0], home, away),
        espnWP: prob && isFinite(+prob.homeWinPercentage) ? +prob.homeWinPercentage : null,
        lastPlay: lp ? { text: lp.text || '', teamId: String(lp.team?.id || ''), value: +lp.scoreValue || 0, id: String(lp.id || '') } : null,
        src: 'espn', seenAt: Date.now(),
      });
    }
    return out;
  }

  // ---- boxscore columns ----
  const COLS = {
    min: ['minutes', 'MIN'], pts: ['points', 'PTS'], reb: ['rebounds', 'totalRebounds', 'REB'], ast: ['assists', 'AST'],
    fg3: ['threePointFieldGoalsMade-threePointFieldGoalsAttempted', '3PT'], stl: ['steals', 'STL'], blk: ['blocks', 'BLK'],
    tov: ['turnovers', 'TO'], pf: ['fouls', 'PF'], pm: ['plusMinus', '+/-'],
  };
  function colIndex(stat) {
    const keys = stat.keys || stat.names || [], names = stat.names || [], labels = stat.labels || [];
    const idx = {};
    for (const k in COLS) {
      let i = -1;
      for (const cand of COLS[k]) { i = keys.indexOf(cand); if (i < 0) i = names.indexOf(cand); if (i < 0) i = labels.indexOf(cand); if (i >= 0) break; }
      idx[k] = i;
    }
    return idx;
  }
  const made = (s) => { const m = String(s || '').match(/^(\d+)-(\d+)/); return m ? [+m[1], +m[2]] : [U.num(s) ?? 0, 0]; };

  function parseBox(j) {
    const players = [];
    for (const tp of j?.boxscore?.players || []) {
      const teamId = String(tp.team?.id || '');
      for (const st of tp.statistics || []) {
        const ix = colIndex(st);
        for (const a of st.athletes || []) {
          const s = a.stats || [];
          const g = (k) => (ix[k] >= 0 ? s[ix[k]] : null);
          const [f3m, f3a] = made(g('fg3'));
          players.push({
            espnId: String(a.athlete?.id || ''), name: a.athlete?.displayName || '', short: a.athlete?.shortName || '',
            pos: a.athlete?.position?.abbreviation || '', jersey: a.athlete?.jersey || '', teamId,
            starter: !!a.starter, active: a.active !== false, dnp: !!a.didNotPlay || !s.length,
            min: U.num(g('min')) ?? 0, pts: U.num(g('pts')) ?? 0, reb: U.num(g('reb')) ?? 0, ast: U.num(g('ast')) ?? 0,
            fg3m: f3m, fg3a: f3a, stl: U.num(g('stl')) ?? 0, blk: U.num(g('blk')) ?? 0, tov: U.num(g('tov')) ?? 0,
            pf: U.num(g('pf')) ?? 0, pm: U.num(String(g('pm') || '').replace('+', '')) ?? 0, oncourt: null,
          });
        }
      }
    }
    return players;
  }

  function parseSummary(j, game) {
    if (!j) return null;
    const hdr = j.header?.competitions?.[0];
    const out = { at: Date.now() };
    if (hdr) out.status = parseStatus(hdr.status);
    // injuries
    out.injuries = {};
    for (const t of j.injuries || []) {
      const tid = String(t.team?.id || '');
      out.injuries[tid] = (t.injuries || []).map((x) => ({
        espnId: String(x.athlete?.id || ''), name: x.athlete?.displayName || '', pos: x.athlete?.position?.abbreviation || '',
        status: x.status || x.type?.description || '', detail: [x.details?.side, x.details?.type, x.details?.detail].filter(Boolean).join(' '),
        ret: x.details?.returnDate || '',
      }));
    }
    // last five
    out.lastFive = {};
    for (const t of j.lastFiveGames || []) {
      out.lastFive[String(t.team?.id || '')] = (t.events || []).map((e) => ({
        result: e.gameResult || '', score: e.score || '', opp: e.opponent?.abbreviation || '', atVs: e.atVs || '', date: Date.parse(e.gameDate) || 0,
      }));
    }
    // season series
    const ss = (j.seasonseries || []).find((s) => s.type === 'season') || (j.seasonseries || [])[0];
    if (ss) {
      out.series = {
        summary: ss.summary || ss.description || '', title: ss.title || 'Season series',
        events: (ss.events || []).map((e) => {
          const cs = e.competitors || [];
          const h = cs.find((c) => c.homeAway === 'home') || {}, a = cs.find((c) => c.homeAway === 'away') || {};
          return { date: Date.parse(e.date) || 0, home: h.team?.abbreviation, away: a.team?.abbreviation, hs: U.num(h.score), as: U.num(a.score), winner: h.winner ? h.team?.abbreviation : a.winner ? a.team?.abbreviation : '' };
        }).filter((e) => e.hs != null),
      };
    }
    // predictor
    if (j.predictor) {
      const ph = U.num(j.predictor.homeTeam?.gameProjection), pa = U.num(j.predictor.awayTeam?.gameProjection);
      if (ph != null) out.predictor = { home: ph / 100, away: (pa ?? 100 - ph) / 100 };
    }
    // pickcenter
    const pc = (j.pickcenter || []).find((p) => p.details || p.spread != null) || null;
    if (pc && game) out.pick = parseOdds(pc, game.home, game.away);
    // leaders
    out.leaders = {};
    for (const t of j.leaders || []) {
      const o = {};
      for (const cat of t.leaders || []) o[cat.name] = (cat.leaders || []).map((l) => ({ espnId: String(l.athlete?.id || ''), name: l.athlete?.displayName || '', value: U.num(l.value ?? l.displayValue) }));
      out.leaders[String(t.team?.id || '')] = o;
    }
    out.box = parseBox(j);
    // plays
    out.plays = (j.plays || []).map((p) => ({
      id: String(p.id), seq: +p.sequenceNumber || 0, period: +p.period?.number || 0, clockSec: U.clockStr(p.clock?.displayValue),
      text: p.text || '', type: p.type?.text || '', scoring: !!p.scoringPlay, value: +p.scoreValue || 0, teamId: String(p.team?.id || ''),
      hs: U.num(p.homeScore), as: U.num(p.awayScore), x: p.coordinate?.x, y: p.coordinate?.y,
      who: (p.participants || []).map((q) => String(q.athlete?.id || '')),
    }));
    out.wp = (j.winprobability || []).map((w) => ({ playId: String(w.playId), home: +w.homeWinPercentage }));
    return out;
  }

  function parseRoster(j) {
    let ath = j?.athletes || [];
    if (ath.length && ath[0].items) ath = ath.flatMap((g) => g.items || []);
    return ath.map((a) => ({
      espnId: String(a.id), name: a.displayName || a.fullName || '', short: a.shortName || '', pos: a.position?.abbreviation || '',
      jersey: a.jersey || '', inj: (a.injuries || [])[0]?.status || '',
    }));
  }

  const GL = {
    min: ['minutes', 'MIN'], pts: ['points', 'PTS'], reb: ['totalRebounds', 'rebounds', 'REB'], ast: ['assists', 'AST'],
    fg3: ['threePointFieldGoalsMade-threePointFieldGoalsAttempted', '3PT'], stl: ['steals', 'STL'], blk: ['blocks', 'BLK'], tov: ['turnovers', 'TO'], pf: ['fouls', 'PF'],
  };
  function parseGamelog(j, season) {
    if (!j) return [];
    const names = j.names || [], labels = j.labels || [];
    const ix = {};
    for (const k in GL) { let i = -1; for (const c of GL[k]) { i = names.indexOf(c); if (i < 0) i = labels.indexOf(c); if (i >= 0) break; } ix[k] = i; }
    const meta = j.events || {};
    const rows = [];
    for (const stp of j.seasonTypes || []) {
      const dn = String(stp.displayName || '');
      if (/pre.?season/i.test(dn)) continue;
      const post = /post|playoff|play-in/i.test(dn);
      for (const cat of stp.categories || []) {
        if (cat.type && cat.type !== 'event') continue;
        for (const ev of cat.events || []) {
          const m = meta[ev.eventId] || {};
          const s = ev.stats || [];
          const g = (k) => (ix[k] >= 0 ? s[ix[k]] : null);
          const min = U.num(g('min'));
          if (!s.length || min == null) continue;
          const [f3m, f3a] = made(g('fg3'));
          rows.push({
            eventId: String(ev.eventId), date: Date.parse(m.gameDate) || 0, opp: TEAMS.toCode(m.opponent?.abbreviation), oppId: String(m.opponent?.id || ''),
            home: m.atVs ? m.atVs !== '@' : null, result: m.gameResult || '', season, post,
            min, pts: U.num(g('pts')) ?? 0, reb: U.num(g('reb')) ?? 0, ast: U.num(g('ast')) ?? 0, fg3m: f3m, fg3a: f3a,
            stl: U.num(g('stl')) ?? 0, blk: U.num(g('blk')) ?? 0, tov: U.num(g('tov')) ?? 0, pf: U.num(g('pf')) ?? 0,
          });
        }
      }
    }
    // de-dupe & newest first
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.eventId) ? false : seen.add(r.eventId))).sort((a, b) => b.date - a.date);
  }

  function parseStandings(j) {
    const out = {};
    const walk = (node) => {
      for (const e of node?.standings?.entries || []) {
        const s = {}; for (const x of e.stats || []) s[x.name || x.type] = x;
        const v = (k) => U.num(s[k]?.value);
        const w = v('wins') ?? 0, l = v('losses') ?? 0;
        out[String(e.team?.id)] = { abbr: e.team?.abbreviation, w, l, gp: w + l, pf: v('avgPointsFor'), pa: v('avgPointsAgainst'), diff: v('differential'), streak: s.streak?.displayValue || '' };
      }
      for (const c of node?.children || []) walk(c);
    };
    walk(j);
    const vals = Object.values(out).filter((t) => t.pf);
    const lg = vals.length ? U.mean(vals.map((t) => t.pf)) : 114.5;
    // rank offense (pf high = 1) and defense (pa low = 1)
    const offR = [...vals].sort((a, b) => b.pf - a.pf), defR = [...vals].sort((a, b) => a.pa - b.pa);
    offR.forEach((t, i) => (t.offRank = i + 1)); defR.forEach((t, i) => (t.defRank = i + 1));
    return { teams: out, lgPts: lg };
  }

  return {
    scoreboard: (key) => NET.get('espn', `${P}/scoreboard?dates=${key}&limit=50`, { fresh: true, timeout: 6000 }).then(parseScoreboard),
    summary: (id, game) => NET.get('espn', `${P}/summary?event=${id}`, { fresh: true }).then((j) => parseSummary(j, game)),
    roster: (teamId) => NET.get('espn', `${P}/teams/${teamId}/roster`).then(parseRoster),
    standings: () => NET.get('espn', `/apis/v2/sports/basketball/nba/standings`).then(parseStandings),
    gamelog: (id, season) => NET.get('espnweb', `/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog?season=${season}`).then((j) => parseGamelog(j, season)),
    parseScoreboard, parseSummary, parseGamelog, parseStandings, parseRoster, parseOdds,
  };
})();
