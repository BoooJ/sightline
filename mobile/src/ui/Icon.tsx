import { View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import { color as palette } from "./theme";

// Icônes dessinées pour l'app (trait de 1,75 sur une grille de 24), utilisées sur le web et dans les écrans.
const PATHS = {
  today: "M12 3v2.2M12 18.8V21M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M3 12h2.2M18.8 12H21M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6",
  matches: "M4 6h16M4 12h16M4 18h10",
  grenades: "M9.5 6.5h5M12 6.5V4.2M10 4.2h4M7.5 13.5a4.5 4.5 0 1 0 9 0 4.5 4.5 0 0 0-9 0zM12 9v0",
  progress: "M4 17l5-5 4 4 7-8M15 8h5v5",
  strats: "M9 3.5h6v3H9zM7.5 5H6v15.5h12V5h-1.5M9 16l2.5-3 2.5 2 2-3.5",
  chevronRight: "M9 5l7 7-7 7",
  chevronLeft: "M15 5l-7 7 7 7",
  chevronDown: "M6 9l6 6 6-6",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
  target: "M12 3v4M12 17v4M3 12h4M17 12h4M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  warning: "M12 4l9 16H3l9-16zM12 10v4.5M12 17.5v.01",
  plus: "M12 5v14M5 12h14",
  trash: "M4.5 7h15M10 7V4.5h4V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, color = palette.text2, strokeWidth = 1.75 }: {
  name: IconName; size?: number; color?: string; strokeWidth?: number;
}) {
  // décorative : le libellé est porté par le bouton ou le texte voisin
  return (
    <View aria-hidden style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d={PATHS[name]} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        {name === "today" && <Circle cx={12} cy={12} r={3.6} stroke={color} strokeWidth={strokeWidth} />}
      </Svg>
    </View>
  );
}
