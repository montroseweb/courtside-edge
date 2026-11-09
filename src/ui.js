/* ============================================================
   ui.js — DOM: game cards, win-prob gel bars, edge ticker,
   Pick Finder window, pick cards, intel panes, settings
   ============================================================ */

const UI = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const cards = new Map(); // gameId → {el, court, refs}
  let finder = null;       // {id, court, refs}
  const openDetails = new Set();
  const F = { filter: 'all', sort: 'edge', playable: false, noCombo: !!U.store.get('nocombo', false), minP: U.store.get('minp2', 0.5), allRungs: !!U.store.get('allrungs', false) };
  // one rung per ladder (same player-stat, same total, same team's spread…): highest expected Kelly growth
  function bestRungs(list) {
    const best = new Map(), out = [];
    for (const p of list) { if (!p.fam || p.modelOnly) { out.push(p); continue; } const k = p.gameId + '|' + p.fam; const b = best.get(k); if (!b || (p.growth ?? 0) > (b.growth ?? 0)) best.set(k, p); }
    return out.concat([...best.values()]);
  }
  const isCombo = (p) => p.kind === 'prop' && !!MODEL.COMBO[p.stat];
  let lastListRender = 0, lastChartRender = 0, lastTicker = 0, lastTickerHTML = '', lastTouch = 0;
  const busy = () => Date.now() - lastTouch < 2500 || MYB.modal();

  const clearHash = () => { try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; } };
  const dur = (ms) => { const sec = Math.max(1, Math.round(ms / 1000)); return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's'; };
  const DEPLOY = 'https://vercel.com/new/import?s=' + encodeURIComponent('https://github.com/montroseweb/courtside-edge');
  function kalshiStale(g) {
    const st = KALSHI.status();
    if (NET.isDemo() || !KALSHI.hasGame(g.kkey) || !st.snapMode || Date.now() - st.snapAt <= 10 * 60e3) return '';
    return `<p class="kslim">Kalshi feed is ${U.ago(st.snapAt).replace(' ago', '')} old — picks are held until it refreshes (details at the bottom).</p>`;
  }
  function kalshiNote(g) {
    const st = KALSHI.status(), h = NET.health('kalshi');
    if (NET.isDemo()) return '';
    if (KALSHI.hasGame(g.kkey) && st.snapMode && Date.now() - st.snapAt > 10 * 60e3) return `<div class="knote bad"><b>Kalshi feed is ${U.ago(st.snapAt).replace(' ago', '')} old — no picks are cleared on stale prices.</b> The feed job restarts automatically; for direct second-by-second prices deploy the Vercel copy. <a class="gel primary" href="${DEPLOY}" target="_blank" rel="noopener">Deploy on Vercel</a></div>`;
    if (KALSHI.hasGame(g.kkey)) return st.snapMode ? `<div class="knote ok"><b>Real Kalshi prices via the published feed</b> — updated ${U.ago(st.snapAt)} (refreshes about every minute). Your browser can't reach Kalshi directly from this host, so confirm the live price before entering. For second-by-second prices, use the Vercel copy. <a class="gel" href="${DEPLOY}" target="_blank" rel="noopener">Deploy on Vercel</a></div>` : '';
    const routes = NET.routes('kalshi').map((r) => `${U.esc(r.host)} (${r.kind}): ${U.esc(r.result)}`).join(' · ');
    if (st.reached || st.ok) {
      return `<div class="knote ok"><b>Kalshi connected</b> — ${st.events} NBA events found, none open for this game yet${st.unmatched.length ? ` (unmatched: ${U.esc(st.unmatched.join(', '))})` : ''}. Model and sportsbook picks are shown below.</div>`;
    }
    const blocked = h.level === 'down' || st.scanErrors > 0 || (st.discovered && !st.reached);
    return `<div class="knote${blocked ? ' bad' : ''}"><b>${blocked ? 'Kalshi prices are blocked from this link.' : 'Connecting to Kalshi…'}</b> ${blocked ? 'Browsers can\'t call Kalshi directly and the free relays are refusing or rate-limiting. Until it connects, the picks below use the model and sportsbook lines; check each on Kalshi or Robinhood against its <b>Buy if ≤</b> price.' : 'Trying direct, then relay routes.'}
      <a class="gel primary" href="${DEPLOY}" target="_blank" rel="noopener">Fix it: deploy my copy on Vercel (1 min)</a>
      ${routes ? `<small>Routes tried: ${routes}</small>` : ''}</div>`;
  }
  const teamSwatch = (t) => `<span class="sw" style="--c:#${t.color};--c2:#${t.alt}"></span>`;
  const logoImg = (t, cls = 'lg') => t.logo && !NET.isDemo() ? `<img class="${cls}" src="${U.esc(t.logo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'sw',style:'--c:#${t.color};--c2:#${t.alt}'}))">` : teamSwatch(t);

  function statusLine(g) {
    if (g.state === 'pre') {
      const ms = g.date - Date.now();
      return { main: U.localTime(g.date), sub: ms > 0 && ms < 18 * 3600e3 ? 'in ' + U.countdown(ms) : U.dayLabel(g.dateKey, STATE.todayKey) };
    }
    if (g.state === 'post') return { main: /OT/.test(g.detail) ? g.detail.replace(/^Final\/?/, 'FINAL/') : 'FINAL', sub: '' };
    if (/HALFTIME/.test(g.statusName)) return { main: 'HALF', sub: '' };
    if (/END_PERIOD/.test(g.statusName)) return { main: 'END ' + U.periodShort(g.period), sub: '' };
    return { main: `${U.periodShort(g.period)} ${U.fmtClock(g.clockSec)}`, sub: '' };
  }

  // ---------- win probability bar ----------
  function wpBarHTML() {
    return `<div class="wp"><span class="wp-l">—</span><div class="wp-track"><div class="wp-a"></div><div class="wp-h"></div><div class="wp-mk" hidden><i></i><em></em></div><div class="wp-glare"></div></div><span class="wp-r">—</span></div>`;
  }
  function updateWP(root, g) {
    const p = g.wp; if (p == null) return;
    const a = 1 - p;
    const r = root._wp || (root._wp = { l: $('.wp-l', root), r: $('.wp-r', root), A: $('.wp-a', root), H: $('.wp-h', root), mk: $('.wp-mk', root), em: $('.wp-mk em', root) });
    r.l.textContent = Math.round(a * 100) + '%'; r.r.textContent = Math.round(p * 100) + '%';
    r.A.style.width = (a * 100).toFixed(1) + '%'; r.H.style.width = (p * 100).toFixed(1) + '%';
    const [ca, ch] = U.pairColors(g.away, g.home);
    r.A.style.setProperty('--c', '#' + ca); r.H.style.setProperty('--c', '#' + ch);
    r.l.classList.toggle('fav', a > 0.5); r.r.classList.toggle('fav', p > 0.5);
    if (g.kp != null) {
      r.mk.hidden = false; r.mk.style.left = ((1 - g.kp) * 100).toFixed(1) + '%';
      r.em.textContent = '';
      r.mk.title = `Kalshi market: ${g.away.abbr} ${Math.round((1 - g.kp) * 100)}¢ · ${g.home.abbr} ${Math.round(g.kp * 100)}¢`;
    } else r.mk.hidden = true;
  }

  // ---------- game cards ----------
  function cardHTML(g) {
    return `<article class="gcard window" data-id="${g.id}" tabindex="0" aria-label="${U.esc(g.name)}">
      <div class="titlebar"><span class="tb-t">${U.esc(g.away.abbr)} @ ${U.esc(g.home.abbr)}<small>${U.esc(g.venue.name || '')}</small></span><span class="pill st"></span></div>
      <div class="courtbox"><canvas class="court"></canvas><div class="lastplay" hidden></div></div>
      <div class="lcd">
        <div class="tm away">${logoImg(g.away)}<div><b>${U.esc(g.away.abbr)}</b><small class="rec">${U.esc(g.away.record)}</small></div></div>
        <div class="mid"><span class="sc sa">${g.away.score}</span><span class="clk"><b></b><small></small></span><span class="sc sh">${g.home.score}</span></div>
        <div class="tm home"><div><b>${U.esc(g.home.abbr)}</b><small class="rec">${U.esc(g.home.record)}</small></div>${logoImg(g.home)}</div>
      </div>
      ${wpBarHTML()}
      <div class="cfoot"><span class="lines"></span><span class="edges"></span></div>
    </article>`;
  }

  function renderGames() {
    const wrap = $('#games');
    const list = STATE.list.filter((g) => g.dateKey === STATE.dateKey);
    const ids = list.map((g) => g.id).join(',');
    if (wrap.dataset.ids !== ids) {
      for (const [, c] of cards) c.court.destroy();
      cards.clear();
      wrap.innerHTML = list.length ? list.map(cardHTML).join('') : `<div class="empty window"><div class="titlebar"><span class="tb-t">No games</span></div><p>${STATE.loaded ? 'No NBA games on this date.' : 'Loading the slate…'}</p></div>`;
      wrap.dataset.ids = ids;
      for (const el of $$('.gcard', wrap)) {
        const g = STATE.games.get(el.dataset.id);
        const court = COURT.create($('canvas', el));
        court.setGame(g);
        cards.set(g.id, { el, court, refs: { st: $('.st', el), sa: $('.sa', el), sh: $('.sh', el), clk: $('.clk b', el), sub: $('.clk small', el), lines: $('.lines', el), edges: $('.edges', el), lp: $('.lastplay', el) } });
      }
    }
    for (const g of list) updateCard(g);
  }

  function updateCard(g) {
    const c = cards.get(g.id); if (!c) return;
    const r = c.refs;
    c.court.setGame(g);
    const s = statusLine(g);
    if (r.sa.textContent !== String(g.away.score)) { r.sa.textContent = g.away.score; bump(r.sa); }
    if (r.sh.textContent !== String(g.home.score)) { r.sh.textContent = g.home.score; bump(r.sh); }
    r.clk.textContent = s.main; r.sub.textContent = s.sub;
    c.el.classList.toggle('is-live', g.state === 'in'); c.el.classList.toggle('is-final', g.state === 'post');
    r.st.textContent = g.state === 'in' ? 'LIVE' : g.state === 'post' ? 'FINAL' : (g.broadcast || 'UPCOMING');
    r.st.className = 'pill st ' + g.state;
    r.sa.classList.toggle('lead', g.state !== 'pre' && g.away.score > g.home.score);
    r.sh.classList.toggle('lead', g.state !== 'pre' && g.home.score > g.away.score);
    const pre = g.pre;
    if (pre) {
      const sp = pre.src.bookSpread ?? pre.spread;
      const fav = sp >= 0 ? g.home.abbr : g.away.abbr;
      r.lines.textContent = `${fav} −${Math.abs(sp).toFixed(1)} · O/U ${(pre.src.bookTotal ?? pre.total).toFixed(1)}${pre.src.book ? '' : ' (model)'}`;
    }
    const ev = g.eval;
    const n = ev ? ev.picks.filter((p) => p.playable).length : 0;
    const topM = ev && !n ? (ev.models || [])[0] : null;
    r.edges.innerHTML = ev ? (n ? `<b>${n}</b> edge${n > 1 ? 's' : ''} ›` : topM ? `Top pick: ${U.esc(topM.label)} ›` : 'Pick Finder ›') : 'Pick Finder ›';
    r.edges.classList.toggle('hot', n > 0);
    if (g.state === 'in' && g.lastPlay?.text) { r.lp.hidden = false; r.lp.textContent = g.lastPlay.text; } else r.lp.hidden = true;
    updateWP(c.el, g);
  }
  function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

  function scoreFx(g, side, pts, extra) {
    cards.get(g.id)?.court.score(side, pts, extra);
    if (finder?.id === g.id) finder.court.score(side, pts, extra);
  }

  // ---------- date bar ----------
  function renderDates() {
    const bv = MYB.view() === 'bets';
    $('#dates').innerHTML = `<button class="chip mb${bv ? ' on' : ''}" data-k="bets"><i></i>My Bets<b class="cnt"></b></button>` + STATE.dates.map((k) => `<button class="chip${!bv && k === STATE.dateKey ? ' on' : ''}" data-k="${k}">${U.dayLabel(k, STATE.todayKey)}</button>`).join('');
  }

  // ---------- feed LEDs ----------
  function renderFeeds() {
    const srcs = [['espn', 'ESPN', 'ESPN'], ['nba', 'NBA', 'NBA'], ['kalshi', 'KALSHI', 'KAL']];
    $('#feeds').innerHTML = srcs.map(([k, l, ls]) => {
      let h = NET.health(k);
      if (k === 'kalshi') { const ks = KALSHI.status(); if (ks.snapMode && Date.now() - ks.snapAt < 5 * 60e3) h = { ...h, level: 'stale', lat: 0, err: '', mode: 'feed' }; }
      if (k === 'nba' && h.level !== 'ok') { const e = NET.health('espn'); if (e.level === 'ok') h = { ...e, mode: 'espn', err: '' }; }
      const tip = k === 'nba' && h.mode === 'espn' ? 'Live box score & play-by-play via ESPN (the NBA CDN blocks browsers on this host)' : h.level === 'ok' ? `${l}: ${Math.round(h.lat)} ms · ${h.mode}` : h.err ? `${l}: ${h.err}` : `${l}: waiting`;
      return `<span class="led ${h.level}" title="${U.esc(tip)}"><i></i><b class="lf">${l}</b><b class="ls">${ls}</b><small>${h.mode === 'feed' ? 'feed' : h.mode === 'espn' ? 'via ESPN' : h.level === 'ok' ? Math.round(h.lat) + 'ms' : h.level === 'down' ? 'off' : '…'}</small></span>`;
    }).join('');
  }

  // ---------- ticker (top edges across the slate) ----------
  // ---------- Buy Now ----------
  const kalshiBuyable = (p) => !p.modelOnly && !p.book;
  const BN = new Map(); // pick id → {first, changed, sig}: when it appeared and when its price or probability last moved
  function bnTrack(p) {
    const sig = Math.round(p.price * 1000) + '|' + Math.round(p.fair * 1000), now = Date.now();
    let t = BN.get(p.id);
    if (!t) { t = { first: now, changed: now, sig }; BN.set(p.id, t); } else if (t.sig !== sig) { t.sig = sig; t.changed = now; }
    if (BN.size > 400) for (const [k, v] of BN) if (now - v.changed > 3600e3) BN.delete(k);
    return t;
  }
  const secs = (t) => { const x = Math.max(0, Math.round((Date.now() - t) / 1000)); return x < 60 ? x + 's' : x < 3600 ? Math.floor(x / 60) + 'm' : Math.floor(x / 3600) + 'h'; };
  // Kalshi contract side in words: a NO on a team's contract names that team
  const sideTxt = (p, g) => (p.side === 'NO' && (p.m?.side === 'home' || p.m?.side === 'away') ? `NO on ${g[p.m.side].abbr}` : p.side);
  function buyInner(p, g, rank, fe, extra) {
    const t = bnTrack(p), first = fe?.firstSeen ?? t.first, fresh = Date.now() - first < 90e3;
    const clock = g.state === 'in' ? `${U.periodShort(g.period)} ${U.fmtClock(g.clockSec)}` : U.localTime(g.date);
    const [who, sel] = heading(p, g);
    return `<span class="bn-rank">${rank}</span><span class="bn-body">
        <span class="bn-top"><b>${U.esc(who)}</b>${fresh ? '<em class="bn-new">NEW</em>' : ''}${extra || ''}</span>
        <small>${U.esc(sel)} · ${sideTxt(p, g)} · ${U.esc(g.away.abbr)}@${U.esc(g.home.abbr)} · ${clock}${p.lag ? ' · <em class="lagx">LAG</em>' : ''}${p.delayed ? ` · price ${Math.max(1, Math.round(p.delayed))}m old` : ''}</small>
        <span class="bn-vals"><span><label>Kalshi Ask</label><b>${c0(p.price)}</b></span><span><label>True Probability</label><b>${P2(p.fair)}</b></span><span class="e"><label>Edge</label><b>${U.signed(p.netEdge * 100, 2)}%</b></span></span>
        <span class="bn-foot"><span class="bn-age${fresh ? ' new' : ''}">found ${secs(first)} ago · updated ${secs(t.changed)} ago</span>${addBtn(MYB.has(p.id), 'data-rowadd="1"')}</span>
      </span>`;
  }
  // keyed live list: rows persist, re-rank every tick, slide to their new positions (FLIP), flash on rank changes
  function keyed(box, items) {
    if (!box._rows) { box.innerHTML = ''; box._h = null; box._rows = new Map(); }
    else if (Date.now() - lastTouch < 700) return; // never re-rank under a finger
    const before = new Map(); for (const [k, el] of box._rows) before.set(k, el.getBoundingClientRect().top);
    const keep = new Set(), now = Date.now();
    items.forEach((it, i) => {
      keep.add(it.key);
      let el = box._rows.get(it.key);
      if (!el) { el = document.createElement('div'); el.setAttribute('role', 'button'); el.tabIndex = 0; box._rows.set(it.key, el); el._anim = 'enter'; el._animUntil = now + 600; }
      el.dataset.pick = it.p.id; el.dataset.game = it.g.id;
      if (el._rank && el._rank !== i + 1) { el._anim = i + 1 < el._rank ? 'up' : 'down'; el._animUntil = now + 900; }
      el._rank = i + 1;
      const cls = it.cls + (now < (el._animUntil || 0) ? ' ' + el._anim : '');
      if (el.className !== cls) el.className = cls;
      if (el._h !== it.html) { el.innerHTML = it.html; el._h = it.html; }
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    });
    for (const [k, el] of box._rows) if (!keep.has(k)) { el.remove(); box._rows.delete(k); }
    for (const [k, el] of box._rows) {
      const f = before.get(k); if (f == null) continue;
      const d = f - el.getBoundingClientRect().top;
      if (Math.abs(d) > 1) { el.style.transition = 'none'; el.style.transform = `translateY(${d}px)`; requestAnimationFrame(() => { el.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1)'; el.style.transform = ''; }); }
    }
  }
  function renderBuyNow(g) {
    const box = $('#fBuy'); if (!box) return;
    const bl = buyLists([g]);
    const nEl = $('#fBuyN'), nTxt = bl.buy.length ? `${bl.buy.length} in buy zone` : 'none in buy zone';
    if (nEl.textContent !== nTxt) nEl.textContent = nTxt;
    if (!$('#fBuyBox').open) return;
    if (!bl.buy.length) {
      const h = buyHTML(bl, 8, KALSHI.hasGame(g.kkey) ? 'Zero contracts inside a buy zone at current prices.' : 'No Kalshi prices for this game yet.');
      if (box._h !== h || box._rows) { box.innerHTML = h; box._h = h; box._rows = null; }
      return;
    }
    const feedMap = new Map(PICKS.feed(g.id).map((e) => [e.key, e]));
    keyed(box, bl.buy.slice(0, 8).map(({ p, g: gg }, i) => ({ key: p.id, p, g: gg, cls: `tk bn tier-${(p.tier || 'none').toLowerCase()}`, html: buyInner(p, gg, i + 1, feedMap.get(p.id)) })));
  }

  // ---------- home: Best Edges across every game on the selected day ----------
  let bestAt = 0;
  function renderBest(force) {
    const box = $('#best'); if (!box || $('#bestBox').hidden) return;
    if (!force && Date.now() - bestAt < 1000) return;
    bestAt = Date.now();
    const games = STATE.list.filter((g) => g.dateKey === STATE.dateKey && g.state !== 'post');
    const rows = [];
    for (const g of games) for (const p of g.eval?.picks || []) {
      if (!kalshiBuyable(p) || !p.survivor || (F.noCombo && isCombo(p)) || p.fair < F.minP - 1e-9) continue;
      rows.push({ p, g });
    }
    let list = rows;
    if (!F.allRungs) { const ks = new Set(bestRungs(rows.map((x) => x.p))); list = rows.filter((x) => ks.has(x.p)); }
    list.sort((a, b) => (b.p.playable - a.p.playable) || (b.p.netEdge - a.p.netEdge));
    const loading = games.filter((g) => !INTEL.get(g.id)?.players?.size).length;
    const nTxt = `${list.length} cleared · ${games.length} game${games.length === 1 ? '' : 's'}${loading ? ` · loading players for ${loading}` : ''}`;
    if ($('#bestN').textContent !== nTxt) $('#bestN').textContent = nTxt;
    if (!list.length) {
      const h = `<p class="muted small">${!games.length ? 'No games left on this date.' : !STATE.loaded ? 'Loading the slate…' : 'Nothing clears every stress test right now. Props appear as each game’s player data loads; edges are re-checked every second.'}</p>`;
      if (box._h !== h || box._rows) { box.innerHTML = h; box._h = h; box._rows = null; }
      return;
    }
    const feed = new Map(PICKS.allFeed().map((e) => [e.key, e]));
    keyed(box, list.slice(0, 12).map(({ p, g }, i) => ({ key: p.id, p, g, cls: `tk bn best tier-${(p.tier || 'none').toLowerCase()}${p.playable ? '' : ' wait'}`,
      html: buyInner(p, g, i + 1, feed.get(p.id), p.playable ? '<em class="bn-zone">BUY ZONE</em>' : `<em class="bn-wait">WAIT ≤ ${c0(p.buyMax)}</em>`) })));
  }
  // + on any live list row (Buy Now, Best Edges): same add flow as the pick cards
  function rowAdd(btn) {
    const row = btn.closest('[data-pick]'), g = STATE.games.get(row?.dataset.game);
    const p = g && (g.eval?.picks || []).concat(g.eval?.all || []).find((x) => x.id === row.dataset.pick);
    if (!p) return;
    lastTouch = Date.now();
    btn.classList.add('on'); btn.classList.remove('bounce'); void btn.offsetWidth; btn.classList.add('bounce');
    const [who, sel] = heading(p, g);
    setTimeout(() => MYB.openAdd({ mode: 'pick', legs: [MYB.legFrom(p, g)], ask: p.price ?? null, title: who, sub: `${sel} · ${sideTxt(p, g)} · ${g.away.abbr}@${g.home.abbr}`, btn }), 260);
  }
  function goPick(gid, pid) {
    location.hash = 'game-' + gid;
    setTimeout(() => { const t = document.getElementById('pk-' + pid.replace(/[^A-Za-z0-9_-]/g, '_')); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); } }, 700);
  }
  function watchRow(p, g) {
    return `<button class="tk wl" data-game="${g.id}" data-pick="${U.esc(p.id)}">
        <span class="tk-main"><b>${U.esc(p.label)}</b><small>${U.esc(g.away.abbr)}@${U.esc(g.home.abbr)} · ${p.modelOnly ? 'no live price on this line' : `now ${Math.round(p.price * 100)}¢`} · true ${(p.fair * 100).toFixed(1)}%</small></span>
        <span class="tk-side"><b>≤ ${Math.floor(p.maxEntry * 100)}¢</b><small>buy zone</small></span>
      </button>`;
  }
  function buyLists(games) {
    const buy = [], watch = [], model = [];
    for (const g of games) {
      if (!g.eval || g.state === 'post') continue;
      for (const p of g.eval.picks) {
        if (!kalshiBuyable(p) || (F.noCombo && isCombo(p)) || p.fair < F.minP - 1e-9) continue;
        if (p.playable) buy.push({ p, g });
        else if (p.survivor) watch.push({ p, g });
      }
      for (const p of (g.eval.models || []).slice(0, 4)) model.push({ p, g });
    }
    if (!F.allRungs) { const keep = new Set(bestRungs(buy.map((x) => x.p))); for (let i = buy.length - 1; i >= 0; i--) if (!keep.has(buy[i].p)) buy.splice(i, 1); }
    buy.sort((a, b) => b.p.netEdge - a.p.netEdge);
    watch.sort((a, b) => (a.p.price - a.p.maxEntry) - (b.p.price - b.p.maxEntry));
    model.sort((a, b) => b.p.rating - a.p.rating);
    return { buy, watch, model };
  }
  function buyHTML(lists, max, empty) {
    let h = `<p class="muted small bn-empty">${empty}</p>`;
    if (lists.watch.length) h += `<h4 class="subh">Survived stress tests — above buy zone, wait for the price</h4>` + lists.watch.slice(0, 5).map(({ p, g }) => watchRow(p, g)).join('');
    else if (lists.model.length) h += `<h4 class="subh">Model overs — check the price on Kalshi</h4>` + lists.model.slice(0, 5).map(({ p, g }) => watchRow(p, g)).join('');
    return h;
  }
  function renderTicker() { renderBest(); }

  // ---------- Pick Finder ----------
  function openFinder(id) {
    const g = STATE.games.get(id);
    if (!g) return false;
    if (finder?.id === id) return true;
    closeFinder(true);
    const el = $('#finder');
    el.innerHTML = `<div class="fwin window" role="dialog" aria-label="Pick Finder">
      <div class="titlebar big"><span class="ticon"></span><span class="tb-t">Pick Finder — ${U.esc(g.away.abbr)} @ ${U.esc(g.home.abbr)}</span>
        <span class="wbtns"><button class="wb cl" id="fClose" aria-label="Close Pick Finder">✕</button></span></div>
      <div class="fbody">
        <section class="fhero">
          <div class="courtbox big"><canvas class="court"></canvas></div>
          <div class="lcd big">
            <div class="tm away">${logoImg(g.away)}<div><b>${U.esc(g.away.name)}</b><small class="rec">${U.esc(g.away.record)}</small></div></div>
            <div class="mid"><span class="sc sa"></span><span class="clk"><b></b><small></small></span><span class="sc sh"></span></div>
            <div class="tm home"><div><b>${U.esc(g.home.name)}</b><small class="rec">${U.esc(g.home.record)}</small></div>${logoImg(g.home)}</div>
          </div>
          ${wpBarHTML()}
          <div class="qtab" id="fQtab"></div>
          <div class="wpt" id="fWpt"></div>
          <div class="probs" id="fProbs"></div>
          <div class="lineq" id="fLines"></div>
        </section>
        <div class="toolbar" role="toolbar">
          <div class="seg" id="fFilter">${[['all', 'All'], ['live', 'Live'], ['prop', 'Props'], ['line', 'Lines'], ['seg', 'Qtrs/Halves']].map(([k, l]) => `<button class="chip${F.filter === k ? ' on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
          <label class="chk"><input type="checkbox" id="fPlay" ${F.playable ? 'checked' : ''}> Buy zone only</label>
          <label class="chk"><input type="checkbox" id="fNoCombo" ${F.noCombo ? 'checked' : ''}> Hide PRA &amp; combos</label>
          <label class="chk"><input type="checkbox" id="fBest" ${F.allRungs ? '' : 'checked'}> Best rung only</label>
          <label class="sel">Min hit <select id="fMinP">${[0.3, 0.4, 0.5, 0.6, 0.7].map((v) => `<option value="${v}"${Math.abs(F.minP - v) < 1e-6 ? ' selected' : ''}>${v * 100}%</option>`).join('')}</select></label>
        </div>
        <section class="pane roster"><h3><span class="ico i-roster"></span>Verified Roster / Injury Status</h3><div id="fRoster"></div></section>
        <section class="pane"><h3><span class="ico i-map"></span>Edge Map<small id="fCount"></small></h3><div id="fChart" class="chart"></div></section>
        <details class="pane fold buynow" id="fBuyBox"><summary><h3><span class="ico i-buy"></span>Buy Now<small id="fBuyN"></small></h3></summary><div id="fBuy"></div></details>
        <details class="pane fold" id="fSec1" open><summary><h3><span class="ico i-list"></span>Section 1 · Main Picks<small id="fUpd"></small></h3></summary><div id="fList" class="plist"></div></details>
        <details class="pane fold" id="fSec2" open><summary><h3><span class="ico i-parlay"></span>Section 2 · Optimal Parlays<small id="fParN"></small></h3></summary><div id="fParlays" class="plist"></div></details>
        <details class="pane fold" id="fCustomBox"><summary><h3><span class="ico i-custom"></span>Build Your Own Pick<small>any market · any line</small></h3></summary><div id="fCustom" class="cpwrap"></div></details>
        <details class="pane fold" id="fFeedBox"><summary><h3><span class="ico i-feed"></span>Live Pick Feed<small>buy-zone entries</small></h3></summary><ol id="fFeed" class="feed"></ol></details>
        <details class="pane fold" id="fBoardBox"><summary><h3><span class="ico i-board"></span>Projection Board</h3></summary><div id="fBoard"></div></details>
        <details class="pane fold" id="fIntelBox"><summary><h3><span class="ico i-intel"></span>Matchup Intel</h3></summary><div id="fIntel" class="intel"></div></details>
        <details class="pane fold notes"><summary><h3><span class="ico i-notes"></span>Risk protocol</h3></summary>
          <p><b>Phase 1 — roster air-gap.</b> Injury status comes only from the official game-day report (ESPN); ESPN team news can only bench a player (never activate one). Players not listed are fully active; a player in tonight's live box score is active. Teammate usage shifts apply only to OUT (1.00) and DOUBTFUL (0.75). Own-prop DNP risk: QUESTIONABLE 18%, PROBABLE 3%.</p>
          <p><b>Phase 2 — stress tests.</b> Possessions = home pace (home games) × away pace (road games) ÷ league, from each team's recent box scores. Volume scales to tonight's possessions; efficiency to the opponent's points allowed per 100 possessions, defense-vs-position, shot-zone and shot-type defense, and transition defense (each shrunk toward league by sample size); all blended 50/50 with the market-implied team total. Usage (FGA + 0.44·FTA + TOV)/min with/without each OUT teammate; minutes ramps after absences and role changes inferred from logs; news-reported minute limits and starting-role changes applied. Fatigue: back-to-back, 3-in-4, road stretches, time zones, altitude. Market read: every ladder (a player's 20+/25+/30+, a total's lines, a team's spread lines) gets one always-decreasing Kalshi curve fitted to its quotes by liquidity, and one model weight for the whole ladder, so probabilities can never run backwards; pregame quarters/halves lean 70% on that curve. Scoring by quarter uses real shares (Q4 is the slowest). Gates: net edge ≥ +4.00%, true probability ≥ 30% (or edge ≥ +10 and ROI ≥ +60%), trend sanitization, prices ≤ 10 min old; a thin book (spread > 12¢ or no bid) survives only when the liquid lines of its own ladder value it above the ask and the edge is ≥ +6%; MARKET CONFLICT blocks any ladder where the model and a liquid Kalshi ladder differ by more than 22 points. Teammate absences use same-season with/without splits, count only what his recent games don't already reflect, and add (never multiply) with caps. Player props are overs only.</p>
          <p><b>Phase 3 — sizing.</b> ¼-Kelly % of bankroll = 25% of the full Kelly stake (props/lines), × 0.85 (two-leg) or × 0.70 (three-leg) for parlays. Parlay legs are Section 1 survivors at least as likely as your Min hit setting; a ticket must clear +4.00 pts compound edge, hit at least 1.18× as often as its price implies, stay +EV with correlation removed, and hit at least 25% (two legs) or 14% (three legs). Tickets mix props with game lines when both exist, bar negative or redundant correlations (Gaussian copula with Monte Carlo pricing), rank by compound edge, and every bet family (all rungs of one ladder) appears on one ticket only. The combo price shown is the product of the live leg asks; Kalshi's own combo quote can differ. Prices are Kalshi's; Robinhood can differ. The Kalshi taker fee 0.07·P·(1−P) is included in EV.</p></details>
        <div id="fKnote" class="kfoot"></div>
      </div></div>`;
    el.hidden = false;
    document.body.classList.add('finder-open');
    const court = COURT.create($('canvas', el), { big: true });
    court.setGame(g);
    finder = { id, court, el };
    $('#fClose').onclick = () => { clearHash(); closeFinder(); };
    $('#fFilter').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; F.filter = b.dataset.f; $$('#fFilter .chip').forEach((x) => x.classList.toggle('on', x === b)); updateFinder(true); };
    $('#fPlay').onchange = (e) => { F.playable = e.target.checked; updateFinder(true); };
    $('#fNoCombo').onchange = (e) => { F.noCombo = e.target.checked; U.store.set('nocombo', F.noCombo); updateFinder(true); };
    $('#fBest').onchange = (e) => { F.allRungs = !e.target.checked; U.store.set('allrungs', F.allRungs); updateFinder(true); };
    $('#fMinP').onchange = (e) => { F.minP = +e.target.value; U.store.set('minp2', F.minP); updateFinder(true); };
    for (const id2 of ['fBuyBox', 'fSec1', 'fSec2', 'fCustomBox', 'fFeedBox', 'fBoardBox', 'fIntelBox']) $('#' + id2).addEventListener('toggle', () => updateFinder(true));
    $('#fBuy').onclick = (e) => { const a = e.target.closest('.addb'); if (a) return rowAdd(a); const b = e.target.closest('[data-pick]'); if (!b) return; const t = document.getElementById('pk-' + b.dataset.pick.replace(/[^A-Za-z0-9_-]/g, '_')); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); } };
    // per-card tabs (History / Evidence): one panel at a time, state kept across refreshes, built on demand
    const rawPick = (pid) => { const g = STATE.games.get(finder?.id); return g && (g.eval?.picks || []).concat(g.eval?.models || [], g.eval?.all || []).find((x) => x.id === pid); };
    const findPick = (pid) => { const g = STATE.games.get(finder?.id), p = rawPick(pid); return p && g ? curPick(p, g) : p; };
    // line steppers, Kalshi line chips and resets (pick cards and parlay legs)
    const onLine = (e) => {
      const b = e.target.closest('[data-lstep],[data-lset],[data-lreset],[data-pxreset]'); if (!b) return false;
      lastTouch = Date.now();
      const g = STATE.games.get(finder?.id); if (!g) return true;
      if (b.dataset.pxreset) { for (const k of [...PXL.keys()]) if (k.startsWith(b.dataset.pxreset + '|')) PXL.delete(k); PXPIN.delete(b.dataset.pxreset); updateFinder(true); return true; }
      let base, key, map;
      if (b.dataset.pid) { base = rawPick(b.dataset.pid); key = b.dataset.pid; map = LSEL; }
      else if (b.dataset.px) { const c = PX.get(b.dataset.px); const l = c?.legs.find((x) => (x.base || x.p).id === b.dataset.leg); base = l && (l.base || l.p); key = b.dataset.px + '|' + b.dataset.leg; map = PXL; }
      if (!base || !adjustable(base)) return true;
      if (b.dataset.px && PXBASE.has(b.dataset.px)) PXPIN.set(b.dataset.px, PXBASE.get(b.dataset.px)); // pin before the optimizer can drop it
      const b0 = PICKS.lineOf(base), cur = map.has(key) ? map.get(key) : b0;
      const n = b.dataset.lset != null ? +b.dataset.lset : b.dataset.lreset != null ? b0 : stepLine(base, cur, +b.dataset.lstep);
      if (Math.abs(n - b0) < 1e-6) map.delete(key); else map.set(key, n);
      updateFinder(true);
      return true;
    };
    const onAdd = (e) => {
      const b = e.target.closest('.addb'); if (!b) return false;
      lastTouch = Date.now();
      const g = STATE.games.get(finder?.id); if (!g) return true;
      b.classList.add('on'); b.classList.remove('bounce'); void b.offsetWidth; b.classList.add('bounce');
      if (b.dataset.add) {
        const p = findPick(b.dataset.add); if (!p) return true;
        const [who, sel] = heading(p, g);
        setTimeout(() => MYB.openAdd({ mode: 'pick', legs: [MYB.legFrom(p, g)], ask: p.price ?? null, title: who, sub: `${sel} · ${sideTxt(p, g)} · ${g.away.abbr}@${g.home.abbr}`, btn: b }), 260);
      } else if (b.dataset.addpx) {
        const c = PX.get(b.dataset.addpx); if (!c) return true;
        setTimeout(() => MYB.openAdd({ mode: 'parlay', pxId: b.dataset.addpx, legs: c.legs.map((l) => MYB.legFrom(l.p, l.g)), ask: c.mkt, title: `${c.legs.length}-leg optimal parlay`, sub: c.legs.map((l) => heading(l.p, l.g)[0]).join(' · '), btn: b }), 260);
      }
      return true;
    };
    const onTab = (e) => {
      if (onLine(e) || onAdd(e)) return;
      const t = e.target.closest('.tab'); if (!t) return;
      lastTouch = Date.now();
      const card = t.closest('.pick'), k = t.dataset.k, pid = card.dataset.id, g = STATE.games.get(finder?.id);
      const was = openDetails.has(k);
      card.querySelectorAll('.tab').forEach((x) => { openDetails.delete(x.dataset.k); x.classList.remove('on'); });
      const panel = card.querySelector('.pk-panel');
      if (was) { panel.innerHTML = ''; return; }
      openDetails.add(k); t.classList.add('on');
      if (pid.startsWith('px-')) { updateFinder(true); return; }
      const p = findPick(pid); if (!p || !g) return;
      panel.innerHTML = k.endsWith(':hist') ? `<div class="histbox">${histHTML(p)}</div>` : evidenceHTML(p, g);
    };
    $('#fList').addEventListener('click', onTab);
    $('#fParlays').addEventListener('click', onTab);
    $('#fList').addEventListener('toggle', (e) => { const d = e.target; if (d.tagName !== 'DETAILS' || !d.dataset.k) return; if (d.open) openDetails.add(d.dataset.k); else openDetails.delete(d.dataset.k); updateFinder(true); }, true);
    // tap a history bar → tooltip with opponent and minutes
    el.addEventListener('click', (e) => {
      const b = e.target.closest('.hb'); if (!b) return;
      lastTouch = Date.now() + 2500;
      const wrap = b.closest('.hwrap'), tip = wrap.querySelector('.htip');
      const r = b.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      tip.textContent = b.dataset.tip; tip.hidden = false;
      const tw = tip.offsetWidth / 2 + 4;
      tip.style.left = U.clamp(r.left - w.left + r.width / 2, tw, Math.max(tw, w.width - tw)) + 'px';
      wrap.querySelectorAll('.hb.on').forEach((x) => x.classList.remove('on')); b.classList.add('on');
    });
    el.scrollTop = 0;
    updateFinder(true);
    APP.focus(id);
    return true;
  }
  function closeFinder(silent) {
    if (!finder) return;
    finder.court.destroy();
    finder = null;
    const el = $('#finder'); el.hidden = true; el.innerHTML = '';
    document.body.classList.remove('finder-open');
    if (!silent) APP.focus(null);
  }

  function filtered(picks) {
    let ps = picks;
    if (F.filter === 'live') ps = ps.filter((p) => p.live);
    else if (F.filter === 'prop') ps = ps.filter((p) => p.kind === 'prop');
    else if (F.filter === 'line') ps = ps.filter((p) => p.kind !== 'prop' && !p.seg);
    else if (F.filter === 'seg') ps = ps.filter((p) => p.seg);
    if (F.playable) ps = ps.filter((p) => p.playable);
    if (F.noCombo) ps = ps.filter((p) => !isCombo(p));
    ps = ps.filter((p) => p.fair >= F.minP - 1e-9);
    if (!F.allRungs) ps = bestRungs(ps);
    // strict descending order by net mathematical edge (model-only lines by lean)
    return [...ps].sort((a, b) => (b.netEdge ?? b.lean ?? -1) - (a.netEdge ?? a.lean ?? -1));
  }

  const amOf = (pr) => (pr <= 0 || pr >= 1 ? '—' : pr >= 0.5 ? '−' + Math.round(pr / (1 - pr) * 100) : '+' + Math.round((1 - pr) / pr * 100));
  const P2 = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(2) + '%');
  const SEGL = { Q1: '1st Quarter', Q2: '2nd Quarter', Q3: '3rd Quarter', Q4: '4th Quarter', '1H': '1st Half', '2H': '2nd Half' };
  // "[Player or Team] — [Selection]"
  function heading(p, g) {
    const m = p.m, seg = m.seg ? ` (${SEGL[m.seg]})` : '';
    const tn = (side) => g[side].full || g[side].name;
    const other = (side) => (side === 'home' ? 'away' : 'home');
    switch (p.kind) {
      case 'prop': { const L = MODEL.LABEL[m.stat] || m.stat; return [m.player || p.data.player.name, `Over ${(m.th.k - 0.5).toFixed(1)} ${L.replace(/^./, (c) => c.toUpperCase())} (${m.th.k}+)`]; }
      case 'ml': if (m.side === 'tie') return [`${g.away.abbr} @ ${g.home.abbr}`, p.yes ? `${SEGL[m.seg]} Tie` : `No ${SEGL[m.seg]} Tie`]; return [tn(p.yes ? m.side : other(m.side)), `Moneyline${seg}`];
      case 'spread': return p.yes ? [tn(m.side), `−${m.th.line} Spread${seg}`] : [tn(other(m.side)), `+${m.th.line} Spread${seg}`];
      case 'total': return [`${g.away.abbr} @ ${g.home.abbr}`, `${p.yes ? 'Over' : 'Under'} ${m.th.line} Total Points${seg}`];
      case 'teamtotal': return [tn(m.side), `${p.yes ? 'Over' : 'Under'} ${m.th.line} Team Points${seg}`];
      case 'margin': { const r = m.range ? (m.range[1] === Infinity ? `${m.range[0]}+` : `${m.range[0]}–${m.range[1]}`) : ''; return [tn(m.side), `${p.yes ? '' : 'NOT '}Wins by ${r}`]; }
      case 'ot': return [`${g.away.abbr} @ ${g.home.abbr}`, p.yes ? 'Game Goes to Overtime' : 'No Overtime'];
    }
    return [p.label, p.sub];
  }
  function marketLine(p, g) {
    const [, sel] = heading(p, g);
    if (p.modelOnly) return `${sel} — no live Kalshi quote (buy only at ≤ $${p.maxEntry.toFixed(2)})`;
    if (p.book) return `${sel} at ${PICKS.fmtAm(p.am)} (${U.esc(p.book)})`;
    return `${sel} at $${p.price.toFixed(2)} Kalshi ${p.side} ask (${amOf(p.price)})${p.delayed ? ` · price ${U.ago(p.m.snapAt)}` : ''}`;
  }
  // three-zone bracket in cents per contract: BUY ≤ buyMax (≥ +4.00 pts edge) · FAIR ≤ break-even · DO NOT BUY above
  const c0 = (x) => (x == null || !isFinite(x) ? '—' : Math.round(x * 100) + '¢');
  const c1 = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(1) + '¢');
  function bracket(buyMax, fairMax, now, fmt) {
    const pos = (v) => U.clamp(v * 100, 0, 100).toFixed(1) + '%';
    const bt = fmt === c0 ? Math.floor(buyMax * 100) / 100 : buyMax, ft = fmt === c0 ? Math.max(bt, Math.floor(fairMax * 100) / 100) : Math.max(bt, fairMax);
    const step = fmt === c0 ? 0.01 : 0.001;
    return `<div class="entry"><div class="eb"><i class="g" style="width:${pos(bt)}"></i><i class="y" style="left:${pos(bt)};width:${U.clamp((ft - bt) * 100, 0, 100).toFixed(1)}%"></i><i class="r" style="left:${pos(ft)}"></i>${now != null ? `<b class="now" style="left:${pos(now)}"></b>` : ''}</div>
      <div class="el"><span class="g">BUY ≤ ${fmt(bt)}</span>${ft > bt ? `<span>FAIR ${fmt(bt + step)}–${fmt(ft)}</span>` : ''}<span class="bad">DO NOT BUY ≥ ${fmt(ft + step)}</span></div></div>`;
  }
  const kellyPct = (k) => (k * 100).toFixed(2) + '%';
  function statRow(cells) { return `<div class="pk-row">${cells.map(([l, v, cls]) => `<div><label>${l}</label><b${cls ? ` class="${cls}"` : ''}>${v}</b></div>`).join('')}</div>`; }

  // ---- History: last 10 games and last 10 vs tonight's opponent (lazy; built only when opened) ----
  function histChart(rows, stat, k, title, uid) {
    if (!rows.length) return `<div class="hchart"><h5>${title}</h5><p class="muted small">No games in the last two seasons.</p></div>`;
    const W = 320, H = 132, T = 14, B = 22, L = 4, Rr = 4, n = rows.length;
    const vals = rows.map((r) => MODEL.statVal(r, stat));
    const top = Math.max(k ?? 0, ...vals, 1) * 1.15;
    const slot = (W - L - Rr) / Math.max(n, 5), bw = Math.min(26, slot * 0.68);
    const y = (v) => H - B - (v / top) * (H - T - B);
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="hsvg" role="img" aria-label="${U.esc(title)}"><defs>
      <linearGradient id="h${uid}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#9cf5b3"/><stop offset=".5" stop-color="#2fb457"/><stop offset=".51" stop-color="#1f8c40"/><stop offset="1" stop-color="#34b45c"/></linearGradient>
      <linearGradient id="h${uid}m" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#b9c6d6"/><stop offset=".5" stop-color="#6b7c90"/><stop offset=".51" stop-color="#55657a"/><stop offset="1" stop-color="#6b7c90"/></linearGradient></defs>`;
    svg += `<line x1="${L}" x2="${W - Rr}" y1="${H - B}" y2="${H - B}" class="hbase"/>`;
    if (k != null) svg += `<line x1="${L}" x2="${W - Rr}" y1="${y(k)}" y2="${y(k)}" class="hline"/><text x="${W - Rr - 2}" y="${y(k) - 3}" text-anchor="end" class="hlab">${k}+</text>`;
    rows.forEach((r, i) => {
      const v = vals[i], x = L + slot * i + (slot - bw) / 2, yy = y(v), h = Math.max(0, H - B - yy), hit = k != null && v >= k;
      const d = new Date(r.date), tip = `vs ${r.opp} · ${Math.round(r.min)} min · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${v} ${MODEL.SHORT[stat] || stat}`;
      svg += `<g class="hb" data-tip="${U.esc(tip)}" tabindex="0"><rect x="${x - 3}" y="${T}" width="${bw + 6}" height="${H - T - B + 14}" fill="transparent"/>`;
      if (h > 0) svg += `<rect x="${x}" y="${yy}" width="${bw}" height="${h}" rx="3" fill="url(#h${uid}${hit ? 'g' : 'm'})" stroke="rgba(0,0,0,.6)" stroke-width="1"/><rect x="${x + 2}" y="${yy + 1}" width="${Math.max(0, bw - 4)}" height="${Math.min(6, h / 2)}" rx="2" fill="rgba(255,255,255,.35)"/>`;
      svg += `<text x="${x + bw / 2}" y="${H - B - 4}" text-anchor="middle" class="hval">${v}</text><text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle" class="hopp">${U.esc(r.opp || '')}</text></g>`;
    });
    const hits = k != null ? vals.filter((v) => v >= k).length : 0;
    return `<div class="hchart"><h5>${title}<small>${k != null ? `${hits}/${n} at ${k}+ · avg ${(U.sum(vals) / n).toFixed(1)}` : ''}</small></h5><div class="hwrap">${svg}</svg><div class="htip" hidden></div></div></div>`;
  }
  function histHTML(p) {
    const pl = p.data.player, st = p.m.stat, k = p.m.th?.k, games = (pl.proj?.games || []);
    const uid = U.hash(p.id).toString(36);
    const last = games.slice(0, 10).reverse();
    const vs = games.filter((r) => r.opp === pl.ctx?.opp).slice(0, 10).reverse();
    const S = MODEL.SHORT[st] || st;
    return histChart(last, st, k, `Last 10 games · ${S}`, uid + 'a') + histChart(vs, st, k, `Last ${vs.length || 10} vs ${pl.ctx?.opp || 'opponent'} · ${S}`, uid + 'b');
  }

  // ---------- adjustable lines (props, spreads, totals, team totals) ----------
  const LSEL = new Map();   // pick id → line chosen by the user
  const PXL = new Map();    // `${parlay id}|${leg id}` → line chosen for that leg
  const adjustable = (p) => !!p?.m?.th && PICKS.ADJ.has(p.m.kind) && !p.book && p.m.th.op !== '<';
  // spreads read from the backed team's side: YES on "X wins by L+" is X −L, NO is the other team +L
  const dispOf = (p, line) => (p.m.kind === 'spread' && p.yes ? -line : line);
  const fmtLine = (p, line) => { const v = dispOf(p, line); return p.m.kind === 'spread' ? (v > 0 ? '+' : '−') + Math.abs(v) : String(v); };
  const stepLine = (p, line, dir) => { const n = line + (p.m.kind === 'spread' && p.yes ? -dir : dir); return n >= 0.5 ? n : line; };
  const curPick = (p, g) => (LSEL.has(p.id) ? PICKS.variant(p, g, LSEL.get(p.id)) : p);
  function lineRow(base, cur, g, attrs) {
    const now = PICKS.lineOf(cur), b0 = PICKS.lineOf(base);
    const lad = PICKS.ladder(base.m, g).sort((a, c) => Math.abs(a - now) - Math.abs(c - now)).slice(0, 4).sort((a, c) => dispOf(base, a) - dispOf(base, c));
    const chips = lad.map((L) => `<button class="lchip${Math.abs(L - now) < 1e-6 ? ' on' : ''}" data-lset="${L}" ${attrs}>${fmtLine(base, L)}</button>`).join('');
    return `<div class="lrow"><button class="lsb" data-lstep="-1" ${attrs} aria-label="Lower the line">−</button><span class="lval"><label>Line</label><b>${fmtLine(base, now)}</b></span><button class="lsb" data-lstep="1" ${attrs} aria-label="Raise the line">+</button>${chips ? `<span class="lchips" title="Lines Kalshi lists">${chips}</span>` : ''}${Math.abs(now - b0) > 1e-6 ? `<button class="lreset" data-lreset="1" ${attrs} aria-label="Back to the original line">↺</button>` : ''}</div>`;
  }

  function pickHTML(base, g) {
    const p = curPick(base, g), adj = p !== base;
    const fe = PICKS.feed(g.id).find((e) => e.key === p.id);
    const chips = [];
    if (p.live) chips.push('<span class="chipx live">LIVE</span>');
    if (p.lag) chips.push('<span class="chipx lag">LAG</span>');
    if (p.thin) chips.push(`<span class="chipx thin">THIN BOOK · LADDER ${c0(p.thin.prior)}</span>`);
    if (p.playable) chips.push('<span class="chipx new">BUY ZONE</span>');
    if (p.delayed) chips.push(`<span class="chipx delayed">${Math.max(1, Math.round(p.delayed))}m DELAY</span>`);
    if (p.book) chips.push(`<span class="chipx book">${U.esc(p.book.toUpperCase())}</span>`);
    const stc = p.kind === 'prop' ? p.data.player.st?.code : null;
    if (stc && stc !== 'ACTIVE') chips.push(`<span class="chipx lag">${U.esc(stc)}</span>`);
    if (fe) { const m = Math.max(0, Math.round((Date.now() - fe.firstSeen) / 60000)); chips.push(`<span>logged ${m ? m + 'm' : '<1m'} ago · ${U.esc(fe.periodTag)}</span>`); }
    if (adj) chips.unshift(`<span class="chipx custom">YOUR LINE</span>${p.status === 'hit' ? '<span class="chipx new">ALREADY HIT ✓</span>' : p.status === 'lost' ? '<span class="chipx lag">ALREADY LOST</span>' : p.custom ? '<span class="chipx lag">NO KALSHI MARKET AT THIS LINE</span>' : ''}`);
    if (p.reason && !adj) chips.push(`<span class="rejt">${U.esc(p.reason)}</span>`);
    const [who, sel] = heading(p, g);
    const pid = U.esc(base.id), hk = base.id + ':hist', ek = base.id + ':ev';
    const askLabel = p.book ? U.esc(p.book) : 'Kalshi Ask';
    const cells = p.modelOnly
      ? [['Kalshi Ask', 'no quote'], ['True Probability', P2(p.fair)], ['Buy if ≤', c0(p.buyMax), 'pos'], ['1/4-Kelly % of bankroll', '—']]
      : [[askLabel, p.book ? `${c0(p.price)}<em>${PICKS.fmtAm(p.am)}</em>` : c0(p.price)], ['True Probability', P2(p.fair)], ['Mathematical Edge', p.netEdge == null ? '—' : U.signed(p.netEdge * 100, 2) + '%', p.netEdge >= 0 ? 'pos' : 'neg'], ['1/4-Kelly % of bankroll', kellyPct(p.kelly || 0)]];
    const showHist = p.kind === 'prop' && p.data.player?.proj;
    return `<article class="pick tier-${(base.tier || 'none').toLowerCase()}${base.survivor || base.modelOnly || adj ? '' : ' dim'}${adj ? ' adj' : ''}" id="pk-${U.esc(base.id.replace(/[^A-Za-z0-9_-]/g, '_'))}" data-id="${pid}">
      <div class="pk-h">${avatarHTML(p, g)}<span class="pk-t"><b>${U.esc(who)}</b><small>${U.esc(sel)}</small></span><span class="side ${p.side === 'YES' ? 'yes' : 'no'}">${p.side}</span></div>
      ${adjustable(base) ? lineRow(base, p, g, `data-pid="${pid}"`) : ''}
      ${statRow(cells)}
      ${bracket(p.buyMax, p.fairMax, p.price, c0)}
      ${chips.length ? `<div class="pk-m">${chips.join('')}</div>` : ''}
      <div class="pk-tabs">${showHist ? `<button class="tab${openDetails.has(hk) ? ' on' : ''}" data-k="${U.esc(hk)}">History</button>` : ''}<button class="tab${openDetails.has(ek) ? ' on' : ''}" data-k="${U.esc(ek)}">Data-Driven Strategic Evidence</button>${addBtn(MYB.has(p.id), `data-add="${pid}"`)}</div>
      <div class="pk-panel">${showHist && openDetails.has(hk) ? `<div class="histbox">${histHTML(p)}</div>` : ''}${openDetails.has(ek) ? evidenceHTML(p, g) : ''}</div>
    </article>`;
  }
  function evidenceHTML(p, g) { const ev = PICKS.evidence(p, g); return `<ul class="evs">${ev.sections.map((x) => `<li class="ev-${x.k}"><b>${x.title}:</b> ${U.esc(x.t)}</li>`).join('')}</ul>`; }

  const addBtn = (on, attr) => `<button class="addb${on ? ' on' : ''}" ${attr} aria-label="Add to My Bets or a parlay"><i class="pl"></i><i class="ck"></i></button>`;
  // ---------- Section 2: parlays ----------
  const PX = new Map(); // parlay card id → ticket (for the + button)
  const PXPIN = new Map(); // parlay id → base ticket the user edited: stays on screen until reset
  const PXBASE = new Map(); // parlay id → the optimizer's ticket as last shown
  // a ticket with any user-moved leg lines, re-priced with the joint engine (no market at a line → no combo ask)
  function adjTicket(c, id) {
    if (!c.legs.some((l) => PXL.has(id + '|' + l.p.id))) return c;
    const legs = c.legs.map((l) => { const L = PXL.get(id + '|' + l.p.id); if (L == null) return l; const v = PICKS.variant(l.p, l.g, L); return { ...PARLAY.legOf(v, l.g), base: l.p }; });
    const m = PARLAY.metrics(legs, legs.map((l) => l.p.fair), legs.map((l) => l.p.price ?? null));
    return { ...c, legs, adjusted: true, trueP: m.p, indTrue: m.ind, mkt: m.ask, cost: m.cost, edge: m.edge, ratio: m.ratio, lift: m.ind ? m.p / m.ind - 1 : 0, kelly: m.kelly, fairMax: m.be, buyMax: Math.max(0, Math.min(m.p - 0.04, m.be - 0.01)), pairs: m.rel, minR: m.rel.length ? Math.min(...m.rel.map((x) => x.r)) : 0 };
  }
  function parlayHTML(c0x) {
    const id = 'px-' + U.hash(c0x.legs.map((l) => l.p.id).join('|')).toString(36);
    const c = adjTicket(c0x, id);
    PXBASE.set(id, c0x); if (PXBASE.size > 60) PXBASE.delete(PXBASE.keys().next().value);
    if (c.adjusted) PXPIN.set(id, c0x); else PXPIN.delete(id);
    PX.set(id, c); if (PX.size > 60) PX.delete(PX.keys().next().value);
    const legs = c.legs.map((l, i) => {
      const base = l.base || l.p, [who, sel] = heading(l.p, l.g);
      const st = adjustable(base) ? `<span class="lmini"><button class="lsb s" data-lstep="-1" data-px="${id}" data-leg="${U.esc(base.id)}" aria-label="Lower this leg's line">−</button><button class="lsb s" data-lstep="1" data-px="${id}" data-leg="${U.esc(base.id)}" aria-label="Raise this leg's line">+</button></span>` : '';
      return `<li${l.base ? ' class="adj"' : ''}><b>${i + 1}</b><span>${U.esc(who)} — ${U.esc(sel)}</span><em>${l.p.price != null ? c0(l.p.price) : 'no mkt'}</em>${st}</li>`;
    }).join('');
    const ek = id + ':ev';
    return `<article class="pick parlay" id="${id}" data-id="${id}">
      <div class="pk-h"><span class="badge plx">${c.legs.length}-LEG<b>${c.edge != null ? (c.edge * 100).toFixed(1) : '—'}</b></span><span class="pk-t"><b>${c.legs.length}-Leg ${c.adjusted ? 'Parlay · your lines' : 'Optimal Parlay'}</b><small>hits ${(c.trueP * 100).toFixed(1)}%${c.mkt != null ? ` vs ${c1(c.mkt)} price` : ' · a leg has no Kalshi market at its line'}</small></span>${c.adjusted ? `<button class="lreset" data-pxreset="${id}">Reset</button>` : ''}</div>
      <ol class="plegs">${legs}</ol>
      ${statRow([['Kalshi Ask', c1(c.mkt)], ['True Probability', P2(c.trueP)], ['Mathematical Edge', c.edge == null ? '—' : U.signed(c.edge * 100, 2) + '%', c.edge == null ? '' : c.edge >= 0 ? 'pos' : 'neg'], ['1/4-Kelly % of bankroll', kellyPct(c.kelly || 0)]])}
      ${bracket(c.buyMax, c.fairMax, c.mkt, c1)}
      <div class="pk-m">${c.ratio ? `<span class="chipx ${c.ratio >= 1 ? 'new' : 'lag'}">HITS ${c.ratio.toFixed(2)}× ITS PRICE</span>` : ''}${c.lift > 0.005 ? `<span class="chipx corr">CORRELATION +${(c.lift * 100).toFixed(1)}%</span>` : ''}<span>combo price = leg asks multiplied</span></div>
      <div class="pk-tabs"><button class="tab${openDetails.has(ek) ? ' on' : ''}" data-k="${ek}">Mathematical Synergy &amp; Correlation Analysis</button>${addBtn(MYB.hasPx(id), `data-addpx="${id}"`)}</div>
      <div class="pk-panel">${openDetails.has(ek) ? `<ul class="evs">${PARLAY.report(c).map((x) => `<li class="ev-${x.k}"><b>${x.title}:</b> ${U.esc(x.t)}</li>`).join('')}</ul>` : ''}</div>
    </article>`;
  }
  function parlaysHTML(res, empty) {
    // edited tickets stay pinned even if the live optimizer drops them; their legs re-price every refresh
    const ids = new Set([...res.two, ...res.three].map((c) => 'px-' + U.hash(c.legs.map((l) => l.p.id).join('|')).toString(36)));
    const pinned = [...PXPIN.entries()].filter(([id, c]) => !ids.has(id) && c.legs[0]?.g?.id === finder?.id).map(([, c]) => ({ ...c, legs: c.legs.map((l) => ({ ...l, p: (l.g.eval?.all || []).find((x) => x.id === l.p.id) || l.p })) }));
    const pin = pinned.length ? `<h4 class="subh">Your edited parlays</h4>` + pinned.map(parlayHTML).join('') : '';
    if (!res.two.length && !res.three.length) return pin + `<p class="muted small">${empty}</p>`;
    return pin + (res.two.length ? `<h4 class="subh">2-leg</h4>` + res.two.map(parlayHTML).join('') : '') + (res.three.length ? `<h4 class="subh">3-leg</h4>` + res.three.map(parlayHTML).join('') : '');
  }

  // ---------- quarter-by-quarter scoreboard: Q1 Q2 Q3 Q4 [OT] TOTAL 1H 2H ----------
  function qtabHTML(g) {
    const live = g.state === 'in', post = g.state === 'post';
    const nP = Math.max(4, g.home.line.length, g.away.line.length, live ? g.period : 0);
    const cur = live ? g.period : 0;
    const started = (i) => post || (live && i < g.period);
    const sum = (line, a, z) => { let t = 0; for (let i = a; i < z; i++) t += line[i] || 0; return t; };
    const heads = [];
    for (let i = 0; i < nP; i++) heads.push(i < 4 ? 'Q' + (i + 1) : (i === 4 ? 'OT' : `${i - 3}OT`));
    const cells = (side) => {
      const L = g[side].line;
      const v = [];
      for (let i = 0; i < nP; i++) v.push(started(i) ? (L[i] ?? 0) : null);
      v.push(g.state === 'pre' ? null : g[side].score);
      v.push(started(0) ? sum(L, 0, 2) : null);
      v.push(started(2) ? sum(L, 2, 4) : null);
      return v;
    };
    const a = cells('away'), h = cells('home');
    const cls = ['', ...heads.map((_, i) => (i + 1 === cur ? 'cur' : '')), 'tot', 'half', 'half'];
    const th = ['', ...heads, 'TOTAL', '1H', '2H'];
    const row = (side, v, o) => `<tr><th><span class="qsw" style="--c:#${U.pairColors(g.away, g.home)[side === 'away' ? 0 : 1]}"></span>${U.esc(g[side].abbr)}</th>${v.map((x, i) => `<td class="${cls[i + 1]}${x != null && o[i] != null && x > o[i] ? ' lead' : ''}">${x == null ? '–' : x}</td>`).join('')}</tr>`;
    return `<table class="qt"><thead><tr>${th.map((t, i) => `<th class="${cls[i]}">${t}</th>`).join('')}</tr></thead><tbody>${row('away', a, h)}${row('home', h, a)}</tbody></table>`;
  }

  // ---------- win-probability timeline (model vs Kalshi) ----------
  function wpTimelineHTML(g) {
    const H = g.wpHist || [];
    if (g.state === 'pre' || H.length < 2) return '';
    const W = 340, Ht = 86, L = 2, R0 = 2, T = 6, B = 14;
    const end = Math.max(48, H[H.length - 1].el);
    const x = (el) => L + (el / end) * (W - L - R0), y = (p) => T + (1 - p) * (Ht - T - B);
    const [ca, ch] = U.pairColors(g.away, g.home);
    const pts = H.map((d) => `${x(d.el).toFixed(1)},${y(d.wp).toFixed(1)}`).join(' ');
    const k = H.filter((d) => d.kp != null).map((d) => `${x(d.el).toFixed(1)},${y(d.kp).toFixed(1)}`).join(' ');
    const mid = y(0.5), last = H[H.length - 1];
    let s = `<svg viewBox="0 0 ${W} ${Ht}" class="wpsvg" role="img" aria-label="Win probability timeline"><defs>
      <clipPath id="wpTop"><rect x="0" y="0" width="${W}" height="${mid}"/></clipPath><clipPath id="wpBot"><rect x="0" y="${mid}" width="${W}" height="${Ht}"/></clipPath>
      <linearGradient id="wpH" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#${ch}" stop-opacity=".75"/><stop offset="1" stop-color="#${ch}" stop-opacity=".1"/></linearGradient>
      <linearGradient id="wpA" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#${ca}" stop-opacity=".1"/><stop offset="1" stop-color="#${ca}" stop-opacity=".75"/></linearGradient></defs>`;
    for (let q = 12; q < end; q += q < 48 ? 12 : 5) s += `<line x1="${x(q)}" x2="${x(q)}" y1="${T}" y2="${Ht - B}" class="wpq"/>`;
    s += `<polygon points="${x(H[0].el)},${mid} ${pts} ${x(last.el)},${mid}" fill="url(#wpH)" clip-path="url(#wpTop)"/><polygon points="${x(H[0].el)},${mid} ${pts} ${x(last.el)},${mid}" fill="url(#wpA)" clip-path="url(#wpBot)"/>`;
    s += `<line x1="${L}" x2="${W - R0}" y1="${mid}" y2="${mid}" class="wpm"/>`;
    if (k) s += `<polyline points="${k}" class="wpk"/>`;
    s += `<polyline points="${pts}" class="wpl"/><circle cx="${x(last.el)}" cy="${y(last.wp)}" r="3.2" class="wpd"/>`;
    ['Q1', 'Q2', 'Q3', 'Q4'].forEach((q, i) => (s += `<text x="${x(i * 12 + 6)}" y="${Ht - 3}" text-anchor="middle" class="wpx">${q}</text>`));
    s += `<text x="${W - 4}" y="${T + 9}" text-anchor="end" class="wpx">${U.esc(g.home.abbr)} ${Math.round(last.wp * 100)}%</text><text x="${W - 4}" y="${Ht - B - 3}" text-anchor="end" class="wpx">${U.esc(g.away.abbr)} ${Math.round((1 - last.wp) * 100)}%</text></svg>`;
    return `<div class="wpt-h"><span>Win probability</span><span class="wleg"><i class="lm"></i>model<i class="lk"></i>Kalshi</span></div>${s}`;
  }

  // ---------- 2K-style avatar: headshot (props) or team plate (lines), rating chip ----------
  function avatarHTML(p, g) {
    const tierC = { HOF: 'hof', GOLD: 'gold', SILVER: 'silver', BRONZE: 'bronze' }[p.tier] || 'none';
    let inner;
    if (p.kind === 'prop' && p.data?.player) {
      const pl = p.data.player, side = pl.side, ini = pl.name.split(' ').map((w) => w[0]).slice(0, 2).join('');
      const col = U.pairColors(g.away, g.home)[side === 'away' ? 0 : 1];
      inner = !NET.isDemo() && pl.espnId ? `<img src="https://a.espncdn.com/i/headshots/nba/players/full/${U.esc(pl.espnId)}.png" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('i'),{textContent:'${U.esc(ini)}'}))"><s style="--c:#${col}"></s>` : `<i>${U.esc(ini)}</i><s style="--c:#${col}"></s>`;
    } else {
      const side = p.kind === 'total' || p.kind === 'ot' ? 'home' : (p.yes ? p.m.side : (p.m.side === 'home' ? 'away' : 'home')) || 'home';
      const t = g[side] || g.home;
      inner = t.logo && !NET.isDemo() ? `<img class="tl" src="${U.esc(t.logo)}" alt="" loading="lazy">` : `<i class="tp" style="--c:#${t.color};--c2:#${t.alt}">${U.esc(t.abbr)}</i>`;
    }
    return `<span class="av t-${tierC}">${inner}<b>${p.rating}</b></span>`;
  }

  // ---------- Verified roster / injury status (once per game) ----------
  function rosterHTML(g) {
    const rec = INTEL.get(g.id);
    if (!rec || !INTEL.reportLoaded(rec)) return '<p class="muted small">Game-day injury report not loaded yet — every pick for this game is held until it is (Phase 1).</p>';
    const col = (side) => {
      const l = INTEL.injuriesFor(rec, g, side);
      const bench = [...rec.players.values()].filter((x) => x.side === side && x.st?.code === 'CONFLICT');
      const nws = (rec.news?.[side] || []).filter((a) => a.at && g.date - a.at < 48 * 3600e3 && /restriction|limit|start|bench|ruled out|will not play|won't play|sidelined|will miss|questionable|probable|return/i.test(a.head + ' ' + a.desc)).slice(0, 3);
      return `<div class="rcol"><h4>${teamSwatch(g[side])}${U.esc(g[side].abbr)}</h4>${l.length ? `<ul>${l.map((x) => `<li><b class="${/OUT|DOUBT/.test(x.code) ? 'out' : 'q'}">${U.esc(x.code)}</b>${U.esc(x.name)}${x.detail ? ` <small>${U.esc(x.detail)}</small>` : ''}</li>`).join('')}</ul>` : '<p class="small">No designations — full roster active.</p>'}${bench.length ? `<p class="small warn">Props benched (source conflict): ${bench.map((x) => U.esc(x.name)).join(', ')}</p>` : ''}${nws.length ? `<ul class="news">${nws.map((a) => `<li>${U.esc(a.head)} <small>${U.ago(a.at)}</small></li>`).join('')}</ul>` : ''}</div>`;
    };
    return `<div class="rcols">${col('away')}${col('home')}</div><p class="muted small">Source: official game-day injury report, pulled ${U.ago(rec.sumAt)}. Players not listed are fully active; anyone in tonight's live box score is active. QUESTIONABLE props carry an 18% DNP discount.</p>`;
  }

  function renderFeed(g) {
    const items = PICKS.feed(g.id).slice(0, 25);
    $('#fFeed').innerHTML = items.length ? items.map((e) => `<li class="${e.active ? 'act' : 'gone'}"><time>${U.ago(e.firstSeen)}</time><span><b>${U.esc(e.label)}</b> · buy ${e.side} @ ${U.cents(e.entry)} <em>true ${(e.fair0 * 100).toFixed(2)}%, edge ${U.signed(e.edge0 * 100, 2)}%</em>${e.lag ? ' <span class="chipx lag">LAG</span>' : ''}</span><small>${e.periodTag}${e.active ? ' · open' : ' · faded after ' + dur(e.closedAt - e.firstSeen)}</small></li>`).join('')
      : `<li class="muted">No edges yet. New ones are logged here with the game clock and how long ago they opened.</li>`;
  }

  function probsHTML(g) {
    const pre = g.pre?.src || {};
    const cells = [
      ['Model', g.wp, true], ['Kalshi', g.kp], ['ESPN', g.state === 'in' ? g.espnWP : pre.bpi], ['Book', g.state === 'pre' ? pre.bookP : null],
    ].filter((c) => c[1] != null);
    return cells.map(([l, v, main]) => `<div class="pb${main ? ' main' : ''}"><label>${l}</label><b>${g.home.abbr} ${U.pct(v)}</b></div>`).join('') + (g.run && g.run.pts - g.run.opp >= 6 && g.state === 'in' ? `<div class="pb run"><label>Momentum</label><b>${g[g.run.side].abbr} ${g.run.pts}–${g.run.opp} run</b></div>` : '');
  }

  function linesHTML(g) {
    const pre = g.pre; if (!pre) return '';
    const s = pre.src;
    const parts = [];
    if (s.bookSpread != null) parts.push(`<span><label>${U.esc(s.book || 'Book')}</label>${s.bookSpread >= 0 ? g.home.abbr : g.away.abbr} −${Math.abs(s.bookSpread).toFixed(1)} · ${s.bookTotal ?? '—'}</span>`);
    if (s.kalshiSpread != null || s.kalshiTotal != null) parts.push(`<span><label>Kalshi implied</label>${s.kalshiSpread != null ? (s.kalshiSpread >= 0 ? g.home.abbr : g.away.abbr) + ' −' + Math.abs(s.kalshiSpread).toFixed(1) : '—'} · ${s.kalshiTotal != null ? s.kalshiTotal.toFixed(1) : '—'}</span>`);
    parts.push(`<span><label>Consensus</label>${pre.spread >= 0 ? g.home.abbr : g.away.abbr} −${Math.abs(pre.spread).toFixed(1)} · ${pre.total.toFixed(1)}</span>`);
    if (g.state === 'in') parts.push(`<span><label>Live model</label>proj ${(g.ls.margin + g.sEff * g.ls.tau) >= 0 ? g.home.abbr : g.away.abbr} by ${Math.abs(g.ls.margin + g.sEff * g.ls.tau).toFixed(1)} · ${MODEL.totalDist(g.ls, g.tEff, g).mu.toFixed(1)}</span>`);
    return parts.join('');
  }

  function segFairHTML(g) {
    if (!g.pre || g.state === 'post') return '';
    const ctx = { ls: g.ls, sEff: g.sEff ?? g.pre.spread, tEff: g.tEff ?? g.pre.total };
    const cells = ['Q1', 'Q2', 'Q3', 'Q4', '1H', '2H'].map((seg) => {
      const h = MODEL.lineProb({ kind: 'ml', seg, side: 'home' }, g, ctx), a = MODEL.lineProb({ kind: 'ml', seg, side: 'away' }, g, ctx);
      if (!h || !a) return '';
      const done = h.sd < 0.05;
      const tie = Math.max(0, 1 - h.p - a.p);
      return `<div class="sf${done ? ' done' : ''}"><label>${seg}</label><span>${U.esc(g.away.abbr)} <b>${U.cents(a.p)}</b></span><span>${U.esc(g.home.abbr)} <b>${U.cents(h.p)}</b></span><small>${done ? 'settled' : 'tie ' + U.pct(tie)}</small></div>`;
    }).join('');
    return `<h4 class="subh">Quarter &amp; half winners — fair prices</h4><div class="segfair">${cells}</div><p class="muted small">Compare these with Robinhood or a sportsbook when Kalshi has no quarter market. A tied segment usually settles NO for both teams.</p>`;
  }

  function boardHTML(g) {
    const rec = INTEL.get(g.id);
    const seg = segFairHTML(g);
    if (!rec || !rec.players.size) return seg + `<p class="muted">${rec?.loading ? 'Loading game logs…' : 'Player projections load with the game logs.'}</p>`;
    const rows = [...rec.players.values()].filter((p) => p.proj).sort((a, b) => (a.side === b.side ? b.proj.proj.pts.mu - a.proj.proj.pts.mu : a.side === 'away' ? -1 : 1));
    const box = STATE.box.get(g.id);
    return seg + `<h4 class="subh">Player projections</h4><div class="tblwrap"><table class="board"><thead><tr><th>Player</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>3PM</th><th>PRA</th>${box ? '<th>Live</th>' : ''}</tr></thead><tbody>${rows.map((p) => {
      const pr = p.proj.proj; const lb = box ? (box.byEspn.get(p.espnId) || box.players.find((x) => U.nameScore(x.name, p.name) >= 0.9)) : null;
      return `<tr><td><span class="dot" style="--c:#${U.onDark(g[p.side].color)}"></span>${U.esc(p.name)}${p.status ? ` <em class="inj">${U.esc(p.status)}</em>` : ''}${p.ctx?.b2b ? ' <em class="b2b">B2B</em>' : ''}</td><td>${p.proj.minProj.toFixed(0)}</td><td>${pr.pts.mu.toFixed(1)}</td><td>${pr.reb.mu.toFixed(1)}</td><td>${pr.ast.mu.toFixed(1)}</td><td>${pr.fg3m.mu.toFixed(1)}</td><td>${pr.pra.mu.toFixed(1)}</td>${box ? `<td>${lb ? `${lb.pts}/${lb.reb}/${lb.ast} · ${lb.min.toFixed(0)}m${lb.pf >= 4 ? ` <em class="inj">${lb.pf}PF</em>` : ''}` : '—'}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div><p class="muted small">Projections: two seasons of game logs, recent form weighted, adjusted for minutes, market-implied team total, matchup history, home/away and injuries.</p>`;
  }

  function intelHTML(g) {
    const rec = INTEL.get(g.id);
    const S = rec?.summary;
    const st = STATE.standings?.teams || {};
    const team = (side) => {
      const t = g[side], s = st[t.id];
      const inj = rec ? INTEL.injuriesFor(rec, g, side) : [];
      const l5 = S?.lastFive?.[t.id] || [];
      return `<div class="tcol"><h4>${teamSwatch(t)}${U.esc(t.full)}</h4>
        ${s?.pf ? `<div class="meters"><div><label>Offense</label><b>${s.pf.toFixed(1)}</b><i style="--v:${U.clamp((31 - s.offRank) / 30, 0.03, 1)}"></i><small>#${s.offRank}</small></div><div><label>Defense</label><b>${s.pa.toFixed(1)}</b><i style="--v:${U.clamp((31 - s.defRank) / 30, 0.03, 1)}"></i><small>#${s.defRank}</small></div><div><label>Record</label><b>${s.w}-${s.l}</b><small>${U.esc(s.streak)}</small></div></div>` : ''}
        <div class="l5">${l5.map((e) => `<span class="${e.result === 'W' ? 'w' : 'l'}" title="${U.esc(e.atVs + ' ' + e.opp + ' ' + e.score)}">${e.result}<small>${U.esc(e.opp)}</small></span>`).join('') || '<span class="muted small">Last 5 loads with the game summary</span>'}</div>
        <ul class="inj">${inj.length ? inj.map((x) => `<li><b class="${/out/i.test(x.status) ? 'out' : 'q'}">${U.esc(x.status)}</b> ${U.esc(x.name)}${x.detail ? ` <small>${U.esc(x.detail)}</small>` : ''}</li>`).join('') : '<li class="muted small">No injuries listed</li>'}</ul></div>`;
    };
    const ser = S?.series;
    return `<div class="tcols">${team('away')}${team('home')}</div>
      ${ser ? `<div class="series"><h4>${U.esc(ser.title)}</h4><p>${U.esc(ser.summary || '')}</p>${ser.events.map((e) => `<span>${new Date(e.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${U.esc(e.away)} ${e.as}–${e.hs} ${U.esc(e.home)}</span>`).join('')}</div>` : ''}
      ${S?.predictor ? `<p class="small">ESPN BPI: ${g.home.abbr} ${U.pct(S.predictor.home, 1)} · ${g.away.abbr} ${U.pct(S.predictor.away, 1)}</p>` : ''}`;
  }

  // Section 2 source: every priced side in this game; the optimizer keeps Section 1 survivors and re-applies every gate
  function parlaysFor(g) {
    const ev = g.eval; if (!ev) return { two: [], three: [] };
    const cands = (ev.all || []).filter((p) => !(F.noCombo && isCombo(p))).map((p) => ({ p, g }));
    return PARLAY.build(cands, { pool: 24, max: 5, minLeg: Math.max(0.45, F.minP), ...(window.__PXOPT || {}) });
  }
  function updateFinder(force) {
    if (!finder) return;
    const g = STATE.games.get(finder.id); if (!g) return;
    const el = finder.el;
    finder.court.setGame(g);
    const s = statusLine(g);
    const sa = $('.lcd .sa', el), sh = $('.lcd .sh', el);
    if (sa.textContent !== String(g.away.score)) { sa.textContent = g.away.score; bump(sa); }
    if (sh.textContent !== String(g.home.score)) { sh.textContent = g.home.score; bump(sh); }
    $('.lcd .clk b', el).textContent = s.main; $('.lcd .clk small', el).textContent = s.sub;
    updateWP($('.fhero', el), g);
    const qh = qtabHTML(g), qe = $('#fQtab'); if (qe._h !== qh) { qe.innerHTML = qh; qe._h = qh; }
    const wh = wpTimelineHTML(g), we = $('#fWpt'); if (we._h !== wh) { we.innerHTML = wh; we._h = wh; }
    $('#fProbs').innerHTML = probsHTML(g);
    $('#fLines').innerHTML = linesHTML(g);
    renderBuyNow(g);
    if ($('#fCustomBox').open) MYB.renderCustom($('#fCustom'), 'finder', g.id);
    const ev = g.eval;
    const now = Date.now();
    if (force || (now - lastListRender > 2500 && !busy())) {
      lastListRender = now;
      const surv = ev ? filtered(ev.survivors || []) : [];
      const rej = ev ? filtered((ev.picks || []).filter((p) => !p.survivor)) : [];
      const ms = ev && !F.playable ? filtered(ev.models || []) : [];
      const au = ev?.audit;
      $('#fCount').textContent = ev ? `${surv.length} survived · ${au.priced + au.roster} priced` : '';
      $('#fUpd').textContent = ev ? `${surv.length} survived` : '';
      { const kh = kalshiNote(g), kEl = $('#fKnote'); if (kEl._h !== kh) { kEl.innerHTML = kh; kEl._h = kh; } }
      const rh = rosterHTML(g); const rEl = $('#fRoster'); if (rEl._h !== rh) { rEl.innerHTML = rh; rEl._h = rh; }
      const set = (sel, html) => { const x = $(sel); if (x._h !== html) { x.innerHTML = html; x._h = html; } };
      if ($('#fSec1').open) {
        const pend = ev?.pending?.length || 0;
        const rec = INTEL.get(g.id);
        let html = kalshiStale(g);
        if (au) html += `<p class="audit"><b>${surv.length} survived</b> of ${au.priced + au.roster} · rejected: edge &lt; +4% ${au.edge} · true &lt; 30% ${au.floor} · thin book ${au.illiquid} · market conflict ${au.conflict || 0} · trend ${au.trend} · roster ${au.roster}</p>`;
        // picks whose line you moved stay pinned on top even if they drop out of the filtered list
        const shownIds = new Set(surv.slice(0, 40).map((p) => p.id));
        const pinned = [...LSEL.keys()].filter((id) => !shownIds.has(id)).map((id) => (ev.picks || []).concat(ev.all || [], ev.models || []).find((x) => x.id === id && x.gameId === g.id)).filter(Boolean);
        if (pinned.length) html += `<h4 class="subh">Your lines</h4>` + pinned.map((p) => pickHTML(p, g)).join('');
        if (surv.length) html += (pinned.length ? '<h4 class="subh">Main picks</h4>' : '') + surv.slice(0, 40).map((p) => pickHTML(p, g)).join('');
        else html += `<p class="muted small">${!rec || !INTEL.reportLoaded(rec) ? 'Holding all picks until the game-day injury report is loaded (Phase 1).' : g.state === 'post' ? 'This game is final.' : 'Zero assets cleared every stress test at current prices.'}</p>`;
        if (pend) html += `<p class="muted small">${pend} prop markets waiting on game logs.</p>`;
        if (rej.length && !F.playable) html += `<details class="rejbox" data-k="rej"${openDetails.has('rej') ? ' open' : ''}><summary>Discarded by stress tests (${rej.length})</summary>${openDetails.has('rej') ? rej.slice(0, 25).map((p) => { const [w, sl] = heading(p, g); return `<div class="rejrow"><b>${U.esc(w)} — ${U.esc(sl)}</b><span>${p.price != null ? c0(p.price) : '—'} · true ${P2(p.fair)} · ${U.esc(p.reason)}</span></div>`; }).join('') : ''}</details>`;
        if (ms.length) html += `<details class="rejbox" data-k="unpriced"${openDetails.has('unpriced') ? ' open' : ''}><summary>Unpriced model lines — not edge-verifiable (${ms.length})</summary>${openDetails.has('unpriced') ? ms.slice(0, 20).map((p) => pickHTML(p, g)).join('') : ''}</details>`;
        set('#fList', html);
      }
      if ($('#fSec2').open) {
        const pr = parlaysFor(g);
        $('#fParN').textContent = `${pr.two.length + pr.three.length} tickets`;
        set('#fParlays', parlaysHTML(pr, 'No 2- or 3-leg combination from this game clears +4.00% compound edge, 18% above its price, with non-negative correlation.'));
      }
      if ($('#fFeedBox').open) renderFeed(g);
      if ($('#fBoardBox').open) set('#fBoard', boardHTML(g));
      if ($('#fIntelBox').open) set('#fIntel', intelHTML(g));
    }
    if (force || (now - lastChartRender > 4000 && !busy())) {
      lastChartRender = now;
      const priced = ev ? filtered(ev.picks.filter((p) => !p.book || true)) : [];
      const lean = !priced.length;
      const ps = lean ? (ev ? filtered(ev.models || []) : []) : priced;
      CHART.render($('#fChart'), ps, { lean, onPick: (id) => { const t = document.getElementById('pk-' + id.replace(/[^A-Za-z0-9_-]/g, '_')); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); } } });
    }
  }

  function banner(html, kind = 'info') {
    const b = $('#banner');
    if (!html) { b.hidden = true; b.innerHTML = ''; return; }
    b.className = 'banner window ' + kind; b.innerHTML = html; b.hidden = false;
  }

  function init() {
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) document.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true });
    $('#dates').onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; if (b.dataset.k === 'bets') return MYB.show(true); if (MYB.view() === 'bets') MYB.show(false); APP.setDate(b.dataset.k); };
    $('#best').onclick = (e) => { const a = e.target.closest('.addb'); if (a) return rowAdd(a); const r = e.target.closest('[data-pick]'); if (r) goPick(r.dataset.game, r.dataset.pick); };
    $('#best').onkeydown = (e) => { if (e.key === 'Enter') { const r = e.target.closest('[data-pick]'); if (r) goPick(r.dataset.game, r.dataset.pick); } };
    $('#games').onclick = (e) => { const c = e.target.closest('.gcard'); if (c) location.hash = 'game-' + c.dataset.id; };
    $('#games').onkeydown = (e) => { if (e.key === 'Enter') { const c = e.target.closest('.gcard'); if (c) location.hash = 'game-' + c.dataset.id; } };
    if ($('#ticker')) $('#ticker').onclick = (e) => { const b = e.target.closest('[data-game]'); if (!b) return; location.hash = 'game-' + b.dataset.game; setTimeout(() => { const t = document.getElementById('pk-' + b.dataset.pick.replace(/[^A-Za-z0-9_-]/g, '_')); if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); } }, 600); };
    $('#btnSettings').onclick = () => { const s = $('#settings'); s.hidden = !s.hidden; if (!s.hidden) $('#proxyIn').value = NET.getProxy(); };
    $('#setClose').onclick = () => ($('#settings').hidden = true);
    $('#proxySave').onclick = () => { NET.setProxy($('#proxyIn').value.trim()); $('#settings').hidden = true; APP.restart(); };
    $('#demoBtn').onclick = () => { $('#settings').hidden = true; APP.startDemo(); };
    $('#liveBtn').onclick = () => { $('#settings').hidden = true; APP.startLive(); };
    // Clear cache keeps My Bets and the parlay builder
    $('#clearBtn').onclick = () => { try { Object.keys(localStorage).filter((k) => k.startsWith('ce:') && !/^ce:(bets|slip)(:demo)?$/.test(k)).forEach((k) => localStorage.removeItem(k)); } catch { } $('#settings').hidden = true; APP.restart(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && finder) { clearHash(); closeFinder(); } });
    NET.onChange(() => { clearTimeout(init._t); init._t = setTimeout(renderFeeds, 200); });
  }

  return { init, renderGames, updateCard, renderDates, renderFeeds, renderTicker, openFinder, closeFinder, updateFinder, scoreFx, banner, finderId: () => finder?.id || null, heading, avatarHTML, statRow, parlaysFor, renderBest, sideTxt: (p, g) => sideTxt(p, g), F };
})();
