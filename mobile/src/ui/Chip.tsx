import { ScrollView, StyleSheet, View } from "react-native";

import { PressableScale } from "./PressableScale";
import { Txt } from "./Txt";
import { color, radius, space } from "./theme";

export function Chip({ label, selected, onPress, dot }: { label: string; selected?: boolean; onPress?: () => void; dot?: string }) {
  return (
    <PressableScale
      onPress={onPress} haptic="select" hitSlop={6}
      accessibilityRole="button" accessibilityState={{ selected: !!selected }}
      style={[styles.chip, selected && styles.selected]}
    >
      {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
      <Txt v="subhead" color={selected ? color.accent : color.text2}>{label}</Txt>
    </PressableScale>
  );
}

/** Rangée de puces qui défile horizontalement, collée aux marges de l'écran. */
export function ChipRow<T extends string>({ items, value, onChange }: {
  items: { value: T; label: string; dot?: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} style={styles.scroll}>
      {items.map((i) => (
        <Chip key={i.value} label={i.label} dot={i.dot} selected={i.value === value} onPress={() => onChange(i.value)} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { marginHorizontal: -space.lg, flexGrow: 0 },
  row: { paddingHorizontal: space.lg, gap: space.sm },
  chip: {
    height: 36, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: color.surface2,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong, flexDirection: "row", alignItems: "center", gap: 6,
  },
  selected: { backgroundColor: color.accentDim, borderColor: color.accentLine },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
