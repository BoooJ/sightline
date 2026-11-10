import { type QueryClient, useQuery } from "@tanstack/react-query";
import type { Map3d, Variant } from "./types";

/** Cartes 3D disponibles ; module « replay3d » coupé (404) : aucune, le replay reste en 2D. */
export async function fetchMaps3d(): Promise<Map3d[]> {
  const r = await fetch("/api/maps3d");
  if (r.status === 404) return [];
  // session expirée : l'écran de connexion prend le relais, comme pour les autres appels
  if (r.status === 401) window.dispatchEvent(new Event("auth-required"));
  if (!r.ok) throw new Error(`erreur ${r.status}`);  // statusText est vide en HTTP/2
  return r.json() as Promise<Map3d[]>;
}

/** Carte 3D affichable : une version grise ou texturée (une collision seule, envoyée avant la carte, ne suffit pas). */
export const find3d = (list: Map3d[], mapName: string): Map3d | null =>
  list.find((m) => m.map === mapName && !!(m.variants.gray || m.variants.textured)) ?? null;

export const useMaps3d = () => useQuery({ queryKey: ["maps3d"], queryFn: fetchMaps3d, staleTime: 5 * 60_000, retry: false });

/** Fichier de carte introuvable (404) : la carte a pu être ré-exportée depuis la lecture de la liste (le nom du fichier
 *  suit son contenu, l'ancien est supprimé). Relit la liste ; nouvelle adresse de la variante, ou null si rien n'a changé. */
export async function freshUrl(qc: QueryClient, map: string, variant: Variant, old: string): Promise<string | null> {
  await qc.invalidateQueries({ queryKey: ["maps3d"], refetchType: "all" });
  const url = find3d(qc.getQueryData<Map3d[]>(["maps3d"]) ?? [], map)?.variants[variant]?.url ?? null;
  return url && url !== old ? url : null;
}
