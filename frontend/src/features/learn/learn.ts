import type { GrenadeType, LearnEntry, Vec3 } from "../../shared/api/types";
import { gameClock } from "../../shared/roundTime";

/** Indicateurs d'un ensemble de rounds joués à un poste (les autres joueurs, ou moi). */
export interface PosteMetrics {
  rounds: number; winPct: number | null; survivePct: number; kpr: number; adr: number; openingDeathPct: number;
  tradedPct: number | null; deathS: number | null; leftPct: number; leftS: number | null; nadesPerRound: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);

export function metrics(es: LearnEntry[]): PosteMetrics {
  const n = es.length, dead = es.filter((e) => e.death), decided = es.filter((e) => e.won !== null);
  return {
    rounds: n,
    winPct: decided.length ? pct(decided.filter((e) => e.won).length, decided.length) : null,
    survivePct: pct(n - dead.length, n),
    kpr: n ? es.reduce((a, e) => a + e.kills, 0) / n : 0,
    adr: n ? es.reduce((a, e) => a + e.damage, 0) / n : 0,
    openingDeathPct: pct(dead.filter((e) => e.death!.opening).length, n),
    tradedPct: dead.length ? pct(dead.filter((e) => e.death!.traded).length, dead.length) : null,
    deathS: median(dead.map((e) => e.death!.time_s)),
    leftPct: pct(es.filter((e) => e.left_s !== null).length, n),
    leftS: median(es.flatMap((e) => (e.left_s !== null ? [e.left_s] : []))),
    nadesPerRound: n ? es.reduce((a, e) => a + e.grenades.filter((g) => g.type !== "decoy").length, 0) / n : 0,
  };
}

export interface NadeSpot { type: GrenadeType; land: Vec3; count: number; perRound: number; timeS: number; setpos: string | null; players: string[] }

/** Utilitaires typiques du poste : grenades regroupées par type et zone d'arrivée (250 unités). */
export function nadeSpots(es: LearnEntry[]): NadeSpot[] {
  const spots: (NadeSpot & { times: number[]; ps: Set<string> })[] = [];
  for (const e of es) for (const g of e.grenades) {
    if (!g.land || g.type === "decoy") continue;
    const type = g.type === "incendiary" ? "molotov" : g.type;
    let s = spots.find((s) => s.type === type && Math.hypot(s.land[0] - g.land![0], s.land[1] - g.land![1]) <= 250);
    if (!s) spots.push(s = { type, land: g.land, count: 0, perRound: 0, timeS: 0, setpos: null, players: [], times: [], ps: new Set() });
    s.count++; s.times.push(g.time_s); s.ps.add(e.name);
    if (!s.setpos && g.setpos) s.setpos = g.setpos;
  }
  return spots.map(({ times, ps, ...s }) => ({ ...s, perRound: es.length ? s.count / es.length : 0, timeS: median(times) ?? 0, players: [...ps] }))
    .filter((s) => s.count >= 2 || es.length < 4).sort((a, b) => b.count - a.count);
}

const fmt = gameClock;  // horloge du jeu (1:55 au début du round)

export interface Tip { kind: "good" | "work" | "info"; text: string }

/** Conseils : écarts entre mes rounds et ceux des autres à ce poste, puis repères tirés des autres. */
export function tips(others: LearnEntry[], mine: LearnEntry[], label: (place: string | null | undefined, pos?: Vec3 | null) => string | null,
  nadeLabel: (t: GrenadeType) => string): Tip[] {
  const out: Tip[] = [];
  const o = metrics(others);
  if (mine.length) {
    const m = metrics(mine);
    if (m.survivePct + 15 <= o.survivePct) out.push({ kind: "work", text: `Tu survis moins souvent qu'eux (${Math.round(m.survivePct)} % contre ${Math.round(o.survivePct)} %). Compare ta position à ${fmt(20)} avec leurs points sur la carte.` });
    else if (m.survivePct >= o.survivePct + 10) out.push({ kind: "good", text: `Tu survis plus souvent qu'eux (${Math.round(m.survivePct)} % contre ${Math.round(o.survivePct)} %).` });
    if (m.deathS !== null && o.deathS !== null && m.deathS + 5 <= o.deathS)
      out.push({ kind: "work", text: `Tu meurs plus tôt (vers ${fmt(m.deathS)}, eux vers ${fmt(o.deathS)}) : attends l'information ou joue plus en retrait avant de prendre un duel.` });
    if (m.openingDeathPct >= o.openingDeathPct + 15)
      out.push({ kind: "work", text: `Tu donnes trop souvent le premier kill du round (${Math.round(m.openingDeathPct)} % de tes rounds, ${Math.round(o.openingDeathPct)} % pour eux).` });
    if (m.nadesPerRound + 0.5 <= o.nadesPerRound)
      out.push({ kind: "work", text: `Tu lances moins d'utilitaires (${m.nadesPerRound.toFixed(1)} par round contre ${o.nadesPerRound.toFixed(1)}). Entraîne les lineups du poste ci-dessous.` });
    if (m.kpr + 0.2 <= o.kpr) out.push({ kind: "work", text: `Moins de kills par round qu'eux (${m.kpr.toFixed(2)} contre ${o.kpr.toFixed(2)}).` });
    else if (m.kpr >= o.kpr + 0.2) out.push({ kind: "good", text: `Plus de kills par round qu'eux (${m.kpr.toFixed(2)} contre ${o.kpr.toFixed(2)}).` });
    if (Math.abs(m.leftPct - o.leftPct) >= 25)
      out.push({ kind: "info", text: m.leftPct > o.leftPct ? `Tu quittes ton poste plus souvent qu'eux (${Math.round(m.leftPct)} % des rounds contre ${Math.round(o.leftPct)} %) : rotation trop rapide ?`
        : `Tu restes à ton poste plus souvent qu'eux (eux tournent dans ${Math.round(o.leftPct)} % des rounds${o.leftS !== null ? `, vers ${fmt(o.leftS)}` : ""}).` });
  }
  // repères généraux tirés des autres
  const dead = others.filter((e) => e.death);
  const from = new Map<string, number>();
  for (const e of dead) { const l = label(e.death!.attacker_place, e.death!.attacker_pos); if (l) from.set(l, (from.get(l) ?? 0) + 1); }
  const top = [...from.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2 && dead.length >= 3) out.push({ kind: "info", text: `${top[1]} morts sur ${dead.length} à ce poste viennent de ${top[0]} : c'est l'angle à surveiller.` });
  const spots = nadeSpots(others).slice(0, 3);
  if (spots.length) out.push({ kind: "info", text: `Utilitaires les plus utilisés ici : ${spots.map((s) => `${nadeLabel(s.type)} → ${label(null, s.land) ?? "?"} (vers ${fmt(s.timeS)})`).join(", ")}.` });
  if (o.leftS !== null && o.leftPct >= 20) out.push({ kind: "info", text: `Ils quittent le poste dans ${Math.round(o.leftPct)} % des rounds, en général vers ${fmt(o.leftS)}.` });
  return out;
}

export { fmt };
