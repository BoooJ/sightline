import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Api } from "./api";
import { useSession } from "./session";
import type { NoteFilter, NoteInput } from "./types";

type Fn<A extends unknown[], R> = (api: Api, ...args: A) => Promise<R>;

/** Une requête de l'API, mise en cache par mode (serveur / démo) : passer en démo ne mélange jamais les données. */
function useApiQuery<A extends unknown[], R>(name: string, fn: Fn<A, R>, args: A, enabled = true) {
  const s = useSession();
  return useQuery({
    queryKey: [s.mode, name, ...args],
    queryFn: () => fn(s.api, ...args),
    enabled: enabled && (s.status === "signedIn" || s.status === "demo"),
  });
}

export const useCalendar = () => useApiQuery("calendar", (a) => a.calendar(), []);
export const useScoutTeams = () => useApiQuery("scoutTeams", (a) => a.scoutTeams(), []);
export const useScoutReport = (id: number | null) =>
  useApiQuery("scoutReport", (a, i: number) => a.scoutReport(i), [id ?? 0], id !== null);
export const useBrief = (id: number | null, map: string | null) =>
  useApiQuery("brief", (a, i: number, m: string) => a.scoutBrief(i, m), [id ?? 0, map ?? ""], id !== null && !!map);
export const usePlayers = () => useApiQuery("players", (a) => a.players(), []);
export const useProfile = (sid: string | null | undefined) =>
  useApiQuery("profile", (a, s: string) => a.profile(s), [sid ?? ""], !!sid);
export const useDashboard = (sid: string | null | undefined) =>
  useApiQuery("dashboard", (a, s: string) => a.dashboard(s), [sid ?? ""], !!sid);
export const useMatch = (id: number) => useApiQuery("match", (a, i: number) => a.match(i), [id], id > 0);
export const useAnalysis = (id: number) => useApiQuery("analysis", (a, i: number) => a.analysis(i), [id], id > 0);
export const useDebrief = (id: number, team: number | null) =>
  useApiQuery("debrief", (a, i: number, t: number | null) => a.debrief(i, t), [id, team], id > 0 && team !== null);
export const useMaps = () => useApiQuery("maps", (a) => a.maps(), []);
export const useGrenades = (map: string, team?: number) =>
  useApiQuery("grenades", (a, m: string, t: number | undefined) => a.grenades(m, { team: t }), [map, team], !!map);
export const useCallouts = (map: string) => useApiQuery("callouts", (a, m: string) => a.callouts(m), [map], !!map);
export const useStrats = () => useApiQuery("strats", (a) => a.strats(), []);
export const useStrat = (id: number) => useApiQuery("strat", (a, i: number) => a.strat(i), [id], id > 0);
export const useGoals = (teamId: number | null) =>
  useApiQuery("goals", (a, t: number) => a.goals(t), [teamId ?? 0], teamId !== null);
export const useNotifications = () => useApiQuery("notifications", (a) => a.notifications(), []);
export const useNotes = (f: NoteFilter, enabled = true) =>
  useApiQuery("notes", (a, ff: NoteFilter) => a.notes(ff), [f], enabled);
export const useNote = (id: number) => useApiQuery("note", (a, i: number) => a.note(i), [id], id > 0);

/** Écrire une note : chaque écriture remet à jour toutes les listes de notes (Carnet, préparation, bilan…). */
export function useNoteActions() {
  const s = useSession();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: [s.mode, "notes"] });
  return {
    create: useMutation({ mutationFn: (p: NoteInput) => s.api.createNote(p), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, p }: { id: number; p: Partial<NoteInput> }) => s.api.updateNote(id, p),
      onSuccess: (n) => { qc.setQueryData([s.mode, "note", n.id], n); return refresh(); },
    }),
    remove: useMutation({
      mutationFn: (id: number) => s.api.deleteNote(id),
      onSuccess: (_, id) => { qc.removeQueries({ queryKey: [s.mode, "note", id] }); return refresh(); },
    }),
  };
}
