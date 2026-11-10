import type { CalendarEvent, Dashboard, LikelyMaps, NotificationT, ProfileLine, ScoutTeam } from "@/api/types";

import { parseLocal, parseUtc } from "./format";
import { matchOpponent } from "./opponent";

export type TrendPoint = Dashboard["trend"][number];

export type TodayCard =
  | { kind: "prep"; event: CalendarEvent; team: ScoutTeam | null; soon: boolean }
  | { kind: "debrief"; match: ProfileLine; fresh: boolean }
  | { kind: "form"; trend: TrendPoint[] }
  | { kind: "grenades"; map: string };

export interface TodayInput {
  now: Date;
  events: CalendarEvent[];
  teams: ScoutTeam[];
  /** matchs du joueur, du plus récent au plus ancien */
  recent: ProfileLine[];
  trend: TrendPoint[];
  /** bilans déjà ouverts dans l'app */
  seen: Set<number>;
  /** analyses terminées (notifications « match prêt ») */
  ready: { match_id: number; at: Date }[];
}

const PLAYED: CalendarEvent["kind"][] = ["match", "tournament", "scrim"];

/** Analyses terminées, lues dans les notifications « match prêt » (lien /matches/{id}). */
export function readyFrom(notifications: NotificationT[]): { match_id: number; at: Date }[] {
  return notifications.flatMap((n) => {
    const id = n.kind === "match_ready" ? /\/matches\/(\d+)/.exec(n.link)?.[1] : undefined;
    return id && n.created_at ? [{ match_id: Number(id), at: parseUtc(n.created_at) }] : [];
  });
}
const DAY_MS = 86_400_000;

/** Les cartes probables qui valent d'être montrées : 5 % et plus, trois au plus. */
export function likelyTop(odds: LikelyMaps | null | undefined, n = 3): LikelyMaps["maps"] {
  return (odds?.maps ?? []).filter((m) => m.pct >= 5).slice(0, n);
}

export function nextEvent(events: CalendarEvent[], now: Date): CalendarEvent | null {
  return events
    .filter((e) => PLAYED.includes(e.kind) && parseLocal(e.starts_at).getTime() >= now.getTime())
    .sort((a, b) => parseLocal(a.starts_at).getTime() - parseLocal(b.starts_at).getTime())[0] ?? null;
}

/** Les cartes de l'écran « Aujourd'hui », dans l'ordre du moment que vit le joueur. */
export function buildToday(i: TodayInput): TodayCard[] {
  const ev = nextEvent(i.events, i.now);
  const last = i.recent[0] ?? null;
  const prep: TodayCard | null = ev
    ? { kind: "prep", event: ev, team: matchOpponent(ev.opponent, i.teams),
        soon: parseLocal(ev.starts_at).getTime() - i.now.getTime() < DAY_MS }
    : null;
  const readyAt = last ? i.ready.find((r) => r.match_id === last.match_id)?.at : undefined;
  const fresh = !!last && !!readyAt && !i.seen.has(last.match_id) && i.now.getTime() - readyAt.getTime() < DAY_MS;
  const debrief: TodayCard | null = last ? { kind: "debrief", match: last, fresh } : null;
  const form: TodayCard | null = i.trend.length >= 2 ? { kind: "form", trend: i.trend } : null;
  const map = ev?.maps[0] ?? last?.map;
  const grenades: TodayCard | null = map ? { kind: "grenades", map } : null;
  const order = fresh ? [debrief, prep, form, grenades] : [prep, debrief, form, grenades];
  return order.filter((c): c is TodayCard => c !== null);
}
