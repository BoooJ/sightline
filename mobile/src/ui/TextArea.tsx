import { useState } from "react";
import { StyleSheet, TextInput, type TextInputProps } from "react-native";

import { color, radius, space, type as typeScale } from "./theme";

/** Champ de texte sur plusieurs lignes, qui grandit avec le texte à partir de `minHeight`. Bord menthe quand il a le focus. */
export function TextArea({ style, minHeight = 160, onFocus, onBlur, ...p }: TextInputProps & { minHeight?: number }) {
  const [focus, setFocus] = useState(false);
  return (
    <TextInput
      multiline textAlignVertical="top" placeholderTextColor={color.text3} selectionColor={color.accent}
      {...p}
      onFocus={(e) => { setFocus(true); onFocus?.(e); }}
      onBlur={(e) => { setFocus(false); onBlur?.(e); }}
      style={[styles.box, { minHeight }, focus && styles.focus, style]}
    />
  );
}

const styles = StyleSheet.create({
  box: {
    ...typeScale.body, color: color.text, backgroundColor: color.surface2, borderRadius: radius.md, padding: space.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
    // le bord menthe suffit à montrer le focus : pas de contour du navigateur en plus
    outlineStyle: "none",
  } as object,
  focus: { borderColor: color.accentLine },
});
