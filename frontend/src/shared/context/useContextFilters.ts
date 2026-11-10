import { useMemo } from "react";
import type { Side } from "../api/types";
import { useUrlParams } from "../useUrlParams";

/** Filtres de la barre de contexte commune (comme la barre « ON / PLAYING / … » d'EDGE), gardés dans l'URL :
 *  partageables, conservés au retour arrière, lus par toutes les pages de statistiques. */
export const CTX_KEYS = ["team", "map", "side", "econ", "opp_econ", "months", "date_from", "date_to", "last_n", "folder", "event", "tag", "kind", "role"] as const;
export type CtxKey = (typeof CTX_KEYS)[number];
/** Filtres de bibliothèque (sélection de matchs) : envoyés tels quels à l'API. */
export const LIB_KEYS: CtxKey[] = ["team", "months", "date_from", "date_to", "last_n", "folder", "event", "tag", "kind"];

export const MONTHS = [1, 3, 6, 12] as const;
export const LAST_N = [1, 3, 5, 20, 50, 100] as const;
export const KINDS = ["official", "practice"] as const;
export const OPP_ECONS = ["buy", "eco"] as const;

export interface ContextFilters {
  team?: number; map?: string; side?: Side; econ?: string; oppEcon?: string; months?: number; dateFrom?: string; dateTo?: string;
  lastN?: number; folder?: string; event?: string; tag?: string; kind?: "official" | "practice"; role?: string;
}

const int = (v: string | null, allowed?: readonly number[]) => {
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 && (!allowed || allowed.includes(n)) ? n : undefined;
};

/** Lit les filtres depuis les paramètres d'URL (valeurs invalides ignorées). */
export function parseContext(p: URLSearchParams): ContextFilters {
  const side = p.get("side")?.toUpperCase();
  const kind = p.get("kind");
  const oppEcon = p.get("opp_econ");
  return {
    team: int(p.get("team")), map: p.get("map") || undefined, side: side === "CT" || side === "T" ? side : undefined,
    econ: p.get("econ") || undefined, oppEcon: oppEcon && (OPP_ECONS as readonly string[]).includes(oppEcon) ? oppEcon : undefined,
    months: int(p.get("months"), MONTHS), dateFrom: p.get("date_from") || undefined, dateTo: p.get("date_to") || undefined,
    lastN: int(p.get("last_n"), LAST_N), folder: p.get("folder") || undefined, event: p.get("event") || undefined,
    tag: p.get("tag") || undefined, kind: kind === "official" || kind === "practice" ? kind : undefined, role: p.get("role") || undefined,
  };
}

/** Paramètres d'API (toutes les clés), sans les valeurs vides. */
export function toApiParams(f: ContextFilters): Record<string, string | undefined> {
  const s = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
  return {
    team: s(f.team), map: f.map, side: f.side, econ: f.econ, opp_econ: f.oppEcon, months: s(f.months), date_from: f.dateFrom,
    date_to: f.dateTo, last_n: s(f.lastN), folder: f.folder, event: f.event, tag: f.tag, kind: f.kind, role: f.role,
  };
}

/** Seulement la sélection de matchs (pour les endpoints qui ne connaissent pas camp / économie). */
export function toLibParams(f: ContextFilters): Record<string, string | undefined> {
  const all = toApiParams(f);
  return Object.fromEntries(LIB_KEYS.map((k) => [k, all[k]]));
}

export function useContextFilters() {
  const [params, set] = useUrlParams();
  const search = params.toString();
  return useMemo(() => {
    const f = parseContext(params);
    const api = toApiParams(f);
    const lib = toLibParams(f);
    const clean = (o: Record<string, string | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
    return { ...f, params: clean(api), lib: clean(lib), key: clean(api), set, search, raw: params };
  }, [search]);  // eslint-disable-line react-hooks/exhaustive-deps
}
export type ContextState = ReturnType<typeof useContextFilters>;
