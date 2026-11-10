import { useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  interpolate, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { t } from "@/i18n/fr";

import { color, motion, radius, space, TAB_BAR_H } from "./theme";

// Point d'arrivée d'un geste lancé (fonction de projection d'Apple, décélération du défilement).
function project(velocity: number, rate = 0.998) {
  "worklet";
  return ((velocity / 1000) * rate) / (1 - rate);
}
// Résistance progressive au-delà du haut de la feuille, au lieu d'un arrêt sec.
function rubber(over: number, dim: number) {
  "worklet";
  return (over * dim * 0.55) / (dim + 0.55 * over);
}

/** Feuille qui monte du bas. Elle suit le doigt, garde sa vitesse au lâcher et se ferme si le geste l'envoie
 *  sous la moitié ; le fond assombri la ferme aussi. Fondu simple si « Réduire les animations ». */
export function Sheet({ open, onClose, children, height = 0.72, label }: {
  open: boolean; onClose: () => void; children: ReactNode; height?: number; label?: string;
}) {
  const { height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const sheetH = Math.round(H * height);
  const y = useSharedValue(sheetH);
  const start = useSharedValue(0);
  // la feuille reste montée le temps de son animation de sortie
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);

  useEffect(() => {
    if (open) {
      y.set(reduce ? withTiming(0, { duration: motion.fast }) : withSpring(0, motion.spring));
    } else {
      y.set(withTiming(sheetH, { duration: motion.base }, (done) => { if (done) runOnJS(setShown)(false); }));
    }
  }, [open, reduce, sheetH, y]);

  const pan = usePanGesture({
    activeOffsetY: [-6, 6],
    onBegin: () => {
      "worklet";
      start.set(y.get());
    },
    onUpdate: (e) => {
      "worklet";
      const next = start.get() + e.translationY;
      y.set(next < 0 ? -rubber(-next, sheetH) : next);
    },
    onDeactivate: (e) => {
      "worklet";
      const v = e.velocityY;
      if (y.get() + project(v) > sheetH * 0.45) {
        y.set(withSpring(sheetH, { ...motion.spring, velocity: v }));
        runOnJS(onClose)();
      } else {
        y.set(withSpring(0, { ...motion.fling, velocity: v }));
      }
    },
  });

  const sheetStyle = useAnimatedStyle(() => (reduce
    ? { opacity: interpolate(y.get(), [0, sheetH], [1, 0]) }
    : { transform: [{ translateY: y.get() }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: interpolate(y.get(), [0, sheetH], [1, 0], "clamp") }));

  if (!shown) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={t.common.close} />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[styles.sheet, { height: sheetH + 40, paddingBottom: insets.bottom + space.lg + 40 + (Platform.OS === "web" ? TAB_BAR_H : 0), bottom: -40 }, sheetStyle]}
          accessibilityViewIsModal accessibilityLabel={label}
        >
          <View style={styles.grabber} />
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: color.scrim },
  sheet: {
    position: "absolute", left: 0, right: 0, backgroundColor: color.surface, borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg, paddingHorizontal: space.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: color.lineStrong, marginTop: 8, marginBottom: space.md },
});
