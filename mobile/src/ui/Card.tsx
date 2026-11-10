import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { Icon } from "./Icon";
import { PressableScale } from "./PressableScale";
import { Txt } from "./Txt";
import { color, radius, space } from "./theme";

/** Carte à plat (pas d'ombre) : une idée par carte. Touchable si `onPress`, avec chevron. */
export function Card({ children, onPress, style, accent, label }: {
  children: ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle>;
  /** liseré à gauche (accent, camp) pour la carte mise en avant */
  accent?: string;
  /** libellé VoiceOver de la carte touchable */
  label?: string;
}) {
  const body = (
    <View style={[styles.card, accent ? { borderLeftColor: accent, borderLeftWidth: 3 } : null, style]}>
      <View style={styles.content}>{children}</View>
      {onPress && <View style={styles.chevron}><Icon name="chevronRight" size={18} color={color.text3} /></View>}
    </View>
  );
  if (!onPress) return body;
  return (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label} haptic="light">
      {body}
    </PressableScale>
  );
}

/** Ligne titre de carte : petite étiquette + éventuel complément à droite. */
export function CardHeader({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      <Txt v="label">{label}</Txt>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface2, borderRadius: radius.card, padding: space.lg, flexDirection: "row",
    alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: color.line,
  },
  content: { flex: 1, gap: space.sm },
  chevron: { marginLeft: space.sm },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
});
