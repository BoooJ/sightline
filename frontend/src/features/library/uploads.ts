import { create } from "zustand";
import type { ImportResult } from "../../shared/api/client";

/** Upload par morceaux, reprenable et parallèle (voir backend/app/api/uploads.py). Le store vit au niveau du module :
 *  l'envoi continue quand on navigue ailleurs dans l'application. */
// 2 Mo : sur une connexion lente (0,1 Mo/s), chaque morceau reçu est gardé au bout de ~20 s ; une coupure ne perd presque rien
export const CHUNK = 2 * 1024 * 1024;
/** Morceaux envoyés en même temps : masque la latence réseau (un seul morceau à la fois attend un aller-retour
 *  complet avant le suivant ; sur une connexion lointaine, c'est souvent la moitié du temps). */
export const PARALLEL = 3;
const MAX_RETRIES = 8;

export interface UploadItem {
  id: string; name: string; size: number; sent: number; bps: number;
  status: "queued" | "uploading" | "retrying" | "done" | "error"; error?: string; created?: boolean;
}
interface S { items: Record<string, UploadItem>; patch: (id: string, p: Partial<UploadItem>) => void; clear: (id: string) => void }

export const useUploads = create<S>((set) => ({
  items: {},
  patch: (id, p) => set((s) => ({ items: { ...s.items, [id]: { ...s.items[id], ...p } as UploadItem } })),
  clear: (id) => set((s) => { const items = { ...s.items }; delete items[id]; return { items }; }),
}));

/** Identifiant stable d'un fichier (nom, taille, date) : permet de reprendre après un rechargement de page. */
export function uploadId(f: Pick<File, "name" | "size" | "lastModified">): string {
  const str = `${f.name}|${f.size}|${f.lastModified}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0") + f.size.toString(16);
}

class HttpError extends Error { constructor(readonly status: number, readonly body: unknown, msg: string) { super(msg); } }

async function call(url: string, init: RequestInit): Promise<any> {  // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(url, init);
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new HttpError(r.status, body?.detail, typeof body?.detail === "string" ? body.detail : `${r.status} ${r.statusText}`);
  return body;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Envoie un morceau avec suivi d'octets (XHR : fetch n'expose pas la progression d'upload). */
function putChunk(url: string, blob: Blob, onBytes: (n: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.upload.onprogress = (e) => onBytes(e.loaded);
    x.onload = () => {
      let body: any = null;  // eslint-disable-line @typescript-eslint/no-explicit-any
      try { body = JSON.parse(x.responseText); } catch { /* corps non JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(body.received);
      else reject(new HttpError(x.status, body?.detail, typeof body?.detail === "string" ? body.detail : `${x.status}`));
    };
    x.onerror = () => reject(new Error("connexion interrompue"));
    x.ontimeout = () => reject(new Error("délai dépassé"));
    x.send(blob);
  });
}

type Status = { received: number; ranges: [number, number][]; size: number };

/** Morceaux (début, fin) encore absents côté serveur, découpés sur la grille de CHUNK. */
export function missingChunks(size: number, ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 0; a < size; a += CHUNK) {
    const b = Math.min(size, a + CHUNK);
    if (!ranges.some(([x, y]) => x <= a && y >= b)) out.push([a, b]);
  }
  return out;
}

/** Envoie un fichier par morceaux (PARALLEL à la fois) puis appelle `finish(id)` (import de démo, piste audio…). */
export async function uploadChunked<T>(f: File, kind: "demo" | "audio", finish: (id: string) => Promise<T>): Promise<T> {
  const id = uploadId(f), { patch } = useUploads.getState();
  patch(id, { id, name: f.name, size: f.size, sent: 0, bps: 0, status: "uploading", error: undefined });
  const status = (): Promise<Status> => call("/api/uploads", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name: f.name, size: f.size, kind }),
  });
  let st = await status();
  for (let attempt = 0; ; attempt++) {
    const todo = missingChunks(f.size, st.ranges);
    if (!todo.length) break;
    const done = f.size - todo.reduce((n, [a, b]) => n + (b - a), 0);
    const inflight = new Map<number, number>();
    const t0 = performance.now();
    let finished = 0, failure: unknown = null;
    const report = () => {
      const sent = done + finished + [...inflight.values()].reduce((a, b) => a + b, 0);
      const dt = (performance.now() - t0) / 1000;
      patch(id, { sent, bps: dt > 0.5 ? (sent - done) / dt : 0, status: "uploading" });
    };
    const worker = async () => {
      for (let c = todo.shift(); c && !failure; c = todo.shift()) {
        const [a, b] = c;
        try {
          await putChunk(`/api/uploads/${id}?offset=${a}`, f.slice(a, b), (n) => { inflight.set(a, n); report(); });
          inflight.delete(a); finished += b - a; report();
        } catch (e) { inflight.delete(a); failure = e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
    if (!failure) { st = await status(); continue; }
    if (failure instanceof HttpError && failure.status < 500 && failure.status !== 409) throw failure;
    if (attempt >= MAX_RETRIES) throw failure;
    patch(id, { status: "retrying", error: (failure as Error).message });
    await sleep(Math.min(30_000, 1000 * 2 ** (attempt + 1)));
    st = await status();  // l'état réel côté serveur fait foi (des morceaux ont pu arriver malgré l'erreur)
  }
  patch(id, { sent: f.size });
  const res = await finish(id);
  useUploads.getState().clear(id);  // la démo apparaît maintenant dans la liste des imports (analyse)
  return res;
}

const uploadOne = (f: File): Promise<ImportResult[number]> =>
  uploadChunked(f, "demo", (id) => call(`/api/uploads/${id}/complete`, { method: "POST" }));

export const attachAudio = (matchId: number, f: File, label: string) =>
  uploadChunked(f, "audio", (id) => call(`/api/matches/${matchId}/audio`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ upload_id: id, label }),
  }));

/** Envoie les fichiers un par un (débit montant partagé : en parallèle, aucun ne finirait plus tôt). */
export async function uploadFiles(files: File[]): Promise<{ results: ImportResult; failed: string[] }> {
  const results: ImportResult = [], failed: string[] = [];
  for (const f of files) useUploads.getState().patch(uploadId(f), { id: uploadId(f), name: f.name, size: f.size, sent: 0, bps: 0, status: "queued" });
  for (const f of files) {
    try { results.push(await uploadOne(f)); } catch (e) {
      useUploads.getState().patch(uploadId(f), { status: "error", error: (e as Error).message });
      failed.push(`${f.name} (${(e as Error).message})`);
    }
  }
  return { results, failed };
}
