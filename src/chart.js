/* ============================================================
   chart.js — "Edge Map": confidence (y) vs edge after fees (x).
   Color + shape encode market family (validated 3-slot palette).
   ============================================================ */

const CHART = (() => {
  const FAM = {
    prop: { label: 'Player props', color: 'var(--s1)', shape: 'circle' },
    line: { label: 'Game lines', color: 'var(--s2)', shape: 'square' },
    seg: { label: 'Quarters / halves', color: 'var(--s3)', shape: 'diamond' },
  };
  const famOf = (p) => (p.kind === 'prop' ? 'prop' : p.seg ? 'seg' : 'line');

  function shapePath(shape, x, y, r) {
    if (shape === 'square') return `M${x - r * 0.88},${y - r * 0.88}h${r * 1.76}v${r * 1.76}h${-r * 1.76}z`;
    if (shape === 'diamond') return `M${x},${y - r * 1.2}L${x + r * 1.2},${y}L${x},${y + r * 1.2}L${x - r * 1.2},${y}z`;
    return `M${x - r},${y}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`;
  }

  function render(el, picks, opts = {}) {
    const W = 640, H = 300, L = 44, R = 14, T = 14, B = 34;
    const lean = !!opts.lean;
    const xv = (p) => (lean ? p.lean : p.edge);
    const pts = picks.filter((p) => isFinite(xv(p)) && isFinite(p.fair)).slice(0, 120);
    const ex = pts.map((p) => xv(p) * 100);
    let x0 = lean ? 0 : Math.min(-6, ...ex), x1 = Math.max(lean ? 10 : 12, ...ex);
    x0 = Math.floor(x0 / 2) * 2; x1 = Math.ceil(x1 / 2) * 2;
    const y0 = 0, y1 = 100;
    const sx = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
    const sy = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const xt = []; const step = (x1 - x0) > 30 ? 10 : 4;
    for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step) xt.push(v);
    const yt = [0, 25, 50, 75, 100];
    let s = `<svg viewBox="0 0 ${W} ${H}" class="edgemap" role="img" aria-label="Edge map: confidence versus edge for ${pts.length} picks">`;
    // playable zone
    if (!lean) {
      s += `<rect x="${sx(2.5)}" y="${T}" width="${Math.max(0, sx(x1) - sx(2.5))}" height="${H - T - B}" fill="var(--zone)"/>`;
      s += `<text x="${sx(x1) - 6}" y="${T + 14}" text-anchor="end" class="ax zl">+EV zone</text>`;
    } else s += `<text x="${sx(x1) - 6}" y="${T + 14}" text-anchor="end" class="ax zl">no live prices: model lean</text>`;
    for (const v of yt) s += `<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="grid"/><text x="${L - 6}" y="${sy(v) + 4}" text-anchor="end" class="ax">${v}%</text>`;
    for (const v of xt) s += `<line y1="${T}" y2="${H - B}" x1="${sx(v)}" x2="${sx(v)}" class="grid${v === 0 ? ' zero' : ''}"/><text x="${sx(v)}" y="${H - B + 16}" text-anchor="middle" class="ax">${v > 0 ? '+' : ''}${v}${lean ? '' : '¢'}</text>`;
    s += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle" class="ax tt">${lean ? 'Model lean vs baseline (pct pts)' : 'Edge per $1 contract after fees'}</text>`;
    s += `<text x="12" y="${(T + H - B) / 2}" text-anchor="middle" class="ax tt" transform="rotate(-90 12 ${(T + H - B) / 2})">Confidence</text>`;
    // marks (draw weakest first so best are on top)
    const sorted = [...pts].sort((a, b) => a.rating - b.rating);
    for (const p of sorted) {
      const f = FAM[famOf(p)];
      const r = p.tier === 'HOF' ? 7.5 : p.tier === 'GOLD' ? 6.5 : p.tier ? 5.5 : 4.5;
      const x = sx(xv(p) * 100), y = sy(p.fair * 100);
      s += `<g class="pt${p.playable ? ' play' : ''}${p.lag ? ' lag' : ''}" data-id="${U.esc(p.id)}" tabindex="0">`;
      s += `<circle cx="${x}" cy="${y}" r="16" fill="transparent"/>`;
      if (p.lag) s += `<circle cx="${x}" cy="${y}" r="${r + 4}" class="lagring"/>`;
      s += `<path d="${shapePath(f.shape, x, y, r)}" fill="${f.color}" stroke="var(--chart-bg)" stroke-width="2" opacity="${p.playable || lean ? 1 : 0.45}"/>`;
      s += `</g>`;
    }
    // direct labels for top 3 playable
    const top = pts.filter((p) => p.playable || lean).sort((a, b) => b.rating - a.rating).slice(0, 3);
    for (const p of top) {
      const x = sx(xv(p) * 100), y = sy(p.fair * 100);
      const right = x < W - 170;
      s += `<text x="${right ? x + 11 : x - 11}" y="${y - 8}" text-anchor="${right ? 'start' : 'end'}" class="dl">${U.esc(p.label.length > 24 ? p.label.slice(0, 23) + '…' : p.label)}</text>`;
    }
    s += `</svg>`;
    const legend = `<div class="legend">${Object.values(FAM).map((f) => `<span><svg viewBox="-8 -8 16 16" width="14" height="14"><path d="${shapePath(f.shape, 0, 0, 5)}" fill="${f.color}"/></svg>${f.label}</span>`).join('')}${lean ? '' : '<span><svg viewBox="-8 -8 16 16" width="14" height="14"><circle r="6" class="lagring"/></svg>Stale price</span>'}</div>`;
    el.innerHTML = legend + `<div class="chartwrap">${s}<div class="tip" hidden></div></div>`;
    const tip = el.querySelector('.tip');
    const byId = new Map(pts.map((p) => [p.id, p]));
    const show = (g) => {
      const p = byId.get(g.dataset.id); if (!p) return;
      const box = el.querySelector('.chartwrap').getBoundingClientRect(), r = g.getBoundingClientRect();
      tip.innerHTML = p.modelOnly ? `<b>${U.esc(p.label)}</b><span>${p.side} if ≤ ${U.cents(p.maxEntry)} · fair ${U.cents(p.fair)}</span><span>Lean +${(p.lean * 100).toFixed(1)} · Conf ${U.pct(p.fair)} · OVR ${p.rating}</span>` : `<b>${U.esc(p.label)}</b><span>${p.side} @ ${U.cents(p.price)} · fair ${U.cents(p.fair)}</span><span>Edge ${U.signed(p.edge * 100, 1)}¢ · Conf ${U.pct(p.fair)} · OVR ${p.rating}</span>`;
      tip.hidden = false;
      const tx = U.clamp(r.left - box.left + r.width / 2, 90, box.width - 90);
      tip.style.left = tx + 'px'; tip.style.top = (r.top - box.top - 8) + 'px';
    };
    el.querySelectorAll('.pt').forEach((g) => {
      g.addEventListener('pointerenter', () => show(g));
      g.addEventListener('focus', () => show(g));
      g.addEventListener('pointerleave', () => (tip.hidden = true));
      g.addEventListener('blur', () => (tip.hidden = true));
      g.addEventListener('click', () => { show(g); opts.onPick?.(g.dataset.id); });
    });
  }
  return { render, famOf, FAM };
})();
