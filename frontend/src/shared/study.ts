/** Séance d'étude : suite de moments à revoir dans le replay (ex. tous les rounds joués à un poste), en suivant un
 *  joueur. Gardée dans sessionStorage (onglet courant) ; le replay la lit avec ?study=1&i=<index>. */
export interface StudyMark { tick: number; text: string }
export interface StudyItem { match_id: number; round_number: number; steamid: string; start: number; end: number; label: string; marks?: StudyMark[] }
/** pauses : le replay s'arrête à chaque moment clé (marks) et affiche son explication. */
export interface Study { title: string; back: string; items: StudyItem[]; pauses?: boolean }

const KEY = "study";

export function saveStudy(st: Study): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch { /* stockage indisponible */ }
}

export function loadStudy(): Study | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Study | null; } catch { return null; }
}

export function studyUrl(it: StudyItem, i: number): string {
  return `/matches/${it.match_id}/replay/${it.round_number}?study=1&i=${i}&t=${it.start}&focus=${it.steamid}`;
}
