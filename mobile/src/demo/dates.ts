const pad = (n: number) => String(n).padStart(2, "0");

/** Remplace les dates « @-3 », « @-1T19:00:00 » des données de démo par des dates réelles relatives à `today`. */
export function shiftDates<T>(v: T, today: Date): T {
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") {
      const m = /^@(-?\d+)(.*)$/.exec(x);
      if (!m) return x;
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + Number(m[1]));
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${m[2]}`;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as T;
}
