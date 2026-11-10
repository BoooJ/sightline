/** Temps dans un round CS2. Le jeu affiche un compte à rebours : 1:55 à la fin du freeze time, 0:00 au temps écoulé
 *  (puis 40 s de bombe une fois posée). Les calculs du site comptent en secondes écoulées depuis la fin du freeze time ;
 *  on les montre toujours comme l'horloge du jeu, pour qu'un « 1:44 » se lise comme en partie. */
export const ROUND_S = 115;

/** Horloge du jeu `s` secondes après la fin du freeze time (0 s → « 1:55 », 11 s → « 1:44 »). */
export function gameClock(s: number): string {
  const v = Math.max(0, Math.round(ROUND_S - s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

/** Infobulle qui lève l'ambiguïté : « 11 s après le début du round (horloge du jeu : 1:44) ». */
export function clockHint(s: number): string {
  return `${Math.round(s)} s après le début du round (horloge du jeu : ${gameClock(s)})`;
}
