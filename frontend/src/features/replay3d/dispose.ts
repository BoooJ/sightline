import type { Material, Object3D, Texture, TextureSource } from "three";

/** Image décodée qu'on peut libérer : ImageBitmap (GLTFLoader, dans les navigateurs qui en font) ou image du DOM (ceux qui
 *  n'en font pas : TextureLoader). Jamais les données des autres textures, relues à chaque envoi : os des maillages à
 *  peau, rendus (reflets des bras), canvas. Les fichiers exportés n'ont pas de textures compressées. */
function decoded(data: unknown): data is ImageBitmap | HTMLImageElement {
  return (typeof ImageBitmap !== "undefined" && data instanceof ImageBitmap)
    || (typeof HTMLImageElement !== "undefined" && data instanceof HTMLImageElement);
}

/** Textures dont l'image a été libérée : three ne peut plus les renvoyer à la carte graphique (contexte perdu puis rendu). */
const freed = new WeakSet<Texture>();

/** Textures des matériaux d'un arbre, chacune une fois. */
function texturesOf(root: Object3D): Set<Texture> {
  const out = new Set<Texture>();
  root.traverse((o) => {
    const m = (o as Object3D & { material?: Material | Material[] }).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : [])
      for (const v of Object.values(mat)) if ((v as Texture | null)?.isTexture) out.add(v as Texture);
  });
  return out;
}

/** Libère l'image décodée d'une texture (ImageBitmap : `close` rend sa mémoire tout de suite, sans attendre le
 *  ramasse-miettes). */
function freeImage(t: Texture) {
  const img = t.source.data;
  if (!decoded(img)) return;
  t.source.data = null;
  if ("close" in img) img.close();
  freed.add(t);
}

/** Libère l'image décodée de chaque texture des matériaux d'un arbre dès son premier envoi à la carte graphique : three ne
 *  la relit plus ensuite, la texture vit sur la carte graphique. Envoi à la demande (premier rendu où la texture est
 *  dessinée, ou `initTexture`) : une texture pas encore dessinée garde la sienne. C'est l'essentiel de la mémoire de la
 *  page en 3D : 4 octets par pixel, environ 300 Mo pour Dust2 texturée. `onUpdate` est appelé par three juste après
 *  l'envoi (`WebGLTextures.uploadTexture`) ; un `onUpdate` déjà posé est gardé.
 *  Ce que three ne peut plus faire ensuite, sans l'image : renvoyer la texture à un nouveau contexte WebGL (perdu puis
 *  rendu : le Viewer relit alors la carte et les bras, `imagesFreed`), ou après un changement de ses réglages
 *  (`needsUpdate`, que rien ne fait ici). Image partagée par plusieurs textures (clones aux réglages différents : three
 *  l'envoie pour chacune) : gardée ; les fichiers exportés n'en ont pas. */
export function freeImagesAfterUpload(root: Object3D) {
  const bySource = new Map<TextureSource<unknown>, Texture[]>();
  for (const t of texturesOf(root)) {
    const same = bySource.get(t.source);
    if (same) same.push(t);
    else bySource.set(t.source, [t]);
  }
  for (const [source, ts] of bySource) {
    if (ts.length !== 1 || !decoded(source.data)) continue;
    const t = ts[0], before = t.onUpdate;
    t.onUpdate = (x) => {
      before?.(x);
      freeImage(x);
    };
  }
}

/** Arbre dessiné dans un contexte graphique perdu depuis : ses ressources sur la carte graphique sont parties avec le
 *  contexte (les libérer ferait avertir le navigateur, « object does not belong to this context »). Seules les images
 *  encore gardées sont fermées ; le reste part avec le ramasse-miettes. */
export function freeImages(root: Object3D) {
  for (const t of texturesOf(root)) freeImage(t);
}

/** Vrai si une image de texture de l'arbre a été libérée : three ne pourrait pas la renvoyer à un nouveau contexte. */
export function imagesFreed(root: Object3D): boolean {
  for (const t of texturesOf(root)) if (freed.has(t)) return true;
  return false;
}

/** Libère géométries, matériaux, textures (leurs images décodées comprises, envoyées ou non) et squelettes (texture des
 *  os des maillages à peau) d'un arbre three.js (viewer.ts le réexporte d'ici). Une texture partagée (reflets de la scène
 *  des bras) doit être retirée du matériau avant. */
export function disposeTree(root: Object3D) {
  root.traverse((o) => {
    const m = o as Object3D & { geometry?: { dispose(): void }; material?: Material | Material[]; skeleton?: { dispose(): void } };
    m.geometry?.dispose();
    m.skeleton?.dispose();  // SkinnedMesh : boneTexture
    for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) {
      for (const v of Object.values(mat)) {
        if (!(v as Texture | null)?.isTexture) continue;
        (v as Texture).dispose();
        freeImage(v as Texture);
      }
      mat.dispose();
    }
  });
}
