import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Image as SvgImage } from "react-native-svg";

import { RADAR_SIZE } from "@/lib/radar";

import { color, radius } from "./theme";

export interface Crop { x: number; y: number; w: number }

/** Radar d'une carte (1024 px) avec des marques dessinées en coordonnées radar. `crop` zoome sur une zone
 *  (fractions 0–1) ; `children(u)` reçoit la taille d'un point écran en unités radar, pour garder des traits
 *  et des cibles de même taille à l'écran quel que soit le zoom. */
export function Radar({ uri, size, crop, children, label }: {
  uri: string; size: number; crop?: Crop; children?: (unit: number) => ReactNode; label: string;
}) {
  const c = crop ?? { x: 0, y: 0, w: 1 };
  const span = c.w * RADAR_SIZE;
  const unit = span / size;
  return (
    <View style={[styles.frame, { width: size, height: size }]} accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg width={size} height={size} viewBox={`${c.x * RADAR_SIZE} ${c.y * RADAR_SIZE} ${span} ${span}`}>
        <SvgImage href={uri} x={0} y={0} width={RADAR_SIZE} height={RADAR_SIZE} opacity={0.82} preserveAspectRatio="none" />
        {children?.(unit)}
      </Svg>
    </View>
  );
}

/** Cadre carré qui contient tous les points (fractions), avec une marge, sans descendre sous `minW`. */
export function cropAround(points: [number, number][], minW = 0.32, pad = 0.1): Crop {
  if (!points.length) return { x: 0, y: 0, w: 1 };
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = Math.min(1, Math.max(minW, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const clamp = (v: number) => Math.min(1 - w, Math.max(0, v));
  return { x: clamp(cx - w / 2), y: clamp(cy - w / 2), w };
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: radius.card, overflow: "hidden", backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.line,
  },
});
