import { Children, isValidElement, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Icon } from "./Icon";
import { PressableScale } from "./PressableScale";
import { Txt } from "./Txt";
import { color, radius, space, TOUCH } from "./theme";

/** Groupe de lignes sur une même surface, séparées par un trait fin (comme les listes groupées d'iOS). */
export function ListGroup({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.group}>
      {rows.map((r, i) => (
        <View key={r.key ?? i}>
          {i > 0 ? <View style={styles.sep} /> : null}
          {r}
        </View>
      ))}
    </View>
  );
}

export function ListRow({ title, subtitle, leading, value, valueColor, onPress, label }: {
  title: string; subtitle?: string; leading?: ReactNode; value?: string; valueColor?: string; onPress?: () => void; label?: string;
}) {
  const body = (
    <View style={styles.row}>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.text}>
        <Txt v="body" numberOfLines={1}>{title}</Txt>
        {subtitle ? <Txt v="caption" numberOfLines={2}>{subtitle}</Txt> : null}
      </View>
      {value ? <Txt v="data" color={valueColor ?? color.text}>{value}</Txt> : null}
      {onPress ? <Icon name="chevronRight" size={18} color={color.text3} /> : null}
    </View>
  );
  return onPress
    ? <PressableScale onPress={onPress} haptic="light" accessibilityRole="button" accessibilityLabel={label ?? title}>{body}</PressableScale>
    : body;
}

const styles = StyleSheet.create({
  group: { backgroundColor: color.surface2, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line, overflow: "hidden" },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: color.line, marginLeft: space.lg },
  row: { minHeight: TOUCH + 12, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  leading: { minWidth: 28, alignItems: "center" },
  text: { flex: 1, gap: 1 },
});
