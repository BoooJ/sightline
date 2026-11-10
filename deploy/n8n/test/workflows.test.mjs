// Exécute le code des nœuds Code des workflows (tel qu'il est dans le JSON importé dans n8n) avec un faux contexte n8n.
// Lancer : node --test deploy/n8n/test/workflows.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = (f) => JSON.parse(readFileSync(new URL(`../workflows/${f}`, import.meta.url), "utf8"));
const W0 = load("w0-erreurs.json");
const W1 = load("w1-pracc.json");
const W2 = load("w2-discord.json");
const W4 = load("w4-formulaire.json");
const W5 = load("w5-prep.json");
const W6 = load("w6-faceit.json");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function run(wf, name, items, { nodes = {}, state = {} } = {}) {
  const code = wf.nodes.find((n) => n.name === name).parameters.jsCode;
  const wrap = (list) => ({ first: () => ({ json: list[0] }), all: () => list.map((json) => ({ json })) });
  return new AsyncFunction("$input", "$", "$getWorkflowStaticData", code)(wrap(items), (n) => wrap(nodes[n]), () => state);
}

const PRACC = [
  { Uid: "old", CreatedAt: "2026-11-01T20:00:00Z", Uploaded: true, DownloadUrl: "/api/team/server/demos/old/download",
    Team: { ID: 7, Name: "Into The Horse" }, OtherTeam: { ID: 11, Name: "Rivals" } },
  { Uid: "new", CreatedAt: "2026-11-20T20:00:00Z", Uploaded: true, DownloadUrl: "/api/team/server/demos/new/download",
    Team: { ID: 12, Name: "Hosts" }, OtherTeam: { ID: 7, Name: "Into The Horse" } },
  { Uid: "pending", CreatedAt: "2026-11-21T20:00:00Z", Uploaded: false, DownloadUrl: "/x",
    Team: { ID: 7, Name: "Into The Horse" }, OtherTeam: { ID: 13, Name: "Late" } },
];

test("W1 : rien pendant le backup OVH (05:00–07:30 UTC), mais toujours une réponse", async () => {
  for (const [t, quiet] of [["05:15", true], ["06:15", true], ["07:29", true], ["07:30", false], ["04:59", false]]) {
    const out = await run(W1, "Hors backup", [{ timestamp: `2026-10-22T${t}:00Z`, body: { step: "list", statusCode: 200, body: PRACC } }]);
    assert.equal(out.length, 1, t);
    assert.equal(out[0].json.quiet, quiet, t);
    assert.deepEqual([out[0].json.statusCode, out[0].json.body], [200, PRACC], t); // la réponse de PRACC passe à « Trier »
  }
});

test("W1 : session expirée détectée", async () => {
  const [out] = await run(W1, "Trier", [{ statusCode: 401, body: { error: "not_authenticated" } }]);
  assert.equal(out.json.expired, true);
});

test("W1 : démos envoyées, les plus récentes d'abord, adversaire = l'autre équipe", async () => {
  const state = { praccAlertAt: 123 };
  const [out] = await run(W1, "Trier", [{ statusCode: 200, body: PRACC }], { state });
  assert.deepEqual(out.json.uids, ["new", "old"]);
  assert.deepEqual(out.json.demos.map((d) => d.opponent), ["Hosts", "Rivals"]);
  assert.equal(out.json.demos[0].downloadUrl, "https://pracc.com/api/team/server/demos/new/download");
  assert.equal(state.praccAlertAt, undefined); // session valide : la prochaine expiration sera signalée
});

test("W1 : corps PRACC en texte = même résultat qu'un tableau", async () => {
  const [a] = await run(W1, "Trier", [{ statusCode: 200, body: PRACC }]);
  const [b] = await run(W1, "Trier", [{ statusCode: 200, body: JSON.stringify(PRACC) }]);
  assert.deepEqual(b.json, a.json);
});

test("W1 : 200 identifiants au plus, les plus récents", async () => {
  const many = Array.from({ length: 260 }, (_, i) => ({ Uid: `u${i}`, CreatedAt: `2027-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    Uploaded: true, DownloadUrl: `/d/${i}`, Team: { ID: 7 }, OtherTeam: { ID: 8 } }));
  many.push({ Uid: "latest", CreatedAt: "2028-01-01T00:00:00Z", Uploaded: true, DownloadUrl: "/d/l", Team: { ID: 7 }, OtherTeam: { ID: 8 } });
  const [out] = await run(W1, "Trier", [{ statusCode: 200, body: many }]);
  assert.equal(out.json.uids.length, 200);
  assert.equal(out.json.uids[0], "latest");
});

test("W1 : pas d'arriéré, seulement les pracs créés après la mise en service", async () => {
  const mk = (Uid, CreatedAt) => ({ Uid, CreatedAt, Uploaded: true, DownloadUrl: `/d/${Uid}`, Team: { ID: 7 }, OtherTeam: { ID: 8 } });
  const [out] = await run(W1, "Trier", [{ statusCode: 200, body: [
    mk("avant", "2026-10-23T02:44:59Z"), mk("pile", "2026-10-23T02:45:00Z"), mk("apres", "2026-10-24T18:00:00Z"),
    mk("illisible", "hier soir"), mk("absente", undefined),
  ] }]);
  assert.deepEqual(out.json.uids, ["apres", "pile"]);
});

test("W1 : l'extension n'ouvre que des liens pracc.com", async () => {
  const mk = (Uid, DownloadUrl) => ({ Uid, CreatedAt: "2026-11-20T20:00:00Z", Uploaded: true, DownloadUrl, Team: { ID: 7 }, OtherTeam: { ID: 8 } });
  const [out] = await run(W1, "Trier", [{ statusCode: 200, body: [
    mk("rel", "/api/x"), mk("abs", "https://pracc.com/api/y"), mk("evil", "https://evil.example/z"),
    mk("proto", "//evil.example/z"), mk("lookalike", "https://pracc.com.evil.example/z"), mk("plain", "http://pracc.com/z"),
  ] }]);
  assert.deepEqual(out.json.uids.sort(), ["abs", "rel"]);
});

test("W1 : autre réponse de PRACC = erreur (W0 la poste sur Discord)", async () => {
  await assert.rejects(run(W1, "Trier", [{ statusCode: 500, body: "oops" }]), /PRACC a répondu 500/);
});

test("W1 : alerte de session une fois par jour", async () => {
  const state = {};
  assert.equal((await run(W1, "Alerte (1 par jour)", [{}], { state })).length, 1);
  assert.equal((await run(W1, "Alerte (1 par jour)", [{}], { state })).length, 0);
  state.praccAlertAt -= 25 * 3600 * 1000;
  assert.equal((await run(W1, "Alerte (1 par jour)", [{}], { state })).length, 1);
});

test("W1 : seulement les inconnus, 3 au plus, en une seule réponse", async () => {
  const demos = ["a", "b", "c", "d", "e"].map((uid) => ({ uid }));
  const out = await run(W1, "À récupérer (3 max)", [{ known: ["b"] }], { nodes: { Trier: [{ demos }] } });
  assert.deepEqual(out.map((i) => i.json.fetch.map((d) => d.uid)), [["a", "c", "d"]]);
  const none = await run(W1, "À récupérer (3 max)", [{ known: ["a"] }], { nodes: { Trier: [{ demos: [{ uid: "a" }] }] } });
  assert.deepEqual(none.map((i) => i.json), [{ fetch: [] }]); // rien de neuf : l'extension reçoit quand même sa réponse
});

const imp = (items) => run(W1, "Préparer l'import", [{ body: { step: "import", items } }]);

test("W1 : import à partir du lien de stockage renvoyé par l'extension", async () => {
  const out = await imp([
    { uid: "new", createdAt: "2026-10-20T19:53:42.812684+02:00", opponent: "Hosts", storageUrl: "https://fsn1.your-objectstorage.com/d/new.dem.bz2?X-Amz-Signature=1" },
    { uid: "sans-lien", createdAt: "2026-10-20T20:00:00Z", opponent: "X" },
  ]);
  assert.deepEqual(out.map((i) => i.json), [{
    url: "https://fsn1.your-objectstorage.com/d/new.dem.bz2?X-Amz-Signature=1", source: "pracc", external_id: "new",
    label: { folder: "PRACC", played_on: "2026-10-20", tags: ["pracc", "Hosts"], opponent: "Hosts" },
  }]);
});

test("W1 : import refusé si le lien n'est pas https, sans identifiant, ou au-delà de 3", async () => {
  const mk = (uid, storageUrl) => ({ uid, createdAt: "2026-10-24T18:00:00Z", opponent: "X", storageUrl });
  assert.deepEqual((await imp([mk("a", "http://s.example/x"), mk("", "https://s.example/x"), mk("b", "pas un lien")])).length, 0);
  const four = await imp(["a", "b", "c", "d"].map((u) => mk(u, `https://s.example/${u}`)));
  assert.deepEqual(four.map((i) => i.json.external_id), ["a", "b", "c"]);
  assert.deepEqual(await imp(undefined), []);
});

test("W1 : étiquette valide (nom de 80 caractères, date non ISO)", async () => {
  const mk = (createdAt) => [{ uid: "r", createdAt, opponent: "A".repeat(80), storageUrl: "https://s.example/x.dem" }];
  const [a] = await imp(mk("Tue, 20 Oct 2026 22:30:00 GMT"));
  assert.equal(a.json.label.opponent.length, 64);
  assert.deepEqual(a.json.label.tags, ["pracc", "A".repeat(64)]);
  assert.equal(a.json.label.played_on, "2026-10-20");
  const [b] = await imp(mk("pas une date"));
  assert.equal(b.json.label.played_on, null);
});

test("W2 : un message par événement", async () => {
  const msg = async (event, data) => (await run(W2, "Message", [{ body: { event, data } }]))[0]?.json;
  assert.match((await msg("demo.imported", { opponent: "Rivals" })).content, /prac contre Rivals/);
  assert.match((await msg("demo.failed", { source: "pracc", external_id: "u1", error: "expiré" })).content, /pracc u1.*expiré/);
  assert.equal((await msg("comms.ready", { title: "Into The Horse 13–9 M33", tracks: 4, path: "/matches/7" })).content,
    "🎙 Comms ajoutées : Into The Horse 13–9 M33 · 4 pistes TeamSpeak · https://sightline.example.com/matches/7");
  assert.match((await msg("comms.ready", { title: "ITH 13–9 M33", tracks: 1, path: "/matches/7" })).content, /· 1 piste TeamSpeak ·/);
  assert.match((await msg("ping", {})).content, /relié à n8n/);
  assert.equal(await msg("inconnu", {}), undefined);
  const ready = { match_id: 4, teams: ["ITH", "Rivals"], score: [13, 9], map: "de_mirage", map_name: "Mirage",
                  kind: "practice", path: "/matches/4", url: null };
  const m = await msg("match.ready", { ...ready, our_team: "ITH", our_team_id: 7 });
  assert.deepEqual(m, { isMatch: true, match_id: 4, kind: "practice", our_team: "ITH", our_team_id: 7, title: "ITH 13–9 Rivals · Mirage",
                        url: "https://sightline.example.com/matches/4" });
  // match d'une autre équipe (scouting) : une ligne, pas de débrief ni d'appel à Claude
  assert.deepEqual(await msg("match.ready", { ...ready, our_team: null, our_team_id: null }),
                   { isMatch: false, content: "🎯 Match analysé : ITH 13–9 Rivals · Mirage · https://sightline.example.com/matches/4" });
});

test("W2 : embed avec ou sans résumé de Claude", async () => {
  const nodes = { Message: [{ title: "ITH 13–9 Rivals · Mirage", url: "https://sightline.example.com/matches/4", kind: "practice" }] };
  const [ok] = await run(W2, "Embed", [{ text: "Ligne 1\nLigne 2" }], { nodes });
  assert.equal(ok.json.embed.description, "Ligne 1\nLigne 2");
  assert.equal(ok.json.embed.footer.text, "Prac · Sightline");
  const [ko] = await run(W2, "Embed", [{ error: "timeout" }], { nodes });
  assert.match(ko.json.embed.description, /Analyse terminée/);
});

test("W2 : débrief et stats donnés à Claude en un seul texte, partie en erreur omise", async () => {
  const Message = [{ match_id: 18, title: "TMN 13–10 ITH · Ancient" }];
  const [both] = await run(W2, "Données du match", [{}], { nodes: { Message, "Débrief": [{ phases: [1] }], Stats: [{ players: [] }] } });
  assert.match(both.json.prompt, /n°18 : TMN 13–10 ITH · Ancient/);
  assert.ok(both.json.prompt.includes('Débrief (JSON) : {"phases":[1]}'));
  assert.ok(both.json.prompt.includes('Stats (JSON) : {"players":[]}'));
  assert.ok(!both.json.prompt.includes("Notre équipe")); // inconnue : résumé neutre
  const [ours] = await run(W2, "Données du match", [{}],
    { nodes: { Message: [{ ...Message[0], our_team: "Into The Horse" }], "Débrief": [{}], Stats: [{}] } });
  assert.ok(ours.json.prompt.includes("Notre équipe, celle qui lit ce salon : Into The Horse."));
  const [noDebrief] = await run(W2, "Données du match", [{}],
    { nodes: { Message, "Débrief": [{ error: { message: "404" } }], Stats: [{ players: [], big: "x".repeat(20000) }] } });
  assert.ok(!noDebrief.json.prompt.includes("Débrief"));
  assert.ok(noDebrief.json.prompt.length < 10000); // stats tronquées
});

test("W2 : messages bornés et sans mention", async () => {
  const Z = String.fromCharCode(0x200b);
  const msg = async (event, data) => (await run(W2, "Message", [{ body: { event, data } }]))[0].json;
  assert.equal((await msg("demo.failed", { error: "@everyone " + "x".repeat(3000) })).content.length, 1900);
  assert.ok(!(await msg("demo.imported", { opponent: "@here" })).content.includes("@here"));
  assert.ok((await msg("demo.imported", { opponent: "@here" })).content.includes("@" + Z + "here"));
  const nodes = { Message: [{ title: "T".repeat(500), url: "https://x", kind: "official" }] };
  const [e] = await run(W2, "Embed", [{ text: "@everyone " + "y".repeat(5000) }], { nodes });
  assert.equal(e.json.embed.title.length, 256);
  assert.equal(e.json.embed.description.length, 4000);
  assert.ok(e.json.embed.description.startsWith("@" + Z + "everyone"));
});

test("W0 : mention neutralisée", async () => {
  const [o] = await run(W0, "Message d'erreur", [{ workflow: { name: "W1" }, execution: { lastNodeExecuted: "N", error: { message: "@everyone" } } }]);
  assert.ok(!o.json.content.includes("@everyone"));
});

test("W2 : débrief demandé pour notre équipe quand elle est connue", () => {
  const url = W2.nodes.find((n) => n.name === "Débrief").parameters.url;
  assert.ok(url.includes("/debrief{{ $('Message').first().json.our_team_id ? '?team=' + $('Message').first().json.our_team_id : '' }}"));
});

test("W4 : le fichier du formulaire part sous le nom « demo », adversaire facultatif", async () => {
  const file = { fileName: "ith-vs-rivals.dem", id: "filesystem-v2:abc" };
  const fileRun = (json, binary) => {
    const code = W4.nodes.find((n) => n.name === "Fichier").parameters.jsCode;
    const input = { first: () => ({ json, binary }) };
    return new AsyncFunction("$input", code)(input);
  };
  const [a] = await fileRun({ opponent: "  Rivals  " }, { "Démo": file });
  assert.deepEqual(a, { json: { opponent: "Rivals" }, binary: { demo: file } });
  const [b] = await fileRun({}, { demo: file });
  assert.equal(b.json.opponent, "");
  await assert.rejects(fileRun({ opponent: "x" }, {}), /Aucune démo/);
});

test("W1 : notre équipe gardée pour l'étape calendrier", async () => {
  const state = {};
  await run(W1, "Trier", [{ statusCode: 200, body: PRACC }], { state });
  assert.equal(state.praccTeamId, 7); // Into The Horse, présente dans tous les pracs
});

test("W1 : calendrier PRACC → événements Sightline (ESEA et pracs réservés)", async () => {
  const body = {
    Events: [{ ID: 41, Time: "2026-10-28T20:30:00+01:00", Title: "ESEA vs. mskLANERS", ExternalSource: "faceit_esea",
               Description: "Competition: S59 EU Main B\nBest of: 1", ExternalUrl: "https://www.faceit.com/x" },
             { ID: 42, Time: "2026-10-29T18:00:00+01:00", Title: "Réunion", ExternalSource: "" }],
    Matches: [{ ID: 9, Time: "2026-10-26T20:00:00+01:00", Team: { ID: 7, Name: "Into The Horse" }, OtherTeam: { ID: 12, Name: "Rivals" } }],
  };
  const [out] = await run(W1, "Calendrier PRACC", [{ body: { step: "calendar", statusCode: 200, body } }], { state: { praccTeamId: 7 } });
  assert.equal(out.json.source, "pracc");
  assert.deepEqual(out.json.events.map((e) => [e.external_id, e.kind, e.opponent]),
                   [["event-41", "match", "mskLANERS"], ["event-42", "other", ""], ["match-9", "scrim", "Rivals"]]);
  assert.equal(out.json.events[2].title, "Prac vs. Rivals");
  assert.match(out.json.events[0].notes, /S59 EU Main B[\s\S]*faceit\.com/);
  // session expirée ou réponse inattendue : rien d'envoyé (le calendrier n'est jamais vidé par erreur)
  for (const sent of [{ statusCode: 401, body: null }, { statusCode: 200, body: { Matches: [] } }, { statusCode: 200, body: "oops" }]) {
    assert.deepEqual(await run(W1, "Calendrier PRACC", [{ body: { step: "calendar", ...sent } }]), [], JSON.stringify(sent));
  }
});

test("W5 : prép d'avant-match, heure Discord dans le fuseau de chacun", async () => {
  const ev = { title: "ESEA vs. mskLANERS", kind: "match", opponent: "mskLANERS", starts_at: "2026-10-28T19:30:00Z",
               notes: "Competition: S59 EU Main B\nBest of: 1\nhttps://www.faceit.com/x", url: "https://sightline.example.com/calendar",
               history: { win: 1, loss: 1, draw: 0, matches: [
                 { map: "Mirage", score: [13, 9], result: "win", date: "2026-10-01", url: "https://sightline.example.com/matches/3" },
                 { map: "Nuke", score: [10, 13], result: "loss", date: "2026-09-20", url: null }] },
               their_maps: [{ map: "Ancient", count: 3 }, { map: "Nuke", count: 2 }] };
  const [m] = await run(W5, "Messages de prép", [{ events: [ev] }]);
  assert.equal(m.json.content, "📅 Match officiel dans 24 h");
  assert.equal(m.json.embed.title, "Match officiel contre mskLANERS");
  const d = m.json.embed.description;
  assert.ok(d.includes(`<t:${Date.parse("2026-10-28T19:30:00Z") / 1000}:F>`));
  assert.ok(d.includes("Competition: S59 EU Main B · Best of: 1") && !d.includes("faceit.com"));
  assert.ok(d.includes("**Contre eux** : 1 V – 1 D") && d.includes("✅ Mirage 13–9 · 2026-10-01 · [revoir](https://sightline.example.com/matches/3)"));
  assert.ok(d.includes("**Leurs cartes** (dans nos démos) : Ancient ×3 · Nuke ×2"));
  assert.ok(!d.includes("Cartes probables")); // pas un match FACEIT : pas d'estimation
  const likely_maps = { them: 4, us: 22, few: true, maps: [
    { map: "de_dust2", name: "Dust II", pct: 36, played: 2, won: 2 }, { map: "de_mirage", name: "Mirage", pct: 24, played: 1, won: 0 },
    { map: "de_nuke", name: "Nuke", pct: 12, played: 0, won: 0 }, { map: "de_anubis", name: "Anubis", pct: 2, played: 0, won: 0 }] };
  const [f] = await run(W5, "Messages de prép", [{ events: [{ ...ev, likely_maps }] }]);
  const fd = f.json.embed.description;
  assert.ok(fd.includes("**Cartes probables** : Dust II 36 % · Mirage 24 % · Nuke 12 %") && !fd.includes("Anubis"), fd);
  assert.ok(fd.includes("Leur bilan ESEA : Dust II 2/2 · Mirage 0/1"));
  assert.ok(fd.includes("leurs 4 matchs ESEA et nos 22 : peu de matchs"));
  const [none] = await run(W5, "Messages de prép", [{ events: [{ ...ev, kind: "scrim", opponent: "@everyone", history: {}, their_maps: [] }] }]);
  assert.ok(none.json.embed.description.includes("Pas encore de match contre eux"));
  assert.ok(!none.json.embed.title.includes("@everyone"));
  assert.deepEqual(await run(W5, "Messages de prép", [{ events: [] }]), []);
});

test("W6 : un message par horaire déplacé, une alerte par jour au plus si FACEIT ne répond pas", async () => {
  const state = { faceitAlertAt: 1 };
  const moved = [{ title: "ESEA vs. mskLANERS", opponent: "mskLANERS", before: "2026-10-28T19:30:00Z", after: "2026-10-29T20:00:00Z" }];
  const [m] = await run(W6, "Horaires déplacés", [{ created: 0, updated: 1, removed: 0, moved }], { state });
  const [b, a] = [Date.parse(moved[0].before) / 1000, Date.parse(moved[0].after) / 1000];
  assert.equal(m.json.content, `⏰ **ESEA vs. mskLANERS** déplacé : ~~<t:${b}:f>~~ → **<t:${a}:F>** (<t:${a}:R>)`);
  assert.equal(state.faceitAlertAt, undefined); // de nouveau joignable
  assert.deepEqual(await run(W6, "Horaires déplacés", [{ created: 3, updated: 0, removed: 0, moved: [] }], { state }), []);
  const [alert] = await run(W6, "Horaires déplacés", [{ error: { message: "502 - FACEIT injoignable" } }], { state });
  assert.match(alert.json.content, /FACEIT injoignable/);
  assert.deepEqual(await run(W6, "Horaires déplacés", [{ error: { message: "encore" } }], { state }), []);
  const [mention] = await run(W6, "Horaires déplacés", [{ moved: [{ ...moved[0], title: "ESEA vs. @everyone" }] }]);
  assert.ok(!mention.json.content.includes("@everyone"));
});

test("W1 : étapes FACEIT aiguillées, alerte de connexion une fois par jour", async () => {
  const sw = W1.nodes.find((n) => n.name === "Étape ?").parameters.output;
  const route = (step) => Function("$json", `return ${sw.replace(/^=\{\{|\}\}$/g, "")}`)({ body: { step } });
  assert.deepEqual(["list", "import", "calendar", "faceit-wanted", "faceit-links", "?"].map(route), [0, 1, 2, 3, 4, 0]);
  assert.equal(Function("$json", `return ${sw.replace(/^=\{\{|\}\}$/g, "")}`)({}), 0);
  const state = {};
  const alert = (status) => run(W1, "Alerte FACEIT (1 par jour)", [{ status }], { state });
  const [a] = await alert("login");
  assert.match(a.json.content, /connecte-toi à faceit\.com/);
  assert.deepEqual(await alert("login"), []); // une fois par jour
  assert.deepEqual(await alert("started"), []);
  assert.equal(state.faceitLoginAt, undefined); // de nouveau connecté : la prochaine déconnexion sera signalée
  assert.equal((await alert("login")).length, 1);
});

test("noeuds Discord : 3 essais espacés de 5 s", () => {
  for (const wf of [W0, W1, W2, W5, W6]) for (const n of wf.nodes.filter((x) => x.type === "n8n-nodes-base.discord")) {
    assert.deepEqual([n.retryOnFail, n.maxTries, n.waitBetweenTries], [true, 3, 5000], n.name);
  }
});
