/* ============================================================
   picks.js — turns markets + fair values into ranked picks:
   fee-aware EV, entry thresholds, Kelly, lag detection, rating,
   evidence, and a timestamped live pick feed
   ============================================================ */

const PICKS = (() => {
  const FEED = new Map();       // gameId → Map(key → entry)
  const atQuote = new Map();    // ticker → {quoteAt, p}
  const PLAY_MIN = 0.025;       // minimum edge (after fees) to call it a pick
  const persisted = U.store.get('feed:' + U.etDateKey(), {});
  for (const gid in persisted) FEED.set(gid, new Map(persisted[gid].map((e) => [e.key, e])));
  let saveT = 0;
  function persist() {
    if (NET.isDemo() || Date.now() - saveT < 5000) return; saveT = Date.now();
    const o = {}; for (const [gid, m] of FEED) o[gid] = [...m.values()].sort((a, b) => b.firstSeen - a.firstSeen).slice(0, 80);
    U.store.set('feed:' + U.etDateKey(), o);
  }

  const teamName = (g, side) => g[side].name || g[side].abbr;
  const other = (s) => (s === 'home' ? 'away' : 'home');
  const SEGN = { Q1: '1st Qtr', Q2: '2nd Qtr', Q3: '3rd Qtr', Q4: '4th Qtr', '1H': '1st Half', '2H': '2nd Half' };

  function labels(m, g, sideYes) {
    const seg = m.seg ? ' · ' + SEGN[m.seg] : '';
    const th = m.th;
    switch (m.kind) {
      case 'margin': { const r = m.range ? (m.range[1] === Infinity ? `${m.range[0]}+` : `${m.range[0]}–${m.range[1]}`) : ''; return sideYes ? { t: `${teamName(g, m.side)} win by ${r}`, s: 'Winning margin' } : { t: `Not ${teamName(g, m.side)} by ${r}`, s: 'Winning margin · NO' }; }
      case 'ot': return sideYes ? { t: 'Game goes to overtime', s: 'Overtime' } : { t: 'No overtime', s: 'Overtime · NO' };
      case 'ml': if (m.side === 'tie') return sideYes ? { t: `${SEGN[m.seg] || ''} ends tied`, s: 'Segment tie' } : { t: `${SEGN[m.seg] || ''} not tied`, s: 'Segment tie · NO' };
        return sideYes ? { t: `${teamName(g, m.side)} win${seg}`, s: m.seg ? 'Segment winner' : 'Moneyline' } : (m.seg ? { t: `${teamName(g, m.side)} don't win${seg}`, s: 'Other team or tie' } : { t: `${teamName(g, other(m.side))} win`, s: `Moneyline · NO on ${g[m.side].abbr}` });
      case 'spread': {
        const L = th.line;
        return sideYes ? { t: `${teamName(g, m.side)} −${L}${seg}`, s: `Wins by ${th.k}+` } : { t: `${teamName(g, other(m.side))} +${L}${seg}`, s: `${g[m.side].abbr} wins by ${th.k - 1} or fewer / loses` };
      }
      case 'total': return sideYes ? { t: `Over ${th.line}${seg}`, s: 'Game total' } : { t: `Under ${th.line}${seg}`, s: 'Game total' };
      case 'teamtotal': return sideYes ? { t: `${teamName(g, m.side)} over ${th.line}`, s: 'Team total' } : { t: `${teamName(g, m.side)} under ${th.line}`, s: 'Team total' };
      case 'prop': {
        const st = MODEL.SHORT[m.stat] || m.stat;
        if (m.prot) { const L = labels({ ...m, prot: false }, g, sideYes); return { t: L.t, s: L.s + ' · PROT market' }; }
        if (m.stat === 'dd' || m.stat === 'td') return sideYes ? { t: `${m.player} ${st}`, s: MODEL.LABEL[m.stat] } : { t: `${m.player} no ${st}`, s: MODEL.LABEL[m.stat] };
        if (th?.op === '<') return sideYes ? { t: `${m.player} under ${th.line} ${st}`, s: 'Player prop' } : { t: `${m.player} ${th.kmax + 1}+ ${st}`, s: 'Player prop' };
        return sideYes ? { t: `${m.player} ${th.k}+ ${st}`, s: `Player prop · ${MODEL.LABEL[m.stat]}` } : { t: `${m.player} under ${th.k - 0.5} ${st}`, s: `Player prop · ≤${th.k - 1} ${MODEL.LABEL[m.stat]}` };
      }
    }
    return { t: m.title, s: m.sub };
  }

  function liveBoxFor(g, rec, espnId, name) {
    const box = STATE.box.get(g.id);
    if (!box) return null;
    let p = box.byEspn?.get(espnId);
    if (!p && name) p = box.players.find((x) => U.nameScore(x.name, name) >= 0.9);
    return p || null;
  }

  const fmtAm = (a) => (a == null ? '' : (a > 0 ? '+' : '') + Math.round(a));
  // pregame sportsbook lines (DraftKings via ESPN) as tradable prices when Kalshi lacks that line
  function bookMarkets(g, mk, ls) {
    if (!ls.pre) return [];
    const o = INTEL.get(g.id)?.summary?.pick || g.odds;
    if (!o) return [];
    const have = new Set(mk.filter((m) => !m.seg).map((m) => m.kind));
    const book = o.provider || 'Sportsbook';
    const mkB = (id, kind, side, th, yesAm, noAm, sub) => ({ ticker: `BOOK-${g.id}-${id}`, kind, side, th, seg: null, book, sub, title: sub, yesAsk: U.amToProb(yesAm), noAsk: U.amToProb(noAm), yesBid: null, noBid: null, yesAm, noAm, vol: 1e4, oi: 0, quoteAt: Date.now(), hist: [] });
    const out = [];
    if (!have.has('ml') && o.mlHome != null && o.mlAway != null) out.push(mkB('ml', 'ml', 'home', null, o.mlHome, o.mlAway, `${book}: ${g.home.abbr} ${fmtAm(o.mlHome)} / ${g.away.abbr} ${fmtAm(o.mlAway)}`));
    if (!have.has('spread') && o.spreadHome) {
      const side = o.spreadHome > 0 ? 'home' : 'away', L = Math.abs(o.spreadHome);
      const yA = (side === 'home' ? o.spOddsHome : o.spOddsAway) ?? -110, nA = (side === 'home' ? o.spOddsAway : o.spOddsHome) ?? -110;
      out.push(mkB('sp', 'spread', side, { op: '>', line: L, k: Math.floor(L) + 1 }, yA, nA, `${book}: ${g[side].abbr} −${L} (${fmtAm(yA)})`));
    }
    if (!have.has('total') && o.total) out.push(mkB('tot', 'total', null, { op: '>', line: o.total, k: Math.floor(o.total) + 1 }, o.overOdds ?? -110, o.underOdds ?? -110, `${book}: O/U ${o.total} (${fmtAm(o.overOdds ?? -110)}/${fmtAm(o.underOdds ?? -110)})`));
    return out;
  }

  // Kalshi-style prop ladders; used for model picks when no live price exists for that line
  const LADDER = { pts: [10, 15, 20, 25, 30, 35, 40], reb: [4, 6, 8, 10, 12, 14], ast: [2, 4, 6, 8, 10, 12], fg3m: [1, 2, 3, 4, 5], pra: [15, 20, 25, 30, 35, 40, 45, 50] };
  function naiveProb(pl, stat, k) {
    const games = pl.proj.games;
    const cur = pl.proj.cur.length >= 5 ? pl.proj.cur : games.slice(0, 15);
    const v = cur.map((r) => MODEL.statVal(r, stat));
    const mu = U.mean(v); if (!isFinite(mu)) return null;
    const sv = v.length > 2 ? U.wvar(v, v.map(() => 1)) : NaN;
    const variance = isFinite(sv) ? 0.5 * sv + 0.5 * MODEL.priorVar(stat, mu) : MODEL.priorVar(stat, mu);
    return MODEL.probAtLeast(stat, k, mu, variance);
  }
  function modelPicks(g, rec, ls, pricedKeys) {
    const out = [];
    if (!rec || ls.post) return out;
    for (const pl of rec.players.values()) {
      if (!pl.proj || /^out/i.test(pl.status || '')) continue;
      const lb = !ls.pre ? liveBoxFor(g, rec, pl.espnId, pl.name) : null;
      if (!ls.pre && !lb) continue;
      for (const stat of Object.keys(LADDER)) {
        if (pricedKeys.has(`${pl.espnId}:${stat}`)) continue;
        let best = null;
        for (const k of LADDER[stat]) {
          const th = { op: '>=', line: k, k };
          const fp = lb ? MODEL.propLiveProb(pl.proj, stat, th, lb, ls) : MODEL.propPregameProb(pl.proj, stat, th);
          if (!fp || fp.hit || fp.p == null) continue;
          const base = lb ? MODEL.propPregameProb(pl.proj, stat, th)?.p : naiveProb(pl, stat, k);
          if (base == null || !isFinite(base)) continue;
          const lean = fp.p - base, yes = true, fair = fp.p; // overs only
          if (lean < 0.01 || fair < 0.35 || fair > 0.92) continue; // model must be above baseline; actionable band
          const score = Math.abs(lean) + 0.15 * (fair - 0.5);
          if (!best || score > best.score) best = { k, th, fp, base, lean, yes, fair, score };
        }
        if (!best) continue;
        const nEff = pl.proj.nEff;
        const unc = 0.05 + 0.12 / Math.sqrt(nEff + 1) + (/question|doubt|day/i.test(pl.status || '') ? 0.05 : 0);
        const safety = unc * 0.8 + 0.005;
        const fair = best.fair;
        let raw = 52 + 160 * Math.abs(best.lean) + 12 * (fair - 0.5) + (nEff >= 15 ? 3 : nEff < 6 ? -6 : 0);
        const rating = Math.round(U.clamp(40 + 59 * (1 - Math.exp(-Math.max(0, raw - 40) / 30)), 30, 86));
        const tier = rating >= 83 ? 'GOLD' : rating >= 76 ? 'SILVER' : rating >= 70 ? 'BRONZE' : '';
        const m = { ticker: `MODEL-${pl.espnId}-${stat}-${best.k}`, kind: 'prop', stat, player: pl.name, th: best.th, sub: `${pl.name}: ${best.k}+`, title: '', espnId: pl.espnId, yesBid: null, yesAsk: null, noBid: null, noAsk: null, vol: 0, oi: 0, quoteAt: 0, hist: [], modelOnly: true };
        const lbz = labels(m, g, best.yes);
        out.push({
          id: m.ticker + (best.yes ? ':Y' : ':N'), ticker: m.ticker, gameId: g.id, kind: 'prop', stat, side: best.yes ? 'YES' : 'NO', label: lbz.t, sub: lbz.s,
          price: null, fair, cost: null, edge: null, netEdge: null, lean: Math.abs(best.lean), roi: null, be: U.breakEven(fair), fairMax: U.breakEven(fair), maxEntry: Math.min(Math.max(0, fair - 0.04), U.breakEven(Math.max(0, fair - safety))), buyMax: Math.min(Math.max(0, fair - 0.04), U.breakEven(Math.max(0, fair - safety))), greatEntry: U.breakEven(Math.max(0, fair - safety - 0.06)), scale: 0,
          kelly: 0, unc, safety, rating, tier, playable: false, modelOnly: true, lag: null, live: !ls.pre, liq: { spread: null, vol: 0, oi: 0 }, m,
          data: { player: pl, live: lb, fp: { ...best.fp, base: best.base, liveBase: !!lb } }, yes: best.yes,
        });
      }
    }
    return out.sort((a, b) => b.rating - a.rating).slice(0, 40);
  }

  // ladder family: rungs of the same underlying bet (one player-stat, one total ladder, one team's spread…)
  function famKey(m, yes) {
    const seg = m.seg || 'G', other = (s) => (s === 'home' ? 'away' : 'home');
    switch (m.kind) {
      case 'prop': return `prop:${m.espnId || m.player}:${m.stat}`;
      case 'total': return `total:${seg}:${yes ? 'o' : 'u'}`;
      case 'teamtotal': return `tt:${seg}:${m.side}:${yes ? 'o' : 'u'}`;
      case 'spread': return `sp:${seg}:${yes ? m.side : other(m.side)}`;
      case 'margin': return `mg:${m.side}`;
      case 'ml': return `ml:${seg}`;
      default: return m.kind + ':' + m.ticker;
    }
  }


  // ladder identity: rungs of one underlying bet whose YES probability falls as the line rises
  function ladderKey(m) {
    if (!m?.th || m.th.op === '<' || m.book) return null;
    const seg = m.seg || 'G';
    switch (m.kind) {
      case 'prop': return `prop:${m.espnId || m.player}:${m.stat}`;
      case 'total': return `total:${seg}`;
      case 'teamtotal': return `tt:${seg}:${m.side}`;
      case 'spread': return `sp:${seg}:${m.side}`;
    }
    return null;
  }
  // weighted isotonic regression, non-increasing in x (pool-adjacent-violators); returns Map x → fitted value
  function isoDec(pts) {
    const st = [];
    for (const q of [...pts].sort((a, b) => a.x - b.x)) {
      st.push({ y: q.y, w: q.w, xs: [q.x] });
      while (st.length > 1 && st[st.length - 2].y < st[st.length - 1].y) { const b = st.pop(), a = st.pop(), w = a.w + b.w; st.push({ y: (a.y * a.w + b.y * b.w) / w, w, xs: a.xs.concat(b.xs) }); }
    }
    const out = new Map(); for (const blk of st) for (const x of blk.xs) out.set(x, blk.y); return out;
  }
  // market curve at any line: interpolated between fitted quotes (probit space); beyond them, the model's own
  // shape carried by the nearest quote's market-vs-model shift
  const zq = (q) => U.normInv(U.clamp(q, 0.002, 0.998));
  function curveAt(F, L, modelAtL) {
    const xs = [...F.curve.keys()].sort((a, b) => a - b);
    if (F.curve.has(L)) return F.curve.get(L);
    const lo = [...xs].reverse().find((x) => x < L), hi = xs.find((x) => x > L);
    if (lo != null && hi != null) { const t = (L - lo) / (hi - lo); return U.normCdf(zq(F.curve.get(lo)) + t * (zq(F.curve.get(hi)) - zq(F.curve.get(lo)))); }
    const e = lo != null ? lo : hi, mE = F.model.get(e), mL = modelAtL ?? F.model.get(L);
    if (mE == null || mL == null) return F.curve.get(e);
    return U.normCdf(zq(mL) + zq(F.curve.get(e)) - zq(mE));
  }

  function evaluate(g) {
    const rec = INTEL.get(g.id);
    const ls = g.ls || MODEL.liveState(g);
    const kmk = KALSHI.marketsFor(g.kkey);
    const mk = [...kmk, ...bookMarkets(g, kmk, ls)];
    const ctx = { ls, sEff: g.sEff ?? g.pre?.spread ?? 2, tEff: g.tEff ?? g.pre?.total ?? 229 };
    const now = Date.now();
    const out = [], pending = [], rejected = [], rows = [];
    for (const m of mk) {
      if (m.yesAsk == null && m.noAsk == null) continue;
      let fp = null, kind = m.kind, why = [], data = {}, unc;
      if (m.kind === 'prop') {
        if (!rec) { pending.push(m); continue; }
        let p = m.espnId ? rec.players.get(m.espnId) : null;
        if (!p && m.player) { const hit = [...rec.players.values()].find((x) => U.nameScore(x.name, m.player) >= 0.8); if (hit) { p = hit; m.espnId = hit.espnId; } }
        if (!p?.proj) { pending.push(m); continue; }
        const lb = !ls.pre ? liveBoxFor(g, rec, p.espnId, p.name) : null;
        if (!(lb && (lb.min > 0 || lb.played)) && !p.st?.ok) { rejected.push({ m, reason: `ROSTER: ${p.st?.code || 'UNVERIFIED'}` }); continue; }
        if (!lb && !ls.pre && !ls.post) { pending.push(m); continue; } // waiting on the live box score
        if (lb && !ls.post) fp = MODEL.propLiveProb(p.proj, m.stat, m.th, lb, ls);
        else if (ls.pre) fp = MODEL.propPregameProb(p.proj, m.stat, m.th);
        if (!fp) continue;
        if (fp.hit) continue;
        const nEff = p.proj.nEff;
        const playP = lb ? 1 : (INTEL.PLAY_P[p.st?.code] ?? 1); // own DNP risk (QUESTIONABLE 0.82, PROBABLE 0.97)
        if (playP < 1) fp = { ...fp, p: fp.p * playP };
        unc = (lb ? 0.03 + 0.08 / Math.sqrt(nEff + 1) : 0.035 + 0.12 / Math.sqrt(nEff + 1)) + (playP < 1 ? 0.03 : 0);
        data = { player: p, live: lb, fp, playP };
      } else if (['ml', 'spread', 'total', 'teamtotal', 'margin', 'ot'].includes(m.kind)) {
        if (!INTEL.reportLoaded(rec)) { rejected.push({ m, reason: 'ROSTER: game-day injury report not loaded' }); continue; }
        fp = MODEL.lineProb(m, g, ctx);
        if (!fp) continue;
        unc = (ls.pre ? 0.02 : 0.025) + (m.seg ? 0.01 : 0);
        data = { fp };
      } else continue;
      if (fp.p == null || !isFinite(fp.p)) continue;
      const pModel = fp.p;
      // ---- lag tracking: fair value at the moment the market last re-quoted ----
      const q = atQuote.get(m.ticker);
      if (!q || q.quoteAt !== m.quoteAt) atQuote.set(m.ticker, { quoteAt: m.quoteAt, p: pModel });
      const base = atQuote.get(m.ticker);
      const move = pModel - base.p;
      // the event that should have moved this market: the player's own stat for props, any score for lines
      let evAt = g.lastScoreAt || 0;
      if (m.kind === 'prop') evAt = Math.max(0, ...(MODEL.COMBO[m.stat] || [m.stat]).map((k) => STATE.statAt.get(`${data.player.espnId}:${k}`) || 0));
      const sinceScore = evAt ? (now - evAt) / 1000 : Infinity;
      const delayed = m.snapAt ? (now - m.snapAt) / 60000 : 0; // minutes behind (published snapshot)
      if (delayed) unc += ls.pre ? 0.005 : Math.min(0.04, 0.012 * delayed);
      const quoteStale = !m.book && !m.snapAt && !!evAt && m.quoteAt < evAt && sinceScore < 120;
      const stale = quoteStale && sinceScore > 1.5 && Math.abs(move) >= 0.025;
      const lag = stale ? { sec: Math.round((now - m.quoteAt) / 1000), sinceScore: Math.round(sinceScore), move } : null;
      rows.push({ m, fp, kind, data, unc, pModel, quoteStale, lag, move, delayed });
    }

    // ---- pass 2: one market curve per ladder ----
    // Each ladder (a player's PRA 20+/25+/30+, a total's lines, a team's spread lines) gets ONE monotone market curve
    // fitted to its quotes (isotonic, weighted by liquidity), and ONE model weight for the whole ladder. Thin rungs
    // borrow the curve from liquid neighbours instead of being blended (or not) on their own noisy quote, so the
    // final probabilities can never run backwards (30+ above 25+), and a thin rung priced below its own ladder is
    // a real, explainable edge rather than an automatic reject.
    const fams = new Map();
    for (const r of rows) {
      const k = ladderKey(r.m); if (!k || r.m.prot) continue;
      (fams.get(k) || fams.set(k, { rows: [] }).get(k)).rows.push(r);
    }
    for (const [k, F] of fams) {
      F.rows.sort((a, b) => a.m.th.line - b.m.th.line);
      F.model = new Map(F.rows.map((r) => [r.m.th.line, r.pModel]));
      const pts = [];
      for (const r of F.rows) {
        const m = r.m, sp = m.yesAsk != null && m.yesBid != null ? m.yesAsk - m.yesBid : null;
        if (sp == null || sp > 0.25 || !(m.yesBid > 0)) continue;
        pts.push({ x: m.th.line, y: (m.yesAsk + m.yesBid) / 2, w: (1 + Math.log1p(m.vol || 0)) / (sp + 0.02) ** 2, liquid: sp <= 0.06 });
      }
      F.liquid = pts.some((q) => q.liquid);
      F.curve = pts.length ? isoDec(pts) : null;
      if (!F.curve) continue;
      // one model weight for the ladder
      const r0 = F.rows[0], isProp = r0.m.kind === 'prop';
      // model weight: props by sample size; game lines 0.65 live, pregame 0.45 for the full game and 0.3 for a quarter/half
      // (pregame segment splits are structural estimates; Kalshi's segment ladders are the better pregame read)
      let w = isProp ? (r0.data.live ? 0.62 : 0.55) + Math.min(0.1, (r0.data.player.proj.nEff || 0) / 300) : !ls.pre ? 0.65 : r0.m.seg ? 0.3 : 0.45;
      if (isProp && !r0.data.live) { const nCur = r0.data.player.proj.cur?.length || 0; if (nCur < 10) w *= 0.8 + 0.02 * nCur; }
      let gs = 0, gw = 0; for (const q of pts) { gs += q.w * Math.abs(F.model.get(q.x) - F.curve.get(q.x)); gw += q.w; }
      const gapF = gw ? gs / gw : 0;
      if (gapF > 0.12) w *= U.clamp(1 - (gapF - 0.12) / 0.45, isProp ? 0.45 : 0.5, 1);
      F.w = w; F.gap = gapF;
      for (const r of F.rows) {
        const L = r.m.th.line, prior = curveAt(F, L);
        const wr = r.quoteStale ? 0.85 : w; // a quote that predates the latest basket carries little information (LAG)
        r.blend = { p: wr * r.pModel + (1 - wr) * prior, prior, w: wr, gap: r.pModel - prior };
        if (Math.abs(r.pModel - prior) > 0.25) r.unc += 0.03;
      }
      // final guarantee: the ladder's probabilities never increase with the line
      const fin = isoDec(F.rows.map((r) => ({ x: r.m.th.line, y: r.blend.p, w: 1 })));
      for (const r of F.rows) r.blend.p = fin.get(r.m.th.line);
      F.fit = [...F.rows].map((r) => ({ L: r.m.th.line, p: r.blend.p, model: r.pModel, prior: r.blend.prior }));
    }

    // ---- pass 3: gates and picks ----
    for (const r of rows) {
      const { m, kind, data, lag, move, delayed } = r;
      let unc = r.unc, fp = r.fp, gap = 0;
      const pModel = r.pModel, mmid = MODEL.mid(m);
      const F = fams.get(ladderKey(m));
      if (r.blend) { gap = r.blend.gap; fp = { ...fp, p: r.blend.p, pModel, mmid, prior: r.blend.prior, wModel: r.blend.w, gap, ladder: F.rows.length }; }
      else if (m.prot && F?.fit) {
        // protected-ladder twin of a regular rung: same event, so it takes the regular ladder's probability
        const t = F.fit.find((x) => Math.abs(x.L - m.th.line) < 1e-6);
        fp = { ...fp, p: t ? t.p : pModel, pModel, mmid, wModel: 1, gap: 0 };
      } else {
        // markets outside a ladder (moneylines, margins, OT): blend with their own liquid quote while live
        let pFair = pModel, wModel = 1;
        if (m.kind !== 'prop' && !m.book && !ls.pre && mmid != null && m.yesAsk - m.yesBid <= 0.08) {
          gap = pModel - mmid;
          wModel = r.quoteStale ? 0.85 : 0.65;
          if (!r.quoteStale && Math.abs(gap) > 0.12) wModel *= U.clamp(1 - (Math.abs(gap) - 0.12) / 0.45, 0.5, 1);
          pFair = wModel * pModel + (1 - wModel) * mmid;
        }
        fp = { ...fp, p: pFair, pModel, mmid, wModel, gap };
      }
      data.fp = fp;

      // trend sanitization inputs (props): hit history at this threshold vs the context-adjusted projection
      let trend = null;
      if (m.kind === 'prop' && m.th?.k != null && !data.live) {
        const pr = data.player.proj, hh = MODEL.hitHistory(pr.games, m.stat, m.th.k, data.player.ctx.season);
        const muAdj = pr.proj[m.stat]?.mu;
        if (hh && muAdj != null) trend = { hh, muAdj, l10: hh.l10.n ? hh.l10.h / hh.l10.n : 0, regress: isFinite(hh.avg10) && muAdj < hh.avg10 * 0.95 };
      }
      for (const yes of [true, false]) {
        if (m.kind === 'prop' && (!yes || m.th?.op === '<')) continue; // player props: overs only (buy YES on "X+")
        const price = yes ? m.yesAsk : m.noAsk;
        if (price == null || price <= 0.02 || price >= 0.96) continue; // no value in 97¢+ contracts
        const fair = yes ? fp.p : 1 - fp.p;                 // algorithmic true winning probability
        const implied = price;                               // market implied winning probability (ask / book price)
        const netEdge = fair - implied;
        const fee = m.book ? 0 : U.fee(price);               // sportsbook prices already include the vig
        const cost = price + fee, ev = fair - cost, roi = ev / cost;
        const safety = unc * 0.8 + 0.005;
        const BE = m.book ? (x) => U.clamp(x, 0, 1) : U.breakEven;
        const fairMax = BE(fair);                            // above this: negative EV after fees
        const buyMax = Math.min(Math.max(0, fair - 0.04), BE(Math.max(0, fair - safety))); // ≥4.00 pts edge and model-error margin
        const kellyFull = ev > 0 ? ev / (1 - cost) : 0;
        const scale = Math.round(U.clamp((kellyFull * 0.25) / 0.03 * 10 * (1 - Math.min(0.5, unc * 3)), 0, 10) * 10) / 10;
        // ---- Phase 2 gates ----
        const spreadQ = m.book ? 0 : (m.yesAsk != null && m.yesBid != null ? m.yesAsk - m.yesBid : 1);
        const bidSide = m.book ? 1 : yes ? m.yesBid : m.noBid;
        // expected log-growth of full Kelly (KL divergence): balances edge against hit rate
        const growth = ev > 0 ? fair * Math.log(fair / cost) + (1 - fair) * Math.log((1 - fair) / Math.max(1e-6, 1 - cost)) : 0;
        let reason = null;
        let thin = null;
        if (!m.book && (spreadQ > 0.12 || !(bidSide > 0.005))) {
          // a thin rung is tradable at its ask; keep it only when the liquid rungs of the same ladder price it higher
          // than the ask (the market contradicts itself) and the edge is at least +6.00%
          const prior = fp.prior != null ? (yes ? fp.prior : 1 - fp.prior) : null;
          if (F?.liquid && prior != null && price <= prior - 0.02 && netEdge >= 0.06) thin = { prior };
          else reason = `ILLIQUID: ${!(bidSide > 0.005) ? 'no resting bid' : `bid-ask spread ${Math.round(spreadQ * 100)}¢`}${prior != null ? ` (ladder values it at ${Math.round(prior * 100)}¢)` : ''}`;
        }
        else if (delayed > 10) reason = `PRICE STALE: Kalshi feed ${Math.round(delayed)} min old (> 10 min)`;
        else if (r.blend && F?.liquid && F.gap > 0.22 && !r.quoteStale) reason = `MARKET CONFLICT: model ${(pModel * 100).toFixed(0)}% vs Kalshi's liquid ladder ${(fp.prior * 100).toFixed(0)}% — a gap this large usually means the model is missing news (minutes, role, injury)`;
        else if (netEdge < 0.04 || ev <= 0) reason = `EDGE ${U.signed(netEdge * 100, 2)}% < +4.00% minimum`;
        else if (fair < 0.30 && !(netEdge >= 0.10 && roi >= 0.6)) reason = `TRUE PROBABILITY ${(fair * 100).toFixed(2)}% < 30.00% floor`;
        else if (trend && trend.l10 >= 0.7 && trend.regress) reason = `TREND SANITIZED: L10 ${trend.hh.l10.h}/${trend.hh.l10.n} but projection ${trend.muAdj.toFixed(1)} < 95% of L10 avg ${trend.hh.avg10.toFixed(1)}`;
        const spreadW = m.book ? 0.04 : m.yesAsk != null && m.yesBid != null ? m.yesAsk - m.yesBid : 0.1;
        let raw = 62 + 14 * ((netEdge - Math.max(0.04, safety)) / 0.05) + 10 * (fair - 0.5);
        if (data.player) raw += data.player.proj.nEff >= 15 ? 3 : data.player.proj.nEff < 6 ? -6 : 0;
        if (spreadW > 0.06) raw -= 6; if (m.vol < 50) raw -= 4;
        if (lag && Math.sign(move) === (yes ? 1 : -1)) raw += 4;
        if (Math.abs(gap) > 0.25) raw -= 8;
        const rating = Math.round(U.clamp(40 + 59 * (1 - Math.exp(-Math.max(0, raw - 40) / 30)), 30, 99));
        const tier = rating >= 90 ? 'HOF' : rating >= 83 ? 'GOLD' : rating >= 76 ? 'SILVER' : rating >= 70 ? 'BRONZE' : '';
        const lb = labels(m, g, yes);
        out.push({
          id: m.ticker + (yes ? ':Y' : ':N'), ticker: m.ticker, gameId: g.id, kind, seg: m.seg, stat: m.stat, side: yes ? 'YES' : 'NO',
          label: lb.t, sub: lb.s, price, implied, fair, netEdge, edge: netEdge, ev, cost, fee, roi, be: fairMax, fairMax, maxEntry: buyMax, buyMax, kelly: kellyFull * 0.25, scale, unc, safety, rating, tier,
          survivor: !reason, reason, trend, growth, fam: famKey(m, yes), thin,
          playable: !reason && price <= buyMax + 1e-9,
          lag: lag && Math.sign(move) === (yes ? 1 : -1) ? lag : null,
          live: !ls.pre, liq: { spread: spreadW, vol: m.vol, oi: m.oi }, m, data, yes, book: m.book || null, delayed: delayed || 0, am: m.book ? (yes ? m.yesAm : m.noAm) : null,
        });
      }
    }
    // keep the better side per market for ranking
    const best = new Map();
    for (const p of out) { const b = best.get(p.ticker); if (!b || p.edge > b.edge) best.set(p.ticker, p); }
    const picks = [...best.values()].sort((a, b) => (b.survivor - a.survivor) || b.netEdge - a.netEdge);
    const survivors = picks.filter((p) => p.survivor);
    const audit = { priced: picks.length, survived: survivors.length, edge: 0, floor: 0, trend: 0, illiquid: 0, stale: 0, conflict: 0, roster: rejected.length };
    for (const p of picks) if (p.reason) { if (/^EDGE/.test(p.reason)) audit.edge++; else if (/FLOOR|floor/.test(p.reason)) audit.floor++; else if (/TREND/.test(p.reason)) audit.trend++; else if (/ILLIQUID/.test(p.reason)) audit.illiquid++; else if (/STALE/.test(p.reason)) audit.stale++; else if (/CONFLICT/.test(p.reason)) audit.conflict++; }
    const pricedKeys = new Set(picks.filter((p) => p.kind === 'prop').map((p) => `${p.data.player.espnId}:${p.stat}`));
    const models = modelPicks(g, rec, ls, pricedKeys);
    updateFeed(g, picks);
    return { picks, survivors, audit, rejected, models, all: out, pending, fams, at: now };
  }

  function updateFeed(g, picks) {
    let f = FEED.get(g.id); if (!f) { f = new Map(); FEED.set(g.id, f); }
    const now = Date.now();
    const seen = new Set();
    for (const p of picks) {
      if (!p.playable) continue;
      seen.add(p.id);
      let e = f.get(p.id);
      if (!e || !e.active) {
        e = { key: p.id, gameId: g.id, label: p.label, sub: p.sub, side: p.side, firstSeen: now, lastSeen: now, active: true, entry: p.price, fair0: p.fair, edge0: p.edge, peakEdge: p.edge, live: p.live, lag: !!p.lag, kind: p.kind, rating: p.rating, tier: p.tier, periodTag: g.ls && !g.ls.pre ? `${U.periodShort(g.ls.period)} ${U.fmtClock(g.ls.clockSec)}` : 'Pregame', reopened: !!(e && !e.active) };
        f.set(p.id, e);
      }
      e.lastSeen = now; e.price = p.price; e.fair = p.fair; e.edge = p.edge; e.peakEdge = Math.max(e.peakEdge, p.edge); e.rating = p.rating; e.tier = p.tier; e.lag = e.lag || !!p.lag;
    }
    for (const e of f.values()) if (e.active && !seen.has(e.key) && now - e.lastSeen > 8000) { e.active = false; e.closedAt = now; }
    persist();
  }

  // ---- Phase 3 evidence: four quantified sections + verified roster line ----
  const P2 = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(2) + '%');
  const f3 = (x) => (x == null || !isFinite(x) ? '—' : x.toFixed(3));
  const f1 = (x) => (x == null || !isFinite(x) ? '—' : x.toFixed(1));
  const NA = 'not in public feed — not applied';
  function statusLine(p, g) {
    const rec = INTEL.get(g.id);
    const rep = `${INTEL.reportSummary(rec, g, 'away')}; ${INTEL.reportSummary(rec, g, 'home')}${rec?.sumAt ? ` (report pulled ${U.ago(rec.sumAt)})` : ''}`;
    if (p.kind === 'prop' && !p.modelOnly) {
      const pl = p.data.player, st = pl.st || {};
      return `${pl.name}: ${st.code || 'UNVERIFIED'} — ${st.src || ''}${st.detail ? ` (${st.detail})` : ''}${p.data.playP < 1 ? `; DNP risk priced at ${P2(1 - p.data.playP)}` : ''}. Game report — ${rep}.`;
    }
    if (p.modelOnly) { const pl = p.data.player, st = pl.st || {}; return `${pl.name}: ${st.code || 'UNVERIFIED'} — ${st.src || ''}. Game report — ${rep}.`; }
    return `Game report — ${rep}. Players not listed are treated as fully active.`;
  }
  function evidence(p, g) {
    const rec = INTEL.get(g.id), ls = g.ls, m = p.m;
    const pm = rec?.poss || INTEL.possModel(g);
    const sec = { arb: [], pace: [], rot: [], match: [] };
    const priceTxt = p.price == null ? 'No live price' : p.book ? `${p.book} ${fmtAm(p.am)} → ${P2(p.implied)}` : `Kalshi ask $${p.price.toFixed(2)} → ${P2(p.implied)}`;
    if (p.kind === 'prop') {
      const pl = p.data.player, pr = pl.proj, st = m.stat, S = MODEL.SHORT[st] || st, k = m.th?.k, fp = p.data.fp, cx = pl.ctx || {};
      const prj = pr.proj[st] || {}, sd = fp.sd || Math.sqrt(prj.variance || 0), mu = fp.mu ?? prj.mu;
      // ---- DISCREPANCY ARBITRAGE ----
      if (!p.modelOnly) {
        const mktMu = sd > 0 ? (k - 0.5) - sd * U.normInv(1 - p.price) : null;
        sec.arb.push(`${priceTxt}. Model P(${S} ≥ ${k}) = ${P2(fp.pModel ?? fp.p)} from a ${f1(mu)} ± ${f1(sd)} projection${fp.prior != null ? `; Kalshi ladder curve ${P2(fp.prior)} (one monotone curve fitted to all ${fp.ladder} ${S} lines, weighted by liquidity) at ${Math.round((1 - fp.wModel) * 100)}% weight` : fp.mmid != null && fp.wModel < 1 ? `; market-prior blend (${Math.round((1 - fp.wModel) * 100)}% weight on mid ${P2(fp.mmid)})` : ''} → true ${P2(p.fair)}.`);
        if (p.thin) sec.arb.push(`Thin book (wide spread or no bid) — kept because the liquid lines of the same ladder value this contract at ${(p.thin.prior * 100).toFixed(0)}¢, above the ${(p.price * 100).toFixed(0)}¢ ask, and the edge clears +6%.`);
        if (mktMu != null && isFinite(mktMu)) sec.arb.push(`The ask prices a ${f1(mktMu)} ${S} mean under the same σ; the model projects ${f1(mu)} (${U.signed(mu - mktMu, 1)}).`);
        sec.arb.push(`Net edge ${U.signed(p.netEdge * 100, 2)}%; after the ${m.book ? 'book vig' : `$${p.fee.toFixed(3)} taker fee`} EV ${p.ev >= 0 ? '+' : '−'}$${Math.abs(p.ev).toFixed(3)} per $1 contract (ROI ${U.signed(p.roi * 100, 1)}%).`);
      } else {
        sec.arb.push(`No live Kalshi quote on this line: model ${P2(fp.p)} vs ${fp.liveBase ? 'pregame model' : 'season-average baseline'} ${P2(fp.base)}. Not edge-verified; buy only at ≤ $${p.maxEntry.toFixed(2)}.`);
      }
      const hh = p.trend?.hh || MODEL.hitHistory(pr.games, st, k, cx.season);
      if (hh) sec.arb.push(`Trend audit at ${k}+: L5 ${hh.l5.h}/${hh.l5.n}, L10 ${hh.l10.h}/${hh.l10.n}, L20 ${hh.l20.h}/${hh.l20.n}; L10 avg ${f1(hh.avg10)} vs projection ${f1(prj.mu)} — ${prj.mu >= hh.avg10 * 0.95 ? 'no regression conflict' : 'projection below the trend (trend carries no weight)'}.`);
      if (p.lag) sec.arb.push(`Stale quote: unchanged ${p.lag.sec}s after ${pl.name}'s stat moved ${p.lag.sinceScore}s ago; fair value shifted ${U.signed(p.lag.move * 100, 1)} pts.`);
      if (p.delayed) sec.arb.push(`Price from the published Kalshi feed, ${U.ago(m.snapAt)}; uncertainty widened by ${f1(Math.min(4, 1.2 * p.delayed))} pts.`);
      // ---- POSSESSION & PACE MODEL ----
      const team = g[pl.side], opp = g[pl.side === 'home' ? 'away' : 'home'];
      if (cx.poss) sec.pace.push(`Projected possessions ${f1(cx.poss)} = ${team.abbr} ${f1(cx.teamPace)} × ${opp.abbr} ${f1(pl.side === 'home' ? pm.paceA : pm.paceH)} ÷ league ${f1(pm.lgPace)} (${pm.src}). ${team.abbr} baseline ${f1(cx.teamPace)} → volume ×${f3(cx.paceF)}.`);
      if (cx.defF) sec.pace.push(`${opp.abbr} allows ${f1(cx.oppDrtg)} pts/100 poss vs league ${f1(cx.lgRtg)} → efficiency ×${f3(cx.defF)} (applied to PTS ×1.0, 3PM ×0.8, AST ×0.5).`);
      if (cx.marketF != null) sec.pace.push(`Market-implied ${team.abbr} total ${f1(cx.impliedPts)} vs ${f1(cx.teamAvgPts)} season avg (×${f3(cx.marketF)}); blended 50/50 → ${S} environment ×${f3(pr.env?.[MODEL.COMBO[st] ? 'pts' : st])}.`);
      if (!ls.pre && ls.elapsed > 2) sec.pace.push(`Live: ${ls.total} pts in ${f1(ls.elapsed)} min = ${f1(ls.total / ls.elapsed * 48)} pts/48 vs pregame total ${f1(g.pre?.total)}; ${f1(ls.rem)} min remaining.`);
      const vH = pm.h.venue, vA = pm.a.venue;
      if (vH || vA) sec.pace.push(`Venue pace (scouted box scores): ${g.home.abbr} ${vH ? `${f1(vH.pace)} at home (n=${vH.n})` : 'home split n/a'} vs ${f1(pm.h.seasonPace ?? pm.paceH)} season; ${g.away.abbr} ${vA ? `${f1(vA.pace)} on the road (n=${vA.n})` : 'road split n/a'} vs ${f1(pm.a.seasonPace ?? pm.paceA)} season.`);
      const sf = cx.scoutF || {};
      if (sf.trans) sec.pace.push(`Transition: ${team.abbr} ${f1(sf.trans.fbFor)} fast-break pts/g vs ${opp.abbr} allowing ${f1(sf.trans.fbAg)} (league ${SCOUT.LG.fb}) → ×${f3(sf.trans.f)}.${sf.paint ? ` Paint: ${opp.abbr} allows ${f1(sf.paint.ag)} paint pts/g (league ${SCOUT.LG.paint}).` : ''}`);
      if (!sf.have) sec.pace.push('Opponent scouting (last 4 box scores) loading — venue pace and transition factors pending.');
      // ---- ROTATIONAL & USAGE MATH ----
      if (p.data.live) {
        const lb = p.data.live;
        sec.rot.push(`Live: ${fp.cur} ${S} in ${f1(lb.min)} min, ${lb.pf} PF, ${lb.oncourt ? 'on court' : 'on bench'}; needs ${Math.max(0, (k ?? 0) - fp.cur)} more in ${f1(fp.r)} projected remaining min.`);
        for (const n of fp.notes || []) sec.rot.push(n + '.');
      }
      sec.rot.push(`Minutes ${f1(pr.minProj)} projected (weighted ${f1(pr.minBase)}, L5 ${f1(pr.l5min)}).`);
      const fat = pr.fat || cx.fat;
      sec.rot.push(fat?.known ? (fat.flags.length ? `Fatigue matrix: ${fat.flags.join('; ')}.` : `Fatigue matrix: ${fat.since - 1} days rest, ${fat.in4} games in 4 nights, ${fat.road7} road games in 7, ${fat.tz} time-zone shift — no penalty.`) : 'Fatigue matrix: schedule not loaded — no penalty applied.');
      const u = pr.usage || {};
      if (u.all != null) sec.rot.push(`Usage proxy (FGA + 0.44·FTA + TOV)/min: ${f3(u.all)} (L5 ${f3(u.l5)}).`);
      for (const x of u.mates || []) sec.rot.push(`Without ${x.name} (${x.code}, official; ${x.n} games): usage ${f3(x.without)}/min vs ${f3(x.with)} with (${U.signed((x.without / x.with - 1) * 100, 1)}%).`);
      for (const n of pr.notes.filter((n) => n.k === 'inj' || n.k === 'blowout')) sec.rot.push(n.t + '.');
      for (const n of pr.notes.filter((n) => n.k === 'min')) sec.rot.push(n.t + '.');
      const nw = cx.news || {};
      sec.rot.push(`Minutes restriction: ${pl.st?.code === 'MINUTES RESTRICTION' ? 'listed on the game report' : 'none on the game report'}; ESPN team news (48h): ${nw.items?.length ? nw.items.slice(0, 2).map((a) => `"${a.head}"`).join('; ') : 'no minutes, role or availability items'}.`);
      // ---- MATCHUP & DEFENSIVE AUDIT ----
      const d = pl.matchup;
      if (d) sec.match.push(d.stl36 != null ? `Estimated primary defender ${d.name} (${d.pos || '—'}, ${f1(d.min)} proj min): ${f1(d.stl36)} STL / ${f1(d.blk36)} BLK / ${f1(d.pf36)} PF per 36 (≈${f1(d.stlPct)} steals and ${f1(d.blkPct)} blocks per 100 possessions on the floor, last ${d.n}); disruption z ${U.signed(d.z, 2)} → ×${f3(d.f)} on scoring.` : `Estimated primary defender ${d.name} (${d.pos || '—'}); defensive logs not loaded.`);
      sec.match.push(`${opp.abbr} team defense ${f1(cx.oppDrtg)} pts/100 poss${cx.oppDefRank ? ` (#${cx.oppDefRank} in points allowed)` : ''}.`);
      const h2h = pr.games.filter((r) => r.opp === cx.opp).slice(0, 5);
      if (h2h.length) sec.match.push(`vs ${cx.opp} last ${h2h.length}: ${h2h.map((r) => MODEL.statVal(r, st)).join(', ')} ${S}${prj.h2hF && Math.abs(prj.h2hF - 1) > 0.005 ? ` → ×${f3(prj.h2hF)}` : ' (no adjustment)'}.`);
      const spl = pl.splits, key = ['pts', 'reb', 'ast', 'fg3m'].includes(st) ? st : 'pts';
      if (spl?.topD && spl?.botD) sec.match.push(`vs top-10 defenses ${f1(spl.topD[key])} (n=${spl.topD.n}) / bottom-10 ${f1(spl.botD[key])} (n=${spl.botD.n}) ${MODEL.SHORT[key]}; home ${f1(spl.home?.[key])} / away ${f1(spl.away?.[key])}.`);
      const sc = cx.scoutF || {};
      if (sc.dvp) sec.match.push(`Defense vs ${sc.dvp.G === 'G' ? 'guards' : sc.dvp.G === 'C' ? 'centers' : 'forwards'} (${opp.abbr}, last ${sc.dvp.n}): ${f1(sc.dvp.pts)} pts / ${f1(sc.dvp.reb)} reb / ${f1(sc.dvp.ast)} ast / ${f1(sc.dvp.fg3m)} 3PM allowed per game → PTS ×${f3(Math.sqrt(sc.dvp.f.pts))}, REB ×${f3(Math.sqrt(sc.dvp.f.reb))}, AST ×${f3(Math.sqrt(sc.dvp.f.ast))}.`);
      if (sc.zone) { const ZN = { rim: 'rim', paint: 'paint', mid: 'mid-range', c3: 'corner 3', ab3: 'above-break 3' }; sec.match.push(`Shot-zone matchup — ${pl.name}'s mix (${sc.zone.nShots >= 15 ? sc.zone.nShots + ' scouted shots' : 'position default'}): ${Object.entries(sc.zone.share).filter(([, v]) => v > 0.04).map(([z, v]) => `${ZN[z]} ${Math.round(v * 100)}%`).join(', ')}; ${opp.abbr} allows ${Object.entries(sc.zone.zd).map(([z, x]) => `${ZN[z]} ${(x.fg * 100).toFixed(1)}%`).join(', ')} (${sc.zone.att} shots) → scoring ×${f3(Math.pow(sc.zone.zoneF, 0.6))}, 3PM ×${f3(sc.zone.threeF)}.`); }
      if (sc.type) { const TN = { cs: 'catch-and-shoot', od: 'off-dribble (iso / P&R)', drive: 'drives', cut: 'cuts / putbacks', post: 'post-ups' }; sec.match.push(`Shot-type matchup (play-type proxy from play-by-play): ${Object.entries(sc.type.share).filter(([, v]) => v > 0.05).map(([t, v]) => `${TN[t]} ${Math.round(v * 100)}%`).join(', ')}; ${opp.abbr} eFG allowed ${Object.entries(sc.type.td).map(([t, x]) => `${TN[t]} ${(x.efg * 100).toFixed(1)}%`).join(', ')} → ×${f3(Math.sqrt(sc.type.typeF))}.`); }
      if (!sc.have) sec.match.push('Opponent scouting (defense vs position, shot-zone and shot-type defense) loading from the last 4 box scores.');
    } else {
      // ---- game lines ----
      const pre = g.pre?.src || {}, fp = p.data.fp;
      const bits = [];
      if (pre.bookSpread != null) bits.push(`${pre.book || 'book'} ${pre.bookSpread >= 0 ? g.home.abbr : g.away.abbr} −${Math.abs(pre.bookSpread).toFixed(1)}`);
      if (pre.bookTotal) bits.push(`O/U ${pre.bookTotal}`);
      if (pre.bookP != null) bits.push(`no-vig ML ${P2(pre.bookP)} ${g.home.abbr}`);
      if (pre.bpi != null) bits.push(`ESPN BPI ${P2(pre.bpi)}`);
      if (pre.kalshiSpread != null) bits.push(`Kalshi spread ladder ${U.signed(pre.kalshiSpread, 1)}`);
      if (pre.kalshiTotal != null) bits.push(`Kalshi total ladder ${f1(pre.kalshiTotal)}`);
      sec.arb.push(`${priceTxt}. Model ${P2(p.fair)} (${fp.mu != null ? `mean ${U.signed(fp.mu, 1)} ± ${f1(fp.sd)}` : 'segment model'}). Consensus inputs: ${bits.join(', ') || 'Kalshi prices only'}.`);
      if (p.netEdge != null) sec.arb.push(`Net edge ${U.signed(p.netEdge * 100, 2)}%; EV ${p.ev >= 0 ? '+' : '−'}$${Math.abs(p.ev).toFixed(3)} per $1 (ROI ${U.signed(p.roi * 100, 1)}%).`);
      else sec.arb.push('No Kalshi market at this line — model probability only.');
      if (p.lag) sec.arb.push(`Stale quote: unchanged ${p.lag.sec}s after a score ${p.lag.sinceScore}s ago; fair value moved ${U.signed(p.lag.move * 100, 1)} pts.`);
      if (p.delayed) sec.arb.push(`Price from the published Kalshi feed, ${U.ago(m.snapAt)}.`);
      sec.pace.push(`Projected possessions ${f1(pm.poss)} = ${g.home.abbr} ${f1(pm.paceH)} × ${g.away.abbr} ${f1(pm.paceA)} ÷ league ${f1(pm.lgPace)} (${pm.src}). Consensus total ${f1(g.pre?.total)}; model total ${f1(MODEL.totalDist(g.ls, g.tEff ?? g.pre?.total, g).mu)} ± ${f1(MODEL.totalDist(g.ls, g.tEff ?? g.pre?.total, g).sd)}.`);
      if (!ls.pre && ls.elapsed > 2) sec.pace.push(`Live: ${g.away.abbr} ${g.away.score}–${g.home.score} ${g.home.abbr}, ${U.periodShort(ls.period)} ${U.fmtClock(ls.clockSec)}; ${f1(ls.total / ls.elapsed * 48)} pts/48${g.run && g.run.pts - g.run.opp >= 6 ? `; ${g[g.run.side].abbr} ${g.run.pts}–${g.run.opp} run` : ''}.`);
      for (const side of ['away', 'home']) {
        const l = INTEL.injuriesFor(rec, g, side).filter((x) => /OUT|DOUBTFUL/.test(x.code));
        sec.rot.push(`${g[side].abbr}: ${l.length ? l.map((x) => `${x.name} ${x.code}`).join(', ') : 'no OUT/DOUBTFUL designations'}.`);
      }
      const fh = g.fat?.home, fa = g.fat?.away;
      if (fh?.known || fa?.known) sec.rot.push(`Fatigue matrix — ${g.away.abbr}: ${fa?.flags.length ? fa.flags.join('; ') : 'none'}; ${g.home.abbr}: ${fh?.flags.length ? fh.flags.join('; ') : 'none'}. Differential ${U.signed(g.fatAdj * 2, 1)} pts, applied at 50% weight (${U.signed(g.fatAdj, 1)}) because the consensus partly prices rest.`);
      if (g.sMkt != null) sec.rot.push(`Live strength re-anchored to the market in quiet stretches: ${U.signed(g.sMkt, 1)} vs pregame ${U.signed(g.pre.spread, 1)} → ${U.signed(g.sEff, 1)} used.`);
      const h = pm.h, a = pm.a;
      sec.match.push(`Per 100 possessions — ${g.away.abbr} O ${f1(a.ortg)} / D ${f1(a.drtg)}${a.defRank ? ` (#${a.offRank}/#${a.defRank})` : ''}; ${g.home.abbr} O ${f1(h.ortg)} / D ${f1(h.drtg)}${h.defRank ? ` (#${h.offRank}/#${h.defRank})` : ''}; league ${f1(pm.lgRtg)}.`);
      const ser = rec?.summary?.series;
      if (ser?.events?.length) sec.match.push(`Season series: ${ser.events.map((e) => `${e.away} ${e.as}–${e.hs} ${e.home}`).join(', ')}.`);
      const sH = SCOUT.get(g.home.id), sA = SCOUT.get(g.away.id);
      if (sH && sA) sec.match.push(`Transition: ${g.away.abbr} ${f1(sA.fbFor)} / ${g.home.abbr} ${f1(sH.fbFor)} fast-break pts/g; allowed ${f1(sA.fbAg)} / ${f1(sH.fbAg)}. Paint pts allowed ${f1(sA.paintAg)} / ${f1(sH.paintAg)} (last ${Math.min(sA.n, sH.n)} games).`);
      if (pm.h.venue || pm.a.venue) sec.pace.push(`Venue pace: ${g.home.abbr} ${pm.h.venue ? f1(pm.h.venue.pace) + ' at home' : 'n/a'}, ${g.away.abbr} ${pm.a.venue ? f1(pm.a.venue.pace) + ' on the road' : 'n/a'} (scouted box scores).`);
    }
    return {
      status: statusLine(p, g),
      sections: [
        { k: 'arb', title: 'DISCREPANCY ARBITRAGE', t: sec.arb.join(' ') },
        { k: 'pace', title: 'POSSESSION & PACE MODEL', t: sec.pace.join(' ') },
        { k: 'rot', title: 'ROTATIONAL & USAGE MATH', t: sec.rot.join(' ') },
        { k: 'match', title: 'MATCHUP & DEFENSIVE AUDIT', t: sec.match.join(' ') },
      ],
    };
  }

  // ---- live probability for a HELD position (My Bets / parlay builder): the same model and market prior as
  // the pick engine, plus settlement the instant an outcome is mathematically decided (overs cleared, a
  // quarter or half complete, a final). Returns p for the side held, status live|hit|lost|pending, a plain note.
  function holdProb(L, g) {
    const ls = g.ls || MODEL.liveState(g), md = L.m, mk = KALSHI.market(L.ticker);
    const ctx = { ls, sEff: g.sEff ?? g.pre?.spread ?? 2, tEff: g.tEff ?? g.pre?.total ?? 229 };
    const th = mk?.th || md.th;
    const clock = ls.pre ? U.localTime(g.date) : ls.post ? 'Final' : /HALFTIME/.test(g.statusName || '') ? 'Half' : `${U.periodShort(ls.period)} ${U.fmtClock(ls.clockSec)}`;
    let pY = null, dec = null, note = '';
    const ab = (side) => g[side].abbr;
    if (md.kind === 'prop') {
      const rec = INTEL.get(g.id);
      const pl = rec ? ((md.espnId && rec.players.get(md.espnId)) || [...rec.players.values()].find((x) => U.nameScore(x.name, md.player) >= 0.8)) : null;
      const lb = !ls.pre ? liveBoxFor(g, rec, pl?.espnId || md.espnId, pl?.name || md.player) : null;
      const S = MODEL.SHORT[md.stat] || md.stat, k = th?.k;
      const cur = lb ? (MODEL.COMBO[md.stat] || [md.stat]).reduce((a, s) => a + (lb[s] || 0), 0) : null;
      const nm = md.player || 'Player';
      if (lb && k != null && cur >= k) { dec = 1; note = `${nm} has ${cur} ${S} — cleared ${k}+`; }
      else if (ls.post) { if (lb || STATE.box.get(g.id)) { dec = 0; note = `${nm} finished with ${cur ?? 0} ${S} (needed ${k})`; } else note = 'Waiting for the final box score'; }
      else if (pl?.proj && k != null) {
        const fp = lb ? MODEL.propLiveProb(pl.proj, md.stat, th, lb, ls) : ls.pre ? MODEL.propPregameProb(pl.proj, md.stat, th) : null;
        if (fp) {
          pY = fp.p * (lb ? 1 : (INTEL.PLAY_P[pl.st?.code] ?? 1));
          note = lb ? `${nm} ${cur}/${k} ${S} — needs ${k - cur} more in ~${Math.max(0, fp.r).toFixed(0)} min${fp.notes?.length ? ' · ' + fp.notes.join(', ') : ''}` : `${nm} projects ${fp.mu != null ? fp.mu.toFixed(1) : '—'} ${S} (needs ${k})${pl.st?.code && pl.st.code !== 'ACTIVE' ? ' · ' + pl.st.code : ''}`;
        } else note = 'Waiting for the live box score';
      } else note = pl ? 'Loading game logs' : 'Loading player data';
    } else {
      const m2 = { ...md, th };
      const fp = MODEL.lineProb(m2, g, ctx);
      if (fp) {
        pY = fp.p;
        if (ls.post || (fp.sd != null && fp.sd < 0.05 && !ls.pre)) dec = fp.p >= 0.5 ? 1 : 0;
        const ss = md.seg ? MODEL.segState(g, ls, md.seg) : null;
        // overs that already cleared settle immediately (unders that cleared are already lost)
        if (dec == null && th && (md.kind === 'total' || md.kind === 'teamtotal') && !ls.pre) {
          const curT = md.kind === 'total' ? (ss ? ss.segTotal : ls.total) : (ss ? (md.side === 'home' ? ss.hm : ss.am) : g[md.side]?.score ?? 0);
          if (th.op === '<' ? curT > th.kmax : curT >= th.k) dec = th.op === '<' ? 0 : 1;
        }
        if (dec == null && md.kind === 'ot' && ls.period > 4) dec = 1;
        const segTxt = ss ? `${md.seg}: ${ab('away')} ${ss.am}–${ss.hm} ${ab('home')}${ss.remSeg > 0 && ss.started ? `, ${ss.remSeg.toFixed(1)} min left in it` : ss.started ? ' (final)' : ' (not started)'}` : '';
        const lead = (side) => { const d = side === 'home' ? ls.margin : -ls.margin; return d > 0 ? `${ab(side)} lead by ${d}` : d < 0 ? `${ab(side)} trail by ${-d}` : 'tied'; };
        const heldTeam = ['ml', 'spread', 'margin'].includes(md.kind) ? (L.yes ? md.side : md.side === 'home' ? 'away' : 'home') : null;
        if (ls.pre) note = md.kind === 'total' || md.kind === 'teamtotal' ? `Model projects ${fp.mu != null ? fp.mu.toFixed(1) : '—'} (line ${th?.line ?? '—'})` : `Model: ${U.pct(L.yes ? pY : 1 - pY)} before tip-off`;
        else if (ss) note = segTxt;
        else if (heldTeam && heldTeam !== 'tie') note = `${lead(heldTeam)} · ${clock}`;
        else if (md.kind === 'total') note = `${ls.total} pts so far · on pace for ${fp.mu != null ? fp.mu.toFixed(0) : '—'} (line ${th?.line ?? '—'})`;
        else if (md.kind === 'teamtotal') note = `${ab(md.side)} ${g[md.side].score} pts · on pace for ${fp.mu != null ? fp.mu.toFixed(0) : '—'} (line ${th?.line ?? '—'})`;
        else if (md.kind === 'ot') note = ls.period > 4 ? 'Overtime reached' : `${lead('home')} · ${clock}`;
        // settled: say why in one line
        if (dec != null) {
          const won = (dec === 1) === !!L.yes, fin = `${ab('away')} ${g.away.score}–${g.home.score} ${ab('home')}`;
          if ((md.kind === 'total' || md.kind === 'teamtotal') && !ls.post && !(ss && ss.remSeg <= 0 && ss.started)) {
            const curT = md.kind === 'total' ? (ss ? ss.segTotal : ls.total) : (ss ? (md.side === 'home' ? ss.hm : ss.am) : g[md.side]?.score ?? 0);
            note = `${won ? 'Cleared' : 'Lost'} — ${md.kind === 'teamtotal' ? ab(md.side) + ' already has ' : ''}${curT} pts, already past ${th.line}`;
          } else if (ss) note = `${won ? 'Won' : 'Lost'} — ${segTxt}`;
          else if (md.kind === 'ot' && ls.period > 4) note = `${won ? 'Won' : 'Lost'} — the game went to overtime`;
          else note = `${won ? 'Won' : 'Lost'} — Final: ${fin}`;
        }
      } else note = 'Model not ready for this market';
    }
    // while undecided: use the pick engine's own true probability for this exact side when it priced it this
    // tick (same lag-aware market prior as the pick cards); otherwise blend with a liquid quote here
    if (dec == null && pY != null) {
      const same = (g.eval?.all || []).find((x) => x.id === L.id) || (g.eval?.models || []).find((x) => x.id === L.id);
      if (same && same.fair != null) pY = L.yes ? same.fair : 1 - same.fair;
      else {
        const mid = MODEL.mid(mk);
        const stale = mk && !mk.snapAt && g.lastScoreAt && mk.quoteAt < g.lastScoreAt;
        if (mid != null && mk.yesAsk - mk.yesBid <= 0.1) { const w = stale ? 0.85 : 0.65; pY = w * pY + (1 - w) * mid; }
      }
    }
    if (dec != null) pY = dec;
    const status = dec != null ? ((dec === 1) === !!L.yes ? 'hit' : 'lost') : pY == null ? 'pending' : 'live';
    return { p: pY == null ? null : L.yes ? pY : 1 - pY, status, note, clock, mk };
  }

  // ---- re-price any side at any line: Kalshi's own market at that line when it exists (same numbers as the pick
  // cards), otherwise the model's probability with no tradable price ----
  const ADJ = new Set(['prop', 'spread', 'total', 'teamtotal']);
  const sameSubject = (x, m) => (m.kind === 'prop' ? x.stat === m.stat && ((m.espnId && x.espnId === m.espnId) || U.nameScore(x.player || '', m.player || '') >= 0.8) : m.kind === 'total' ? true : x.side === m.side);
  function findMarket(m, g) {
    if (!m.th) return KALSHI.marketsFor(g.kkey).find((x) => x.kind === m.kind && (x.seg || null) === (m.seg || null) && x.side === m.side) || null;
    const c = KALSHI.marketsFor(g.kkey).filter((x) => x.kind === m.kind && (x.seg || null) === (m.seg || null) && x.th && x.th.op !== '<' && sameSubject(x, m) && (m.kind === 'prop' ? x.th.k === m.th.k : Math.abs(x.th.line - m.th.line) < 1e-6));
    return c.find((x) => !x.prot) || c[0] || null; // the regular market, not its empty "protected" twin
  }
  const thAt = (kind, line) => (kind === 'prop' ? { op: '>=', line: Math.ceil(line) - 0.5, k: Math.ceil(line) } : { op: '>', line, k: Math.floor(line) + 1 });
  // every Kalshi line that exists for this bet (for the line chips)
  function ladder(m, g) {
    if (!ADJ.has(m.kind)) return [];
    return KALSHI.marketsFor(g.kkey).filter((x) => x.kind === m.kind && (x.seg || null) === (m.seg || null) && x.th && x.th.op !== '<' && sameSubject(x, m)).map((x) => x.th.line).sort((a, b) => a - b).filter((v, i, a) => a.indexOf(v) === i);
  }
  /** d: {m:{kind, seg, side, stat, th, range, espnId, player}, yes} → a pick-shaped object for any line */
  function priceSide(d, g) {
    const mk = findMarket(d.m, g);
    const ticker = mk ? mk.ticker : `CUSTOM-${g.id}-${d.m.kind}-${d.m.seg || 'G'}-${d.m.side || ''}-${d.m.stat || ''}-${d.m.espnId || ''}-${d.m.th ? d.m.th.line : ''}`;
    const id = ticker + (d.yes ? ':Y' : ':N');
    const same = (g.eval?.all || []).find((x) => x.id === id);
    if (same) return same;
    const m = { ...d.m, th: mk?.th || d.m.th, ticker };
    const h = holdProb({ id, ticker, yes: !!d.yes, m }, g);
    const rec = INTEL.get(g.id);
    const pl = m.kind === 'prop' && rec ? ((m.espnId && rec.players.get(m.espnId)) || [...rec.players.values()].find((x) => U.nameScore(x.name, m.player || '') >= 0.8)) : null;
    const price = mk ? (d.yes ? mk.yesAsk : mk.noAsk) : null;
    let fair = h.p;
    // a line Kalshi doesn't list: same ladder math as the listed rungs — the ladder's market curve at this line and
    // the ladder's model weight — then kept between the neighbouring listed rungs so the order can't break
    if (mk && fair != null && h.status === 'live' && m.th) { const t = g.eval?.fams?.get(ladderKey(m))?.fit?.find((x) => Math.abs(x.L - m.th.line) < 1e-6); if (t) fair = d.yes ? t.p : 1 - t.p; }
    if (!mk && fair != null && h.status === 'live' && m.th) {
      const F = g.eval?.fams?.get(ladderKey(m));
      if (F?.curve && F.fit?.length) {
        const modelY = d.yes ? fair : 1 - fair, L = m.th.line;
        let y = F.w * modelY + (1 - F.w) * curveAt(F, L, modelY);
        const lo = [...F.fit].reverse().find((x) => x.L < L), hi = F.fit.find((x) => x.L > L);
        if (lo) y = Math.min(y, lo.p); if (hi) y = Math.max(y, hi.p);
        fair = d.yes ? y : 1 - y;
      }
    }
    const lb = labels(m, g, !!d.yes);
    const o = { id, ticker, gameId: g.id, kind: m.kind, seg: m.seg, stat: m.stat, side: d.yes ? 'YES' : 'NO', yes: !!d.yes, label: lb.t, sub: lb.s, m, custom: !mk, modelOnly: !mk || price == null,
      fair, price, implied: price, status: h.status, note: h.note, live: !(g.ls || MODEL.liveState(g)).pre, fam: famKey(m, !!d.yes), tier: '', lag: null, delayed: mk?.snapAt ? (Date.now() - mk.snapAt) / 60000 : 0,
      data: { player: pl || (m.kind === 'prop' ? { name: m.player, espnId: m.espnId, side: d.pside || 'home' } : null), fp: { p: fair } } };
    if (fair == null) return { ...o, netEdge: null, kelly: 0, buyMax: 0, fairMax: 0, maxEntry: 0, rating: 40 };
    const unc = 0.04, safety = unc * 0.8 + 0.005;
    const buyMax = Math.min(Math.max(0, fair - 0.04), U.breakEven(Math.max(0, fair - safety)));
    if (price == null) return { ...o, netEdge: null, edge: null, kelly: 0, buyMax, maxEntry: buyMax, fairMax: U.breakEven(fair), rating: Math.round(U.clamp(50 + 40 * (fair - 0.5), 30, 85)) };
    const fee = U.fee(price), cost = price + fee, ev = fair - cost, netEdge = fair - price;
    return { ...o, netEdge, edge: netEdge, fee, cost, ev, roi: ev / cost, buyMax, maxEntry: buyMax, fairMax: U.breakEven(fair), kelly: ev > 0 ? ev / (1 - cost) * 0.25 : 0,
      growth: ev > 0 ? fair * Math.log(fair / cost) + (1 - fair) * Math.log((1 - fair) / Math.max(1e-6, 1 - cost)) : 0,
      rating: Math.round(U.clamp(40 + 59 * (1 - Math.exp(-Math.max(0, 62 + 14 * ((netEdge - 0.04) / 0.05) + 10 * (fair - 0.5) - 40) / 30)), 30, 99)), playable: netEdge >= 0.04 && price <= buyMax + 1e-9 };
  }
  /** the same bet as p, moved to another line (props: over that line; lines: same team/side) */
  function variant(p, g, line) {
    if (!p?.m || !ADJ.has(p.m.kind) || !p.m.th || line == null) return p;
    return priceSide({ m: { ...p.m, th: thAt(p.m.kind, line) }, yes: p.yes, pside: p.data?.player?.side }, g);
  }
  // the line a pick is quoted at (props: "Over 14.5"; spreads/totals: the strike)
  const lineOf = (p) => (p?.m?.th ? (p.m.kind === 'prop' ? p.m.th.k - 0.5 : p.m.th.line) : null);

  function feed(gameId) { return [...(FEED.get(gameId)?.values() || [])].sort((a, b) => b.firstSeen - a.firstSeen); }
  function allFeed() { const o = []; for (const f of FEED.values()) o.push(...f.values()); return o.sort((a, b) => b.firstSeen - a.firstSeen); }

  return { evaluate, evidence, statusLine, feed, allFeed, labels, fmtAm, holdProb, priceSide, variant, ladder, lineOf, thAt, findMarket, ADJ };
})();
