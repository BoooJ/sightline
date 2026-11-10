/** Fichiers 3D (.glb des cartes et de la vue du joueur) gardés dans le navigateur d'une visite à l'autre (Cache Storage).
 *  Leur adresse change avec leur contenu (`<nom>-<sha12>.glb`, servis « immutable ») : une copie vaut tant que cette
 *  adresse est demandée. Le cache HTTP ne suffit pas : Chromium n'y garde pas un fichier de 42 Mo (texturée de Dust2,
 *  retéléchargée à chaque visite et même après une relance du navigateur, mesure CACHE3D), et il le partage avec tous les
 *  sites. Seuls les membres connectés reçoivent ces fichiers : tout est effacé à la déconnexion (`forgetFiles3d`).
 *  Tout échec du stockage (Cache Storage absent hors HTTPS et localhost, refusé en navigation privée, quota plein) revient
 *  à télécharger comme avant : jamais une erreur de chargement à cause de lui. Rien de three.js ici : l'en-tête de
 *  l'application l'importe pour la déconnexion. */

export const FILES3D_CACHE = "sightline-3d-1";  // nom à changer si la forme des copies change
/** Cartes gardées, des plus récemment téléchargées aux plus anciennes, tant que leur total reste sous ce budget (la
 *  dernière toujours) : les 7 cartes en compétition à 55-70 Mo chacune, grise et texturée (Dust2 : 12 + 42,5 Mo). Les
 *  fichiers « vue » (≈ 47 Mo en tout) n'y comptent pas : une seule version de chacun est gardée. */
export const MAP_BUDGET = 500 * 1024 ** 2;
const LIMIT_MS = 2000;  // déconnexion : effacement attendu au plus ce temps avant d'ouvrir la page de connexion
const SAVED = "x-saved", SIZE = "x-size";  // en-têtes de la copie : date du téléchargement, taille

/** Cache des fichiers 3D ; null s'il n'existe pas ici (contexte non sécurisé) ou s'il est refusé. */
export async function openFiles3d(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(FILES3D_CACHE);
  } catch {
    return null;
  }
}

/** Copie entière : taille du manifeste, en-tête glTF 2 (« glTF », version 2) et longueur qu'il annonce. */
export function isGlb(b: Uint8Array, size: number): boolean {
  if (b.length !== size || b.length < 12) return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return v.getUint32(0, true) === 0x46546c67 && v.getUint32(4, true) === 2 && v.getUint32(8, true) === b.length;
}

/** Garde la copie de `url` (vérifiée avant par l'appelant : `isGlb`), puis fait le ménage ; ne lève jamais (quota
 *  plein : pas gardée). `budget` : MAP_BUDGET, réduit dans les tests. */
export async function keepFile3d(c: Cache, url: string, bytes: Uint8Array<ArrayBuffer>, budget = MAP_BUDGET): Promise<void> {
  try {
    await c.put(url, new Response(bytes, { headers: { "content-type": "model/gltf-binary", [SAVED]: String(Date.now()),
      [SIZE]: String(bytes.length) } }));
    await prune(c, url, budget);
  } catch {
    /* pas gardée, ou ménage remis au prochain fichier gardé */
  }
}

// adresse sans la somme du contenu : « /api/maps3d/de_dust2/gray », « /api/assets3d/vue/bras-ct »
const nameOf = (path: string) => /^(.*)-[0-9a-f]{12}\.glb$/.exec(path)?.[1] ?? path;
const mapOf = (path: string) => /^\/api\/maps3d\/([^/]+)\//.exec(path)?.[1] ?? null;
const pathOf = (url: string) => new URL(url, "http://localhost").pathname;

/** Anciennes versions du fichier `url` effacées ; cartes au-delà du budget effacées (grise et texturée ensemble), les
 *  moins récemment téléchargées d'abord, jamais celle de `url`. */
async function prune(c: Cache, url: string, budget: number) {
  const me = pathOf(url), gone: Request[] = [];
  const maps = new Map<string, { at: number; order: number; size: number; keys: Request[] }>();
  for (const [order, k] of (await c.keys()).entries()) {
    const p = pathOf(k.url), m = mapOf(p);
    if (p !== me && nameOf(p) === nameOf(me)) gone.push(k);
    else if (m) {
      const e = maps.get(m) ?? { at: 0, order: 0, size: 0, keys: [] }, h = (await c.match(k))?.headers;
      e.at = Math.max(e.at, Number(h?.get(SAVED)) || 0);
      e.order = order;  // à date égale : rangée après dans le cache, donc plus récente
      e.size += Number(h?.get(SIZE)) || 0;
      e.keys.push(k);
      maps.set(m, e);
    }
  }
  const mine = mapOf(me);
  const recent = [...maps].sort(([a, x], [b, y]) => Number(b === mine) - Number(a === mine) || y.at - x.at || y.order - x.order);
  let total = 0;
  for (const [i, [, e]] of recent.entries()) {
    total += e.size;
    if (total > budget && i > 0) gone.push(...e.keys);
  }
  await Promise.all(gone.map((k) => c.delete(k)));
}

/** Déconnexion : copies effacées, rien des fichiers de l'équipe ne reste dans le navigateur ; ne lève jamais et n'attend
 *  pas plus de 2 s (la page de connexion s'ouvre quand même). */
export async function forgetFiles3d(): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    await Promise.race([caches.delete(FILES3D_CACHE), new Promise((done) => setTimeout(done, LIMIT_MS))]);
  } catch {
    /* stockage refusé : rien n'a pu y être gardé */
  }
}
