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
      case 'ml': return sideYes ? { t: `${teamName(g, m.side)} win${seg}`, s: m.seg ? 'Segment winner' : 'Moneyline' } : (m.seg ? { t: `${teamName(g, m.side)} don't win${seg}`, s: 'Other team or tie' } : { t: `${teamName(g, other(m.side))} win`, s: `Moneyline · NO on ${g[m.side].abbr}` });
      case 'spread': {
        const L = th.line;
        return sideYes ? { t: `${teamName(g, m.side)} −${L}${seg}`, s: `Wins by ${th.k}+` } : { t: `${teamName(g, other(m.side))} +${L}${seg}`, s: `${g[m.side].abbr} wins by ${th.k - 1} or fewer / loses` };
      }
      case 'total': return sideYes ? { t: `Over ${th.line}${seg}`, s: 'Game total' } : { t: `Under ${th.line}${seg}`, s: 'Game total' };
      case 'teamtotal': return sideYes ? { t: `${teamName(g, m.side)} over ${th.line}`, s: 'Team total' } : { t: `${teamName(g, m.side)} under ${th.line}`, s: 'Team total' };
      case 'prop': {
        const st = MODEL.SHORT[m.stat] || m.stat;
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
          const lean = fp.p - base, yes = lean >= 0, fair = yes ? fp.p : 1 - fp.p;
          if (fair < 0.35 || fair > 0.92) continue; // actionable band
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
          price: null, fair, cost: null, edge: null, lean: Math.abs(best.lean), roi: null, be: U.breakEven(fair), maxEntry: U.breakEven(Math.max(0, fair - safety)), greatEntry: U.breakEven(Math.max(0, fair - safety - 0.06)),
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
    const out = [], pending = [];
    for (const m of mk) {
      if (m.yesAsk == null && m.noAsk == null) continue;
      let fp = null, kind = m.kind, why = [], data = {}, unc;
      if (m.kind === 'prop') {
        if (!rec) { pending.push(m); continue; }
        let p = m.espnId ? rec.players.get(m.espnId) : null;
        if (!p && m.player) { const hit = [...rec.players.values()].find((x) => U.nameScore(x.name, m.player) >= 0.8); if (hit) { p = hit; m.espnId = hit.espnId; } }
        if (!p?.proj) { pending.push(m); continue; }
        const lb = !ls.pre ? liveBoxFor(g, rec, p.espnId, p.name) : null;
        if (!lb && !ls.pre && !ls.post) { pending.push(m); continue; } // waiting on the live box score
        if (lb && !ls.post) fp = MODEL.propLiveProb(p.proj, m.stat, m.th, lb, ls);
        else if (ls.pre) fp = MODEL.propPregameProb(p.proj, m.stat, m.th);
        if (!fp) continue;
        if (fp.hit) continue;
        const nEff = p.proj.nEff;
        unc = (lb ? 0.03 + 0.08 / Math.sqrt(nEff + 1) : 0.035 + 0.12 / Math.sqrt(nEff + 1)) + (/question|doubt|day/i.test(p.status) ? 0.05 : 0);
        data = { player: p, live: lb, fp };
      } else if (['ml', 'spread', 'total', 'teamtotal'].includes(m.kind)) {
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
      const quoteStale = !m.book && !!evAt && m.quoteAt < evAt && sinceScore < 120;
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

      for (const yes of [true, false]) {
        const price = yes ? m.yesAsk : m.noAsk;
        if (price == null || price <= 0.02 || price >= 0.96) continue; // no value in 97¢+ contracts
        const fair = yes ? fp.p : 1 - fp.p;
        const cost = price + (m.book ? 0 : U.fee(price)); // sportsbook prices already include the vig
        const edge = fair - cost;
        const safety = unc * 0.8 + 0.005;
        const BE = m.book ? (x) => U.clamp(x, 0, 1) : U.breakEven;
        const be = BE(fair), maxEntry = BE(Math.max(0, fair - safety)), greatEntry = BE(Math.max(0, fair - safety - 0.06));
        const roi = edge / cost;
        const kelly = edge > 0 ? Math.max(0, (fair - cost) / (1 - cost)) * 0.25 : 0;
        const spreadW = m.book ? 0.04 : m.yesAsk != null && m.yesBid != null ? m.yesAsk - m.yesBid : 0.1;
        // raw score: edge beyond the safety margin (in 5¢ units) + confidence + data/liquidity quality
        let raw = 62 + 14 * ((edge - safety) / 0.05) + 10 * (fair - 0.5);
        if (data.player) raw += data.player.proj.nEff >= 15 ? 3 : data.player.proj.nEff < 6 ? -6 : 0;
        if (spreadW > 0.06) raw -= 6; if (m.vol < 50) raw -= 4;
        if (lag && Math.sign(move) === (yes ? 1 : -1)) raw += 4;
        if (fair < 0.12) raw -= 8; // long shots need more proof
        if (Math.abs(gap) > 0.25) raw -= 8; // huge model/market gaps usually mean missing news
        // diminishing returns toward 99
        let rating = Math.round(U.clamp(40 + 59 * (1 - Math.exp(-Math.max(0, raw - 40) / 30)), 30, 99));
        const tier = rating >= 90 ? 'HOF' : rating >= 83 ? 'GOLD' : rating >= 76 ? 'SILVER' : rating >= 70 ? 'BRONZE' : '';
        const lb = labels(m, g, yes);
        out.push({
          id: m.ticker + (yes ? ':Y' : ':N'), ticker: m.ticker, gameId: g.id, kind, seg: m.seg, stat: m.stat, side: yes ? 'YES' : 'NO',
          label: lb.t, sub: lb.s, price, fair, cost, edge, roi, be, maxEntry, greatEntry, kelly, unc, safety, rating, tier,
          playable: edge >= Math.max(PLAY_MIN, safety) && price <= maxEntry + 1e-9,
          lag: lag && Math.sign(move) === (yes ? 1 : -1) ? lag : null,
          live: !ls.pre, liq: { spread: spreadW, vol: m.vol, oi: m.oi }, m, data, yes, book: m.book || null, am: m.book ? (yes ? m.yesAm : m.noAm) : null,
        });
      }
    }
    // keep the better side per market for ranking
    const best = new Map();
    for (const p of out) { const b = best.get(p.ticker); if (!b || p.edge > b.edge) best.set(p.ticker, p); }
    const picks = [...best.values()].sort((a, b) => b.rating - a.rating || b.edge - a.edge);
    const pricedKeys = new Set(picks.filter((p) => p.kind === 'prop').map((p) => `${p.data.player.espnId}:${p.stat}`));
    const models = modelPicks(g, rec, ls, pricedKeys);
    updateFeed(g, picks);
    return { picks, models, all: out, pending, at: now };
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

  // ---- evidence ("why") bullets ----
  function evidence(p, g) {
    const out = [];
    const rec = INTEL.get(g.id);
    const ls = g.ls;
    if (p.kind === 'prop') {
      const pl = p.data.player, pr = pl.proj, m = p.m;
      const st = m.stat, S = MODEL.SHORT[st] || st;
      const k = m.th?.k;
      const fp = p.data.fp;
      if (p.data.live) {
        const lb = p.data.live;
        out.push({ k: 'live', t: `Live: ${fp.cur} ${S} in ${lb.min.toFixed(0)} min (${lb.pf} PF${lb.oncourt ? ', on court' : ', on bench'}) → needs ${Math.max(0, (k ?? 0) - fp.cur)} more in ~${fp.r.toFixed(1)} projected min` });
        for (const n of fp.notes || []) out.push({ k: 'risk', t: n });
      }
      const sd = Math.sqrt(pr.proj[st]?.variance ?? 0);
      if (pr.proj[st]) out.push({ k: 'proj', t: `Projection ${pr.proj[st].mu.toFixed(1)} ${S} (±${sd.toFixed(1)}) on ${pr.minProj.toFixed(1)} min vs line ${k != null ? k + '+' : '—'}` });
      const hh = MODEL.hitHistory(pr.games, st, k, pl.ctx.season);
      if (hh) {
        const r = (o) => `${o.h}/${o.n}`;
        out.push({ k: 'hits', t: `Hit ${k}+: L5 ${r(hh.l5)} · L10 ${r(hh.l10)} · L20 ${r(hh.l20)}${hh.season.n ? ' · this season ' + r(hh.season) : ''}` });
        if (Math.abs(hh.streak) >= 3) out.push({ k: 'streak', t: hh.streak > 0 ? `Streak: hit ${k}+ in ${hh.streak} straight` : `Streak: missed ${k}+ in ${-hh.streak} straight` });
        out.push({ k: 'form', t: `Last 10: ${hh.last.join(', ')} (avg L5 ${hh.avg5.toFixed(1)}, L10 ${hh.avg10.toFixed(1)})` });
      }
      const h2h = pr.games.filter((r) => r.opp === pl.ctx.opp).slice(0, 5);
      if (h2h.length) out.push({ k: 'h2h', t: `vs ${pl.ctx.opp} (last ${h2h.length}): ${h2h.map((r) => MODEL.statVal(r, st)).join(', ')} ${S}${pr.proj[st]?.h2hF && Math.abs(pr.proj[st].h2hF - 1) > 0.01 ? ` → ${U.signed((pr.proj[st].h2hF - 1) * 100, 0)}% adj` : ''}` });
      const oppT = STATE.standings?.teams?.[g[pl.side === 'home' ? 'away' : 'home'].id];
      if (oppT?.pa) out.push({ k: 'def', t: `${pl.ctx.opp} defense: ${oppT.pa.toFixed(1)} pts allowed/g (#${oppT.defRank} of 30)${pl.matchup ? ` · likely matchup ${pl.matchup.name}${pl.matchup.pos ? ' (' + pl.matchup.pos + ')' : ''}` : ''}` });
      const spl = pl.splits;
      const key = ['pts', 'reb', 'ast', 'fg3m'].includes(st) ? st : 'pts';
      if (spl?.home && spl?.away) out.push({ k: 'split', t: `Home ${spl.home[key].toFixed(1)} / Away ${spl.away[key].toFixed(1)} ${MODEL.SHORT[key]}${spl.topD && spl.botD ? ` · vs top-10 D ${spl.topD[key].toFixed(1)} / bottom-10 D ${spl.botD[key].toFixed(1)}` : ''}` });
      if (spl?.b2b && spl.b2b.n >= 3 && spl?.rested) out.push({ k: 'rest', t: `On 0 days rest ${spl.b2b[key].toFixed(1)} vs rested ${spl.rested[key].toFixed(1)} ${MODEL.SHORT[key]} (n=${spl.b2b.n})` });
      for (const n of pr.notes) out.push({ k: n.k, t: n.t });
      if (fp.mmid != null && fp.wModel < 1) out.push({ k: 'blend', t: `Model ${U.pct(fp.pModel)} · market mid ${U.pct(fp.mmid)} → confidence ${U.pct(fp.p)} (market prior weight ${Math.round((1 - fp.wModel) * 100)}%${fp.wModel >= 0.85 ? ', quote is stale' : ''})` });
      if (Math.abs(fp.gap || 0) > 0.25) out.push({ k: 'risk', t: `Model and market disagree by ${Math.round(Math.abs(fp.gap) * 100)} pts — check injury news and minutes before trusting this one` });
      if (pl.status) out.push({ k: 'risk', t: `Injury report: ${pl.status} — check the market's no-play rules before entering` });
      if (pr.nEff < 8) out.push({ k: 'risk', t: `Thin sample (${pr.games.length} games) — wider safety margin applied` });
    } else {
      const pre = g.pre?.src || {};
      const bits = [];
      if (pre.bookSpread != null) bits.push(`${pre.book || 'Book'} ${pre.bookSpread >= 0 ? g.home.abbr + ' −' + pre.bookSpread.toFixed(1) : g.away.abbr + ' −' + (-pre.bookSpread).toFixed(1)}`);
      if (pre.bookTotal) bits.push(`O/U ${pre.bookTotal}`);
      if (pre.bookP != null) bits.push(`no-vig ML ${U.pct(pre.bookP)} ${g.home.abbr}`);
      if (pre.bpi != null) bits.push(`ESPN BPI ${U.pct(pre.bpi)}`);
      if (pre.kalshiSpread != null) bits.push(`Kalshi ladder ${U.signed(pre.kalshiSpread, 1)}`);
      if (bits.length) out.push({ k: 'cons', t: 'Pregame consensus: ' + bits.join(' · ') });
      const fp = p.data.fp;
      if (p.kind === 'total') out.push({ k: 'proj', t: `Projected total ${fp.mu.toFixed(1)} ± ${fp.sd.toFixed(1)}${ls && !ls.pre ? ` (now ${ls.total}, ${ls.rem.toFixed(1)} min left)` : ''}` });
      else if (fp.mu != null) out.push({ k: 'proj', t: `Projected ${p.kind === 'spread' ? g[p.m.side].abbr + ' margin' : 'home margin'} ${U.signed(fp.mu, 1)} ± ${fp.sd.toFixed(1)}` });
      if (ls && !ls.pre) {
        out.push({ k: 'live', t: `Live: ${g.away.abbr} ${g.away.score}–${g.home.score} ${g.home.abbr}, ${U.periodShort(ls.period)} ${U.fmtClock(ls.clockSec)}${g.espnWP != null ? ` · ESPN WP ${U.pct(g.espnWP)} ${g.home.abbr}` : ''}` });
        if (g.run && g.run.pts >= 6) out.push({ k: 'mom', t: `Momentum: ${g[g.run.side].abbr} on a ${g.run.pts}–${g.run.opp} run` });
        if (g.sMkt != null) out.push({ k: 'cal', t: `Market-calibrated strength ${U.signed(g.sMkt, 1)} vs pregame ${U.signed(g.pre.spread, 1)} (blend used: ${U.signed(g.sEff, 1)})` });
      }
      const inj = rec ? [...INTEL.injuriesFor(rec, g, 'home'), ...INTEL.injuriesFor(rec, g, 'away')].filter((x) => /out/i.test(x.status)) : [];
      if (inj.length) out.push({ k: 'inj', t: 'Out: ' + inj.slice(0, 6).map((x) => x.name).join(', ') });
      const st = STATE.standings?.teams;
      const h = st?.[g.home.id], a = st?.[g.away.id];
      if (h?.pf && a?.pf) out.push({ k: 'def', t: `Off/Def ppg — ${g.away.abbr} ${a.pf.toFixed(1)}/${a.pa.toFixed(1)} (#${a.offRank}/#${a.defRank}) · ${g.home.abbr} ${h.pf.toFixed(1)}/${h.pa.toFixed(1)} (#${h.offRank}/#${h.defRank})` });
    }
    if (p.lag) out.unshift({ k: 'lag', t: `Stale price: quote unchanged ${p.lag.sec}s while the score moved ${p.lag.sinceScore}s ago — fair value moved ${U.signed(p.lag.move * 100, 1)}¢` });
    const m = p.m;
    if (p.modelOnly) {
      const fp = p.data.fp, pYes = fp.p, bYes = fp.base;
      out.unshift({ k: 'proj', t: fp.liveBase ? `Live model ${U.pct(p.yes ? pYes : 1 - pYes)} vs pregame model ${U.pct(p.yes ? bYes : 1 - bYes)} (live swing ${U.signed(p.lean * 100, 1)} pts)` : `Model ${U.pct(p.yes ? pYes : 1 - pYes)} vs season-average baseline ${U.pct(p.yes ? bYes : 1 - bYes)} (context lean ${U.signed(p.lean * 100, 1)} pts)` });
      out.push({ k: 'mkt', t: `No live Kalshi price loaded for this line. On Kalshi or Robinhood, buy ${p.side} on "${m.sub}" only at ≤ ${U.cents(p.maxEntry)} (great ≤ ${U.cents(p.greatEntry)}).` });
    } else if (p.book) {
      out.push({ k: 'mkt', t: `${m.sub}. Price ${fmtAm(p.am)} = ${U.cents(p.price)} implied (vig included). Kalshi had no open market for this line.` });
    } else {
      out.push({ k: 'mkt', t: `Kalshi ${m.ticker}: bid ${U.cents(m.yesBid)} / ask ${U.cents(m.yesAsk)} YES · vol ${Math.round(m.vol).toLocaleString()} · OI ${Math.round(m.oi).toLocaleString()} · requoted ${U.ago(m.quoteAt)}` });
    }
    return out;
  }

  function feed(gameId) { return [...(FEED.get(gameId)?.values() || [])].sort((a, b) => b.firstSeen - a.firstSeen); }
  function allFeed() { const o = []; for (const f of FEED.values()) o.push(...f.values()); return o.sort((a, b) => b.firstSeen - a.firstSeen); }

  return { evaluate, evidence, feed, allFeed, labels, fmtAm };
})();
