/* ============================================================
   parlay.js — Section 2 optimal parlays + the joint-probability
   engine shared by the parlay builder and My Bets.
   Joint probability: Gaussian copula on each leg's true
   probability with rule-based pairwise correlations (exact
   bivariate normal for 2 legs, Kirkwood product for 3 legs during
   the search, Monte Carlo with common random numbers and an
   independence control variate for any number of legs).
   ============================================================ */

const PARLAY = (() => {
  const LINE = new Set(['ml', 'spread', 'total', 'teamtotal', 'margin', 'ot']);
  // bivariate normal CDF Φ2(a, b; r) by integrating φ(x)·Φ((b − r x)/√(1−r²)) over x ≤ a (Simpson, 240 steps)
  function bvn(a, b, r) {
    if (Math.abs(r) < 1e-6) return U.normCdf(a) * U.normCdf(b);
    r = U.clamp(r, -0.95, 0.95);
    const lo = -8, hi = Math.min(a, 8), n = 240, h = (hi - lo) / n, sq = Math.sqrt(1 - r * r);
    if (hi <= lo) return 0;
    let s = 0;
    for (let i = 0; i <= n; i++) {
      const x = lo + i * h, f = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * U.normCdf((b - r * x) / sq);
      s += f * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
    }
    return U.clamp(s * h / 3, 0, Math.min(U.normCdf(a), U.normCdf(b)));
  }
  const memo = new Map();
  const joint2 = (pa, pb, r) => {
    const k = `${pa.toFixed(4)}|${pb.toFixed(4)}|${r.toFixed(3)}`;
    if (memo.has(k)) return memo.get(k);
    const v = bvn(U.normInv(pa), U.normInv(pb), r);
    if (memo.size > 5000) memo.clear();
    memo.set(k, v);
    return v;
  };

  // describe a leg's direction for correlation rules
  function legOf(p, g) {
    const m = p.m;
    const L = { p, g, gameId: p.gameId, fam: p.kind === 'prop' ? 'prop' : 'line', kind: p.kind, seg: !!m.seg, segK: m.seg || 'G', ticker: p.ticker };
    if (p.kind === 'prop') { L.player = p.data.player.espnId; L.team = p.data.player.side; L.stat = m.stat; L.name = p.data.player.name; }
    else if (['ml', 'spread', 'margin'].includes(p.kind)) L.team = p.yes ? m.side : (m.side === 'home' ? 'away' : 'home');
    else if (p.kind === 'teamtotal') { L.team = m.side; L.over = p.yes; }
    else if (p.kind === 'total') L.over = p.yes;
    else if (p.kind === 'ot') L.over = p.yes;
    return L;
  }
  const PTS_LIKE = { pts: 1, pra: 1, pa: 0.9, pr: 0.85, ast: 0.6, fg3m: 0.6, reb: 0.4, ra: 0.5, stl: 0.2, blk: 0.2 };
  // correlation between the two legs' success events; null = barred pairing; reason string for the report
  function rho(a, b) {
    if (a.gameId !== b.gameId) return { r: 0, why: 'separate games — independent' };
    if (a.ticker === b.ticker) return null;
    const seg = a.seg || b.seg ? 0.5 : 1;
    if (a.fam === 'prop' && b.fam === 'prop') {
      if (a.player === b.player) return null; // same player stacking: redundant exposure
      if (a.team === b.team) {
        if ((a.stat === 'ast' && /pts|pra|pa|fg3m/.test(b.stat)) || (b.stat === 'ast' && /pts|pra|pa|fg3m/.test(a.stat))) return { r: 0.12, why: 'teammate assist ↔ teammate scoring share the same made baskets' };
        if (a.stat === 'reb' && b.stat === 'reb') return { r: -0.06, why: 'teammates compete for the same rebounds' };
        if (/pts|pra/.test(a.stat) && /pts|pra/.test(b.stat)) return { r: -0.05, why: 'teammates compete for the same shot volume' };
        return { r: 0.02, why: 'teammates — shared minutes environment' };
      }
      if (/pts|pra|pa|fg3m/.test(a.stat) && /pts|pra|pa|fg3m/.test(b.stat)) return { r: 0.06, why: 'opposing scorers share the possession count' };
      return { r: 0.03, why: 'opposing players share the possession count' };
    }
    const prop = a.fam === 'prop' ? a : b.fam === 'prop' ? b : null, line = prop === a ? b : a;
    if (prop) {
      const w = PTS_LIKE[prop.stat] ?? 0.4;
      if (line.kind === 'total') return { r: (line.over ? 0.25 : -0.25) * w * seg, why: line.over ? `game Over and ${prop.name} ${MODEL.SHORT[prop.stat]} both scale with possessions and scoring efficiency` : `game Under suppresses ${prop.name}'s volume (counter-acting script)` };
      if (line.kind === 'teamtotal') return { r: (line.team === prop.team ? (line.over ? 0.35 : -0.35) : (line.over ? 0.05 : -0.05)) * w * seg, why: line.team === prop.team ? `${prop.name} is a direct component of the team total` : 'opponent team total — pace link only' };
      if (line.kind === 'ot') return { r: line.over ? 0.05 : 0, why: 'overtime adds 5 minutes of volume' };
      // team side (ml / spread / margin)
      const r = (line.team === prop.team ? 0.12 : -0.08) * w * seg;
      return { r, why: line.team === prop.team ? `${prop.name}'s production feeds his team's margin` : `${prop.name} plays for the side the line is against (counter-acting script)` };
    }
    // two game lines in the same game
    const sides = (x) => ['ml', 'spread', 'margin'].includes(x.kind);
    if (sides(a) && sides(b)) { if (a.seg !== b.seg) return { r: a.team === b.team ? 0.35 : -0.35, why: 'segment winner and full-game side move together' }; return null; }
    if ((a.kind === 'total' && b.kind === 'teamtotal') || (a.kind === 'teamtotal' && b.kind === 'total') || (a.kind === b.kind && (a.kind === 'total' || a.kind === 'teamtotal'))) return null; // redundant scoring exposure
    if ((sides(a) && b.kind === 'total') || (sides(b) && a.kind === 'total')) return { r: 0.03, why: 'side and total — weak scoring link' };
    return { r: 0, why: 'no structural link' };
  }

  // ---------- n-leg joint probability ----------
  const NS = 8192; let ZB = null;
  function zbank(n) {
    if (ZB && ZB.n >= n) return ZB;
    const N = Math.max(n, 12), rng = U.rng(0x5eed1), z = new Float64Array(NS * N);
    for (let i = 0; i < z.length; i += 2) { const u = Math.max(1e-12, rng()), v = rng(), r = Math.sqrt(-2 * Math.log(u)); z[i] = r * Math.cos(6.283185307179586 * v); if (i + 1 < z.length) z[i + 1] = r * Math.sin(6.283185307179586 * v); }
    return (ZB = { n: N, z });
  }
  // Cholesky factor; off-diagonals shrink until the matrix is positive definite
  function chol(R) {
    const n = R.length;
    for (let sh = 1; sh > 0.15; sh *= 0.85) {
      const L = Array.from({ length: n }, () => new Float64Array(n)); let ok = true;
      for (let i = 0; i < n && ok; i++) for (let j = 0; j <= i; j++) {
        let v = i === j ? 1 : R[i][j] * sh;
        for (let k = 0; k < j; k++) v -= L[i][k] * L[j][k];
        if (i === j) { if (v <= 1e-6) { ok = false; break; } L[i][i] = Math.sqrt(v); } else L[i][j] = v / L[j][j];
      }
      if (ok) return L;
    }
    return Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
  }
  function kirk3(ps, R) {
    const j01 = joint2(ps[0], ps[1], R[0][1]), j02 = joint2(ps[0], ps[2], R[0][2]), j12 = joint2(ps[1], ps[2], R[1][2]);
    return Math.min(j01 * j02 * j12 / (ps[0] * ps[1] * ps[2]), j01, j02, j12);
  }
  /** P(every leg wins). ps: true probabilities; R: pairwise latent correlations (R[i][j] ≤ −0.999 = cannot both win). */
  function jointN(ps, R, fast) {
    const n = ps.length;
    if (!n) return 1;
    if (ps.some((p) => !(p > 0))) return 0;
    if (n === 1) return ps[0];
    let any = false;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { if (R[i][j] <= -0.999) return 0; if (Math.abs(R[i][j]) > 1e-6) any = true; }
    const prod = ps.reduce((a, b) => a * b, 1);
    if (!any) return prod;
    const pc = ps.map((p) => U.clamp(p, 1e-6, 1 - 1e-6));
    if (n === 2) return joint2(pc[0], pc[1], R[0][1]);
    if (n === 3 && fast) return kirk3(pc, R);
    const B = zbank(n), z = B.z, st = B.n, L = chol(R), t = pc.map((p) => U.normInv(p));
    let hc = 0, hi = 0;
    for (let s = 0; s < NS; s++) {
      const o = s * st; let okc = true, oki = true;
      for (let j = 0; j < n && (okc || oki); j++) {
        if (oki && z[o + j] >= t[j]) oki = false;
        if (okc) { const Lj = L[j]; let x = 0; for (let k = 0; k <= j; k++) x += Lj[k] * z[o + k]; if (x >= t[j]) okc = false; }
      }
      if (okc) hc++; if (oki) hi++;
    }
    // common random numbers: exact independent product × (correlated / independent) hit ratio
    const est = hi >= 40 ? prod * hc / hi : hc / NS;
    return U.clamp(est, 0, Math.min(...pc));
  }

  // segment overlap (minutes) between two legs: 1 = same window
  const WIN = { G: [0, 48], Q1: [0, 12], Q2: [12, 24], Q3: [24, 36], Q4: [36, 48], '1H': [0, 24], '2H': [24, 48] };
  function overlap(a, b) { const A = WIN[a.segK || 'G'], B = WIN[b.segK || 'G']; const o = Math.max(0, Math.min(A[1], B[1]) - Math.max(A[0], B[0])); return o / Math.sqrt((A[1] - A[0]) * (B[1] - B[0])); }
  /** relation between ANY two legs (builder / My Bets): rho rules where they apply, honest estimates where the
   *  optimizer bars a pairing. flag: ok | conflict | impossible | nested | same-player | redundant | dup */
  function relation(a, b) {
    if (a.gameId !== b.gameId) return { r: 0, flag: 'ok', why: 'different games — independent' };
    if (a.ticker === b.ticker) return a.p.side === b.p.side ? { r: 0.97, flag: 'dup', why: 'the same contract twice' } : { r: -1, flag: 'impossible', why: 'opposite sides of the same contract — they can’t both win' };
    const c = rho(a, b);
    if (c) return { ...c, flag: c.r < -0.02 ? 'conflict' : 'ok' };
    const S = (x) => MODEL.SHORT[x] || x;
    if (a.fam === 'prop' && b.fam === 'prop' && a.player === b.player) {
      if (a.stat === b.stat) return { r: 0.97, flag: 'nested', why: `two lines on ${a.name}’s ${S(a.stat)} — the higher line already includes the lower one` };
      const inC = (x, y) => (MODEL.COMBO[x] || []).includes(y) || (MODEL.COMBO[x] && MODEL.COMBO[y] && MODEL.COMBO[x].some((k) => MODEL.COMBO[y].includes(k)));
      return { r: inC(a.stat, b.stat) || inC(b.stat, a.stat) ? 0.7 : 0.3, flag: 'same-player', why: `both need a big night from ${a.name} — one cold game or early exit sinks both` };
    }
    const ov = overlap(a, b), sides = (x) => ['ml', 'spread', 'margin'].includes(x.kind), tot = (x) => x.kind === 'total' || x.kind === 'teamtotal';
    if (sides(a) && sides(b)) {
      if (a.segK === b.segK) {
        if (a.team === b.team) return { r: 0.8, flag: 'redundant', why: 'two bets on the same team winning the same stretch — they rise and fall together' };
        if (a.kind === 'ml' && b.kind === 'ml') return { r: -1, flag: 'impossible', why: 'both teams can’t win' };
        return { r: -0.7, flag: 'conflict', why: 'bets on opposite teams in the same stretch cancel each other out' };
      }
      const r = 0.1 + 0.75 * ov;
      return a.team === b.team ? { r, flag: ov > 0.4 ? 'redundant' : 'ok', why: `same team in overlapping parts of the game` } : { r: -r, flag: 'conflict', why: 'opposite teams in overlapping parts of the game' };
    }
    if (tot(a) && tot(b)) {
      const same = a.over === b.over;
      const sameMkt = a.kind === b.kind && (a.kind === 'total' || a.team === b.team);
      if (sameMkt && a.segK === b.segK) return same ? { r: 0.97, flag: 'nested', why: 'two lines on the same total — one already covers the other' } : { r: -0.85, flag: 'conflict', why: 'an Over and an Under on the same total pull in opposite directions' };
      const r0 = (sameMkt ? 0.9 : a.kind === b.kind ? 0.3 : 0.65) * ov;
      return same ? { r: r0, flag: r0 > 0.45 ? 'redundant' : 'ok', why: 'both ride the same scoring pace — it doubles your pace risk' } : { r: -r0, flag: 'conflict', why: 'one needs a fast game, the other a slow one' };
    }
    return { r: 0, flag: 'ok', why: 'no structural link' };
  }
  function corrMatrix(D) {
    const n = D.length, R = Array.from({ length: n }, () => new Array(n).fill(0)), rel = [];
    for (let i = 0; i < n; i++) { R[i][i] = 1; for (let j = i + 1; j < n; j++) { const x = relation(D[i], D[j]); R[i][j] = R[j][i] = x.r; rel.push({ i, j, ...x }); } }
    return { R, rel };
  }
  const growthOf = (p, cost) => (p > cost && cost > 0 && cost < 1 ? p * Math.log(p / cost) + (1 - p) * Math.log((1 - p) / (1 - cost)) : 0);
  const haircutN = (n) => (n <= 1 ? 1 : n === 2 ? 0.85 : n === 3 ? 0.7 : Math.max(0.4, 0.7 - 0.08 * (n - 3)));
  /** price a ticket from descriptors D (relation shape), true probabilities ps and asks qs (null = no quote) */
  function metrics(D, ps, qs, fast) {
    const { R, rel } = corrMatrix(D);
    const p = jointN(ps, R, fast);
    const ind = ps.reduce((a, b) => a * b, 1);
    const ask = qs.every((q) => q != null) ? qs.reduce((a, b) => a * b, 1) : null;
    const cost = ask != null ? ask + U.fee(ask) : null;
    const kelly = cost != null && p > cost ? (p - cost) / (1 - cost) * 0.25 * haircutN(D.length) : 0;
    return { p, ind, ask, cost, edge: ask != null ? p - ask : null, ratio: ask ? p / ask : null, be: U.breakEven(p), growth: cost != null ? growthOf(p, cost) : 0, kelly, rel, R };
  }

  function evalCombo(legs, exact) {
    const pairs = [];
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
      const c = rho(legs[i], legs[j]);
      if (!c || c.r < 0) return null; // correlation filter: no negative or redundant pairings
      pairs.push({ i, j, ...c });
    }
    const ps = legs.map((l) => l.p.fair), qs = legs.map((l) => l.p.implied);
    const R = legs.map((_, i) => legs.map((__, j) => (i === j ? 1 : 0)));
    for (const x of pairs) R[x.i][x.j] = R[x.j][x.i] = x.r;
    let trueP = jointN(ps, R, !exact);
    if (!exact && legs.length === 3) trueP = trueP - 0.15 * (trueP - ps.reduce((a, b) => a * b, 1)); // Kirkwood runs hot vs the copula; exact pricing follows for the chosen tickets
    const indTrue = ps.reduce((a, b) => a * b, 1), mkt = qs.reduce((a, b) => a * b, 1);
    const edge = trueP - mkt, cost = mkt + U.fee(mkt);
    const kellyFull = trueP > cost ? (trueP - cost) / (1 - cost) : 0;
    const haircut = haircutN(legs.length);
    const scale = Math.round(U.clamp((kellyFull * 0.25 * haircut) / 0.02 * 10, 0, 10) * 10) / 10;
    return { legs, pairs, trueP, indTrue, mkt, cost, edge, ratio: trueP / mkt, lift: trueP / indTrue - 1, growth: growthOf(trueP, cost), scale, kelly: kellyFull * 0.25 * haircut, buyMax: Math.max(0, Math.min(trueP - 0.04, U.breakEven(trueP) - 0.01)), fairMax: U.breakEven(trueP), minR: Math.min(...pairs.map((x) => x.r)) };
  }

  // a leg is usable in a parlay when it is priced, liquid, fresh, not overpriced and likely
  const LEG_BAR = /ILLIQUID|STALE|TREND|ROSTER/;
  const legScore = (p) => p.netEdge + 0.3 * (p.fair - 0.5) + (p.survivor ? 0.02 : 0);
  /** cands: [{p, g}] — priced sides (props overs only); by default only Section 1 survivors are used as legs.
   *  Returns {two, three}: tickets ranked by compound edge, every bet family on one ticket only. */
  function build(cands, opts = {}) {
    const minLeg = opts.minLeg ?? 0.5, survOnly = opts.legs !== 'all';
    const top = cands.filter(({ p }) => (!survOnly || p.survivor) && p.price != null && !p.book && !p.modelOnly && p.implied > 0.02 && p.fair < 0.97 && p.fair >= minLeg - 1e-9 && p.netEdge >= 0 && !LEG_BAR.test(p.reason || ''))
      .sort((a, b) => legScore(b.p) - legScore(a.p)).slice(0, opts.pool || 24);
    const L = top.map(({ p, g }) => legOf(p, g));
    const mixed = new Set(L.map((l) => l.fam)).size > 1; // props and lines both available → every ticket mixes them
    const fam = (l) => l.gameId + '|' + (l.p.fam || l.ticker);
    // acceptance: compound edge ≥ +4 pts, ≥ 18% above the price, still +EV with correlation removed, and likely enough
    const minRatio = opts.minRatio ?? 1.18, minP2 = opts.minP2 ?? 0.25, minP3 = opts.minP3 ?? 0.14;
    const ok = (c) => c && c.edge >= 0.04 && c.ratio >= minRatio && c.indTrue >= c.mkt && c.trueP >= (c.legs.length === 2 ? minP2 : minP3) && c.growth > 0;
    // lcb: edge after knocking the joint probability down by one standard error of the legs' model uncertainty
    const lcb = (c) => { const rel = Math.sqrt(c.legs.reduce((a, l) => a + ((l.p.unc ?? 0.04) / Math.max(0.05, l.p.fair)) ** 2, 0)); return c.trueP * (1 - rel) - c.cost; };
    const RANK = { growth: (c) => c.growth, edge: (c) => c.edge, prob: (c) => c.trueP, blend: (c) => c.growth * Math.sqrt(c.trueP), lcb };
    const rk = RANK[opts.rank || 'edge'];
    const all = [];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      if (fam(L[i]) === fam(L[j])) continue;
      const two = [L[i], L[j]];
      if (!mixed || two[0].fam !== two[1].fam) { const c = evalCombo(two); if (ok(c)) all.push(c); }
      for (let k = j + 1; k < L.length; k++) {
        if (fam(L[k]) === fam(L[i]) || fam(L[k]) === fam(L[j])) continue;
        const l3 = [L[i], L[j], L[k]];
        if (mixed && new Set(l3.map((l) => l.fam)).size < 2) continue;
        const c3 = evalCombo(l3); if (ok(c3)) all.push(c3);
      }
    }
    all.sort((a, b) => rk(b) - rk(a));
    // diversity is enforced on bet FAMILIES (a ladder's rungs count as one bet): by default each family appears in
    // exactly one ticket (backtest: 63.5% hit vs 60.3% for the old repeat-the-best-leg list, no leg on two tickets)
    const max = opts.max || 5, capSec = opts.capSec ?? 1, capAll = opts.capAll ?? 1, use = new Map(), useSec = { 2: new Map(), 3: new Map() }, pick = { 2: [], 3: [] };
    for (const c of all) {
      const n = c.legs.length; if (pick[n].length >= max) continue;
      const fs = c.legs.map(fam);
      if (fs.some((f) => (use.get(f) || 0) >= capAll || (useSec[n].get(f) || 0) >= capSec)) continue;
      if ([...pick[2], ...pick[3]].some((o) => o.legs.filter((l) => fs.includes(fam(l))).length >= 2)) continue;
      pick[n].push(c); for (const f of fs) { use.set(f, (use.get(f) || 0) + 1); useSec[n].set(f, (useSec[n].get(f) || 0) + 1); }
      if (pick[2].length >= max && pick[3].length >= max) break;
    }
    // final pricing of the chosen 3-leg tickets with the full copula (matches the parlay builder)
    const fin = (c) => (c.legs.length > 2 ? evalCombo(c.legs, true) : c);
    return { two: pick[2].map(fin), three: pick[3].map(fin).filter(ok).sort((a, b) => rk(b) - rk(a)), considered: all.length, pool: L.length };
  }

  const toAm = (p) => (p <= 0 || p >= 1 ? '—' : p >= 0.5 ? '−' + Math.round(p / (1 - p) * 100) : '+' + Math.round((1 - p) / p * 100));
  const P2 = (x) => (x * 100).toFixed(2) + '%';
  function report(c) {
    const legs = c.legs;
    const qTxt = legs.map((l) => `$${l.p.implied.toFixed(2)}`).join(' × ');
    const synergy = `Combo price from the live leg asks: ${qTxt} = ${P2(c.mkt)} (${toAm(c.mkt)}). True legs ${legs.map((l) => P2(l.p.fair)).join(', ')}; independent product ${P2(c.indTrue)} (already ${U.signed((c.indTrue - c.mkt) * 100, 2)} pts above the price before any correlation); correlation-adjusted joint ${P2(c.trueP)} (${U.signed(c.lift * 100, 1)}% lift from legs that win together). Compound edge ${U.signed(c.edge * 100, 2)}% — the ticket hits ${(c.ratio).toFixed(2)}× as often as its price implies → fair odds ${toAm(c.trueP)}; EV ${c.trueP >= c.cost ? '+' : '−'}$${Math.abs(c.trueP / c.cost - 1).toFixed(2)} per $1 after the fee. Kalshi combo quotes can include their own correlation charge — buy only at or below the BUY price.`;
    const script = c.pairs.map((x) => `Leg ${x.i + 1} ↔ Leg ${x.j + 1} (ρ ${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}): ${x.why}.`).join(' ') + (() => {
      const gs = [...new Set(legs.map((l) => l.g))];
      return ' ' + gs.map((g) => { const rec = INTEL.get(g.id), pm = rec?.poss || INTEL.possModel(g); return `${g.away.abbr}@${g.home.abbr}: ${pm.poss.toFixed(1)} projected possessions vs league ${pm.lgPace.toFixed(1)}, consensus total ${g.pre?.total?.toFixed(1) ?? '—'}.`; }).join(' ');
    })();
    const inj = legs.map((l, i) => `Leg ${i + 1}: ${l.fam === 'prop' ? `${l.name} ${l.p.data.player.st?.code || '—'}` : 'game report loaded'}`).join('; ');
    const fat = [...new Set(legs.map((l) => l.g))].map((g) => { const f = g.fat; if (!f) return `${g.away.abbr}@${g.home.abbr}: schedule not loaded`; const t = [...(f.away?.flags || []).map((x) => g.away.abbr + ' ' + x), ...(f.home?.flags || []).map((x) => g.home.abbr + ' ' + x)]; return `${g.away.abbr}@${g.home.abbr}: ${t.length ? t.join('; ') : 'no fatigue flags'}`; }).join(' · ');
    const stress = `Roster verification — ${inj}. Fatigue — ${fat}. Minimum single-leg edge ${U.signed(Math.min(...legs.map((l) => l.p.netEdge)) * 100, 2)}%; minimum pairwise ρ ${c.minR >= 0 ? '+' : ''}${c.minR.toFixed(2)} (no counter-acting scripts). Allocation carries a ${legs.length === 3 ? '0.70' : '0.85'} multi-leg variance haircut.`;
    return [{ k: 'syn', title: 'COMPOUND EDGE SYNERGY', t: synergy }, { k: 'script', title: 'GAME SCRIPT & PACING CROSS-CORRELATION', t: script }, { k: 'stress', title: 'COMPOUNDING STRESS-TEST DEFENSE', t: stress }];
  }
  return { build, report, toAm, rho, bvn, joint2, jointN, relation, metrics, legOf, haircutN, growthOf };
})();
