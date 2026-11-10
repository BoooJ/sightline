import { Pressable, StyleSheet, Switch, View } from "react-native";

import { tap } from "./PressableScale";
import { Txt } from "./Txt";
import { color, radius, space, TOUCH } from "./theme";

// react-native-web peint le bouton activé en sarcelle (#009688) si on ne lui donne pas sa couleur (prop propre au web)
const WEB_THUMB = { activeThumbColor: color.text } as object;

/** Interrupteur avec son libellé : toute la ligne se touche (l'interrupteur seul est une cible trop petite). */
export function Toggle({ label, hint, value, onChange, disabled }: {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => { tap("select"); onChange(!value); }} disabled={disabled}
      accessibilityRole="switch" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ checked: value, disabled: !!disabled }}
      style={[styles.row, disabled && styles.off]}
    >
      <View style={styles.text}>
        <Txt v="body">{label}</Txt>
        {hint ? <Txt v="caption">{hint}</Txt> : null}
      </View>
      {/* l'interrupteur ne reçoit pas le toucher : la ligne s'en charge, sinon il basculerait deux fois */}
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Switch value={value} trackColor={{ false: color.surface3, true: color.accent }} thumbColor={color.text}
          ios_backgroundColor={color.surface3} {...WEB_THUMB} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: TOUCH + 12, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm,
    backgroundColor: color.surface2, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line,
  },
  text: { flex: 1, gap: 2 },
  off: { opacity: 0.5 },
});
