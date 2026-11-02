/* ============================================================
   net.js — feed access with proxy failover, rate limiting,
   latency tracking, in-flight de-duplication, demo routing
   ============================================================ */

const NET = (() => {
  const relOk = /^https?:$/.test(location.protocol);
  const SOURCES = {
    espn: { label: 'ESPN', bases: ['/x/espn', 'https://site.api.espn.com'] },
    espnweb: { label: 'ESPN', bases: ['/x/espnweb', 'https://site.web.api.espn.com'] },
    nba: { label: 'NBA', bases: ['/x/nba', 'https://cdn.nba.com'] },
    kalshi: { label: 'Kalshi', bases: ['/x/kalshi', '/x/kalshi2', 'https://external-api.kalshi.com', 'https://api.elections.kalshi.com'] },
  };
  const PUBLIC = ['https://corsproxy.io/?url={url}', 'https://api.allorigins.win/raw?url={url}', 'https://api.codetabs.com/v1/proxy/?quest={url}'];
  const state = {};
  for (const k in SOURCES) state[k] = { active: -1, ok: 0, fail: 0, lastOk: 0, lastErr: '', lat: 0, mode: 'idle', good: new Set() };
  let demo = false;
  let customProxy = U.store.get('proxy', '');
  const inflight = new Map();
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(); } catch { } });

  // direct first (one less hop = lowest latency, no hosting quota), then a custom proxy,
  // then this site's own rewrite proxy. The first that works is remembered per source.
  function candidates(src) {
    const abs = SOURCES[src].bases.filter((b) => !b.startsWith('/'));
    const rel = SOURCES[src].bases.filter((b) => b.startsWith('/'));
    const out = abs.map((b) => ({ base: b, kind: 'direct' }));
    if (customProxy) out.push(...abs.map((b) => ({ base: b, kind: 'custom' })));
    if (relOk) out.push(...rel.map((b) => ({ base: b, kind: 'proxy' })));
    // last resort when hosted somewhere without rewrites: free public CORS relays
    for (const tpl of PUBLIC) out.push({ base: abs[0], kind: 'public', tpl });
    return out;
  }
  function buildUrl(c, path) {
    const full = c.base + path;
    if (c.kind === 'public') return c.tpl.replace('{url}', encodeURIComponent(full + (full.includes('?') ? '&' : '?') + '_cb=' + Math.floor(Date.now() / 1000)));
    if (c.kind === 'custom') return customProxy.includes('{url}') ? customProxy.replace('{url}', encodeURIComponent(full)) : customProxy + encodeURIComponent(full);
    return full;
  }

  // ---- Kalshi token bucket (public tier is ~20 req/s; stay well under) ----
  const bucket = { tokens: 8, cap: 8, rate: 7, last: performance.now(), pausedUntil: 0, q: [] };
  function pump() {
    const now = performance.now();
    bucket.tokens = Math.min(bucket.cap, bucket.tokens + ((now - bucket.last) / 1000) * bucket.rate);
    bucket.last = now;
    if (Date.now() < bucket.pausedUntil) { setTimeout(pump, bucket.pausedUntil - Date.now() + 5); return; }
    bucket.q.sort((a, b) => b.pri - a.pri);
    while (bucket.q.length && bucket.tokens >= 1) { bucket.tokens -= 1; bucket.q.shift().go(); }
    if (bucket.q.length) setTimeout(pump, Math.max(20, (1 - bucket.tokens) / bucket.rate * 1000));
  }
  const throttle = (pri) => new Promise((res) => { bucket.q.push({ pri, go: res }); pump(); });

  async function rawFetch(url, opts) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), opts.timeout || 9000);
    try {
      const t0 = performance.now();
      const r = await fetch(url, { cache: opts.fresh ? 'no-store' : 'default', signal: ctl.signal, headers: { Accept: 'application/json' } });
      const ms = performance.now() - t0;
      if (r.status === 404) { const e = new Error('404'); e.code = 404; throw e; }
      if (r.status === 429) { const e = new Error('rate limited'); e.code = 429; throw e; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.code = r.status; throw e; }
      const txt = await r.text();
      if (!txt || txt[0] === '<') { const e = new Error('not JSON'); e.code = 'html'; throw e; }
      return { json: JSON.parse(txt), ms };
    } finally { clearTimeout(to); }
  }

  async function get(src, path, opts = {}) {
    const key = src + path;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const st = state[src];
      if (demo) {
        await new Promise((r) => setTimeout(r, 25 + Math.random() * 60));
        const j = DEMO.handle(src, path);
        st.ok++; st.lastOk = Date.now(); st.lat = st.lat ? st.lat * 0.8 + 50 * 0.2 : 50; st.mode = 'demo'; emit();
        if (j == null) { const e = new Error('404'); e.code = 404; throw e; }
        return j;
      }
      if (src === 'kalshi') await throttle(opts.priority || 0);
      const cands = candidates(src);
      const order = st.active >= 0 && st.active < cands.length ? [st.active, ...cands.map((_, i) => i).filter((i) => i !== st.active)] : cands.map((_, i) => i);
      let lastErr;
      for (const i of order) {
        const c = cands[i];
        try {
          const { json, ms } = await rawFetch(buildUrl(c, path), opts);
          st.active = i; st.good.add(i); st.ok++; st.lastOk = Date.now(); st.lat = st.lat ? st.lat * 0.75 + ms * 0.25 : ms; st.mode = c.kind; st.lastErr = '';
          emit();
          return json;
        } catch (e) {
          lastErr = e;
          // a real "not found" from an upstream we've already reached (e.g. boxscore before tip-off)
          if ((e.code === 404 || e.code === 403) && st.good.has(i)) { const nf = new Error('not found'); nf.code = 404; throw nf; }
          if (e.code === 429) { bucket.pausedUntil = Date.now() + 2500; st.lastErr = 'rate limited'; emit(); throw e; }
          // network / CORS / HTML-404 from a missing proxy → try next candidate
        }
      }
      if (lastErr && (lastErr.code === 404 || lastErr.code === 403) && st.good.size) { const nf = new Error('not found'); nf.code = 404; throw nf; }
      st.fail++; st.lastErr = lastErr ? (lastErr.name === 'AbortError' ? 'timeout' : (lastErr.message || 'blocked')) : 'blocked'; st.mode = 'down';
      emit();
      throw lastErr || new Error('unreachable');
    })();
    inflight.set(key, p);
    p.finally(() => inflight.delete(key)).catch(() => { });
    return p;
  }

  function health(src) {
    const st = state[src];
    const age = st.lastOk ? Date.now() - st.lastOk : Infinity;
    let level = 'off';
    if (st.mode === 'down' && age > 15000) level = 'down';
    else if (st.lastOk && age < 20000) level = 'ok';
    else if (st.lastOk) level = 'stale';
    return { level, lat: st.lat, age, mode: st.mode, err: st.lastErr, label: SOURCES[src].label };
  }

  return {
    get, health, state,
    onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },
    setDemo: (v) => { demo = !!v; for (const k in state) { state[k].mode = v ? 'demo' : 'idle'; state[k].lastOk = 0; } emit(); },
    isDemo: () => demo,
    setProxy: (p) => { customProxy = p || ''; U.store.set('proxy', customProxy); for (const k in state) { state[k].active = -1; state[k].good.clear(); } },
    getProxy: () => customProxy,
  };
})();
