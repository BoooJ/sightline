// Mesure ce que charge le build de production : polices, JS, CSS, appels d'API et premiers affichages par page.
// Usage : backend lancé sur 8000 avec frontend/dist construit (il sert le build), puis
//   MSYS_NO_PATHCONV=1 node scripts/perf-audit.cjs http://127.0.0.1:8000 "/,/matches/1"   (sous Git Bash ; PowerShell : sans la variable)
const { chromium } = require(require("path").join(__dirname, "../frontend/node_modules/@playwright/test"));
(async () => {
  const base = process.argv[2] || "http://127.0.0.1:8000";
  const routes = (process.argv[3] || "/,/matches/1,/matches/1/replay/1").split(",");
  const browser = await chromium.launch();
  for (const r of routes) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(base + r, { waitUntil: "networkidle" });
    const m = await page.evaluate(() => new Promise((res) => {
      const res_ = performance.getEntriesByType("resource").map((e) => ({ n: e.name.replace(location.origin, ""), t: e.initiatorType, s: e.transferSize, d: Math.round(e.duration), st: Math.round(e.startTime) }));
      const nav = performance.getEntriesByType("navigation")[0];
      const paint = performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]);
      new PerformanceObserver((l) => { const lcp = l.getEntries().pop(); res({ res: res_, dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), paint, lcp: Math.round(lcp.startTime) }); }).observe({ type: "largest-contentful-paint", buffered: true });
      setTimeout(() => res({ res: res_, dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), paint, lcp: null }), 1500);
    }));
    const fonts = m.res.filter((x) => /woff/.test(x.n));
    const js = m.res.filter((x) => /\.js/.test(x.n));
    const api = m.res.filter((x) => x.n.includes("/api/"));
    const sum = (a) => a.reduce((s, x) => s + x.s, 0);
    console.log(`\n== ${r}  paint=${JSON.stringify(m.paint)} lcp=${m.lcp} dcl=${m.dcl} load=${m.load}`);
    console.log(`fonts: ${fonts.length} files, ${Math.round(sum(fonts)/1024)} kB :`, fonts.map((f) => f.n.split("/").pop().replace(/-[A-Za-z0-9_-]{8}\.woff2?$/, "")).join(", "));
    console.log(`js: ${js.length} files, ${Math.round(sum(js)/1024)} kB ; css ${Math.round(sum(m.res.filter((x)=>/\.css/.test(x.n)))/1024)} kB`);
    console.log(`api (${api.length}):`, api.map((a) => `${a.n.slice(0, 60)} ${a.st}ms+${a.d}ms ${Math.round(a.s/1024)}kB`).join("\n  "));
    await ctx.close();
  }
  await browser.close();
})();
