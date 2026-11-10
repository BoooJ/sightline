/** SteamID64 collé à la main par un membre qu'aucune démo importée ne montre encore : le nombre seul, ou le lien de son
 *  profil steamcommunity.com/profiles/…. Un lien /id/<pseudo> ne contient pas l'identifiant : null. */
export function parseSteamId(raw: string): string | null {
  const s = raw.trim();
  const id = (s.match(/^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d+)\/?$/i) ?? s.match(/^(\d+)$/))?.[1];
  return id && /^7656119\d{10}$/.test(id) ? id : null;
}
