import type {
  AppUser, AuthState, CalendarEvent, Callouts, CareerStats, Dashboard, GrenadeSearch, MapMeta, MatchAnalysis,
  MatchDebriefT, MatchDetail, NoteFilter, NoteInput, NoteT, NotificationT, PlayerProfile, ScoutBrief, ScoutReport, ScoutTeam, Strat,
  StratSummary, TeamGoalT,
} from "./types";

/** Ce que les écrans lisent. Deux implémentations : le serveur Sightline (http.ts) et la démo embarquée (demo.ts). */
export interface Api {
  me(): Promise<AuthState>;
  updateMe(p: { steamid?: string | null; ts_nickname?: string | null }): Promise<AppUser>;
  logout(): Promise<void>;
  calendar(): Promise<CalendarEvent[]>;
  scoutTeams(): Promise<ScoutTeam[]>;
  scoutReport(teamId: number): Promise<ScoutReport>;
  scoutBrief(teamId: number, map: string): Promise<ScoutBrief>;
  players(): Promise<CareerStats[]>;
  profile(steamid: string): Promise<PlayerProfile>;
  dashboard(steamid: string): Promise<Dashboard>;
  match(id: number): Promise<MatchDetail>;
  analysis(id: number): Promise<MatchAnalysis>;
  debrief(id: number, teamId: number | null): Promise<MatchDebriefT>;
  maps(): Promise<MapMeta[]>;
  /** lineups regroupés d'une carte (sans les lancers un par un), éventuellement d'une seule équipe */
  grenades(map: string, f?: { team?: number }): Promise<GrenadeSearch>;
  callouts(map: string): Promise<Callouts>;
  /** cahier des stratégies de l'équipe (lecture : on les écrit sur le site) */
  strats(): Promise<StratSummary[]>;
  strat(id: number): Promise<Strat>;
  goals(teamId: number): Promise<TeamGoalT[]>;
  /** notes : les miennes et celles partagées avec l'équipe. Seules écritures de contenu de l'app. */
  notes(f?: NoteFilter): Promise<NoteT[]>;
  note(id: number): Promise<NoteT>;
  createNote(p: NoteInput): Promise<NoteT>;
  updateNote(id: number, p: Partial<NoteInput>): Promise<NoteT>;
  deleteNote(id: number): Promise<void>;
  notifications(after?: number): Promise<NotificationT[]>;
  /** clé publique VAPID du serveur (abonnement aux notifications web) */
  pushKey(): Promise<string>;
  pushSubscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void>;
  pushUnsubscribe(endpoint: string): Promise<void>;
  /** adresse complète d'un fichier public du serveur (radars : « /maps/de_dust2.png ») */
  assetUrl(path: string): string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}
