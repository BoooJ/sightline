import type { GrenadeThrow, GrenadeType, Side, Vec3 } from "../../shared/api/types";

/** Recherche de combinaisons (« pattern finder ») : ensembles de grenades qu'une équipe lance ensemble, au même
 *  endroit, dans plusieurs rounds. Une combinaison = 2 à 4 grenades (type + zone d'arrivée) lancées dans la même
 *  salve (moins de GAP_S secondes entre deux lancers) ; elle compte une fois par round. */
export const ZONE_R = 250, GAP_S = 12, MAX_ITEMS = 4, MAX_TOKENS = 10;

export interface ComboItem { type: GrenadeType; land: Vec3; sample: GrenadeThrow }
export interface ComboRound {
  match_id: number; round_number: number; team: string; opponent: string; won: boolean | null; time_s: number; tick: number;
  throws: GrenadeThrow[];
}
export interface Combo { key: string; side: Side; team: string; items: ComboItem[]; rounds: ComboRound[]; winRate: number | null; time_s: number }

interface Zone { id: number; type: GrenadeType; side: Side; team_id: number; land: Vec3; n: number }

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const TYPE_RANK: Record<GrenadeType, number> = { smoke: 0, flash: 1, he: 2, molotov: 3, incendiary: 3, decoy: 4 };
const fire = (t: GrenadeType): GrenadeType => (t === "incendiary" ? "molotov" : t);  // molotov T = incendiaire CT

function* subsets<T>(xs: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i <= xs.length - (k - acc.length); i++) yield* subsets(xs, k, i + 1, [...acc, xs[i]]);
}

export function findCombos(throws: GrenadeThrow[], minRounds = 2): Combo[] {
  // zones d'arrivée par équipe, camp et type (centre = premier lancer, comme les lineups)
  const zones: Zone[] = [];
  const zoneOf = new Map<number, Zone>();
  for (const t of throws) {
    if (!t.land || t.type === "decoy") continue;
    const type = fire(t.type);
    let z = zones.find((z) => z.type === type && z.side === t.side && z.team_id === t.team_id && dist(z.land, t.land!) <= ZONE_R);
    if (!z) zones.push(z = { id: zones.length, type, side: t.side, team_id: t.team_id, land: t.land, n: 0 });
    z.n++;
    zoneOf.set(t.id, z);
  }
  // salves : lancers d'une équipe dans un round, séparés de moins de GAP_S secondes
  const byRound = new Map<string, GrenadeThrow[]>();
  for (const t of throws) {
    if (!zoneOf.has(t.id)) continue;
    const k = `${t.match_id}:${t.round_number}:${t.team_id}`;
    (byRound.get(k) ?? byRound.set(k, []).get(k)!).push(t);
  }
  const found = new Map<string, { zones: Zone[]; rounds: Map<string, ComboRound> }>();
  for (const [rk, ts] of byRound) {
    ts.sort((a, b) => a.throw_tick - b.throw_tick);
    const bursts: GrenadeThrow[][] = [];
    for (const t of ts) {
      const last = bursts[bursts.length - 1];
      if (last && t.time_s - last[last.length - 1].time_s <= GAP_S) last.push(t); else bursts.push([t]);
    }
    for (const b of bursts) {
      // une grenade par zone (la première), en ignorant les zones vues une seule fois dans toute la bibliothèque
      const first = new Map<number, GrenadeThrow>();
      for (const t of b) { const z = zoneOf.get(t.id)!; if (z.n >= minRounds && !first.has(z.id)) first.set(z.id, t); }
      const ids = [...first.keys()].slice(0, MAX_TOKENS).sort((a, b) => a - b);
      for (let k = 2; k <= Math.min(MAX_ITEMS, ids.length); k++) {
        for (const sub of subsets(ids, k)) {
          const key = sub.join("-");
          const e = found.get(key) ?? found.set(key, { zones: sub.map((id) => zones[id]), rounds: new Map() }).get(key)!;
          if (e.rounds.has(rk)) continue;
          const sel = sub.map((id) => first.get(id)!);
          const t0 = sel.reduce((a, t) => (t.throw_tick < a.throw_tick ? t : a));
          e.rounds.set(rk, { match_id: t0.match_id, round_number: t0.round_number, team: t0.team, opponent: t0.opponent, won: t0.won,
            time_s: t0.time_s, tick: t0.throw_tick, throws: sel });
        }
      }
    }
  }
  const all = [...found.entries()].filter(([, e]) => e.rounds.size >= minRounds);
  // combinaisons « fermées » : on écarte celles incluses dans une plus grande observée dans les mêmes rounds
  const closed = all.filter(([key, e]) => {
    const mine = key.split("-");
    return !all.some(([k2, e2]) => k2 !== key && e2.rounds.size === e.rounds.size && e2.zones.length > e.zones.length
      && mine.every((id) => k2.split("-").includes(id)));
  });
  return closed.map(([key, e]): Combo => {
    const rounds = [...e.rounds.values()].sort((a, b) => b.match_id - a.match_id || a.round_number - b.round_number);
    const decided = rounds.filter((r) => r.won !== null);
    const zs = [...e.zones].sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type]);
    // grenades de chaque round dans l'ordre des éléments de la combinaison
    for (const r of rounds) r.throws = zs.map((z) => r.throws.find((t) => zoneOf.get(t.id) === z)!);
    const items = zs.map((z) => ({ type: z.type, land: z.land, sample: rounds[0].throws[zs.indexOf(z)] }));
    const times = rounds.map((r) => r.time_s).sort((a, b) => a - b);
    return { key, side: e.zones[0].side, team: rounds[0].team, items, rounds,
      winRate: decided.length ? decided.filter((r) => r.won).length / decided.length : null, time_s: times[Math.floor(times.length / 2)] };
  }).sort((a, b) => b.rounds.length - a.rounds.length || b.items.length - a.items.length);
}
