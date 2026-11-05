/* demo.js — Courtside Edge demo feed simulator.
   Imitates ESPN site API, NBA liveData CDN and Kalshi trade-api v2 JSON for a
   simulated slate. Real NBA teams (for court styling), FICTIONAL players.
   Usage: DEMO.handle(source, pathWithQuery) -> parsed-JSON-like object | null. */
const DEMO = (() => {
  'use strict';
  const SPEED = 4;                       // game clock runs 4x real time
  // test harness: '#seedN' in the URL plays a different set of games (default seed keeps the curated slate)
  const SEED = (typeof location !== 'undefined' && (String(location.hash).match(/seed(\d+)/) || [])[1]) || '';
  const BREAK_MS = 20000, HALF_MS = 45000; // real ms between quarters / at half
  const ESPN_LAG = 3000;                 // ESPN reflects state ~3s older than NBA CDN
  const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const MONTH = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MON_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DOW = { Sun: 'Sun', Mon: 'Mon', Tue: 'Tue', Wed: 'Wed', Thu: 'Thu', Fri: 'Fri', Sat: 'Sat' };

  /* ---------------- PRNG, hashing, math ---------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fnv(str) {
    let h = 0x811c9dc5; str = String(str);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  const hf = (s) => fnv(s) / 4294967296;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const r2 = (x) => Math.round(x * 100) / 100;
  const usd = (x) => (Math.round(x * 10000) / 10000).toFixed(4);
  function Phi(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function poisson(r, lam) {
    if (lam <= 0) return 0;
    if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss(r)));
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= r(); } while (p > L);
    return k - 1;
  }
  function pickW(r, idxs, wfn) {
    let tot = 0; const w = idxs.map((i) => { const x = Math.max(0.001, wfn(i)); tot += x; return x; });
    let u = r() * tot;
    for (let j = 0; j < idxs.length; j++) { u -= w[j]; if (u <= 0) return idxs[j]; }
    return idxs[idxs.length - 1];
  }

  /* ---------------- Eastern-time helpers ---------------- */
  const ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short' });
  function et(ms) {
    const o = {}; for (const p of ETF.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, wd: DOW[o.weekday] || o.weekday };
  }
  function etOffMin(ms) { const p = et(ms); return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60000) * 60000) / 60000); }
  function etToMs(y, m, d, h, mi) { const g = Date.UTC(y, m - 1, d, h, mi); const r1 = g - etOffMin(g) * 60000; return g - etOffMin(r1) * 60000; }
  function tzAbbr(ms) {
    try { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName'); return p ? p.value : 'ET'; } catch (e) { return 'ET'; }
  }
  const ymd = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  const ordD = (d) => d + ((d % 100 >= 11 && d % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th'));
  const isoMin = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';
  const isoSec = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  function hm12(p) { const h = p.h % 12 || 12; return `${h}:${pad(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`; }

  /* ---------------- Teams (real) ---------------- */
  const T = {}; const ALL = [];
  [
    ['ATL', 1, 'ATL', 'Atlanta', 'Hawks', 'c8102e', 'fdb927', 'State Farm Arena', 'Atlanta', 'GA', 1610612737, 'E'],
    ['BOS', 2, 'BOS', 'Boston', 'Celtics', '008348', 'ffffff', 'TD Garden', 'Boston', 'MA', 1610612738, 'E'],
    ['NO', 3, 'NOP', 'New Orleans', 'Pelicans', '0a2240', 'b4975a', 'Smoothie King Center', 'New Orleans', 'LA', 1610612740, 'W'],
    ['CHI', 4, 'CHI', 'Chicago', 'Bulls', 'ce1141', '000000', 'United Center', 'Chicago', 'IL', 1610612741, 'E'],
    ['CLE', 5, 'CLE', 'Cleveland', 'Cavaliers', '860038', 'bc945c', 'Rocket Arena', 'Cleveland', 'OH', 1610612739, 'E'],
    ['DAL', 6, 'DAL', 'Dallas', 'Mavericks', '0064b1', 'bbc4ca', 'American Airlines Center', 'Dallas', 'TX', 1610612742, 'W'],
    ['DEN', 7, 'DEN', 'Denver', 'Nuggets', '0e2240', 'fec524', 'Ball Arena', 'Denver', 'CO', 1610612743, 'W'],
    ['DET', 8, 'DET', 'Detroit', 'Pistons', '1d428a', 'c8102e', 'Little Caesars Arena', 'Detroit', 'MI', 1610612765, 'E'],
    ['GS', 9, 'GSW', 'Golden State', 'Warriors', '1d428a', 'fdb927', 'Chase Center', 'San Francisco', 'CA', 1610612744, 'W'],
    ['HOU', 10, 'HOU', 'Houston', 'Rockets', 'ce1141', '000000', 'Toyota Center', 'Houston', 'TX', 1610612745, 'W'],
    ['IND', 11, 'IND', 'Indiana', 'Pacers', '002d62', 'fdbb30', 'Gainbridge Fieldhouse', 'Indianapolis', 'IN', 1610612754, 'E'],
    ['LAC', 12, 'LAC', 'LA', 'Clippers', '12173f', 'c8102e', 'Intuit Dome', 'Inglewood', 'CA', 1610612746, 'W'],
    ['LAL', 13, 'LAL', 'Los Angeles', 'Lakers', '552583', 'fdb927', 'Crypto.com Arena', 'Los Angeles', 'CA', 1610612747, 'W'],
    ['MIA', 14, 'MIA', 'Miami', 'Heat', '98002e', '000000', 'Kaseya Center', 'Miami', 'FL', 1610612748, 'E'],
    ['MIL', 15, 'MIL', 'Milwaukee', 'Bucks', '00471b', 'eee1c6', 'Fiserv Forum', 'Milwaukee', 'WI', 1610612749, 'E'],
    ['MIN', 16, 'MIN', 'Minnesota', 'Timberwolves', '266092', '79bc43', 'Target Center', 'Minneapolis', 'MN', 1610612750, 'W'],
    ['BKN', 17, 'BKN', 'Brooklyn', 'Nets', '000000', 'ffffff', 'Barclays Center', 'Brooklyn', 'NY', 1610612751, 'E'],
    ['NY', 18, 'NYK', 'New York', 'Knicks', '1d428a', 'f58426', 'Madison Square Garden', 'New York', 'NY', 1610612752, 'E'],
    ['ORL', 19, 'ORL', 'Orlando', 'Magic', '0077c0', 'c4ced4', 'Kia Center', 'Orlando', 'FL', 1610612753, 'E'],
    ['PHI', 20, 'PHI', 'Philadelphia', '76ers', '1d428a', 'e01234', 'Xfinity Mobile Arena', 'Philadelphia', 'PA', 1610612755, 'E'],
    ['PHX', 21, 'PHX', 'Phoenix', 'Suns', '29127a', 'e56020', 'Mortgage Matchup Center', 'Phoenix', 'AZ', 1610612756, 'W'],
    ['POR', 22, 'POR', 'Portland', 'Trail Blazers', 'e03a3e', '000000', 'Moda Center', 'Portland', 'OR', 1610612757, 'W'],
    ['SAC', 23, 'SAC', 'Sacramento', 'Kings', '5a2d81', '63727a', 'Golden 1 Center', 'Sacramento', 'CA', 1610612758, 'W'],
    ['SA', 24, 'SAS', 'San Antonio', 'Spurs', 'c4ced4', '000000', 'Frost Bank Center', 'San Antonio', 'TX', 1610612759, 'W'],
    ['OKC', 25, 'OKC', 'Oklahoma City', 'Thunder', '007ac1', 'ef3b24', 'Paycom Center', 'Oklahoma City', 'OK', 1610612760, 'W'],
    ['UTAH', 26, 'UTA', 'Utah', 'Jazz', '4e008e', '79a3dc', 'Delta Center', 'Salt Lake City', 'UT', 1610612762, 'W'],
    ['WSH', 27, 'WAS', 'Washington', 'Wizards', '002b5c', 'e31837', 'Capital One Arena', 'Washington', 'DC', 1610612764, 'E'],
    ['TOR', 28, 'TOR', 'Toronto', 'Raptors', 'd91244', '000000', 'Scotiabank Arena', 'Toronto', 'ON', 1610612761, 'E'],
    ['MEM', 29, 'MEM', 'Memphis', 'Grizzlies', '5d76a9', '12173f', 'FedExForum', 'Memphis', 'TN', 1610612763, 'W'],
    ['CHA', 30, 'CHA', 'Charlotte', 'Hornets', '008ca8', '1d1160', 'Spectrum Center', 'Charlotte', 'NC', 1610612766, 'E'],
  ].forEach((r) => {
    const t = { abbr: r[0], id: String(r[1]), code: r[2], location: r[3], name: r[4], color: r[5], alt: r[6], arena: r[7], city: r[8], state: r[9], nbaId: r[10], conf: r[11] };
    t.displayName = `${t.location} ${t.name}`;
    t.kname = t.abbr === 'LAL' ? 'Los Angeles L' : t.abbr === 'LAC' ? 'Los Angeles C' : t.location;
    t.off = (hf(t.abbr + 'off') - 0.5) * 12; t.def = (hf(t.abbr + 'def') - 0.5) * 12;
    t.logo = `https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/${t.abbr.toLowerCase()}.png`;
    T[t.abbr] = t; ALL.push(t.abbr);
  });
  const teamRef = (t) => ({ id: t.id, abbreviation: t.abbr, displayName: t.displayName });

  /* ---------------- Fictional players ---------------- */
  const FIRST = ['Darnell', 'Malik', 'Andre', 'Corey', 'Devin', 'Elijah', 'Grant', 'Isaiah', 'Jamal', 'Keon', 'Landon', 'Mason', 'Nate', 'Omar', 'Quentin', 'Reggie', 'Silas', 'Trey', 'Victor', 'Wes', 'Bryce', 'Cam', 'Dante', 'Emmett', 'Felix', 'Gideon', 'Hollis', 'Ivan', 'Jasper', 'Kendrick', 'Luca', 'Miles', 'Niko', 'Otis', 'Percy', 'Rhett', 'Soren', 'Tariq', 'Vaughn', 'Desmond'];
  const LAST = ['Price', 'Hale', 'Whitfield', 'Bramble', 'Castellan', 'Dorsey', 'Pruitt', 'Merriweather', 'Albright', 'Kincaid', 'Vossberg', 'Lindqvist', 'Ashworth', 'Fairbanks', 'Quarles', 'Ridley', 'Sandoval', 'Underhill', 'Wexler', 'Yarbrough', 'Abernathy', 'Blackwood', 'Calloway', 'Delacroix', 'Ellsworth', 'Fontaine', 'Garrity', 'Holloway', 'Jessup', 'Kilgore', 'Mbatha', 'Nwosu', 'Okonkwo', 'Pemberton', 'Radcliffe', 'Stroud', 'Thibodeaux', 'Upshaw', 'Valcourt', 'Whitlock', 'Haddad', 'Ferreira', 'Kowalczyk', 'Marchetti', 'Duvall', 'Stanton', 'Brightwater', 'Cordero', 'Ashby', 'Hargrove', 'Ivers', 'Juarez', 'Keane', 'Larkin', 'Mosley', 'Navarro', 'Oduya', 'Rutledge', 'Sayer', 'Trask', 'Vickers', 'Whitaker'];
  const POS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG', 'SF', 'PF', 'C'];
  const POS_ESPN = { PG: 'G', SG: 'G', SF: 'F', PF: 'F', C: 'C' };
  const INJ = { NY: [[2, 'Out', 'Knee', 'Soreness']], DAL: [[1, 'Out', 'Ankle', 'Sprain']], GS: [[0, 'Questionable', 'Hamstring', 'Tightness']] };
  const usedNames = new Set();

  function players(abbr) {
    const t = T[abbr];
    if (t.players) return t.players;
    const r = mulberry32(fnv('roster' + abbr));
    const star = Math.floor(r() * 3);
    const ps = [];
    const jerseys = new Set();
    for (let i = 0; i < 9; i++) {
      let name, guard = 0;
      do { name = FIRST[Math.floor(r() * FIRST.length)] + ' ' + LAST[Math.floor(r() * LAST.length)]; } while (usedNames.has(name) && guard++ < 200);
      usedNames.add(name);
      let j; do { j = Math.floor(r() * 56); } while (jerseys.has(j)); jerseys.add(j);
      const pos = POS[i], starter = i < 5, isStar = i === star;
      const v = () => 0.85 + r() * 0.3;
      const pts = isStar ? 24 + r() * 5 : starter ? 13 + r() * 6 : 11 + r() * 6;
      const reb = { PG: 4.5, SG: 5, SF: 6.5, PF: 9, C: 12 }[pos] * v();
      const ast = ({ PG: 7.5, SG: 4.2, SF: 3.5, PF: 2.8, C: 2.6 }[pos] + (isStar ? 1.5 : 0)) * v();
      const fg3 = Math.max(0.1, { PG: 2.6, SG: 3.0, SF: 2.2, PF: 1.4, C: 0.5 }[pos] * v() + (isStar ? 0.5 : 0));
      const stl = 1.0 + r() * 0.6, blk = Math.max(0.15, { C: 1.8, PF: 1.0 }[pos] * v() || 0.4 * v());
      const tov = 1.2 + pts * 0.05 + ast * 0.15;
      const min = isStar ? 35 + r() * 2 : starter ? 30 + r() * 5 : 14 + r() * 10;
      const parts = name.split(' ');
      const id = String(9000000 + Number(t.id) * 100 + i);
      const form = hf(id + 'form') < 0.25 ? 1.12 : hf(id + 'form') < 0.4 ? 0.88 : 1.0;
      const prevMult = 0.96 + 0.08 * hf(id + 'prev');
      const tonightBase = 0.3 * form + 0.7 * prevMult;
      ps.push({
        i, id, personId: 1700000 + Number(t.id) * 100 + i, name, first: parts[0], last: parts[1],
        short: `${parts[0][0]}. ${parts[1]}`, jersey: String(j), pos, starter, star: isStar,
        r: { pts, reb, ast, fg3, stl, blk, tov }, min, ft: 0.7 + r() * 0.2, eff: 0.94 + r() * 0.12,
        form, h2h: 0.9 + 0.25 * hf(id + 'h2h'), prevMult, tonightBase, tonight: tonightBase, inj: null, team: abbr,
      });
    }
    // normalise minutes to 240 total
    const tot = ps.reduce((s, p) => s + p.min, 0);
    const benchScale = (240 - ps.slice(0, 5).reduce((s, p) => s + p.min, 0)) / ps.slice(5).reduce((s, p) => s + p.min, 0);
    if (tot !== 240) ps.slice(5).forEach((p) => { p.min = clamp(p.min * benchScale, 8, 30); });
    (INJ[abbr] || []).forEach(([idx, status, type, detail]) => { ps[idx].inj = { status, type, detail, miss: 2 + Math.floor(hf(ps[idx].id + 'miss') * 3) }; });
    t.players = ps;
    return ps;
  }
  const isOut = (p) => p.inj && p.inj.status === 'Out';
  function targets(abbr) { // tonight's minute targets normalised over available players
    const ps = players(abbr), av = ps.filter((p) => !isOut(p));
    const tot = av.reduce((s, p) => s + p.min, 0);
    return ps.map((p) => isOut(p) ? 0 : clamp(p.min * 240 / tot, 0, 40));
  }

  /* ---------------- Global state ---------------- */
  let S = null;
  let lastError = null;
  function init() {
    const now = Date.now();
    const tp = et(now);
    const tmr = et(Date.UTC(tp.y, tp.m - 1, tp.d + 1, 17));
    S = { startedAt: now, today: { y: tp.y, m: tp.m, d: tp.d }, tomorrow: { y: tmr.y, m: tmr.m, d: tmr.d }, games: [], byEspn: {}, byNba: {}, byEvent: {}, tonightOpp: {}, sched: {}, logs: new Map(), qcache: new Map() };
    const roundMin = (ms) => Math.round(ms / 60000) * 60000;
    const roundHalfHour = (ms) => Math.round(ms / 1800000) * 1800000;
    const todayDefs = [
      ['BOS', 'NY', now - 300e3, 4.5, 224.5],
      ['LAL', 'GS', now - 70e3, 3, 228.5],
      ['MIA', 'CHI', now - 700e3, 1.5, 218.5, 's22'], // salt picked so the game is close (91-90) entering Q4 7:00
      ['DEN', 'PHX', roundMin(now + 25 * 60e3), 2, 231.5],
      ['OKC', 'DAL', roundHalfHour(now + 120 * 60e3), -6.5, 226.5],
      ['MIL', 'SA', roundHalfHour(now + 180 * 60e3), 1, 230.5],
      ['CLE', 'ORL', now - 180 * 60e3, 3, 219.5],
    ];
    const tm = S.tomorrow;
    const tmrDefs = [
      ['PHI', 'TOR', etToMs(tm.y, tm.m, tm.d, 19, 0), 2.5, 222.5],
      ['ATL', 'IND', etToMs(tm.y, tm.m, tm.d, 19, 30), 3.5, 233.5],
      ['MIN', 'MEM', etToMs(tm.y, tm.m, tm.d, 20, 0), -4, 226.5],
      ['SAC', 'POR', etToMs(tm.y, tm.m, tm.d, 22, 0), -1.5, 229.5],
    ];
    ALL.forEach(players); // fixed creation order keeps fictional names deterministic
    todayDefs.forEach((d, i) => addGame(i + 1, d, S.today, true));
    tmrDefs.forEach((d, i) => addGame(i + 11, d, S.tomorrow, false));
  }
  function addGame(n, [aw, hm, tip, spreadHome, total, salt], day, isToday) {
    const g = {
      n, espnId: '4018100' + pad(n), nbaId: '00226001' + pad(n), away: T[aw], home: T[hm], tipReal: tip,
      spreadHome, total, day, isToday, dcode: `${String(day.y).slice(2)}${MON[day.m - 1]}${pad(day.d)}`,
      rng: mulberry32(fnv('game' + n + aw + hm + (salt || '') + SEED)), seq: 0, ev: [], snaps: [], on: { home: [], away: [] }, starters: { home: [], away: [] },
    };
    g.sim = { phase: 'pre', period: 0, pclock: 720, cursor: tip, home: 0, away: 0, ls: { home: [], away: [] }, poss: 'home', pendingD: null, breakUntil: 0, elapsed: 0 };
    g.box = { home: players(hm).map(blankBox), away: players(aw).map(blankBox) };
    g.tgt = { home: targets(hm), away: targets(aw) };
    // tonight's head-to-head form (also visible in the game logs vs this opponent)
    for (const side of ['home', 'away']) for (const p of players(g[side].abbr)) p.tonight = p.tonightBase * (1 + 0.3 * (p.h2h - 1));
    g.W = { home: players(hm).map((p) => weightsFor(p, p.tonight)), away: players(aw).map((p) => weightsFor(p, p.tonight)) };
    g.info = { home: sideInfo(players(hm), g.W.home, g.tgt.home), away: sideInfo(players(aw), g.W.away, g.tgt.away) };
    // scoring calibration: expected ppp of each side (incl. its shooters' efficiency) matches the line
    const calib = (diffPerPoss) => {
      const tot = total / POSS_PER_SIDE_GAME;
      g.k = { home: kSolve((tot + diffPerPoss) / 2) / g.info.home.ebar, away: kSolve((tot - diffPerPoss) / 2) / g.info.away.ebar };
      g.gm = null;
    };
    calib(spreadHome / POSS_PER_SIDE_GAME);
    for (let it = 0; it < 2; it++) { // the rubber band shrinks the drift by f1 = (1 - e^-x)/x
      const x = gameModel(g).theta * POSS_PER_SIDE_GAME, f1 = x > 1e-6 ? (1 - Math.exp(-x)) / x : 1;
      calib(spreadHome / (POSS_PER_SIDE_GAME * f1));
    }
    if (!g.anchored) { // anchor player rates to log evidence, then recalibrate team scoring to the line
      g.anchored = true;
      const Wh = anchorSide(g, 'home'), Wa = anchorSide(g, 'away');
      g.W = { home: Wh, away: Wa };
      g.info = { home: sideInfo(players(hm), Wh, g.tgt.home), away: sideInfo(players(aw), Wa, g.tgt.away) };
      calib(spreadHome / POSS_PER_SIDE_GAME);
      for (let it = 0; it < 2; it++) { const x = gameModel(g).theta * POSS_PER_SIDE_GAME, f1 = x > 1e-6 ? (1 - Math.exp(-x)) / x : 1; calib(spreadHome / (POSS_PER_SIDE_GAME * f1)); }
    }
    // per-minute production of every player tonight (same model the sim realises, used for prop pricing)
    g.rt = {
      home: teamRates(players(hm), g.info.home, g.k.home, g.k.away * g.info.away.ebar),
      away: teamRates(players(aw), g.info.away, g.k.away, g.k.home * g.info.home.ebar),
    };
    S.games.push(g); S.byEspn[g.espnId] = g; S.byNba[g.nbaId] = g;
    if (!S.tonightOpp[aw]) S.tonightOpp[aw] = hm;
    if (!S.tonightOpp[hm]) S.tonightOpp[hm] = aw;
    return g;
  }
  /* ---------------- Possession model (shared by sim, pricing and game logs) ---------------- */
  const SEC_PER_POSS = 14, POSS_PER_PERIOD = 720 / 14 + 0.527;          // renewal count + final clamped possession
  const POSS_PER_SIDE_GAME = POSS_PER_PERIOD * 4 / 2;                     // ~103.9
  const POSS_PER_MIN_SIDE = POSS_PER_PERIOD / 12 / 2;                     // ~2.165 per game minute per side
  const C_RB = 0.0035;                                                    // score-effects rubber band (per point of lead)
  const CHAIN = [{ f3: 0.395, p2: 0.52 }, { f3: 0.12, p2: 0.58 }, { f3: 0.12, p2: 0.58 }];
  function chain(k) { // expected attempts at each step of the shot/putback chain; k includes team shooting efficiency
    const out = []; let N = 0.76;
    for (const c of CHAIN) { const miss = c.f3 * (1 - 0.355 * k) + (1 - c.f3) * (1 - c.p2 * k); out.push({ N, f3: c.f3, p2b: c.p2, miss }); N *= miss * 0.26; }
    return out;
  }
  function possMoments(k) { // mean / variance of points on one possession
    const ch = chain(k); let m1 = 0, m2 = 0;
    for (let a = 2; a >= 0; a--) {
      const c = CHAIN[a], p3 = 0.355 * k, p2 = c.p2 * k, cont = ch[a].miss * 0.26;
      const e1 = c.f3 * p3 * 3 + (1 - c.f3) * p2 * 2.04 + cont * m1;
      const e2 = c.f3 * p3 * 9 + (1 - c.f3) * p2 * 4.2 + cont * m2;
      m1 = e1; m2 = e2;
    }
    const mean = 0.11 * 1.664 + 0.76 * m1;
    return { mean, v: 0.11 * 3.149 + 0.76 * m2 - mean * mean };
  }
  const expPPP = (k) => possMoments(k).mean;
  const kCache = new Map();
  function kSolve(ppp) {
    const key = Math.round(ppp * 2000);
    if (kCache.has(key)) return kCache.get(key);
    let lo = 0.4, hi = 1.8;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (expPPP(mid) < ppp) lo = mid; else hi = mid; }
    kCache.set(key, (lo + hi) / 2);
    return (lo + hi) / 2;
  }
  const isBig = (p) => p.pos === 'C' || p.pos === 'PF';
  const ADJ1 = { m2: 1, m3: 1, ftm: 1, reb: 1, ast: 1 };
  function weightsFor(p, m, adj = ADJ1) { // selection weights used by the possession sim
    return { w2: Math.max(1, p.r.pts - 2.4 * p.r.fg3) * m * adj.m2, w3: (p.r.fg3 + 0.05) * m * adj.m3, wf: p.r.pts * m * adj.ftm, wa: p.r.ast * m * adj.ast,
      wor: p.r.reb * (isBig(p) ? 1.6 : 0.7) * adj.reb, wdr: p.r.reb * adj.reb };
  }
  // Tonight's production is anchored to the player's own visible evidence: realised / expected in his game logs
  // (current season weighted 2x, prior 1x, lightly shrunk). Keeps market truth consistent with what a reader of the logs sees.
  function dataAdj(p) {
    if (p.adj) return p.adj;
    const acc = { m2: [0, 0], m3: [0, 0], ftm: [0, 0], reb: [0, 0], ast: [0, 0] };
    for (const [season, w] of [[2027, 2], [2026, 1]]) for (const x of gameLines(p, season)) {
      acc.m2[0] += w * (x.fgm - x.fg3m); acc.m2[1] += w * x.ex.m2; acc.m3[0] += w * x.fg3m; acc.m3[1] += w * x.ex.m3;
      acc.ftm[0] += w * x.ftm; acc.ftm[1] += w * x.ex.ftm; acc.reb[0] += w * x.reb; acc.reb[1] += w * x.ex.reb; acc.ast[0] += w * x.ast; acc.ast[1] += w * x.ex.ast;
    }
    const K = 4, o = {};
    for (const k of Object.keys(acc)) o[k] = clamp((acc[k][0] + K) / (acc[k][1] + K), 0.6, 1.6);
    p.adj = o;
    return o;
  }
  // Solve each team's selection-weight multipliers so every player's tonight rate = process expectation x his log evidence
  // (normalised so team totals stay where the line puts them).
  const ADJ_KEYS = ['m2', 'm3', 'ftm', 'reb', 'ast'];
  function anchorSide(g, side) {
    const ps = players(g[side].abbr), mins = g.tgt[side], osd = other(side);
    const kOpp = g.k[osd] * g.info[osd].ebar;
    const rt0 = teamRates(ps, g.info[side], g.k[side], kOpp);
    const tgt = ps.map((p, i) => { const r = dataAdj(p), o = {}; for (const k of ADJ_KEYS) o[k] = rt0[i][k] * r[k]; return o; });
    for (const k of ADJ_KEYS) {
      let a = 0, b = 0; ps.forEach((p, i) => { a += rt0[i][k] * mins[i]; b += tgt[i][k] * mins[i]; });
      if (b > 0) tgt.forEach((t) => { t[k] *= a / b; });
    }
    const adj = ps.map((p) => Object.assign({}, dataAdj(p)));
    for (let it = 0; it < 6; it++) {
      const W = ps.map((p, i) => weightsFor(p, p.tonight, adj[i])), info = sideInfo(ps, W, mins), rt = teamRates(ps, info, g.k[side], kOpp);
      ps.forEach((p, i) => { if (!mins[i]) return; for (const k of ADJ_KEYS) if (rt[i][k] > 1e-9 && tgt[i][k] > 1e-9) adj[i][k] = clamp(adj[i][k] * tgt[i][k] / rt[i][k], 0.3, 3); });
    }
    return ps.map((p, i) => weightsFor(p, p.tonight, adj[i]));
  }
  // E[w_i / (w_i + sum of teammates' weights on the floor) | i on the floor], 2nd-order (Jensen) corrected:
  // teammates j fill (pool-1) slots with prob pi_j; the sum's variance is taken conditional on exactly pool-1 of them.
  function shareVec(W, mins, key, pool) {
    return W.map((w, i) => {
      if (!mins[i]) return 0;
      let mo = 0; for (let j = 0; j < W.length; j++) if (j !== i) mo += mins[j];
      let mu = 0, v1 = 0, c1 = 0, q1 = 0;
      for (let j = 0; j < W.length; j++) {
        if (j === i || !mins[j]) continue;
        const pi = Math.min(0.995, (pool - 1) * mins[j] / mo), wj = W[j][key];
        mu += wj * pi; v1 += wj * wj * pi * (1 - pi); c1 += wj * pi * (1 - pi); q1 += pi * (1 - pi);
      }
      const V = Math.max(0, v1 - (q1 > 0 ? c1 * c1 / q1 : 0)), a = w[key] + mu;
      return w[key] / a + w[key] * V / (a * a * a);
    });
  }
  function sideInfo(ps, W, mins) {
    const o = { mins, s2: shareVec(W, mins, 'w2', 5), s3: shareVec(W, mins, 'w3', 5), sf: shareVec(W, mins, 'wf', 5), sor: shareVec(W, mins, 'wor', 5), sdr: shareVec(W, mins, 'wdr', 5), sa: shareVec(W, mins, 'wa', 4) };
    let num = 0, den = 0;
    for (let i = 0; i < ps.length; i++) { const sh = mins[i] / 48 * (0.4 * o.s3[i] + 0.6 * o.s2[i]); num += sh * ps[i].eff; den += sh; }
    o.ebar = den ? num / den : 1;
    return o;
  }
  // per-game-minute expected production of each player while on the floor; kOff raw (pre-efficiency), kDefEff = opponent k*ebar
  function teamRates(ps, info, kOff, kDefEff) {
    const ch = chain(kOff * info.ebar), chD = chain(kDefEff);
    let A3 = 0, A2 = 0, M2b = 0, MISS = 0, MISSd = 0;
    for (const c of ch) { A3 += c.N * c.f3; A2 += c.N * (1 - c.f3); M2b += c.N * (1 - c.f3) * c.p2b; MISS += c.N * c.miss; }
    for (const c of chD) MISSd += c.N * c.miss;
    const P = POSS_PER_MIN_SIDE, ko = kOff * info.ebar;
    const astTeam = 0.76 * (CHAIN[0].f3 * 0.355 * ko * 0.85 + (1 - CHAIN[0].f3) * 0.52 * ko * 0.55);
    return ps.map((p, i) => {
      if (!info.mins[i]) return { m2: 0, m3: 0, ftm: 0, a2: 0, a3: 0, fta: 0, reb: 0, ast: 0 };
      const m3 = A3 * info.s3[i] * 0.355 * kOff * p.eff, m2 = M2b * info.s2[i] * kOff * p.eff;
      const fta = 0.11 * info.sf[i] * 2.08 + m2 * 0.05;
      const shooter0 = CHAIN[0].f3 * info.s3[i] + (1 - CHAIN[0].f3) * info.s2[i];
      return { m2: m2 * P, m3: m3 * P, ftm: fta * p.ft * P, a3: A3 * info.s3[i] * P, a2: A2 * info.s2[i] * P, fta: fta * P,
        reb: ((MISS * 0.26 + 0.022 * 0.15) * info.sor[i] + (MISSd * 0.74 + 0.022 * 0.85) * info.sdr[i]) * P,
        ast: astTeam * (1 - shooter0) * info.sa[i] * P };
    });
  }
  function poisArr(lam, n) { const a = new Array(Math.max(1, n)).fill(0); let q = Math.exp(-lam); for (let i = 0; i < a.length; i++) { a[i] = q; q *= lam / (i + 1); } return a; }
  function poisTail(c, lam, thr) { // P(c + Pois(lam) >= thr)
    const need = thr - c; if (need <= 0) return 1; if (lam <= 1e-9) return 0;
    const a = poisArr(lam, need); let cdf = 0; for (let i = 0; i < need; i++) cdf += a[i];
    return clamp(1 - cdf, 0, 1);
  }
  function ptsTail(c, l2, l3, l1, thr) { // P(c + 2A + 3B + C >= thr), A,B,C Poisson
    const N = thr - c; if (N <= 0) return 1;
    const pc = poisArr(l1, N), pa = poisArr(l2, Math.ceil(N / 2) + 1), pb = poisArr(l3, Math.ceil(N / 3) + 1);
    const S1 = new Array(N).fill(0);
    for (let a = 0; 2 * a < N; a++) for (let x = 0; x + 2 * a < N; x++) S1[x + 2 * a] += pa[a] * pc[x];
    let cdf = 0;
    for (let b = 0; 3 * b < N; b++) for (let x = 0; x + 3 * b < N; x++) cdf += pb[b] * S1[x];
    return clamp(1 - cdf, 0, 1);
  }
  const blankBox = () => ({ min: 0, pts: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, pm: 0 });
  function ensure() { if (!S) init(); }

  /* ---------------- Game simulation ---------------- */
  const other = (s) => (s === 'home' ? 'away' : 'home');
  const plen = (p) => (p <= 4 ? 720 : 300);
  function remMin(period, pclock, phase) {
    if (phase === 'pre') return 48;
    if (phase === 'final') return 0;
    if (phase === 'break' || phase === 'half') return period < 4 ? (4 - period) * 12 : 5;
    return period <= 4 ? (4 - period) * 12 + pclock / 60 : pclock / 60;
  }
  function gameModel(g) {
    if (g.gm) return g.gm;
    const o = {};
    for (const side of ['home', 'away']) {
      const ke = g.k[side] * g.info[side].ebar, m = possMoments(ke), m2 = possMoments(ke * 1.01);
      o[side] = { mu: m.mean, v: m.v, beta: (m2.mean - m.mean) / 0.01 };
    }
    o.theta = C_RB * (o.home.beta + o.away.beta);
    g.gm = o;
    return o;
  }
  function possLeft(st) { // expected remaining possessions (both teams) in regulation/current OT
    if (st.phase === 'pre') return POSS_PER_PERIOD * 4;
    if (st.phase === 'final') return 0;
    if (st.phase === 'break' || st.phase === 'half') return st.period < 4 ? POSS_PER_PERIOD * (4 - st.period) : 300 / SEC_PER_POSS + 0.527;
    const cur = st.pclock / SEC_PER_POSS + 0.5;
    return st.period < 4 ? cur + POSS_PER_PERIOD * (4 - st.period) : cur;
  }
  function marginDist(g, M, n, delta) { // final margin (home-away) ~ N(mean, sd): OU process from the rubber band
    const gm = gameModel(g);
    const nh = Math.max(0, n / 2 + 0.25 * delta), na = Math.max(0, n / 2 - 0.25 * delta);
    const x = gm.theta * (nh + na) / 2, dec = Math.exp(-x);
    const f1 = x > 1e-6 ? (1 - dec) / x : 1, f2 = x > 1e-6 ? (1 - Math.exp(-2 * x)) / (2 * x) : 1;
    return { mean: M * dec + (nh * gm.home.mu - na * gm.away.mu) * f1, sd: Math.sqrt(Math.max(1e-4, (nh * gm.home.v + na * gm.away.v) * f2)), nh, na };
  }
  function otWinHome(g) {
    if (g.otw != null) return g.otw;
    const d = marginDist(g, 0, 300 / SEC_PER_POSS + 0.527, 0);
    const w = 1 - Phi((0.5 - d.mean) / d.sd), l = Phi((-0.5 - d.mean) / d.sd);
    g.otw = w / Math.max(1e-6, w + l);
    return g.otw;
  }
  const possDelta = (st) => (st.phase === 'live' && st.poss ? (st.poss === 'home' ? 1 : -1) : 0);
  function pHomeWin(g, st) {
    const M = st.home - st.away;
    if (st.phase === 'final') return M > 0 ? 1 : 0;
    const d = marginDist(g, M, possLeft(st), possDelta(st));
    const pw = 1 - Phi((0.5 - d.mean) / d.sd), pt = Phi((0.5 - d.mean) / d.sd) - Phi((-0.5 - d.mean) / d.sd);
    return clamp(pw + pt * otWinHome(g), 0, 1);
  }
  function simState(g) { const s = g.sim; return { phase: s.phase, period: s.period, pclock: s.pclock, home: s.home, away: s.away, poss: s.poss }; }
  function advance(g, now) {
    const s = g.sim;
    for (let guard = 0; guard < 20000; guard++) {
      if (s.phase === 'final') return;
      if (s.phase === 'pre') { if (now < g.tipReal) return; startPeriod(g, 1, g.tipReal); continue; }
      if (s.phase === 'break' || s.phase === 'half') { if (now < s.breakUntil) return; startPeriod(g, s.period + 1, s.breakUntil); continue; }
      if (s.pendingD == null) s.pendingD = 6 + g.rng() * 8 + g.rng() * 8;
      const d = Math.min(s.pendingD, s.pclock);
      const endReal = s.cursor + d / SPEED * 1000;
      if (endReal > now) return;
      s.pendingD = null;
      possession(g, d, endReal);
      if (s.pclock <= 0.0001) endPeriod(g, endReal);
    }
  }
  function startPeriod(g, p, real) {
    const s = g.sim;
    s.period = p; s.pclock = plen(p); s.phase = 'live'; s.cursor = real;
    s.ls.home[p - 1] = 0; s.ls.away[p - 1] = 0;
    setLineups(g, real, p === 1 || p === 3 || p === 5, p === 1);
    if (p === 1) {
      const w = g.rng() < 0.5 ? 'home' : 'away'; g.jump = w; s.poss = w;
      const hc = players(g.home.abbr)[g.on.home.slice().sort((a, b) => players(g.home.abbr)[b].r.reb - players(g.home.abbr)[a].r.reb)[0]];
      const ac = players(g.away.abbr)[g.on.away.slice().sort((a, b) => players(g.away.abbr)[b].r.reb - players(g.away.abbr)[a].r.reb)[0]];
      addEv(g, { real, side: w, type: 'jump', text: `${hc.name} vs. ${ac.name} (${g[w].name} gains possession)` });
    } else {
      s.poss = (p % 2 === 0) ? other(g.jump) : g.jump;
      addEv(g, { real, side: null, type: 'period', sub: 'start', text: `Start of the ${perName(p)}` });
    }
    snap(g, real);
  }
  function endPeriod(g, real) {
    const s = g.sim, p = s.period;
    if (p >= 4 && s.home !== s.away) { s.phase = 'final'; s.finalReal = real; }
    else if (p === 2) { s.phase = 'half'; s.breakUntil = real + HALF_MS; }
    else { s.phase = 'break'; s.breakUntil = real + BREAK_MS; }
    addEv(g, { real, side: null, type: 'period', sub: 'end', text: s.phase === 'final' ? 'End of Game' : `End of the ${perName(p)}` });
    snap(g, real);
  }
  const perName = (p) => p <= 4 ? `${ordD(p)} Quarter` : (p === 5 ? 'OT' : `${p - 4}OT`);
  function elapsedMin(g) { const s = g.sim; let e = 0; for (let p = 1; p < s.period; p++) e += plen(p) / 60; return e + (plen(s.period) - s.pclock) / 60; }
  function setLineups(g, real, starterPref, initial) {
    const s = g.sim, Eg = elapsedMin(g);
    for (const side of ['home', 'away']) {
      const ps = players(g[side].abbr), box = g.box[side], tgt = g.tgt[side];
      const margin = side === 'home' ? s.home - s.away : s.away - s.home;
      const av = ps.filter((p) => !isOut(p) && box[p.i].pf < 6).map((p) => p.i);
      const sc = {};
      for (const i of av) {
        let v = tgt[i] / 48 * (Eg + 3) - box[i].min;
        if (starterPref && ps[i].starter) v += 100;
        const pf = box[i].pf;
        if (s.period <= 3 && pf >= s.period + 2) v -= 100;
        if (s.period === 4 && pf >= 5 && s.pclock > 300) v -= 50;
        if (s.period >= 4 && Math.abs(margin) > 22 && ps[i].starter) v -= 60;
        if (s.period >= 4 && s.pclock < 360 && Math.abs(margin) <= 10) v += tgt[i] / 8; // closers
        sc[i] = v;
      }
      const next = av.slice().sort((a, b) => sc[b] - sc[a]).slice(0, 5);
      const prev = g.on[side];
      if (!initial) {
        const outs = prev.filter((i) => !next.includes(i)), ins = next.filter((i) => !prev.includes(i));
        for (let j = 0; j < Math.min(outs.length, ins.length); j++) {
          addEv(g, { real, side, type: 'sub', sub: 'in', p: ins[j], p2: outs[j], text: `${ps[ins[j]].name} enters the game for ${ps[outs[j]].name}` });
        }
      }
      g.on[side] = next;
      if (initial) g.starters[side] = next.slice();
    }
  }
  function score(g, side, pts) {
    const s = g.sim; s[side] += pts; s.ls[side][s.period - 1] += pts;
    for (const i of g.on[side]) g.box[side][i].pm += pts;
    for (const i of g.on[other(side)]) g.box[other(side)][i].pm -= pts;
  }
  function addEv(g, e) {
    const s = g.sim;
    e.n = ++g.seq; e.period = s.period; e.clock = s.pclock; e.home = s.home; e.away = s.away; e.poss = s.poss;
    e.wp = clamp(pHomeWin(g, simState(g)), 0.001, 0.999);
    g.ev.push(e);
    return e;
  }
  function snap(g, real) {
    const s = g.sim, pst = [];
    for (const side of ['home', 'away']) for (const b of g.box[side]) pst.push(b.pts, b.oreb + b.dreb, b.ast, b.fg3m, b.min, b.pf);
    g.snaps.push({ real, period: s.period, pclock: s.pclock, phase: s.phase, poss: s.poss, home: s.home, away: s.away, lsH: s.ls.home.slice(), lsA: s.ls.away.slice(), pst, evN: g.ev.length, breakUntil: s.breakUntil });
  }
  function shotLoc(r, g, side, is3, putback) {
    // home attacks right basket in 1st half, left in 2nd half (+OT follows 2nd half)
    const right = (side === 'home') === (g.sim.period <= 2);
    let dist, ang;
    if (is3) {
      ang = (r() * 2 - 1) * 85 * Math.PI / 180;
      dist = Math.abs(Math.sin(ang)) > 0.93 ? 22.2 + r() * 1.2 : 23.9 + r() * 3.2;
    } else {
      ang = (r() * 2 - 1) * 80 * Math.PI / 180;
      dist = putback ? r() * 3 : (r() < 0.45 ? r() * 4 : 4 + r() * 16);
    }
    const bx = right ? 94 - 5.25 : 5.25;
    const x = clamp(bx + (right ? -1 : 1) * dist * Math.cos(ang), 0.5, 93.5);
    const y = clamp(25 + dist * Math.sin(ang), 0.5, 49.5);
    return { x, y, dist: Math.max(0, Math.round(dist)) };
  }
  function possession(g, d, real) {
    const s = g.sim, r = g.rng;
    const prevClock = s.pclock;
    s.pclock = Math.max(0, s.pclock - d);
    for (const side of ['home', 'away']) for (const i of g.on[side]) g.box[side][i].min += d / 60;
    const offS = s.poss, defS = other(offS);
    const P = players(g[offS].abbr), D = players(g[defS].abbr), off = g.on[offS], def = g.on[defS];
    const lead = offS === 'home' ? s.home - s.away : s.away - s.home;
    const k = g.k[offS] * clamp(1 - C_RB * lead, 0.9, 1.1);
    const W = g.W[offS], WD = g.W[defS];
    const big = (pl) => (pl.pos === 'C' || pl.pos === 'PF' ? 1.4 : 1);
    if (r() < 0.06) foul(g, real, defS, pickW(r, def, (i) => big(D[i])), 'personal');
    const u = r();
    if (u < 0.13) {
      const t = pickW(r, off, (i) => P[i].r.tov);
      g.box[offS][t].tov++;
      let st = null;
      if (r() < 0.5) { st = pickW(r, def, (i) => D[i].r.stl); g.box[defS][st].stl++; }
      addEv(g, { real, side: offS, type: 'tov', p: t, sub: st != null ? 'bad pass' : 'lost ball', p2: st,
        text: st != null ? `${P[t].name} bad pass (${D[st].name} steals)` : `${P[t].name} lost ball turnover` });
      if (st != null) addEv(g, { real, side: defS, type: 'steal', p: st, nbaOnly: true, text: `${D[st].short} STEAL` });
    } else if (u < 0.24) {
      foul(g, real, defS, pickW(r, def, (i) => big(D[i])), 'shooting');
      const sh = pickW(r, off, (i) => W[i].wf);
      const n = r() < 0.08 ? 3 : 2;
      let lastMade = true;
      for (let j = 1; j <= n; j++) { lastMade = r() < P[sh].ft; freeThrow(g, real, offS, sh, j, n, lastMade); }
      if (!lastMade) {
        if (r() < 0.15) { const o = pickW(r, off, (i) => W[i].wor); g.box[offS][o].oreb++; addEv(g, { real, side: offS, type: 'reb', sub: 'offensive', p: o, text: `${P[o].name} offensive rebound` }); }
        else { const dr = pickW(r, def, (i) => WD[i].wdr); g.box[defS][dr].dreb++; addEv(g, { real, side: defS, type: 'reb', sub: 'defensive', p: dr, text: `${D[dr].name} defensive rebound` }); }
      }
    } else {
      for (let att = 0; att < 3; att++) {
        const is3 = att === 0 ? r() < 0.395 : r() < 0.12;
        const sh = pickW(r, off, (i) => (is3 ? W[i].w3 : W[i].w2));
        const made = r() < (is3 ? 0.355 : att > 0 ? 0.58 : 0.52) * k * P[sh].eff;
        const loc = shotLoc(r, g, offS, is3, att > 0);
        let ast = null, blk = null;
        if (made && att === 0 && r() < (is3 ? 0.85 : 0.55)) ast = pickW(r, off.filter((i) => i !== sh), (i) => W[i].wa);
        if (!made && !is3 && r() < 0.08) blk = pickW(r, def, (i) => D[i].r.blk + 0.1);
        const b = g.box[offS][sh];
        b.fga++; if (is3) b.fg3a++;
        if (made) { b.fgm++; b.pts += is3 ? 3 : 2; if (is3) b.fg3m++; score(g, offS, is3 ? 3 : 2); if (ast != null) g.box[offS][ast].ast++; }
        if (blk != null) g.box[defS][blk].blk++;
        const kind = is3 ? 'Three Point Jumper' : loc.dist <= 2 && r() < 0.35 ? 'Dunk Shot' : loc.dist <= 4 ? 'Driving Layup Shot' : (r() < 0.4 ? 'Pullup Jump Shot' : 'Jump Shot');
        const what = is3 ? `${loc.dist}-foot three point jumper` : kind === 'Dunk Shot' ? 'dunk' : kind === 'Driving Layup Shot' ? 'driving layup' : `${loc.dist}-foot ${kind === 'Pullup Jump Shot' ? 'pullup jump shot' : 'jumper'}`;
        let text = `${P[sh].name} ${made ? 'makes' : 'misses'} ${what}`;
        if (ast != null) text += ` (${P[ast].name} assists)`;
        if (blk != null) text = `${D[blk].name} blocks ${P[sh].name} 's ${what}`;
        addEv(g, { real, side: offS, type: 'shot', p: sh, p2: ast, is3, made, pts: made ? (is3 ? 3 : 2) : 0, x: loc.x, y: loc.y, dist: loc.dist, kind, text });
        if (blk != null) addEv(g, { real, side: defS, type: 'block', p: blk, nbaOnly: true, text: `${D[blk].short} BLOCK` });
        if (made) {
          if (!is3 && r() < 0.05) { foul(g, real, defS, pickW(r, def, (i) => big(D[i])), 'shooting'); freeThrow(g, real, offS, sh, 1, 1, r() < P[sh].ft); }
          break;
        }
        if (r() < 0.26) {
          const o = pickW(r, off, (i) => W[i].wor); g.box[offS][o].oreb++;
          addEv(g, { real, side: offS, type: 'reb', sub: 'offensive', p: o, text: `${P[o].name} offensive rebound` });
          continue;
        }
        const dr = pickW(r, def, (i) => WD[i].wdr); g.box[defS][dr].dreb++;
        addEv(g, { real, side: defS, type: 'reb', sub: 'defensive', p: dr, text: `${D[dr].name} defensive rebound` });
        break;
      }
    }
    s.poss = defS;
    if (r() < 0.025 && s.pclock > 30) addEv(g, { real, side: offS, type: 'timeout', text: `${g[offS].name} Full Timeout` });
    s.cursor = real;
    if (Math.floor(prevClock / 180) !== Math.floor(s.pclock / 180) && s.pclock > 20) setLineups(g, real, false, false);
    else {
      // foul-outs force an immediate substitution
      for (const side of ['home', 'away']) if (g.on[side].some((i) => g.box[side][i].pf >= 6)) { setLineups(g, real, false, false); break; }
    }
    snap(g, real);
  }
  function foul(g, real, side, i, kind) {
    const ps = players(g[side].abbr); g.box[side][i].pf++;
    addEv(g, { real, side, type: 'foul', sub: kind, p: i, text: `${ps[i].name} ${kind} foul` });
  }
  function freeThrow(g, real, side, i, j, n, made) {
    const ps = players(g[side].abbr), b = g.box[side][i];
    b.fta++; if (made) { b.ftm++; b.pts++; score(g, side, 1); }
    addEv(g, { real, side, type: 'ft', p: i, made, pts: made ? 1 : 0, j, nft: n, text: `${ps[i].name} ${made ? 'makes' : 'misses'} free throw ${j} of ${n}` });
  }

  /* ---------------- State at time t ---------------- */
  function stateAt(g, t, now) {
    advance(g, now);
    const sn = g.snaps;
    if (t < g.tipReal || !sn.length || sn[0].real > t) {
      return { phase: 'pre', period: 0, pclock: 720, home: 0, away: 0, lsH: [], lsA: [], pst: null, evN: 0, R: 48 };
    }
    let lo = 0, hi = sn.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sn[mid].real <= t) lo = mid; else hi = mid - 1; }
    const x = sn[lo];
    let pclock = x.pclock;
    if (x.phase === 'live') pclock = Math.max(0, x.pclock - (t - x.real) / 1000 * SPEED);
    const st = { phase: x.phase, period: x.period, pclock, poss: x.poss, home: x.home, away: x.away, lsH: x.lsH, lsA: x.lsA, pst: x.pst, evN: x.evN, breakUntil: x.breakUntil };
    st.R = remMin(st.period, st.pclock, st.phase);
    return st;
  }
  const pstat = (st, side, i, f) => (st.pst ? st.pst[((side === 'home' ? 0 : 9) + i) * 6 + f] : 0); // f: 0 pts,1 reb,2 ast,3 fg3m,4 min,5 pf
  const cstat = (st, side, i, f) => { const a = st.cst !== undefined ? st.cst : st.pst; return a ? a[((side === 'home' ? 0 : 9) + i) * 6 + f] : 0; }; // counting stats (possibly lagged view)

  /* ---------------- ESPN builders ---------------- */
  function fmtClock(sec) {
    if (sec >= 60) { const m = Math.floor(sec / 60), s = Math.floor(sec - m * 60); return `${m}:${pad(s)}`; }
    return (Math.floor(sec * 10) / 10).toFixed(1);
  }
  function espnStatus(g, st) {
    const tp = et(g.tipReal), tz = tzAbbr(g.tipReal);
    const ord = (p) => p <= 4 ? ordD(p) : (p === 5 ? 'OT' : `${p - 4}OT`);
    if (st.phase === 'pre') {
      return { clock: 0, displayClock: '0.0', period: 0, type: { id: '1', name: 'STATUS_SCHEDULED', state: 'pre', completed: false, description: 'Scheduled',
        detail: `${tp.wd}, ${MONTH[tp.m - 1]} ${ordD(tp.d)} at ${hm12(tp)} ${tz}`, shortDetail: `${tp.m}/${tp.d} - ${hm12(tp)} ${tz}` } };
    }
    if (st.phase === 'final') {
      const ot = st.period > 4 ? (st.period === 5 ? 'Final/OT' : `Final/${st.period - 4}OT`) : 'Final';
      return { clock: 0, displayClock: '0.0', period: st.period, type: { id: '3', name: 'STATUS_FINAL', state: 'post', completed: true, description: 'Final', detail: ot, shortDetail: ot } };
    }
    if (st.phase === 'half') return { clock: 0, displayClock: '0.0', period: 2, type: { id: '23', name: 'STATUS_HALFTIME', state: 'in', completed: false, description: 'Halftime', detail: 'Halftime', shortDetail: 'Halftime' } };
    if (st.phase === 'break') {
      const d = st.period <= 4 ? `End of ${ord(st.period)} Quarter` : `End of ${ord(st.period)}`;
      return { clock: 0, displayClock: '0.0', period: st.period, type: { id: '22', name: 'STATUS_END_PERIOD', state: 'in', completed: false, description: 'End of Period', detail: d, shortDetail: `End of ${ord(st.period)}` } };
    }
    const dc = fmtClock(st.pclock);
    return { clock: Math.round(st.pclock * 10) / 10, displayClock: dc, period: st.period, type: { id: '2', name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, description: 'In Progress',
      detail: st.period <= 4 ? `${dc} - ${ord(st.period)} Quarter` : `${dc} - ${ord(st.period)}`, shortDetail: `${dc} - ${ord(st.period)}` } };
  }
  function record(abbr) { const s = schedule(abbr).cur; const w = s.filter((x) => x.result === 'W').length; return { w, l: s.length - w, summary: `${w}-${s.length - w}` }; }
  function espnTeam(t) {
    return { id: t.id, abbreviation: t.abbr, displayName: t.displayName, shortDisplayName: t.name, name: t.name, location: t.location, color: t.color, alternateColor: t.alt, logo: t.logo };
  }
  function lines(g) {
    const s = g.spreadHome, fav = s >= 0 ? g.home : g.away, a = Math.abs(s);
    const pFav = Phi(a / 12);
    const ml = (p) => (p >= 0.5 ? -Math.round(100 * p / (1 - p) / 5) * 5 : Math.round(100 * (1 - p) / p / 5) * 5);
    const favML = ml(Math.min(0.97, pFav + 0.022)), dogML = ml(Math.max(0.03, 1 - pFav + 0.022));
    return {
      details: a < 0.25 ? 'EVEN' : `${fav.abbr} -${a}`, spread: -s, overUnder: g.total,
      homeML: s >= 0 ? favML : dogML, awayML: s >= 0 ? dogML : favML, homeFav: s >= 0,
    };
  }
  function espnOdds(g) {
    const L = lines(g);
    return [{ provider: { id: '58', name: 'DraftKings' }, details: L.details, overUnder: L.overUnder, spread: L.spread,
      homeTeamOdds: { favorite: L.homeFav, underdog: !L.homeFav, moneyLine: L.homeML }, awayTeamOdds: { favorite: !L.homeFav, underdog: L.homeFav, moneyLine: L.awayML } }];
  }
  function lastVisibleEv(g, st) {
    for (let i = st.evN - 1; i >= 0; i--) if (!g.ev[i].nbaOnly) return i;
    return -1;
  }
  function espnEvent(g, now) {
    const st = stateAt(g, now - ESPN_LAG, now);
    const status = espnStatus(g, st);
    const comp = (side) => {
      const t = g[side], c = { id: t.id, homeAway: side, team: espnTeam(t), score: String(side === 'home' ? st.home : st.away), records: [{ name: 'overall', abbreviation: 'Game', type: 'total', summary: record(t.abbr).summary }] };
      if (st.phase !== 'pre') c.linescores = (side === 'home' ? st.lsH : st.lsA).map((v, i) => ({ value: v, period: i + 1 }));
      if (st.phase === 'final') c.winner = side === 'home' ? st.home > st.away : st.away > st.home;
      return c;
    };
    const competition = {
      id: g.espnId, date: isoMin(g.tipReal), venue: { id: String(3000 + Number(g.home.id)), fullName: g.home.arena, address: { city: g.home.city, state: g.home.state } },
      competitors: [comp('home'), comp('away')], status, broadcasts: [{ market: 'national', names: [g.n % 2 ? 'ESPN' : 'NBA TV'] }], odds: espnOdds(g),
    };
    if (st.phase !== 'pre' && st.phase !== 'final') {
      const li = lastVisibleEv(g, st);
      if (li >= 0) {
        const e = g.ev[li];
        let pi = li - 1; while (pi >= 0 && g.ev[pi].nbaOnly) pi--;
        const pw = pi >= 0 ? g.ev[pi].wp : pHomeWin(g, { phase: 'pre', period: 0, pclock: 720, home: 0, away: 0 });
        const ath = e.p != null && e.side ? [players(g[e.side].abbr)[e.p]] : [];
        competition.situation = { lastPlay: { id: g.espnId + pad(e.n, 4), type: { id: String(espnTypeId(e)), text: espnTypeText(e) }, text: e.text, scoreValue: e.pts || 0,
          team: e.side ? { id: g[e.side].id } : undefined, probability: { tiePercentage: 0, homeWinPercentage: r3(pw), awayWinPercentage: r3(1 - pw) },
          athletesInvolved: ath.map((p) => ({ id: p.id, displayName: p.name, shortName: p.short, team: { id: g[e.side].id } })) } };
      }
    }
    return { id: g.espnId, uid: `s:40~l:46~e:${g.espnId}`, date: isoMin(g.tipReal), name: `${g.away.displayName} at ${g.home.displayName}`, shortName: `${g.away.abbr} @ ${g.home.abbr}`,
      season: { year: 2027, type: 2 }, status, competitions: [competition] };
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  function espnTypeText(e) {
    switch (e.type) {
      case 'shot': return e.kind;
      case 'ft': return `Free Throw - ${e.j} of ${e.nft}`;
      case 'reb': return e.sub === 'offensive' ? 'Offensive Rebound' : 'Defensive Rebound';
      case 'tov': return e.sub === 'bad pass' ? 'Bad Pass Turnover' : 'Lost Ball Turnover';
      case 'foul': return e.sub === 'shooting' ? 'Shooting Foul' : 'Personal Foul';
      case 'sub': return 'Substitution';
      case 'period': return e.sub === 'end' ? 'End Period' : 'Start Period';
      case 'jump': return 'Jumpball';
      case 'timeout': return 'Full Timeout';
      default: return e.type;
    }
  }
  const espnTypeId = (e) => ({ shot: 92, ft: 97, reb: 156, tov: 62, foul: 45, sub: 584, period: 412, jump: 615, timeout: 16 }[e.type] || 1);
  function espnPlay(g, e) {
    const pl = e.side && e.p != null ? players(g[e.side].abbr) : null;
    const parts = [];
    if (pl) parts.push({ athlete: { id: pl[e.p].id } });
    if (pl && e.p2 != null && (e.type === 'shot' || e.type === 'sub')) parts.push({ athlete: { id: pl[e.p2].id } });
    if (e.type === 'tov' && e.p2 != null) parts.push({ athlete: { id: players(g[other(e.side)].abbr)[e.p2].id } });
    const o = { id: g.espnId + pad(e.n, 4), sequenceNumber: String(e.n), type: { id: String(espnTypeId(e)), text: espnTypeText(e) }, text: e.text,
      awayScore: e.away, homeScore: e.home, period: { number: e.period, displayValue: perName(e.period) }, clock: { displayValue: fmtClock(e.clock) },
      scoringPlay: !!(e.pts), scoreValue: e.pts || 0, shootingPlay: e.type === 'shot' || e.type === 'ft', participants: parts, wallclock: isoSec(e.real) };
    if (e.side) o.team = { id: g[e.side].id };
    if (e.type === 'shot') o.coordinate = { x: Math.round(e.y * 10) / 10, y: Math.round(e.x * 10) / 10 };
    return o;
  }
  function espnBoxPlayers(g, side, live) {
    const ps = players(g[side].abbr), box = g.box[side], starters = g.starters[side];
    const order = ps.map((p) => p.i).sort((a, b) => (starters.includes(b) - starters.includes(a)) || a - b);
    const keys = ['minutes', 'points', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted', 'rebounds', 'assists', 'turnovers', 'steals', 'blocks', 'offensiveRebounds', 'defensiveRebounds', 'fouls', 'plusMinus'];
    const names = ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-'];
    const athletes = order.map((i) => {
      const p = ps[i], b = box[i];
      const ath = { id: p.id, displayName: p.name, shortName: p.short, position: { abbreviation: POS_ESPN[p.pos] }, jersey: p.jersey };
      if (isOut(p) || (b.min === 0 && !live)) return { active: false, starter: false, didNotPlay: true, reason: isOut(p) ? 'Injury/Illness' : 'Coach\'s Decision', athlete: ath, stats: [] };
      const pm = b.pm > 0 ? `+${b.pm}` : String(b.pm);
      return { active: true, starter: starters.includes(i), didNotPlay: false, athlete: ath,
        stats: [String(Math.round(b.min)), String(b.pts), `${b.fgm}-${b.fga}`, `${b.fg3m}-${b.fg3a}`, `${b.ftm}-${b.fta}`, String(b.oreb + b.dreb), String(b.ast), String(b.tov), String(b.stl), String(b.blk), String(b.oreb), String(b.dreb), String(b.pf), pm] };
    });
    return { team: { id: g[side].id, abbreviation: g[side].abbr }, statistics: [{ names, keys, labels: names.slice(), athletes }] };
  }
  function teamBoxStats(g, side) {
    const t = g.box[side].reduce((a, b) => { for (const k in b) a[k] = (a[k] || 0) + b[k]; return a; }, {});
    const pct = (m, a) => (a ? (100 * m / a).toFixed(1) : '0.0');
    return [
      { name: 'fieldGoalsMade-fieldGoalsAttempted', displayValue: `${t.fgm}-${t.fga}`, label: 'FG' },
      { name: 'fieldGoalPct', displayValue: pct(t.fgm, t.fga), label: 'Field Goal %' },
      { name: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', displayValue: `${t.fg3m}-${t.fg3a}`, label: '3PT' },
      { name: 'threePointFieldGoalPct', displayValue: pct(t.fg3m, t.fg3a), label: 'Three Point %' },
      { name: 'freeThrowsMade-freeThrowsAttempted', displayValue: `${t.ftm}-${t.fta}`, label: 'FT' },
      { name: 'totalRebounds', displayValue: String(t.oreb + t.dreb), label: 'Rebounds' },
      { name: 'offensiveRebounds', displayValue: String(t.oreb), label: 'Offensive Rebounds' },
      { name: 'defensiveRebounds', displayValue: String(t.dreb), label: 'Defensive Rebounds' },
      { name: 'assists', displayValue: String(t.ast), label: 'Assists' },
      { name: 'steals', displayValue: String(t.stl), label: 'Steals' },
      { name: 'blocks', displayValue: String(t.blk), label: 'Blocks' },
      { name: 'turnovers', displayValue: String(t.tov), label: 'Turnovers' },
      { name: 'fouls', displayValue: String(t.pf), label: 'Fouls' },
    ];
  }
  function espnSummary(g, now) {
    const ev = espnEvent(g, now);
    const st = stateAt(g, now - ESPN_LAG, now);
    const live = st.phase !== 'pre';
    const L = lines(g);
    const hdrComp = ev.competitions[0].competitors.map((c) => ({ homeAway: c.homeAway, id: c.id, team: { id: c.team.id, abbreviation: c.team.abbreviation, displayName: c.team.displayName, color: c.team.color, alternateColor: c.team.alternateColor, logos: [{ href: c.team.logo }] },
      score: c.score, linescores: (c.linescores || []).map((l) => ({ displayValue: String(l.value) })), record: [{ type: 'total', summary: c.records[0].summary }] }));
    const out = {
      header: { id: g.espnId, competitions: [{ id: g.espnId, date: ev.date, competitors: hdrComp, status: ev.status }] },
      boxscore: { teams: ['away', 'home'].map((side) => ({ team: { id: g[side].id, abbreviation: g[side].abbr }, statistics: live ? teamBoxStats(g, side) : [] })) },
      pickcenter: [{ provider: { name: 'DraftKings' }, details: L.details, overUnder: L.overUnder, spread: L.spread,
        awayTeamOdds: { favorite: !L.homeFav, underdog: L.homeFav, moneyLine: L.awayML, spreadOdds: -110, team: { id: g.away.id, abbreviation: g.away.abbr } },
        homeTeamOdds: { favorite: L.homeFav, underdog: !L.homeFav, moneyLine: L.homeML, spreadOdds: -110, team: { id: g.home.id, abbreviation: g.home.abbr } } }],
      predictor: (() => { const p = clamp(Phi(g.spreadHome / 12) + (hf(g.espnId + 'bpi') - 0.5) * 0.06, 0.03, 0.97) * 100;
        return { header: 'Matchup Predictor', homeTeam: { id: g.home.id, gameProjection: p.toFixed(1), teamChanceLoss: (100 - p).toFixed(1) }, awayTeam: { id: g.away.id, gameProjection: (100 - p).toFixed(1), teamChanceLoss: p.toFixed(1) } }; })(),
      injuries: ['away', 'home'].map((side) => ({ team: teamRef(g[side]), injuries: players(g[side].abbr).filter((p) => p.inj).map((p) => ({
        status: p.inj.status, date: isoMin(S.startedAt - 86400e3), athlete: { id: p.id, displayName: p.name, position: { abbreviation: p.pos } }, type: { description: p.inj.status.toLowerCase() },
        details: { type: p.inj.type, detail: p.inj.detail, side: 'Left', returnDate: ymd(et(S.startedAt + 4 * 86400e3)), fantasyStatus: { description: p.inj.status === 'Out' ? 'OUT' : 'GTD' } } })) })),
      lastFiveGames: ['away', 'home'].map((side) => ({ team: { id: g[side].id, abbreviation: g[side].abbr }, events: schedule(g[side].abbr).cur.slice(0, 5).map((x) => schedEvent(g[side], x)) })),
      seasonseries: [seasonSeries(g)],
      leaders: ['away', 'home'].map((side) => ({ team: { id: g[side].id, abbreviation: g[side].abbr }, leaders: leaders(g[side].abbr) })),
      gameInfo: { venue: { fullName: g.home.arena, address: { city: g.home.city, state: g.home.state } } },
    };
    if (live) {
      out.boxscore.players = ['away', 'home'].map((side) => espnBoxPlayers(g, side, st.phase !== 'final'));
      const vis = []; for (let i = 0; i < st.evN; i++) if (!g.ev[i].nbaOnly) vis.push(g.ev[i]);
      const last = vis.slice(-400);
      out.plays = last.map((e) => espnPlay(g, e));
      out.winprobability = last.map((e) => ({ homeWinPercentage: r3(e.wp), tiePercentage: 0, playId: g.espnId + pad(e.n, 4) }));
    } else { out.plays = []; out.winprobability = []; }
    return out;
  }
  function schedEvent(t, x) {
    const o = T[x.opp];
    return { id: x.id, gameDate: new Date(x.date).toISOString(), score: `${x.ts}-${x.os}`, atVs: x.home ? 'vs' : '@', gameResult: x.result,
      opponent: { id: o.id, abbreviation: o.abbr, displayName: o.displayName }, homeTeamId: x.home ? t.id : o.id, awayTeamId: x.home ? o.id : t.id,
      homeTeamScore: String(x.home ? x.ts : x.os), awayTeamScore: String(x.home ? x.os : x.ts) };
  }
  function seasonSeries(g) {
    const a = g.away.abbr, h = g.home.abbr;
    const meets = schedule(h).cur.filter((x) => x.opp === a);
    let aw = 0, hw = 0;
    const events = meets.map((x) => {
      if (x.result === 'W') hw++; else aw++;
      return { id: x.id, date: isoMin(x.date), competitors: [
        { homeAway: x.home ? 'home' : 'away', team: { id: g.home.id, abbreviation: h }, score: String(x.ts), winner: x.result === 'W' },
        { homeAway: x.home ? 'away' : 'home', team: { id: g.away.id, abbreviation: a }, score: String(x.os), winner: x.result !== 'W' }] };
    });
    const summary = hw === aw ? `Series tied ${hw}-${aw}` : hw > aw ? `${h} leads series ${hw}-${aw}` : `${a} leads series ${aw}-${hw}`;
    return { type: 'season', title: 'Regular Season Series', summary, completed: false, totalCompetitions: 4, events };
  }
  function leaders(abbr) {
    const ps = players(abbr);
    const avg = (p, f) => { const L = gameLines(p, 2027); return L.length ? L.reduce((s, x) => s + x[f], 0) / L.length : 0; };
    return [['points', 'Points', 'pts'], ['rebounds', 'Rebounds', 'reb'], ['assists', 'Assists', 'ast']].map(([name, dn, f]) => {
      let best = null, bv = -1; for (const p of ps) { const v = avg(p, f); if (v > bv) { bv = v; best = p; } }
      return { name, displayName: dn, leaders: [{ displayValue: bv.toFixed(1), value: Math.round(bv * 10) / 10, athlete: { id: best.id, displayName: best.name, position: { abbreviation: best.pos } } }] };
    });
  }
  function espnRoster(id) {
    const t = Object.values(T).find((x) => x.id === String(id));
    if (!t) return null;
    return { team: { id: t.id, abbreviation: t.abbr, displayName: t.displayName }, athletes: players(t.abbr).map((p) => ({ id: p.id, displayName: p.name, fullName: p.name, shortName: p.short, jersey: p.jersey,
      position: { abbreviation: p.pos }, injuries: p.inj ? [{ status: p.inj.status, date: isoMin(S.startedAt - 86400e3) }] : [], status: { type: 'active' } })) };
  }
  function standings() {
    const mk = (conf, name) => ({ name, standings: { entries: ALL.filter((a) => T[a].conf === conf).map((a) => {
      const sc = schedule(a).cur, t = T[a];
      const w = sc.filter((x) => x.result === 'W').length, l = sc.length - w;
      const pf = sc.reduce((s, x) => s + x.ts, 0) / sc.length, pa = sc.reduce((s, x) => s + x.os, 0) / sc.length;
      let streak = 0; const first = sc[0].result; for (const x of sc) { if (x.result === first) streak++; else break; }
      return { team: { id: t.id, abbreviation: t.abbr, displayName: t.displayName }, stats: [
        { name: 'wins', value: w }, { name: 'losses', value: l }, { name: 'winPercent', value: Math.round(w / (w + l) * 1000) / 1000 },
        { name: 'avgPointsFor', value: Math.round(pf * 10) / 10 }, { name: 'avgPointsAgainst', value: Math.round(pa * 10) / 10 },
        { name: 'differential', value: Math.round((pf - pa) * 10) / 10 }, { name: 'streak', displayValue: `${first}${streak}`, value: first === 'W' ? streak : -streak }] };
    }) } });
    return { children: [mk('E', 'Eastern Conference'), mk('W', 'Western Conference')] };
  }

  /* ---------------- Schedules & game logs ---------------- */
  function schedule(abbr) {
    if (S.sched[abbr]) return S.sched[abbr];
    const t = T[abbr], r = mulberry32(fnv('sched' + abbr)), opp0 = S.tonightOpp[abbr];
    const others = ALL.filter((a) => a !== abbr && a !== opp0 && !((abbr === 'BOS' && a === 'NY') || (abbr === 'NY' && a === 'BOS')));
    const sc = (a, b) => Math.round(112 + T[a].off - T[b].def + gauss(r) * 10);
    const cur = [], n = 5 + Math.floor(hf(abbr + 'n') * 3), td = S.today;
    let back = 2;
    for (let i = 0; i < n; i++) {
      let opp = others[Math.floor(r() * others.length)], id = '4017' + pad(+t.id) + pad(i, 3), home = r() < 0.5;
      let ts = sc(abbr, opp), os = sc(opp, abbr);
      if (i === 3 && (abbr === 'BOS' || abbr === 'NY')) { opp = abbr === 'BOS' ? 'NY' : 'BOS'; id = '401799001'; home = abbr === 'BOS'; ts = abbr === 'BOS' ? 110 : 104; os = abbr === 'BOS' ? 104 : 110; }
      if (ts === os) ts++;
      cur.push({ id, date: etToMs(td.y, td.m, td.d - back, 19, 30), home, opp, ts, os, result: ts > os ? 'W' : 'L', idx: i });
      back += 1 + (r() < 0.75 ? 1 : 0) + (r() < 0.2 ? 1 : 0);
    }
    const prev = [], meet = new Set([12, 30, hf(abbr + 'm3') < 0.5 ? 45 : -1]);
    let day = 0;
    for (let i = 0; i < 55; i++) {
      const opp = opp0 && meet.has(i) ? opp0 : others[Math.floor(r() * others.length)];
      let ts = sc(abbr, opp); const os = sc(opp, abbr); if (ts === os) ts++;
      prev.push({ id: '4016' + pad(+t.id) + pad(i, 3), date: etToMs(2025, 10, 22 + day, 19, 30), home: r() < 0.5, opp, ts, os, result: ts > os ? 'W' : 'L', idx: i });
      day += 2 + (r() < 0.6 ? 1 : 0) + (r() < 0.15 ? 1 : 0);
    }
    prev.reverse(); // newest first
    S.sched[abbr] = { cur, prev };
    return S.sched[abbr];
  }
  function logMinutes(abbr, outSet) { // minute targets for a game with some players unavailable (same rule as tonight's targets)
    const ps = players(abbr);
    if (!outSet.size) return ps.map((p) => p.min);
    const tot = ps.reduce((a, p) => a + (outSet.has(p.i) ? 0 : p.min), 0);
    return ps.map((p) => (outSet.has(p.i) ? 0 : clamp(p.min * 240 / tot, 0, 40)));
  }
  // returns array of {g (sched game), min, pts, reb, ast, fg3m, fg3a, fgm, fga, ftm, fta, stl, blk, pf, tov}
  // Drawn from the SAME per-minute production model the live sim realises and the market prices (teamRates).
  function gameLines(p, season) {
    const key = p.id + ':' + season;
    if (S.logs.has(key)) return S.logs.get(key);
    const sch = schedule(p.team), isCur = season === 2027;
    const games = isCur ? sch.cur : season === 2026 ? sch.prev : [];
    const ps = players(p.team);
    const outRes = [];
    for (const x of games) {
      if (isCur && isOut(p) && x.idx < p.inj.miss) continue;
      const r = mulberry32(fnv(p.id + ':' + x.id));
      if (r() < 0.03) continue;
      const outSet = new Set();
      if (isCur) for (const q of ps) if (isOut(q) && x.idx < q.inj.miss) outSet.add(q.i);
      const mins = logMinutes(p.team, outSet);
      let mult = isCur ? p.form : p.prevMult;
      if (S.tonightOpp[p.team] && x.opp === S.tonightOpp[p.team]) mult *= p.h2h;
      const W = ps.map((q) => weightsFor(q, q === p ? mult : 1));
      const info = sideInfo(ps, W, mins);
      const rt = teamRates(ps, info, kSolve(x.ts / POSS_PER_SIDE_GAME) / info.ebar, kSolve(x.os / POSS_PER_SIDE_GAME))[p.i];
      const min = clamp(Math.round(mins[p.i] + gauss(r) * 3.2), 4, 44), m36 = min / 36;
      const m2 = poisson(r, rt.m2 * min), m3 = poisson(r, rt.m3 * min), ftm = poisson(r, rt.ftm * min);
      const fg3a = m3 + poisson(r, Math.max(0, rt.a3 - rt.m3) * min), fg2a = m2 + poisson(r, Math.max(0, rt.a2 - rt.m2) * min);
      outRes.push({ g: x, ex: { m2: rt.m2 * min, m3: rt.m3 * min, ftm: rt.ftm * min, reb: rt.reb * min, ast: rt.ast * min }, min, pts: 2 * m2 + 3 * m3 + ftm, reb: poisson(r, rt.reb * min), ast: poisson(r, rt.ast * min), fg3m: m3, fg3a, fgm: m2 + m3, fga: fg2a + fg3a,
        ftm, fta: ftm + poisson(r, Math.max(0, rt.fta - rt.ftm) * min), stl: poisson(r, p.r.stl * m36), blk: poisson(r, p.r.blk * m36),
        pf: Math.min(6, poisson(r, 2.3 * m36)), tov: poisson(r, p.r.tov * m36) });
    }
    S.logs.set(key, outRes);
    return outRes;
  }
  function gamelog(id, season) {
    const pid = String(id);
    const tAbbr = ALL.find((a) => T[a].id === String(Math.floor((Number(pid) - 9000000) / 100)));
    if (!tAbbr || !/^9\d{6}$/.test(pid)) return null;
    const p = players(tAbbr).find((x) => x.id === pid);
    if (!p) return null;
    const names = ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'fieldGoalPct', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'threePointPct', 'freeThrowsMade-freeThrowsAttempted', 'freeThrowPct', 'totalRebounds', 'assists', 'blocks', 'steals', 'fouls', 'turnovers', 'points'];
    const labels = ['MIN', 'FG', 'FG%', '3PT', '3P%', 'FT', 'FT%', 'REB', 'AST', 'BLK', 'STL', 'PF', 'TO', 'PTS'];
    const L = gameLines(p, season);
    const t = T[tAbbr], events = {}, byMonth = new Map();
    const pct = (m, a) => (a ? (100 * m / a).toFixed(1) : '0.0');
    for (const x of L) {
      const o = T[x.g.opp];
      events[x.g.id] = { id: x.g.id, gameDate: new Date(x.g.date).toISOString().replace('Z', '+00:00'), atVs: x.g.home ? 'vs' : '@', gameResult: x.g.result,
        score: `${Math.max(x.g.ts, x.g.os)}-${Math.min(x.g.ts, x.g.os)}`, opponent: { id: o.id, abbreviation: o.abbr, displayName: o.displayName },
        team: { id: t.id, abbreviation: t.abbr }, homeTeamId: x.g.home ? t.id : o.id, awayTeamId: x.g.home ? o.id : t.id };
      const mon = MONTH[et(x.g.date).m - 1];
      if (!byMonth.has(mon)) byMonth.set(mon, []);
      byMonth.get(mon).push({ eventId: x.g.id, stats: [String(x.min), `${x.fgm}-${x.fga}`, pct(x.fgm, x.fga), `${x.fg3m}-${x.fg3a}`, pct(x.fg3m, x.fg3a), `${x.ftm}-${x.fta}`, pct(x.ftm, x.fta),
        String(x.reb), String(x.ast), String(x.blk), String(x.stl), String(x.pf), String(x.tov), String(x.pts)] });
    }
    const seasonTypes = L.length ? [{ displayName: season === 2027 ? '2026-27 Regular Season' : season === 2026 ? '2025-26 Regular Season' : `${season - 1}-${String(season).slice(2)} Regular Season`,
      categories: [...byMonth.entries()].map(([m, evs]) => ({ type: 'event', displayName: m, events: evs })) }] : [];
    return { labels, names, events, seasonTypes };
  }

  /* ---------------- NBA CDN builders ---------------- */
  const isoDur = (sec) => { const m = Math.floor(sec / 60), s = sec - m * 60; return `PT${pad(m)}M${s.toFixed(2).padStart(5, '0')}S`; };
  function nbaTeam(t, st, side) {
    const rec = record(t.abbr), ls = side === 'home' ? st.lsH : st.lsA;
    const np = Math.max(4, ls.length);
    const periods = []; for (let i = 0; i < np; i++) periods.push({ period: i + 1, periodType: i < 4 ? 'REGULAR' : 'OVERTIME', score: ls[i] || 0 });
    return { teamId: t.nbaId, teamName: t.name, teamCity: t.location, teamTricode: t.code, wins: rec.w, losses: rec.l, score: side === 'home' ? st.home : st.away, periods };
  }
  function nbaStatusText(g, st) {
    if (st.phase === 'pre') { const p = et(g.tipReal); return `${p.h % 12 || 12}:${pad(p.mi)} ${p.h < 12 ? 'am' : 'pm'} ET`; }
    if (st.phase === 'final') return st.period > 4 ? 'Final/OT' : 'Final';
    if (st.phase === 'half') return 'Half';
    const q = st.period <= 4 ? `Q${st.period}` : `OT${st.period - 4}`;
    if (st.phase === 'break') return `End ${q}`;
    return `${q} ${fmtClock(st.pclock)}`;
  }
  function nbaScoreboard(now) {
    const games = S.games.filter((g) => g.isToday).map((g) => {
      const st = stateAt(g, now, now);
      const gs = st.phase === 'pre' ? 1 : st.phase === 'final' ? 3 : 2;
      return { gameId: g.nbaId, gameCode: `${ymd(g.day).replace(/-/g, '')}/${g.away.code}${g.home.code}`, gameStatus: gs, gameStatusText: nbaStatusText(g, st), period: st.period,
        gameClock: gs === 2 ? isoDur(st.phase === 'live' ? st.pclock : 0) : '', gameTimeUTC: isoSec(g.tipReal), homeTeam: nbaTeam(g.home, st, 'home'), awayTeam: nbaTeam(g.away, st, 'away') };
    });
    return { meta: { version: 1, request: 'demo', time: new Date(now).toISOString(), code: 200 }, scoreboard: { gameDate: ymd(S.today), leagueId: '00', leagueName: 'National Basketball Association', games } };
  }
  function nbaBox(g, now) {
    const st = stateAt(g, now, now);
    if (st.phase === 'pre') return null;
    const team = (side) => {
      const t = g[side], ps = players(t.abbr), box = g.box[side], live = st.phase !== 'final';
      return { teamId: t.nbaId, teamName: t.name, teamCity: t.location, teamTricode: t.code, score: side === 'home' ? st.home : st.away,
        players: ps.map((p) => {
          const b = box[p.i], starter = g.starters[side].includes(p.i);
          const o = { status: isOut(p) ? 'INACTIVE' : 'ACTIVE', order: p.i + 1, personId: p.personId, jerseyNum: p.jersey, position: starter ? p.pos : '', starter: starter ? '1' : '0',
            oncourt: live && g.on[side].includes(p.i) ? '1' : '0', played: b.min > 0 ? '1' : '0', name: p.name, nameI: p.short, firstName: p.first, familyName: p.last,
            statistics: { minutes: isoDur(b.min * 60), points: b.pts, reboundsTotal: b.oreb + b.dreb, reboundsOffensive: b.oreb, reboundsDefensive: b.dreb, assists: b.ast,
              threePointersMade: b.fg3m, threePointersAttempted: b.fg3a, fieldGoalsMade: b.fgm, fieldGoalsAttempted: b.fga, freeThrowsMade: b.ftm, freeThrowsAttempted: b.fta,
              steals: b.stl, blocks: b.blk, turnovers: b.tov, foulsPersonal: b.pf, plusMinusPoints: b.pm } };
          if (isOut(p)) o.notPlayingReason = 'INACTIVE_INJURY';
          return o;
        }) };
    };
    return { meta: { version: 1, code: 200 }, game: { gameId: g.nbaId, gameStatus: st.phase === 'final' ? 3 : 2, gameStatusText: nbaStatusText(g, st), period: st.period,
      gameClock: isoDur(st.phase === 'live' ? st.pclock : 0), gameTimeUTC: isoSec(g.tipReal), homeTeam: team('home'), awayTeam: team('away') } };
  }
  function nbaPbp(g, now) {
    const st = stateAt(g, now, now);
    if (st.phase === 'pre') return null;
    const type = (e) => ({ shot: e.is3 ? '3pt' : '2pt', ft: 'freethrow', reb: 'rebound', tov: 'turnover', foul: 'foul', sub: 'substitution', period: 'period', jump: 'jumpball', timeout: 'timeout', block: 'block', steal: 'steal' }[e.type]);
    const sub = (e) => {
      if (e.type === 'shot') return { 'Three Point Jumper': 'Jump Shot', 'Jump Shot': 'Jump Shot', 'Pullup Jump Shot': 'Jump Shot', 'Driving Layup Shot': 'Layup', 'Dunk Shot': 'DUNK' }[e.kind];
      if (e.type === 'ft') return `${e.j} of ${e.nft}`;
      if (e.type === 'timeout') return 'full';
      return e.sub || '';
    };
    const actions = g.ev.map((e) => {
      const t = e.side ? g[e.side] : null, pl = t && e.p != null ? players(t.abbr)[e.p] : null;
      const a = { actionNumber: e.n, clock: isoDur(e.clock), timeActual: isoSec(e.real), period: e.period, periodType: e.period <= 4 ? 'REGULAR' : 'OVERTIME',
        teamId: t ? t.nbaId : 0, teamTricode: t ? t.code : '', actionType: type(e), subType: sub(e), scoreHome: String(e.home), scoreAway: String(e.away),
        possession: g[e.poss] ? g[e.poss].nbaId : 0, personId: pl ? pl.personId : 0, playerNameI: pl ? pl.short : '', description: e.text, isFieldGoal: e.type === 'shot' ? 1 : 0 };
      if (e.type === 'shot') { a.shotResult = e.made ? 'Made' : 'Missed'; a.x = Math.round(e.x / 94 * 10000) / 100; a.y = Math.round(e.y / 50 * 10000) / 100; a.shotDistance = e.dist; a.pointsTotal = e.pts; }
      if (e.type === 'ft') a.shotResult = e.made ? 'Made' : 'Missed';
      return a;
    });
    return { meta: { version: 1, code: 200 }, game: { gameId: g.nbaId, actions } };
  }

  /* ---------------- Kalshi ---------------- */
  const SERIES = [
    ['KXNBAGAME', 'Pro Basketball Game'], ['KXNBASPREAD', 'Pro Basketball Spread'], ['KXNBATOTAL', 'Pro Basketball Total Points'],
    ['KXNBAPTS', 'Pro Basketball Player Points'], ['KXNBAREB', 'Pro Basketball Player Rebounds'], ['KXNBAAST', 'Pro Basketball Player Assists'],
    ['KXNBA3PT', 'Pro Basketball Player Threes'], ['KXNBA1QWINNER', 'Pro Basketball 1st Quarter Winner'], ['KXNBA', 'Pro Basketball Champion'],
    ['KXNBAMVP', 'NBA MVP'], ['KXNFLGAME', 'Pro Football Game'],
  ].map(([ticker, title]) => ({ ticker, title, category: 'Sports', frequency: ticker === 'KXNBA' || ticker === 'KXNBAMVP' ? 'annual' : 'custom', tags: [ticker === 'KXNFLGAME' ? 'Football' : 'Basketball'], settlement_sources: [{ name: ticker === 'KXNFLGAME' ? 'NFL' : 'NBA', url: 'https://www.nba.com/' }] }));
  const PROPS = { KXNBAPTS: ['pts', 0, 'points', [10, 15, 20, 25, 30, 35], 25, 2], KXNBAREB: ['reb', 1, 'rebounds', [4, 6, 8, 10, 12, 14], 14, 4], KXNBAAST: ['ast', 2, 'assists', [2, 4, 6, 8, 10, 12], 10, 3], KXNBA3PT: ['fg3', 3, 'threes', [1, 2, 3, 4, 5], 8, 0.9] };
  function kdefs(g) {
    if (g.kd) return g.kd;
    const a = g.away, h = g.home, base = `${g.dcode}${a.code}${h.code}`, matchup = `${a.kname} at ${h.kname}`;
    const dHuman = `${MON_S[g.day.m - 1]} ${g.day.d}, ${g.day.y}`;
    const evs = {};
    const event = (series, suffix) => (evs[series] = evs[series] || { event_ticker: `${series}-${base}`, series_ticker: series, title: matchup + (suffix || ''), sub_title: `${a.code} @ ${h.code} (${MON_S[g.day.m - 1]} ${g.day.d})`, category: 'Sports', strike_date: isoSec(g.tipReal + 3 * 3600e3), markets: [] });
    const add = (series, sfx, def) => {
      const e = event(series, sfx);
      def.ticker = `${e.event_ticker}-${def.tsfx}`; def.event_ticker = e.event_ticker; def.series = series; def.g = g;
      const u = hf(def.ticker + 'b'), sg = hf(def.ticker + 's') < 0.5 ? -1 : 1, m = hf(def.ticker + 'm');
      def.bias = def.family === 'prop' ? (u < 0.15 ? sg * (0.05 + 0.07 * m) : (m - 0.5) * 0.04)
        : (def.family === 'spread' || def.family === 'total') ? (u < 0.12 ? sg * (0.03 + 0.03 * m) : (m - 0.5) * 0.04) : (u < 0.05 ? sg * 0.03 : (m - 0.5) * 0.03);
      const lagU = hf(def.ticker + 'lag');
      def.lag = { game: 4 + 6 * lagU, spread: 6 + 12 * lagU, total: 6 + 12 * lagU, q1: 5 + 10 * lagU, prop: 8 + 22 * lagU }[def.family];
      def.width = def.family === 'prop' ? 0.02 + Math.floor(hf(def.ticker + 'w') * 3) / 100 : def.family === 'game' ? 0.01 : def.family === 'q1' ? 0.02 : 0.01 + Math.floor(hf(def.ticker + 'w') * 2) / 100;
      def.phaseOff = fnv(def.ticker) % 10000;
      const vb = { game: 120000, spread: 15000, total: 15000, q1: 6000, prop: 2500 }[def.family];
      def.volBase = Math.floor(vb * (0.4 + hf(def.ticker + 'v'))); def.volRate = vb / 4000 * (0.5 + hf(def.ticker + 'vr'));
      e.markets.push(def);
    };
    for (const side of ['away', 'home']) {
      const t = g[side];
      add('KXNBAGAME', '', { family: 'game', side, tsfx: t.code, title: `${matchup} Winner?`, ysub: t.kname, nsub: t.kname, strike_type: 'structured',
        rules: `If ${t.kname} wins the ${matchup} professional basketball game originally scheduled for ${dHuman}, then the market resolves to Yes.` });
    }
    const favSide = g.spreadHome >= 0 ? 'home' : 'away', fa = Math.abs(g.spreadHome);
    const favR = [1, 3, 5, 7, 9, 11].filter((x) => x <= fa + 7.5);
    while (favR.length < 4) favR.push(favR[favR.length - 1] + 2);
    const rungs = { [favSide]: favR, [other(favSide)]: [1, 3] };
    for (const side of ['away', 'home']) for (const X of rungs[side]) {
      const t = g[side];
      add('KXNBASPREAD', ': Spread', { family: 'spread', side, strike: X + 0.5, tsfx: `${t.code}${X}`, title: `${t.kname} wins by over ${X}.5 Points?`, ysub: `${t.kname} wins by over ${X}.5 Points`, nsub: `${t.kname} wins by over ${X}.5 Points`,
        strike_type: 'greater', floor: X + 0.5, rules: `If ${t.kname} wins the ${matchup} game by more than ${X}.5 points, then the market resolves to Yes.` });
    }
    const c = Math.floor(g.total);
    for (const off of [-12, -9, -6, -3, 0, 3, 6, 9, 12]) {
      const X = c + off;
      add('KXNBATOTAL', ': Total Points', { family: 'total', strike: X + 0.5, tsfx: String(X), title: `${matchup}: Total Points`, ysub: `Over ${X}.5 points scored`, nsub: `Over ${X}.5 points scored`,
        strike_type: 'greater', floor: X + 0.5, rules: `If more than ${X}.5 total points are scored in the ${matchup} game, then the market resolves to Yes.` });
    }
    if (g.isToday) {
      for (const side of ['away', 'home']) {
        const t = g[side], ps = players(t.abbr), tgt = g.tgt[side];
        const exp = (p, f) => p.r[f] * p.tonight * tgt[p.i] / 36;
        const keyP = ps.filter((p) => !isOut(p)).sort((x, y) => exp(y, 'pts') - exp(x, 'pts')).slice(0, 4);
        for (const p of keyP) for (const series of Object.keys(PROPS)) {
          const [f, fi, word, ladder, , minMean] = PROPS[series];
          const mean = exp(p, f);
          if (mean < minMean) continue;
          let rs = ladder.filter((x) => x >= mean * 0.45 && x <= mean * 1.6 + 1).sort((x, y) => Math.abs(x - mean) - Math.abs(y - mean)).slice(0, 4);
          if (rs.length < 3) rs = ladder.slice().sort((x, y) => Math.abs(x - mean) - Math.abs(y - mean)).slice(0, 3);
          rs.sort((x, y) => x - y);
          const tag = `${t.code}${p.first[0]}${p.last.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)}${p.jersey}`;
          for (const thr of rs) {
            add(series, `: ${word[0].toUpperCase() + word.slice(1)}`, { family: 'prop', side, pIdx: p.i, stat: f, fi, thr, tsfx: `${tag}-${thr}`,
              title: `${p.name}: ${thr}+ ${word}`, ysub: `${p.name}: ${thr}+`, nsub: `${p.name}: ${thr}+`, strike_type: 'greater', floor: thr - 0.5,
              rules: `If ${p.name} records ${thr} or more ${word} in the ${matchup} game, then the market resolves to Yes.` });
          }
        }
      }
      for (const side of ['away', 'home']) {
        const t = g[side];
        add('KXNBA1QWINNER', ': 1st Quarter Winner', { family: 'q1', side, tsfx: t.code, title: `${matchup}: 1st Quarter Winner`, ysub: t.kname, nsub: t.kname, strike_type: 'structured',
          rules: `If ${t.kname} outscores the opponent in the 1st quarter of the ${matchup} game, then the market resolves to Yes. A tied quarter resolves to No.` });
      }
    }
    g.kd = evs;
    return evs;
  }
  function futures() {
    if (S.fut) return S.fut;
    const mk = (series, evT, title, items) => ({ event_ticker: evT, series_ticker: series, title, sub_title: '2026-27', category: 'Sports', strike_date: '2027-06-20T00:00:00Z',
      markets: items.map(([sfx, ysub, p]) => ({ static: true, ticker: `${evT}-${sfx}`, event_ticker: evT, series, title, ysub, nsub: ysub, strike_type: 'structured', p, width: 0.01, volBase: 400000, volRate: 2, rules: `If ${ysub} wins, then the market resolves to Yes.` })) });
    S.fut = [
      mk('KXNBA', 'KXNBA-27', 'Pro Basketball Champion 2027', [['OKC', 'Oklahoma City', 0.21], ['BOS', 'Boston', 0.11], ['NYK', 'New York', 0.09], ['DEN', 'Denver', 0.08]]),
      mk('KXNBAMVP', 'KXNBAMVP-27', 'NBA MVP 2027', [['DPRICE', 'Darnell Price', 0.12], ['MHALE', 'Malik Hale', 0.08]]),
      mk('KXNFLGAME', `KXNFLGAME-${S.tomorrow.y % 100}${MON[S.tomorrow.m - 1]}${pad(S.tomorrow.d)}BUFKC`, 'Buffalo at Kansas City Winner?', [['BUF', 'Buffalo', 0.44], ['KC', 'Kansas City', 0.58]]),
    ];
    return S.fut;
  }
  function openEvents(now) {
    const out = [];
    for (const g of S.games) {
      const st = stateAt(g, now, now);
      if (st.phase === 'final') continue;
      const evs = kdefs(g);
      for (const s of Object.keys(evs)) {
        if (s === 'KXNBA1QWINNER' && !(st.phase === 'pre' || (st.phase === 'live' && st.period === 1))) continue;
        out.push(evs[s]);
      }
    }
    for (const e of futures()) out.push(e);
    return out;
  }
  function propRemMin(g, st, side, i) { // expected remaining minutes under the sim's lineup rule (deficit vs target)
    if (st.phase === 'final' || pstat(st, side, i, 5) >= 6) return 0;
    const tgt = g.tgt[side][i];
    if (st.phase === 'pre') return tgt;
    if (st.period >= 5 || (st.phase !== 'live' && st.period >= 4)) return tgt / 48 * st.R;
    return clamp(tgt - pstat(st, side, i, 4), 0, st.R);
  }
  function trueProb(d, g, st) {
    const M = st.home - st.away;
    if (d.family === 'game') { const p = pHomeWin(g, st); return d.side === 'home' ? p : 1 - p; }
    if (d.family === 'spread') {
      if (st.phase === 'final') { const m = d.side === 'home' ? M : -M; return m > d.strike ? 1 : 0; }
      const dm = marginDist(g, M, possLeft(st), possDelta(st));
      return d.side === 'home' ? 1 - Phi((d.strike - dm.mean) / dm.sd) : Phi((-d.strike - dm.mean) / dm.sd);
    }
    if (d.family === 'total') {
      const T0 = st.home + st.away;
      if (st.phase === 'final') return T0 > d.strike ? 1 : 0;
      const gm = gameModel(g), n = possLeft(st), dm = marginDist(g, M, n, possDelta(st)), muP = (gm.home.mu + gm.away.mu) / 2;
      const mean = T0 + dm.nh * gm.home.mu + dm.na * gm.away.mu;
      const sd = Math.sqrt(dm.nh * gm.home.v + dm.na * gm.away.v + n * SEC_PER_POSS * 10.67 / 2744 * muP * muP + 1e-4);
      const pt = Phi((0.5 - dm.mean) / dm.sd) - Phi((-0.5 - dm.mean) / dm.sd);
      const nOT = 300 / SEC_PER_POSS + 0.527, otMean = nOT * muP, otVar = nOT * (gm.home.v + gm.away.v) / 2;
      const z = (d.strike - mean) / sd;
      return clamp(1 - Phi(z) + pt * (Phi(z) - Phi((d.strike - mean - otMean) / Math.sqrt(sd * sd + otVar))), 0, 1);
    }
    if (d.family === 'q1') {
      let M1 = 0, n = POSS_PER_PERIOD, delta = 0;
      if (st.phase !== 'pre') {
        M1 = (st.lsH[0] || 0) - (st.lsA[0] || 0);
        if (!(st.phase === 'live' && st.period === 1)) return (d.side === 'home' ? M1 > 0 : M1 < 0) ? 1 : 0;
        n = st.pclock / SEC_PER_POSS + 0.5; delta = possDelta(st);
      }
      const dm = marginDist(g, M1, n, delta);
      return d.side === 'home' ? 1 - Phi((0.5 - dm.mean) / dm.sd) : Phi((-0.5 - dm.mean) / dm.sd);
    }
    if (d.family === 'prop') {
      const c = cstat(st, d.side, d.pIdx, d.fi);
      if (st.phase === 'final') return c >= d.thr ? 1 : 0;
      const r = propRemMin(g, st, d.side, d.pIdx), rt = g.rt[d.side][d.pIdx];
      if (d.stat === 'pts') return ptsTail(c, rt.m2 * r, rt.m3 * r, rt.ftm * r, d.thr);
      return poisTail(c, (d.stat === 'reb' ? rt.reb : d.stat === 'ast' ? rt.ast : rt.m3) * r, d.thr);
    }
    return 0.5;
  }
  // The market knows the clock in real time but processes scoring/stat changes late: it sees counting stats as of
  // (its last 10s refresh) - (its lag). Outside those lag windows quote mid = truth + bias + noise.
  function viewAt(g, t, scoreT, now) {
    const cur = stateAt(g, t, now);
    if (scoreT >= t) return cur;
    const old = stateAt(g, scoreT, now);
    return Object.assign({}, cur, { home: old.home, away: old.away, lsH: old.lsH, lsA: old.lsA, cst: old.pst });
  }
  function quoteMid(d, t, bucket, now) {
    if (d.static) return { mid: d.p + (hf(d.ticker + bucket) - 0.5) * 0.01, hit: false };
    const g = d.g, bStart = bucket * 10000 - d.phaseOff;
    const st = viewAt(g, t, Math.min(t, bStart - d.lag * 1000), now);
    if (d.family === 'prop' && cstat(st, d.side, d.pIdx, d.fi) >= d.thr) return { mid: 0.995, hit: true };
    const p = trueProb(d, g, st);
    const u = hf(d.ticker + ':n:' + bucket), noise = u < 0.5 ? 0 : (u < 0.75 ? -0.01 : 0.01);
    return { mid: clamp(p + d.bias + noise, 0.01, 0.99), hit: false };
  }
  function quote(d, now) {
    const bucket = Math.floor((now + (d.phaseOff || 0)) / 10000);
    const key = d.ticker + ':' + Math.floor(now / 1000);
    let q = S.qcache.get(key);
    if (!q) {
      const cur = quoteMid(d, now, bucket, now), prev = quoteMid(d, now - 10000, bucket - 1, now);
      let bid, ask;
      if (cur.hit) { bid = 0.99; ask = 1.0; }
      else { bid = clamp(r2(cur.mid - d.width / 2), 0.01, 0.98); ask = clamp(r2(bid + d.width), bid + 0.01, 0.99); }
      q = { bid, ask, last: cur.hit ? 0.99 : r2(cur.mid), prev: prev.hit ? 0.99 : r2(prev.mid) };
      if (S.qcache.size > 20000) S.qcache.clear();
      S.qcache.set(key, q);
    }
    const g = d.g, tip = g ? g.tipReal : S.startedAt;
    const vol = Math.floor(d.volBase + d.volRate * Math.max(0, now - S.startedAt) / 1000);
    return {
      ticker: d.ticker, event_ticker: d.event_ticker, market_type: 'binary', title: d.title, subtitle: '', yes_sub_title: d.ysub, no_sub_title: d.nsub, status: 'active',
      yes_bid_dollars: usd(q.bid), yes_ask_dollars: usd(q.ask), no_bid_dollars: usd(1 - q.ask), no_ask_dollars: usd(1 - q.bid),
      last_price_dollars: usd(q.last), previous_price_dollars: usd(q.prev), volume: vol, volume_fp: vol.toFixed(2),
      open_interest: Math.floor(vol * 0.45), open_interest_fp: Math.floor(vol * 0.45).toFixed(2),
      close_time: isoSec(tip + 4 * 3600e3), expected_expiration_time: isoSec(tip + 2.75 * 3600e3), strike_type: d.strike_type,
      ...(d.floor != null ? { floor_strike: d.floor } : {}), rules_primary: d.rules,
    };
  }
  function truthOf(ticker) { // debug: the sim's own probability right now (no lag, no bias)
    const now = Date.now();
    for (const e of openEvents(now)) {
      const d = e.markets.find((x) => x.ticker === ticker);
      if (!d) continue;
      if (d.static) return { truth: d.p, lagged: false };
      const st = stateAt(d.g, now, now), bucket = Math.floor((now + d.phaseOff) / 10000);
      const v = viewAt(d.g, now, Math.min(now, bucket * 10000 - d.phaseOff - d.lag * 1000), now);
      const lagged = d.family === 'prop' ? cstat(v, d.side, d.pIdx, d.fi) !== pstat(st, d.side, d.pIdx, d.fi) : (v.home !== st.home || v.away !== st.away);
      return { truth: trueProb(d, d.g, st), lagged, bias: d.bias, family: d.family };
    }
    return null;
  }
  const evOut = (e, nested, now) => {
    const o = { event_ticker: e.event_ticker, series_ticker: e.series_ticker, title: e.title, sub_title: e.sub_title, category: e.category, strike_date: e.strike_date, mutually_exclusive: e.series_ticker === 'KXNBAGAME' };
    if (nested) o.markets = e.markets.map((d) => quote(d, now));
    return o;
  };
  function kalshi(path, q, now) {
    const p = path.replace(/^\/trade-api\/v2/, '');
    let m;
    if (p === '/series' || p === '/series/') {
      const cat = q.get('category');
      return { series: SERIES.filter((s) => !cat || s.category === cat).map((s) => ({ ...s })) };
    }
    if ((m = p.match(/^\/series\/([A-Z0-9]+)$/))) { const s = SERIES.find((x) => x.ticker === m[1]); return s ? { series: { ...s } } : null; }
    if (p === '/events' || p === '/events/') {
      const st = q.get('series_ticker'), nested = q.get('with_nested_markets') === 'true';
      const lim = clamp(parseInt(q.get('limit') || '200', 10) || 200, 1, 200);
      const evs = openEvents(now).filter((e) => !st || e.series_ticker === st).slice(0, lim);
      return { events: evs.map((e) => evOut(e, nested, now)), cursor: '' };
    }
    if ((m = p.match(/^\/events\/([A-Z0-9-]+)$/))) {
      const e = openEvents(now).find((x) => x.event_ticker === m[1]);
      if (!e) return null;
      const mk = e.markets.map((d) => quote(d, now));
      const eo = evOut(e, false, now); eo.markets = mk;
      return { event: eo, markets: mk.map((x) => ({ ...x })) };
    }
    if ((m = p.match(/^\/markets\/([A-Z0-9.-]+)$/))) {
      for (const e of openEvents(now)) { const d = e.markets.find((x) => x.ticker === m[1]); if (d) return { market: quote(d, now) }; }
      return null;
    }
    if (p === '/markets' || p === '/markets/') {
      const st = q.get('series_ticker'), et_ = q.get('event_ticker'), tk = q.get('tickers');
      const evSet = et_ ? new Set(et_.split(',').map((x) => x.trim()).filter(Boolean)) : null;
      const tkSet = tk ? new Set(tk.split(',').map((x) => x.trim()).filter(Boolean)) : null;
      const lim = clamp(parseInt(q.get('limit') || '1000', 10) || 1000, 1, 1000);
      const out = [];
      for (const e of openEvents(now)) {
        if (st && e.series_ticker !== st) continue;
        if (evSet && !evSet.has(e.event_ticker)) continue;
        for (const d of e.markets) { if (tkSet && !tkSet.has(d.ticker)) continue; out.push(quote(d, now)); if (out.length >= lim) break; }
        if (out.length >= lim) break;
      }
      return { markets: out, cursor: '' };
    }
    return null;
  }

  /* ---------------- Router ---------------- */
  function espn(path, q, now) {
    let m;
    if (/\/sports\/basketball\/nba\/scoreboard$/.test(path) && path.startsWith('/apis/site/v2')) {
      const ds = q.get('dates') || ymd(S.today).replace(/-/g, '');
      const t = ymd(S.today).replace(/-/g, ''), tm = ymd(S.tomorrow).replace(/-/g, '');
      const day = ds === t ? S.today : ds === tm ? S.tomorrow : null;
      const dayStr = day ? ymd(day) : `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
      const games = day ? S.games.filter((g) => g.day === day) : [];
      return { leagues: [{ season: { year: 2027, type: { type: 2 } } }], day: { date: dayStr }, events: games.map((g) => espnEvent(g, now)) };
    }
    if (/^\/apis\/site\/v2\/sports\/basketball\/nba\/summary$/.test(path)) {
      const g = S.byEspn[q.get('event') || ''];
      return g ? espnSummary(g, now) : null;
    }
    if ((m = path.match(/^\/apis\/site\/v2\/sports\/basketball\/nba\/teams\/(\d+)\/roster$/))) return espnRoster(m[1]);
    if (/^\/apis\/v2\/sports\/basketball\/nba\/standings$/.test(path)) return standings();
    return null;
  }
  function handle(source, pathWithQuery) {
    try {
      ensure();
      const now = Date.now();
      const s = String(pathWithQuery || '');
      const qi = s.indexOf('?');
      const path = (qi >= 0 ? s.slice(0, qi) : s).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
      const q = new URLSearchParams(qi >= 0 ? s.slice(qi + 1) : '');
      let m;
      if (source === 'espn') return espn(path, q, now);
      if (source === 'espnweb') {
        if ((m = path.match(/^\/apis\/common\/v3\/sports\/basketball\/nba\/athletes\/(\d+)\/gamelog$/))) return gamelog(m[1], parseInt(q.get('season') || '2027', 10));
        return null;
      }
      if (source === 'nba') {
        if (path === '/static/json/liveData/scoreboard/todaysScoreboard_00.json') return nbaScoreboard(now);
        if ((m = path.match(/^\/static\/json\/liveData\/boxscore\/boxscore_(\d+)\.json$/))) { const g = S.byNba[m[1]]; return g ? nbaBox(g, now) : null; }
        if ((m = path.match(/^\/static\/json\/liveData\/playbyplay\/playbyplay_(\d+)\.json$/))) { const g = S.byNba[m[1]]; return g ? nbaPbp(g, now) : null; }
        return null;
      }
      if (source === 'kalshi') return kalshi(path, q, now);
      return null;
    } catch (e) {
      lastError = String((e && e.stack) || e);
      return null;
    }
  }
  function info() { ensure(); return { startedAt: S.startedAt, speed: SPEED, lastError }; }
  function _truth(ticker) { try { ensure(); return truthOf(ticker); } catch (e) { lastError = String((e && e.stack) || e); return null; } }
  return { handle, info, _truth };
})();
