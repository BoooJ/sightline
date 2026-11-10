import { Text, type TextProps } from "react-native";

import { type as typeScale, type TypeVariant } from "./theme";

/** Texte de l'app : une variante de l'échelle typographique, une couleur éventuelle. Suit la taille de texte du
 *  système (Dynamic Type), plafonnée pour les chiffres qui doivent tenir dans leur case. */
export function Txt({ v = "body", color, style, ...p }: TextProps & { v?: TypeVariant; color?: string }) {
  const dense = v === "number" || v === "data" || v === "dataSmall" || v === "label";
  return <Text maxFontSizeMultiplier={dense ? 1.35 : 1.8} {...p} style={[typeScale[v], color ? { color } : null, style]} />;
}
