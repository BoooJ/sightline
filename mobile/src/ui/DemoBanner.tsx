import { StyleSheet, View } from "react-native";

import { t } from "@/i18n/fr";

import { Txt } from "./Txt";
import { color, radius } from "./theme";

/** Rappel discret que les données sont celles de la démo (matchs pro publics). */
export function DemoBanner() {
  return (
    <View style={styles.pill} accessibilityRole="text">
      <View style={styles.dot} />
      <Txt v="dataSmall" color={color.text2}>{t.demo.banner}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.pill, backgroundColor: color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.accent },
});
