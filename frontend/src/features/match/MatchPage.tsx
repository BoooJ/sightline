import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DeleteMatchesDialog } from "../library/DeleteMatches";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { useUrlParams } from "../../shared/useUrlParams";
import type { MatchDetail, Side } from "../../shared/api/types";
import { useMyPlayer } from "../../shared/myPlayer";
import { NotesPanel } from "../notes/NotesPanel";
import { formatDuration } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Skeleton } from "../../shared/ui/Skeleton";
import { RoundStrip } from "./RoundStrip";
import { EconomyChart } from "./EconomyChart";
import { Scoreboard } from "./Scoreboard";
import { DuelsPanel, PlayersPanel, TeamsPanel } from "./StatsPanels";
import { Comments, useComments } from "../team/Comments";
import { AnalysisPanel } from "./AnalysisPanel";
import { Brief } from "./Brief";
import { DebriefPanel } from "../team/Debrief";
import { ECONS } from "../players/Filters";
import "./match.css";

const TABS = [
  { key: "overview", label: "Aperçu" }, { key: "analysis", label: "Analyse" }, { key: "debrief", label: "Débrief" }, { key: "players", label: "Joueurs" },
  { key: "teams", label: "Équipes" }, { key: "duels", label: "Duels" }, { key: "comments", label: "Commentaires" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function MatchPage() {
  const id = Number(useParams().matchId);
  const [params, set] = useUrlParams();
  const tab = (TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "overview") as Tab;
  const side = (params.get("side") === "CT" || params.get("side") === "T" ? params.get("side") : undefined) as Side | undefined;
  const q = useQuery({ queryKey: ["match", id], queryFn: () => api.match(id) });
  const comments = useComments(id);
  const [deleting, setDeleting] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const share = async () => {
    const l = await api.createShare({ match_id: id, round_number: 1, tick: 0, layers: [] });
    const url = `${window.location.origin}${l.url}`;
    setShareUrl(url);
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* presse-papiers refusé : lien affiché */ }
  };
  // duels : toujours sur tout le match (avec un filtre de camp, les deux sens d'un duel ne portent pas sur les mêmes rounds)
  const statSide = tab === "duels" ? undefined : side;
  const econ = tab === "duels" ? undefined : params.get("econ") ?? undefined;
  const stats = useQuery({ queryKey: ["match-stats", id, statSide ?? "all", econ ?? "all"], queryFn: () => api.matchStats(id, statSide, econ),
    enabled: tab !== "overview" && tab !== "comments" && tab !== "analysis" && tab !== "debrief", placeholderData: (prev) => prev });
  const analysis = useQuery({ queryKey: ["match-analysis", id], queryFn: () => api.matchAnalysis(id), enabled: tab === "analysis" || tab === "overview" });
  if (q.isLoading) return <div className="page"><Skeleton header rows={8} /></div>;
  if (!q.data) return <EmptyState title="Match introuvable" />;
  const m = q.data;
  const aWins = m.score_a > m.score_b;
  return (
    <div className="page">
      <Link to="/" className="back-link"><Icon name="back" />Bibliothèque</Link>
      <header className="match-hero panel" style={{ ["--radar" as string]: `url(/maps/${m.map_name}.png)` }}>
        <div className="hero-map display">{m.map_display_name}</div>
        <div className="hero-score">
          <span className={`hero-team ${aWins ? "win" : "lose"}`}>{m.team_a.name}</span>
          <span className="hero-num display"><b className={aWins ? "win" : "lose"}>{m.score_a}</b><i>:</i><b className={aWins ? "lose" : "win"}>{m.score_b}</b></span>
          <span className={`hero-team ${aWins ? "lose" : "win"}`}>{m.team_b.name}</span>
        </div>
        <div className="hero-halves mono">{m.halves.map((h) => <span key={h.label} title={h.label}>{h.a}–{h.b}</span>)}</div>
        <div className="hero-meta">{m.server_name} · {formatDuration(m.duration_s)}</div>
        <div className="hero-actions">
          <Link to={`/matches/${m.id}/replay/1`}><Button variant="primary"><Icon name="play" />Replay</Button></Link>
          <Link to={`/assistant?match=${m.id}&q=${encodeURIComponent("Analyse ce match : les rounds clés, ce qui a fait la différence et 3 points à travailler.")}`}
            data-testid="ask-assistant"><Button><Icon name="comment" />Demander à l'assistant</Button></Link>
          <Link to={`/matches/${m.id}/report`} data-testid="report-link"><Button><Icon name="print" />Rapport</Button></Link>
          <a className="btn" href={api.demoFileUrl(m.demo_id)} download data-testid="demo-download" title="Télécharger le fichier .dem d'origine"><Icon name="download" />Démo</a>
          <Button onClick={() => void share()} data-testid="match-share" title="Lien public en lecture seule, valable 30 jours"><Icon name="share" />{copied ? "Lien copié ✓" : "Partager"}</Button>
          <Button variant="ghost" onClick={() => setDeleting(true)} title="Supprimer ce match" data-testid="delete-match-page"><Icon name="trash" />Supprimer</Button>
        </div>
        {shareUrl && <div className="hero-share"><span className="rf-label">Lien public (30 jours)</span><input className="rf-select mono" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Lien public" data-testid="match-share-url" /></div>}
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? "on" : ""}`}
            onClick={() => set("tab", t.key === "overview" ? undefined : t.key)}>{t.label}
            {t.key === "comments" && !!comments.data?.length && <span className="rp-tool-count">{comments.data.length}</span>}</button>
        ))}
        {tab !== "overview" && tab !== "duels" && tab !== "comments" && tab !== "analysis" && tab !== "debrief" && (
          <><div className="map-pills tabs-filter" role="group" aria-label="Économie">
            {ECONS.map(([v, l]) => (
              <button key={v ?? "e-all"} type="button" className={`pill ${econ === v ? "on" : ""}`} onClick={() => set("econ", v)}>{l}</button>
            ))}
          </div>
          <span className="tabs-sep" />
          <div className="map-pills tabs-filter tabs-side" role="group" aria-label="Camp">
            {([undefined, "CT", "T"] as const).map((s_) => (
              <button key={s_ ?? "all"} type="button" className={`pill ${side === s_ ? "on" : ""} ${s_ ? `pill-${s_.toLowerCase()}` : ""}`}
                onClick={() => set("side", s_)}>{s_ ?? "Tous"}</button>
            ))}
          </div>
          </>
        )}
      </nav>
      {deleting && <DeleteMatchesDialog matches={[m]} onClose={() => setDeleting(false)} onDeleted={() => navigate("/")} />}
      {tab === "overview" && (<>
        {analysis.data && <Brief m={m} a={analysis.data} />}
        <section className="panel section"><h2 className="section-title">Rounds</h2><RoundStrip m={m} />
          <p className="st-legend rs-legend">Chiffre : survivants de l'équipe en fin de round · point sous le numéro : bombe posée (orange), explosée (rouge), désamorcée (bleu).</p></section>
        <section className="panel section"><h2 className="section-title">Économie</h2><EconomyChart m={m} /></section>
        <section className="panel section"><h2 className="section-title">Tableau des scores</h2><Scoreboard m={m} /></section>
      </>)}
      {tab === "comments" && <section className="panel section match-comments"><Comments matchId={m.id} /></section>}
      {tab === "analysis" && <section className="panel section">{analysis.data ? <AnalysisPanel m={m} a={analysis.data} /> : <Spinner />}</section>}
      {tab === "debrief" && <><DebriefPanel m={m} /><MatchNotes m={m} /></>}
      {tab !== "overview" && tab !== "comments" && tab !== "analysis" && tab !== "debrief" && (
        <section className="panel section" aria-busy={stats.isFetching}>
          {!stats.data ? <Spinner /> : tab === "players" ? <PlayersPanel m={m} stats={stats.data} />
            : tab === "teams" ? <TeamsPanel stats={stats.data} /> : <DuelsPanel m={m} stats={stats.data} />}
        </section>
      )}
    </div>
  );
}

/** Notes du match (écrites ici ou depuis l'app) ; une nouvelle note vise aussi l'équipe d'en face, pour la retrouver
 *  dans son scouting et dans la préparation du prochain match contre elle. */
function MatchNotes({ m }: { m: MatchDetail }) {
  const me = useMyPlayer();
  const mine = m.players.find((p) => p.steamid === me)?.team_id;
  const opponent = mine ? (m.team_a.id === mine ? m.team_b.id : m.team_a.id) : null;
  return (
    <NotesPanel className="db-notes" title="Notes du match" filter={{ match: m.id }}
      draft={{ match_id: m.id, map: m.map_name, team_id: opponent }}
      empty="Rien de noté sur ce match. Une erreur à ne pas refaire, un timing adverse : notez-le ici ou depuis l'app." />
  );
}
