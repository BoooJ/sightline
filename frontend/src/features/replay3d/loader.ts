import type { AnimationClip, Object3D } from "three";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { isGlb, keepFile3d, openFiles3d } from "./glbCache";

/** Échec de chargement d'une carte 3D, avec un message en français ; `status` : code HTTP (0 : pas de réponse). */
export class LoadError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

// réseau coupé ou réponse interrompue : le navigateur ne donne qu'un message anglais (« Failed to fetch ») ; une
// annulation (passage en 2D, autre version) reste une AbortError
const cut = (e: unknown) => ((e as Error)?.name === "AbortError" ? e : new LoadError("connexion interrompue"));

type Progress = (got: number, total: number) => void;

// .glb rendus par fetchGlb et gardés dans le navigateur, ou lus depuis lui : de quoi effacer la copie si la lecture du
// fichier échoue et, pour une copie lue depuis le navigateur, retélécharger le fichier une fois (readGlb). Les appelants
// lisent toujours ce que rend fetchGlb (Scene3D : parseGlb, vmLoader : parseGlbAnimated)
const copies = new WeakMap<ArrayBuffer, { forget: () => Promise<unknown>; again?: () => Promise<ArrayBuffer> }>();

/** Corps entier d'une réponse, en suivant la progression. */
async function readAll(r: Response, total: number, onProgress: Progress): Promise<Uint8Array<ArrayBuffer>> {
  const reader = r.body!.getReader(), parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read().catch((e: unknown) => { throw cut(e); });
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Télécharge un .glb en suivant la progression (taille annoncée par le manifeste) ; déjà téléchargé dans ce navigateur
 *  à la même adresse (même contenu) : lu depuis sa copie, sans requête (glbCache.ts). */
export async function fetchGlb(url: string, total: number, onProgress: Progress, signal: AbortSignal): Promise<ArrayBuffer> {
  const c = await openFiles3d();
  const hit = c && await c.match(url).catch(() => undefined);
  if (c && hit) {
    const bytes = hit.body ? await readAll(hit, total, onProgress).catch(() => null) : null;
    signal.throwIfAborted();
    if (bytes && isGlb(bytes, total)) {
      copies.set(bytes.buffer, { forget: () => c.delete(url).catch(() => {}), again: () => download(url, total, onProgress, signal, c) });
      return bytes.buffer;
    }
    await c.delete(url).catch(() => {});  // tronquée ou d'une autre taille : effacée, et le fichier retéléchargé
  }
  return download(url, total, onProgress, signal, c);
}

async function download(url: string, total: number, onProgress: Progress, signal: AbortSignal, c: Cache | null): Promise<ArrayBuffer> {
  const r = await fetch(url, { signal }).catch((e: unknown) => { throw cut(e); });
  // statusText est vide en HTTP/2 : le code seul
  if (!r.ok || !r.body) throw new LoadError(`erreur ${r.status}`, r.status);
  const bytes = await readAll(r, total, onProgress);
  // gardé pour les visites suivantes : réponse 200 entière, de la taille annoncée, et un .glb, servie par l'adresse
  // demandée ; jamais un refus (401, 403), une redirection ni une page servie à la place du fichier. En arrière-plan :
  // la carte s'affiche sans attendre l'écriture
  if (c && r.status === 200 && !r.redirected && isGlb(bytes, total)) {
    const kept = keepFile3d(c, url, bytes);
    copies.set(bytes.buffer, { forget: () => kept.then(() => c.delete(url)).catch(() => {}) });
  }
  return bytes.buffer;
}

/** Lit un .glb (géométrie compressée meshopt comprise) ; `what` : ce qui est lu, pour le journal et le message. */
function readGlb(buf: ArrayBuffer, what: { log: string; message: string }): Promise<GLTF> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // GLTFLoader échoue tantôt par onError, tantôt en levant (JSON illisible), toujours en anglais
  return new Promise<GLTF>((resolve, reject) => loader.parse(buf, "", resolve, reject))
    .catch(async (e: unknown) => {
      // copie gardée dans le navigateur : jamais laissée illisible ; lue depuis lui, le fichier est retéléchargé une fois
      const copy = copies.get(buf);
      copies.delete(buf);
      await copy?.forget();
      if (copy?.again) {
        console.warn("Copie gardée du fichier 3D illisible, fichier retéléchargé :", e);
        return readGlb(await copy.again(), what);
      }
      console.error(what.log, e);
      throw new LoadError(what.message);
    });
}

/** Lit le .glb d'une carte : sa scène seulement. */
export const parseGlb = (buf: ArrayBuffer): Promise<Object3D> =>
  readGlb(buf, { log: "Carte 3D illisible", message: "fichier de carte illisible" }).then((g) => g.scene);

/** Lit un .glb animé (bras, arme de la vue du joueur) : sa scène et ses clips, que parseGlb laisse de côté. */
export const parseGlbAnimated = (buf: ArrayBuffer): Promise<{ scene: Object3D; clips: AnimationClip[] }> =>
  readGlb(buf, { log: "Fichier 3D illisible", message: "fichier 3D illisible" }).then((g) => ({ scene: g.scene, clips: g.animations }));
