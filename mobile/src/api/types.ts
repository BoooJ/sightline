// Copie de frontend/src/shared/api/types.ts (types de l'API Sightline) : ne pas modifier ici,
// lancer `npm run sync-types` après un changement côté site.
// TeamStats y est déclaré deux fois (stats de match, page équipe) : TypeScript fusionne les deux.
/* eslint-disable import/export */
export type Side = "CT" | "T";
export interface Demo {
  id: number; file_name: string; path: string; size: number;
  status: "pending" | "parsing" | "ready" | "error"; progress: number; step: string | null;
  error_message: string | null; parser_version: string | null; match_id: number | null; created_at: string | null;
}
export interface TeamRef { id: number; name: string }
export interface MatchSummary {
  id: number; demo_id: number; map_name: string; map_display_name: string; played_at: string | null;
  imported_at: string | null; duration_s: number; team_a: TeamRef; team_b: TeamRef; score_a: number; score_b: number;
  rounds_count: number; kind?: "official" | "practice";
  labels?: { folder: string; event: string; tags: string[]; played_on: string | null }; date?: string | null;
}
/** Résumé de la sélection courante (barre de contexte). */
export interface ContextSummary { matches: number; maps: number; rounds: number; official: number; practice: number; list: MatchSummary[] }
/** Réglage « Comparé à ». */
export interface ComparisonSettings { mode: "teams" | "self"; teams: number[]; months: number }
/** Référence de comparaison : moyennes pondérées par les rounds, avec l'effectif. */
export interface Baseline { mode: "teams" | "self"; teams?: number[]; months?: number | null; matches?: number; rounds: number; players: number; stats: Record<string, number> }
export interface RoundInfo {
  id: number; number: number; winner_side: Side | null; winner_team_id: number | null; end_reason: string | null;
  ct_team_id: number; t_team_id: number; score_a_after: number; score_b_after: number;
  ct_buy_type: string; t_buy_type: string; ct_equip_value: number; t_equip_value: number;
  start_tick: number; freeze_end_tick: number; end_tick: number; duration_s: number;
  survivors_a?: number; survivors_b?: number; bomb?: "planted" | "exploded" | "defused" | null;
}
export interface PlayerLine {
  steamid: string; name: string; team_id: number; starting_side: Side;
  kills: number; deaths: number; assists: number; adr: number; hs_pct: number;
}
export interface MatchDetail extends MatchSummary {
  server_name: string; tickrate: number; sample_rate: number;
  halves: { label: string; a: number; b: number }[]; rounds: RoundInfo[]; players: PlayerLine[];
}
export interface MapLevel { name: string; image: string; z_min: number; z_max: number }
export interface MapMeta {
  name: string; display_name: string; pos_x: number; pos_y: number; scale: number; image: string;
  levels: MapLevel[]; bomb_a: [number, number] | null; bomb_b: [number, number] | null;
  active_duty?: boolean;  // dans le pool compétitif actuel
}
export type Vec3 = [number, number, number];
export interface WireArray { dtype: string; data: Uint8Array; enc?: "dpm" | "d"; scale?: number }
export interface WireFrames {
  v: number; round: number; n: number; m: number; ticks: WireArray; players: string[];
  fields: Record<string, WireArray>; weapons: string[]; inv_offsets: WireArray; inv_items: WireArray;
}
export interface KillEvent {
  tick: number; attacker: string | null; victim: string; assister: string | null; weapon: string; headshot: boolean;
  penetrated: number; through_smoke: boolean; noscope: boolean; attacker_blind: boolean; flash_assist: boolean;
  attacker_pos: Vec3 | null; victim_pos: Vec3; is_opening: boolean; is_trade: boolean; attacker_place?: string | null; victim_place?: string | null;
}
export interface ShotEvent { tick: number; shooter: string; weapon: string; pos: Vec3; yaw: number; pitch: number }
export interface GrenadeEvent {
  id: number; type: "smoke" | "flash" | "he" | "molotov" | "incendiary" | "decoy"; thrower: string;
  throw_tick: number; throw_pos: Vec3; detonate_tick: number | null; detonate_pos: Vec3 | null; end_tick: number | null;
  trajectory: [number, number, number, number][];
}
export interface BombEvent { tick: number; type: "pickup" | "drop" | "plant" | "defuse" | "explode"; player: string | null; site: string | null; pos: Vec3 | null }
export interface BlindEvent { tick: number; attacker: string | null; victim: string; duration: number }
export interface ReplayPayload {
  match_id: number; round: RoundInfo; map_name: string; tickrate: number;
  teams: { ct: TeamRef; t: TeamRef };
  players: { steamid: string; name: string; team_id: number; side: Side }[];
  frames: WireFrames | null; kills: KillEvent[]; shots: ShotEvent[];
  damages: { tick: number; attacker: string | null; victim: string; dmg: number; hitgroup: string }[];
  grenades: GrenadeEvent[]; bomb: BombEvent[]; blinds: BlindEvent[];
}
export interface AppSettings {
  demo_folders: string[]; sample_rate: number; max_parallel_imports: number; trade_window_s: number;
  eco_max: number; semi_max: number; force_max: number;
  discord_webhook?: string; notify_discord?: boolean; public_url?: string;
}
export interface NotificationT { id: number; kind: string; title: string; body: string; link: string; created_at: string | null }
export interface DemoEvent {
  type: "demo"; demo_id: number; status: Demo["status"]; progress: number; step: string | null;
  error: string | null; match_id: number | null;
}
export interface PlayerStats {
  steamid: string; name: string; team_id: number; rounds: number; kills: number; deaths: number; assists: number;
  diff: number; adr: number; kast: number; hs_pct: number; kpr: number; dpr: number; rating: number;
  opening_kills: number; opening_deaths: number; opening_pct: number; trade_kills: number; traded_deaths: number;
  multi: Record<"2k" | "3k" | "4k" | "5k", number>; clutches: Record<string, { played: number; won: number }>;
  clutches_played: number; clutches_won: number; utility_dmg: number; enemies_flashed: number; blind_time: number;
  flash_assists: number; plants: number; defuses: number;
}
export interface TeamStats {
  id: number; name: string; rounds: number; rounds_won: number; pistols: number; pistols_won: number;
  opening_won: number; opening_pct: number; plants: number; post_plant_won: number; post_plant_pct: number;
  retakes: number; retakes_won: number; retake_pct: number; buy: Record<string, { played: number; won: number }>;
}
export interface MatchStats {
  match_id: number; side: Side | null; players: PlayerStats[]; teams: TeamStats[];
  duels: Record<string, Record<string, number>>;
}
export type Econ = "buy" | "eco" | "vs_eco" | "pistol";
export interface PlayerRoles { t: string | null; ct: string | null }
/** Rôle EDGE (lurk, half_lurk, pack, t_allround / anchor, rotation, ct_allround) et poste (callout) d'un camp. */
export interface EdgeRoleSide { role: string | null; poste: string | null; map?: string | null; rounds: number; places?: Record<string, number> }
export interface EdgeRoles { t: EdgeRoleSide; ct: EdgeRoleSide }
/** Indicateurs d'un groupe de rounds (poste, arme, achat, carte…), avec l'effectif. */
export interface GroupStats {
  rounds: number; rating: number; adr: number; kpr: number; dpr: number; kast: number; hs_pct: number; opening_pct: number;
  kills: number; deaths: number; assists: number; diff: number; utility_dmg: number; opening_kills: number; opening_deaths: number;
}
export interface ProfileRole extends GroupStats { map: string; side: Side; poste: string; role: string | null; role_label?: string | null }
export interface ProfileWeapon extends GroupStats { weapon: string; class: string | null; share: number; econ_rating: number; round_win_pct: number; opening_attempts_pct: number }
export interface ProfileWeaponClass extends GroupStats { class: string; label: string; share: number; econ_rating: number; round_win_pct: number; opening_attempts_pct: number }
export interface ProfileBuy extends GroupStats { own: string; opp: string; label: string }
export interface ProfileMap extends GroupStats {
  map: string; display_name: string; matches: number; won: number; win_pct: number; avg_kda: [number, number, number]; udr: number;
  sides: Partial<Record<Side, GroupStats>>;
}
export interface ProfileLine {
  match_id: number; date: string | null; map: string; display_name: string; opponent: string; score: [number, number]; won: boolean;
  kind: "official" | "practice"; poste: { t: string | null; ct: string | null };
  rounds: number; rating: number; adr: number; kpr: number; dpr: number; kast: number; kills: number; deaths: number; assists: number; utility_dmg: number;
}
export interface ProfileAvg { matches: number; rounds: number; rating: number; adr: number; kpr: number; dpr: number; kast: number; udr: number }
/** Bloc de stats d'équipe (une carte × un camp, ou le total). */
export interface TeamBlock {
  rounds: number; won: number; win_pct: number; pistols: number; pistols_won: number; pistol_pct: number;
  opening_won: number; opening_lost: number; opening_pct: number; deaths: number; traded_deaths: number; trade_pct: number;
  v5_rounds: number; v5_won: number; v5_pct: number; v4_rounds: number; v4_won: number; v4_pct: number;
  flash_assists: number; far: number; utility_dmg: number; udr: number;
  plants: number; post_plant_won: number; post_plant_pct: number; retakes: number; retakes_won: number; retake_pct: number;
}
export interface TeamOpening { attempts: number; attempts_pct: number; kills: number; deaths: number; kill_pct: number; death_pct: number; kd: number; traded_pct: number; ktd: number; won_after_kill_pct: number }
export interface TeamPlayer extends PlayerStats {
  name: string; matches: number; roles: PlayerRoles; postes: { t: string | null; ct: string | null }; opening: TeamOpening;
}
export interface TeamMapStats extends TeamBlock { map: string; display_name: string; matches: number; won: number; map_win_pct: number; sides: Partial<Record<Side, TeamBlock>> }
export interface TeamStats { team: TeamRef; matches: number; won: number; map_win_pct: number; overall: TeamBlock; maps: TeamMapStats[]; players: TeamPlayer[] }
export interface TeamBaseline extends TeamBlock { mode: "teams"; kind: "team"; teams: number[]; months: number | null; n_teams: number }
export interface TeamPositionRow { steamid: string; name: string; T: EdgeRoleSide | null; CT: EdgeRoleSide | null; maps: Record<string, { T: EdgeRoleSide; CT: EdgeRoleSide }> }
/** Playbook v2 : tactiques définies par l'équipe et détectées dans les rounds. */
export type TacticCondition =
  | { kind: "players_in_zone"; zone: [number, number][]; min_players: number; from_s: number; to_s: number; level?: string; players?: string[] }
  | { kind: "utility_in_zone"; zone: [number, number][]; types: string[]; min_count: number; position: "land" | "throw"; from_s: number; to_s: number; level?: string }
  | { kind: "bomb_planted"; site: "A" | "B" | null; before_s: number }
  | { kind: "contact_before"; s: number }
  | { kind: "no_contact_before"; s: number };
export interface Tactic {
  id: number | string; name: string; map: string; side: Side; category: string; category_label: string; tags: string[]; description: string;
  definition: { conditions: TacticCondition[] }; builtin: boolean; updated_at?: string | null;
}
export interface PlaybookTactic extends Tactic { used: number; won: number; rounds: number[]; buckets: Record<string, number>; pct: number; win_pct: number }
export interface PlaybookRound {
  round_id: number; match_id: number; number: number; won: boolean; buy: string; opp_buy: string; opponent: string; date: string | null;
  sequence: { tactic: number | string; name: string; category: string; at_s: number }[]; site: string | null; plant_s: number | null; contact_s: number | null;
  default_kind?: DefaultKind | null; engage_s?: number | null; engage_site?: "A" | "B" | null;
}
export interface Playbook2 {
  map: string; team_id: number; side: Side; rounds: PlaybookRound[]; total: number; buckets: string[];
  categories: { key: string; label: string; tactics: PlaybookTactic[] }[];
  tempo: { rounds: number; buckets: { label: string; n: number }[]; never: number; total: number }; sites: { rounds: number; A: number; B: number; none: number };
}
export interface PatternRound { round_id: number; match_id: number; number: number; won: boolean; buy: string; opp_buy: string; opponent: string; date: string | null; at_s: number }
export interface PatternResult { total: number; matched: PatternRound[]; ids: number[] }
export interface PlayerProfile {
  intro: { team: string; last_match: string | null; round_win_pct: number; rounds: number; matches: number; top_roles: ProfileRole[] };
  roles: ProfileRole[]; weapons: ProfileWeapon[]; weapon_classes: ProfileWeaponClass[];
  buytypes: { matrix: ProfileBuy[]; own: (GroupStats & { own: string; label: string })[]; adr: { with_eco: number; without_eco: number; rounds_without_eco: number } };
  maps: ProfileMap[]; kinds: Partial<Record<"official" | "practice", GroupStats & { matches: number }>>;
  recent: ProfileLine[]; progression: { n: number; recent: ProfileAvg | null; previous: ProfileAvg | null };
}
export interface CareerStats extends Omit<PlayerStats, "team_id"> { team: string; matches: number; roles?: PlayerRoles; edge_roles?: EdgeRoles }
export interface PlayerMatchLine {
  match: MatchSummary | null; team_id: number; rounds: number; kills: number; deaths: number; assists: number; diff: number;
  adr: number; kast: number; hs_pct: number; rating: number; opening_kills: number; opening_deaths: number;
  clutches_won: number; utility_dmg: number;
}
export interface EconLine { rounds: number; rating: number; kpr: number; adr: number; kast: number; opening_pct: number; kills: number; deaths: number }
export interface PlayerDetail extends CareerStats {
  history: PlayerMatchLine[]; economy: Record<string, EconLine>; roles: PlayerRoles; role_features: Record<string, number>;
  edge_roles?: EdgeRoles; positions?: Record<string, { T: EdgeRoleSide; CT: EdgeRoleSide }>;
}
export interface RoundHit extends RoundInfo {
  match: MatchSummary; pov_side: Side | null; bomb_site: string | null; bomb_planted: boolean; kills: number;
  opening_side?: Side | null; clutch?: Partial<Record<Side, number>>;
}
export interface RoundSearch { total: number; rounds: RoundHit[] }
export interface TeamItem { id: number; name: string; matches: number }
export interface PlaylistHead {
  id: number; name: string; description: string; count: number; updated_at: string | null;
  folder: string; favorite: boolean; tags: string[]; author: string | null; maps: string[];
}
export interface PlaylistItem {
  id: number; position: number; note: string; demo_id: number; round_number: number;
  match: MatchSummary | null; round: RoundInfo | null;
}
export interface PlaylistDetail extends PlaylistHead { items: PlaylistItem[] }
export type GrenadeType = "smoke" | "flash" | "he" | "molotov" | "incendiary" | "decoy";
export interface GrenadeThrow {
  id: number; type: GrenadeType; side: Side; thrower: string; thrower_name: string; team_id: number; team: string;
  opponent: string; match_id: number; round_number: number; round_id: number; throw_tick: number; detonate_tick: number | null;
  throw: Vec3; land: Vec3 | null; yaw: number | null; pitch: number | null; setpos: string | null; trajectory: Vec3[];
  won: boolean | null; time_s: number;
}
export interface Lineup {
  key: number; type: GrenadeType; side: Side; throw: Vec3; land: Vec3; ids: number[]; count: number; players: string[];
  setpos: string | null; trajectory: Vec3[];
}
export interface GrenadeSearch { throws: GrenadeThrow[]; lineups: Lineup[] }
export interface HeatPoint {
  x: number; y: number; level: string; side: Side; player: string; weapon: string; headshot: boolean;
  match_id: number; round_number: number; tick: number;
}
export interface Heatmap { map: string; kind: string; bin: number; grid: number; rounds: number; levels: Record<string, number[][]>; points: HeatPoint[] }
export interface HeatPlayer { steamid: string; name: string; team_id: number; team: string }
export type DrawTool = "pen" | "line" | "arrow" | "circle" | "rect" | "text";
export interface Shape {
  id: string; tool: DrawTool; color: string; width: number; level: string; points: [number, number][]; text?: string;
  from_tick?: number | null; to_tick?: number | null;
}
export interface Annotations { shapes: Shape[]; note: string }
export type Role = "owner" | "admin" | "member";
export interface AppUser { id: number; username: string; display_name: string; role: Role; created_at: string | null; steamid?: string | null; ts_nickname?: string | null; comparison?: ComparisonSettings | null }
export interface AuthState { user: AppUser | null; setup_required: boolean; setup_code_required?: boolean }
export interface InviteRow { id: number; role: Role; expires_at: string; created_at: string | null }
export interface NewInvite extends InviteRow { token: string; path: string }
export interface MatchComment {
  id: number; round_number: number | null; tick: number | null; body: string; author: string; author_id: number | null; created_at: string | null;
  private?: boolean; shapes?: Shape[];
}
export interface ScoutTeam {
  id: number; name: string; matches: number; wins: number; maps: number;
  recent?: ("W" | "L" | "D")[]; last_date?: string | null; map_list?: { map: string; display_name: string; played: number; won: number }[];
}
export interface SideBlock {
  rounds: number; won: number; win_pct: number; pistols: number; pistols_won: number; opening_won: number; opening_pct: number;
  plants: number; post_plant_won: number; retakes: number; retakes_won: number; buy: Record<string, { played: number; won: number; win_pct: number }>;
}
export interface SiteSplit { rounds: number; A: number; B: number; none: number }
export interface ScoutMap {
  map: string; display_name: string; played: number; won: number; lost: number; win_pct: number; rounds_won: number; rounds_lost: number;
  ct: SideBlock; t: SideBlock; sites: { total: SiteSplit; by_buy: Record<string, SiteSplit> };
}
export interface ScoutReport {
  team: TeamRef; matches: number; wins: number; recent_wins: number; maps: ScoutMap[]; players: (CareerStats & { matches: number })[];
  recent: (MatchSummary & { opponent: string; score: [number, number]; result: "W" | "L" | "D" })[];
  faceit_team_id?: string | null;
}
export interface ScoutLineup { type: GrenadeType; count: number; throw: Vec3; land: Vec3; players: string[]; setpos: string | null; trajectory: Vec3[] }
export interface PlaybookGroup { key: string; label: string; n: number; won: number; rounds: number[]; pct: number; win_pct: number }
/** Sous-type d'un round T « default » (playbook) : exec = puis exécution, take = puis prise, duels = aux duels, no_take = sans prise */
export type DefaultKind = "exec" | "take" | "duels" | "no_take";
export interface DefaultKindGroup extends PlaybookGroup { key: DefaultKind }
/** Prises d'un site : nombre, rounds gagnés, heure médiane (s après le freeze time) */
export interface EngageSite { n: number; won: number; win_pct: number; rounds: number[]; median_s: number | null; p25_s: number | null; p75_s: number | null }
export interface PlaybookRoundT {
  round_id: number; match_id: number; number: number; won: boolean; opponent: string; category: string; site: string | null; buy: string;
  contact_s: number | null; plant_s: number | null; util_before: number; near_site: number;
  engage_s: number | null; engage_site: "A" | "B" | null; default_kind: DefaultKind | null; pressure_s: number | null; pressure_site: "A" | "B" | null; ct_rotation_s: number | null; late_exec?: boolean;
  /** false quand les centres des sites A et B sont superposés (Nuke) : la rotation CT n'y est pas mesurée */
  rotation_measurable?: boolean;
}
export interface PlaybookRoundCT { round_id: number; match_id: number; number: number; won: boolean; opponent: string; setup: string; buy: string }
export interface Playbook {
  map: string; team_id: number;
  t: { rounds: number; categories: PlaybookGroup[]; sites_by_category: Record<string, Record<string, number>>; avg_contact_s: number | null; avg_plant_s: number | null; list: PlaybookRoundT[];
    default_kinds: DefaultKindGroup[]; engage_by_site: { A: EngageSite; B: EngageSite; none: number } };
  ct: { rounds: number; setups: PlaybookGroup[]; list: PlaybookRoundCT[];
    sites: Record<string, { attacked: number; held: number; plants: number; retakes_won: number; hold_pct: number; retake_pct: number }> };
}
export interface VetoTeamMap {
  played: number; won: number; rounds_won: number; rounds_lost: number; win_pct: number; strength: number;
  /** vetos enregistrés : nombre et part (null sans veto enregistré) */
  pick: number; ban: number; pick_pct: number | null; ban_pct: number | null; played_pct: number | null;
}
export interface VetoMap { map: string; a: VetoTeamMap; b: VetoTeamMap; advantage: number; p_a: number }
export interface VetoData { team_a: TeamRef; team_b: TeamRef; maps: VetoMap[]; vetos: { a: number; b: number }; head_to_head: { match_id: number; map: string; score: [number, number] }[] }
export interface VetoStepT { team: "a" | "b"; action: "ban" | "pick" | "decider"; map: string }
export interface VetoRecordT { id: number; team_a: TeamRef; team_b: TeamRef; format: "bo1" | "bo3" | "bo5"; steps: VetoStepT[]; match_id: number | null; played_on: string | null; note: string; created_at: string | null }
export interface AudioTrack { id: number; label: string; file_name: string; offset_s: number; url: string; steamid?: string | null }
// ---- match prep (templates à widgets, rapports générés)
export type PrepWidgetType = "overview" | "reads" | "pistols" | "attack" | "sites" | "zones" | "postplant" | "defense" | "utility" | "players" | "playbook" | "notes";
export interface PrepWidgetDef { type: PrepWidgetType; label: string; help: string }
export interface PrepTemplateWidget { type: PrepWidgetType; title?: string; text?: string }
export interface PrepTemplate { id: number; name: string; widgets: PrepTemplateWidget[]; shared: boolean; created_by: number | null; author: string | null; updated_at: string | null }
export interface PrepWidget { type: PrepWidgetType; title: string; data: unknown }
export interface PrepReportHead {
  id: number; team_id: number; map: string; template_id: number | null; title: string; notes: string; author: string | null; created_at: string | null;
  team?: TeamRef; display_name?: string; widgets?: PrepWidgetType[];
}
export interface PrepReportFull extends PrepReportHead { content: { team: TeamRef; map: string; display_name: string; matches_on_map: number; widgets: PrepWidget[] } }
// ---- scouting tool joueurs
export interface ScoutPlayerRow {
  steamid: string; name: string; team: string; matches: number; rounds: number; rating: number; relative: number; adr: number; kast: number;
  kpr: number; opening_pct: number; hs_pct: number; edge_roles: EdgeRoles;
}
export interface ScoutPlayers { map: string | null; mean_rating: number; players: ScoutPlayerRow[] }
export interface ShortlistItemT { id: number; steamid: string; name: string; note: string; added_at: string | null }
export interface ShortlistT { id: number; name: string; count: number; created_at: string | null; items: ShortlistItemT[] }
export interface ShareLinkT { token: string; url: string; match_id: number; round_number: number; tick: number; layers: number[]; expires_at: string }
export interface SharedReplay extends ShareLinkT { match: MatchDetail; map: MapMeta }
export interface Facet { name: string; count: number }
export interface Facets { folders: Facet[]; events: Facet[]; tags: Facet[] }
export interface DashComparison { key: string; label: string; value: number; average: number; delta_pct: number }
export interface Dashboard {
  player: { steamid: string; name: string; team: string; matches: number; rounds: number; rating: number; kpr: number; adr: number; kast: number;
    hs_pct: number; opening_pct: number; kills: number; deaths: number; diff: number };
  roles: PlayerRoles; economy: Record<string, EconLine>;
  trend: { match_id: number | null; date: string | null; map: string; rating: number; adr: number; won: boolean; opponent: string }[];
  maps: { map: string; display_name: string; matches: number; won: number; win_pct: number; rating: number }[];
  weapons: { weapon: string; kills: number; hs: number; share: number; hs_pct: number }[];
  strengths: DashComparison[]; weaknesses: DashComparison[]; comparisons: DashComparison[];
}
export type StratType = "execute" | "default" | "rush" | "setup" | "retake" | "other";
export interface StratPosition { name: string; role: string; pos: Vec3; yaw: number }
export interface StratGrenade {
  type: GrenadeType; player: string; note: string; throw: Vec3 | null; land: Vec3 | null; setpos: string | null; timing_s: number | null; trajectory: Vec3[];
}
export interface StratSummary {
  id: number; name: string; map: string; side: Side; type: StratType; tags: string[]; author: string | null; updated_at: string | null;
  counts: { positions: number; grenades: number; shapes: number };
}
export interface Strat extends StratSummary {
  description: string; positions: StratPosition[]; grenades: StratGrenade[]; shapes: Shape[];
  source: { match_id: number; round_number: number; tick: number | null } | null;
}
export type DeathReason = "untraded" | "isolated" | "behind" | "blind" | "outnumbered" | "utility" | "opening" | "lost_cause" | "saveable" | "side" | "unchecked" | "dry";
export type AimZone = "viseur" | "champ" | "cote" | "dos";
export interface WinEvent {
  tick: number; type: "kill" | "plant" | "defuse" | "explode"; player: string | null; victim: string | null; side: Side | null;
  p_before: number; p_after: number; swing: number; weapon?: string; place?: string | null; pos?: Vec3; round?: number;
}
export interface AnalysisRound { number: number; winner_side: Side | null; freeze_end_tick: number; end_tick: number; curve: [number, number][]; events: WinEvent[] }
export interface AnalysisDeath {
  round: number; tick: number; victim: string; victim_name: string; team_id: number | null; side: Side; attacker: string | null; attacker_name: string;
  weapon: string; place: string | null; pos?: Vec3; cost: number; reasons: DeathReason[]; avoidable: boolean; equip: number | null; unused_utility: number;
  t0: number | null; aim_offset: number | null; killer_aim_offset: number | null; aim_zone: AimZone | null; checked: boolean | null;
  help: { killer: string[]; victim: string[] };
}
export interface AnalysisPlayer {
  steamid: string; name: string; team_id: number; impact: number; swing_plus: number; swing_minus: number; deaths: number; avoidable: number;
  reasons: Record<DeathReason, number>; unused_utility: number; lost_cause_gear: number; rounds: number; aim: AimStats | null;
  duels: Partial<Record<AimZone, [number, number]>>; dry: [number, number];
}
export interface MatchAnalysis {
  match_id: number; tickrate: number; reasons: Record<DeathReason, string>; rounds: AnalysisRound[]; players: AnalysisPlayer[];
  deaths: AnalysisDeath[];
  lost_advantages: { round: number; team_id: number; side: Side; state: string; advantage: number; tick: number; end_reason: string | null }[];
  advantages: Record<string, { had: number; won: number; had2: number; won2: number }>;
  economy: {
    teams: Record<string, { force: number; force_won: number; eco: number; eco_won: number; lost_cause_gear: number; unused_utility: number; kept_utility: number }>;
    incoherent: { round: number; steamid: string; name: string; team_id: number; side: Side; team_buy: string; equip: number; kind: "eco_alone" | "buy_alone" }[];
  };
  utility?: {
    players: Record<string, { dead_value: number; alive_value: number; half_end_value: number }>;
    events: { round: number; kind: "lurk_smoke" | "lone_anchor_molotov"; steamid: string; tick: number }[];
    rounds: { round: number; steamid: string; team_id: number | null; value: number }[];
  };
  key_moments: (WinEvent & { round: number })[];
  names: Record<string, string>;
}
export interface CalloutPlace { place: string; label: string | null; count: number; pos: Vec3 | null }
export interface CustomCallout { id: number; label: string; pos: Vec3 }
export interface Callouts { map: string; places: CalloutPlace[]; labels: Record<string, string>; custom: CustomCallout[] }
export interface AimStats { shots: number; accuracy: number | null; hs_accuracy: number | null; first_bullet: number | null; counter_strafe: number | null; ttk_ms: number | null; ttk_kills: number }
export interface PlayerExtras {
  impact: number; rounds: number; matches: number; avoidable_pr: number; avoidable_pct: number; unused_utility_pr: number;
  reasons: Record<DeathReason, number>; deaths: number; aim: AimStats | null;
  duels: Partial<Record<AimZone, [number, number]>>; dry: [number, number];
}
export interface Highlight {
  type: string; label: string; score: number; detail: string; match_id: number; map: string; round: number; round_id: number; tick: number;
  player: string | null; player_name: string; team: string | null; played_at: string | null;
}
export type EventKind = "match" | "scrim" | "tournament" | "practice" | "other";
/** Cartes probables d'un match FACEIT (synchro du serveur) : leurs cartes × les nôtres, avec leur bilan sur chacune. */
export interface LikelyMaps {
  maps: { map: string; name: string; pct: number; played: number; won: number }[];
  them: number; us: number; few: boolean;
}
export interface CalendarEvent {
  id: number; title: string; kind: EventKind; opponent: string; maps: string[]; starts_at: string; notes: string;
  likely_maps?: LikelyMaps | null;
  matches: (MatchSummary & { manual: boolean })[];
}
export interface RemoteDownload { id: string; host: string; name: string; status: "downloading" | "importing" | "done" | "error"; received: number; total: number | null; error: string | null; demo_id: number | null }
export interface Bookmark { id: number; round_number: number; tick: number; label: string; created_at: string | null; match: MatchSummary | null }
/** Note d'un joueur : une carte, et en option un camp, un match, un adversaire ou une stratégie ; privée ou d'équipe. */
export interface NoteT {
  id: number; map: string; side: "T" | "CT" | null; body: string; shared: boolean; mine: boolean;
  author: string; author_id: number | null;
  match: { id: number; title: string; date: string | null } | null;
  team: { id: number; name: string } | null;
  strat: { id: number; name: string } | null;
  created_at: string | null; updated_at: string | null;
}
export interface NoteInput {
  map: string; body: string; side?: "T" | "CT" | null; shared?: boolean;
  match_id?: number | null; team_id?: number | null; strat_id?: number | null;
}
export interface NoteFilter { map?: string; side?: "T" | "CT"; match?: number; team?: number; strat?: number }
export interface TimingZone { place: string; pos: Vec3; rounds: number; pct: number; median_s: number; fastest_s: number; p25_s: number; p75_s: number; players: number; hist: number[] }
export interface Timings {
  map: string; team_id: number; side: Side; rounds: number; max_s: number; slice_s: number; bin_s: number;
  zones: TimingZone[]; slices: Record<string, Vec3[]>; list: { round_id: number; match_id: number; number: number; won: boolean }[];
}

/** Apprendre un poste (GET /api/scouting/learn). */
export interface LearnPoste { place: string; label: string | null; rounds: number; win_pct: number; pos: Vec3; players: string[]; by_player: Record<string, number> }
export interface LearnNade { type: GrenadeType; time_s: number; throw: Vec3; land: Vec3 | null; setpos: string | null; tick: number }
export interface LearnDeath {
  time_s: number; tick: number; pos: Vec3; attacker_pos: Vec3 | null; attacker_place: string | null; weapon: string; opening: boolean; traded: boolean;
}
export interface LearnEntry {
  match_id: number; round_number: number; steamid: string; name: string; team: string; opponent: string; won: boolean | null;
  pos: Vec3; yaw: number | null; start_tick: number; end_tick: number; path: Vec3[]; left_s: number | null; kills: number;
  first_kill_s: number | null; opening_kill: boolean; damage: number; grenades: LearnNade[]; death: LearnDeath | null;
  rate: number; kills_detail: LearnKill[]; bomb_site: string | null; plant_s: number | null; buy: string; opp_buy: string;
  played_at: string | null; round_end_s: number; contact_s: number | null;
}
export interface LearnKill { time_s: number; tick: number; weapon: string; opening: boolean; victim_pos: Vec3; victim_place: string | null; pos: Vec3 | null }
export interface LearnStudy {
  map: string; side: Side; at_s: number; postes: LearnPoste[]; place: string | null; entries: LearnEntry[];
  sites?: Record<string, [number, number, number | null]>;
}

/** Assistant IA (GET /api/ai/status). */
export interface AiStatus { enabled: boolean; model: string; provider: "anthropic" | "gemini"; providers: string[]; source: "env" | "app" | null; models: Record<string, string>; can_configure: boolean }

/** Profils de rôle (GET /api/scouting/roles). round_list : [match, round, début, fin, gagné]. */
export interface RolePlayer {
  steamid: string; name: string; team: string; rounds: number; reliable: boolean; primary: string;
  kpis: Record<string, number | null>; scores: Record<string, number>; round_list: [number, number, number, number, boolean][];
}
export interface RoleProfiles { map: string; side: Side; roles: string[]; players: RolePlayer[]; benchmarks: Record<string, { players: number; kpis: Record<string, number | null> }> }

/** Histoire d'un round (Apprendre un rôle) : étapes de ce qu'a fait un joueur, positionnées sur la carte. */
export type StoryKind = "buy" | "place" | "nade" | "kill" | "plant" | "defuse" | "death" | "end";
export interface StoryStep {
  kind: StoryKind; t: number; tick: number; pos: Vec3 | null; place: string | null;
  items?: string[]; first?: boolean; nade?: GrenadeType; target?: Vec3 | null; target_place?: string | null;
  victim?: string; attacker?: string | null; weapon?: string | null;  // kill, mort : arme ; achat : arme principale du round
  headshot?: boolean; opening?: boolean; teamkill?: boolean;
  site?: string | null; won?: boolean | null; alive?: boolean;
  trajectory?: Vec3[]; yaw?: number | null; pitch?: number | null; setpos?: string | null;  // grenade : lineup
  mates: StoryPlayer[]; enemies: StoryPlayer[];  // joueurs vivants à l'instant de l'étape
  enemy_utility: StoryUtility[];  // grenades adverses en vol ou en effet à l'instant de l'étape
  view_yaw?: number | null;  // direction du regard du joueur suivi (degrés)
}
export interface CalloutZone { name: string; level: string | null; poly: [number, number][] }
export interface StoryUtility { type: GrenadeType; thrower: string; flying: boolean; pos: Vec3 | null; trajectory: Vec3[] }
export interface StoryPlayer { name: string; pos: Vec3 }
export interface StoryRound {
  number: number; side: Side; won: boolean | null; kills: number; died: boolean; buy: string; poste: string | null;
  start_tick: number; end_tick: number; round_end_tick: number; path: [number, number, number, number][]; steps: StoryStep[];
  plant_t: number | null;  // pose de la bombe (secondes après le freeze time)
}
export interface PlayerStory { match_id: number; map: string; steamid: string; name: string; team: string; opponent: string; rate: number; rounds: StoryRound[] }

// ---- scouting FACEIT (équipes ESEA)
export interface FaceitStatus { configured: boolean; source: "env" | "app" | null; can_configure: boolean; downloads: boolean }
export interface FaceitTeamHit { team_id: string; name: string; avatar: string; via: "team" | "player"; player?: string; matches?: number; esea_matches?: number }
export interface FaceitTracked { team_id: string; name: string; avatar: string; local_team_id: number | null; updated_at: string | null }
export interface FaceitMember { player_id: string; nickname: string; avatar: string; country: string; level: number | null; elo: number | null; steamid: string | null; matches: number; in_library: boolean }
export interface FaceitImported { demo_id: number; status: string; match_id: number | null; map: string | null }
export interface FaceitMatch {
  match_id: string; url: string; started_at: string | null; competition: string; esea: boolean;
  opponent: { name: string; team_id: string | null }; won: boolean | null;
  maps: { map: string; score: [number, number] | null; won: boolean | null }[]; demos: number; imported: FaceitImported[];
}
export interface FaceitPoolMap { map: string; played: number; won: number; rounds_won: number; rounds_lost: number; last: string | null; faceit: { matches: number; win_pct: number } | null; active: boolean; likely_ban: boolean }
export interface FaceitTeamReport {
  team: { team_id: string; name: string; avatar: string; url: string; leader: string | null };
  scope: "esea" | "all"; roster: FaceitMember[]; regulars: string[]; matches: FaceitMatch[]; record: { played: number; won: number };
  map_pool: FaceitPoolMap[]; local_team_id: number | null; map_names: Record<string, string>;
}

// ---- brief de scouting (chiffres avec fiabilité)
export type Reliability = "none" | "anecdotal" | "indicative" | "solid";
export interface Stat { k: number; n: number; pct: number | null; lo: number; hi: number; level: Reliability; tone: "good" | "bad" | "neutral"; rounds: number[] }
export interface BriefAfter { won: Stat; bought: Stat; buys: Record<string, number> }
export interface BriefPistols {
  result: Stat; plays: { key: string; label: string; count: Stat; won: number }[]; after_won: BriefAfter | null; after_lost: BriefAfter | null;
  /** pistol T perdu, selon que la bombe a été posée (+800 $ par joueur : force possible) ou non */
  after_lost_planted?: BriefAfter | null; after_lost_unplanted?: BriefAfter | null;
}
export interface BriefPlayer {
  steamid: string; name: string; awper: boolean; awp_kills: number; kills: number; opening: Stat;
  /** part des rounds de l'équipe où il prend le premier duel, puis rounds gagnés par l'équipe après son ouverture gagnée / perdue */
  opening_attempts?: Stat; after_open_win?: Stat; after_open_loss?: Stat;
  spots: Record<"T" | "CT", { place: string; count: Stat; pos?: [number, number, number] }[]>; rounds: Record<"T" | "CT", number>;
}
export interface BriefLine { side: "T" | "CT"; topic?: string; text: string; stat: Stat }
export interface ScoutBrief {
  map: string; display_name: string; matches: number; armed?: boolean; sides: Record<"T" | "CT", Stat>;
  pistols: Record<"T" | "CT", BriefPistols>; first_gun: Record<"T" | "CT", { result: Stat; numbers: Record<string, number> }>;
  t_styles: { key: string; label: string; count: Stat; won: Stat; sites: Record<string, number>; lib_pct?: number | null; late_exec?: Stat;
    /** fins du default (facultatif : les rapports Match Prep gelés contiennent d'anciennes données) */
    kinds?: { key: DefaultKind; label: string; count: Stat; won: Stat }[] }[]; avg_contact_s: number | null; avg_plant_s: number | null;
  /** prise des sites (rounds T hors eco) et rotations CT provoquées ; facultatifs pour les anciens rapports */
  engage_by_site?: { A?: EngageSite; B?: EngageSite; none?: number }; ct_rotation?: Stat | null;
  ct_setups: { setup: string; count: Stat; won: Stat; lib_pct?: number | null }[]; sites: Record<"A" | "B", { held: Stat; retakes: Stat }>;
  utility: Record<"T" | "CT", { type: string; place: string; count: Stat; players: string[]; pos?: [number, number, number] }[]>;
  players: BriefPlayer[]; awper: string | null; entry: string | null;
  round_index: Record<string, [number, number, boolean]>; takeaways: BriefLine[]; counters: BriefLine[];
  /** rounds à revoir, groupés comme le font les analystes (pistols, premiers gun rounds, forces, prises de site…) */
  review?: { key: string; side?: "T" | "CT"; label: string; why: string; rounds: number[] }[]; library_teams?: number;
}

// ---- débrief de match et axes de travail
export interface GoalMetric { key: string; label: string; better: "up" | "down"; unit: string; drill?: string | null }
export interface DebriefRow { key: string; label: string; better: "up" | "down"; unit: string; stat: Stat; usual: number | null; usual_n: number; bad: number[] }
export interface DebriefIssue { key: string; label: string; text: string; excess: number; stat: Stat; usual: number | null; bad_rounds: number[]; drill?: string | null; question?: string | null }
export interface DebriefRound { number: number; round_id: number; kind: string; label: string; why: string; won: boolean; side: "T" | "CT" }
export interface TeamGoalT {
  id: number; team_id: number; metric: string; metric_label: string; better: "up" | "down"; title: string; note: string;
  target: number | null; source_match_id: number | null; created_at: string | null; archived: boolean;
  before?: Stat; after?: Stat; status?: "waiting" | "early" | "better" | "worse" | "flat"; reached?: boolean | null;
  series?: { match_id: number; date: string | null; map: string; opponent: string; k: number; n: number; pct: number | null; after: boolean }[];
  here?: { k: number; n: number; pct: number | null };
}
export interface MatchDebriefT {
  match_id: number; team_id: number; matches_compared: number; phases: DebriefRow[]; sides: DebriefRow[];
  issues: DebriefIssue[]; review: DebriefRound[]; metrics: Record<string, { k: number; n: number; pct: number | null }>;
  notes: { worked: string; change: string; actions: string; updated_at: string | null };
  goals: TeamGoalT[]; teams: { id: number; name: string }[]; catalog: GoalMetric[];
}

// ---- rapport de scouting rédigé par l'IA (vérifié en code)
export interface ReportFact { id: string; map: string | null; side: string | null; topic: string; label: string; k?: number; n?: number; pct?: number | null; lo?: number; hi?: number; level?: Reliability; value?: number; examples?: string[] }
export interface ReportBlock { title: string; text: string; fact_ids: string[]; alerts?: { claim: string; verdict: string; reason: string }[] }
export interface ReportSection { key: string; title: string; map: string | null; blocks: ReportBlock[] }
export interface AiScoutReport {
  id: number; team_id: number; status: "running" | "done" | "error"; model: string; error: string | null;
  content: { sections?: ReportSection[]; facts?: Record<string, ReportFact> };
  checks: { numbers_checked?: number; first_pass_issues?: number; removed_sentences?: number; judge_alerts?: number | null };
  tokens_in: number; tokens_out: number; cost_usd: number | null; latency_s: number | null; created_at: string | null;
}

// ---- routine d'un joueur (rounds armés)
export interface RoutineRef { match_id: number; number: number; won: boolean | null }
export type RoutineStat = Stat & { refs?: RoutineRef[] };
export interface PlayerRoutine {
  name: string | null; map: string; side: Side; scope: "match" | "map"; armed_only: boolean; matches: number; rounds: number; won: Stat;
  buys: { buy: string; kind?: "weapon" | "item"; count: Stat; unused?: Stat }[];
  times: { t: number; clock: string; alive: number; places: { place: string; count: RoutineStat; pos: Vec3 | null }[] }[];
  nades: { type: string; place: string; count: RoutineStat; median_t: number; clock: string; early_clock: string; late_clock: string; from: string[]; pos: Vec3 | null }[];
  rotations: { place: string; count: RoutineStat }[]; deaths: { place: string; count: RoutineStat }[];
}
export interface CoachNoteT { kind: "round" | "routine"; blocks: ReportBlock[]; facts: Record<string, ReportFact>; checks: { removed_sentences?: number; numbers_checked?: number }; model: string; cost_usd: number | null; cached: boolean }
