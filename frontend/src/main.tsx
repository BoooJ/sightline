import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./shared/design/global.css";
// toutes les feuilles de style d'emblée : plusieurs pages en partagent, les pages sont chargées à la demande, et une
// feuille arrivant plus tard (préchargement) ne doit jamais faire bouger la page affichée
import "./features/assistant/assistant.css";
import "./features/bookmarks/bookmarks.css";
import "./features/calendar/calendar.css";
import "./features/callouts/callouts.css";
import "./features/highlights/highlights.css";
import "./features/leaderboards/leaderboards.css";
import "./features/learn/learn.css";
import "./features/learn/story/story.css";
import "./features/match/report.css";
import "./features/dashboard/dashboard.css";
import "./features/grenades/grenades.css";
import "./features/heatmaps/heatmaps.css";
import "./features/library/library.css";
import "./features/match/match.css";
import "./features/players/players.css";
import "./features/playlists/playlists.css";
import "./features/replay/replay.css";
import "./features/rounds/rounds.css";
import "./features/scouting/scouting.css";
import "./features/stratbook/stratbook.css";
import "./features/team/team.css";
import App from "./App";
import { api } from "./shared/api/client";
import { setupPersistence } from "./shared/api/persist";

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } });
// les cartes servent à presque tous les écrans : demandées en même temps que la session, pas après
void qc.prefetchQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
// données de la dernière visite restaurées avant le premier rendu : les listes s'affichent sans attendre le serveur
void setupPersistence(qc).then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}><BrowserRouter future={{ v7_relativeSplatPath: true }}><App /></BrowserRouter></QueryClientProvider>
    </React.StrictMode>,
  );
});
