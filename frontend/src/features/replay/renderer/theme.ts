export interface Theme { ct: string; t: string; smoke: string; fire: string; flash: string; he: string; fg: string; bg: string; accent: string }
export function readTheme(): Theme {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return { ct: v("--ct"), t: v("--t"), smoke: v("--smoke"), fire: v("--fire"), flash: v("--flash"), he: v("--he"),
    fg: v("--fg-0"), bg: v("--bg-0"), accent: v("--accent") };
}
