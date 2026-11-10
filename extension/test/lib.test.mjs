// Logique de l'extension avec un faux fetch (PRACC, stockage, n8n). Lancer : node --test extension/test/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { N8N_HOOK, PRACC_CALENDAR, PRACC_DEMOS, SECRET_HEADER, cleanSecret, faceitRoom, grabDemoLinks, newSecret, runFaceit,
         runTour, storageUrl } from "../lib.js";

const DEMO = "https://pracc.com/api/team/server/demos/u1/download";
const SIGNED = "https://fsn1.your-objectstorage.com/pracc-demos/u1.dem.bz2?X-Amz-Signature=abc";
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

/** Faux fetch : `routes` répond selon l'adresse ; chaque appel est gardé dans `calls`. */
function fake(routes) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, opts, body });
    const r = routes(url, body, opts);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchFn, calls };
}
const now = () => new Date("2026-10-23T14:00:00Z");

test("secret : 64 caractères hexadécimaux, différent à chaque fois", () => {
  const a = newSecret();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(newSecret(), a);
});

test("secret collé par un coéquipier : espaces et majuscules tolérés, le reste refusé", () => {
  const s = newSecret();
  assert.equal(cleanSecret(`  ${s.toUpperCase()}\n`), s);
  for (const bad of ["", "abc", `${s}0`, s.replace(/./, "g"), null, undefined]) assert.equal(cleanSecret(bad), null, String(bad));
});

test("lien de stockage : adresse finale de la redirection, téléchargement coupé", async () => {
  let signal;
  const { fetchFn, calls } = fake((url, _b, opts) => { signal = opts.signal; return { ok: true, redirected: true, url: SIGNED }; });
  assert.equal(await storageUrl(fetchFn, DEMO), SIGNED);
  assert.equal(calls[0].opts.credentials, "include");
  assert.equal(signal.aborted, true);
});

test("lien de stockage : rien sans redirection, ni hors de pracc.com (aucune requête)", async () => {
  const { fetchFn, calls } = fake(() => ({ ok: true, redirected: false, url: DEMO }));
  assert.equal(await storageUrl(fetchFn, DEMO), null);
  for (const u of ["https://evil.example/x", "https://pracc.com.evil.example/x", "http://pracc.com/x", "pas un lien"]) {
    assert.equal(await storageUrl(fetchFn, u), null, u);
  }
  assert.equal(calls.length, 1);
  const failing = fake(() => new TypeError("Failed to fetch"));
  assert.equal(await storageUrl(failing.fetchFn, DEMO), null);
});

test("tour : liste et calendrier envoyés à n8n avec le secret, liens résolus, import envoyé", async () => {
  const list = [{ Uid: "u1", Uploaded: true }];
  const calendar = { Matches: [], Events: [{ ID: 41, Title: "ESEA vs. mskLANERS" }] };
  const { fetchFn, calls } = fake((url, body) => {
    if (url === PRACC_DEMOS) return json(200, list);
    if (url === PRACC_CALENDAR) return json(200, calendar);
    if (url === N8N_HOOK && body.step === "calendar") return json(200, { ok: true });
    if (url === DEMO) return { ok: true, redirected: true, url: SIGNED };
    if (url === N8N_HOOK && body.step === "list") {
      return json(200, { fetch: [{ uid: "u1", downloadUrl: DEMO, createdAt: "2026-10-23T13:00:00Z", opponent: "Rivals" }] });
    }
    if (url === N8N_HOOK && body.step === "import") return json(200, { ok: true });
    throw new Error(`inattendu : ${url}`);
  });
  const out = await runTour({ fetchFn, secret: "s3cr3t", now });
  assert.deepEqual(out, { at: "2026-10-23T14:00:00.000Z", state: "ok", imported: 1, message: "1 prac(s) envoyé(s) à Sightline" });
  const hooks = calls.filter((c) => c.url === N8N_HOOK);
  assert.deepEqual(hooks.map((c) => c.opts.headers[SECRET_HEADER]), ["s3cr3t", "s3cr3t", "s3cr3t"]);
  assert.deepEqual(hooks[0].body, { step: "list", statusCode: 200, body: list });
  assert.deepEqual(hooks[1].body, { step: "calendar", statusCode: 200, body: calendar });
  assert.equal(calls.find((c) => c.url === PRACC_CALENDAR).opts.credentials, "include");
  assert.deepEqual(hooks[2].body, { step: "import", items: [
    { uid: "u1", createdAt: "2026-10-23T13:00:00Z", opponent: "Rivals", storageUrl: SIGNED }] });
  assert.equal(calls.find((c) => c.url === PRACC_DEMOS).opts.credentials, "include");
  assert.ok(hooks.every((c) => c.opts.credentials === undefined)); // aucun cookie vers n8n
});

test("tour : rien de nouveau = pas d'étape import", async () => {
  const { fetchFn, calls } = fake((url) => (url === PRACC_DEMOS ? json(200, []) : json(200, { fetch: [] })));
  const out = await runTour({ fetchFn, secret: "s", now });
  assert.equal(out.message, "Rien de nouveau");
  assert.deepEqual(calls.filter((c) => c.url === N8N_HOOK).map((c) => c.body.step), ["list", "calendar"]);
});

test("tour : session PRACC expirée, signalée même si n8n ne répond pas", async () => {
  for (const n8n of [json(200, { fetch: [], expired: true }), json(502, {})]) {
    const { fetchFn, calls } = fake((url) => (url === PRACC_DEMOS ? json(401, { Code: "not_authenticated" }) : n8n));
    const out = await runTour({ fetchFn, secret: "s", now });
    assert.equal(out.state, "expired");
    assert.deepEqual(calls[1].body, { step: "list", statusCode: 401, body: null }); // n8n prévient Discord
  }
});

test("tour : pause du backup, aucun lien demandé, mais calendrier envoyé", async () => {
  const { fetchFn, calls } = fake((url) => (url === PRACC_DEMOS ? json(200, []) : json(200, { fetch: [], quiet: true })));
  const out = await runTour({ fetchFn, secret: "s", now });
  assert.match(out.message, /pause/);
  assert.deepEqual(calls.map((c) => (c.url === N8N_HOOK ? c.body.step : c.url)), [PRACC_DEMOS, "list", PRACC_CALENDAR, "calendar"]);
});

test("tour : erreurs lisibles (secret refusé, PRACC injoignable, lien introuvable)", async () => {
  const refused = fake((url) => (url === PRACC_DEMOS ? json(200, []) : json(403, {})));
  assert.match((await runTour({ fetchFn: refused.fetchFn, secret: "faux", now })).message, /refuse le secret/);
  const down = fake(() => new TypeError("Failed to fetch"));
  assert.deepEqual(await runTour({ fetchFn: down.fetchFn, secret: "s", now }),
                   { at: "2026-10-23T14:00:00.000Z", state: "error", message: "PRACC injoignable", imported: 0 });
  const noLink = fake((url) => {
    if (url === PRACC_DEMOS) return json(200, []);
    if (url === DEMO) return { ok: false, redirected: false, url: DEMO };
    return json(200, { fetch: [{ uid: "u1", downloadUrl: DEMO }] });
  });
  const out = await runTour({ fetchFn: noLink.fetchFn, secret: "s", now });
  assert.equal(out.state, "error");
  assert.match(out.message, /1 lien\(s\) de démo introuvable/);
  assert.deepEqual(noLink.calls.filter((c) => c.url === N8N_HOOK).map((c) => c.body.step), ["list", "calendar"]); // pas d'import vide
});

test("FACEIT : matchs demandés ouverts un par un, liens transmis à n8n", async () => {
  const M1 = "1-00000000-0000-4000-8000-000000000001", M2 = "1-00000000-0000-4000-8000-000000000002";
  const { fetchFn, calls } = fake((url, body) => (body.step === "faceit-wanted" ? json(200, { wanted: [{ match_id: M1 }, { match_id: M2 }] })
    : json(200, { status: "started" })));
  const opened = [];
  const openRoom = async (u) => { opened.push(u); return u.endsWith(M1) ? { links: ["https://b2/x-1-1.dem.zst?s", "https://b2/x-1-4.dem.zst?s"] }
    : { error: "Aucun lien de démo" }; };
  const out = await runFaceit({ fetchFn, secret: "s", openRoom, now });
  assert.deepEqual(opened, [faceitRoom(M1), faceitRoom(M2)]);
  assert.deepEqual(calls.map((c) => c.body.step), ["faceit-wanted", "faceit-links", "faceit-links"]);
  assert.deepEqual(calls[1].body, { step: "faceit-links", match_id: M1, links: ["https://b2/x-1-1.dem.zst?s", "https://b2/x-1-4.dem.zst?s"] });
  assert.deepEqual(calls[2].body, { step: "faceit-links", match_id: M2, error: "Aucun lien de démo" });
  assert.deepEqual([out.state, out.sent, out.message], ["ok", 2, "FACEIT : 2 démo(s) envoyée(s) à Sightline"]);
});

test("FACEIT : pas connecté, on s'arrête ; rien à faire, ou n8n injoignable", async () => {
  const M = "1-00000000-0000-4000-8000-000000000001";
  const two = fake((url, body) => (body.step === "faceit-wanted" ? json(200, { wanted: [{ match_id: M }, { match_id: M }] }) : json(200, {})));
  const out = await runFaceit({ fetchFn: two.fetchFn, secret: "s", openRoom: async () => ({ error: "login" }), now });
  assert.equal(out.state, "expired");
  assert.equal(two.calls.length, 2); // le 2e match attend aussi : inutile d'ouvrir sa page
  const none = fake(() => json(200, { wanted: [] }));
  assert.equal((await runFaceit({ fetchFn: none.fetchFn, secret: "s", openRoom: async () => assert.fail(), now })).message,
               "FACEIT : rien à récupérer");
  const down = fake(() => json(502, {}));
  assert.equal((await runFaceit({ fetchFn: down.fetchFn, secret: "s", openRoom: async () => ({}), now })).state, "error");
  const crash = fake((url, body) => (body.step === "faceit-wanted" ? json(200, { wanted: [{ match_id: M }] }) : json(200, {})));
  await runFaceit({ fetchFn: crash.fetchFn, secret: "s", openRoom: async () => { throw new Error("Page FACEIT trop lente"); }, now });
  assert.deepEqual(crash.calls[1].body, { step: "faceit-links", match_id: M, error: "Page FACEIT trop lente" });
});

/** Fausse page de match : bouton « Regarder la démo », puis un menu « Démo 1 / Démo 2 » (ou un lien direct). */
function fakePage({ items = 2, logged = true, closes = false, lazy = false } = {}) {
  const page = { menu: false, buttons: [], clicks: 0 };
  const button = (text, onClick) => ({ textContent: text, click: onClick });
  const watch = button("Regarder la démo", () => {
    page.clicks += 1;
    if (!items && !(lazy && page.clicks === 1)) globalThis.window.open("https://b2/m-1-1.dem.zst?sig"); // `lazy` : 1er clic sans effet
    page.menu = items > 0;
  });
  const entry = (k) => button(`Démo ${k}`, () => { globalThis.window.open(`https://b2/m-1-${k}.dem.zst?sig`); if (closes) page.menu = false; });
  globalThis.window = { open: () => "vrai open" };
  globalThis.document = {
    querySelectorAll: () => (logged ? [watch, ...(page.menu ? Array.from({ length: items }, (_, i) => entry(i + 1)) : [])] : []),
    body: { innerText: logged ? "Salle de match" : "Se connecter à FACEIT" },
  };
  return () => { delete globalThis.window; delete globalThis.document; };
}

test("page FACEIT : liens notés au lieu d'être ouverts, menu d'une démo par fichier", async () => {
  for (const opts of [{ items: 2 }, { items: 2, closes: true }, { items: 0 }, { items: 0, lazy: true }]) {
    const done = fakePage(opts);
    const out = await grabDemoLinks(1);
    const expected = opts.items ? ["https://b2/m-1-1.dem.zst?sig", "https://b2/m-1-2.dem.zst?sig"] : ["https://b2/m-1-1.dem.zst?sig"];
    assert.deepEqual(out, { links: expected }, JSON.stringify(opts));
    assert.equal(globalThis.window.open(), "vrai open"); // la page retrouve son window.open
    done();
  }
  const done = fakePage({ logged: false });
  assert.deepEqual(await grabDemoLinks(1), { error: "login" });
  done();
});
