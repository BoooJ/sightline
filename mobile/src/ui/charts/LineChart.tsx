import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";

import { num } from "@/lib/format";

import { Txt } from "../Txt";
import { color, space } from "../theme";

export interface ChartPoint { value: number; good?: boolean; label?: string }

const PAD_Y = 10;

/** Courbe d'une valeur par match, avec sa moyenne en pointillé. Points verts / rouges : match gagné / perdu.
 *  `summary` est lu par VoiceOver à la place du dessin. */
export function LineChart({ points, average, height = 168, summary, firstLabel, lastLabel }: {
  points: ChartPoint[]; average?: number | null; height?: number; summary: string; firstLabel?: string; lastLabel?: string;
}) {
  const [w, setW] = useState(0);
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals, average ?? Infinity);
  const hi = Math.max(...vals, average ?? -Infinity);
  const span = hi - lo || 1;
  const x = (i: number) => (points.length < 2 ? w / 2 : (i / (points.length - 1)) * (w - 12) + 6);
  const y = (v: number) => PAD_Y + (1 - (v - lo) / span) * (height - 2 * PAD_Y);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = points.length > 1 ? `${line} L${x(points.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z` : "";
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary}>
      <View style={styles.axis}>
        <Txt v="dataSmall">{num(hi)}</Txt>
        {average != null ? <Txt v="dataSmall">moy. {num(average)}</Txt> : null}
      </View>
      <View style={{ height }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        {w > 0 && points.length > 0 && (
          <Svg width={w} height={height}>
            <Defs>
              <LinearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={color.accent} stopOpacity={0.18} />
                <Stop offset="1" stopColor={color.accent} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {average != null && (
              <Line x1={0} x2={w} y1={y(average)} y2={y(average)} stroke={color.text3} strokeDasharray="4 5" strokeWidth={1} />
            )}
            {area ? <Path d={area} fill="url(#fill)" /> : null}
            <Path d={line} stroke={color.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {points.map((p, i) => (
              <Circle key={i} cx={x(i)} cy={y(p.value)} r={i === points.length - 1 ? 5 : 3.5}
                fill={p.good === undefined ? color.accent : p.good ? color.good : color.bad} stroke={color.surface2} strokeWidth={2} />
            ))}
          </Svg>
        )}
      </View>
      <View style={styles.axis}>
        <Txt v="dataSmall">{firstLabel ?? ""}</Txt>
        <Txt v="dataSmall">{lastLabel ?? ""}</Txt>
      </View>
    </View>
  );
}

/** Petite courbe sans axes (cartes de l'accueil). */
export function Sparkline({ values, width = 96, height = 32 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const x = (i: number) => 3 + (i / (values.length - 1)) * (width - 6);
  const y = (v: number) => 3 + (1 - (v - lo) / span) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values.length - 1;
  return (
    <View aria-hidden>
      <Svg width={width} height={height}>
        <Path d={d} stroke={color.accent} strokeWidth={1.75} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        <Circle cx={x(last)} cy={y(values[last])} r={3} fill={color.accent} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  axis: { flexDirection: "row", justifyContent: "space-between", marginVertical: space.xs },
});
