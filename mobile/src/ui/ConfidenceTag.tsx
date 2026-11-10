import { StyleSheet, View } from "react-native";

import type { Reliability, Stat } from "@/api/types";
import { t } from "@/i18n/fr";
import { RELIABILITY_LABEL } from "@/lib/labels";

import { Txt } from "./Txt";
import { color } from "./theme";

const BARS: Record<Reliability, number> = { none: 0, anecdotal: 1, indicative: 2, solid: 3 };

/** Fiabilité d'un chiffre en trois barres, comme un signal : on ne présente jamais 2 rounds comme une tendance. */
export function ConfidenceTag({ stat, showSample = true }: { stat: Stat; showSample?: boolean }) {
  const bars = BARS[stat.level];
  const label = `${RELIABILITY_LABEL[stat.level]}${showSample && stat.n ? ` · ${stat.k}/${stat.n}` : ""}`;
  return (
    <View style={styles.row} accessible accessibilityLabel={t.prep.reliabilityLabel(label)}>
      <View style={styles.bars}>
        {[1, 2, 3].map((b) => (
          <View key={b} style={[styles.bar, { height: 3 + b * 3, backgroundColor: b <= bars ? color.text2 : color.lineStrong }]} />
        ))}
      </View>
      <Txt v="dataSmall" color={color.text3}>{label}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 12 },
  bar: { width: 3, borderRadius: 1 },
});
