import Svg, { Circle, Line, Rect } from "react-native-svg";

import { color } from "@/ui/theme";

/** La marque de Sightline mobile : une ligne de visée qui traverse un repère, sur un carré arrondi. */
export function Logo({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Sightline">
      <Rect x={0} y={0} width={64} height={64} rx={16} fill={color.surface2} />
      <Circle cx={32} cy={32} r={15} stroke={color.accent} strokeWidth={3} fill="none" />
      <Line x1={9} y1={38} x2={55} y2={26} stroke={color.text} strokeWidth={3} strokeLinecap="round" />
      <Circle cx={32} cy={32} r={3.5} fill={color.accent} />
    </Svg>
  );
}
