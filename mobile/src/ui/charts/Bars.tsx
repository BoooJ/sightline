import { StyleSheet, View } from "react-native";

import { t } from "@/i18n/fr";
import { pct, signed } from "@/lib/format";

import { Txt } from "../Txt";
import { color, radius, space } from "../theme";

/** Gagnés / perdus sur une seule barre, avec le total en clair. */
export function SplitBar({ label, sub, won, lost }: { label: string; sub?: string; won: number; lost: number }) {
  const total = won + lost;
  const share = total ? won / total : 0;
  return (
    <View style={styles.block} accessible accessibilityLabel={t.common.splitBar(label, won, lost)}>
      <View style={styles.head}>
        <View style={styles.flex}>
          <Txt v="subhead" color={color.text}>{label}</Txt>
          {sub ? <Txt v="caption">{sub}</Txt> : null}
        </View>
        <Txt v="data">{won}–{lost}</Txt>
      </View>
      <View style={styles.track}>
        {total > 0 ? <View style={[styles.won, { flex: share }]} /> : null}
        {total > 0 ? <View style={[styles.lost, { flex: 1 - share }]} /> : null}
      </View>
    </View>
  );
}

/** Écart à une moyenne, centré sur zéro : à droite si mieux, à gauche si moins bien. */
export function DeltaBar({ label, value, deltaPct, better = "up" }: { label: string; value: string; deltaPct: number; better?: "up" | "down" }) {
  const good = better === "up" ? deltaPct >= 0 : deltaPct <= 0;
  const size = Math.min(1, Math.abs(deltaPct) / 50);
  return (
    <View style={styles.block} accessible accessibilityLabel={t.common.deltaBar(label, value, signed(deltaPct, 0))}>
      <View style={styles.head}>
        <Txt v="subhead" color={color.text} style={styles.flex}>{label}</Txt>
        <Txt v="data">{value}</Txt>
        <Txt v="dataSmall" color={good ? color.good : color.bad} style={styles.delta}>{signed(deltaPct, 0)}{" "}%</Txt>
      </View>
      <View style={styles.center}>
        <View style={styles.half}>{deltaPct < 0 ? <View style={[styles.fillL, { width: `${size * 100}%`, backgroundColor: good ? color.good : color.bad }]} /> : null}</View>
        <View style={styles.zero} />
        <View style={styles.half}>{deltaPct > 0 ? <View style={[styles.fillR, { width: `${size * 100}%`, backgroundColor: good ? color.good : color.bad }]} /> : null}</View>
      </View>
    </View>
  );
}

/** Part d'un total en petite barre (sites, styles). */
export function ShareBar({ share, tone = color.text2 }: { share: number; tone?: string }) {
  return (
    <View style={styles.thin}>
      <View style={{ width: pct(share * 100) === "—" ? 0 : `${Math.round(share * 100)}%`, backgroundColor: tone, borderRadius: 2 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  flex: { flex: 1 },
  delta: { minWidth: 48, textAlign: "right" },
  track: { height: 8, borderRadius: radius.pill, overflow: "hidden", flexDirection: "row", backgroundColor: color.surface3, gap: 2 },
  won: { backgroundColor: color.good, borderRadius: radius.pill },
  lost: { backgroundColor: color.bad, opacity: 0.85, borderRadius: radius.pill },
  center: { flexDirection: "row", alignItems: "center", height: 8 },
  half: { flex: 1, height: 6, justifyContent: "center", backgroundColor: color.surface3, borderRadius: 3, overflow: "hidden" },
  zero: { width: 2, height: 12, backgroundColor: color.text3, marginHorizontal: 2, borderRadius: 1 },
  fillL: { position: "absolute", right: 0, top: 0, bottom: 0, borderRadius: 3 },
  fillR: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 3 },
  thin: { height: 4, backgroundColor: color.surface3, borderRadius: 2, overflow: "hidden", flexDirection: "row" },
});
