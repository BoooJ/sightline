import { ActivityIndicator, StyleSheet } from "react-native";

import { Icon, type IconName } from "./Icon";
import { PressableScale } from "./PressableScale";
import { Txt } from "./Txt";
import { color, radius, TOUCH } from "./theme";

/** Une seule action principale par écran (kind « primary ») ; les autres en « secondary » ou « plain ».
 *  « danger » : la confirmation d'une suppression, jamais une action affichée d'emblée. */
export function Button({ label, onPress, kind = "primary", icon, busy, disabled }: {
  label: string; onPress: () => void; kind?: "primary" | "secondary" | "plain" | "danger"; icon?: IconName; busy?: boolean; disabled?: boolean;
}) {
  const fg = kind === "primary" ? color.onAccent : kind === "secondary" ? color.text : kind === "danger" ? color.bad : color.accent;
  return (
    <PressableScale
      onPress={onPress} disabled={disabled || busy} haptic={kind === "primary" ? "light" : false}
      accessibilityRole="button" accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      style={[styles.base, styles[kind], (disabled || busy) && styles.off]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={18} color={fg} /> : null}
      <Txt v="headline" color={fg}>{label}</Txt>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: TOUCH + 6, borderRadius: radius.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 18 },
  primary: { backgroundColor: color.accent },
  secondary: { backgroundColor: color.surface3, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  plain: { backgroundColor: "transparent", minHeight: TOUCH },
  danger: { backgroundColor: color.badDim },
  off: { opacity: 0.5 },
});
