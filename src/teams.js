/* ============================================================
   teams.js — team table, code mapping, stylized arena courts
   Court profiles are stylized interpretations of each home floor
   (wood tone, paint color, apron, accents) — not licensed artwork.
   ============================================================ */

const TEAMS = (() => {
  // espn abbr, espn id, tricode (NBA CDN + Kalshi), city, name, primary, secondary, arena, court profile
  // court: wood (maple|honey|amber|dark|parquet|herring), paint, apron, line, accent, stain (inside-arc tint or null), extra
  const T = [
    ['ATL', 1, 'ATL', 'Atlanta', 'Hawks', 'e03a3e', 'c1d32f', 'State Farm Arena', { wood: 'maple', paint: '#c8102e', apron: '#1b1c1e', line: '#ffffff', accent: '#c1d32f', stain: null }],
    ['BOS', 2, 'BOS', 'Boston', 'Celtics', '007a33', 'ba9653', 'TD Garden', { wood: 'parquet', paint: '#007a33', apron: '#0b5c2c', line: '#ffffff', accent: '#ba9653', stain: null }],
    ['NO', 3, 'NOP', 'New Orleans', 'Pelicans', '0c2340', 'c8102e', 'Smoothie King Center', { wood: 'honey', paint: '#0c2340', apron: '#0c2340', line: '#ffffff', accent: '#85714d', stain: null }],
    ['CHI', 4, 'CHI', 'Chicago', 'Bulls', 'ce1141', '000000', 'United Center', { wood: 'maple', paint: '#ce1141', apron: '#111111', line: '#ffffff', accent: '#ce1141', stain: null }],
    ['CLE', 5, 'CLE', 'Cleveland', 'Cavaliers', '860038', 'fdbb30', 'Rocket Arena', { wood: 'honey', paint: '#860038', apron: '#041e42', line: '#ffffff', accent: '#fdbb30', stain: null }],
    ['DAL', 6, 'DAL', 'Dallas', 'Mavericks', '0064b1', 'bbc4ca', 'American Airlines Center', { wood: 'amber', paint: '#0064b1', apron: '#002b5e', line: '#ffffff', accent: '#b8c4ca', stain: null }],
    ['DEN', 7, 'DEN', 'Denver', 'Nuggets', '0e2240', 'fec524', 'Ball Arena', { wood: 'maple', paint: '#0e2240', apron: '#0e2240', line: '#ffffff', accent: '#fec524', stain: null, mountains: true }],
    ['DET', 8, 'DET', 'Detroit', 'Pistons', 'c8102e', '1d42ba', 'Little Caesars Arena', { wood: 'honey', paint: '#1d42ba', apron: '#c8102e', line: '#ffffff', accent: '#bec0c2', stain: null }],
    ['GS', 9, 'GSW', 'Golden State', 'Warriors', '1d428a', 'ffc72c', 'Chase Center', { wood: 'maple', paint: '#1d428a', apron: '#1d428a', line: '#ffffff', accent: '#ffc72c', stain: null }],
    ['HOU', 10, 'HOU', 'Houston', 'Rockets', 'ce1141', 'c4ced4', 'Toyota Center', { wood: 'amber', paint: '#ce1141', apron: '#000000', line: '#ffffff', accent: '#c4ced4', stain: null }],
    ['IND', 11, 'IND', 'Indiana', 'Pacers', '002d62', 'fdbb30', 'Gainbridge Fieldhouse', { wood: 'honey', paint: '#002d62', apron: '#002d62', line: '#ffffff', accent: '#fdbb30', stain: 'rgba(253,187,48,0.10)' }],
    ['LAC', 12, 'LAC', 'LA', 'Clippers', 'c8102e', '1d428a', 'Intuit Dome', { wood: 'dark', paint: '#1d428a', apron: '#0b1020', line: '#ffffff', accent: '#c8102e', stain: null }],
    ['LAL', 13, 'LAL', 'Los Angeles', 'Lakers', '552583', 'fdb927', 'Crypto.com Arena', { wood: 'honey', paint: '#fdb927', apron: '#552583', line: '#ffffff', accent: '#552583', stain: null }],
    ['MIA', 14, 'MIA', 'Miami', 'Heat', '98002e', 'f9a01b', 'Kaseya Center', { wood: 'maple', paint: '#98002e', apron: '#000000', line: '#ffffff', accent: '#f9a01b', stain: null }],
    ['MIL', 15, 'MIL', 'Milwaukee', 'Bucks', '00471b', 'eee1c6', 'Fiserv Forum', { wood: 'maple', paint: '#00471b', apron: '#00471b', line: '#eee1c6', accent: '#0077c0', stain: 'rgba(238,225,198,0.18)' }],
    ['MIN', 16, 'MIN', 'Minnesota', 'Timberwolves', '0c2340', '78be20', 'Target Center', { wood: 'amber', paint: '#0c2340', apron: '#0c2340', line: '#ffffff', accent: '#78be20', stain: null }],
    ['BKN', 17, 'BKN', 'Brooklyn', 'Nets', '000000', 'ffffff', 'Barclays Center', { wood: 'herring', paint: '#111111', apron: '#000000', line: '#ffffff', accent: '#9aa0a6', stain: null }],
    ['NY', 18, 'NYK', 'New York', 'Knicks', '1d428a', 'f58426', 'Madison Square Garden', { wood: 'honey', paint: '#006bb6', apron: '#1d428a', line: '#ffffff', accent: '#f58426', stain: null }],
    ['ORL', 19, 'ORL', 'Orlando', 'Magic', '0077c0', 'c4ced4', 'Kia Center', { wood: 'maple', paint: '#0077c0', apron: '#000000', line: '#ffffff', accent: '#c4ced4', stain: null, pinstripes: true }],
    ['PHI', 20, 'PHI', 'Philadelphia', '76ers', '006bb6', 'ed174c', 'Xfinity Mobile Arena', { wood: 'honey', paint: '#006bb6', apron: '#002b5c', line: '#ffffff', accent: '#ed174c', stain: null }],
    ['PHX', 21, 'PHX', 'Phoenix', 'Suns', '1d1160', 'e56020', 'PHX Arena', { wood: 'amber', paint: '#1b1b1b', apron: '#1d1160', line: '#ffffff', accent: '#e56020', stain: null, sunburst: true }],
    ['POR', 22, 'POR', 'Portland', 'Trail Blazers', 'e03a3e', '000000', 'Moda Center', { wood: 'dark', paint: '#111111', apron: '#111111', line: '#ffffff', accent: '#e03a3e', stain: null }],
    ['SAC', 23, 'SAC', 'Sacramento', 'Kings', '5a2d81', '63727a', 'Golden 1 Center', { wood: 'maple', paint: '#5a2d81', apron: '#111111', line: '#ffffff', accent: '#63727a', stain: null }],
    ['SA', 24, 'SAS', 'San Antonio', 'Spurs', 'c4ced4', '000000', 'Frost Bank Center', { wood: 'honey', paint: '#111111', apron: '#000000', line: '#ffffff', accent: '#c4ced4', stain: null }],
    ['OKC', 25, 'OKC', 'Oklahoma City', 'Thunder', '007ac1', 'ef3b24', 'Paycom Center', { wood: 'maple', paint: '#007ac1', apron: '#002d62', line: '#ffffff', accent: '#ef3b24', stain: null }],
    ['UTAH', 26, 'UTA', 'Utah', 'Jazz', '4e008e', '79a3dc', 'Delta Center', { wood: 'maple', paint: '#4e008e', apron: '#0d0d0d', line: '#ffffff', accent: '#79a3dc', stain: null, mountains: true }],
    ['WSH', 27, 'WAS', 'Washington', 'Wizards', '002b5c', 'e31837', 'Capital One Arena', { wood: 'honey', paint: '#e31837', apron: '#002b5c', line: '#ffffff', accent: '#c4ced4', stain: null }],
    ['TOR', 28, 'TOR', 'Toronto', 'Raptors', 'ce1141', '000000', 'Scotiabank Arena', { wood: 'maple', paint: '#ce1141', apron: '#000000', line: '#ffffff', accent: '#a1a1a4', stain: null }],
    ['MEM', 29, 'MEM', 'Memphis', 'Grizzlies', '5d76a9', '12173f', 'FedExForum', { wood: 'amber', paint: '#12173f', apron: '#12173f', line: '#ffffff', accent: '#5d76a9', stain: null }],
    ['CHA', 30, 'CHA', 'Charlotte', 'Hornets', '1d1160', '00788c', 'Spectrum Center', { wood: 'maple', paint: '#00788c', apron: '#1d1160', line: '#ffffff', accent: '#a1a1a4', stain: null, honeycomb: true }],
  ];
  // standard-time UTC offsets (hours) and arena elevation (ft) for travel/fatigue math
  const TZ = { ATL: -5, BOS: -5, BKN: -5, CHA: -5, CLE: -5, DET: -5, IND: -5, MIA: -5, NYK: -5, ORL: -5, PHI: -5, TOR: -5, WAS: -5,
    CHI: -6, DAL: -6, HOU: -6, MEM: -6, MIL: -6, MIN: -6, NOP: -6, OKC: -6, SAS: -6, DEN: -7, UTA: -7, PHX: -7, GSW: -8, LAC: -8, LAL: -8, POR: -8, SAC: -8 };
  const ELEV = { DEN: 5280, UTA: 4226 };
  const byEspn = {}, byId = {}, byCode = {};
  const list = T.map(([espn, id, code, city, name, color, alt, arena, court]) => {
    const t = { espn, id: String(id), code, city, name, color, alt, arena, court, tz: TZ[code] ?? -5, elev: ELEV[code] || 0 };
    byEspn[espn] = t; byId[String(id)] = t; byCode[code] = t;
    return t;
  });
  // extra aliases occasionally seen in feeds
  const ALIAS = { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', UTH: 'UTA', PHO: 'PHX', BRK: 'BKN', NJN: 'BKN', CHO: 'CHA', WSB: 'WAS', NOR: 'NOP', GOS: 'GSW', SAN: 'SAS', NYC: 'NYK' };
  const toCode = (abbr) => { abbr = String(abbr || '').toUpperCase(); return byCode[abbr] ? abbr : (ALIAS[abbr] || (byEspn[abbr] && byEspn[abbr].code) || abbr); };
  const find = (x) => byCode[toCode(x)] || byId[String(x)] || null;
  const CODES = Object.keys(byCode);
  // split "BOSNYK" (or with 2-4 letter codes) into [away, home]
  function splitPair(s) {
    s = String(s || '').toUpperCase();
    for (let i = 2; i <= 4; i++) {
      const a = toCode(s.slice(0, i)), b = toCode(s.slice(i));
      if (byCode[a] && byCode[b]) return [a, b];
    }
    return null;
  }
  return { list, byEspn, byId, byCode, toCode, find, CODES, splitPair };
})();
