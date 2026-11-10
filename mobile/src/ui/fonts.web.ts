import { Asset } from "expo-asset";
import { useEffect, useState } from "react";

import { loadFontFaces } from "@/lib/fontFaces";

import { FONTS } from "./fontFiles";

// au-delà, l'app s'affiche avec la police de secours (réseau lent) ; la vraie remplace l'autre dès son arrivée
const TIMEOUT_MS = 4000;

/** Sur le web : API FontFace, pas expo-font (bloqué sous Safari, voir lib/fontFaces). */
export function useAppFonts(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const urls = Object.fromEntries(Object.entries(FONTS).map(([family, file]) => [family, Asset.fromModule(file).uri]));
    void loadFontFaces(urls, {
      create: (family, url) => new FontFace(family, `url(${JSON.stringify(url)})`),
      add: (face) => document.fonts.add(face),
      wait: (ms) => new Promise((res) => setTimeout(res, ms)),
    }, TIMEOUT_MS).then(() => setReady(true));
  }, []);
  return ready;
}
