#!/usr/bin/env node
// Régénère les données de la démo (src/demo/fixtures.json) depuis un backend Sightline LOCAL dont la bibliothèque ne
// contient que des matchs pro publics (jamais le serveur de l'équipe : tout ce fichier est publié avec l'app).
//
//   node scripts/capture-demo.mjs [http://127.0.0.1:8765] [--joueur ZywOo] [--adversaire MOUZ]
//
// Les dates des matchs sont remplacées par des décalages en jours (« @-3 ») que l'app recalcule à l'ouverture :
// la démo raconte toujours « ton dernier match était hier ».
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? "http://127.0.0.1:8765").replace(/\/$/, "");
const PLAYER = opt("--joueur", "ZywOo");
const OPPONENT = opt("--adversaire", "MOUZ");
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/demo/fixtures.json");

async function get(p) {
  const r = await fetch(base + p);
  if (!r.ok) throw new Error(`${p} : ${r.status}`);
  return r.json();
}
const q = encodeURIComponent;

const players = await get("/api/players");
const me = players.find((p) => p.name === PLAYER) ?? [...players].sort((a, b) => b.rating - a.rating)[0];
const teams = await get("/api/scouting/teams");
const mine = teams.find((t) => t.name === me.team);
const opp = teams.find((t) => t.name === OPPONENT) ?? teams.find((t) => t !== mine);
if (!mine || !opp) throw new Error("équipes introuvables");
const sid = me.steamid;

const profile = await get(`/api/players/${sid}/profile`);
const dashboard = await get(`/api/players/${sid}/dashboard`);
const ids = profile.recent.map((r) => r.match_id);

const matches = {}, analyses = {}, debriefs = {};
for (const id of ids) {
  matches[id] = await get(`/api/matches/${id}`);
  const a = await get(`/api/matches/${id}/analysis`);
  // l'app ne lit que les joueurs et les morts du joueur démo : pas les courbes de chaque round
  analyses[id] = { ...a, rounds: [], key_moments: [], lost_advantages: [], advantages: {},
    economy: { teams: {}, incoherent: [] }, utility: undefined, deaths: a.deaths.filter((d) => d.victim === sid) };
  debriefs[`${id}:${mine.id}`] = await get(`/api/matches/${id}/debrief?team=${mine.id}`);
}
const used = new Set(Object.values(matches).map((m) => m.map_name));
const maps = (await get("/api/maps")).filter((m) => used.has(m.name));

// un lineup lancé une seule fois n'en est pas un ; trajectoires sans les points d'arrivée répétés
const sameVec = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const lineupsOnly = (g) => ({
  throws: [],
  lineups: g.lineups.filter((l) => l.count >= 2)
    .map((l) => ({ ...l, ids: [], trajectory: l.trajectory.filter((p, i, t) => !sameVec(p, t[i - 1])) })),
});

const briefs = {}, grenades = {}, callouts = {};
for (const map of used) {
  briefs[`${opp.id}:${map}`] = await get(`/api/scouting/teams/${opp.id}/brief?map=${q(map)}`);
  for (const team of [null, mine.id, opp.id]) {
    const g = await get(`/api/grenades?map=${q(map)}&lineups=true&throws=false${team ? `&team=${team}` : ""}`);
    grenades[team ? `${map}:${team}` : map] = lineupsOnly(g);
  }
  callouts[map] = await get(`/api/callouts?map=${q(map)}`);
}

const newest = [...ids].sort((a, b) => (matches[b].date ?? "").localeCompare(matches[a].date ?? ""));
const last = matches[newest[0]];
const fixtures = {
  me: { id: 0, username: "demo", display_name: me.name, role: "member", created_at: null, steamid: sid },
  event: { title: last.labels?.event || "Prochain match", opponent: opp.name, maps: [...used], inDays: 2, hour: 20 },
  readyMatchId: last.id,
  readyTitle: `Match prêt : ${last.team_a.name} ${last.score_a}–${last.score_b} ${last.team_b.name}`,
  teams: teams.filter((t) => t.id === opp.id || t.id === mine.id),
  scoutReports: { [opp.id]: await get(`/api/scouting/teams/${opp.id}`) },
  briefs,
  players: players.map(({ steamid, name, team, matches: n, rating }) => ({ steamid, name, team, matches: n, rating })),
  profile, dashboard, matches, analyses, debriefs, maps, grenades, callouts,
  goals: { [mine.id]: await get(`/api/teams/${mine.id}/goals`) },
};

// dates → décalages : le dernier match hier, puis tous les deux jours avant ; le reste (imports, captures) aujourd'hui
const offsets = new Map();
newest.forEach((id, i) => offsets.set((matches[id].date ?? "").slice(0, 10), -(1 + 2 * i)));
const sorted = [...offsets.keys()].sort();
function token(day) {
  if (offsets.has(day)) return offsets.get(day);
  const after = sorted.findIndex((d) => d > day); // entre deux matchs (création d'un objectif) : la veille du suivant
  return after > 0 ? offsets.get(sorted[after]) - 1 : 0;
}
function shift(v) {
  if (typeof v === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})(.*)$/.exec(v);
    return m ? `@${token(m[1])}${m[2]}` : v;
  }
  if (Array.isArray(v)) return v.map(shift);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
  return v;
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const json = JSON.stringify(shift(fixtures));
fs.writeFileSync(out, json);
console.log(`${me.name} (${mine.name}) contre ${opp.name} : ${ids.length} matchs, ${(json.length / 1024).toFixed(0)} Ko → ${out}`);
