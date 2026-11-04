/* ============================================================
   nba.js — NBA official liveData CDN (scoreboard, boxscore,
   play-by-play). Usually the fastest public score source.
   ============================================================ */

const NBA = (() => {
  const B = '/static/json/liveData';
  function parseScoreboard(j) {
    const sb = j?.scoreboard;
    if (!sb) return null;
    return {
      date: sb.gameDate,
      games: (sb.games || []).map((g) => ({
        gameId: String(g.gameId), status: +g.gameStatus || 1, statusText: g.gameStatusText || '', period: +g.period || 0,
        clockSec: U.isoDur(g.gameClock), timeUTC: Date.parse(g.gameTimeUTC) || 0,
        home: { code: TEAMS.toCode(g.homeTeam?.teamTricode), score: +g.homeTeam?.score || 0, line: (g.homeTeam?.periods || []).map((p) => +p.score || 0) },
        away: { code: TEAMS.toCode(g.awayTeam?.teamTricode), score: +g.awayTeam?.score || 0, line: (g.awayTeam?.periods || []).map((p) => +p.score || 0) },
      })),
    };
  }
  function parseBox(j) {
    const g = j?.game;
    if (!g) return null;
    const side = (t, ha) => (t?.players || []).map((p) => {
      const s = p.statistics || {};
      return {
        nbaId: String(p.personId), name: p.name || `${p.firstName || ''} ${p.familyName || ''}`.trim(), short: p.nameI || '', teamCode: TEAMS.toCode(t.teamTricode), ha,
        pos: p.position || '', jersey: p.jerseyNum || '', starter: p.starter === '1', oncourt: p.oncourt === '1', played: p.played === '1',
        status: p.status || 'ACTIVE', notPlaying: p.notPlayingReason || '',
        min: (U.isoDur(s.minutes) ?? 0) / 60, pts: +s.points || 0, reb: +s.reboundsTotal || 0, ast: +s.assists || 0, fg3m: +s.threePointersMade || 0,
        fg3a: +s.threePointersAttempted || 0, fga: +s.fieldGoalsAttempted || 0, fta: +s.freeThrowsAttempted || 0, stl: +s.steals || 0, blk: +s.blocks || 0, tov: +s.turnovers || 0, pf: +s.foulsPersonal || 0, pm: +s.plusMinusPoints || 0,
      };
    });
    return {
      gameId: String(g.gameId), status: +g.gameStatus || 0, period: +g.period || 0, clockSec: U.isoDur(g.gameClock),
      homeScore: +g.homeTeam?.score || 0, awayScore: +g.awayTeam?.score || 0,
      players: [...side(g.homeTeam, 'home'), ...side(g.awayTeam, 'away')], at: Date.now(),
    };
  }
  function parsePbp(j) {
    const acts = j?.game?.actions;
    if (!acts) return null;
    return acts.map((a) => ({
      n: +a.actionNumber || 0, period: +a.period || 0, clockSec: U.isoDur(a.clock), team: TEAMS.toCode(a.teamTricode), teamId: a.teamId,
      type: a.actionType || '', sub: a.subType || '', made: a.shotResult === 'Made', shot: a.shotResult != null && /2pt|3pt/.test(a.actionType || ''),
      x: U.num(a.x), y: U.num(a.y), hs: U.num(a.scoreHome), as: U.num(a.scoreAway), poss: a.possession, personId: String(a.personId || ''),
      who: a.playerNameI || '', desc: a.description || '', ts: Date.parse(a.timeActual) || 0,
    }));
  }
  return {
    scoreboard: () => NET.get('nba', `${B}/scoreboard/todaysScoreboard_00.json`, { fresh: true, timeout: 5000 }).then(parseScoreboard),
    box: (gid) => NET.get('nba', `${B}/boxscore/boxscore_${gid}.json`, { fresh: true, timeout: 6000 }).then(parseBox),
    pbp: (gid) => NET.get('nba', `${B}/playbyplay/playbyplay_${gid}.json`, { fresh: true, timeout: 8000 }).then(parsePbp),
    parseScoreboard, parseBox, parsePbp,
  };
})();
