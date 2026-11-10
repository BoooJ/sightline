export function rollingMean(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const part = values.slice(Math.max(0, i - window + 1), i + 1);
    return part.reduce((s, v) => s + v, 0) / part.length;
  });
}

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const FLAT = 0.03; // écart de rating sous lequel on parle de stabilité

/** Moyenne des `recentN` derniers matchs comparée à celle des précédents. */
export function trendSummary(values: number[], recentN = 5): { recent: number; before: number | null; direction: "up" | "down" | "flat" } {
  const recent = mean(values.slice(-recentN));
  const rest = values.slice(0, Math.max(0, values.length - recentN));
  if (!rest.length) return { recent, before: null, direction: "flat" };
  const before = mean(rest);
  const d = recent - before;
  return { recent, before, direction: d > FLAT ? "up" : d < -FLAT ? "down" : "flat" };
}
