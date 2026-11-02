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
  const F = { filter: 'all', sort: 'rating', playable: false };
  let lastListRender = 0, lastChartRender = 0, lastTicker = 0, lastTickerHTML = '', lastTouch = 0;
  const busy = () => Date.now() - lastTouch < 2000;

  const clearHash = () => { try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; } };
  const dur = (ms) => { const sec = Math.max(1, Math.round(ms / 1000)); return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's'; };
  const DEPLOY = 'https://vercel.com/new/import?s=' + encodeURIComponent('https://github.com/montroseweb/courtside-edge');
  function kalshiNote(g) {
    const st = KALSHI.status(), h = NET.health('kalshi');
    if (KALSHI.hasGame(g.kkey)) return '';
    if (NET.isDemo()) return '';
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
    r.A.style.setProperty('--c', '#' + U.onDark(g.away.color)); r.H.style.setProperty('--c', '#' + U.onDark(g.home.color));
    r.l.classList.toggle('fav', a > 0.5); r.r.classList.toggle('fav', p > 0.5);
    if (g.kp != null) {
      r.mk.hidden = false; r.mk.style.left = ((1 - g.kp) * 100).toFixed(1) + '%';
      const kh = Math.round(g.kp * 100); r.em.textContent = 'K ' + (100 - kh) + '|' + kh;
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
    $('#dates').innerHTML = STATE.dates.map((k) => `<button class="chip${k === STATE.dateKey ? ' on' : ''}" data-k="${k}">${U.dayLabel(k, STATE.todayKey)}</button>`).join('');
  }

  // ---------- feed LEDs ----------
  function renderFeeds() {
    const srcs = [['espn', 'ESPN', 'ESPN'], ['nba', 'NBA', 'NBA'], ['kalshi', 'KALSHI', 'KAL']];
    $('#feeds').innerHTML = srcs.map(([k, l, ls]) => {
      const h = NET.health(k);
      const tip = h.level === 'ok' ? `${l}: ${Math.round(h.lat)} ms · ${h.mode}` : h.err ? `${l}: ${h.err}` : `${l}: waiting`;
      return `<span class="led ${h.level}" title="${U.esc(tip)}"><i></i><b class="lf">${l}</b><b class="ls">${ls}</b><small>${h.level === 'ok' ? Math.round(h.lat) + 'ms' : h.level === 'down' ? 'off' : '…'}</small></span>`;
    }).join('');
  }

  // ---------- ticker (top edges across the slate) ----------
  function renderTicker() {
    const el = $('#ticker');
    if (busy() || Date.now() - lastTicker < 2000) return;
    lastTicker = Date.now();
    const all = [];
    for (const g of STATE.list) if (g.eval && g.state !== 'post') for (const p of g.eval.picks) if (p.playable) all.push({ p, g });
    all.sort((a, b) => b.p.rating - a.p.rating);
    if (!all.length) { // no priced edges anywhere (e.g. Kalshi blocked): show the strongest model picks
      for (const g of STATE.list) if (g.eval && g.state !== 'post') for (const p of (g.eval.models || []).slice(0, 3)) all.push({ p, g });
      all.sort((a, b) => b.p.rating - a.p.rating);
    }
    const feedMap = new Map(PICKS.allFeed().map((e) => [e.key, e]));
    if (!all.length) {
      lastTickerHTML = '';
      el.innerHTML = `<p class="muted">${KALSHI.status().markets ? 'No prices beat the models by enough right now. New edges appear here with a timestamp the moment they open.' : 'Waiting for Kalshi prices…'}</p>`;
      return;
    }
    const html = all.slice(0, 10).map(({ p, g }) => {
      const fe = feedMap.get(p.id);
      return `<button class="tk tier-${(p.tier || 'none').toLowerCase()}" data-game="${g.id}" data-pick="${U.esc(p.id)}">
        <span class="tk-badge">${p.tier ? p.tier : 'OVR'}<b>${p.rating}</b></span>
        <span class="tk-main"><b>${U.esc(p.label)}</b><small>${U.esc(g.away.abbr)}@${U.esc(g.home.abbr)} · ${p.modelOnly ? `${p.side} if ≤ ${U.cents(p.maxEntry)} · no live price` : p.book ? `${U.esc(p.book)} ${PICKS.fmtAm(p.am)} → fair ${U.cents(p.fair)}` : `buy ${p.side} ${U.cents(p.price)} → fair ${U.cents(p.fair)}`}</small></span>
        <span class="tk-side">${p.modelOnly ? `<b>${U.pct(p.fair)}</b><small>model · ≤${U.cents(p.maxEntry)}</small>` : `<b class="pos">+${(p.edge * 100).toFixed(1)}¢</b><small>${fe ? U.ago(fe.firstSeen) : ''}${p.lag ? ' · LAG' : ''}</small>`}</span>
      </button>`;
    }).join('');
    if (html !== lastTickerHTML) { el.innerHTML = html; lastTickerHTML = html; }
  }

  // ---------- Pick Finder ----------
  function openFinder(id) {
    const g = STATE.games.get(id);
    if (!g) return false;
    if (finder?.id === id) return true;
    closeFinder(true);
    const el = $('#finder');
    el.innerHTML = `<div class="fwin window" role="dialog" aria-label="Pick Finder">
      <div class="titlebar big"><span class="ticon"></span><span class="tb-t">Pick Finder — ${U.esc(g.away.abbr)} @ ${U.esc(g.home.abbr)}</span>
        <span class="wbtns"><button class="wb mn" aria-hidden="true" tabindex="-1"></button><button class="wb mx" aria-hidden="true" tabindex="-1"></button><button class="wb cl" id="fClose" aria-label="Close Pick Finder">✕</button></span></div>
      <div class="fbody">
        <section class="fhero">
          <div class="courtbox big"><canvas class="court"></canvas></div>
          <div class="lcd big">
            <div class="tm away">${logoImg(g.away)}<div><b>${U.esc(g.away.name)}</b><small class="rec">${U.esc(g.away.record)}</small></div></div>
            <div class="mid"><span class="sc sa"></span><span class="clk"><b></b><small></small></span><span class="sc sh"></span></div>
            <div class="tm home"><div><b>${U.esc(g.home.name)}</b><small class="rec">${U.esc(g.home.record)}</small></div>${logoImg(g.home)}</div>
          </div>
          ${wpBarHTML()}
          <div class="probs" id="fProbs"></div>
          <div class="lineq" id="fLines"></div>
        </section>
        <div class="toolbar" role="toolbar">
          <div class="seg" id="fFilter">${[['all', 'All'], ['live', 'Live'], ['prop', 'Props'], ['line', 'Lines'], ['seg', 'Qtrs/Halves']].map(([k, l]) => `<button class="chip${F.filter === k ? ' on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
          <label class="chk"><input type="checkbox" id="fPlay" ${F.playable ? 'checked' : ''}> +EV only</label>
          <label class="sel">Sort <select id="fSort"><option value="rating">Pick rating</option><option value="edge">Edge ¢</option><option value="roi">ROI</option><option value="conf">Confidence</option></select></label>
        </div>
        <section class="pane"><h3>Edge Map<small id="fCount"></small></h3><div id="fChart" class="chart"></div></section>
        <section class="pane"><h3>Live Pick Feed<small>new edges, timestamped</small></h3><ol id="fFeed" class="feed"></ol></section>
        <section class="pane"><h3>Ranked Picks<small id="fUpd"></small></h3><div id="fList" class="plist"></div></section>
        <section class="pane"><h3>Projection Board<small>model fair lines</small></h3><div id="fBoard"></div></section>
        <section class="pane"><h3>Matchup Intel</h3><div id="fIntel" class="intel"></div></section>
        <section class="pane notes"><h3>How the numbers work</h3>
          <p><b>Confidence</b> is the model's probability that the pick hits. <b>Real price</b> is that probability in cents, the price where the contract is break-even before fees. <b>Edge</b> is real price minus the ask minus Kalshi's taker fee (7%×P×(1−P)). <b>Max entry</b> keeps a safety margin for model error; above it, pass. <b>Great entry</b> is a further 6¢ cushion.</p>
          <p>Game lines blend the sportsbook line (via ESPN), ESPN BPI and Kalshi's own ladders. Live lines use a score/clock random-walk model that re-anchors to the market only during quiet stretches, so a stale quote after a basket shows up as a <b>LAG</b> edge. Props use two seasons of game logs weighted to recent form, projected minutes, the market-implied team total, head-to-head history, home/away and rest splits, and with/without splits for injured teammates. Live props re-project from the current box score, fouls and blowout risk.</p>
          <p>Prices come from Kalshi; Robinhood's event contracts can differ. Scores are only as fast as ESPN and the NBA's own feed publish them. No model guarantees a profit: size small and treat thin samples with care.</p></section>
      </div></div>`;
    el.hidden = false;
    document.body.classList.add('finder-open');
    const court = COURT.create($('canvas', el), { big: true });
    court.setGame(g);
    finder = { id, court, el };
    $('#fClose').onclick = () => { clearHash(); closeFinder(); };
    $('#fFilter').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; F.filter = b.dataset.f; $$('#fFilter .chip').forEach((x) => x.classList.toggle('on', x === b)); updateFinder(true); };
    $('#fPlay').onchange = (e) => { F.playable = e.target.checked; updateFinder(true); };
    $('#fSort').value = F.sort; $('#fSort').onchange = (e) => { F.sort = e.target.value; updateFinder(true); };
    $('#fList').addEventListener('toggle', (e) => { const d = e.target; if (d.tagName !== 'DETAILS') return; const id2 = d.closest('.pick')?.dataset.id; if (!id2) return; if (d.open) openDetails.add(id2); else openDetails.delete(id2); }, true);
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
    const key = { rating: (p) => p.rating, edge: (p) => p.edge ?? p.lean ?? 0, roi: (p) => p.roi ?? p.lean ?? 0, conf: (p) => p.fair }[F.sort];
    return [...ps].sort((a, b) => key(b) - key(a));
  }

  const amOf = (pr) => (pr <= 0 || pr >= 1 ? '—' : pr >= 0.5 ? '−' + Math.round(pr / (1 - pr) * 100) : '+' + Math.round((1 - pr) / pr * 100));
  function entryBar(p) {
    const pos = (v) => U.clamp(v * 100, 0, 100).toFixed(1) + '%';
    return `<div class="entry" aria-label="Entry range">
      <div class="eb"><i class="g" style="width:${pos(p.greatEntry)}"></i><i class="y" style="left:${pos(p.greatEntry)};width:${U.clamp((p.maxEntry - p.greatEntry) * 100, 0, 100).toFixed(1)}%"></i><i class="r" style="left:${pos(p.maxEntry)}"></i>${p.price != null ? `<b class="now" style="left:${pos(p.price)}"></b>` : ''}<b class="fair" style="left:${pos(p.fair)}"></b></div>
      <div class="el"><span>Great ≤ <b>${U.cents(p.greatEntry)}${p.book ? ' (' + amOf(p.greatEntry) + ')' : ''}</b></span><span>Max entry <b>${U.cents(p.maxEntry)}${p.book ? ' (' + amOf(p.maxEntry) + ')' : ''}</b></span><span class="bad">Too expensive ≥ <b>${Math.round(p.maxEntry * 100) + 1}¢</b></span></div>
    </div>`;
  }

  function pickHTML(p, g) {
    const fe = PICKS.feed(g.id).find((e) => e.key === p.id);
    const ev = PICKS.evidence(p, g);
    const chips = [];
    if (p.live) chips.push('<span class="chipx live">LIVE</span>');
    if (p.lag) chips.push('<span class="chipx lag">LAG</span>');
    if (fe && fe.active && Date.now() - fe.firstSeen < 90e3) chips.push('<span class="chipx new">NEW</span>');
    if (p.modelOnly) chips.push('<span class="chipx model">MODEL · NO LIVE PRICE</span>');
    else if (p.book) chips.push(`<span class="chipx book">${U.esc(p.book.toUpperCase())}</span>`);
    if (!p.playable && !p.modelOnly) chips.push('<span class="chipx pass">PASS</span>');
    return `<article class="pick tier-${(p.tier || 'none').toLowerCase()}${p.playable ? '' : ' dim'}" id="pk-${U.esc(p.id.replace(/[^A-Za-z0-9_-]/g, '_'))}" data-id="${U.esc(p.id)}">
      <div class="pk-h"><span class="badge">${p.tier || 'OVR'}<b>${p.rating}</b></span>
        <span class="pk-t"><b>${U.esc(p.label)}</b><small>${U.esc(p.sub)}</small><small class="buy">${p.book ? 'Bet' : 'Buy'} <b>${p.book ? U.esc(p.label) : p.side}</b>${p.book ? ' at ' + U.esc(p.book) : ` on “${U.esc(p.m.sub || p.m.title)}”`}</small></span>
        <span class="side ${p.side === 'YES' ? 'yes' : 'no'}">${p.side}</span></div>
      <div class="pk-s">
        <div><label>Confidence</label><b>${U.pct(p.fair)}</b></div>
        <div><label>Real price</label><b>${U.cents(p.fair)}</b></div>
        ${p.modelOnly ? `<div><label>Buy if ≤</label><b>${U.cents(p.maxEntry)}</b></div><div><label>${p.data.fp.liveBase ? 'Live swing' : 'Lean'}</label><b class="pos">+${(p.lean * 100).toFixed(1)}</b></div>`
        : `<div><label>${p.book ? U.esc(p.book) : 'Kalshi ask'}</label><b>${p.book ? PICKS.fmtAm(p.am) : U.cents(p.price)}</b></div><div><label>Edge</label><b class="${p.edge > 0 ? 'pos' : 'neg'}">${U.signed(p.edge * 100, 1)}¢</b></div>`}
      </div>
      ${entryBar(p)}
      <div class="pk-m">${chips.join('')}${p.modelOnly ? '<span>Compare with the live price on Kalshi or Robinhood</span>' : `<span>ROI ${U.signed(p.roi * 100, 0)}%</span><span>¼-Kelly ${(p.kelly * 100).toFixed(1)}%</span>${p.book ? '' : `<span>Spread ${Math.round(p.liq.spread * 100)}¢</span>`}`}<span>${fe ? 'Found ' + U.ago(fe.firstSeen) + (fe.periodTag ? ' · ' + fe.periodTag : '') : ''}</span></div>
      <details${openDetails.has(p.id) ? ' open' : ''}><summary>Why — ${ev.length} data points</summary><ul>${ev.map((e) => `<li class="ev-${e.k}">${U.esc(e.t)}</li>`).join('')}</ul></details>
    </article>`;
  }

  function renderFeed(g) {
    const items = PICKS.feed(g.id).slice(0, 25);
    $('#fFeed').innerHTML = items.length ? items.map((e) => `<li class="${e.active ? 'act' : 'gone'}"><time>${U.ago(e.firstSeen)}</time><span><b>${U.esc(e.label)}</b> · buy ${e.side} @ ${U.cents(e.entry)} <em>fair ${U.cents(e.fair0)}, edge ${U.signed(e.edge0 * 100, 1)}¢</em>${e.lag ? ' <span class="chipx lag">LAG</span>' : ''}</span><small>${e.periodTag}${e.active ? ' · open' : ' · faded after ' + dur(e.closedAt - e.firstSeen)}</small></li>`).join('')
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
    $('#fProbs').innerHTML = probsHTML(g);
    $('#fLines').innerHTML = linesHTML(g);
    const ev = g.eval;
    const now = Date.now();
    if (force || (now - lastListRender > 2500 && !busy())) {
      lastListRender = now;
      const ps = ev ? filtered(ev.picks) : [];
      const ms = ev && !F.playable ? filtered(ev.models || []) : [];
      const total = ev ? ev.picks.length : 0;
      $('#fCount').textContent = ev ? (total ? `${ev.picks.filter((p) => p.playable).length} +EV of ${total} priced` : `${(ev.models || []).length} model picks`) : '';
      $('#fUpd').textContent = ev ? 'updated ' + U.ago(ev.at) : '';
      const pend = ev?.pending?.length || 0;
      const rec = INTEL.get(g.id);
      let html = kalshiNote(g);
      if (ps.length) html += ps.slice(0, 50).map((p) => pickHTML(p, g)).join('');
      if (pend) html += `<p class="muted small">${pend} more prop markets are waiting on game logs.</p>`;
      if (ms.length) html += `<h4 class="subh">Model picks — no live price on this line yet</h4><p class="muted small">Best lean per player and stat on Kalshi's standard lines, ranked. Enter only at or below the Buy-if price.</p>` + ms.slice(0, 30).map((p) => pickHTML(p, g)).join('');
      if (!ps.length && !ms.length) html += `<p class="muted">${rec?.loading || !rec ? 'Loading game logs and injury reports to build picks…' : g.state === 'post' ? 'This game is final.' : 'No picks match this filter.'}</p>`;
      $('#fList').innerHTML = html;
      renderFeed(g);
      $('#fBoard').innerHTML = boardHTML(g);
      $('#fIntel').innerHTML = intelHTML(g);
    }
    if (force || (now - lastChartRender > 4000 && !busy())) {
      lastChartRender = now;
      const priced = ev ? filtered(ev.picks) : [];
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
    $('#dates').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) APP.setDate(b.dataset.k); };
    $('#games').onclick = (e) => { const c = e.target.closest('.gcard'); if (c) location.hash = 'game-' + c.dataset.id; };
    $('#games').onkeydown = (e) => { if (e.key === 'Enter') { const c = e.target.closest('.gcard'); if (c) location.hash = 'game-' + c.dataset.id; } };
    $('#ticker').onclick = (e) => { const b = e.target.closest('[data-game]'); if (!b) return; location.hash = 'game-' + b.dataset.game; setTimeout(() => { const t = document.getElementById('pk-' + b.dataset.pick.replace(/[^A-Za-z0-9_-]/g, '_')); if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); } }, 600); };
    $('#btnSettings').onclick = () => { const s = $('#settings'); s.hidden = !s.hidden; if (!s.hidden) $('#proxyIn').value = NET.getProxy(); };
    $('#setClose').onclick = () => ($('#settings').hidden = true);
    $('#proxySave').onclick = () => { NET.setProxy($('#proxyIn').value.trim()); $('#settings').hidden = true; APP.restart(); };
    $('#demoBtn').onclick = () => { $('#settings').hidden = true; APP.startDemo(); };
    $('#liveBtn').onclick = () => { $('#settings').hidden = true; APP.startLive(); };
    $('#clearBtn').onclick = () => { try { Object.keys(localStorage).filter((k) => k.startsWith('ce:')).forEach((k) => localStorage.removeItem(k)); } catch { } $('#settings').hidden = true; APP.restart(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && finder) { clearHash(); closeFinder(); } });
    NET.onChange(() => { clearTimeout(init._t); init._t = setTimeout(renderFeeds, 200); });
  }

  return { init, renderGames, updateCard, renderDates, renderFeeds, renderTicker, openFinder, closeFinder, updateFinder, scoreFx, banner, finderId: () => finder?.id || null };
})();
