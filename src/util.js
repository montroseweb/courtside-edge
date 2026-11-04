/* ============================================================
   util.js — math, time, formatting, names
   ============================================================ */

const U = (() => {
  // ---------- probability ----------
  function erf(x) {
    // Abramowitz & Stegun 7.1.26 (max err ~1.5e-7)
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  function normInv(p) {
    // Acklam's rational approximation
    if (p <= 0) return -8; if (p >= 1) return 8;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pl = 0.02425, ph = 1 - pl;
    let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > ph) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  // P(X >= k) for integer-valued X with normal approx (continuity corrected)
  const normAtLeast = (k, mu, sd) => 1 - normCdf((k - 0.5 - mu) / Math.max(sd, 1e-6));

  // P(X >= k) for count data: Poisson if var<=mean, else negative binomial
  function countAtLeast(k, mu, variance) {
    if (k <= 0) return 1;
    mu = Math.max(mu, 1e-4);
    variance = Math.max(variance || mu, mu * 1.0001);
    let pmf, cdf = 0;
    if (variance <= mu * 1.02) {
      pmf = Math.exp(-mu);
      for (let i = 0; i < k; i++) { cdf += pmf; pmf *= mu / (i + 1); }
    } else {
      const r = (mu * mu) / (variance - mu);
      const p = r / (r + mu);
      pmf = Math.exp(r * Math.log(p));
      for (let i = 0; i < k; i++) { cdf += pmf; pmf *= ((i + r) / (i + 1)) * (1 - p); }
    }
    return clamp(1 - cdf, 0, 1);
  }

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sum = (arr) => arr.reduce((s, x) => s + x, 0);
  const mean = (arr) => (arr.length ? sum(arr) / arr.length : NaN);
  function wmean(vals, ws) { let s = 0, w = 0; for (let i = 0; i < vals.length; i++) { s += vals[i] * ws[i]; w += ws[i]; } return w ? s / w : NaN; }
  function wvar(vals, ws) {
    const m = wmean(vals, ws); let s = 0, w = 0, w2 = 0;
    for (let i = 0; i < vals.length; i++) { s += ws[i] * (vals[i] - m) ** 2; w += ws[i]; w2 += ws[i] * ws[i]; }
    if (!w) return NaN;
    const neff = (w * w) / w2;
    return neff > 1 ? (s / w) * (neff / (neff - 1)) : s / w;
  }

  // ---------- odds / pricing ----------
  const amToProb = (am) => { am = +am; if (!isFinite(am) || am === 0) return NaN; return am < 0 ? -am / (-am + 100) : 100 / (am + 100); };
  const KALSHI_FEE_RATE = 0.07;
  const fee = (price) => KALSHI_FEE_RATE * price * (1 - price);              // $/contract, taker, large-order limit
  // price at which a contract with true prob p breaks even after fee
  function breakEven(p) {
    const A = KALSHI_FEE_RATE, B = 1 + KALSHI_FEE_RATE;
    // A x^2 - B x + p = 0
    const disc = B * B - 4 * A * p;
    return clamp((B - Math.sqrt(Math.max(0, disc))) / (2 * A), 0, 1);
  }
  const cents = (x) => (x == null || !isFinite(x) ? '—' : Math.round(x * 100) + '¢');
  const pct = (x, d = 0) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
  const signed = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x > 0 ? '+' : '') + x.toFixed(d));

  // ---------- time ----------
  function etParts(d = new Date()) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day };
  }
  const ymd = ({ y, m, d }) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  function etDateKey(d = new Date()) { return ymd(etParts(d)); }
  function addDaysKey(key, n) {
    const y = +key.slice(0, 4), m = +key.slice(4, 6), d = +key.slice(6, 8);
    const dt = new Date(Date.UTC(y, m - 1, d + n, 12));
    return ymd({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
  }
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const kalshiDateCode = (key) => key.slice(2, 4) + MON[+key.slice(4, 6) - 1] + key.slice(6, 8);
  // ESPN season = ending year of the season (2026-27 → 2027)
  function seasonFor(key) { const y = +key.slice(0, 4), m = +key.slice(4, 6); return m >= 8 ? y + 1 : y; }
  function dayLabel(key, todayKey) {
    if (key === todayKey) return 'Today';
    if (key === addDaysKey(todayKey, 1)) return 'Tomorrow';
    const y = +key.slice(0, 4), m = +key.slice(4, 6), d = +key.slice(6, 8);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + ' ' + m + '/' + d;
  }
  function ago(ts, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm ago';
  }
  function countdown(ms) {
    if (ms <= 0) return 'Tipping off';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}:${String(ss).padStart(2, '0')}`;
  }
  const localTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // "PT05M12.00S" → seconds
  function isoDur(s) {
    if (!s || typeof s !== 'string') return null;
    const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  }
  // "5:12" or "34.2" → seconds
  function clockStr(s) {
    if (s == null) return null;
    s = String(s);
    if (s.includes(':')) { const [a, b] = s.split(':'); return (+a) * 60 + (+b); }
    const v = parseFloat(s); return isFinite(v) ? v : null;
  }
  const fmtClock = (sec) => {
    if (sec == null || !isFinite(sec)) return '';
    if (sec < 60) return sec.toFixed(1);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const periodName = (p) => (p <= 4 ? ['', '1st', '2nd', '3rd', '4th'][p] : (p === 5 ? 'OT' : `${p - 4}OT`));
  const periodShort = (p) => (p <= 4 ? 'Q' + p : (p === 5 ? 'OT' : `${p - 4}OT`));

  // minutes remaining in game given period & seconds left in period (regulation 48)
  function minutesRemaining(period, secLeft) {
    if (!period) return 48;
    const sl = (secLeft ?? 0) / 60;
    if (period <= 4) return (4 - period) * 12 + sl;
    return sl; // OT: just this OT
  }
  function minutesElapsed(period, secLeft) {
    if (!period) return 0;
    const sl = (secLeft ?? 0) / 60;
    if (period <= 4) return (period - 1) * 12 + (12 - sl);
    return 48 + (period - 5) * 5 + (5 - sl);
  }

  // ---------- names ----------
  function normName(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function nameScore(a, b) {
    const A = normName(a).split(' ').filter(Boolean), B = normName(b).split(' ').filter(Boolean);
    if (!A.length || !B.length) return 0;
    if (A.join(' ') === B.join(' ')) return 1;
    const lastA = A[A.length - 1], lastB = B[B.length - 1];
    let s = 0;
    if (lastA === lastB) s += 0.6;
    if (A[0] === B[0]) s += 0.35;
    else if (A[0][0] === B[0][0]) s += 0.2;
    const common = A.filter((t) => B.includes(t)).length;
    s += 0.05 * common;
    return Math.min(0.99, s);
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (x) => { const v = typeof x === 'string' ? parseFloat(x) : x; return isFinite(v) ? v : null; };

  // ---------- color ----------
  function hexToRgb(h) {
    h = String(h || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16); if (!isFinite(n) || h.length !== 6) return { r: 128, g: 128, b: 128 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgba = (h, a) => { const { r, g, b } = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; };
  function shade(h, amt) { // amt -1..1
    const { r, g, b } = hexToRgb(h);
    const f = (c) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
    return '#' + [f(r), f(g), f(b)].map((c) => clamp(c, 0, 255).toString(16).padStart(2, '0')).join('');
  }
  function lum(h) { const { r, g, b } = hexToRgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
  // pick a readable version of a team color on dark glass
  const onDark = (h) => { h = String(h || '').replace('#', ''); return lum(h) < 0.12 ? shade(h, 0.35).slice(1) : h; };
  // perceptual ("redmean") color distance
  const cdist = (a, b) => { const x = hexToRgb(a), y = hexToRgb(b), rm = (x.r + y.r) / 2, dr = x.r - y.r, dg = x.g - y.g, db = x.b - y.b; return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db); };
  // two distinguishable team colors for side-by-side fills (falls back to an alternate color when they clash)
  function pairColors(away, home) {
    let a = onDark(away.color), h = onDark(home.color);
    if (cdist(a, h) < 140) {
      const sat = (c) => { const x = hexToRgb(c); return Math.max(x.r, x.g, x.b) - Math.min(x.r, x.g, x.b); };
      const pick = (t, other) => [t.alt, t.meta?.alt, t.meta?.court?.accent, t.meta?.court?.paint].filter(Boolean).map((c) => onDark(c)).find((c) => cdist(c, other) >= 140 && sat(c) > 50);
      const aa = pick(away, h); if (aa) a = aa; else { const hh = pick(home, a); if (hh) h = hh; else a = onDark(away.alt || '888888'); }
    }
    return [a, h];
  }

  // seeded rng (for deterministic textures)
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  const store = {
    get(k, d = null) { try { const v = localStorage.getItem('ce:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ce:' + k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem('ce:' + k); } catch { } },
  };

  return {
    erf, normCdf, normInv, normAtLeast, countAtLeast, clamp, lerp, sum, mean, wmean, wvar,
    amToProb, fee, breakEven, KALSHI_FEE_RATE, cents, pct, signed,
    etParts, etDateKey, addDaysKey, kalshiDateCode, seasonFor, dayLabel, ago, countdown, localTime, isoDur, clockStr, fmtClock,
    periodName, periodShort, minutesRemaining, minutesElapsed,
    normName, nameScore, esc, num, hexToRgb, rgba, shade, lum, onDark, pairColors, cdist, rng, hash, store,
  };
})();
