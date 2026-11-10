/** Lien de retour contextuel du replay : les pages qui envoient vers un round passent `?from=<chemin>` et le replay
 *  affiche « ← Scouting », « ← Playbook »…, puis ramène exactement sur la page et ses filtres. */
export const fromHere = () => `from=${encodeURIComponent(window.location.pathname + window.location.search)}`;

const LABELS: [string, string][] = [["/scouting/players", "Joueurs à scouter"], ["/scouting", "Scouting"], ["/playbook", "Playbook"], ["/pattern-finder", "Pattern Finder"],
  ["/match-prep", "Match Prep"], ["/team-stats", "Stats d'équipe"], ["/rounds", "Rounds"], ["/highlights", "Moments forts"], ["/players", "Joueur"],
  ["/bookmarks", "Signets"], ["/playlists", "Playlists"], ["/dashboard", "Tableau de bord"], ["/learn", "Apprendre un rôle"]];

/** Chemin de retour sûr (même origine, chemin relatif) et son libellé, ou null. */
export function backTarget(raw: string | null): { to: string; label: string } | null {
  if (!raw) return null;
  let path: string;
  try { path = decodeURIComponent(raw); } catch { return null; }
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  const label = LABELS.find(([p]) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))?.[1] ?? "Retour";
  return { to: path, label };
}
