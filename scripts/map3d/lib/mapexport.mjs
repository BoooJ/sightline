// Fichiers d'une carte (grise, texturée, collision) à partir de l'export de Source 2 Viewer : le flux d'export.mjs, sans
// l'envoi, avec ses dépendances injectables (comme lib/joueurs.mjs) pour être testé sans CS2.
import fs from "node:fs";
import path from "node:path";
import { bombCenters, checkAlignment } from "./align.mjs";
import { buildCollision, collisionArgs, collisionOut } from "./collision.mjs";
import { optimize } from "./optimize.mjs";
import { findExports, runS2v, s2vArgs } from "./s2v.mjs";

const REAL = { runS2v, findExports, checkAlignment, bombCenters, optimize, buildCollision, collisionOut };
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} Mo`;

/** Collision de la carte → `files.collision`. Même repère que la carte (SOURCE_TO_GLTF) : le serveur garde les champs de
 *  tête de la carte (variante collision). */
async function makeCollision({ map, work, exe, vpk, io, files, log }, d) {
  const out = path.join(work, "collision", `${map}.glb`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  d.runS2v(exe, collisionArgs(vpk, map, out));
  const doc = await io.read(d.collisionOut(out)), tris = await d.buildCollision(doc);
  const file = path.join(work, "collision.glb");
  await io.write(file, doc);
  files.collision = file;
  log(`Collision : ${mb(fs.statSync(file).size)}, ${tris} triangles`);
}

/** Produit les fichiers des `variants` dans `work`. Rend { files, checks }. Alignement refusé ou export de la carte en
 *  échec : erreur, rien n'est envoyé. Collision absente ou illisible : avertissement et carte sans collision quand la
 *  grise ou la texturée part avec ; erreur seulement si la collision est seule demandée (--only collision). */
export async function exportMapFiles({ map, mapMeta, variants, work, exe, vpk, io, log = console.log, warn = console.warn }, deps = {}) {
  const d = { ...REAL, ...deps }, files = {}, shown = variants.filter((v) => v !== "collision");
  let checks = {};
  if (shown.length) {
    d.runS2v(exe, s2vArgs(vpk, map, path.join(work, "export", `${map}.gltf`)));
    const { world, physics } = d.findExports(path.join(work, "export"));
    const align = d.checkAlignment(mapMeta, physics ? d.bombCenters(await io.read(physics)) : []);
    log(`Alignement (écart aux sites, unités du jeu) : ${JSON.stringify(align.checks)}`);
    if (!align.ok) throw new Error("Alignement refusé (sites de bombe à plus de 300 unités, ou introuvables) : rien n'est envoyé.");
    checks = align.checks;
    for (const v of shown) {
      files[v] = path.join(work, `${v}.glb`);
      const st = await d.optimize(io, world, files[v], v);
      log(`${v === "gray" ? "Grise" : "Texturée"} : ${mb(st.size)}, ${st.textures} textures`);
    }
  }
  if (variants.includes("collision")) {
    try {
      await makeCollision({ map, work, exe, vpk, io, files, log }, d);
    } catch (e) {
      if (!shown.length || e.interrupted) throw e;
      delete files.collision;
      warn(`Attention : pas de collision pour ${map} : ${e.message.replace(/ : rien n'est envoyé\.?$|\s*rien n'est envoyé\.?$/, "").trim()} ; carte envoyée sans.`);
    }
  }
  return { files, checks };
}
