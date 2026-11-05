/* ============================================================
   model.js — fair-value models
   - pregame consensus (sportsbook line, ESPN BPI, Kalshi ladders)
   - live game: Brownian-motion margin/total model (Stern 1994),
     anchored on pregame consensus and recalibrated to the market
     only when the market is "settled" (no recent scoring)
   - player props: weighted form × minutes × context, NB/normal
   ============================================================ */

const MODEL = (() => {
  const SIG = 12.0;    // full-game final-margin sd (pts)
  const SIG_T = 18.5;  // full-game total sd
  const SIG_TEAM = 12.5;
  const SIG_SEG = 15.0; // quarter margins have sd ≈ 7.5
  const SEGS = { Q1: [0, 12], Q2: [12, 24], Q3: [24, 36], Q4: [36, 48], '1H': [0, 24], '2H': [24, 48] };

  const mid = (m) => (m && m.yesBid != null && m.yesAsk != null && m.yesAsk > 0 && m.yesAsk - m.yesBid <= 0.12 ? (m.yesBid + m.yesAsk) / 2 : null);
  const noVig = (a, b) => { const pa = U.amToProb(a), pb = U.amToProb(b); return isFinite(pa) && isFinite(pb) ? pa / (pa + pb) : null; };

  // ---------- ladder fits (market-implied mean from a strike ladder) ----------
  function fitLadder(rungs, sigma) {
    // rungs: [{line (X.5), p (P(value > line))}] → implied mean
    let s = 0, w = 0;
    for (const r of rungs) {
      if (r.p == null || r.p < 0.04 || r.p > 0.96) continue;
      const mu = r.line + sigma * U.normInv(r.p);
      const wt = r.p * (1 - r.p) * (r.liq || 1);
      s += mu * wt; w += wt;
    }
    return w ? s / w : null;
  }

  // ---------- pregame consensus ----------
  function pregame(game, intel, mkts) {
    const src = {};
    const odds = intel?.pick || game.odds || null;
    if (odds) {
      if (odds.spreadHome != null) src.bookSpread = odds.spreadHome;
      if (odds.total) src.bookTotal = odds.total;
      const nv = noVig(odds.mlHome, odds.mlAway); if (nv != null) src.bookP = nv;
      src.book = odds.provider;
    }
    if (intel?.predictor?.home != null) src.bpi = intel.predictor.home;
    const full = mkts.filter((m) => !m.seg);
    const mlHome = full.find((m) => m.kind === 'ml' && m.side === 'home'), mlAway = full.find((m) => m.kind === 'ml' && m.side === 'away');
    let kp = mid(mlHome); if (kp == null && mid(mlAway) != null) kp = 1 - mid(mlAway);
    if (kp != null) src.kalshiP = kp;
    const sp = full.filter((m) => m.kind === 'spread' && m.th && m.side).map((m) => ({ line: m.th.line, p: mid(m), side: m.side, liq: 1 + Math.log10(1 + m.vol) }));
    let spFit = null;
    if (sp.length) {
      const conv = sp.map((r) => ({ line: r.line, p: r.p, liq: r.liq, sgn: r.side === 'home' ? 1 : -1 }));
      let s = 0, w = 0;
      for (const r of conv) { if (r.p == null || r.p < 0.04 || r.p > 0.96) continue; const mu = r.line + SIG * U.normInv(r.p); const wt = r.p * (1 - r.p) * r.liq; s += r.sgn * mu * wt; w += wt; }
      if (w) spFit = s / w;
    }
    if (spFit != null) src.kalshiSpread = spFit;
    const tot = full.filter((m) => m.kind === 'total' && m.th).map((m) => ({ line: m.th.line, p: mid(m), liq: 1 + Math.log10(1 + m.vol) }));
    const tFit = fitLadder(tot, SIG_T); if (tFit != null) src.kalshiTotal = tFit;

    const wavg = (pairs) => { let s = 0, w = 0; for (const [v, wt] of pairs) if (v != null && isFinite(v)) { s += v * wt; w += wt; } return w ? s / w : null; };
    let spread = wavg([[src.bookSpread, 0.5], [src.kalshiSpread, 0.3], [src.kalshiP != null ? SIG * U.normInv(U.clamp(src.kalshiP, 0.02, 0.98)) : null, 0.2], [src.bpi != null ? SIG * U.normInv(U.clamp(src.bpi, 0.02, 0.98)) : null, 0.1]]);
    if (spread == null) spread = 2.0; // league-average home edge
    let total = wavg([[src.bookTotal, 0.55], [src.kalshiTotal, 0.45]]);
    if (total == null) total = 2 * (STATE.standings?.lgPts || 114.5);
    const pHome = wavg([[src.bookP, 0.35], [U.normCdf(spread / SIG), 0.25], [src.bpi, 0.15], [src.kalshiP, 0.25]]);
    return { spread, total, pHome, src };
  }

  // ---------- live game state ----------
  function liveState(g) {
    const pre = g.state === 'pre';
    const post = g.state === 'post';
    const period = g.period || 0;
    let clockSec = g.clockSec ?? 0;
    if (/HALFTIME|END_PERIOD/.test(g.statusName || '')) clockSec = 0;
    const elapsed = pre ? 0 : U.minutesElapsed(period, clockSec);
    let rem = pre ? 48 : post ? 0 : U.minutesRemaining(period, clockSec);
    // regulation ended tied, OT not started yet → 5 more minutes
    if (!pre && !post && period === 4 && clockSec <= 0 && g.home.score === g.away.score) rem = 5;
    if (!pre && !post && period > 4 && clockSec <= 0 && g.home.score === g.away.score) rem = 5;
    return { pre, post, period, clockSec, elapsed, rem, tau: rem / 48, margin: g.home.score - g.away.score, total: g.home.score + g.away.score };
  }

  // home-margin distribution at the end of game
  // late-game volatility (intentional fouls, 3PA spikes, extra possessions) the pure random walk misses
  const lateVar = (rem) => (rem > 0 ? 6 * Math.exp(-rem / 3) : 0);
  // remaining-time volatility rises through the game (leads regress; late quarters swing more):
  // 12 pts/√48min at tip (matches spread error), ~16 near the end
  const sigAt = (tau) => SIG + 4 * (1 - U.clamp(tau, 0, 1));
  function marginDist(ls, sEff) {
    const mu = ls.margin + sEff * ls.tau;
    const t = Math.max(ls.tau, 1e-6), sg = sigAt(t);
    const sd = Math.sqrt(sg * sg * t + lateVar(ls.rem));
    return { mu, sd };
  }
  function pHomeWin(ls, sEff) {
    if (ls.post) return ls.margin > 0 ? 1 : 0;
    if (ls.tau <= 0) return ls.margin > 0 ? 1 : ls.margin < 0 ? 0 : 0.5;
    const { mu, sd } = marginDist(ls, sEff);
    const pWin = 1 - U.normCdf((0.5 - mu) / sd);
    const pTie = U.normCdf((0.5 - mu) / sd) - U.normCdf((-0.5 - mu) / sd);
    const pOT = U.normCdf((sEff * 5 / 48) / (SIG * Math.sqrt(5 / 48)));
    return U.clamp(pWin + pTie * pOT, 0.0005, 0.9995);
  }
  function totalDist(ls, tEff, g) {
    if (ls.post) return { mu: ls.total, sd: 0.01 };
    const preRate = tEff / 48;
    const el = ls.elapsed;
    const liveRate = el > 0.5 ? ls.total / el : preRate;
    const w = 18 / (18 + el);
    let rate = w * preRate + (1 - w) * liveRate;
    rate = U.clamp(rate, preRate * 0.8, preRate * 1.2);
    if (g && g.rMkt != null) rate = 0.5 * rate + 0.5 * g.rMkt; // market-implied remaining scoring rate (quiet periods only)
    let mu = ls.total + rate * ls.rem;
    if (ls.rem < 2 && Math.abs(ls.margin) <= 8 && ls.period >= 4) mu += ls.rem < 1 ? 3 : 1.8; // late fouling
    return { mu, sd: Math.max(1.2, Math.sqrt(SIG_T * SIG_T * ls.tau + 1.6 * lateVar(ls.rem))) };
  }
  function segState(g, ls, seg) {
    const [a, b] = SEGS[seg];
    const len = b - a;
    const remSeg = ls.pre ? len : U.clamp(b - ls.elapsed, 0, len);
    // points so far inside the segment from linescores
    let hm = 0, am = 0;
    const p0 = a / 12, p1 = b / 12; // periods [p0, p1)
    for (let p = p0; p < p1; p++) { hm += g.home.line[p] || 0; am += g.away.line[p] || 0; }
    return { remSeg, len, hm, am, segMargin: hm - am, segTotal: hm + am, started: ls.elapsed > a || (ls.elapsed === a && !ls.pre && ls.period > p0) };
  }

  // live per-team scoring rate (pts/min): pregame implied team rate blended with what the team is actually
  // scoring tonight; the live share grows with elapsed minutes but regresses hard (basketball rates mean-revert)
  function teamRate(g, ls, side, sEff, tEff) {
    const sgn = side === 'home' ? 1 : -1;
    const pre = U.clamp((tEff + sgn * sEff) / 2 / 48, 1.8, 3.0);
    const el = ls.elapsed, pts = side === 'home' ? g.home.score : g.away.score;
    if (el < 3) return { rate: pre, pre, live: null, w: 1 };
    const live = pts / el, w = 22 / (22 + el);
    return { rate: U.clamp(w * pre + (1 - w) * live, pre * 0.8, pre * 1.2), pre, live, w };
  }
  function lateTeamBump(ls) { return ls.rem < 2 && Math.abs(ls.margin) <= 8 && ls.period >= 4 ? (ls.rem < 1 ? 1.5 : 0.9) : 0; }

  // ---------- fair probability for a game-line market ----------
  function lineProb(m, g, ctx) {
    const ls = ctx.ls, sEff = ctx.sEff, tEff = ctx.tEff;
    const atLeast = (k, mu, sd) => (sd < 0.05 ? (mu >= k ? 1 : 0) : U.normAtLeast(k, mu, sd));
    const th = m.th;
    const sideSign = m.side === 'away' ? -1 : 1;
    if (m.seg) {
      const ss = segState(g, ls, m.seg);
      const mu = ss.segMargin + sEff * (ss.remSeg / 48), sd = SIG_SEG * Math.sqrt(ss.remSeg / 48);
      if (m.kind === 'ml') {
        if (!m.side) return null;
        const pH = sd < 0.05 ? (ss.segMargin > 0 ? 1 : 0) : 1 - U.normCdf((0.5 - mu) / sd);
        const pA = sd < 0.05 ? (ss.segMargin < 0 ? 1 : 0) : U.normCdf((-0.5 - mu) / sd);
        if (m.side === 'tie') return { p: U.clamp(1 - pH - pA, 0, 1), mu, sd };
        return { p: m.side === 'home' ? pH : pA, mu, sd };
      }
      if (m.kind === 'teamtotal' && th && m.side) {
        const so = m.side === 'home' ? ss.hm : ss.am, tr = teamRate(g, ls, m.side, sEff, tEff);
        const tmu = so + tr.rate * ss.remSeg, tsd = SIG_TEAM * 1.1 * Math.sqrt(ss.remSeg / 48);
        return { p: atLeast(th.k, tmu, tsd), mu: tmu, sd: tsd, so, tr };
      }
      if (m.kind === 'spread' && th && m.side) return { p: atLeast(th.k, sideSign * mu, sd), mu: sideSign * mu, sd };
      if (m.kind === 'total' && th) {
        const rh = teamRate(g, ls, 'home', sEff, tEff), ra = teamRate(g, ls, 'away', sEff, tEff);
        const tmu = ss.segTotal + (rh.rate + ra.rate) * ss.remSeg, tsd = SIG_T * Math.sqrt(ss.remSeg / 48);
        return { p: atLeast(th.k, tmu, tsd), mu: tmu, sd: tsd, so: ss.segTotal };
      }
      return null;
    }
    if (m.kind === 'margin' && m.range && m.side) {
      const d = marginDist(ls, sEff), mu = sideSign * d.mu, [lo, hi] = m.range;
      if (ls.post) { const v = sideSign * ls.margin; return { p: v >= lo && v <= hi ? 1 : 0, mu, sd: 0 }; }
      const p = U.normCdf((Math.min(hi, 99) + 0.5 - mu) / d.sd) - U.normCdf((lo - 0.5 - mu) / d.sd);
      return { p: U.clamp(p, 0, 1), mu, sd: d.sd };
    }
    if (m.kind === 'ot') {
      if (ls.period > 4) return { p: 1, mu: 0, sd: 0 };
      if (ls.post) return { p: 0, mu: 0, sd: 0 };
      const remReg = ls.pre ? 48 : Math.max(0, U.minutesRemaining(Math.min(ls.period, 4), ls.clockSec));
      const t = remReg / 48, mu = ls.margin + sEff * t, sg = sigAt(Math.max(t, 1e-6));
      const sd = Math.sqrt(sg * sg * Math.max(t, 1e-6) + lateVar(remReg));
      if (sd < 0.05) return { p: ls.margin === 0 ? 1 : 0, mu, sd: 0 };
      // normal tie mass under-counts real NBA ties (~6% of games go to OT); inflate until the last 12 minutes
      const infl = 1 + 0.8 * Math.min(1, remReg / 12);
      return { p: U.clamp((U.normCdf((0.5 - mu) / sd) - U.normCdf((-0.5 - mu) / sd)) * infl, 0, 1), mu, sd };
    }
    if (m.kind === 'ml') {
      if (!m.side || m.side === 'tie') return null;
      const ph = pHomeWin(ls, sEff);
      return { p: m.side === 'home' ? ph : 1 - ph, ...marginDist(ls, sEff) };
    }
    if (m.kind === 'spread' && th && m.side) {
      const d = marginDist(ls, sEff);
      const mu = sideSign * d.mu;
      if (ls.post) return { p: sideSign * ls.margin >= th.k ? 1 : 0, mu, sd: 0 };
      return { p: atLeast(th.k, mu, d.sd), mu, sd: d.sd };
    }
    if (m.kind === 'total' && th) {
      const d = totalDist(ls, tEff, g);
      if (th.op === '<') return { p: 1 - atLeast(th.kmax + 1, d.mu, d.sd), ...d };
      return { p: atLeast(th.k, d.mu, d.sd), ...d };
    }
    if (m.kind === 'teamtotal' && th && m.side) {
      const cur = m.side === 'home' ? g.home.score : g.away.score;
      if (ls.post) return { p: cur >= th.k ? 1 : 0, mu: cur, sd: 0 };
      const tr = teamRate(g, ls, m.side, sEff, tEff);
      const mu = cur + tr.rate * ls.rem + lateTeamBump(ls), sd = Math.max(0.8, Math.sqrt(SIG_TEAM * SIG_TEAM * ls.tau + 0.8 * lateVar(ls.rem)));
      return { p: atLeast(th.k, mu, sd), mu, sd, tr };
    }
    return null;
  }

  // ---------- players ----------
  const STATS = ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk'];
  const COMBO = { pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], ra: ['reb', 'ast'] };
  const statVal = (r, s) => (COMBO[s] ? COMBO[s].reduce((a, k) => a + (r[k] || 0), 0) : r[s] || 0);
  const ENV_EXP = { pts: 1.0, fg3m: 0.9, ast: 0.75, reb: 0.35, stl: 0.3, blk: 0.3 };
  const LABEL = { pts: 'points', reb: 'rebounds', ast: 'assists', fg3m: 'threes', stl: 'steals', blk: 'blocks', pra: 'pts+reb+ast', pr: 'pts+reb', pa: 'pts+ast', ra: 'reb+ast', dd: 'double-double', td: 'triple-double' };
  const SHORT = { pts: 'PTS', reb: 'REB', ast: 'AST', fg3m: '3PM', stl: 'STL', blk: 'BLK', pra: 'PRA', pr: 'P+R', pa: 'P+A', ra: 'R+A', dd: 'DD', td: 'TD' };
  function priorVar(s, mu) {
    switch (s) {
      case 'pts': case 'pra': case 'pr': case 'pa': return (0.27 * mu + 2.2) ** 2;
      case 'reb': case 'ra': return mu + (mu * mu) / 9;
      case 'ast': return mu + (mu * mu) / 8;
      case 'fg3m': return mu + (mu * mu) / 6;
      default: return mu * 1.15 + 0.05;
    }
  }

  /**
   * Pregame projection for one player.
   * logs: newest-first gamelog rows (both seasons). ctx: {season, opp, home, teamCode, env, spreadTeam, b2b, outMates:[{name, logs}], status}
   */
  function projectPlayer(logs, ctx) {
    const games = (logs || []).filter((r) => r.min >= 4);
    if (games.length < 3) return null;
    const cur = games.filter((r) => r.season === ctx.season);
    const w = games.map((r, i) => Math.pow(0.5, i / 10) * (r.season === ctx.season ? 1 : 0.55) * (r.post ? 0.85 : 1));
    const nEff = U.sum(w) ** 2 / U.sum(w.map((x) => x * x));
    const notes = [];
    // minutes
    const last5 = games.slice(0, 5);
    let minProj = 0.6 * U.wmean(games.map((r) => r.min), w) + 0.4 * U.mean(last5.map((r) => r.min));
    const minBase = minProj;
    // minutes intelligence: ramp after an absence, sustained role change, news-reported limits / role
    const curG = games.filter((r) => r.season === ctx.season);
    for (let i = 0; i < Math.min(curG.length - 1, 4); i++) {
      const gap = (curG[i].date - curG[i + 1].date) / 864e5;
      if (gap >= 7) {
        const since = curG.slice(0, i + 1), before = games.slice(i + 1, i + 11);
        const ms = U.mean(since.map((r) => r.min)), mb = U.mean(before.map((r) => r.min));
        if (isFinite(ms) && isFinite(mb) && ms < 0.85 * mb) { const cap = ms * 1.08; if (minProj > cap) { notes.push({ k: 'min', t: `Minutes ramp: ${Math.round(gap)}-day absence, ${since.length} game${since.length > 1 ? 's' : ''} back at ${ms.toFixed(1)} min vs ${mb.toFixed(1)} before → capped at ${cap.toFixed(1)}` }); minProj = cap; } }
        break;
      }
    }
    if (games.length >= 8) {
      const l3 = U.mean(games.slice(0, 3).map((r) => r.min)), l15 = U.mean(games.slice(3, 18).map((r) => r.min));
      if (l15 > 0 && Math.abs(l3 / l15 - 1) > 0.15 && games.slice(0, 3).every((r) => Math.sign(r.min - l15) === Math.sign(l3 - l15))) { const was = minProj; minProj = 0.6 * l3 + 0.4 * minProj; notes.push({ k: 'min', t: `Role change: last 3 games ${l3.toFixed(1)} min vs ${l15.toFixed(1)} prior (all 3 same direction) → ${was.toFixed(1)} → ${minProj.toFixed(1)}` }); }
    }
    const nw = ctx.news || {};
    if (nw.cap && minProj > nw.cap) { notes.push({ k: 'min', t: `News: minutes limit ~${nw.cap} ("${nw.items[0]?.head.slice(0, 60)}")` }); minProj = nw.cap; }
    else if (nw.restrict) { minProj *= 0.8; notes.push({ k: 'min', t: `News: minutes restriction reported ("${nw.items[0]?.head.slice(0, 60)}") → ×0.80` }); }
    if (nw.start && minProj < 28) { minProj *= 1.12; notes.push({ k: 'min', t: `News: moving into the starting lineup ("${nw.items[0]?.head.slice(0, 60)}") → ×1.12` }); }
    if (nw.bench && minProj > 24) { minProj *= 0.88; notes.push({ k: 'min', t: `News: moving to a bench role → ×0.88` }); }
    const fat = ctx.fat || { minF: 1, effF: 1, flags: [] };
    if (fat.minF !== 1) minProj *= fat.minF;
    // usage proxy per minute: (FGA + 0.44·FTA + TOV) / MIN
    const ug = games.filter((r) => r.fga != null && r.fta != null);
    const usage = (arr) => { const m = U.sum(arr.map((r) => r.min)); return m ? U.sum(arr.map((r) => r.fga + 0.44 * r.fta + (r.tov || 0))) / m : null; };
    const usageInfo = { all: ug.length >= 3 ? usage(ug) : null, l5: ug.length >= 3 ? usage(ug.slice(0, 5)) : null, mates: [] };
    const sp = Math.abs(ctx.spreadTeam || 0);
    if (sp > 8 && minProj > 26) { const f = Math.max(0.9, 1 - 0.006 * (sp - 8)); minProj *= f; notes.push({ k: 'blowout', t: `Blowout risk (spread ${sp.toFixed(1)}) trims starter minutes ${(100 - f * 100).toFixed(1)}%` }); }

    // teammate absences: with/without splits where available
    const mateFx = {}; for (const s of STATS) mateFx[s] = 1;
    const mateNotes = [];
    for (const mate of ctx.outMates || []) {
      const mlogs = (mate.logs || []).filter((r) => r.min > 0);
      const mDates = new Set(mlogs.map((r) => Math.floor(r.date / 864e5)));
      const sameSeason = games.filter((r) => r.season === ctx.season || r.season === ctx.season - 1);
      const onTeam = mlogs.length > 0;
      if (!onTeam) continue;
      // only use seasons in which the teammate logged games (proxy for being on the roster)
      const mSeasons = new Set(mlogs.map((r) => r.season));
      const pool = sameSeason.filter((r) => mSeasons.has(r.season));
      const without = pool.filter((r) => !mDates.has(Math.floor(r.date / 864e5)));
      const withG = pool.filter((r) => mDates.has(Math.floor(r.date / 864e5)));
      const mateAvg = U.mean(mlogs.slice(0, 15).map((r) => r.pts));
      const mw = mate.w ?? 1; // OUT = 1, DOUBTFUL = 0.75
      if (without.length >= 2 && withG.length >= 3) {
        const parts = [];
        const uW = usage(without.filter((r) => r.fga != null)), uWi = usage(withG.filter((r) => r.fga != null));
        if (uW != null && uWi != null) usageInfo.mates.push({ name: mate.name, code: mate.code || 'OUT', with: uWi, without: uW, n: without.length, nWith: withG.length });
        for (const s of STATS) {
          const rw = U.sum(without.map((r) => r[s])) / Math.max(1, U.sum(without.map((r) => r.min)));
          const rwi = U.sum(withG.map((r) => r[s])) / Math.max(1, U.sum(withG.map((r) => r.min)));
          if (rwi > 0) {
            const wt = mw * without.length / (without.length + 4);
            const f = U.clamp(1 + wt * (rw / rwi - 1), 0.85, 1.3);
            mateFx[s] *= f;
            if (s === 'pts' || s === 'ast' || s === 'reb') parts.push(`${SHORT[s]} ${U.signed((f - 1) * 100, 0)}%`);
          }
        }
        const minW = U.mean(without.map((r) => r.min)), minWi = U.mean(withG.map((r) => r.min));
        if (isFinite(minW) && isFinite(minWi)) minProj *= U.clamp(1 + (without.length / (without.length + 4)) * (minW / minWi - 1), 0.92, 1.12);
        mateNotes.push(`${mate.name} ${mate.code || 'OUT'} (official) — with/without split, ${without.length} games without vs ${withG.length} with: ${parts.join(', ')}`);
      } else if (isFinite(mateAvg) && mateAvg >= 8) {
        // usage redistribution heuristic
        const teamPts = ctx.teamAvgPts || 114;
        const myPts = U.wmean(games.map((r) => r.pts), w);
        const share = myPts / Math.max(30, teamPts - mateAvg);
        const missedRecent = games.slice(0, 3).every((r) => !mDates.has(Math.floor(r.date / 864e5)));
        const bump = 0.6 * mw * mateAvg * share * (missedRecent ? 0.5 : 1);
        const f = U.clamp(1 + bump / Math.max(3, myPts), 1, 1.18);
        mateFx.pts *= f; mateFx.fg3m *= 1 + (f - 1) * 0.8; mateFx.ast *= 1 + (f - 1) * 0.6; mateFx.reb *= 1 + (f - 1) * 0.4;
        mateNotes.push(`${mate.name} ${mate.code || 'OUT'} (official, ${mateAvg.toFixed(1)} ppg) — fewer than 2 games without him in the logs; scoring-share redistribution ${U.signed((f - 1) * 100, 0)}% PTS${missedRecent ? ' (absent from the last 3 games already, half weight)' : ''}`);
      }
    }
    for (const t of mateNotes) notes.push({ k: 'inj', t });

    // environment: possession volume × opponent efficiency allowed, blended 50/50 with the market-implied team total
    const PACE_EXP = { pts: 1, reb: 0.7, ast: 1, fg3m: 1, stl: 1, blk: 0.8 }, DEF_EXP = { pts: 1, fg3m: 0.8, ast: 0.5, reb: 0, stl: 0, blk: 0 };
    const EFF_EXP = { pts: 1, fg3m: 1.3, ast: 0.4, reb: 0, stl: 0, blk: 0 };
    const envFor = (s) => {
      const model = Math.pow(ctx.paceF ?? 1, PACE_EXP[s] ?? 1) * Math.pow(ctx.defF ?? 1, DEF_EXP[s] ?? 0);
      return ctx.marketF != null ? 0.5 * model + 0.5 * Math.pow(ctx.marketF, ENV_EXP[s] ?? 0.5) : model;
    };

    const proj = {};
    const all = [...STATS, ...Object.keys(COMBO)];
    for (const s of all) {
      const vals = games.map((r) => statVal(r, s));
      const scaled = games.map((r, i) => vals[i] * U.clamp(minBase / Math.max(r.min, 1), 0.6, 1.6));
      let mu;
      if (COMBO[s]) mu = COMBO[s].reduce((a, k) => a + proj[k].mu, 0);
      else {
        const rate = U.sum(games.map((r, i) => vals[i] * w[i])) / U.sum(games.map((r, i) => r.min * w[i]));
        mu = rate * minProj;
        mu *= envFor(s);
        mu *= Math.pow(fat.effF ?? 1, EFF_EXP[s] ?? 0);
        mu *= ctx.scoutF?.[s] ?? 1;                       // defense vs position, shot zones/types, transition
        if (s === 'pts' || s === 'fg3m') mu *= ctx.defenderF ?? 1; // primary defender disruption
        mu *= mateFx[s] || 1;
      }
      // head-to-head
      const h2h = games.filter((r) => r.opp === ctx.opp);
      let h2hF = 1;
      if (h2h.length >= 2 && !COMBO[s]) {
        const rAll = U.sum(games.map((r) => statVal(r, s))) / U.sum(games.map((r) => r.min));
        const rH = U.sum(h2h.map((r) => statVal(r, s))) / U.sum(h2h.map((r) => r.min));
        if (rAll > 0) { h2hF = U.clamp(1 + 0.35 * (h2h.length / (h2h.length + 5)) * (rH / rAll - 1), 0.9, 1.1); mu *= h2hF; }
      }
      // home/away split
      let haF = 1;
      if (ctx.home != null && !COMBO[s]) {
        const side = games.filter((r) => r.home === ctx.home), other = games.filter((r) => r.home === !ctx.home);
        if (side.length >= 5 && other.length >= 5) {
          const r1 = U.sum(side.map((r) => statVal(r, s))) / U.sum(side.map((r) => r.min));
          const r0 = U.sum(games.map((r) => statVal(r, s))) / U.sum(games.map((r) => r.min));
          if (r0 > 0) { haF = U.clamp(1 + 0.5 * Math.min(1, side.length / 30) * (r1 / r0 - 1), 0.95, 1.05); mu *= haF; }
        }
      }
      if (COMBO[s]) { // combos: apply average of component context already embedded via components
      }
      const sv = U.wvar(scaled, w);
      const pv = priorVar(s, mu);
      let variance = (nEff * (isFinite(sv) ? sv : pv) + 8 * pv) / (nEff + 8);
      variance *= 1 + 1 / Math.max(2, nEff);
      proj[s] = { mu, variance, h2hF, haF, n: games.length, nEff, vals };
    }
    const env = {}; for (const s of STATS) env[s] = envFor(s);
    return { proj, minProj, minBase, games, cur, notes, nEff, env, usage: usageInfo, fat, l5min: U.mean(last5.map((r) => r.min)) };
  }

  function probAtLeast(stat, k, mu, variance) {
    if (k <= 0) return 1;
    if (['pts', 'pra', 'pr', 'pa'].includes(stat) || mu > 12) return U.normAtLeast(k, mu, Math.sqrt(variance));
    return U.countAtLeast(k, mu, variance);
  }

  function propPregameProb(pp, stat, th) {
    if (!pp) return null;
    if (stat === 'dd' || stat === 'td') {
      const ps = ['pts', 'reb', 'ast'].map((s) => probAtLeast(s, 10, pp.proj[s].mu, pp.proj[s].variance));
      const p2 = ps[0] * ps[1] + ps[0] * ps[2] + ps[1] * ps[2] - 2 * ps[0] * ps[1] * ps[2];
      return { p: stat === 'dd' ? p2 : ps[0] * ps[1] * ps[2], mu: null };
    }
    const pr = pp.proj[stat];
    if (!pr || !th) return null;
    if (th.op === '<') return { p: 1 - probAtLeast(stat, th.kmax + 1, pr.mu, pr.variance), mu: pr.mu, sd: Math.sqrt(pr.variance) };
    return { p: probAtLeast(stat, th.k, pr.mu, pr.variance), mu: pr.mu, sd: Math.sqrt(pr.variance) };
  }

  /**
   * Live prop probability. live: {cur:{pts..}, min, pf, oncourt, played, active}
   */
  function propLiveProb(pp, stat, th, live, ls) {
    if (!pp || !th || stat === 'dd' || stat === 'td') return null;
    const comps = COMBO[stat] || [stat];
    const c = comps.reduce((a, k) => a + (live[k] || 0), 0);
    if (th.op !== '<' && c >= th.k) return { p: 1, mu: c, sd: 0, cur: c, hit: true, r: 0, notes: [] };
    const notes = [];
    const R = ls.rem;
    const M = pp.minProj;
    let r = U.clamp(0.5 * (M - live.min) + 0.5 * (M / 48) * R, 0, R);
    const per = ls.period;
    if (live.pf >= 6) { r = 0; notes.push('Fouled out'); }
    else if (live.pf === 5) { r *= 0.6; notes.push('5 fouls — minutes at risk'); }
    else if (live.pf === 4 && per <= 3) { r *= 0.8; notes.push('4 fouls before the 4th'); }
    else if (live.pf === 3 && per <= 2) { r *= 0.9; notes.push('3 first-half fouls'); }
    const am = Math.abs(ls.margin);
    if (per >= 4 && am >= 20) { r *= 0.45; notes.push(`Blowout (${am}) — starters likely sit`); }
    else if (per >= 4 && am >= 15 && (ls.clockSec ?? 720) < 420) { r *= 0.7; notes.push(`Margin ${am} late — garbage-time risk`); }
    else if (per === 3 && am >= 25) { r *= 0.75; notes.push(`Margin ${am} in Q3`); }
    if (live.active === false || (!live.played && ls.elapsed > 8)) { r = 0; notes.push('Not playing'); }
    let mu = 0, variance = 0;
    for (const k of comps) {
      const pr = pp.proj[k];
      const ratePre = pr.mu / Math.max(M, 1);
      const rate = (ratePre * 30 + (live[k] || 0)) / (30 + live.min);
      mu += rate * r;
      variance += pr.variance * (r / Math.max(M, 1));
    }
    variance = Math.max(variance, mu * 1.05, 0.0001);
    const need = th.op === '<' ? null : th.k - c;
    let p;
    if (th.op === '<') p = c > th.kmax ? 0 : 1 - probAtLeast(stat, th.kmax + 1 - c, mu, variance);
    else p = r <= 0 ? 0 : probAtLeast(stat, need, mu, variance);
    return { p: U.clamp(p, 0, 1), mu: c + mu, sd: Math.sqrt(variance), cur: c, r, notes };
  }

  // hit history at threshold k
  function hitHistory(games, stat, k, season) {
    if (!games?.length || k == null) return null;
    const v = games.map((r) => statVal(r, stat));
    const hit = (arr) => ({ h: arr.filter((x) => x >= k).length, n: arr.length });
    let streak = 0; const first = v[0] >= k;
    for (const x of v) { if ((x >= k) === first) streak++; else break; }
    const cur = games.filter((r) => r.season === season).map((r) => statVal(r, stat));
    return { l5: hit(v.slice(0, 5)), l10: hit(v.slice(0, 10)), l20: hit(v.slice(0, 20)), season: hit(cur), streak: first ? streak : -streak, last: v.slice(0, 10), avg5: U.mean(v.slice(0, 5)), avg10: U.mean(v.slice(0, 10)) };
  }

  return { teamRate, segState, probAtLeast, priorVar, SIG, SIG_T, SEGS, mid, noVig, pregame, liveState, pHomeWin, marginDist, totalDist, lineProb, projectPlayer, propPregameProb, propLiveProb, hitHistory, statVal, LABEL, SHORT, COMBO, STATS };
})();
