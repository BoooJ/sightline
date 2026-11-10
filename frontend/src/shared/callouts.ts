import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
import type { Vec3 } from "./api/types";

/** Nom de lieu du jeu rendu lisible : « BombsiteB » → « Bombsite B », « CTSpawn » → « CT Spawn ». */
export function humanizePlace(place: string): string {
  return place.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/** Rayon d'un callout placé à la main (unités du jeu) et écart de hauteur maximal (un autre étage n'est pas concerné). */
export const CUSTOM_RADIUS = 300, CUSTOM_DZ = 180;

export type PlaceLabel = (place: string | null | undefined, pos?: Vec3 | null) => string | null;

/** Nom d'un endroit de la carte pour l'équipe : callout placé à la main le plus proche s'il couvre la position,
 *  sinon le lieu du jeu renommé par l'équipe, sinon le nom du jeu rendu lisible. */
export function usePlaceLabel(map: string | undefined): PlaceLabel {
  const q = useQuery({ queryKey: ["callouts", map], queryFn: () => api.callouts(map!), enabled: !!map, staleTime: 60_000 });
  const labels = q.data?.labels, custom = q.data?.custom;
  return useCallback((place, pos) => {
    if (pos && custom?.length) {
      let best: { label: string; d: number } | null = null;
      for (const c of custom) {
        if (Math.abs(c.pos[2] - pos[2]) > CUSTOM_DZ) continue;
        const d = Math.hypot(c.pos[0] - pos[0], c.pos[1] - pos[1]);
        if (d <= CUSTOM_RADIUS && (!best || d < best.d)) best = { label: c.label, d };
      }
      if (best) return best.label;
    }
    if (!place) return null;
    return labels?.[place] ?? humanizePlace(place);
  }, [labels, custom]);
}

/** Nom de l'endroit où se trouve une position : callout placé à la main qui la couvre, sinon le lieu du jeu dont le
 *  centre (moyenne des morts) est le plus proche, à 700 unités au plus et au même étage. */
export function usePlaceAt(map: string | undefined) {
  const q = useQuery({ queryKey: ["callouts", map], queryFn: () => api.callouts(map!), enabled: !!map, staleTime: 60_000 });
  const label = usePlaceLabel(map);
  const places = q.data?.places;
  return useCallback((pos: Vec3 | null | undefined): string | null => {
    if (!pos) return null;
    const own = label(null, pos);
    if (own) return own;
    let best: { place: string; d: number } | null = null;
    for (const p of places ?? []) {
      if (!p.pos || Math.abs(p.pos[2] - pos[2]) > 220) continue;
      const d = Math.hypot(p.pos[0] - pos[0], p.pos[1] - pos[1]);
      if (d <= 700 && (!best || d < best.d)) best = { place: p.place, d };
    }
    return best ? label(best.place) : null;
  }, [places, label]);
}
