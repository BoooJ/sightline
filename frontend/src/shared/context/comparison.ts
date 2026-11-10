import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { api } from "../api/client";
import type { Baseline, ComparisonSettings } from "../api/types";
import { useAuth } from "../../features/team/auth";
import type { ContextState } from "./useContextFilters";

/** Réglage « Comparé à » : équipes de la bibliothèque (5 au plus) sur une fenêtre, ou sa propre forme passée.
 *  Gardé dans le navigateur et, quand il y a un compte, sur le compte (partagé entre appareils). Un seul état
 *  partagé par toutes les barres et fenêtres affichées. */
export const DEFAULT_COMPARISON: ComparisonSettings = { mode: "teams", teams: [], months: 3 };
const KEY = "sl-comparison";
const PRESETS_KEY = "sl-comparison-presets";
export interface ComparisonPreset { name: string; teams: number[]; months: number }

function loadLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (!v) return fallback;
    const parsed = JSON.parse(v);
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T;
    return { ...fallback, ...parsed } as T;
  } catch { return fallback; }
}
function saveLocal(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* stockage indisponible */ } }

const useStore = create<{ settings: ComparisonSettings; set: (s: ComparisonSettings) => void }>((set) => ({
  settings: loadLocal(KEY, DEFAULT_COMPARISON),
  set: (settings) => { saveLocal(KEY, settings); set({ settings }); },
}));

export function useComparison() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const local = useStore((s) => s.settings);
  const setLocal = useStore((s) => s.set);
  // compte connecté : le réglage du compte fait foi (et remplit le réglage local pour les prochaines fois)
  const fromAccount = user?.comparison ?? null;
  useEffect(() => { if (fromAccount && JSON.stringify(fromAccount) !== JSON.stringify(local)) setLocal(fromAccount); }, [fromAccount]);  // eslint-disable-line react-hooks/exhaustive-deps
  const settings: ComparisonSettings = local;
  const update = useCallback(async (s: ComparisonSettings) => {
    setLocal(s);
    if (user) { await api.updateMe({ comparison: s }); qc.invalidateQueries({ queryKey: ["me"] }); }
  }, [user, qc, setLocal]);
  return { settings, update };
}

export function usePresets() {
  const [presets, setPresets] = useState<ComparisonPreset[]>(() => loadLocal(PRESETS_KEY, [] as ComparisonPreset[]));
  useEffect(() => saveLocal(PRESETS_KEY, presets), [presets]);
  return { presets, setPresets };
}

/** Référence pour les filtres courants : moyenne des équipes choisies (mêmes camp / carte / économie), ou, en mode
 *  « soi-même », la forme passée du joueur `steamid` sur autant de matchs que la sélection courante. */
export function useBaseline(ctx: ContextState, steamid?: string) {
  const { settings } = useComparison();
  const teams = settings.mode === "teams" ? settings.teams : [];
  const enabled = settings.mode === "teams" ? teams.length > 0 : !!steamid;
  const params = settings.mode === "teams"
    ? { mode: "teams", cmp_teams: teams.join(","), cmp_months: String(settings.months), side: ctx.params.side, map: ctx.params.map, econ: ctx.params.econ, opp_econ: ctx.params.opp_econ, kind: ctx.params.kind }
    : { mode: "self", steamid, ...ctx.params };
  const q = useQuery({ queryKey: ["compare", params], queryFn: () => api.compare(params), enabled, staleTime: 60_000, placeholderData: (prev) => prev });
  const b: Baseline | undefined = enabled ? q.data : undefined;
  return { baseline: b, stats: b?.stats ?? {}, rounds: b?.rounds ?? 0, settings, enabled, loading: enabled && q.isLoading };
}
