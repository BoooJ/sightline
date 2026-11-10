import { toSummary } from "@/lib/strats";

import { ApiError, type Api } from "./api";
import type {
  AppUser, Callouts, CareerStats, Dashboard, GrenadeSearch, MapMeta, MatchAnalysis, MatchDebriefT, MatchDetail,
  NoteFilter, NoteInput, NoteT, PlayerProfile, ScoutBrief, ScoutReport, ScoutTeam, Strat, TeamGoalT,
} from "./types";

/** Note de la démo telle qu'elle est gardée sur le téléphone (le contexte affiché est recalculé à chaque lecture). */
export interface DemoNote {
  id: number; map: string; side: "T" | "CT" | null; body: string; shared: boolean;
  author_id: number; author: string;
  match_id: number | null; team_id: number | null; strat_id: number | null;
  created_at: string; updated_at: string;
}

const NOTE_MAX = 2000;

/** Réponses capturées sur des matchs pro publics (scripts/capture-demo.mjs). */
export interface DemoFixtures {
  me: AppUser;
  /** le prochain match, placé à l'ouverture de la démo dans `eventInDays` jours à `eventHour` h */
  event: { title: string; opponent: string; maps: string[]; inDays: number; hour: number };
  /** match dont l'analyse vient de se terminer (notification « match prêt » il y a 2 h) */
  readyMatchId: number;
  readyTitle: string;
  teams: ScoutTeam[];
  scoutReports: Record<string, ScoutReport>;
  /** clé `${teamId}:${map}` */
  briefs: Record<string, ScoutBrief>;
  players: CareerStats[];
  profile: PlayerProfile;
  dashboard: Dashboard;
  matches: Record<string, MatchDetail>;
  analyses: Record<string, MatchAnalysis>;
  /** clé `${matchId}:${teamId}` */
  debriefs: Record<string, MatchDebriefT>;
  maps: MapMeta[];
  /** clé `${map}` ou `${map}:${teamId}` */
  grenades: Record<string, GrenadeSearch>;
  callouts: Record<string, Callouts>;
  /** stratégies d'exemple (src/demo/strats.json, construites par scripts/demo-strats.mjs) */
  strats: Strat[];
  goals: Record<string, TeamGoalT[]>;
  /** notes d'exemple (src/demo/notes.json), copiées à l'ouverture de la démo */
  notes?: DemoNote[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function found<T>(v: T | undefined, what: string): Promise<T> {
  return v === undefined ? Promise.reject(new ApiError(404, `${what} absent de la démo`)) : Promise.resolve(v);
}

export function createDemoApi(o: {
  fixtures: DemoFixtures; now: () => Date; assetBase: string;
  /** notes de départ et sauvegarde après chaque écriture (prefs) : la démo n'écrit jamais sur le serveur */
  notes?: { initial: DemoNote[]; save: (list: DemoNote[]) => void };
}): Api {
  const fx = o.fixtures;
  let notes: DemoNote[] = [...(o.notes?.initial ?? fx.notes ?? [])];
  const save = () => o.notes?.save(notes);

  function view(n: DemoNote): NoteT {
    const m = n.match_id !== null ? fx.matches[String(n.match_id)] : undefined;
    const team = n.team_id !== null ? fx.teams.find((t) => t.id === n.team_id) : undefined;
    const strat = n.strat_id !== null ? fx.strats.find((s) => s.id === n.strat_id) : undefined;
    return {
      id: n.id, map: n.map, side: n.side, body: n.body, shared: n.shared, mine: n.author_id === fx.me.id,
      author: n.author, author_id: n.author_id,
      match: m ? { id: m.id, title: `${m.team_a.name} vs ${m.team_b.name}`, date: m.date ?? null } : null,
      team: team ? { id: team.id, name: team.name } : null,
      strat: strat ? { id: strat.id, name: strat.name } : null,
      created_at: n.created_at, updated_at: n.updated_at,
    };
  }
  function cleanBody(body: string | undefined): string {
    const text = (body ?? "").trim();
    if (!text || text.length > NOTE_MAX) throw new ApiError(400, `Note vide ou trop longue (${NOTE_MAX} caractères max.)`);
    return text;
  }
  function own(id: number): DemoNote {
    const n = notes.find((x) => x.id === id);
    if (!n) throw new ApiError(404, "Note introuvable");
    if (n.author_id !== fx.me.id) throw new ApiError(403, "Seul l'auteur peut modifier cette note");
    return n;
  }
  const stamp = () => o.now().toISOString();
  const time = (iso: string) => new Date(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`).getTime();
  const matches = (n: DemoNote, f: NoteFilter) => (!f.map || n.map === f.map) && (!f.side || n.side === null || n.side === f.side)
    && (f.match === undefined || n.match_id === f.match) && (f.team === undefined || n.team_id === f.team)
    && (f.strat === undefined || n.strat_id === f.strat);

  return {
    me: async () => ({ user: fx.me, setup_required: false }),
    updateMe: async (p) => ({ ...fx.me, steamid: p.steamid ?? fx.me.steamid, ts_nickname: p.ts_nickname ?? fx.me.ts_nickname ?? null }), // la démo garde son joueur
    logout: async () => {},
    calendar: async () => {
      const now = o.now();
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + fx.event.inDays, fx.event.hour, 0);
      return [{ id: 1, title: fx.event.title, kind: "match", opponent: fx.event.opponent, maps: fx.event.maps,
        starts_at: localIso(at), notes: "", matches: [] }];
    },
    scoutTeams: async () => fx.teams,
    scoutReport: (id) => found(fx.scoutReports[String(id)], "Équipe"),
    scoutBrief: (id, map) => found(fx.briefs[`${id}:${map}`], "Carte"),
    players: async () => fx.players,
    profile: (sid) => found(sid === fx.me.steamid ? fx.profile : undefined, "Joueur"),
    dashboard: (sid) => found(sid === fx.me.steamid ? fx.dashboard : undefined, "Joueur"),
    match: (id) => found(fx.matches[String(id)], "Match"),
    analysis: (id) => found(fx.analyses[String(id)], "Analyse"),
    debrief: (id, team) => found(fx.debriefs[`${id}:${team}`], "Bilan"),
    maps: async () => fx.maps,
    grenades: async (map, f) => fx.grenades[f?.team ? `${map}:${f.team}` : map] ?? { throws: [], lineups: [] },
    callouts: async (map) => fx.callouts[map] ?? { map, places: [], labels: {}, custom: [] },
    strats: async () => fx.strats.map(toSummary),
    strat: (id) => found(fx.strats.find((s) => s.id === id), "Stratégie"),
    goals: async (teamId) => fx.goals[String(teamId)] ?? [],
    notes: async (f = {}) => notes.filter((n) => matches(n, f))
      .sort((a, b) => time(b.updated_at) - time(a.updated_at) || b.id - a.id).map(view),
    note: async (id) => {
      const n = notes.find((x) => x.id === id);
      if (!n) throw new ApiError(404, "Note introuvable");
      return view(n);
    },
    createNote: async (p: NoteInput) => {
      const at = stamp();
      const n: DemoNote = {
        id: Math.max(0, ...notes.map((x) => x.id)) + 1, map: p.map, side: p.side ?? null, body: cleanBody(p.body),
        shared: !!p.shared, author_id: fx.me.id, author: fx.me.display_name,
        match_id: p.match_id ?? null, team_id: p.team_id ?? null, strat_id: p.strat_id ?? null, created_at: at, updated_at: at,
      };
      notes = [n, ...notes];
      save();
      return view(n);
    },
    updateNote: async (id, p) => {
      const cur = own(id);
      const next: DemoNote = {
        ...cur,
        ...(p.map !== undefined ? { map: p.map } : {}),
        ...(p.body !== undefined ? { body: cleanBody(p.body) } : {}),
        ...(p.side !== undefined ? { side: p.side } : {}),
        ...(p.shared !== undefined ? { shared: p.shared } : {}),
        ...(p.match_id !== undefined ? { match_id: p.match_id } : {}),
        ...(p.team_id !== undefined ? { team_id: p.team_id } : {}),
        ...(p.strat_id !== undefined ? { strat_id: p.strat_id } : {}),
        updated_at: stamp(),
      };
      notes = notes.map((x) => (x.id === id ? next : x));
      save();
      return view(next);
    },
    deleteNote: async (id) => {
      own(id);
      notes = notes.filter((x) => x.id !== id);
      save();
    },
    notifications: async () => {
      const at = new Date(o.now().getTime() - 2 * 3_600_000);
      return [{ id: 1, kind: "match_ready", title: fx.readyTitle, body: "", link: `/matches/${fx.readyMatchId}`,
        created_at: at.toISOString() }];
    },
    pushKey: () => Promise.reject(new ApiError(400, "Les notifications demandent un compte : indisponibles en démo")),
    pushSubscribe: () => Promise.reject(new ApiError(400, "Indisponible en démo")),
    pushUnsubscribe: async () => {},
    assetUrl: (p) => `${o.assetBase}${p}`,
  };
}
