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

  function evaluate(g) {
    const rec = INTEL.get(g.id);
    const ls = g.ls || MODEL.liveState(g);
    const kmk = KALSHI.marketsFor(g.kkey);
    const mk = [...kmk, ...bookMarkets(g, kmk, ls)];
    const ctx = { ls, sEff: g.sEff ?? g.pre?.spread ?? 2, tEff: g.tEff ?? g.pre?.total ?? 229 };
    const now = Date.now();
    const out = [], pending = [], rejected = [];
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
      // ---- market prior for props: blend the model with the live mid so information the model
      // can't see (late scratches, minutes limits) pulls confidence back toward the market.
      // A quote that predates the latest basket is stale and gets little weight.
      let pFair = pModel, wModel = 1, gap = 0;
      const mmid = MODEL.mid(m);
      if (m.kind === 'prop' && mmid != null && m.yesAsk - m.yesBid <= 0.1) {
        const nEff = data.player.proj.nEff;
        wModel = quoteStale ? 0.85 : (data.live ? 0.62 : 0.55) + Math.min(0.1, nEff / 300);
        pFair = wModel * pModel + (1 - wModel) * mmid;
        gap = pModel - mmid;
        if (Math.abs(gap) > 0.25) unc += 0.03;
      }
      fp = { ...fp, p: pFair, pModel, mmid, wModel, gap };
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
        let reason = null;
        if (netEdge < 0.04 || ev <= 0) reason = `EDGE ${U.signed(netEdge * 100, 2)}% < +4.00% minimum`;
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
          survivor: !reason, reason, trend,
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
    const audit = { priced: picks.length, survived: survivors.length, edge: 0, floor: 0, trend: 0, roster: rejected.length };
    for (const p of picks) if (p.reason) { if (/^EDGE/.test(p.reason)) audit.edge++; else if (/FLOOR|floor/.test(p.reason)) audit.floor++; else if (/TREND/.test(p.reason)) audit.trend++; }
    const pricedKeys = new Set(picks.filter((p) => p.kind === 'prop').map((p) => `${p.data.player.espnId}:${p.stat}`));
    const models = modelPicks(g, rec, ls, pricedKeys);
    updateFeed(g, picks);
    return { picks, survivors, audit, rejected, models, all: out, pending, at: now };
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
        sec.arb.push(`${priceTxt}. Model P(${S} ≥ ${k}) = ${P2(fp.pModel ?? fp.p)} from a ${f1(mu)} ± ${f1(sd)} projection${fp.mmid != null && fp.wModel < 1 ? `; market-prior blend (${Math.round((1 - fp.wModel) * 100)}% weight on mid ${P2(fp.mmid)})` : ''} → true ${P2(p.fair)}.`);
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
      sec.pace.push(`Home/away pace variance and half-court vs transition splits: ${NA}.`);
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
      sec.rot.push(`Minutes restriction: ${pl.st?.code === 'MINUTES RESTRICTION' ? 'listed on the game report' : 'none listed on the game report'}. Coaching rotation quotes / minute caps: ${NA}.`);
      // ---- MATCHUP & DEFENSIVE AUDIT ----
      const d = pl.matchup;
      if (d) sec.match.push(d.stl36 != null ? `Estimated primary defender ${d.name} (${d.pos || '—'}, ${f1(d.min)} proj min): ${f1(d.stl36)} STL, ${f1(d.blk36)} BLK, ${f1(d.pf36)} PF per 36 over his last ${d.n}.` : `Estimated primary defender ${d.name} (${d.pos || '—'}); defensive logs not loaded.`);
      sec.match.push(`${opp.abbr} team defense ${f1(cx.oppDrtg)} pts/100 poss${cx.oppDefRank ? ` (#${cx.oppDefRank} in points allowed)` : ''}.`);
      const h2h = pr.games.filter((r) => r.opp === cx.opp).slice(0, 5);
      if (h2h.length) sec.match.push(`vs ${cx.opp} last ${h2h.length}: ${h2h.map((r) => MODEL.statVal(r, st)).join(', ')} ${S}${prj.h2hF && Math.abs(prj.h2hF - 1) > 0.005 ? ` → ×${f3(prj.h2hF)}` : ' (no adjustment)'}.`);
      const spl = pl.splits, key = ['pts', 'reb', 'ast', 'fg3m'].includes(st) ? st : 'pts';
      if (spl?.topD && spl?.botD) sec.match.push(`vs top-10 defenses ${f1(spl.topD[key])} (n=${spl.topD.n}) / bottom-10 ${f1(spl.botD[key])} (n=${spl.botD.n}) ${MODEL.SHORT[key]}; home ${f1(spl.home?.[key])} / away ${f1(spl.away?.[key])}.`);
      sec.match.push(`Individual defensive rating, block/steal %, archetype containment, zone and play-type defense: ${NA}.`);
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
      sec.arb.push(`Net edge ${U.signed(p.netEdge * 100, 2)}%; EV ${p.ev >= 0 ? '+' : '−'}$${Math.abs(p.ev).toFixed(3)} per $1 (ROI ${U.signed(p.roi * 100, 1)}%).`);
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
      sec.match.push(`Zone and play-type team defense: ${NA}.`);
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

  function feed(gameId) { return [...(FEED.get(gameId)?.values() || [])].sort((a, b) => b.firstSeen - a.firstSeen); }
  function allFeed() { const o = []; for (const f of FEED.values()) o.push(...f.values()); return o.sort((a, b) => b.firstSeen - a.firstSeen); }

  return { evaluate, evidence, statusLine, feed, allFeed, labels, fmtAm };
})();
