import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CHUNK, checkAdmin, checkSite, uploadFile, uploadVariant } from "../lib/upload.mjs";

/** Réponse au format de Playwright (APIResponse) : le corps se lit en texte, il n'est pas forcément du JSON. */
const res = (status, body) => ({ ok: () => status < 300, status: () => status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

/** Faux Sightline en mémoire, au contrat de store.py : morceaux d'affilée, 409 { detail: { received } } sur un décalage
 *  faux ; begin reprend les octets déjà reçus quand carte, variante, sha256 et taille sont les mêmes (le reste du méta,
 *  exported_at compris, peut changer d'un lancement à l'autre). Pannes réglables : requête perdue (cut), réponse perdue
 *  après écriture (lose), coupure durable après n morceaux (downAfter), code imposé (putStatus, beginStatus). */
function fakeServer({ have = Buffer.alloc(0), cut = 0, lose = 0, downAfter = Infinity, putStatus = null, beginStatus = null } = {}) {
  const st = { data: have, puts: 0, completed: false, begun: null, key: null, downAfter };
  const request = {
    post: async (url, opts = {}) => {
      if (url.endsWith("/complete")) { st.completed = true; return res(200, { variants: { gray: { url: "/api/maps3d/de_nuke/gray-x.glb" } } }); }
      if (beginStatus) return res(...beginStatus);
      const key = [url, opts.data.sha256, opts.data.size].join(" ");
      if (st.key && st.key !== key) st.data = Buffer.alloc(0);
      st.key = key;
      st.begun = opts.data;
      return res(200, { id: "a".repeat(32), received: st.data.length, size: opts.data.size });
    },
    put: async (url, { data }) => {
      st.puts++;
      if (st.puts === cut || st.puts > st.downAfter) throw new Error("coupure réseau");
      if (putStatus) return res(...putStatus);
      const off = Number(new URL(url).searchParams.get("offset"));
      if (off !== st.data.length) return res(409, { detail: { received: st.data.length } });
      st.data = Buffer.concat([st.data, data]);
      if (st.puts === lose) throw new Error("réponse perdue");
      return res(200, { received: st.data.length });
    },
  };
  return { st, request };
}

/** Fichier de trois morceaux (8 Mo), écrit une seule fois pour tous les tests et supprimé à la fin : rien ne reste dans
 *  %TEMP%. Les envois ne font que le lire. */
const BIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "map3d-up-"));
after(() => fs.rmSync(BIG_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const BIG = { file: path.join(BIG_DIR, "gray.glb"), data: Buffer.alloc(2 * CHUNK + 1000) };
for (let k = 0; k < BIG.data.length; k++) BIG.data[k] = k % 251;
fs.writeFileSync(BIG.file, BIG.data);
const bigFile = () => BIG;
const META = { build: "2000873", exported_at: "2026-10-26T18:00:00Z", tool: "map3d 1", world_to_model: [], checks: {} };
const send = (request, file, meta = META) =>
  uploadVariant({ request, site: "http://x", map: "de_nuke", variant: "gray", file, meta, wait: async () => {} });

test("envoi complet malgré une coupure", async () => {
  const { file, data } = bigFile(), { st, request } = fakeServer({ cut: 2 });
  const out = await send(request, file);
  assert.ok(st.data.equals(data) && st.completed && out.variants.gray.url.endsWith(".glb"));
  assert.equal(st.begun.size, data.length);
  assert.match(st.begun.sha256, /^[0-9a-f]{64}$/);
  assert.equal(st.puts, 4);  // 3 morceaux + 1 nouvel essai
});

test("reprise : seuls les morceaux manquants partent", async () => {
  const { file, data } = bigFile(), { st, request } = fakeServer({ have: data.subarray(0, CHUNK) });
  await send(request, file);
  assert.ok(st.data.equals(data));
  assert.equal(st.puts, 2);
});

test("réponse perdue : le 409 du serveur donne où reprendre", async () => {
  const { file, data } = bigFile(), { st, request } = fakeServer({ lose: 2 });
  await send(request, file);
  assert.ok(st.data.equals(data) && st.completed);
  assert.equal(st.puts, 4);  // 2e morceau écrit sans réponse, nouvel essai → 409 { received }, puis le 3e
});

test("relance avec exported_at différent : reprise là où le serveur en est", async () => {
  const { file, data } = bigFile(), { st, request } = fakeServer({ downAfter: 1 });
  await assert.rejects(send(request, file), /Envoi interrompu à 4194304 octets : relancez/);
  st.downAfter = Infinity;
  const puts = st.puts;
  await send(request, file, { ...META, exported_at: "2026-10-26T18:05:00Z" });
  assert.ok(st.data.equals(data) && st.completed);
  assert.equal(st.puts - puts, 2);  // seuls les deux morceaux manquants
});

test("401, 403, 413 et 507 : pas de nouvel essai, le motif du serveur est affiché", async () => {
  const { file } = bigFile();
  for (const [code, detail] of [[401, "Connexion requise"], [403, "Réservé aux administrateurs de l'équipe"], [413, "Morceau trop gros"],
    [507, "Place insuffisante sur le serveur pour cette carte 3D"]]) {
    const { st, request } = fakeServer({ putStatus: [code, { detail }] });
    await assert.rejects(send(request, file), (e) => e.message.includes(`(${code})`) && e.message.includes(detail));
    assert.equal(st.puts, 1);
  }
});

test("réponse qui n'est pas du JSON (502 d'un proxy) : le code HTTP est cité", async () => {
  const { file } = bigFile(), { request } = fakeServer({ beginStatus: [502, "<html><h1>502 Bad Gateway</h1></html>"] });
  await assert.rejects(send(request, file), (e) => /\(502\)/.test(e.message) && !/JSON/.test(e.message));
});

/** Réponse au format de fetch, pour la vérification du site avant l'export. */
const fetched = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

test("avant l'export : module 3D absent → arrêt avec la marche à suivre", async () => {
  await assert.rejects(checkSite("https://x", async () => fetched(200, { ok: true, version: "1", modules: ["teamspeak"] })),
    { message: 'Le module 3D n\'est pas activé sur https://x : ajoutez "replay3d" à modules dans config.toml puis redémarrez le site.' });
  await checkSite("https://x", async (url) => { assert.equal(url, "https://x/api/health"); return fetched(200, { ok: true, modules: ["replay3d"] }); });
});

test("avant l'export : site injoignable ou qui n'est pas Sightline → message clair", async () => {
  await assert.rejects(checkSite("https://x", async () => fetched(502, "<html>Bad Gateway</html>")), /https:\/\/x.*502/);
  await assert.rejects(checkSite("https://x", async () => fetched(200, "<!doctype html><html></html>")), /https:\/\/x.*Sightline/);
  await assert.rejects(checkSite("https://x", async () => { throw new TypeError("fetch failed"); }), /injoignable.*https:\/\/x/);
  // localhost (IPv4 puis IPv6) : la cause est une AggregateError sans message, mais avec un code
  const refused = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
  await assert.rejects(checkSite("http://localhost:8100", async () => { throw new TypeError("fetch failed", { cause: refused }); }),
    /injoignable \(http:\/\/localhost:8100\) : ECONNREFUSED/);
});

test("après la connexion : seuls propriétaire et admin peuvent envoyer", () => {
  assert.throws(() => checkAdmin({ user: { username: "bob", role: "member" } }), /bob.*member.*propriétaire ou admin/);
  checkAdmin({ user: { username: "paul", role: "owner" } });
  checkAdmin({ user: { username: "lea", role: "admin" } });
  checkAdmin({ user: null, setup_required: true });  // mode ouvert (aucun compte, en local) : le serveur tranche
});

test("fichiers 3D (bras, armes) : même envoi sous /api/assets3d", async () => {
  const { file, data } = bigFile(), { st, request } = fakeServer(), urls = [];
  const spy = { post: (u, o) => { urls.push(`POST ${u.replace(/[0-9a-f]{32}/, "<id>")}`); return request.post(u, o); },
    put: (u, o) => { urls.push(`PUT ${u.replace(/[0-9a-f]{32}/, "<id>")}`); return request.put(u, o); } };
  await uploadFile({ request: spy, base: "http://x/api/assets3d", begin: "vue/arme-ak47/upload", file,
    meta: { build: "2000935", exported_at: "2026-10-30T10:00:00Z", tool: "vue 1" }, wait: async () => {} });
  assert.ok(st.data.equals(data) && st.completed);
  assert.deepEqual(urls, ["POST http://x/api/assets3d/vue/arme-ak47/upload", "PUT http://x/api/assets3d/uploads/<id>?offset=0",
    `PUT http://x/api/assets3d/uploads/<id>?offset=${CHUNK}`, `PUT http://x/api/assets3d/uploads/<id>?offset=${2 * CHUNK}`,
    "POST http://x/api/assets3d/uploads/<id>/complete"]);
  assert.throws(() => checkAdmin({ user: { username: "bob", role: "member" } }, "", "de fichiers 3D"), /bob \(member\) ne peut pas envoyer de fichiers 3D/);
});
