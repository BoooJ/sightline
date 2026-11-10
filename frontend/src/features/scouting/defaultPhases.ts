import type { DefaultKind, EngageSite, PlaybookRoundT, Stat } from "../../shared/api/types";

/** Default en phases (playbook) : fins du default, prise des sites et rotations CT provoquées. Logique pure, sans React. */

export const DEFAULT_KINDS: DefaultKind[] = ["exec", "take", "duels", "no_take"];   // ordre fixe partout, pour comparer les équipes
export const DEFAULT_KIND_LABEL: Record<DefaultKind, string> = { exec: "puis exécution", take: "puis prise", duels: "aux duels", no_take: "sans prise" };

/** Sous-types à afficher : compte > 0, dans l'ordre DEFAULT_KINDS. */
export function shownKinds<T extends { key: DefaultKind; count: Stat }>(kinds?: T[] | null): T[] {
  if (!kinds) return [];
  return DEFAULT_KINDS.flatMap((k) => kinds.filter((x) => x.key === k && x.count.k > 0));
}

/** Sites pris à afficher (n > 0 et heure médiane connue), A puis B. */
export function engageParts(e?: { A?: EngageSite; B?: EngageSite } | null): { site: "A" | "B"; median_s: number; n: number; won: number }[] {
  if (!e) return [];
  return (["A", "B"] as const).flatMap((site) => {
    const s = e[site];
    return s && s.n > 0 && s.median_s != null ? [{ site, median_s: s.median_s, n: s.n, won: s.won }] : [];
  });
}

/** Rotations provoquées sur les rounds T hors eco où elle est mesurable (pas sur Nuke, dont les sites sont superposés ;
 *  une ligne sans `rotation_measurable` ne compte pas). `armed` vaut 0 quand rien n'est mesurable. */
export function ctRotationCount(list: PlaybookRoundT[]): { rot: number; armed: number } {
  const armed = list.filter((x) => x.category !== "eco" && x.rotation_measurable === true);
  return { rot: armed.filter((x) => x.ct_rotation_s != null).length, armed: armed.length };
}
