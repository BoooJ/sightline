import { useAuth } from "../features/team/auth";

const LOCAL = "dashboard-player";
/** Joueur suivi (« moi ») : celui lié au compte, sinon celui choisi dans le tableau de bord de ce navigateur. */
export function useMyPlayer(): string | undefined {
  const { user } = useAuth();
  let local: string | null = null;
  try { local = localStorage.getItem(LOCAL); } catch { /* stockage indisponible */ }
  return user?.steamid ?? local ?? undefined;
}
