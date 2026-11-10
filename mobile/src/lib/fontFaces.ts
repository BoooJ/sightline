// Polices de l'app sur le web, par l'API FontFace plutôt que par expo-font.
// expo-font 58 écrit toutes les règles @font-face dans une seule balise <style> et attend document.fonts.load
// pour chacune : sous Safari (WebKit), une règle ajoutée pendant qu'une autre police charge laisse ce chargement
// en attente pour toujours. Les 4 polices partant ensemble, l'app restait sur un écran vide.

export interface FontFaceLike { load(): Promise<unknown> }

export interface FontEnv<F extends FontFaceLike> {
  create(family: string, url: string): F;
  add(face: F): void;
  wait(ms: number): Promise<void>;
}

/** Charge les polices en parallèle ; se termine quand toutes ont répondu (même en échec) ou après `timeoutMs`. */
export async function loadFontFaces<F extends FontFaceLike>(
  urls: Record<string, string>, env: FontEnv<F>, timeoutMs: number,
): Promise<void> {
  const loads = Object.entries(urls).map(([family, url]) => {
    const face = env.create(family, url);
    env.add(face);
    return face.load();
  });
  // une police en retard ou en échec : l'app s'affiche avec la police de secours, la vraie arrive ensuite
  await Promise.race([Promise.allSettled(loads), env.wait(timeoutMs)]);
}
