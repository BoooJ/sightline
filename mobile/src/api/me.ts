import { useEffect, useState } from "react";

import { useMatch, useProfile } from "./hooks";
import { useSession } from "./session";
import { prefs } from "./storage";

/** SteamID du joueur suivi (compte relié, ou joueur de la démo). */
export function useMySteamid(): string | null {
  return useSession().user?.steamid ?? null;
}

/** Les matchs du joueur, du plus récent au plus ancien (le serveur les rend dans l'autre sens). */
export function useMyMatches() {
  const q = useProfile(useMySteamid());
  return { ...q, recent: q.data ? [...q.data.recent].reverse() : [] };
}

/** Équipe du joueur : celle de son dernier match. `pending` tant qu'on la cherche encore ;
 *  ensuite `id` null veut dire « inconnue » (aucun match), pas « en chargement ». */
export function useMyTeamState(): { id: number | null; pending: boolean } {
  const sid = useMySteamid();
  const mine = useMyMatches();
  const m = useMatch(mine.recent[0]?.match_id ?? 0);
  // isLoading et pas isPending : une requête qui ne part pas (aucun match) n'est pas « en cours »
  return { id: m.data?.players.find((p) => p.steamid === sid)?.team_id ?? null, pending: mine.isLoading || m.isLoading };
}

export const useMyTeam = (): number | null => useMyTeamState().id;

const LATER_KEY = "sl-who-later";
let laterCache: string | null | undefined; // undefined : pas encore lu
const laterListeners = new Set<(v: string | null) => void>();

/** « Plus tard » sur « Qui es-tu ? » : le compte entre sans joueur (aucune démo à son nom pour l'instant) et le liera
 *  depuis Compte. Gardé pour ce compte seulement ; `ready` faux tant que le réglage n'est pas lu. */
export function useWhoLater(): { later: boolean; ready: boolean; setLater: (on: boolean) => void } {
  const { user } = useSession();
  const [v, setV] = useState(laterCache);
  useEffect(() => {
    laterListeners.add(setV);
    if (laterCache === undefined) {
      const done = (raw: string | null) => { laterCache = raw; laterListeners.forEach((l) => l(raw)); };
      void prefs.get(LATER_KEY).then(done).catch(() => done(null));
    }
    return () => { laterListeners.delete(setV); };
  }, []);
  const setLater = (on: boolean) => {
    laterCache = on && user ? String(user.id) : null;
    laterListeners.forEach((l) => l(laterCache ?? null));
    void (laterCache ? prefs.set(LATER_KEY, laterCache) : prefs.remove(LATER_KEY));
  };
  return { later: !!user && v === String(user.id), ready: v !== undefined, setLater };
}

const SEEN_KEY = "sl-seen";
let seenCache: number[] | null = null;
const listeners = new Set<(v: number[]) => void>();

/** Bilans déjà ouverts dans l'app (pour ne pas annoncer « ton bilan est prêt » deux fois). */
export function useSeen() {
  const [seen, setSeen] = useState<number[]>(seenCache ?? []);
  useEffect(() => {
    listeners.add(setSeen);
    if (seenCache === null) {
      void prefs.get(SEEN_KEY).then((raw) => {
        seenCache = raw ? (JSON.parse(raw) as number[]) : [];
        listeners.forEach((l) => l(seenCache!));
      }).catch(() => { seenCache = []; });
    }
    return () => { listeners.delete(setSeen); };
  }, []);
  const markSeen = (id: number) => {
    const cur = seenCache ?? [];
    if (cur.includes(id)) return;
    seenCache = [id, ...cur].slice(0, 50);
    listeners.forEach((l) => l(seenCache!));
    void prefs.set(SEEN_KEY, JSON.stringify(seenCache));
  };
  return { seen: new Set(seen), markSeen };
}
