/* ============================================================
   court.js — top-down arena courts on canvas.
   Static floor (wood, paint, lines, logo) is cached per size;
   each frame composites lights, momentum glow, shot chart and
   scoring animations. Away team attacks the LEFT rim, home the
   RIGHT rim (matching the scoreboard layout).
   ============================================================ */

const COURT = (() => {
  const FT_W = 102, FT_H = 58, AP = 4;     // court 94×50 plus 4ft apron
  const RIM = '#ff6a13';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const instances = new Set();
  const logoCache = new Map();
  const staticCache = new Map();
  let raf = 0, frame = 0;

  function loadLogo(url) {
    if (!url) return null;
    if (logoCache.has(url)) return logoCache.get(url);
    const o = { img: new Image(), ok: false, cbs: [] };
    o.img.onload = () => { o.ok = true; o.cbs.forEach((f) => f()); };
    o.img.onerror = () => { o.ok = false; };
    o.img.src = url;
    logoCache.set(url, o);
    return o;
  }

  const WOOD = { maple: '#e9c690', honey: '#ddaa69', amber: '#cf9152', dark: '#a86f3c', parquet: '#c98d52', herring: '#cbc1ae' };

  function woodLayer(ctx, x, y, w, h, k, prof, seed) {
    const R = U.rng(seed);
    const base = WOOD[prof.wood] || WOOD.maple;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
    if (prof.wood === 'parquet') {
      const sq = 5 * k;
      for (let i = 0; i * sq < w + sq; i++) for (let j = 0; j * sq < h + sq; j++) {
        const horiz = (i + j) % 2 === 0;
        const tone = horiz ? 0.06 : -0.08;
        ctx.fillStyle = U.shade(base, tone + (R() - 0.5) * 0.05);
        ctx.fillRect(x + i * sq, y + j * sq, sq, sq);
        ctx.strokeStyle = 'rgba(70,40,15,0.22)'; ctx.lineWidth = Math.max(0.6, k * 0.05);
        for (let s = 1; s < 5; s++) {
          ctx.beginPath();
          if (horiz) { ctx.moveTo(x + i * sq, y + j * sq + s * sq / 5); ctx.lineTo(x + (i + 1) * sq, y + j * sq + s * sq / 5); }
          else { ctx.moveTo(x + i * sq + s * sq / 5, y + j * sq); ctx.lineTo(x + i * sq + s * sq / 5, y + (j + 1) * sq); }
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(60,30,10,0.35)'; ctx.strokeRect(x + i * sq, y + j * sq, sq, sq);
      }
    } else if (prof.wood === 'herring') {
      const pw = 1.2 * k, pl = 4.5 * k;
      ctx.lineWidth = Math.max(0.5, k * 0.05);
      for (let i = -2; i * pw < w + pl * 2; i++) for (let j = -2; j * pl < h + pl; j++) {
        const cx = x + i * pw * 2, cy = y + j * pl + (i % 2) * pl / 2;
        ctx.fillStyle = U.shade(base, (R() - 0.5) * 0.09);
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4); ctx.fillRect(0, 0, pl, pw); ctx.strokeStyle = 'rgba(60,50,40,0.25)'; ctx.strokeRect(0, 0, pl, pw); ctx.restore();
        ctx.fillStyle = U.shade(base, (R() - 0.5) * 0.09 - 0.03);
        ctx.save(); ctx.translate(cx + pw * 1.4, cy); ctx.rotate(-Math.PI / 4 + Math.PI / 2); ctx.fillRect(0, 0, pl, pw); ctx.strokeStyle = 'rgba(60,50,40,0.25)'; ctx.strokeRect(0, 0, pl, pw); ctx.restore();
      }
    } else {
      const ph = Math.max(2, 0.75 * k);
      for (let yy = y, row = 0; yy < y + h; yy += ph, row++) {
        let xx = x - R() * 10 * k;
        while (xx < x + w) {
          const len = (6 + R() * 10) * k;
          ctx.fillStyle = U.shade(base, (R() - 0.5) * 0.11);
          ctx.fillRect(xx, yy, len, ph);
          ctx.fillStyle = 'rgba(80,45,15,0.28)';
          ctx.fillRect(xx + len - 0.6, yy, 0.8, ph);
          xx += len;
        }
        ctx.fillStyle = 'rgba(90,50,20,0.20)'; ctx.fillRect(x, yy, w, Math.max(0.5, k * 0.04));
      }
      // grain streaks
      ctx.globalAlpha = 0.07;
      for (let i = 0; i < 260; i++) {
        ctx.strokeStyle = R() > 0.5 ? '#5a3311' : '#fff3df';
        ctx.lineWidth = 0.6;
        const gx = x + R() * w, gy = y + R() * h, gl = (2 + R() * 9) * k;
        ctx.beginPath(); ctx.moveTo(gx, gy); ctx.bezierCurveTo(gx + gl * 0.3, gy + (R() - 0.5) * 2, gx + gl * 0.7, gy + (R() - 0.5) * 2, gx + gl, gy); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // varnish
    const gl = ctx.createLinearGradient(x, y, x, y + h);
    gl.addColorStop(0, 'rgba(255,255,255,0.20)'); gl.addColorStop(0.45, 'rgba(255,255,255,0.04)'); gl.addColorStop(0.5, 'rgba(255,255,255,0)'); gl.addColorStop(1, 'rgba(0,0,0,0.10)');
    ctx.fillStyle = gl; ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  function buildStatic(W, H, dpr, game) {
    const home = game.home, prof = home.meta?.court || TEAMS.byCode[home.code]?.court || { wood: 'maple', paint: '#' + home.color, apron: U.shade('#' + home.color, -0.4), line: '#fff', accent: '#' + home.alt };
    const logo = NET.isDemo() ? null : loadLogo(home.logo);
    const key = `${home.code}:${W}:${H}:${dpr}:${logo?.ok ? 1 : 0}`;
    if (staticCache.has(key)) return staticCache.get(key);
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    const k = W / FT_W;
    const X = (ft) => (AP + ft) * k, Y = (ft) => (AP + ft) * k;
    // apron
    const ap = c.createLinearGradient(0, 0, 0, H);
    ap.addColorStop(0, U.shade(prof.apron, 0.12)); ap.addColorStop(1, U.shade(prof.apron, -0.25));
    c.fillStyle = ap; c.fillRect(0, 0, W, H);
    if (prof.pinstripes) { c.strokeStyle = 'rgba(255,255,255,0.10)'; c.lineWidth = 1; for (let x = 0; x < W; x += k * 1.6) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); } }
    if (prof.honeycomb) {
      c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 1; const r = k * 1.3;
      for (let yy = 0, row = 0; yy < H + r; yy += r * 1.5, row++) for (let xx = (row % 2) * r * 0.87; xx < W + r; xx += r * 1.74) {
        c.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i + Math.PI / 6; c.lineTo(xx + r * Math.cos(a), yy + r * Math.sin(a)); } c.closePath(); c.stroke();
      }
    }
    // wood
    woodLayer(c, X(0), Y(0), 94 * k, 50 * k, k, prof, U.hash(home.code));
    // arc stain
    const lw = Math.max(1, k * 0.2);
    const threePath = (end) => {
      const bx = end ? 94 - 5.25 : 5.25, dir = end ? -1 : 1;
      const ang = Math.asin(22 / 23.75);
      c.beginPath();
      c.moveTo(X(end ? 94 : 0), Y(3));
      c.lineTo(X(bx + dir * 23.75 * Math.cos(ang)), Y(3));
      if (!end) c.arc(X(bx), Y(25), 23.75 * k, -ang, ang, false);
      else c.arc(X(bx), Y(25), 23.75 * k, Math.PI + ang, Math.PI - ang, true);
      c.lineTo(X(end ? 94 : 0), Y(47));
    };
    if (prof.stain) for (const e of [0, 1]) { threePath(e); c.closePath(); c.fillStyle = prof.stain; c.fill(); }
    if (prof.sunburst) {
      c.save(); c.translate(X(47), Y(25)); c.globalAlpha = 0.10; c.fillStyle = prof.accent;
      for (let i = 0; i < 16; i++) { c.rotate(Math.PI / 8); c.beginPath(); c.moveTo(0, 0); c.lineTo(30 * k, -2.5 * k); c.lineTo(30 * k, 2.5 * k); c.closePath(); c.fill(); }
      c.restore();
    }
    // paint
    const paintGrad = (x0, x1) => { const gp = c.createLinearGradient(0, Y(17), 0, Y(33)); gp.addColorStop(0, U.shade(prof.paint, 0.12)); gp.addColorStop(0.5, prof.paint); gp.addColorStop(1, U.shade(prof.paint, -0.15)); return gp; };
    c.fillStyle = paintGrad(); c.fillRect(X(0), Y(17), 19 * k, 16 * k); c.fillRect(X(94 - 19), Y(17), 19 * k, 16 * k);
    if (prof.mountains) {
      c.save(); c.globalAlpha = 0.18; c.fillStyle = '#ffffff';
      for (const e of [0, 1]) {
        const x0 = e ? X(94 - 19) : X(0);
        c.beginPath(); c.moveTo(x0, Y(33)); c.lineTo(x0 + 4 * k, Y(27)); c.lineTo(x0 + 7 * k, Y(30)); c.lineTo(x0 + 11 * k, Y(24)); c.lineTo(x0 + 15 * k, Y(29)); c.lineTo(x0 + 19 * k, Y(26)); c.lineTo(x0 + 19 * k, Y(33)); c.closePath(); c.fill();
      }
      c.restore();
    }
    // center circle fill
    c.beginPath(); c.arc(X(47), Y(25), 6 * k, 0, Math.PI * 2); c.fillStyle = U.rgba(prof.paint.replace('#', ''), 0.85); c.fill();
    // lines
    c.strokeStyle = prof.line; c.lineWidth = lw; c.lineCap = 'butt';
    c.strokeRect(X(0), Y(0), 94 * k, 50 * k);
    c.beginPath(); c.moveTo(X(47), Y(0)); c.lineTo(X(47), Y(50)); c.stroke();
    c.beginPath(); c.arc(X(47), Y(25), 6 * k, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(X(47), Y(25), 2 * k, 0, Math.PI * 2); c.stroke();
    for (const e of [0, 1]) {
      const bx = e ? 94 - 5.25 : 5.25, kx = e ? 94 - 19 : 19, dir = e ? -1 : 1;
      c.strokeRect(X(e ? 94 - 19 : 0), Y(17), 19 * k, 16 * k);
      // FT circle: outer half solid, inner half dashed
      c.beginPath(); c.arc(X(kx), Y(25), 6 * k, e ? Math.PI / 2 : -Math.PI / 2, e ? Math.PI * 1.5 : Math.PI / 2, !!e); c.stroke();
      c.save(); c.setLineDash([k * 1.2, k * 1.0]); c.beginPath(); c.arc(X(kx), Y(25), 6 * k, e ? -Math.PI / 2 : Math.PI / 2, e ? Math.PI / 2 : Math.PI * 1.5, !!e); c.stroke(); c.restore();
      // restricted area
      c.beginPath(); c.arc(X(bx), Y(25), 4 * k, e ? Math.PI / 2 : -Math.PI / 2, e ? Math.PI * 1.5 : Math.PI / 2, !!e); c.stroke();
      // 3pt
      c.strokeStyle = prof.accent && prof.accent !== prof.paint ? prof.line : prof.line;
      threePath(e); c.stroke();
      // hash marks
      for (const h of [7, 8, 11, 14]) { c.beginPath(); c.moveTo(X(e ? 94 - h : h), Y(17)); c.lineTo(X(e ? 94 - h : h), Y(16.4)); c.moveTo(X(e ? 94 - h : h), Y(33)); c.lineTo(X(e ? 94 - h : h), Y(33.6)); c.stroke(); }
      // backboard + rim
      c.save(); c.lineWidth = Math.max(2, k * 0.45); c.strokeStyle = 'rgba(255,255,255,0.95)';
      c.beginPath(); c.moveTo(X(e ? 90 : 4), Y(22)); c.lineTo(X(e ? 90 : 4), Y(28)); c.stroke(); c.restore();
      c.beginPath(); c.arc(X(bx), Y(25), 0.75 * k, 0, Math.PI * 2); c.strokeStyle = RIM; c.lineWidth = Math.max(1.4, k * 0.25); c.stroke();
      c.strokeStyle = prof.line; c.lineWidth = lw;
    }
    // accent pinline inside boundary
    c.strokeStyle = prof.accent; c.globalAlpha = 0.85; c.lineWidth = Math.max(1, k * 0.25);
    c.strokeRect(X(0) - k * 0.9, Y(0) - k * 0.9, 94 * k + k * 1.8, 50 * k + k * 1.8); c.globalAlpha = 1;
    // apron words
    c.fillStyle = 'rgba(255,255,255,0.88)'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const fs = Math.max(7, k * 2.3);
    c.font = `700 ${fs}px Teko, "Arial Narrow", sans-serif`;
    const spaced = (s) => s.toUpperCase().split('').join(String.fromCharCode(8202));
    c.fillText(spaced(home.city || ''), W / 2, k * AP / 2 + 0.5);
    c.fillText(spaced(home.name || ''), W / 2, H - k * AP / 2 + 0.5);
    c.font = `600 ${Math.max(6, k * 1.6)}px Teko, "Arial Narrow", sans-serif`; c.fillStyle = 'rgba(255,255,255,0.55)';
    c.textAlign = 'right'; c.fillText((game.venue?.name || home.meta?.arena || '').toUpperCase(), W - k * 1.2, k * AP / 2 + 0.5);
    // center logo
    const cr = 5.2 * k;
    c.save(); c.beginPath(); c.arc(X(47), Y(25), cr, 0, Math.PI * 2); c.clip();
    if (logo?.ok) {
      c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(X(47) - cr, Y(25) - cr, cr * 2, cr * 2);
      const s = cr * 1.7; c.drawImage(logo.img, X(47) - s / 2, Y(25) - s / 2, s, s);
    } else {
      const gr = c.createRadialGradient(X(47), Y(25) - cr * 0.4, cr * 0.1, X(47), Y(25), cr);
      gr.addColorStop(0, U.shade('#' + home.color, 0.25)); gr.addColorStop(1, U.shade('#' + home.color, -0.3));
      c.fillStyle = gr; c.fillRect(X(47) - cr, Y(25) - cr, cr * 2, cr * 2);
      c.fillStyle = '#ffffff'; c.textAlign = 'center';
      let fsz = cr * 1.05; c.font = `700 ${fsz}px Teko, "Arial Narrow", sans-serif`;
      const tw = c.measureText(home.abbr).width; if (tw > cr * 1.5) { fsz *= (cr * 1.5) / tw; c.font = `700 ${fsz}px Teko, "Arial Narrow", sans-serif`; }
      c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 3; c.fillText(home.abbr, X(47), Y(25) + cr * 0.08); c.shadowBlur = 0;
    }
    c.restore();
    c.beginPath(); c.arc(X(47), Y(25), cr, 0, Math.PI * 2); c.strokeStyle = '#' + (home.alt && U.lum(home.alt) > 0.12 ? home.alt : 'ffffff'); c.lineWidth = Math.max(1.2, k * 0.35); c.stroke();
    // arena vignette
    const vg = c.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.38)');
    c.fillStyle = vg; c.fillRect(0, 0, W, H);
    const out = { cv, k, X, Y };
    staticCache.set(key, out);
    if (staticCache.size > 60) staticCache.delete(staticCache.keys().next().value);
    if (logo && !logo.ok) logo.cbs.push(() => { for (const i of instances) if (i.game?.home?.logo === home.logo) i.dirty = true; });
    return out;
  }

  // positions (ft) for synthesized shots
  function synthShot(side, pts, R) {
    const left = side === 'away';
    const bx = left ? 5.25 : 94 - 5.25, dir = left ? 1 : -1;
    let x, y;
    if (pts === 1) { x = left ? 19 : 75; y = 25; }
    else if (pts === 3) {
      const a = (R() - 0.5) * Math.PI * 0.95; const r = 24 + R() * 2.5;
      x = bx + dir * Math.max(1, r * Math.cos(a)); y = 25 + r * Math.sin(a); y = U.clamp(y, 1.5, 48.5);
      if (Math.abs(y - 25) > 21.5) x = left ? 2 + R() * 9 : 92 - R() * 9;
    } else { const a = (R() - 0.5) * Math.PI * 0.9; const r = 1 + R() * 16; x = bx + dir * Math.max(0.5, r * Math.cos(a)); y = 25 + r * Math.sin(a); }
    return { x, y };
  }
  // map feed coordinates into our orientation
  function mapShot(side, s) {
    let x, y;
    if (s.src === 'nba') { x = s.x * 0.94; y = s.y * 0.5; }
    else { y = s.x; x = Math.min(s.y, 94 - s.y); } // ESPN half-court: x across, y from baseline
    if (s.src === 'nba') { if (x > 47) x = 94 - x; }
    if (side === 'home') x = 94 - x;
    return { x, y };
  }

  function create(canvas, opts = {}) {
    const inst = { canvas, ctx: canvas.getContext('2d'), game: null, visible: true, big: !!opts.big, fx: [], dirty: true, W: 0, H: 0, R: U.rng(Math.random() * 1e9 | 0), t0: performance.now() };
    const io = new IntersectionObserver((es) => { for (const e of es) inst.visible = e.isIntersecting; }, { rootMargin: '80px' });
    io.observe(canvas);
    inst.io = io;
    instances.add(inst);
    inst.setGame = (g) => { inst.game = g; };
    inst.score = (side, pts, extra = {}) => {
      if (!inst.game) return;
      const s = extra.shot ? mapShot(side, extra.shot) : synthShot(side, pts, inst.R);
      inst.fx.push({ type: 'shot', side, pts, x: s.x, y: s.y, t: performance.now(), lead: !!extra.leadChange });
      if (extra.leadChange) inst.fx.push({ type: 'banner', text: 'LEAD CHANGE', side, t: performance.now() });
      if (inst.fx.length > 24) inst.fx.splice(0, inst.fx.length - 24);
    };
    inst.banner = (text, side) => inst.fx.push({ type: 'banner', text, side, t: performance.now() });
    inst.destroy = () => { io.disconnect(); instances.delete(inst); };
    start();
    return inst;
  }

  function size(inst) {
    const r = inst.canvas.getBoundingClientRect();
    const W = Math.max(120, Math.round(r.width)), H = Math.round(W * FT_H / FT_W);
    const dpr = Math.min(window.devicePixelRatio || 1, inst.big ? 2.5 : 2);
    if (W !== inst.W || H !== inst.H || dpr !== inst.dpr) {
      inst.W = W; inst.H = H; inst.dpr = dpr;
      inst.canvas.width = Math.round(W * dpr); inst.canvas.height = Math.round(H * dpr);
      inst.canvas.style.height = H + 'px';
    }
  }

  function draw(inst, now) {
    const g = inst.game; if (!g) return;
    size(inst);
    const { W, H, dpr } = inst, c = inst.ctx;
    const st = buildStatic(W, H, dpr, g);
    const { k, X, Y } = st;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(st.cv, 0, 0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = (now - inst.t0) / 1000;
    const live = g.state === 'in', pre = g.state === 'pre', post = g.state === 'post';
    const [awc, hmc] = U.pairColors(g.away, g.home); const awayC = '#' + awc, homeC = '#' + hmc;

    // momentum glow on the attacking half of the team on a run
    if (live && g.run && g.run.pts - g.run.opp >= 5) {
      const left = g.run.side === 'away';
      const col = left ? g.away.color : g.home.color;
      const a = U.clamp((g.run.pts - g.run.opp) / 20, 0.08, 0.38) * (reduce ? 1 : 0.8 + 0.2 * Math.sin(t * 3));
      const gr = c.createLinearGradient(left ? X(0) : X(94), 0, X(47), 0);
      gr.addColorStop(0, U.rgba(col, a)); gr.addColorStop(1, U.rgba(col, 0));
      c.fillStyle = gr; c.fillRect(X(left ? 0 : 47), Y(0), 47 * k, 50 * k);
    }
    // pregame spotlights
    if (pre && !reduce) {
      c.save(); c.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 2; i++) {
        const px = W / 2 + Math.sin(t * 0.7 + i * 2.6) * W * 0.32, py = H / 2 + Math.cos(t * 0.9 + i * 1.7) * H * 0.28;
        const sg = c.createRadialGradient(px, py, 0, px, py, H * 0.42);
        sg.addColorStop(0, 'rgba(255,248,225,0.20)'); sg.addColorStop(1, 'rgba(255,248,225,0)');
        c.fillStyle = sg; c.fillRect(0, 0, W, H);
      }
      c.restore();
      const ms = g.date - Date.now();
      if (ms < 30 * 60e3 && ms > -10 * 60e3) {
        c.save(); c.translate(X(47), Y(25)); const pulse = 1 + 0.06 * Math.sin(t * 5);
        c.scale(pulse, pulse); c.fillStyle = 'rgba(0,0,0,0.55)'; c.beginPath(); c.roundRect?.(-11 * k, -2.6 * k, 22 * k, 5.2 * k, 2 * k); c.fill();
        c.fillStyle = '#ffd36b'; c.font = `700 ${3.6 * k}px Teko, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(ms > 0 ? 'TIP-OFF ' + U.countdown(ms) : 'TIP-OFF', 0, 0.3 * k);
        c.restore();
      }
    }
    // glossy sweep
    if (!reduce) {
      const ph = (t % 7) / 7; const sx = -W * 0.4 + ph * W * 1.8;
      const sw = c.createLinearGradient(sx, 0, sx + W * 0.25, H);
      sw.addColorStop(0, 'rgba(255,255,255,0)'); sw.addColorStop(0.5, 'rgba(255,255,255,0.10)'); sw.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = sw; c.fillRect(0, 0, W, H);
    }
    // shot chart (persisted shots)
    const shots = g.shots || [];
    for (let i = Math.max(0, shots.length - (inst.big ? 60 : 16)); i < shots.length; i++) {
      const s = shots[i]; const p = s.x != null ? s : null; if (!p) continue;
      const col = s.side === 'away' ? awayC : homeC;
      const age = (Date.now() - s.t) / 1000;
      const a = U.clamp(1 - age / (inst.big ? 1800 : 600), 0.25, 1);
      c.globalAlpha = a;
      if (s.made) { c.beginPath(); c.arc(X(s.x), Y(s.y), Math.max(1.8, k * 0.75), 0, Math.PI * 2); c.fillStyle = col; c.fill(); c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.9)'; c.stroke(); }
      else { const r = Math.max(1.5, k * 0.6); c.strokeStyle = col; c.lineWidth = Math.max(1, k * 0.22); c.beginPath(); c.moveTo(X(s.x) - r, Y(s.y) - r); c.lineTo(X(s.x) + r, Y(s.y) + r); c.moveTo(X(s.x) + r, Y(s.y) - r); c.lineTo(X(s.x) - r, Y(s.y) + r); c.stroke(); }
      c.globalAlpha = 1;
    }
    // effects
    const nowp = performance.now();
    inst.fx = inst.fx.filter((f) => nowp - f.t < (f.type === 'banner' ? 1800 : 1600));
    for (const f of inst.fx) {
      const el = (nowp - f.t) / 1000;
      if (f.type === 'shot') {
        const left = f.side === 'away';
        const rx = left ? 5.25 : 94 - 5.25, col = left ? awayC : homeC;
        const T = reduce ? 0 : U.clamp(el / 0.65, 0, 1);
        if (T < 1) {
          const bx = U.lerp(f.x, rx, T), by = U.lerp(f.y, 25, T);
          const lift = Math.sin(Math.PI * T) * (f.pts === 3 ? 9 : f.pts === 1 ? 5 : 6);
          const sc = 1 + lift / 9 * 0.9;
          c.beginPath(); c.arc(X(bx), Y(by), k * 0.7, 0, Math.PI * 2); c.fillStyle = 'rgba(0,0,0,0.25)'; c.fill(); // shadow
          c.beginPath(); c.arc(X(bx), Y(by) - lift * k * 0.35, k * 0.75 * sc, 0, Math.PI * 2);
          const bg = c.createRadialGradient(X(bx) - k * 0.3, Y(by) - lift * k * 0.35 - k * 0.3, 0, X(bx), Y(by) - lift * k * 0.35, k * 0.8 * sc);
          bg.addColorStop(0, '#ffb067'); bg.addColorStop(1, '#c4520f'); c.fillStyle = bg; c.fill();
          // trail
          c.strokeStyle = U.rgba(col.replace('#', ''), 0.5); c.lineWidth = k * 0.35; c.setLineDash([k * 0.6, k * 0.6]);
          c.beginPath(); c.moveTo(X(f.x), Y(f.y)); c.quadraticCurveTo(X((f.x + bx) / 2), Y((f.y + by) / 2) - k * 4, X(bx), Y(by) - lift * k * 0.35); c.stroke(); c.setLineDash([]);
        } else {
          const e2 = el - 0.65;
          const rr = k * (1 + e2 * 14);
          c.beginPath(); c.arc(X(rx), Y(25), rr, 0, Math.PI * 2);
          c.strokeStyle = U.rgba(col.replace('#', ''), U.clamp(1 - e2 / 0.9, 0, 1)); c.lineWidth = k * 0.6; c.stroke();
          c.save(); c.globalCompositeOperation = 'lighter';
          const fl = c.createRadialGradient(X(rx), Y(25), 0, X(rx), Y(25), k * 7);
          fl.addColorStop(0, `rgba(255,190,90,${U.clamp(0.7 - e2, 0, 0.7)})`); fl.addColorStop(1, 'rgba(255,190,90,0)');
          c.fillStyle = fl; c.fillRect(X(rx) - k * 7, Y(25) - k * 7, k * 14, k * 14); c.restore();
          c.save(); c.globalAlpha = U.clamp(1.1 - e2 / 0.9, 0, 1);
          c.font = `700 ${k * (inst.big ? 5 : 6)}px Teko, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,0.7)'; const ty = Y(25) - k * (3 + e2 * 6);
          const tx = X(left ? 13 : 81);
          c.strokeText('+' + f.pts, tx, ty); c.fillStyle = col; c.fillText('+' + f.pts, tx, ty); c.restore();
        }
      } else if (f.type === 'banner') {
        const a = el < 0.25 ? el / 0.25 : el > 1.4 ? U.clamp((1.8 - el) / 0.4, 0, 1) : 1;
        c.save(); c.globalAlpha = a;
        const bh = 7 * k; const y0 = Y(25) - bh / 2;
        const bgc = c.createLinearGradient(0, y0, 0, y0 + bh);
        const col = (f.side === 'away' ? g.away.color : g.home.color);
        bgc.addColorStop(0, U.shade('#' + col, 0.25)); bgc.addColorStop(0.5, '#' + col); bgc.addColorStop(0.51, U.shade('#' + col, -0.2)); bgc.addColorStop(1, U.shade('#' + col, -0.45));
        c.fillStyle = bgc; c.fillRect(0, y0, W, bh);
        c.fillStyle = 'rgba(255,255,255,0.9)'; c.fillRect(0, y0, W, 1); c.fillRect(0, y0 + bh - 1, W, 1);
        c.font = `700 ${5 * k}px Teko, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
        const off = reduce ? 0 : (1 - Math.min(1, el / 0.35)) * W * 0.4;
        c.fillStyle = '#fff'; c.fillText(f.text, W / 2 - off, Y(25) + 0.4 * k);
        c.restore();
      }
    }
    // status overlays
    if (live) {
      const pulse = reduce ? 1 : 0.55 + 0.45 * Math.sin(t * 4);
      c.beginPath(); c.arc(k * 2.2, k * 2.2, k * 0.9, 0, Math.PI * 2); c.fillStyle = `rgba(255,59,48,${pulse})`; c.fill();
      if (/HALFTIME/.test(g.statusName)) overlayText(c, X(47), Y(25), k, 'HALFTIME');
      else if (/END_PERIOD/.test(g.statusName)) overlayText(c, X(47), Y(25), k, 'END OF ' + U.periodShort(g.period));
      // possession arrow
      if (g.poss) {
        const left = g.poss === 'away';
        c.fillStyle = 'rgba(255,255,255,0.9)'; c.beginPath();
        const ax = left ? X(36) : X(58), dir = left ? -1 : 1;
        c.moveTo(ax + dir * 2 * k, Y(25)); c.lineTo(ax - dir * 0.5 * k, Y(23.6)); c.lineTo(ax - dir * 0.5 * k, Y(26.4)); c.closePath(); c.fill();
      }
    }
    if (post) {
      c.fillStyle = 'rgba(10,14,22,0.32)'; c.fillRect(0, 0, W, H);
      const win = g.home.score > g.away.score ? 'home' : 'away';
      const gr = c.createLinearGradient(win === 'away' ? 0 : W, 0, W / 2, 0);
      gr.addColorStop(0, U.rgba(g[win].color, 0.35)); gr.addColorStop(1, U.rgba(g[win].color, 0));
      c.fillStyle = gr; c.fillRect(win === 'away' ? 0 : W / 2, 0, W / 2, H);
      overlayText(c, X(47), Y(25), k, 'FINAL');
    }
    inst.dirty = false;
  }
  function overlayText(c, x, y, k, s) {
    c.save(); c.font = `700 ${4.2 * k}px Teko, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    const w = c.measureText(s).width + 4 * k;
    c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(x - w / 2, y - 2.6 * k, w, 5.2 * k);
    c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1; c.strokeRect(x - w / 2 + 0.5, y - 2.6 * k + 0.5, w - 1, 5.2 * k - 1);
    c.fillStyle = '#fff'; c.fillText(s, x, y + 0.3 * k); c.restore();
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    frame++;
    for (const inst of instances) {
      if (!inst.visible || !inst.canvas.isConnected) continue;
      const busy = inst.fx.length > 0;
      if (reduce && !busy && !inst.dirty && frame % 30) continue;
      if (!inst.big && !busy && frame % 2) continue;
      draw(inst, now);
    }
  }
  function start() { if (!raf) raf = requestAnimationFrame(loop); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else start(); });

  return { create, synthShot, mapShot, instances, invalidate: () => { staticCache.clear(); for (const i of instances) i.dirty = true; } };
})();
