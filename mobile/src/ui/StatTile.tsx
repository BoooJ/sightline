import { StyleSheet, View } from "react-native";

import { Txt } from "./Txt";
import { color, radius, space } from "./theme";

/** Un chiffre, son nom, et son écart à une référence (vert si mieux, rouge si moins bien). */
export function StatTile({ label, value, delta, better = "up", hint }: {
  label: string; value: string;
  /** écart déjà mis en forme (« +0,12 ») et son signe numérique */
  delta?: { text: string; sign: number } | null;
  better?: "up" | "down";
  hint?: string;
}) {
  const good = delta ? (better === "up" ? delta.sign > 0 : delta.sign < 0) : false;
  const tone = !delta || delta.sign === 0 ? color.text3 : good ? color.good : color.bad;
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${label} ${value}${delta ? `, ${delta.text}` : ""}`}>
      <Txt v="caption">{label}</Txt>
      <Txt v="number" style={styles.value}>{value}</Txt>
      {delta ? <Txt v="dataSmall" color={tone}>{delta.text}</Txt> : hint ? <Txt v="dataSmall">{hint}</Txt> : null}
    </View>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

const styles = StyleSheet.create({
  tile: {
    flexBasis: "47%", flexGrow: 1, backgroundColor: color.surface2, borderRadius: radius.card, padding: space.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.line, gap: 2,
  },
  value: { marginTop: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
