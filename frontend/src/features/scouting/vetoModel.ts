import type { VetoMap } from "../../shared/api/types";

/** Modèle du simulateur de veto : ordres de séquence, prédictions par étape et arbre de scénarios. */
export type Side = "a" | "b";
export type Action = "ban" | "pick" | "decider";
export type Step = { team: Side; action: "ban" | "pick" };
export type Done = { map: string; team: Side; action: Action };
export type Format = "bo1" | "bo3" | "bo5";

const mk = (s: string, action: "ban" | "pick" = "ban"): Step[] => s.split("").map((c) => ({ team: c.toLowerCase() as Side, action }));
/** Ordres proposés par format (comme EDGE : BO1 ABABAB / AABBBA / ABBAAB). */
export const ORDERS: Record<Format, Record<string, Step[]>> = {
  bo1: { ABABAB: mk("ABABAB"), AABBBA: mk("AABBBA"), ABBAAB: mk("ABBAAB") },
  bo3: { "ban ban pick pick ban ban": [...mk("AB"), ...mk("AB", "pick"), ...mk("AB")] },
  bo5: { "ban ban pick pick pick pick": [...mk("AB"), ...mk("ABAB", "pick")] },
};

export const swap = (steps: Step[]): Step[] => steps.map((s) => ({ ...s, team: s.team === "a" ? "b" : "a" }));

/** Étapes effectives pour un pool donné : un pool plus petit retire des bans en fin de séquence. */
export function stepsFor(order: Step[], poolSize: number): Step[] {
  let extra = order.length - Math.max(0, poolSize - 1);
  if (extra <= 0) return order;
  const out = [...order];
  for (let i = out.length - 1; i >= 0 && extra > 0; i--) if (out[i].action === "ban") { out.splice(i, 1); extra--; }
  return out.slice(0, Math.max(0, poolSize - 1));
}

/** Valeur d'une carte pour l'équipe qui agit (avantage estimé de son point de vue). */
export const value = (m: VetoMap, team: Side) => (team === "a" ? m.advantage : -m.advantage);

export interface Prediction { map: string; p: number; label: "Très probable" | "Probable" | "Possible" }

/** Prédiction d'une étape : avantage estimé + habitudes (Pick % / Ban % des vetos enregistrés), softmax. */
export function predict(left: VetoMap[], step: Step): Prediction[] {
  if (!left.length) return [];
  const scores = left.map((m) => {
    const side = m[step.team];
    const habit = step.action === "ban" ? side.ban_pct : side.pick_pct;
    const base = step.action === "ban" ? -value(m, step.team) : value(m, step.team);
    return { map: m.map, s: base * 1.2 + (habit != null ? (habit / 100) * 1.6 : 0) };
  });
  const T = 0.55;
  const mx = Math.max(...scores.map((x) => x.s));
  const ws = scores.map((x) => ({ map: x.map, w: Math.exp((x.s - mx) / T) }));
  const sum = ws.reduce((a, x) => a + x.w, 0);
  return ws.map((x): Prediction => { const p = x.w / sum; return { map: x.map, p, label: p >= 0.5 ? "Très probable" : p >= 0.25 ? "Probable" : "Possible" }; })
    .sort((x, y) => y.p - x.p);
}

/** Probabilité de gagner une série au meilleur de n cartes, cartes jouées dans l'ordre (programmation dynamique). */
export function seriesWin(ps: number[]): number {
  const need = Math.floor(ps.length / 2) + 1;
  let dist = new Map<string, number>([["0-0", 1]]);
  let win = 0;
  for (const p of ps) {
    const next = new Map<string, number>();
    for (const [k, v] of dist) {
      const [a, b] = k.split("-").map(Number);
      for (const [na, nb, q] of [[a + 1, b, p], [a, b + 1, 1 - p]] as const) {
        if (na === need) { win += v * q; continue; }
        if (nb === need) continue;
        const key = `${na}-${nb}`;
        next.set(key, (next.get(key) ?? 0) + v * q);
      }
    }
    dist = next;
  }
  return win;
}

export interface ScenarioNode { step: Step | null; map: string; action: Action; p: number; cum: number; children: ScenarioNode[]; leaf?: { played: string[]; series: number }; truncated?: boolean }

/** Arbre des scénarios à partir de l'état courant : branches élaguées sous `threshold` (probabilité cumulée), au plus `width` choix par étape. */
export function scenarios(all: VetoMap[], steps: Step[], done: Done[], threshold: number, width = 3): ScenarioNode[] {
  const byName = new Map(all.map((m) => [m.map, m]));
  const rec = (used: Set<string>, k: number, cum: number): ScenarioNode[] => {
    const left = all.filter((m) => !used.has(m.map));
    const step = steps[k];
    if (!step) {
      if (left.length !== 1) return [];
      return [{ step: null, map: left[0].map, action: "decider", p: 1, cum, children: [] }];
    }
    const out: ScenarioNode[] = [];
    for (const pr of predict(left, step).slice(0, width)) {
      const c = cum * pr.p;
      if (c < threshold) continue;
      const next = new Set(used); next.add(pr.map);
      const children = rec(next, k + 1, c);
      // branche coupée par le seuil (il reste des étapes mais aucune au-dessus du seuil) : pas une fin de veto
      out.push({ step, map: pr.map, action: step.action, p: pr.p, cum: c, children, truncated: !children.length && k + 1 < steps.length });
    }
    return out;
  };
  const roots = rec(new Set(done.map((d) => d.map)), done.length, 1);
  // feuilles : cartes jouées et chances de A sur la série
  const walk = (nodes: ScenarioNode[], picks: string[]) => {
    for (const n of nodes) {
      const next = n.action === "ban" ? picks : [...picks, n.map];
      if (!n.children.length && !n.truncated) {
        const played = [...done.filter((d) => d.action !== "ban").map((d) => d.map), ...next];
        n.leaf = { played, series: played.length ? seriesWin(played.map((m) => byName.get(m)?.p_a ?? 0.5)) : 0.5 };
      } else walk(n.children, next);
    }
  };
  walk(roots, []);
  return roots;
}

export function leaves(nodes: ScenarioNode[], path: ScenarioNode[] = []): { path: ScenarioNode[]; node: ScenarioNode }[] {
  const out: { path: ScenarioNode[]; node: ScenarioNode }[] = [];
  for (const n of nodes) {
    const p = [...path, n];
    if (!n.children.length) out.push({ path: p, node: n }); else out.push(...leaves(n.children, p));
  }
  return out.sort((x, y) => y.node.cum - x.node.cum);
}
