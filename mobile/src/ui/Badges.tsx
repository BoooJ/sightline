import { StyleSheet, View } from "react-native";

import { t } from "@/i18n/fr";

import { Txt } from "./Txt";
import { color, radius } from "./theme";

/** Résultat d'un match : V / D (lu « Victoire » / « Défaite » par VoiceOver). */
export function ResultBadge({ won, size = 32 }: { won: boolean | null; size?: number }) {
  const tone = won === null ? color.text3 : won ? color.good : color.bad;
  return (
    <View style={[styles.result, { width: size, height: size, borderColor: tone }]} accessible
      accessibilityLabel={won === null ? t.common.draw : won ? t.common.win : t.common.loss}>
      <Txt v="data" color={tone} style={styles.bold}>{won === null ? "N" : won ? "V" : "D"}</Txt>
    </View>
  );
}

/** Camp (T / CT) : les seules couleurs de camp de l'app. */
export function SideTag({ side }: { side: "T" | "CT" }) {
  const c = side === "CT" ? color.ct : color.t;
  return (
    <View style={[styles.tag, { backgroundColor: side === "CT" ? color.ctDim : color.tDim }]}>
      <Txt v="dataSmall" color={c} style={styles.bold}>{side}</Txt>
    </View>
  );
}

export function Tag({ label, tone = color.text2, bg = color.surface3 }: { label: string; tone?: string; bg?: string }) {
  return (
    <View style={[styles.tag, { backgroundColor: bg }]}>
      <Txt v="dataSmall" color={tone}>{label}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  result: { borderRadius: radius.sm, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  tag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, alignSelf: "flex-start" },
  bold: { fontFamily: "JetBrainsMono_700Bold" },
});
