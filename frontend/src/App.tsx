import { lazy, Suspense, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { APP_NAME, APP_TAGLINE } from "./shared/brand";
import { Icon, type IconName } from "./shared/ui/Icon";
import { Spinner } from "./shared/ui/Spinner";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import { CommandPalette } from "./shared/ui/CommandPalette";
import { LibraryPage } from "./features/library/LibraryPage";
import { AuthGate, InvitePage, ROLE_LABEL, signOut, useAuth } from "./features/team/auth";
import { NotificationsBell } from "./shared/notifications/NotificationsBell";

// tous les écrans sauf la bibliothèque sont chargés à la demande : la première page s'affiche plus vite
// les morceaux de code de chaque écran : chargés à la demande, et préchargés dès que le navigateur est libre (navigation sans attente)
const CHUNKS: Record<string, () => Promise<any>> = {
  "MatchPage": () => import("./features/match/MatchPage"),
  "PlayerPage": () => import("./features/players/PlayerPage"),
  "PlayersPage": () => import("./features/players/PlayersPage"),
  "PlaylistsPage": () => import("./features/playlists/PlaylistsPage"),
  "RoundsPage": () => import("./features/rounds/RoundsPage"),
  "ReplayPage": () => import("./features/replay/ReplayPage"),
  "AssistantPage": () => import("./features/assistant/AssistantPage"),
  "LearnPage": () => import("./features/learn/LearnPage"),
  "StoryPage": () => import("./features/learn/story/StoryPage"),
  "GrenadesPage": () => import("./features/grenades/GrenadesPage"),
  "HeatmapsPage": () => import("./features/heatmaps/HeatmapsPage"),
  "VetoPage": () => import("./features/scouting/VetoPage"),
  "DashboardPage": () => import("./features/dashboard/DashboardPage"),
  "TeamPage": () => import("./features/team/TeamPage"),
  "ScoutingPage": () => import("./features/scouting/ScoutingPage"),
  "StratbookPage": () => import("./features/stratbook/StratbookPage"),
  "CalloutsPage": () => import("./features/callouts/CalloutsPage"),
  "ReportPage": () => import("./features/match/ReportPage"),
  "HighlightsPage": () => import("./features/highlights/HighlightsPage"),
  "LeaderboardsPage": () => import("./features/leaderboards/LeaderboardsPage"),
  "CalendarPage": () => import("./features/calendar/CalendarPage"),
  "GoalsPage": () => import("./features/team/GoalsPage"),
  "BookmarksPage": () => import("./features/bookmarks/BookmarksPage"),
  "TeamScout": () => import("./features/scouting/TeamScout"),
  "FaceitPage": () => import("./features/scouting/FaceitPage"),
  "TeamStatsPage": () => import("./features/teams/TeamStatsPage"),
  "PlaybookPage": () => import("./features/playbook/PlaybookPage"),
  "TacticEditor": () => import("./features/playbook/TacticEditor"),
  "PatternFinderPage": () => import("./features/playbook/PatternFinderPage"),
  "SharePage": () => import("./features/replay/SharePage"),
  "MatchPrepPage": () => import("./features/prep/MatchPrepPage"),
  "PrepReportPage": () => import("./features/prep/PrepReportPage"),
  "PlayerScoutPage": () => import("./features/scouting/PlayerScoutPage"),
};
/** Précharge tous les écrans une fois la première page affichée, pendant les temps morts du navigateur. */
function usePrefetchChunks() {
  useEffect(() => {
    const run = () => { Object.values(CHUNKS).forEach((f) => { f().catch(() => { /* réseau : réessayé à la navigation */ }); }); };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 1500);
  }, []);
}
const MatchPage = lazy(() => CHUNKS["MatchPage"]().then((m) => ({ default: m.MatchPage })));
const PlayerPage = lazy(() => CHUNKS["PlayerPage"]().then((m) => ({ default: m.PlayerPage })));
const PlayersPage = lazy(() => CHUNKS["PlayersPage"]().then((m) => ({ default: m.PlayersPage })));
const PlaylistsPage = lazy(() => CHUNKS["PlaylistsPage"]().then((m) => ({ default: m.PlaylistsPage })));
const PlaylistPage = lazy(() => CHUNKS["PlaylistsPage"]().then((m) => ({ default: m.PlaylistPage })));
const RoundsPage = lazy(() => CHUNKS["RoundsPage"]().then((m) => ({ default: m.RoundsPage })));
const ReplayPage = lazy(() => CHUNKS["ReplayPage"]().then((m) => ({ default: m.ReplayPage })));
const AssistantPage = lazy(() => CHUNKS["AssistantPage"]().then((m) => ({ default: m.AssistantPage })));
const LearnPage = lazy(() => CHUNKS["LearnPage"]().then((m) => ({ default: m.LearnPage })));
const StoryPage = lazy(() => CHUNKS["StoryPage"]().then((m) => ({ default: m.StoryPage })));
const GrenadesPage = lazy(() => CHUNKS["GrenadesPage"]().then((m) => ({ default: m.GrenadesPage })));
const HeatmapsPage = lazy(() => CHUNKS["HeatmapsPage"]().then((m) => ({ default: m.HeatmapsPage })));
const VetoPage = lazy(() => CHUNKS["VetoPage"]().then((m) => ({ default: m.VetoPage })));
const DashboardPage = lazy(() => CHUNKS["DashboardPage"]().then((m) => ({ default: m.DashboardPage })));
const TeamPage = lazy(() => CHUNKS["TeamPage"]().then((m) => ({ default: m.TeamPage })));
const ScoutingPage = lazy(() => CHUNKS["ScoutingPage"]().then((m) => ({ default: m.ScoutingPage })));
const StratbookPage = lazy(() => CHUNKS["StratbookPage"]().then((m) => ({ default: m.StratbookPage })));
const StratRedirect = lazy(() => CHUNKS["StratbookPage"]().then((m) => ({ default: m.StratRedirect })));
const CalloutsPage = lazy(() => CHUNKS["CalloutsPage"]().then((m) => ({ default: m.CalloutsPage })));
const ReportPage = lazy(() => CHUNKS["ReportPage"]().then((m) => ({ default: m.ReportPage })));
const HighlightsPage = lazy(() => CHUNKS["HighlightsPage"]().then((m) => ({ default: m.HighlightsPage })));
const LeaderboardsPage = lazy(() => CHUNKS["LeaderboardsPage"]().then((m) => ({ default: m.LeaderboardsPage })));
const CalendarPage = lazy(() => CHUNKS["CalendarPage"]().then((m) => ({ default: m.CalendarPage })));
const GoalsPage = lazy(() => CHUNKS["GoalsPage"]().then((m) => ({ default: m.GoalsPage })));
const BookmarksPage = lazy(() => CHUNKS["BookmarksPage"]().then((m) => ({ default: m.BookmarksPage })));
const TeamScoutPage = lazy(() => CHUNKS["TeamScout"]().then((m) => ({ default: m.TeamScoutPage })));
const FaceitHomePage = lazy(() => CHUNKS["FaceitPage"]().then((m) => ({ default: m.FaceitHomePage })));
const FaceitTeamPage = lazy(() => CHUNKS["FaceitPage"]().then((m) => ({ default: m.FaceitTeamPage })));
const TeamStatsPage = lazy(() => CHUNKS["TeamStatsPage"]().then((m) => ({ default: m.TeamStatsPage })));
const PlaybookPage = lazy(() => CHUNKS["PlaybookPage"]().then((m) => ({ default: m.PlaybookPage })));
const TacticEditor = lazy(() => CHUNKS["TacticEditor"]().then((m) => ({ default: m.TacticEditor })));
const PatternFinderPage = lazy(() => CHUNKS["PatternFinderPage"]().then((m) => ({ default: m.PatternFinderPage })));
const SharePage = lazy(() => CHUNKS["SharePage"]().then((m) => ({ default: m.SharePage })));
const MatchPrepPage = lazy(() => CHUNKS["MatchPrepPage"]().then((m) => ({ default: m.MatchPrepPage })));
const PrepReportPage = lazy(() => CHUNKS["PrepReportPage"]().then((m) => ({ default: m.PrepReportPage })));
const PlayerScoutPage = lazy(() => CHUNKS["PlayerScoutPage"]().then((m) => ({ default: m.PlayerScoutPage })));

function Logo() {
  return (
    <div className="app-logo">
      <svg className="app-logo-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M4 18 12 4l8 14" /><path d="M8 18h8" /><circle cx="12" cy="13" r="1.6" fill="currentColor" stroke="none" />
      </svg>
      <span className="app-logo-name">{APP_NAME}</span>
    </div>
  );
}

function Account() {
  const { user, setup_required } = useAuth();
  const qc = useQueryClient();
  if (setup_required) {
    return <div className="app-open">Accès ouvert sur cet ordinateur.<Link to="/team">Protéger avec un compte</Link></div>;
  }
  if (!user) return null;
  return (
    <div className="app-user" data-testid="account">
      <span className="team-avatar">{user.display_name.slice(0, 1).toUpperCase()}</span>
      <span><b>{user.display_name}</b><small>{ROLE_LABEL[user.role]}</small></span>
      <button type="button" className="btn btn-sm btn-ghost" title="Se déconnecter" aria-label="Se déconnecter"
        onClick={() => void signOut(qc)}><Icon name="logout" /></button>
    </div>
  );
}

const NAV: { group: string; items: [string, IconName, string][] }[] = [
  { group: "", items: [["/dashboard", "dashboard", "Tableau de bord"], ["/assistant", "comment", "Assistant"]] },
  { group: "Matchs", items: [["/", "library", "Bibliothèque"], ["/rounds", "rounds", "Rounds"], ["/highlights", "star", "Moments forts"],
    ["/bookmarks", "bookmark", "Signets"], ["/playlists", "playlist", "Playlists"]] },
  { group: "Cartes", items: [["/heatmaps", "heat", "Heatmaps"], ["/grenades", "grenade", "Grenades"], ["/callouts", "pin", "Callouts"]] },
  { group: "Statistiques", items: [["/players", "user", "Joueurs"], ["/team-stats", "team", "Équipes"], ["/leaderboards", "trophy", "Classements"], ["/learn", "crosshair", "Apprendre un rôle"]] },
  { group: "Adversaires", items: [["/scouting", "scout", "Scouting"], ["/scouting/players", "user", "Joueurs à scouter"], ["/playbook", "book", "Playbook"], ["/pattern-finder", "search", "Pattern Finder"], ["/match-prep", "print", "Match Prep"], ["/veto", "veto", "Veto"]] },
  { group: "Équipe", items: [["/stratbook", "book", "Stratbook"], ["/goals", "crosshair", "Axes de travail"], ["/calendar", "calendar", "Calendrier"], ["/team", "team", "Membres"]] },
];

function Shell() {
  usePrefetchChunks();
  // petit écran : la navigation devient un menu repliable (refermé à chaque changement de page)
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const { pathname, search } = useLocation();
  // menu réduit à une barre d'icônes : au choix (mémorisé), et toujours dans le replay pour laisser la place au radar
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem("menu-collapsed") === "1"; } catch { return false; } });
  const setCollapsed = (v: boolean) => { setCollapsedState(v); try { localStorage.setItem("menu-collapsed", v ? "1" : "0"); } catch { /* stockage indisponible */ } };
  const inReplay = /\/replay\//.test(pathname);
  const rail = collapsed || inReplay;
  // sections repliées au choix (mémorisé) ; une section repliée garde le lien de la page en cours
  const [shut, setShutState] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("menu-groups-shut") ?? "[]"); } catch { return []; } });
  const toggleGroup = (g: string) => {
    const next = shut.includes(g) ? shut.filter((x) => x !== g) : [...shut, g];
    setShutState(next);
    try { localStorage.setItem("menu-groups-shut", JSON.stringify(next)); } catch { /* stockage indisponible */ }
  };
  useEffect(() => setMenu(false), [pathname, search]);
  const navType = useNavigationType();
  useEffect(() => {  // nouvelle page : on repart du haut ; retour arrière : le navigateur garde la position
    if (navType !== "POP") document.querySelector(".app-main")?.scrollTo({ top: 0 });
  }, [pathname]);  // eslint-disable-line react-hooks/exhaustive-deps
  // Ctrl+K (ou Cmd+K) : recherche rapide depuis n'importe quelle page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className={`app-shell ${menu ? "menu-open" : ""} ${rail ? "rail" : ""}`}>
      <aside className="app-sidebar">
        <div className="app-topbar">
          <Logo />
          <button type="button" className="btn btn-ghost app-burger" aria-label={menu ? "Fermer le menu" : "Ouvrir le menu"} aria-expanded={menu}
            onClick={() => setMenu(!menu)}><Icon name={menu ? "close" : "menu"} /></button>
        </div>
        <button type="button" className="app-search" onClick={() => setPalette(true)} data-testid="open-search" title="Rechercher (Ctrl+K)">
          <Icon name="search" /><span>Rechercher…</span><kbd>Ctrl K</kbd></button>
        <nav className="app-nav" aria-label="Navigation principale">
          {NAV.map((g, i) => {
            // en barre d'icônes, pas de titres : tout reste affiché
            const closed = !rail && !!g.group && shut.includes(g.group);
            const here = g.items.filter(([to]) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`)))
              .sort((a, b) => b[0].length - a[0].length).slice(0, 1);  // /scouting/players : « Joueurs à scouter », pas « Scouting »
            return (
              <div key={g.group || "top"} className="app-nav-group">
                {g.group && (
                  <button type="button" className="app-nav-label app-nav-gap app-nav-toggle" onClick={() => toggleGroup(g.group)}
                    aria-expanded={!closed} aria-controls={`nav-group-${i}`} data-testid="nav-group">
                    {g.group}<Icon name={closed ? "next" : "down"} size={12} />
                  </button>
                )}
                <div id={`nav-group-${i}`} className="app-nav-items">
                  {(closed ? here : g.items).map(([to, icon, label]) => (
                    <NavLink key={to} to={to} end={to === "/"} title={rail ? label : undefined} aria-label={rail ? label : undefined}><Icon name={icon} /><span className="app-nav-text">{label}</span></NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <button type="button" className="app-collapse" onClick={() => setCollapsed(!collapsed)} title={rail ? "Déplier le menu" : "Réduire le menu"}
          aria-label={rail ? "Déplier le menu" : "Réduire le menu"} data-testid="collapse-menu"><Icon name={rail ? "next" : "prev"} />{!rail && <span>Réduire le menu</span>}</button>
        <CommandPalette open={palette} onClose={() => setPalette(false)} />
        <div className="app-sidebar-foot"><NotificationsBell /><Account /><span>{APP_TAGLINE}</span></div>
      </aside>
      <main className="app-main">
        <ErrorBoundary resetKey={pathname}>
        <Suspense fallback={<div className="page"><Spinner /></div>}>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/matches/:matchId" element={<MatchPage />} />
          <Route path="/matches/:matchId/replay/:roundNumber" element={<ReplayPage />} />
          <Route path="/matches/:matchId/report" element={<ReportPage />} />
          <Route path="/rounds" element={<RoundsPage />} />
          <Route path="/grenades" element={<GrenadesPage />} />
          <Route path="/heatmaps" element={<HeatmapsPage />} />
          <Route path="/playlists" element={<PlaylistsPage />} />
          <Route path="/playlists/:playlistId" element={<PlaylistPage />} />
          <Route path="/players" element={<PlayersPage />} />
          <Route path="/learn" element={<StoryPage />} />
          <Route path="/learn/expert" element={<LearnPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/players/:steamid" element={<PlayerPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/callouts" element={<CalloutsPage />} />
          <Route path="/highlights" element={<HighlightsPage />} />
          <Route path="/leaderboards" element={<LeaderboardsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/bookmarks" element={<BookmarksPage />} />
          <Route path="/stratbook" element={<StratbookPage />} />
          <Route path="/stratbook/:stratId" element={<StratRedirect />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/scouting" element={<ScoutingPage />} />
          <Route path="/veto" element={<VetoPage />} />
          <Route path="/scouting/players" element={<PlayerScoutPage />} />
          <Route path="/scouting/faceit" element={<FaceitHomePage />} />
          <Route path="/scouting/faceit/:teamId" element={<FaceitTeamPage />} />
          <Route path="/scouting/:teamId" element={<TeamScoutPage />} />
          <Route path="/team-stats" element={<TeamStatsPage />} />
          <Route path="/playbook" element={<PlaybookPage />} />
          <Route path="/playbook/editor" element={<TacticEditor />} />
          <Route path="/playbook/editor/:id" element={<TacticEditor />} />
          <Route path="/pattern-finder" element={<PatternFinderPage />} />
          <Route path="/match-prep" element={<MatchPrepPage />} />
          <Route path="/match-prep/:reportId" element={<PrepReportPage />} />
        </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

export default function App() {
  const pathname = useLocation().pathname;
  const publicRoute = pathname.startsWith("/invite/") || pathname.startsWith("/s/");
  return (
    <AuthGate publicRoute={publicRoute}>
      {publicRoute ? <Suspense fallback={<div className="page"><Spinner /></div>}><Routes><Route path="/invite/:token" element={<InvitePage />} /><Route path="/s/:token" element={<SharePage />} /></Routes></Suspense> : <Shell />}
    </AuthGate>
  );
}
