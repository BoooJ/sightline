// Mise en forme à la française, sans Intl (données de locale inégales selon les moteurs JS mobiles).
const NNBSP = " "; // espace fine insécable : « 54 % », « 42 s »
const MINUS = "−";
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const DAY_MS = 86_400_000;

const ok = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export function num(v: number | null | undefined, digits = 2): string {
  if (!ok(v)) return "—";
  const s = Math.abs(v).toFixed(digits).replace(".", ",");
  return v < 0 && Number(s.replace(",", ".")) !== 0 ? MINUS + s : s;
}

export function signed(v: number | null | undefined, digits = 1): string {
  if (!ok(v)) return "—";
  const s = num(v, digits);
  return v > 0 && s !== num(0, digits) ? `+${s}` : s;
}

export function pct(v: number | null | undefined, digits = 0): string {
  return ok(v) ? `${num(v, digits)}${NNBSP}%` : "—";
}

export function secs(v: number | null | undefined): string {
  return ok(v) ? `${Math.round(v)}${NNBSP}s` : "—";
}

export function clock(v: number | null | undefined): string {
  if (!ok(v)) return "—";
  const s = Math.max(0, Math.round(v));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Durée d'un round après le freeze time : l'horloge du jeu part de 1:55 (comme shared/roundTime.ts du site). */
const ROUND_S = 115;

/** Horloge du jeu `s` secondes après la fin du freeze time (0 → « 1:55 », 13 → « 1:42 »). */
export function gameClock(s: number | null | undefined): string {
  return ok(s) ? clock(ROUND_S - s) : "—";
}

/** Date « 2026-10-21T20:00 » ou « 2026-10-21 » lue en heure locale. Avec un fuseau (« …Z », « +01:00 », comme les
 *  événements du calendrier, stockés en UTC), c'est un instant : affiché dans l'heure locale de chacun. */
export function parseLocal(iso: string): Date {
  if (/(Z|[+-]\d\d:?\d\d)$/.test(iso)) return new Date(iso);
  const [d, t = "00:00"] = iso.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [h, min] = t.split(":").map(Number);
  return new Date(y, (m || 1) - 1, day || 1, h || 0, min || 0);
}

/** Horodatage de la base (UTC, souvent écrit sans « Z » par Python). */
export function parseUtc(iso: string): Date {
  return new Date(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`);
}

const startOfDay =(d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function countdown(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms < 0) return "commencé";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `dans ${Math.max(1, min)} min`;
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `dans ${h} h`;
  return `dans ${Math.round((startOfDay(target) - startOfDay(now)) / DAY_MS)} j`;
}

export function shortDate(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const d = parseLocal(iso);
  const days = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (days === 0) return "aujourd'hui";
  if (days === -1) return "hier";
  if (days === 1) return "demain";
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

const WEEKDAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « lundi 20 octobre » */
export function longDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`;
}

export function time(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
