import type { GrenadeType, LearnEntry, Vec3 } from "../../shared/api/types";
import { weaponLabel } from "../../shared/format";
import { fmt, metrics, nadeSpots, type PosteMetrics } from "./learn";

/* Analyses avancées d'un poste : situations, placements, déroulé type, duels, joueurs, progression, séance commentée,
 * programme d'entraînement. Fonctions pures (testées dans advanced.test.ts). */

type Label = (place: string | null | undefined, pos?: Vec3 | null) => string | null;
type NadeLabel = (t: GrenadeType) => string;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

export type SiteFilter = "all" | "this" | "other" | "none";
export interface LearnFilter { site: SiteFilter; buy: string[]; opponent: string; player: string; spot: number | null }
export const NO_FILTER: LearnFilter = { site: "all", buy: [], opponent: "", player: "", spot: null };

/** Site de bombe le plus proche du poste (centre des positions), en tenant compte de l'étage. */
export function posteSite(es: LearnEntry[], sites: Record<string, [number, number, number | null]> | undefined): string | null {
  if (!es.length || !sites) return null;
  const c = [0, 1, 2].map((k) => es.reduce((a, e) => a + e.pos[k], 0) / es.length);
  let best: string | null = null, bd = Infinity;
  for (const [k, s] of Object.entries(sites)) {
    const d = Math.hypot(s[0] - c[0], s[1] - c[1]) + (s[2] === null ? 0 : 3 * Math.abs(s[2] - c[2]));
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

export interface Spot { id: number; pos: Vec3; entries: LearnEntry[]; m: PosteMetrics }

/** Variantes de placement au sein du poste : positions de prise de poste regroupées à 220 unités près (même étage). */
export function spots(es: LearnEntry[]): Spot[] {
  const out: { pos: Vec3; entries: LearnEntry[] }[] = [];
  for (const e of es) {
    const s = out.find((s) => Math.hypot(s.pos[0] - e.pos[0], s.pos[1] - e.pos[1]) <= 220 && Math.abs(s.pos[2] - e.pos[2]) <= 150);
    if (s) s.entries.push(e); else out.push({ pos: e.pos, entries: [e] });
  }
  return out.map((s) => {
    const c = [0, 1, 2].map((k) => Math.round(s.entries.reduce((a, e) => a + e.pos[k], 0) / s.entries.length)) as Vec3;
    return { pos: c, entries: s.entries, m: metrics(s.entries) };
  }).sort((a, b) => b.entries.length - a.entries.length).map((s, id) => ({ ...s, id }));
}

export function applyFilter(es: LearnEntry[], f: LearnFilter, site: string | null, spotList: Spot[]): LearnEntry[] {
  const spot = f.spot === null ? null : spotList.find((s) => s.id === f.spot);
  return es.filter((e) => {
    if (f.site === "this" && (!site || e.bomb_site !== site)) return false;
    if (f.site === "other" && (!e.bomb_site || e.bomb_site === site)) return false;
    if (f.site === "none" && e.bomb_site) return false;
    if (f.buy.length && !f.buy.includes(e.buy)) return false;
    if (f.opponent && e.opponent !== f.opponent) return false;
    if (f.player && e.steamid !== f.player) return false;
    if (spot && !spot.entries.includes(e)) return false;
    return true;
  });
}

export const TL_STEP = 2, TL_MAX = 90;
export interface TimelineCol { t: number; held: number; left: number; dead: number; over: number }

/** Déroulé type : à chaque instant, part des rounds où le joueur tient le poste, l'a quitté, est mort, ou round terminé. */
export function timeline(es: LearnEntry[]): TimelineCol[] {
  const cols: TimelineCol[] = [];
  const n = Math.max(1, es.length);
  for (let t = 0; t <= TL_MAX; t += TL_STEP) {
    let held = 0, left = 0, dead = 0, over = 0;
    for (const e of es) {
      if (e.death && e.death.time_s <= t) dead++;
      else if (e.round_end_s <= t) over++;
      else if (e.left_s !== null && e.left_s <= t) left++;
      else held++;
    }
    cols.push({ t, held: held / n, left: left / n, dead: dead / n, over: over / n });
  }
  return cols;
}

export interface ChronoEvent { t: number; text: string; pct: number; kind: "nade" | "contact" | "left" | "death" | "plant" | "kill" }

/** Chronologie type d'un round à ce poste (moments médians). */
export function chronology(es: LearnEntry[], placeAt: (p: Vec3 | null) => string | null, nadeLabel: NadeLabel): ChronoEvent[] {
  if (!es.length) return [];
  const n = es.length, ev: ChronoEvent[] = [];
  for (const s of nadeSpots(es).slice(0, 5))
    ev.push({ t: s.timeS, kind: "nade", pct: s.perRound * 100, text: `${nadeLabel(s.type)} → ${placeAt(s.land) ?? "?"}` });
  const add = (xs: number[], kind: ChronoEvent["kind"], text: string) => {
    const m = median(xs);
    if (m !== null) ev.push({ t: m, kind, pct: (100 * xs.length) / n, text });
  };
  add(es.flatMap((e) => (e.contact_s !== null ? [e.contact_s] : [])), "contact", "Premier contact (dégâts donnés ou reçus)");
  add(es.flatMap((e) => (e.first_kill_s !== null ? [e.first_kill_s] : [])), "kill", "Premier kill");
  add(es.flatMap((e) => (e.left_s !== null ? [e.left_s] : [])), "left", "Quitte le poste (rotation)");
  add(es.flatMap((e) => (e.plant_s !== null ? [e.plant_s] : [])), "plant", "Bombe posée");
  add(es.flatMap((e) => (e.death ? [e.death.time_s] : [])), "death", "Mort");
  return ev.sort((a, b) => a.t - b.t);
}

export interface Count { label: string; n: number }
const countBy = (xs: string[]): Count[] => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
};

export interface Duels { deaths: number; kills: number; deathsFrom: Count[]; deathWeapons: Count[]; killsOn: Count[]; killWeapons: Count[]; deathDist: number | null; killDist: number | null }

export function duels(es: LearnEntry[], label: Label): Duels {
  const deaths = es.flatMap((e) => (e.death ? [e.death] : []));
  const kills = es.flatMap((e) => e.kills_detail);
  const dist = (a: Vec3 | null, b: Vec3 | null) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : null);
  const dd = deaths.flatMap((d) => { const x = dist(d.pos, d.attacker_pos); return x === null ? [] : [x]; });
  const kd = kills.flatMap((k) => { const x = dist(k.pos, k.victim_pos); return x === null ? [] : [x]; });
  return {
    deaths: deaths.length, kills: kills.length,
    deathsFrom: countBy(deaths.map((d) => label(d.attacker_place, d.attacker_pos) ?? "?")),
    deathWeapons: countBy(deaths.map((d) => weaponLabel(d.weapon))),
    killsOn: countBy(kills.map((k) => label(k.victim_place, k.victim_pos) ?? "?")),
    killWeapons: countBy(kills.map((k) => weaponLabel(k.weapon))),
    deathDist: median(dd), killDist: median(kd),
  };
}

export interface PlayerRow { steamid: string; name: string; team: string; entries: LearnEntry[]; m: PosteMetrics }

export function byPlayer(es: LearnEntry[]): PlayerRow[] {
  const g = new Map<string, LearnEntry[]>();
  for (const e of es) (g.get(e.steamid) ?? g.set(e.steamid, []).get(e.steamid)!).push(e);
  return [...g.entries()].map(([steamid, xs]) => ({ steamid, name: xs[0].name, team: xs[0].team, entries: xs, m: metrics(xs) }))
    .sort((a, b) => b.entries.length - a.entries.length);
}

export interface MatchRow { key: string; label: string; date: string | null; m: PosteMetrics }

/** Ma progression à ce poste, match par match (ordre chronologique). */
export function progression(mine: LearnEntry[]): MatchRow[] {
  const g = new Map<number, LearnEntry[]>();
  for (const e of mine) (g.get(e.match_id) ?? g.set(e.match_id, []).get(e.match_id)!).push(e);
  return [...g.entries()].sort((a, b) => (a[1][0].played_at ?? "").localeCompare(b[1][0].played_at ?? "") || a[0] - b[0])
    .map(([id, xs]) => ({ key: String(id), label: `vs ${xs[0].opponent}`, date: xs[0].played_at, m: metrics(xs) }));
}

export interface Mark { tick: number; text: string }

/** Pauses commentées d'une séance d'étude : utilitaires, premier contact, kills, rotation, bombe, mort. */
export function studyMarks(e: LearnEntry, label: Label, nadeLabel: NadeLabel): Mark[] {
  const at = (s: number) => Math.round(e.start_tick + s * e.rate);
  const out: Mark[] = [];
  for (const g of e.grenades) if (g.type !== "decoy") out.push({ tick: g.tick, text: `${nadeLabel(g.type)} lancée vers ${label(null, g.land) ?? "?"} (${fmt(g.time_s)}).` });
  if (e.contact_s !== null) out.push({ tick: at(e.contact_s), text: `Premier contact à ${fmt(e.contact_s)} : observe d'où vient l'adversaire.` });
  for (const k of e.kills_detail) out.push({ tick: k.tick, text: `Kill (${weaponLabel(k.weapon)}) sur ${label(k.victim_place, k.victim_pos) ?? "?"} à ${fmt(k.time_s)}${k.opening ? ", premier kill du round" : ""}.` });
  if (e.left_s !== null) out.push({ tick: at(e.left_s), text: `Il quitte le poste à ${fmt(e.left_s)} : regarde pourquoi (info, bombe, appel).` });
  if (e.plant_s !== null) out.push({ tick: at(e.plant_s), text: `Bombe posée en ${e.bomb_site ?? "?"} à ${fmt(e.plant_s)}.` });
  if (e.death) out.push({ tick: e.death.tick, text: `Mort à ${fmt(e.death.time_s)} : ${weaponLabel(e.death.weapon)} depuis ${label(e.death.attacker_place, e.death.attacker_pos) ?? "?"}${e.death.traded ? " (vengé)" : ""}.` });
  return out.sort((a, b) => a.tick - b.tick).filter((m, i, xs) => !i || m.tick - xs[i - 1].tick > e.rate / 2);
}

export interface Goal { id: string; text: string; auto?: boolean | null }

/** Programme d'entraînement : étapes à cocher et objectifs chiffrés (vérifiés automatiquement sur mes rounds). */
export function programme(others: LearnEntry[], mine: LearnEntry[], placeAt: (p: Vec3 | null) => string | null, nadeLabel: NadeLabel): Goal[] {
  const o = metrics(others), m = mine.length ? metrics(mine) : null;
  const goals: Goal[] = [
    { id: "study", text: "Regarder au moins 10 rounds des autres à ce poste (« Étudier leurs rounds »), pauses commentées activées" },
    { id: "spots", text: "Repérer le placement qui survit le mieux (onglet Déroulé) et l'essayer en jeu" },
  ];
  for (const s of nadeSpots(others).slice(0, 4))
    goals.push({ id: `nade-${s.type}-${s.land.join("_")}`, text: `Maîtriser ${nadeLabel(s.type)} → ${placeAt(s.land) ?? "zone sans nom"} (fichier .cfg, vers ${fmt(s.timeS)})` });
  goals.push({ id: "duels", text: "Connaître les deux angles d'où viennent le plus de morts (onglet Duels)" });
  goals.push({ id: "g-survie", text: `Objectif : survie ≥ ${Math.round(o.survivePct)} % à ce poste`, auto: m ? m.survivePct >= o.survivePct : null });
  goals.push({ id: "g-kpr", text: `Objectif : ${o.kpr.toFixed(2)} kill par round ou plus`, auto: m ? m.kpr >= o.kpr : null });
  goals.push({ id: "g-nades", text: `Objectif : ${o.nadesPerRound.toFixed(1)} utilitaire par round ou plus`, auto: m ? m.nadesPerRound >= o.nadesPerRound - 0.05 : null });
  if (o.deathS !== null)
    goals.push({ id: "g-death", text: `Objectif : ne pas mourir avant ${fmt(o.deathS)} en moyenne`, auto: m ? (m.deathS === null || m.deathS >= o.deathS) : null });
  return goals;
}

/** Position d'un joueur à l'instant t (trajet échantillonné toutes les 2 s) ; null s'il est mort ou le round fini. */
export function posAt(e: LearnEntry, t: number): Vec3 | null {
  if ((e.death && e.death.time_s <= t) || e.round_end_s <= t) return null;
  const k = t / TL_STEP, i = Math.floor(k);
  const a = e.path[i], b = e.path[i + 1];
  if (!a) return null;
  if (!b) return a;
  const f = k - i;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
