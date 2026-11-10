import { useFonts } from "expo-font";

import { FONTS } from "./fontFiles";

/** Vrai quand l'app peut s'afficher : polices chargées, ou en échec (police du système à la place). */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(FONTS);
  return loaded || error != null;
}
