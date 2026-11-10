import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, withSpring, withTiming } from "react-native-reanimated";

import { tap } from "./PressableScale";
import { Txt } from "./Txt";
import { color, motion, radius } from "./theme";

/** Contrôle segmenté façon iOS : la pastille glisse d'un segment à l'autre (ressort sans rebond). */
export function Segmented<T extends string>({ items, value, onChange }: {
  items: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  const [w, setW] = useState(0);
  const reduce = useReducedMotion();
  const index = Math.max(0, items.findIndex((i) => i.value === value));
  const seg = w / items.length;
  const thumb = useAnimatedStyle(() => ({
    width: seg,
    transform: [{ translateX: reduce ? withTiming(index * seg, { duration: 0 }) : withSpring(index * seg, motion.spring) }],
  }), [index, seg, reduce]);
  return (
    <View style={styles.track} onLayout={(e) => setW(e.nativeEvent.layout.width - 4)} accessibilityRole="tablist">
      {w > 0 && <Animated.View style={[styles.thumb, thumb]} />}
      {items.map((i) => {
        const on = i.value === value;
        return (
          <Pressable
            key={i.value} style={styles.seg} accessibilityRole="tab" accessibilityState={{ selected: on }}
            onPress={() => { if (!on) { tap("select"); onChange(i.value); } }}
          >
            <Txt v="subhead" color={on ? color.text : color.text3} style={on ? styles.on : null}>{i.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", backgroundColor: color.surface, borderRadius: radius.md, padding: 2, height: 40 },
  thumb: {
    position: "absolute", top: 2, bottom: 2, left: 2, borderRadius: radius.md - 2, backgroundColor: color.surface3,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  seg: { flex: 1, alignItems: "center", justifyContent: "center" },
  on: { fontWeight: "600" },
});
