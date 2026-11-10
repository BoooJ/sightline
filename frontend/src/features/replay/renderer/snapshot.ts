import type { DrawArgs, Layout } from "./draw";

/** Derniers arguments de rendu du radar : l'enregistreur GIF rejoue la même vue hors écran, image par image. */
export const radarSnapshot: { args: DrawArgs | null; layout: Layout | null } = { args: null, layout: null };
