import { Platform, type TextStyle } from "react-native";

/** « Carnet tactique » : les couleurs du site (on reconnaît Sightline), une seule couleur d'accent, CT/T pour les camps. */
export const color = {
  bg: "#0c0f12",
  surface: "#12161a",
  surface2: "#181d22",
  surface3: "#20262d",
  line: "#1f252c",
  lineStrong: "#2c343d",
  text: "#eef2f5",
  text2: "#a4adb7",
  text3: "#8a95a1",
  accent: "#2ee6a6",
  accentDim: "rgba(46, 230, 166, 0.12)",
  accentLine: "rgba(46, 230, 166, 0.32)",
  onAccent: "#04170f",
  ct: "#5b9dff",
  ctDim: "rgba(91, 157, 255, 0.16)",
  t: "#f0b03a",
  tDim: "rgba(240, 176, 58, 0.16)",
  good: "#2ee6a6",
  bad: "#ef5f67",
  badDim: "rgba(239, 95, 103, 0.14)",
  warn: "#e6b450",
  smoke: "#c9d1dc",
  flash: "#fff6c2",
  molotov: "#ff6a2b",
  he: "#ff3b3b",
  scrim: "rgba(5, 7, 9, 0.6)",
  bar: "rgba(12, 15, 18, 0.82)",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, card: 14, lg: 20, pill: 999 } as const;
/** cible tactile minimale (HIG) */
export const TOUCH = 44;
/** hauteur de la barre d'onglets dessinée pour le web (sans la zone de sécurité) */
export const TAB_BAR_H = 56;

export const font = {
  display: "Saira_700Bold",
  displaySemi: "Saira_600SemiBold",
  mono: "JetBrainsMono_500Medium",
  monoBold: "JetBrainsMono_700Bold",
  /** texte courant : police du système (SF Pro sur iPhone), qui suit la taille choisie dans Réglages */
  body: Platform.select({ web: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif", default: undefined }),
} as const;

const tabular: TextStyle["fontVariant"] = ["tabular-nums"];

/** Échelle typographique : interlignage serré et approche négative en grand, plus aéré en petit. */
export const type = {
  largeTitle: { fontFamily: font.display, fontSize: 34, lineHeight: 40, letterSpacing: -0.6, color: color.text },
  title: { fontFamily: font.displaySemi, fontSize: 24, lineHeight: 30, letterSpacing: -0.3, color: color.text },
  headline: { fontFamily: font.body, fontSize: 17, lineHeight: 22, fontWeight: "600", color: color.text },
  body: { fontFamily: font.body, fontSize: 16, lineHeight: 22, color: color.text },
  callout: { fontFamily: font.body, fontSize: 15, lineHeight: 21, color: color.text2 },
  subhead: { fontFamily: font.body, fontSize: 14, lineHeight: 19, fontWeight: "500", color: color.text2 },
  caption: { fontFamily: font.body, fontSize: 13, lineHeight: 17, color: color.text3 },
  /** étiquette de section, façon onglet de carnet */
  label: { fontFamily: font.monoBold, fontSize: 12, lineHeight: 16, letterSpacing: 1.1, textTransform: "uppercase", color: color.text3 },
  /** grand chiffre (rating, score) */
  number: { fontFamily: font.display, fontSize: 30, lineHeight: 34, letterSpacing: -0.4, color: color.text, fontVariant: tabular },
  /** donnée chiffrée dans le texte */
  data: { fontFamily: font.mono, fontSize: 14, lineHeight: 19, color: color.text, fontVariant: tabular },
  dataSmall: { fontFamily: font.mono, fontSize: 12, lineHeight: 16, color: color.text2, fontVariant: tabular },
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof type;

/** Durées (ms) et ressorts sans rebond (amortissement 1), rebond léger réservé aux gestes lancés. */
export const motion = {
  press: 100,
  fast: 160,
  base: 220,
  spring: { damping: 26, stiffness: 260, mass: 1 },
  fling: { damping: 20, stiffness: 220, mass: 1 },
} as const;

export const NADE_COLOR: Record<string, string> = {
  smoke: color.smoke, flash: color.flash, molotov: color.molotov, incendiary: color.molotov, he: color.he, decoy: color.text3,
};

export const sideColor = (side: "T" | "CT" | null | undefined) => (side === "CT" ? color.ct : side === "T" ? color.t : color.text3);
