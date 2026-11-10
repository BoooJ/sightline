import type { Query, QueryClient } from "@tanstack/react-query";
import { persistQueryClient } from "@tanstack/react-query-persist-client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

/** Requêtes gardées dans le navigateur entre deux visites : la page s'affiche avec les données de la dernière fois,
 *  puis se met à jour. Seules les petites listes partagées par beaucoup d'écrans sont conservées ; les réponses
 *  lourdes (replays, histoires de rounds), tout ce qui touche à la session et les erreurs ne le sont jamais. */
const KEEP = new Set(["maps", "demos", "matches", "facets", "settings", "teams", "players", "playlists", "highlight-types", "callouts", "all-maps"]);
const MAX_BYTES = 200_000;
export const CACHE_VERSION = "1";  // à incrémenter si la forme d'une réponse conservée change
const STORAGE_KEY = "sightline-queries";

export function shouldPersist(q: Query): boolean {
  if (q.state.status !== "success" || !KEEP.has(String(q.queryKey[0]))) return false;
  try { return JSON.stringify(q.state.data).length <= MAX_BYTES; } catch { return false; }
}

/** Déconnexion : rien de la session ne reste dans le navigateur. */
export function clearPersisted(): void {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* stockage indisponible */ }
}

/** Restaure le cache de la dernière visite (résolu avant le premier rendu) puis enregistre chaque changement. */
export function setupPersistence(qc: QueryClient): Promise<void> {
  let storage: Storage;
  try { storage = window.localStorage; storage.getItem(STORAGE_KEY); } catch { return Promise.resolve(); }  // navigation privée ou stockage bloqué
  const persister = createAsyncStoragePersister({ storage, key: STORAGE_KEY, throttleTime: 1000 });
  const [, restored] = persistQueryClient({ queryClient: qc, persister, buster: CACHE_VERSION, maxAge: 7 * 86400_000,
    dehydrateOptions: { shouldDehydrateQuery: shouldPersist } });
  return restored.catch(() => undefined);
}
