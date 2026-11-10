// Visite chaque page du site en local (fixture e2e), capture d'écran + erreurs console + débordements + temps de chargement.
// Usage : backend lancé sur 8000 avec SKYBOX_DATA_DIR=../data-e2e (fixture insérée par backend/scripts/seed_fixture.py) et
// `npm run dev` sur 5173, puis `node scripts/ui-audit.cjs 1440x900,1280x720` → captures et report.json dans .ui-audit/out.
const { chromium } = require(require("path").join(__dirname, "../frontend/node_modules/@playwright/test"));
const fs = require("fs");
const path = require("path");
const OUT = path.join(process.env.UI_AUDIT_OUT || path.join(__dirname, "../.ui-audit"), "out");
fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5173";
const API = "http://127.0.0.1:8000";

async function j(u) { try { return await (await fetch(API + u)).json(); } catch { return null; } }

(async () => {
  const matches = (await j("/api/matches")) || [];
  const m = matches[0]?.id;
  const players = (await j("/api/players")) || [];
  const sid = players[0]?.steamid || (players.players || [])[0]?.steamid;
  const playlists = (await j("/api/playlists")) || [];
  const strats = (await j("/api/strats")) || [];
  const teams = (await j("/api/scouting/teams")) || [];
  const preps = (await j("/api/prep/reports")) || [];
  const routes = [
    "/dashboard", "/", `/matches/${m}`, `/matches/${m}/replay/1`, `/matches/${m}/report`, "/rounds", "/grenades", "/heatmaps",
    "/playlists", playlists[0] && `/playlists/${playlists[0].id}`, "/players", sid && `/players/${sid}`,
    `/learn?match=${m}&player=${sid}`, `/learn?match=${m}&player=${sid}&view=routine`, "/learn/expert", "/assistant", "/team", "/callouts",
    "/highlights", "/leaderboards", "/calendar", "/bookmarks", "/stratbook", strats[0] && `/stratbook/${strats[0].id}`,
    "/scouting", "/veto", "/scouting/faceit", teams[0] && `/scouting/${teams[0].id}`,
    // parité EDGE (sous-projets A → M)
    teams[0] && `/scouting/${teams[0].id}?tab=carte&armed=1`, teams[0] && `/scouting/${teams[0].id}?tab=joueurs`,
    teams[0] && `/team-stats?team=${teams[0].id}&map=de_nuke`, teams[0] && `/team-stats?team=${teams[0].id}&map=de_nuke&tab=sites`,
    teams[0] && `/playbook?team=${teams[0].id}&map=de_nuke`, teams[0] && `/playbook/editor?map=de_nuke&side=T&team=${teams[0].id}`,
    teams[0] && `/pattern-finder?team=${teams[0].id}&map=de_nuke&side=T`, "/match-prep", preps[0] && `/match-prep/${preps[0].id}`,
    "/scouting/players", "/veto?format=bo1&tab=scenarios", "/veto?tab=stats", "/veto?tab=records",
    `/matches/${m}/replay/2?from=%2Fscouting%2F${teams[0] ? teams[0].id : 1}`, "/leaderboards?tab=table", sid && `/players/${sid}?tab=roles`,
  ].filter(Boolean);
  const sizes = (process.argv[2] || "1440x900").split(",").map((s) => s.split("x").map(Number));
  const browser = await chromium.launch();
  const report = [];
  for (const [w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: "fr-FR" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (msg) => { if (msg.type() === "error" || msg.type() === "warning") errors.push(`${msg.type()}: ${msg.text().slice(0, 300)}`); });
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 300)));
    page.on("requestfailed", (r) => errors.push("reqfail: " + r.url().slice(0, 200)));
    for (const r of routes) {
      errors.length = 0;
      const t0 = Date.now();
      let status = "ok";
      try {
        const resp = await page.goto(BASE + r, { waitUntil: "load", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => (status = "networkidle-timeout"));
      } catch (e) { status = "goto-failed: " + String(e).slice(0, 120); }
      await page.waitForTimeout(600);
      const ms = Date.now() - t0;
      const metrics = await page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const de = document.documentElement;
        const overflowX = de.scrollWidth > vw + 1;
        const tiny = [...document.querySelectorAll("body *")].filter((el) => {
          const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize);
          return el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && fs < 11 && cs.visibility !== "hidden" && el.getClientRects().length;
        }).length;
        const clipped = [...document.querySelectorAll("body *")].filter((el) => {
          const rc = el.getBoundingClientRect();
          return rc.width && rc.right > vw + 2 && getComputedStyle(el).position !== "fixed";
        }).length;
        const h1 = document.querySelector("h1")?.textContent?.trim() || "";
        const empty = [...document.querySelectorAll("main, .page, [class*=empty]")].map((e) => e.textContent.trim()).join(" ").slice(0, 160);
        const api4xx = performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/")).length;
        return { vw, vh, overflowX, scrollW: de.scrollWidth, scrollH: de.scrollHeight, tiny, clipped, h1, api: api4xx, title: document.title, sample: empty };
      });
      const name = (r.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home") + `_${w}`;
      await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false });
      report.push({ route: r, size: `${w}x${h}`, ms, status, ...metrics, errors: [...new Set(errors)].slice(0, 8) });
      console.log(`${String(ms).padStart(5)}ms ${status.padEnd(8)} ${r.padEnd(45)} ovX=${metrics.overflowX ? "YES" : "no "} clip=${metrics.clipped} tiny=${metrics.tiny} err=${errors.length} h1=${metrics.h1.slice(0, 30)}`);
    }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
})();
