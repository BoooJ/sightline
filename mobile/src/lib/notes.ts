import type { NoteT } from "@/api/types";
import { t } from "@/i18n/fr";

import { shortDate } from "./format";
import { updatedDay } from "./strats";

export type NoteSide = "all" | "T" | "CT";
/** même limite que le serveur (backend/app/api/notes.py) */
export const NOTE_MAX = 2000;
/** le compteur de caractères n'apparaît qu'à l'approche de la limite */
export const NOTE_WARN = 1800;

/** Une note « les deux camps » (side null) vaut pour T comme pour CT. */
export function filterNotes<T extends Pick<NoteT, "map" | "side">>(list: T[], map: string | null, side: NoteSide): T[] {
  return list.filter((n) => (!map || n.map === map) && (side === "all" || n.side === null || n.side === side));
}

/** Regroupe par carte en gardant l'ordre de la liste (les plus récentes d'abord). */
export function groupNotesByMap<T extends Pick<NoteT, "map">>(list: T[]): { map: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const n of list) groups.set(n.map, [...(groups.get(n.map) ?? []), n]);
  return [...groups].map(([map, items]) => ({ map, items }));
}

/** À quoi la note est rattachée : « contre MOUZ », « match du 18 oct. », « strat Split B ». */
export function noteContext(n: NoteT, now: Date): string[] {
  return [
    n.team ? t.notes.vs(n.team.name) : null,
    n.match ? (n.match.date ? t.notes.match(shortDate(n.match.date, now)) : t.notes.matchPlain) : null,
    n.strat ? t.notes.strat(n.strat.name) : null,
  ].filter((x): x is string => !!x);
}

/** Ligne discrète sous le texte : rattachement, âge, partage, et l'auteur quand ce n'est pas moi. */
export function noteMeta(n: NoteT, now: Date): string {
  return [
    ...noteContext(n, now),
    n.updated_at ? updatedDay(n.updated_at, now) : null,
    n.shared ? t.notes.team : null,
    n.mine ? null : t.notes.by(n.author),
  ].filter(Boolean).join(" · ");
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const idOf = (v: string | string[] | undefined) => {
  const n = Number(one(v));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Valeurs d'une nouvelle note, passées dans l'adresse de l'éditeur par l'écran d'où l'on écrit. */
export function draftFromParams(p: Params): NoteDraft {
  const side = one(p.side);
  return {
    map: one(p.map) ?? "",
    side: side === "T" || side === "CT" ? side : null,
    match_id: idOf(p.match), team_id: idOf(p.team), strat_id: idOf(p.strat),
  };
}

export interface NoteDraft {
  map: string; side: "T" | "CT" | null; match_id: number | null; team_id: number | null; strat_id: number | null;
}
