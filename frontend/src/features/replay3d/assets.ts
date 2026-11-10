import { useQuery } from "@tanstack/react-query";
import { fetchGlb, parseGlbAnimated } from "./loader";
import type { AssetFile, Assets3d } from "./types";
import type { VmLoad } from "./viewmodel";

/** Fichiers 3D autres que les cartes (bras et armes de la vue du joueur, modèles d'agents des joueurs) ; aucun, ou module
 *  « replay3d » coupé (404) : {} (la vue du joueur reste sans bras, les joueurs en silhouettes). */
export async function fetchAssets3d(): Promise<Assets3d> {
  const r = await fetch("/api/assets3d");
  if (r.status === 404) return {};
  // session expirée : l'écran de connexion prend le relais, comme pour les autres appels
  if (r.status === 401) window.dispatchEvent(new Event("auth-required"));
  if (!r.ok) throw new Error(`erreur ${r.status}`);  // statusText est vide en HTTP/2
  return r.json() as Promise<Assets3d>;
}

export const useAssets3d = () => useQuery({ queryKey: ["assets3d"], queryFn: fetchAssets3d, staleTime: 5 * 60_000, retry: false });

/** Chargement des fichiers d'un jeu (« vue » pour ViewModel, « joueurs » pour AgentLibrary) : nom absent de la liste →
 *  null (pas de bras pour cette arme, pas de modèle pour ce camp). */
export const vmLoader = (files: Record<string, AssetFile>): VmLoad => async (name, signal) => {
  const f = files[name];
  return f ? parseGlbAnimated(await fetchGlb(f.url, f.size, () => {}, signal)) : null;
};
