// Optional Cloudflare Worker CORS proxy for Courtside Edge (use if you host the page somewhere
// without rewrites, e.g. GitHub Pages). Deploy, then in the app's Settings paste:
//   https://<your-worker>.workers.dev/?url=
const ALLOW = ['site.api.espn.com', 'site.web.api.espn.com', 'cdn.nba.com', 'external-api.kalshi.com', 'api.elections.kalshi.com'];
export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    const target = new URL(req.url).searchParams.get('url');
    if (!target) return new Response('missing ?url=', { status: 400 });
    const t = new URL(target);
    if (!ALLOW.includes(t.hostname)) return new Response('host not allowed', { status: 403 });
    const r = await fetch(t.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 CourtsideEdge' }, cf: { cacheTtl: 0 } });
    const h = new Headers(r.headers);
    h.set('Access-Control-Allow-Origin', '*');
    h.set('Cache-Control', 'no-store');
    h.delete('set-cookie');
    return new Response(r.body, { status: r.status, headers: h });
  },
};
