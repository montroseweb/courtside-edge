// Builds dist/index.html (full document for hosting) and dist/artifact.html (claude.ai artifact body)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const ORDER = ['util', 'teams', 'net', 'espn', 'nba', 'kalshi', 'model', 'intel', 'scout', 'picks', 'parlay', 'court', 'chart', 'demo', 'ui', 'mybets', 'app'];
const js = `(() => {\n'use strict';\n${ORDER.map((f) => `/* ---- ${f}.js ---- */\n` + src(f + '.js')).join('\n')}\nAPP.start();\n})();`;
const css = src('styles.css'), body = src('body.html');
const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Teko:wght@400;500;600;700&display=swap">`;
const title = '<title>Courtside Edge</title>';
const page = `${title}\n<meta name="claude:viewport-fit-sides" content="cover">\n${fonts}\n<style>\n${css}\n</style>\n${body}\n<script>\n${js}\n</script>\n`;
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="theme-color" content="#080c12">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n<meta name="apple-mobile-web-app-title" content="Courtside">\n<link rel="manifest" href="manifest.json">\n<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">\n<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">\n<meta name="description" content="Live NBA courts, win probability and a Kalshi pick finder.">\n${title}\n${fonts}\n<style>\n:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}\n${css}\n</style>\n</head>\n<body>\n${body}\n<script>\n${js}\n</script>\n</body>\n</html>\n`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), full);
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), page);
fs.writeFileSync(path.join(root, 'tools', '.app-check.js'), js); // for syntax checks (node --check)
// PWA: manifest, icons, service worker (version-stamped so updates replace the cached shell)
const ver = require('crypto').createHash('sha1').update(full).digest('hex').slice(0, 10);
fs.mkdirSync(path.join(root, 'dist', 'icons'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'src', 'assets'))) fs.copyFileSync(path.join(root, 'src', 'assets', f), path.join(root, 'dist', 'icons', f));
fs.writeFileSync(path.join(root, 'dist', 'sw.js'), src('sw.js').replace('__VERSION__', ver));
fs.writeFileSync(path.join(root, 'dist', 'manifest.json'), JSON.stringify({
  name: 'Courtside Edge', short_name: 'Courtside', description: 'Live NBA courts, win probability and a stress-tested Kalshi pick finder.',
  id: './index.html', start_url: './index.html', scope: './', display: 'standalone', orientation: 'portrait', background_color: '#04121f', theme_color: '#080c12',
  icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
}, null, 2));
console.log('built', (full.length / 1024).toFixed(0) + 'KB', 'sw', ver);
