import { useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

/** Précharge les données d'une page au survol de son lien : à l'arrivée, elle s'affiche sans attendre le serveur. */
export function usePrefetch() {
  const qc = useQueryClient();
  return {
    match: (id: number) => { void qc.prefetchQuery({ queryKey: ["match", id], queryFn: () => api.match(id), staleTime: 30_000 }); },
    player: (steamid: string, params: Record<string, string | undefined>) => {
      void qc.prefetchQuery({ queryKey: ["player", steamid, params], queryFn: () => api.player(steamid, params), staleTime: 30_000 });
    },
    scout: (teamId: number) => { void qc.prefetchQuery({ queryKey: ["scout", teamId], queryFn: () => api.scoutReport(teamId), staleTime: 30_000 }); },
  };
}
