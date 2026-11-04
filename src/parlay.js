/* ============================================================
   parlay.js — Section 2: optimal 2-/3-leg parlays built only
   from Section 1 survivors. Joint probability via a Gaussian
   copula on each leg's true probability with rule-based pairwise
   correlations; negative or redundant pairs are barred.
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
    const L = { p, g, gameId: p.gameId, fam: p.kind === 'prop' ? 'prop' : 'line', kind: p.kind, seg: !!m.seg, ticker: p.ticker };
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

  function evalCombo(legs) {
    const pairs = [];
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
      const c = rho(legs[i], legs[j]);
      if (!c || c.r < 0) return null; // correlation filter: no negative or redundant pairings
      pairs.push({ i, j, ...c });
    }
    const ps = legs.map((l) => l.p.fair), qs = legs.map((l) => l.p.implied);
    let trueP;
    if (legs.length === 2) trueP = joint2(ps[0], ps[1], pairs[0].r);
    else {
      // Kirkwood superposition on pairwise joints
      const pj = (k) => joint2(ps[pairs[k].i], ps[pairs[k].j], pairs[k].r);
      const j01 = pj(0), j02 = pj(1), j12 = pj(2);
      trueP = ps[0] * ps[1] * ps[2] * (j01 / (ps[0] * ps[1])) * (j02 / (ps[0] * ps[2])) * (j12 / (ps[1] * ps[2]));
      trueP = Math.min(trueP, j01, j02, j12);
    }
    const indTrue = ps.reduce((a, b) => a * b, 1), mkt = qs.reduce((a, b) => a * b, 1);
    const edge = trueP - mkt;
    const kelly = edge > 0 ? (trueP - mkt) / (1 - mkt) : 0;
    const haircut = legs.length === 3 ? 0.7 : 0.85;
    const scale = Math.round(U.clamp((kelly * 0.25 * haircut) / 0.02 * 10, 0, 10) * 10) / 10;
    return { legs, pairs, trueP, indTrue, mkt, edge, scale, kelly: kelly * 0.25 * haircut, buyMax: Math.max(0, trueP - 0.04), fairMax: trueP, minR: Math.min(...pairs.map((x) => x.r)) };
  }

  /** picks: [{p, g}] survivors. Returns {two, three} sorted by net compound edge. */
  function build(pool, opts = {}) {
    const top = pool.filter(({ p }) => p.survivor && !p.modelOnly && p.implied > 0.02).sort((a, b) => b.p.netEdge - a.p.netEdge).slice(0, opts.pool || 12);
    const L = top.map(({ p, g }) => legOf(p, g));
    const fams = new Set(L.map((l) => l.fam));
    const mixed = fams.size > 1; // props and lines both available → every ticket must mix them
    const two = [], three = [];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const legs = [L[i], L[j]];
      if (mixed && new Set(legs.map((l) => l.fam)).size < 2) continue;
      const c = evalCombo(legs); if (c && c.edge > 0.04) two.push(c);
      for (let k = j + 1; k < L.length; k++) {
        const l3 = [L[i], L[j], L[k]];
        if (mixed && new Set(l3.map((l) => l.fam)).size < 2) continue;
        const c3 = evalCombo(l3); if (c3 && c3.edge > 0.04) three.push(c3);
      }
    }
    const sort = (a, b) => b.edge - a.edge;
    return { two: two.sort(sort).slice(0, opts.max || 5), three: three.sort(sort).slice(0, opts.max || 5) };
  }

  const toAm = (p) => (p <= 0 || p >= 1 ? '—' : p >= 0.5 ? '−' + Math.round(p / (1 - p) * 100) : '+' + Math.round((1 - p) / p * 100));
  const P2 = (x) => (x * 100).toFixed(2) + '%';
  function report(c) {
    const legs = c.legs;
    const qTxt = legs.map((l) => `$${l.p.implied.toFixed(2)}`).join(' × ');
    const synergy = `Legs priced independently: ${qTxt} = ${P2(c.mkt)} (${toAm(c.mkt)}). True legs ${legs.map((l) => P2(l.p.fair)).join(', ')}; independent product ${P2(c.indTrue)}; correlation-adjusted joint ${P2(c.trueP)} (${U.signed((c.trueP - c.indTrue) * 100, 2)} pts from correlation). Compound edge ${U.signed(c.edge * 100, 2)}% → fair odds ${toAm(c.trueP)}; EV ${c.edge >= 0 ? '+' : '−'}$${Math.abs(c.edge / c.mkt).toFixed(2)} per $1 staked.`;
    const script = c.pairs.map((x) => `Leg ${x.i + 1} ↔ Leg ${x.j + 1} (ρ ${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}): ${x.why}.`).join(' ') + (() => {
      const gs = [...new Set(legs.map((l) => l.g))];
      return ' ' + gs.map((g) => { const rec = INTEL.get(g.id), pm = rec?.poss || INTEL.possModel(g); return `${g.away.abbr}@${g.home.abbr}: ${pm.poss.toFixed(1)} projected possessions vs league ${pm.lgPace.toFixed(1)}, consensus total ${g.pre?.total?.toFixed(1) ?? '—'}.`; }).join(' ');
    })();
    const inj = legs.map((l, i) => `Leg ${i + 1}: ${l.fam === 'prop' ? `${l.name} ${l.p.data.player.st?.code || '—'}` : 'game report loaded'}`).join('; ');
    const fat = [...new Set(legs.map((l) => l.g))].map((g) => { const f = g.fat; if (!f) return `${g.away.abbr}@${g.home.abbr}: schedule not loaded`; const t = [...(f.away?.flags || []).map((x) => g.away.abbr + ' ' + x), ...(f.home?.flags || []).map((x) => g.home.abbr + ' ' + x)]; return `${g.away.abbr}@${g.home.abbr}: ${t.length ? t.join('; ') : 'no fatigue flags'}`; }).join(' · ');
    const stress = `Roster verification — ${inj}. Fatigue — ${fat}. Minimum single-leg edge ${U.signed(Math.min(...legs.map((l) => l.p.netEdge)) * 100, 2)}%; minimum pairwise ρ ${c.minR >= 0 ? '+' : ''}${c.minR.toFixed(2)} (no counter-acting scripts). Allocation carries a ${legs.length === 3 ? '0.70' : '0.85'} multi-leg variance haircut.`;
    return [{ k: 'syn', title: 'COMPOUND EDGE SYNERGY', t: synergy }, { k: 'script', title: 'GAME SCRIPT & PACING CROSS-CORRELATION', t: script }, { k: 'stress', title: 'COMPOUNDING STRESS-TEST DEFENSE', t: stress }];
  }
  return { build, report, toAm, rho, bvn, joint2 };
})();
