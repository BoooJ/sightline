import * as Haptics from "expo-haptics";
import { Platform, Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

import { motion } from "./theme";

export function tap(kind: "light" | "select" | "success" = "light") {
  if (Platform.OS === "web") return;
  if (kind === "select") void Haptics.selectionAsync();
  else if (kind === "success") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

type Props = Omit<PressableProps, "style"> & { style?: StyleProp<ViewStyle>; haptic?: "light" | "select" | "success" | false };

/** Retour visuel dès que le doigt touche (pas au relâchement) : légère réduction, puis ressort sans rebond. */
export function PressableScale({ style, haptic = false, onPressIn, onPressOut, onPress, children, ...p }: Props) {
  const reduce = useReducedMotion();
  const s = useSharedValue(1);
  const o = useSharedValue(1);
  // l'opacité demandée par le style (bouton désactivé…) se combine à celle de l'appui, au lieu d'être écrasée par elle
  const base = (StyleSheet.flatten(style)?.opacity as number | undefined) ?? 1;
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: s.get() }], opacity: o.get() * base }), [base]);
  return (
    <Pressable
      {...p}
      onPressIn={(e) => {
        if (reduce) o.set(withTiming(0.7, { duration: motion.press }));
        else s.set(withTiming(0.97, { duration: motion.press }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        s.set(withSpring(1, motion.spring));
        o.set(withTiming(1, { duration: motion.fast }));
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic) tap(haptic);
        onPress?.(e);
      }}
    >
      {/* style aplati : sur le web, Reanimated écrit chaque clé du style dans le DOM (un tableau imbriqué casse) */}
      {(state) => <Animated.View style={[StyleSheet.flatten(style), anim]}>{typeof children === "function" ? children(state) : children}</Animated.View>}
    </Pressable>
  );
}
