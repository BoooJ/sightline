import { useEffect } from "react";
import { StyleSheet, View, type DimensionValue } from "react-native";
import Animated, {
  useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming,
} from "react-native-reanimated";

import { ApiError } from "@/api/api";
import { t } from "@/i18n/fr";

import { Button } from "./Button";
import { Icon } from "./Icon";
import { Txt } from "./Txt";
import { color, radius, space } from "./theme";

export function EmptyState({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <Txt v="callout" style={styles.center}>{text}</Txt>
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : t.common.offline;
  return (
    <View style={styles.empty} accessibilityRole="alert">
      <Icon name="warning" color={color.warn} />
      <Txt v="callout" style={styles.center}>{msg}</Txt>
      {onRetry ? <Button label={t.common.retry} kind="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

/** Bloc de chargement : une pulsation lente (immobile si « Réduire les animations »). */
export function Skeleton({ height = 96, width = "100%" }: { height?: number; width?: DimensionValue }) {
  const reduce = useReducedMotion();
  const o = useSharedValue(0.55);
  useEffect(() => {
    if (!reduce) o.set(withRepeat(withSequence(withTiming(1, { duration: 700 }), withTiming(0.55, { duration: 700 })), -1));
  }, [reduce, o]);
  const anim = useAnimatedStyle(() => ({ opacity: o.get() }));
  return <Animated.View style={[styles.skeleton, { height, width }, anim]} accessibilityLabel={t.common.loading} />;
}

export function Loading({ blocks = 3 }: { blocks?: number }) {
  return (
    <View style={styles.loading}>
      {Array.from({ length: blocks }, (_, i) => <Skeleton key={i} height={i === 0 ? 120 : 84} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: "center", gap: space.md, paddingVertical: space.xl, paddingHorizontal: space.lg,
    backgroundColor: color.surface, borderRadius: radius.card,
  },
  center: { textAlign: "center" },
  skeleton: { backgroundColor: color.surface2, borderRadius: radius.card },
  loading: { gap: space.sm, marginTop: space.lg },
});
