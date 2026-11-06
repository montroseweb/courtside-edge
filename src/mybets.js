/* ============================================================
   mybets.js — My Bets (tracked positions with live hold
   confidence and SELL NOW calls), the green + add flow, the
   bottom parlay pill, and the parlay builder with its
   strength analysis. Positions live in this browser only.
   ============================================================ */

const MYB = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const KEY = () => (NET.isDemo() ? 'bets:demo' : 'bets'), SKEY = () => (NET.isDemo() ? 'slip:demo' : 'slip');
  let mode = null, bets = [], slip = [];
  function load() { const k = KEY(); if (mode === k) return; mode = k; bets = U.store.get(k, []) || []; slip = U.store.get(SKEY(), []) || []; }
  const save = () => U.store.set(KEY(), bets);
  const saveSlip = () => U.store.set(SKEY(), slip);
  let view = 'games', pop = null, sheetOpen = false, toastT = 0, touchAt = 0;
  const touching = () => Date.now() - touchAt < 900;
  const pxAdded = new Set();
  const alerted = new Map(); // bet id → sell kind already announced

  // ---------- formatting ----------
  const cc = (x) => (x == null || !isFinite(x) ? '—' : Math.abs(x * 100 - Math.round(x * 100)) < 0.05 ? Math.round(x * 100) + '¢' : (x * 100).toFixed(1) + '¢');
  const pc = (x) => (x == null || !isFinite(x) ? '—' : Math.round(x * 100) + '%');
  const P2 = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(2) + '%');
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; };
  const uid = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- leg snapshots ----------
  function legFrom(p, g) {
    const m = p.m || {}, pl = p.data?.player;
    const [who, sel] = UI.heading(p, g);
    return {
      id: p.id, ticker: p.ticker, gameId: g.id, dateKey: g.dateKey, kind: p.kind, yes: !!p.yes, side: p.side, fam: p.fam || null,
      m: { kind: m.kind || p.kind, seg: m.seg || null, side: m.side || null, stat: m.stat || null, th: m.th || null, range: m.range || null, espnId: m.espnId || pl?.espnId || null, player: m.player || pl?.name || null },
      pside: pl?.side || null, who, sel, away: g.away.abbr, home: g.home.abbr, ask0: p.price ?? null, fair0: p.fair ?? null, at: Date.now(),
    };
  }
  // relation-shaped descriptor (same shape as PARLAY.legOf) for a stored leg
  function descOf(L) {
    const m = L.m, d = { gameId: L.gameId, ticker: L.ticker, fam: m.kind === 'prop' ? 'prop' : 'line', kind: m.kind, seg: !!m.seg, segK: m.seg || 'G', p: { side: L.side, fam: L.fam, id: L.id } };
    if (m.kind === 'prop') { d.player = m.espnId || m.player; d.team = L.pside; d.stat = m.stat; d.name = m.player; }
    else if (['ml', 'spread', 'margin'].includes(m.kind)) d.team = L.yes ? m.side : m.side === 'home' ? 'away' : 'home';
    else if (m.kind === 'teamtotal') { d.team = m.side; d.over = L.yes; }
    else if (m.kind === 'total' || m.kind === 'ot') d.over = L.yes;
    return d;
  }

  // ---------- live evaluation ----------
  function evalLeg(L) {
    const g = STATE.games.get(L.gameId), mk = KALSHI.market(L.ticker);
    let ask = mk ? (L.yes ? mk.yesAsk : mk.noAsk) : null, bid = mk ? (L.yes ? mk.yesBid : mk.noBid) : null;
    if (!g) { const l = L.last || {}; return { p: l.p ?? null, status: l.status || 'pending', note: l.note || 'Game not on the current scoreboard', clock: l.clock || '', ask: ask ?? null, bid, g: null }; }
    const h = PICKS.holdProb(L, g);
    if (h.status === 'hit') { ask = ask ?? 1; bid = bid ?? 0.99; } else if (h.status === 'lost') { ask = ask ?? 0; bid = bid ?? 0; }
    const r = { p: h.p, status: h.status, note: h.note, clock: h.clock, ask, bid, g };
    const prev = L.last?.status;
    L.last = { p: r.p, status: r.status, note: r.note, clock: r.clock };
    if (prev !== r.status && (r.status === 'hit' || r.status === 'lost')) { L.last.at = Date.now(); dirty = true; if (r.status === 'hit' && prev && prev !== 'pending') { toast(`HIT ✓ ${L.who} — ${L.sel}`); try { navigator.vibrate?.(60); } catch { } } }
    return r;
  }
  let dirty = false;
  function evalTicket(legs) {
    const ev = legs.map(evalLeg);
    const lost = ev.some((e) => e.status === 'lost'), allHit = ev.length > 0 && ev.every((e) => e.status === 'hit');
    const live = legs.map((L, i) => ({ L, e: ev[i] })).filter((x) => x.e.status !== 'hit');
    let p = null, m = null;
    if (lost) p = 0; else if (allHit) p = 1;
    else if (live.every((x) => x.e.p != null)) { m = PARLAY.metrics(live.map((x) => descOf(x.L)), live.map((x) => x.e.p), live.map((x) => x.e.ask)); p = m.p; }
    const prodOf = (k) => (lost ? 0 : allHit ? 1 : live.every((x) => x.e[k] != null) ? live.reduce((a, x) => a * x.e[k], 1) : null);
    return { ev, p, ask: prodOf('ask'), bid: prodOf('bid'), status: lost ? 'lost' : allHit ? 'hit' : live.some((x) => x.e.status === 'pending') ? 'pending' : 'live', m };
  }

  // SELL NOW: strictly (a) cut a position that is all but dead while a buyer still pays more than it is worth,
  // (b) take a price the market overpays by ≥ 6¢ after the fee (locks a gain, or cuts a collapsing position).
  function sellCall(p, bid, paid, note, est) {
    if (p == null || bid == null || !(bid > 0.005) || p >= 0.995) return null;
    const net = bid - U.fee(bid), tag = est ? ' (estimated from the leg bids)' : '';
    if (p <= 0.06 && net >= Math.max(0.01, p + 0.01)) return { kind: 'cut', why: `${note ? note + '. ' : ''}Only ${pc(p)} to hit — selling at ${cc(bid)}${tag} gets back more than holding is worth (${cc(p)}).` };
    if (net - p >= 0.06 && net > paid + 0.005) return { kind: 'lock', why: `Buyers pay ${cc(bid)}${tag} but the real chance is ${pc(p)} — sell to lock in +${cc(net - paid)} per contract before the price catches up.` };
    if (net - p >= 0.08 && p <= 0.25) return { kind: 'cut', why: `${note ? note + '. ' : ''}The real chance fell to ${pc(p)} but buyers still pay ${cc(bid)}${tag} — sell now and cut the loss to ${cc(paid - net)}.` };
    return null;
  }

  function evalBet(b) {
    if (b.type === 'parlay') {
      const t = evalTicket(b.legs);
      const bad = t.ev.map((e, i) => ({ e, i })).filter((x) => x.e.status === 'live' || x.e.status === 'pending').sort((a, c) => (a.e.p ?? 1) - (c.e.p ?? 1))[0];
      const note = bad ? `Leg ${bad.i + 1} (${b.legs[bad.i].who} — ${b.legs[bad.i].sel}): ${bad.e.note}` : '';
      return { ...t, sell: t.status === 'live' ? sellCall(t.p, t.bid, b.paid, note, true) : null };
    }
    const e = evalLeg(b.legs[0]);
    return { ev: [e], p: e.p, ask: e.ask, bid: e.bid, status: e.status, sell: e.status === 'live' ? sellCall(e.p, e.bid, b.paid, e.note, false) : null, note: e.note, clock: e.clock };
  }

  // ---------- add flow (green +) ----------
  function parsePrice(v) {
    let s = String(v ?? '').trim().replace(/[¢c$\s]/gi, '');
    if (!s) return null;
    let x = parseFloat(s);
    if (!isFinite(x)) return null;
    if (x > 0 && x < 1 && s.includes('.')) x *= 100; // "0.42" = 42¢
    if (!(x > 0) || x >= 100) return null;
    return Math.round(x * 10) / 1000;
  }
  function openAdd(o) {
    load();
    pop = o;
    const el = $('#betPop');
    const def = o.ask != null ? (Math.abs(o.ask * 100 - Math.round(o.ask * 100)) < 0.05 ? String(Math.round(o.ask * 100)) : (o.ask * 100).toFixed(1)) : '';
    el.innerHTML = `<div class="pop window" role="dialog" aria-label="Add to My Bets">
      <div class="titlebar"><span class="tb-t">${o.mode === 'complete' ? 'Complete parlay' : 'Add to My Bets'}</span><button class="wb cl" data-x aria-label="Close">✕</button></div>
      <div class="pbody">
        <div class="pop-pick"><b>${U.esc(o.title)}</b><small>${U.esc(o.sub || '')}</small></div>
        <label for="popPrice">What price did you enter at?</label>
        <div class="pin"><input id="popPrice" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${def}" aria-describedby="popHint"><span>¢</span></div>
        <small class="muted" id="popHint">${o.ask != null ? `Kalshi ask now ${cc(o.ask)} per contract` : 'No live Kalshi quote — type what you paid'}${o.mode === 'complete' ? ' (combined leg asks)' : ''}</small>
        <button class="gbtn green" data-act="add">${o.mode === 'complete' ? 'Add parlay to my bets' : 'Add to my bets'}</button>
        ${o.mode === 'complete' ? '' : '<button class="gbtn blue" data-act="parlay">Create parlay</button>'}
      </div></div>`;
    el.hidden = false;
    const inp = $('#popPrice');
    setTimeout(() => { try { inp.focus({ preventScroll: true }); inp.select(); } catch { } }, 60);
  }
  function closePop(added) {
    const el = $('#betPop'); el.hidden = true; el.innerHTML = '';
    if (pop?.btn && !added && !isAdded(pop)) pop.btn.classList.remove('on');
    pop = null;
  }
  function isAdded(o) { return o.pxId ? pxAdded.has(o.pxId) || bets.some((b) => b.pxId === o.pxId) : o.legs.every((L) => has(L.id)); }
  function has(id) { load(); return slip.some((L) => L.id === id) || bets.some((b) => !b.done && b.legs.some((L) => L.id === id)); }
  function hasPx(px) { load(); return pxAdded.has(px) || bets.some((b) => b.pxId === px); }
  function act(kind) {
    const o = pop; if (!o) return;
    const wrap = $('#betPop .pin'), price = parsePrice($('#popPrice').value);
    if (kind === 'add') {
      if (price == null) { wrap.classList.remove('err'); void wrap.offsetWidth; wrap.classList.add('err'); $('#popHint').textContent = 'Type the price per contract in cents, e.g. 42 or 14.2'; return; }
      if (o.mode === 'complete') {
        bets.unshift({ id: uid(), type: 'parlay', at: Date.now(), paid: price, legs: slip.map((L) => ({ ...L, last: null })) });
        slip = []; saveSlip(); closeSheet();
        toast('Parlay added to My Bets');
      } else if (o.legs.length > 1) {
        bets.unshift({ id: uid(), type: 'parlay', at: Date.now(), paid: price, pxId: o.pxId || null, legs: o.legs.map((L) => ({ ...L, paid: L.ask0 })) });
        toast('Parlay added to My Bets');
      } else {
        bets.unshift({ id: uid(), type: 'single', at: Date.now(), paid: price, legs: [{ ...o.legs[0], paid: price }] });
        toast('Added to My Bets');
      }
      save();
      closePop(true);
    } else {
      let n = 0;
      for (const L of o.legs) {
        if (slip.some((x) => x.id === L.id)) continue;
        slip.push({ ...L, paid: o.legs.length === 1 && price != null ? price : L.ask0 }); n++;
      }
      if (o.pxId) pxAdded.add(o.pxId);
      saveSlip();
      closePop(true);
      toast(n ? (n > 1 ? `Added ${n} legs to parlay` : 'Added to parlay') : 'Already in your parlay');
      bumpFab();
    }
    renderFab(); renderDatesBadge();
  }

  function toast(t) {
    const el = $('#toast');
    el.innerHTML = `<i></i><span>${U.esc(t)}</span>`; el.hidden = false;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2000);
  }
  function bumpFab() { const f = $('#slipFab'); f.classList.remove('bump'); void f.offsetWidth; f.classList.add('bump'); }

  // ---------- bottom pill ----------
  let slipEval = null, slipEvalAt = 0;
  function slipNow(force) {
    if (!force && slipEval && Date.now() - slipEvalAt < 900) return slipEval;
    slipEvalAt = Date.now();
    return (slipEval = slip.length ? evalTicket(slip) : null);
  }
  function renderFab() {
    load();
    const f = $('#slipFab');
    if (!slip.length) { f.hidden = true; document.body.classList.remove('has-fab'); return; }
    const t = slipNow();
    const h = `<b>${slip.length}</b><span>pick${slip.length > 1 ? 's' : ''}</span><i></i><span>${t?.p != null ? P2(t.p) : '—'} real probability</span>`;
    if (f._h !== h) { f.innerHTML = h; f._h = h; }
    f.hidden = sheetOpen;
    document.body.classList.toggle('has-fab', !!slip.length);
  }

  // ---------- parlay builder ----------
  function openSheet() { sheetOpen = true; $('#slipWrap').hidden = false; renderFab(); renderSheet(true); }
  function closeSheet() { sheetOpen = false; $('#slipWrap').hidden = true; renderFab(); }

  // candidate legs for "best adds": survivors on every loaded game that is not final
  function candidates() {
    const out = [];
    for (const g of STATE.list) {
      if (!g.eval || g.state === 'post') continue;
      for (const p of g.eval.survivors || []) if (p.price != null && !p.book && !p.modelOnly && p.fair >= 0.45 && p.fair < 0.97 && !slip.some((L) => L.id === p.id)) out.push({ p, g });
    }
    return out.sort((a, b) => (b.p.netEdge + 0.3 * (b.p.fair - 0.5)) - (a.p.netEdge + 0.3 * (a.p.fair - 0.5))).slice(0, 30);
  }
  let anCache = null, anAt = 0, anSig = '';
  function analyze(force) {
    if (!slip.length) return (anCache = { t: null, B: [], adds: [] });
    const t = slipNow(true);
    const sig = slip.map((L) => L.id).join('|') + '#' + t.ev.map((e) => `${e.status}:${e.p == null ? '-' : Math.round(e.p * 100)}:${e.ask == null ? '-' : Math.round(e.ask * 100)}`).join(',');
    if (!force && anCache && ((sig === anSig && Date.now() - anAt < 6000) || Date.now() - anAt < 1500)) return anCache;
    anSig = sig; anAt = Date.now();
    const n = slip.length, B = [];
    const nm = (i) => `Leg ${i + 1} (${slip[i].who})`;
    if (!n) return (anCache = { t, B, adds: [] });
    const ev = t.ev;
    const liveIdx = ev.map((e, i) => i).filter((i) => ev[i].status !== 'hit');
    const D = slip.map(descOf);
    const M = (idx, extra) => {
      const ds = idx.map((i) => D[i]), ps = idx.map((i) => ev[i].p), qs = idx.map((i) => ev[i].ask);
      if (extra) { ds.push(extra.d); ps.push(extra.p); qs.push(extra.q); }
      if (ps.some((p) => p == null)) return null;
      return PARLAY.metrics(ds, ps, qs);
    };
    const cur = t.m || (liveIdx.length ? M(liveIdx) : null);
    // ---- verdict ----
    const lostI = ev.findIndex((e) => e.status === 'lost');
    if (lostI >= 0) B.push({ c: 'bad', t: `${nm(lostI)} already lost — this parlay can't win. Remove it.` });
    else if (n === 1) B.push({ c: 'tip', t: 'One leg isn’t a parlay yet. Add a second leg that pairs well with it — see Best adds below.' });
    else if (cur && cur.ask == null) B.push({ c: 'warn', t: `Can't grade the price — a leg has no live Kalshi quote. Real chance is ${P2(cur.p)}, so pay no more than ${cc(cur.be)}.` });
    else if (cur && cur.edge >= 0.04 && cur.ratio >= 1.15) B.push({ c: 'good', t: `Strong ticket: it hits about ${P2(cur.p)} of the time but costs only ${cc(cur.ask)} — about ${cc(cur.p - cur.cost)} of value per contract after the fee.` });
    else if (cur && cur.edge > 0) B.push({ c: 'warn', t: `Thin edge: ${P2(cur.p)} real chance vs a ${cc(cur.ask)} price — only ${cc(Math.max(0, cur.p - cur.cost))} of value after the fee. One better leg would help.` });
    else if (cur) B.push({ c: 'bad', t: `Bad price: Kalshi charges ${cc(cur.ask)} but this is only worth ${cc(cur.p)}. Don't buy above ${cc(cur.be)}.` });
    for (const [i, e] of ev.entries()) {
      if (e.status === 'hit') B.push({ c: 'good', t: `${nm(i)} already hit — it's locked in.` });
      else if (e.status === 'pending') B.push({ c: 'warn', t: `${nm(i)}: no live estimate yet (${e.note || 'waiting for data'}).` });
    }
    // ---- pair problems ----
    const R = cur?.rel || [];
    const rel = R.map((x) => ({ ...x, i: liveIdx[x.i], j: liveIdx[x.j] }));
    const pairTxt = { impossible: (x) => ({ c: 'bad', t: `Legs ${x.i + 1} & ${x.j + 1} can't both win: ${x.why}.` }), conflict: (x) => ({ c: 'bad', t: `Legs ${x.i + 1} & ${x.j + 1} work against each other — ${x.why}. When one wins, the other usually loses.` }), nested: (x) => ({ c: 'warn', t: `Legs ${x.i + 1} & ${x.j + 1} overlap: ${x.why}. You're paying twice for one outcome — keep the better-priced one.` }), dup: (x) => ({ c: 'warn', t: `Legs ${x.i + 1} & ${x.j + 1} are ${x.why}. Remove one.` }), 'same-player': (x) => ({ c: 'warn', t: `Legs ${x.i + 1} & ${x.j + 1} ${x.why}. Kalshi may also price that link into the combo.` }), redundant: (x) => ({ c: 'warn', t: `Legs ${x.i + 1} & ${x.j + 1} are really one bet: ${x.why}.` }) };
    for (const x of rel.filter((x) => pairTxt[x.flag]).slice(0, 4)) B.push(pairTxt[x.flag](x));
    // ---- biggest fix: drop / swap ----
    const adds = [];
    if (cur && liveIdx.length >= 2) {
      let best = null;
      for (const i of liveIdx) { const m = M(liveIdx.filter((k) => k !== i)); if (m && m.ask != null && cur.ask != null && m.growth > cur.growth + 1e-4 && (!best || m.growth > best.m.growth)) best = { i, m }; }
      if (best) B.push({ c: 'tip', t: `Biggest fix: drop ${nm(best.i)}. Real chance goes ${P2(cur.p)} → ${P2(best.m.p)} and edge ${U.signed(cur.edge * 100, 1)}% → ${U.signed(best.m.edge * 100, 1)}%.` });
    }
    const C = candidates();
    if (liveIdx.length && cur && cur.ask != null) {
      // weakest leg by its own edge; try swapping it for each candidate
      const w = liveIdx.slice().sort((a, b) => (ev[a].p - (ev[a].ask ?? ev[a].p)) - (ev[b].p - (ev[b].ask ?? ev[b].p)))[0];
      let sw = null;
      for (const { p, g } of C) {
        const d = PARLAY.legOf(p, g); if (D.some((x) => PARLAY.relation(x, d).flag !== 'ok')) continue;
        const m = M(liveIdx.filter((k) => k !== w), { d, p: p.fair, q: p.price });
        if (m && m.ask != null && m.growth > cur.growth + 2e-4 && m.p >= cur.p * 0.9 && (!sw || m.growth > sw.m.growth)) sw = { p, g, m };
      }
      if (sw && liveIdx.length >= 2) { const [who, sel] = UI.heading(sw.p, sw.g); B.push({ c: 'tip', t: `Better swap: replace ${nm(w)} with ${who} — ${sel} (${sw.g.away.abbr}@${sw.g.home.abbr}, ${cc(sw.p.price)}). Real chance ${P2(cur.p)} → ${P2(sw.m.p)}, edge ${U.signed(cur.edge * 100, 1)}% → ${U.signed(sw.m.edge * 100, 1)}%.` }); }
      // best adds: only legs that raise the ticket's long-run growth
      for (const { p, g } of C) {
        const d = PARLAY.legOf(p, g); if (D.some((x) => PARLAY.relation(x, d).flag !== 'ok')) continue;
        const m = M(liveIdx, { d, p: p.fair, q: p.price });
        if (m && m.ask != null && m.growth > cur.growth + 1e-4) adds.push({ p, g, m, link: Math.max(0, ...D.map((x) => PARLAY.relation(x, d).r)) });
      }
      adds.sort((a, b) => b.m.growth - a.m.growth);
    } else if (!liveIdx.length || n === 1) {
      for (const { p, g } of C.slice(0, 12)) { const d = PARLAY.legOf(p, g); if (D.some((x) => PARLAY.relation(x, d).flag !== 'ok')) continue; const m = M(liveIdx, { d, p: p.fair, q: p.price }); if (m && m.ask != null && m.edge > 0) adds.push({ p, g, m, link: 0 }); }
      adds.sort((a, b) => b.m.growth - a.m.growth);
    }
    // ---- leg-level warnings ----
    for (const i of liveIdx) { const e = ev[i]; if (e.p != null && e.ask != null && e.p < e.ask - 0.01) B.push({ c: 'warn', t: `${nm(i)} is overpriced: it costs ${cc(e.ask)} but wins only about ${pc(e.p)} — it drags the whole ticket down.` }); }
    if (liveIdx.length >= 2) { const w = liveIdx.slice().sort((a, b) => (ev[a].p ?? 1) - (ev[b].p ?? 1))[0]; if (ev[w].p != null && ev[w].p < 0.45) B.push({ c: 'warn', t: `Weakest link: ${nm(w)} at ${pc(ev[w].p)} — it's the most likely reason this loses.` }); }
    for (const x of rel.filter((x) => x.flag === 'ok' && x.r >= 0.1).slice(0, 2)) B.push({ c: 'good', t: `Legs ${x.i + 1} & ${x.j + 1} help each other: ${x.why}.` });
    if (cur && cur.p < 0.1 && n >= 2) B.push({ c: 'warn', t: `Long shot: it cashes about 1 in ${Math.max(2, Math.round(1 / Math.max(cur.p, 0.001)))} tries. Even with an edge, expect long losing streaks — keep the stake small.` });
    if (n >= 5) B.push({ c: 'warn', t: `${n} legs: every extra leg multiplies the risk — one bad bounce sinks the whole ticket.` });
    if (cur && cur.kelly > 0) B.push({ c: 'tip', t: `Bet size: about ${(cur.kelly * 100).toFixed(2)}% of your bankroll (¼-Kelly with a ${n}-leg haircut).` });
    if (cur && cur.ask != null && !adds.length && liveIdx.length >= 2 && cur.edge > 0) B.push({ c: 'good', t: 'No single add makes this stronger — it’s at its best size.' });
    return (anCache = { t, cur, B, adds: adds.slice(0, 3) });
  }

  function renderSheet(force) {
    if (!sheetOpen || (!force && touching())) return;
    load();
    const box = $('#slipBody');
    if (!slip.length) { closeSheet(); return; }
    const A = analyze(force), t = slipNow(force), ev = t.ev;
    const legs = slip.map((L, i) => {
      const e = ev[i] || {};
      return `<li class="sl ${e.status || ''}"><b class="sl-n">${e.status === 'hit' ? '✓' : i + 1}</b><span class="sl-t"><b>${U.esc(L.who)}</b><small>${U.esc(L.sel)} · ${U.esc(L.away)}@${U.esc(L.home)}${e.clock ? ' · ' + U.esc(e.clock) : ''}</small></span><span class="sl-v"><em>${cc(e.ask)}</em><small>${e.status === 'hit' ? 'HIT' : e.status === 'lost' ? 'LOST' : pc(e.p)}</small></span><button class="sl-x" data-rmleg="${U.esc(L.id)}" aria-label="Remove ${U.esc(L.who)}">✕</button></li>`;
    }).join('');
    const ask = t.ask, p = t.p, edge = ask != null && p != null ? p - ask : null;
    const vals = UI.statRow([['Kalshi ask', cc(ask)], ['Real probability', P2(p)], ['Mathematical edge', edge == null ? '—' : U.signed(edge * 100, 2) + '%', edge == null ? '' : edge >= 0 ? 'pos' : 'neg']]).replace('pk-row', 'pk-row r3');
    const be = p != null ? U.breakEven(p) : null;
    const sa = A.B.map((x) => `<li class="sa-${x.c}"><i></i><span>${U.esc(x.t)}</span></li>`).join('');
    const adds = A.adds.map(({ p: q, g, m }) => { const [who, sel] = UI.heading(q, g); return `<li><span><b>${U.esc(who)}</b><small>${U.esc(sel)} · ${U.esc(g.away.abbr)}@${U.esc(g.home.abbr)} · ${cc(q.price)} · true ${pc(q.fair)}</small><em>Ticket → ${P2(m.p)} real · ${U.signed(m.edge * 100, 1)}% edge</em></span><button class="addmini" data-addc="${U.esc(q.id)}" data-g="${g.id}" aria-label="Add ${U.esc(who)}">+</button></li>`; }).join('');
    const h = `<ol class="slegs">${legs}</ol>${vals}
      ${be != null ? `<p class="be">Profitable at or below <b>${cc(be)}</b> per contract. Kalshi's combo quote can differ from the combined leg asks — check it before you buy.</p>` : ''}
      <h4 class="subh">Strength analysis</h4><ul class="sa">${sa}</ul>
      ${adds ? `<h4 class="subh">Best adds</h4><ul class="adds">${adds}</ul>` : ''}
      <button class="gbtn green" id="slipDone">Complete parlay</button>`;
    if (box._h !== h) { box.innerHTML = h; box._h = h; }
    $('#slipTitle').textContent = `Parlay Builder · ${slip.length} leg${slip.length > 1 ? 's' : ''}`;
  }

  // ---------- My Bets view ----------
  function show(on) {
    view = on ? 'bets' : 'games';
    $('#games').hidden = on; $('#betsView').hidden = !on;
    UI.renderDates();
    if (on) { load(); render(true); }
  }
  function renderDatesBadge() {
    const c = $('#dates [data-k="bets"]'); if (!c) return;
    load();
    const open = bets.filter((b) => !b.done).length;
    const n = c.querySelector('.cnt'); if (n) n.textContent = open ? open : '';
    c.classList.toggle('alarm', [...alerted.values()].some(Boolean));
  }
  function legRow(L, e, i) {
    const paid = L.paid ?? L.ask0;
    const ask = e.ask, chg = paid && ask != null ? (ask - paid) / paid : null;
    const st = e.status;
    return `<li class="bl ${st}" data-g="${U.esc(L.gameId)}"><div class="bl-h"><b>${st === 'hit' ? '✓' : st === 'lost' ? '✕' : i + 1}</b><span><b>${U.esc(L.who)}</b> — ${U.esc(L.sel)}</span><em>${U.esc(L.away)}@${U.esc(L.home)}${e.clock ? ' · ' + U.esc(e.clock) : ''}</em></div>
      ${UI.statRow([['Paid price', cc(paid)], ['Live Kalshi ask', cc(ask)], ['Change', chg == null ? '—' : U.signed(chg * 100, 1) + '%', chg == null ? '' : chg >= 0 ? 'pos' : 'neg'], ['Hold confidence', st === 'hit' ? '100%' : st === 'lost' ? '0%' : pc(e.p), holdCls(e.p, st)]]).replace('pk-row', 'pk-row mini')}
      ${e.note ? `<small class="bl-note">${U.esc(e.note)}</small>` : ''}</li>`;
  }
  const holdCls = (p, st) => (st === 'hit' ? 'pos' : st === 'lost' ? 'neg' : p == null ? '' : p >= 0.6 ? 'pos' : p < 0.3 ? 'neg' : 'mid');
  function avatarFor(L, e, hold) {
    const g = e.g; if (!g) return `<span class="av t-none"><i>${U.esc((L.who || '?').split(' ').map((w) => w[0]).slice(0, 2).join(''))}</i><b>${hold}</b></span>`;
    const fake = { kind: L.kind, data: L.kind === 'prop' ? { player: { name: L.m.player || L.who, espnId: L.m.espnId, side: L.pside || 'home' } } : null, m: { side: L.m.side }, yes: L.yes, tier: '', rating: hold };
    return UI.avatarHTML(fake, g);
  }
  function betHTML(b, R) {
    const st = R.status, hold = st === 'hit' ? 100 : st === 'lost' ? 0 : R.p == null ? '—' : Math.round(U.clamp(R.p, 0.01, 0.99) * 100);
    const ask = R.ask, chg = ask != null ? (ask - b.paid) / b.paid : null;
    const pill = st === 'hit' ? '<span class="bst hit">HIT ✓</span>' : st === 'lost' ? '<span class="bst lost">LOST</span>' : R.sell ? '<span class="bst sell">SELL</span>' : (R.ev[0]?.g?.state === 'in' || R.ev.some((e) => e.g?.state === 'in')) ? '<span class="bst live">LIVE</span>' : '<span class="bst pre">OPEN</span>';
    const row = UI.statRow([['Paid price', cc(b.paid)], ['Live Kalshi ask', cc(ask)], ['Change', chg == null ? '—' : U.signed(chg * 100, 1) + '%', chg == null ? '' : chg >= 0 ? 'pos' : 'neg'], ['Hold confidence', hold === '—' ? '—' : hold + '%', holdCls(R.p, st)]]);
    const sell = R.sell ? `<div class="sellnow" role="alert"><b>SELL NOW</b><span>${U.esc(R.sell.why)}</span></div>` : '';
    const foot = `<div class="bfoot"><span>Added ${new Date(b.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span><button class="bx" data-rm="${b.id}">Remove</button></div>`;
    if (b.type === 'parlay') {
      const hits = R.ev.filter((e) => e.status === 'hit').length;
      return `<div class="pk-h"><span class="badge plx">${b.legs.length}-LEG<b>${hits}/${b.legs.length}</b></span><span class="pk-t"><b>${b.legs.length}-Leg Parlay</b><small>${hits} of ${b.legs.length} legs hit${R.ev.some((e) => e.status === 'lost') ? ' · a leg lost' : ''}</small></span>${pill}</div>${row}${sell}<ol class="blegs">${b.legs.map((L, i) => legRow(L, R.ev[i], i)).join('')}</ol>${foot}`;
    }
    const L = b.legs[0], e = R.ev[0];
    return `<div class="pk-h">${avatarFor(L, e, hold)}<span class="pk-t"><b>${U.esc(L.who)}</b><small>${U.esc(L.sel)} · ${U.esc(L.away)}@${U.esc(L.home)}${e.clock ? ' · ' + U.esc(e.clock) : ''}</small></span>${pill}</div>${row}${sell}${e.note ? `<p class="bnote ${st}">${U.esc(e.note)}</p>` : ''}${foot}`;
  }
  let lastRender = 0;
  function render(force) {
    if (view !== 'bets') return;
    const box = $('#betsView');
    if (!force && (Date.now() - lastRender < 450 || touching())) return;
    lastRender = Date.now();
    load();
    if (!bets.length) {
      const h = `<div class="empty window"><div class="titlebar"><span class="tb-t">My Bets</span></div><p>No bets yet. Open any game, tap the green <b class="pos">+</b> on a pick or an optimal parlay, and enter the price you paid. Each bet then tracks its live Kalshi price, how likely it is to still hit, and when to sell.</p></div>`;
      if (box._h !== h) { box.innerHTML = h; box._h = h; box._rows = null; }
      return;
    }
    if (!box._rows) { box.innerHTML = '<div class="bets-h window"><span id="betsSum"></span></div><div class="bets" id="betsList"></div>'; box._h = null; box._rows = new Map(); }
    const list = $('#betsList', box);
    const R = bets.map((b) => ({ b, R: evalBet(b) }));
    // persist settlement
    for (const { b, R: r } of R) { const done = r.status === 'hit' || r.status === 'lost'; if (done !== !!b.done) { b.done = done; dirty = true; } }
    if (dirty) { dirty = false; save(); }
    const rank = (x) => (x.R.sell ? 0 : !x.b.done ? 1 : 2);
    R.sort((a, c) => rank(a) - rank(c) || (a.b.done ? (c.b.legs[0].last?.at || c.b.at) - (a.b.legs[0].last?.at || a.b.at) : c.b.at - a.b.at));
    const open = R.filter((x) => !x.b.done), won = R.filter((x) => x.R.status === 'hit').length, lost = R.filter((x) => x.R.status === 'lost').length, sells = R.filter((x) => x.R.sell).length;
    $('#betsSum', box).innerHTML = `<b>${open.length}</b> open · <b class="pos">${won}</b> won · <b class="neg">${lost}</b> lost${sells ? ` · <b class="sellc">${sells} SELL NOW</b>` : ''}<small>Live prices refresh every second · positions are saved on this device</small>`;
    const keep = new Set();
    for (const { b, R: r } of R) {
      keep.add(b.id);
      let el = box._rows.get(b.id);
      if (!el) { el = document.createElement('article'); el.dataset.bet = b.id; el.dataset.g = b.legs[0].gameId; box._rows.set(b.id, el); }
      const cls = `bet${b.type === 'parlay' ? ' parlay' : ''}${r.sell ? ' alert' : ''}${r.status === 'hit' ? ' won' : r.status === 'lost' ? ' lost' : ''}`;
      if (el.className !== cls) el.className = cls;
      const h = betHTML(b, r);
      if (el._h !== h) { el.innerHTML = h; el._h = h; }
      list.appendChild(el);
    }
    for (const [id, el] of box._rows) if (!keep.has(id)) { el.remove(); box._rows.delete(id); }
  }

  // alerts run whatever view is on screen
  function alerts() {
    load();
    let any = false;
    for (const b of bets) {
      if (b.done) { alerted.delete(b.id); continue; }
      const r = evalBet(b);
      const k = r.sell?.kind || null;
      if (k && alerted.get(b.id) !== k) {
        const L = b.legs[0];
        toast(`SELL NOW: ${b.type === 'parlay' ? b.legs.length + '-leg parlay' : L.who + ' — ' + L.sel}`);
        try { navigator.vibrate?.([220, 90, 220]); } catch { }
      }
      alerted.set(b.id, k);
      if (k) any = true;
    }
    if (dirty) { dirty = false; save(); }
    const c = $('#dates [data-k="bets"]'); if (c) c.classList.toggle('alarm', any);
  }

  let tickN = 0;
  function tick() {
    load();
    renderFab();
    if (view === 'bets') render();
    if (sheetOpen) renderSheet(false);
    if (++tickN % 2 === 0 && view !== 'bets') alerts();
    renderDatesBadge();
  }

  // games that need live data: unsettled bets and builder legs
  function watch() {
    load();
    const s = new Set();
    for (const b of bets) if (!b.done) for (const L of b.legs) s.add(L.gameId);
    for (const L of slip) s.add(L.gameId);
    return [...s];
  }
  function dateKeys() { load(); const s = new Set(); for (const b of bets) if (!b.done) for (const L of b.legs) if (L.dateKey) s.add(L.dateKey); for (const L of slip) if (L.dateKey) s.add(L.dateKey); return [...s]; }

  function init() {
    const add = (html) => { const d = document.createElement('div'); d.innerHTML = html; const el = d.firstElementChild; document.body.appendChild(el); return el; };
    add('<div id="betPop" class="modal" hidden></div>');
    add('<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>');
    add('<button id="slipFab" class="fab" hidden aria-label="Open parlay builder"></button>');
    add(`<div id="slipWrap" class="modal sheetwrap" hidden><div class="slip window" role="dialog" aria-label="Parlay builder"><div class="titlebar big"><span class="ticon pl"></span><span class="tb-t" id="slipTitle">Parlay Builder</span><span class="wbtns"><button class="wb cl" id="slipClose" aria-label="Close parlay builder">✕</button></span></div><div class="sbody" id="slipBody"></div></div></div>`);
    $('#betPop').addEventListener('click', (e) => {
      if (e.target.id === 'betPop' || e.target.closest('[data-x]')) return closePop(false);
      const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act);
    });
    $('#betPop').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'popPrice') { e.preventDefault(); act('add'); } if (e.key === 'Escape') closePop(false); });
    $('#slipFab').onclick = openSheet;
    $('#slipClose').onclick = closeSheet;
    $('#slipWrap').addEventListener('click', (e) => {
      if (e.target.id === 'slipWrap') return closeSheet();
      const x = e.target.closest('[data-rmleg]');
      if (x) { load(); slip = slip.filter((L) => L.id !== x.dataset.rmleg); saveSlip(); anCache = null; slipEval = null; if (!slip.length) { pxAdded.clear(); closeSheet(); toast('Parlay cleared'); } else renderSheet(true); renderFab(); UI.updateFinder(true); return; }
      const a = e.target.closest('[data-addc]');
      if (a) { const g = STATE.games.get(a.dataset.g), p = g?.eval?.picks.concat(g.eval.all || []).find((q) => q.id === a.dataset.addc); if (p) { slip.push({ ...legFrom(p, g), paid: p.price }); saveSlip(); anCache = null; slipEval = null; renderSheet(true); renderFab(); toast('Added to parlay'); } return; }
      if (e.target.closest('#slipDone')) { const t = slipNow(true); openAdd({ mode: 'complete', legs: slip, ask: t.ask, title: `${slip.length}-leg parlay`, sub: slip.map((L) => L.who).join(' · ') }); }
    });
    $('#betsView').addEventListener('click', (e) => {
      const hd = e.target.closest('.bet > .pk-h, .bl-h');
      if (hd && !e.target.closest('button')) { const el = e.target.closest('[data-g]') || e.target.closest('.bet'); const gid = el?.dataset.g || el?.querySelector('[data-g]')?.dataset.g; if (gid && STATE.games.has(gid)) location.hash = 'game-' + gid; return; }
      const r = e.target.closest('[data-rm]'); if (!r) return;
      // tap twice to remove (no browser dialogs: some hosts block them)
      if (!r.classList.contains('arm')) { r.classList.add('arm'); r.textContent = 'Tap again to remove'; touchAt = Date.now() + 2500; setTimeout(() => { r.classList.remove('arm'); r.textContent = 'Remove'; }, 3000); return; }
      load(); bets = bets.filter((b) => b.id !== r.dataset.rm); alerted.delete(r.dataset.rm); save(); render(true); renderDatesBadge();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen && !pop) closeSheet(); });
    document.addEventListener('pointerdown', (e) => { if (e.target.closest?.('#slipWrap, #betsView')) touchAt = Date.now(); }, { capture: true, passive: true });
  }

  return {
    init, tick, show, render, openAdd, legFrom, has, hasPx, watch, dateKeys, evalBet,
    view: () => view, modal: () => !!pop || sheetOpen,
    _state: () => ({ bets, slip }), _reset: () => { mode = null; },
  };
})();
