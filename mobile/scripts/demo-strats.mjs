#!/usr/bin/env node
// Stratégies d'exemple de la démo (src/demo/strats.json), construites à partir des données déjà capturées
// (src/demo/fixtures.json : lineups pros et callouts) : chaque grenade est un vrai lineup, chaque joueur se tient à un
// vrai point de lancer ou au centre d'un lieu du jeu.
//
//   node scripts/demo-strats.mjs
//
// Le script échoue en nommant le lieu quand aucun lineup ne correspond : on corrige la description, on ne livre pas
// une stratégie à trous.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.resolve(dir, "../src/demo/fixtures.json"), "utf8"));
const out = path.resolve(dir, "../src/demo/strats.json");

const MAX_DIST = 900; // comme src/lib/lineups.ts : au-delà, le lieu le plus proche ne décrit plus le point
const ARROW = "#2ee6a6"; // couleur d'accent de l'app
const MAX_TRAJ = 64; // limite du serveur
const MIN_GAP = 110; // unités de jeu : plus près, deux pastilles de joueur se recouvrent sur la carte du téléphone

// grenade : lineup le plus lancé du côté de la stratégie, de ce type, qui atterrit sur `land` (depuis `from` si donné),
// lancé par le joueur n° `by` (indice dans positions), à `at` secondes après le freeze time.
// position : au point de lancer de la grenade n° `nade`, ou au centre du lieu `at` (décalé de `shift` unités) ;
// regarde vers le lieu `look`. arrows : [lieu de départ, lieu d'arrivée].
const STRATS = [
  {
    map: "de_dust2", side: "T", type: "execute", name: "Exécution B", tags: ["b", "exécution", "regroupement"], daysAgo: 2, round: 4,
    description: "Regroupement en tunnel haut à 1:20. Smokes des portes et de l'entrée du site depuis l'extérieur, molotov "
      + "du fond du site, puis flash par-dessus pour l'entrée.\nLe lurk tient mid et coupe la rotation par les portes de mid.\n"
      + "Pose par défaut, post-plant tunnel et portes.",
    grenades: [
      { type: "smoke", land: "BDoors", from: "OutsideTunnel", by: 1, at: 38, note: "Coupe la rotation par les portes" },
      { type: "smoke", land: "BombsiteB", from: "OutsideTunnel", by: 2, at: 39, note: "Cache l'entrée du site" },
      { type: "flash", land: "BombsiteB", from: "UpperTunnel", by: 3, at: 42, note: "Pop flash pour l'entrée" },
      { type: "molotov", land: "Hole", from: "UpperTunnel", by: 0, at: 41, note: "Nettoie le fond du site" },
    ],
    positions: [
      { name: "flameZ", role: "Entry", nade: 3, look: "BombsiteB" },
      { name: "apEX", role: "IGL", nade: 0, look: "BDoors" },
      { name: "ZywOo", role: "AWP", nade: 1, look: "BombsiteB" },
      { name: "mezii", role: "Support", nade: 2, look: "BombsiteB" },
      { name: "ropz", role: "Lurk", at: "Middle", look: "MidDoors" },
    ],
    arrows: [["UpperTunnel", "BombsiteB"], ["Middle", "MidDoors"]],
  },
  {
    map: "de_dust2", side: "CT", type: "setup", name: "2-1-2", tags: ["setup", "standard"], daysAgo: 5,
    description: "Deux joueurs à A (AWP en long, IGL sur la rampe), un au mid depuis le spawn CT, deux à B.\n"
      + "Info en long : smoke des portes, puis flash de reprise.\nLe mid tourne vers B dès que le tunnel est chargé.",
    grenades: [
      { type: "smoke", land: "LongDoors", from: "LongA", by: 0, at: 12, note: "Si le T montre en long" },
      { type: "flash", land: "LongA", from: "ARamp", by: 1, at: 25, note: "Reprise de long" },
      { type: "incendiary", land: "UpperTunnel", from: "BDoors", by: 3, at: 18, note: "Retarde la sortie du tunnel" },
      { type: "he", land: "Middle", from: "CTSpawn", by: 2, at: 6, note: "À l'ouverture" },
    ],
    positions: [
      { name: "ZywOo", role: "AWP", nade: 0, look: "LongDoors" },
      { name: "apEX", role: "IGL", nade: 1, look: "LongA" },
      { name: "ropz", role: "Mid", nade: 3, look: "Middle" },
      { name: "flameZ", role: "Ancre B", nade: 2, look: "UpperTunnel" },
      { name: "mezii", role: "Support B", at: "BombsiteB", look: "UpperTunnel" },
    ],
    arrows: [["CTSpawn", "BombsiteB"]],
  },
  {
    map: "de_inferno", side: "T", type: "default", name: "Default, puis Banane", tags: ["banane", "default", "lent"], daysAgo: 3, round: 9,
    description: "Contrôle de la banane dès 1:47 : molotov, puis flash. Le mid se prend en même temps.\n"
      + "Le lurk reste aux appartements pour l'info A.\nBanane à nous à 1:00 : on enchaîne sur B ; sinon, on rejoue A.",
    grenades: [
      { type: "molotov", land: "Banana", from: "TRamp", by: 0, at: 8, note: "Brûle les CT avancés" },
      { type: "flash", land: "Banana", from: "TRamp", by: 1, at: 10, note: "Pour prendre le contrôle" },
      { type: "smoke", land: "Arch", from: "TRamp", by: 2, at: 28, note: "Contrôle du mid" },
      { type: "flash", land: "TopofMid", from: "TRamp", by: 3, at: 30, note: "Pop flash haut de mid" },
    ],
    positions: [
      { name: "flameZ", role: "Entry", nade: 0, look: "Banana" },
      { name: "mezii", role: "Support", nade: 1, look: "Banana" },
      { name: "apEX", role: "IGL", nade: 2, look: "Arch" },
      { name: "ZywOo", role: "AWP", nade: 3, look: "TopofMid" },
      { name: "ropz", role: "Lurk", at: "Apartments", look: "Balcony" },
    ],
    arrows: [["TRamp", "Banana"], ["Banana", "BombsiteB"]],
  },
  {
    map: "de_inferno", side: "CT", type: "retake", name: "Reprise B", tags: ["b", "post-plant", "reprise"], daysAgo: 9,
    description: "Reprise dès la bombe posée : regroupement au spawn CT et aux ruines.\n"
      + "Smoke et HE sur le site depuis les ruines, flash depuis le spawn, puis entrée ensemble.\n"
      + "L'AWP couvre depuis le spawn, sans entrer.",
    grenades: [
      { type: "smoke", land: "BombsiteB", from: "Ruins", by: 0, at: 78, note: "Coupe la vue depuis la banane" },
      { type: "he", land: "BombsiteB", from: "Ruins", by: 1, at: 80, note: "Sur le défuseur adverse" },
      { type: "flash", land: "BombsiteB", from: "CTSpawn", by: 2, at: 81, note: "L'entrée part sur la flash" },
    ],
    positions: [
      { name: "apEX", role: "IGL", nade: 0, look: "BombsiteB" },
      { name: "flameZ", role: "Entry", nade: 1, look: "BombsiteB" },
      { name: "mezii", role: "Support", nade: 2, look: "BombsiteB" },
      { name: "ZywOo", role: "AWP", at: "CTSpawn", shift: [-200, 0], look: "BombsiteB" },
      { name: "ropz", role: "Rotation", at: "Arch", look: "BombsiteB" },
    ],
    arrows: [["CTSpawn", "BombsiteB"], ["Arch", "BombsiteB"]],
  },
  {
    map: "de_cache", side: "T", type: "rush", name: "Rush A", tags: ["a", "pistol", "rush"], daysAgo: 14, round: 1,
    description: "Rush A dès 1:50, à cinq par le main.\nSmokes de toxic et du connecteur depuis long A, molotov de la "
      + "ventilation, flash du boost pour l'entrée.\nPose par défaut, post-plant main et connecteur.",
    grenades: [
      { type: "smoke", land: "Toxic", from: "LongA", by: 0, at: 6, note: "" },
      { type: "smoke", land: "Connector", from: "LongA", by: 1, at: 7, note: "Coupe la rotation du mid" },
      { type: "flash", land: "Boost", from: "OutsideA", by: 2, at: 9, note: "L'entrée part sur la flash" },
      { type: "molotov", land: "Vents", from: "LongA", by: 3, at: 8, note: "" },
    ],
    positions: [
      { name: "apEX", role: "IGL", nade: 0, look: "BombsiteA" },
      { name: "mezii", role: "Support", nade: 1, look: "Connector" },
      { name: "flameZ", role: "Entry", nade: 2, look: "BombsiteA" },
      { name: "ropz", role: "Trade", nade: 3, look: "BombsiteA" },
      { name: "ZywOo", role: "AWP", at: "AMain", look: "BombsiteA" },
    ],
    arrows: [["AMain", "BombsiteA"]],
  },
];

const round1 = (v) => Math.round(v * 10) / 10;
const sameType = (a, b) => a === b || (["molotov", "incendiary"].includes(a) && ["molotov", "incendiary"].includes(b));

function nearest(places, p) {
  let best = null;
  let bestD = MAX_DIST * MAX_DIST;
  for (const c of places) {
    if (!c.pos) continue;
    const d = (c.pos[0] - p[0]) ** 2 + (c.pos[1] - p[1]) ** 2;
    if (d < bestD) { bestD = d; best = c.place; }
  }
  return best;
}

/** Deux joueurs au même point de lancer : on écarte le second de MIN_GAP, dans l'axe qui les sépare déjà. */
function spread(points) {
  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (let i = 1; i < points.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = points[j], b = points[i];
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (d >= MIN_GAP) continue;
        const [ux, uy] = d > 1 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [1, 0];
        b[0] = round1(a[0] + ux * MIN_GAP);
        b[1] = round1(a[1] + uy * MIN_GAP);
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/** Trajectoire ramenée à MAX_TRAJ points au plus (le premier et le dernier gardés). */
function thin(traj) {
  if (traj.length <= MAX_TRAJ) return traj;
  const step = (traj.length - 1) / (MAX_TRAJ - 1);
  return Array.from({ length: MAX_TRAJ }, (_, i) => traj[Math.round(i * step)]);
}

function build(def, id) {
  const meta = fx.maps.find((m) => m.name === def.map);
  const places = fx.callouts[def.map].places;
  const center = (place) => {
    const c = places.find((x) => x.place === place && x.pos);
    if (!c) throw new Error(`${def.name} : lieu inconnu « ${place} » sur ${def.map}`);
    return c.pos;
  };
  const radar = (v) => [round1((v[0] - meta.pos_x) / meta.scale), round1((meta.pos_y - v[1]) / meta.scale)];
  const lineups = def.grenades.map((g) => {
    const l = fx.grenades[def.map].lineups
      .filter((x) => x.side === def.side && sameType(x.type, g.type) && nearest(places, x.land) === g.land
        && (!g.from || nearest(places, x.throw) === g.from))
      .sort((a, b) => b.count - a.count)[0];
    if (!l) throw new Error(`${def.name} : aucun lineup ${def.side} ${g.type} vers ${g.land}${g.from ? ` depuis ${g.from}` : ""}`);
    return l;
  });
  const spots = def.positions.map((p) => {
    const base = p.nade !== undefined ? lineups[p.nade].throw : center(p.at);
    return [base[0] + (p.shift?.[0] ?? 0), base[1] + (p.shift?.[1] ?? 0), base[2]].map(round1);
  });
  spread(spots);
  const positions = def.positions.map((p, i) => {
    const pos = spots[i];
    const look = center(p.look);
    const yaw = round1((Math.atan2(look[1] - pos[1], look[0] - pos[0]) * 180) / Math.PI);
    return { name: p.name, role: p.role, pos, yaw };
  });
  const grenades = def.grenades.map((g, i) => ({
    type: lineups[i].type, player: positions[g.by].name, note: g.note, throw: lineups[i].throw, land: lineups[i].land,
    setpos: lineups[i].setpos ?? null, timing_s: g.at, trajectory: thin(lineups[i].trajectory),
  }));
  const shapes = def.arrows.map(([a, b], i) => ({
    id: `fleche-${i + 1}`, tool: "arrow", color: ARROW, width: 3, level: "default", points: [radar(center(a)), radar(center(b))],
  }));
  const match = def.round ? Object.values(fx.matches).find((m) => m.map_name === def.map) : undefined;
  return {
    id, name: def.name, map: def.map, side: def.side, type: def.type, tags: [...def.tags].sort(), author: "Démo",
    updated_at: `@-${def.daysAgo}T16:00:00`,
    counts: { positions: positions.length, grenades: grenades.length, shapes: shapes.length },
    description: def.description, positions, grenades, shapes,
    source: match ? { match_id: match.id, round_number: def.round, tick: null } : null,
  };
}

fs.writeFileSync(out, `${JSON.stringify(STRATS.map((d, i) => build(d, i + 1)), null, 2)}\n`);
console.log(`${STRATS.length} stratégies écrites dans ${path.relative(process.cwd(), out)}`);
