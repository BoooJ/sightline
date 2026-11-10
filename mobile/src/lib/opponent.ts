import type { ScoutTeam } from "@/api/types";

/** Même règle que le serveur pour relier un événement à une équipe (`_norm` de api/calendar.py), accents en moins. */
export function normalizeName(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** L'adversaire d'un événement du calendrier est un texte libre : on cherche l'équipe du scouting qui lui correspond. */
export function matchOpponent(opponent: string, teams: ScoutTeam[]): ScoutTeam | null {
  const q = normalizeName(opponent);
  if (!q) return null;
  const byMatches = [...teams].sort((a, b) => b.matches - a.matches);
  return byMatches.find((t) => normalizeName(t.name) === q)
    ?? byMatches.find((t) => {
      const n = normalizeName(t.name);
      return !!n && (n.includes(q) || q.includes(n));
    })
    ?? null;
}
