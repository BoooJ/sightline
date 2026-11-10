import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { FaceitMatch, FaceitTeamReport, RemoteDownload } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { RemoteDownloads } from "../library/ImportUrl";
import "../library/library.css";
import "./scouting.css";

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

function Avatar({ src, name }: { src: string; name: string }) {
  return src ? <img className="fc-avatar" src={src} alt="" referrerPolicy="no-referrer" />
    : <span className="sc-team-initial display">{name.slice(0, 2).toUpperCase()}</span>;
}

/** Clé d'API FACEIT : sans elle, rien n'est possible. */
function KeySetup({ canConfigure }: { canConfigure: boolean }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.faceitConfig({ api_key: key.trim() }); await qc.invalidateQueries({ queryKey: ["faceit-status"] }); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="panel section fc-setup" data-testid="faceit-setup">
      <h2 className="display">Connecter FACEIT</h2>
      <ol>
        <li>Sur <a className="pl-link" href="https://developers.faceit.com" target="_blank" rel="noreferrer noopener">developers.faceit.com</a>, créez une application, puis une clé d'API « Server side ».</li>
        <li>Pour importer les démos d'un clic, demandez aussi l'accès « Downloads API » pour cette application. Sans lui, téléchargez la démo sur la page du match et importez-la dans la Bibliothèque : elle sera rattachée automatiquement.</li>
      </ol>
      {canConfigure ? (
        <form className="fc-key" onSubmit={save}>
          <input className="rf-select" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Clé d'API FACEIT (Server side)" autoComplete="off" data-testid="faceit-key" />
          <Button type="submit" variant="primary" disabled={busy || key.trim().length < 20}>{busy ? "Vérification…" : "Enregistrer"}</Button>
        </form>
      ) : <p className="st-legend">Demandez au propriétaire de l'équipe d'ajouter la clé.</p>}
      {err && <p className="auth-error" role="alert">{err}</p>}
    </section>
  );
}

export function FaceitHomePage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [input, setInput] = useState(q);
  const status = useQuery({ queryKey: ["faceit-status"], queryFn: api.faceitStatus });
  const ok = !!status.data?.configured;
  const results = useQuery({ queryKey: ["faceit-search", q], queryFn: () => api.faceitSearch(q), enabled: ok && !!q, retry: false, staleTime: 5 * 60_000 });
  const tracked = useQuery({ queryKey: ["faceit-tracked"], queryFn: api.faceitTracked, enabled: ok });
  return (
    <div className="page">
      <Link to="/scouting" className="back-link"><Icon name="back" />Scouting</Link>
      <div className="lib-head">
        <div><div className="eyebrow">Adversaires</div><h1 className="display">Scouting FACEIT</h1>
          <p className="st-legend">Équipes de la saison ESEA (et autres championnats FACEIT), même sans page HLTV.</p></div>
      </div>
      {status.isLoading ? <Spinner /> : !ok ? <KeySetup canConfigure={!!status.data?.can_configure} /> : (<>
        <form className="fc-search panel" onSubmit={(e) => { e.preventDefault(); setParams(input.trim() ? { q: input.trim() } : {}); }}>
          <label className="search"><Icon name="search" />
            <input value={input} onChange={(e) => setInput(e.target.value)} autoFocus data-testid="faceit-search"
              placeholder="Lien de l'équipe FACEIT, nom de l'équipe ou pseudo d'un joueur" /></label>
          <Button type="submit" variant="primary" disabled={!input.trim()}>Rechercher</Button>
        </form>
        {q && (results.isLoading ? <Spinner /> : results.error ? <p className="auth-error">{(results.error as Error).message}</p>
          : !results.data?.length ? <section className="panel section"><EmptyState title="Aucune équipe trouvée">Essayez le lien de la page de l'équipe sur FACEIT, ou le pseudo exact d'un de ses joueurs.</EmptyState></section> : (
            <div className="sc-teams fc-results">
              {results.data.map((t) => (
                <Link key={t.team_id} to={`/scouting/faceit/${t.team_id}`} className="sc-team panel" data-testid="faceit-hit">
                  <Avatar src={t.avatar} name={t.name} />
                  <span className="sc-team-name display">{t.name}</span>
                  <span className="sc-team-meta mono">{t.via === "player" ? `équipe de ${t.player} · ${t.esea_matches} match${(t.esea_matches ?? 0) > 1 ? "s" : ""} ESEA` : "équipe FACEIT"}</span>
                </Link>
              ))}
            </div>
          ))}
        {!!tracked.data?.length && (<>
          <h2 className="display sc-title">Équipes suivies</h2>
          <div className="sc-teams">
            {tracked.data.map((t) => (
              <Link key={t.team_id} to={`/scouting/faceit/${t.team_id}`} className="sc-team panel" data-testid="faceit-tracked">
                <Avatar src={t.avatar} name={t.name} />
                <span className="sc-team-name display">{t.name}</span>
                <span className="sc-team-meta mono">{t.local_team_id ? "démos analysées" : "aucune démo importée"}</span>
              </Link>
            ))}
          </div>
        </>)}
      </>)}
    </div>
  );
}

function DemoCell({ m, onImport, busy, direct }: { m: FaceitMatch; onImport: (url?: string) => void; busy: boolean; direct: boolean }) {
  const ready = m.imported.filter((d) => d.match_id);
  const pending = m.imported.filter((d) => !d.match_id);
  const [paste, setPaste] = useState(false);
  const [url, setUrl] = useState("");
  const missing = m.demos > m.imported.length;
  return (
    <div className="fc-demo">
      {ready.map((d) => <Link key={d.demo_id} className="pl-link" to={`/matches/${d.match_id}`}>Ouvrir{ready.length > 1 && d.map ? ` (${d.map.replace("de_", "")})` : ""}</Link>)}
      {pending.map((d) => <span key={d.demo_id} className="st-legend">{d.status === "error" ? "Erreur d'analyse" : "Analyse…"}</span>)}
      {missing && direct && <Button size="sm" onClick={() => onImport()} disabled={busy} data-testid="faceit-import">{busy ? "…" : "Importer"}</Button>}
      {missing && !direct && (paste ? (
        <form className="fc-paste" onSubmit={(e) => { e.preventDefault(); if (url.trim()) { onImport(url.trim()); setPaste(false); setUrl(""); } }}>
          <input className="rf-select" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Lien de la démo (…dem.zst)" data-testid="faceit-paste-input" />
          <Button size="sm" type="submit" disabled={!url.trim() || busy}>OK</Button>
        </form>
      ) : <Button size="sm" variant="ghost" onClick={() => setPaste(true)} title="Lien obtenu avec l'outil d'import ou depuis FACEIT" data-testid="faceit-paste">Coller un lien</Button>)}
      {!m.demos && !m.imported.length && <span className="st-legend">Pas de démo</span>}
    </div>
  );
}

/** Sans l'API Downloads (rarement accordée) : l'outil du PC récupère les liens signés sur faceit.com. */
function ImportHelp({ teamId, canConfigure }: { teamId: string; canConfigure: boolean }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const command = `node scripts/faceit-import.mjs https://www.faceit.com/fr/teams/${teamId}`;
  return (
    <div className="iu-help fc-help" data-testid="faceit-import-help">
      <b>Importer les démos de l'équipe</b>
      <p>Dans le dossier du projet, lancez l'outil d'import : il ouvre les matchs sur faceit.com (connectez-vous à FACEIT la première fois),
        récupère le lien de chaque démo manquante et le transmet à Sightline, qui la télécharge et l'analyse.</p>
      <div className="iu-cmd"><code className="mono">{command}</code>
        <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* presse-papiers refusé */ } }}>{copied ? "Copié ✓" : "Copier"}</Button></div>
      <span className="st-legend">Options : --max 20 (nombre de matchs), --tous (pas seulement l'ESEA). Une démo téléchargée à la main depuis FACEIT
        peut aussi être importée dans la Bibliothèque : elle sera rattachée au match.</span>
      {canConfigure && <button type="button" className="pl-link fc-linkbtn" onClick={async () => { await api.faceitConfig({ downloads: true }); qc.invalidateQueries({ queryKey: ["faceit-status"] }); }}>
        FACEIT m'a accordé l'accès à l'API Downloads</button>}
    </div>
  );
}

export function FaceitTeamPage() {
  const id = useParams().teamId!;
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const scope = params.get("scope") === "all" ? "all" : "esea";
  const rep = useQuery({ queryKey: ["faceit-team", id, scope], queryFn: () => api.faceitTeam(id, scope), retry: false, staleTime: 5 * 60_000 });
  const status = useQuery({ queryKey: ["faceit-status"], queryFn: api.faceitStatus });
  const direct = !!status.data?.downloads;
  const [busy, setBusy] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // fin d'un téléchargement : la fiche (démos importées, équipe locale) est relue
  const dls = useQuery({ queryKey: ["remote-downloads"], queryFn: api.remoteDownloads });
  const done = (dls.data ?? []).filter((d: RemoteDownload) => d.status === "done").length;
  useEffect(() => { if (done) qc.invalidateQueries({ queryKey: ["faceit-team", id] }); }, [done, id, qc]);
  const pendingAnalysis = rep.data?.matches.some((m) => m.imported.some((d) => !d.match_id && d.status !== "error"));
  useEffect(() => {
    if (!pendingAnalysis) return;
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ["faceit-team", id] }), 4000);
    return () => clearInterval(t);
  }, [pendingAnalysis, id, qc]);

  const importMatches = async (ids: string[], url?: string) => {
    setErr(null); setBusy((b) => [...b, ...ids]);
    const errors: string[] = [];
    for (const mid of ids) {
      try { await api.faceitImport(mid, url); } catch (e) { errors.push((e as Error).message); }
    }
    setBusy((b) => b.filter((x) => !ids.includes(x)));
    if (errors.length) setErr([...new Set(errors)].join(" · "));
    qc.invalidateQueries({ queryKey: ["remote-downloads"] });
  };

  if (rep.isLoading) return <div className="page"><Spinner /><p className="st-legend fc-wait">Récupération des matchs sur FACEIT…</p></div>;
  if (rep.error || !rep.data) return <div className="page"><Link to="/scouting/faceit" className="back-link"><Icon name="back" />Scouting FACEIT</Link><EmptyState title="Équipe indisponible">{(rep.error as Error | null)?.message}</EmptyState></div>;
  const r: FaceitTeamReport = rep.data;
  const name = (m: string) => r.map_names[m] ?? m.replace(/^de_/, "");
  const importable = r.matches.filter((m) => m.demos > m.imported.length).map((m) => m.match_id);
  const ask = `Prépare un rapport de scouting de l'équipe FACEIT « ${r.team.name} » (team_id ${r.team.team_id}) pour notre prochain match : `
    + "map pool et bans probables, setups CT et exécutions T par carte, économie, joueurs clés, puis 3 recommandations concrètes.";
  return (
    <div className="page">
      <Link to="/scouting/faceit" className="back-link"><Icon name="back" />Scouting FACEIT</Link>
      <header className="pl-hero panel sc-hero fc-hero">
        <Avatar src={r.team.avatar} name={r.team.name} />
        <div>
          <div className="eyebrow">Scouting FACEIT</div>
          <h1 className="display pl-name" data-testid="faceit-team-name">{r.team.name}</h1>
          <div className="pl-sub mono">{r.record.played} match{r.record.played > 1 ? "s" : ""} {scope === "esea" ? "ESEA" : ""} · {r.record.won}V {r.record.played - r.record.won}D</div>
          <div className="sc-form">{r.matches.slice(0, 10).map((m) => <span key={m.match_id} className={`sc-chip ${m.won ? "W" : m.won === false ? "L" : "D"}`}>{m.won ? "V" : m.won === false ? "D" : "?"}</span>)}</div>
        </div>
        <div className="fc-actions">
          {r.local_team_id ? <Link className="btn btn-primary" to={`/scouting/${r.local_team_id}`} data-testid="faceit-local"><Icon name="scout" />Analyse des démos</Link>
            : <span className="st-legend">Importez des démos pour l'analyse détaillée (setups, exécutions, timings).</span>}
          <Link className="btn btn-ghost" to={`/assistant?q=${encodeURIComponent(ask)}`}><Icon name="comment" />Rapport IA</Link>
          <a className="btn btn-ghost" href={r.team.url} target="_blank" rel="noreferrer noopener">FACEIT ↗</a>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={scope === "esea"} className={`tab ${scope === "esea" ? "on" : ""}`} onClick={() => setParams({})}>Saison ESEA</button>
        <button type="button" role="tab" aria-selected={scope === "all"} className={`tab ${scope === "all" ? "on" : ""}`} onClick={() => setParams({ scope: "all" })}>Tous les matchs d'équipe</button>
      </nav>

      <section className="panel section">
        <h2 className="display sc-title">Map pool</h2>
        <table className="st-table fc-table" data-testid="faceit-pool">
          <thead><tr><th className="sc-left">Carte</th><th>Bilan</th><th>Victoires</th><th>Rounds</th><th title="Toutes compétitions, selon FACEIT">FACEIT</th><th>Dernier match</th><th /></tr></thead>
          <tbody>{r.map_pool.filter((m) => m.played || m.active || m.faceit).map((m) => (
            <tr key={m.map}>
              <td className="sc-left">{name(m.map)}</td>
              <td className="mono">{m.played ? `${m.won}V ${m.played - m.won}D` : "—"}</td>
              <td className={`mono ${m.played ? (pct(m.won, m.played) >= 50 ? "pos" : "neg") : ""}`}>{m.played ? `${pct(m.won, m.played)} %` : "—"}</td>
              <td className="mono">{m.played ? `${m.rounds_won}:${m.rounds_lost}` : "—"}</td>
              <td className="mono">{m.faceit ? `${m.faceit.matches} · ${Math.round(m.faceit.win_pct)} %` : "—"}</td>
              <td className="mono">{fmtDate(m.last)}</td>
              <td>{m.likely_ban && <span className="fc-badge" title="Carte du pool jamais jouée sur la période">ban probable</span>}</td>
            </tr>))}</tbody>
        </table>
      </section>

      <section className="panel section">
        <h2 className="display sc-title">Roster</h2>
        <table className="st-table fc-table">
          <thead><tr><th className="sc-left">Joueur</th><th>Niveau</th><th>ELO</th><th>Matchs joués</th><th>Bibliothèque</th></tr></thead>
          <tbody>{r.roster.map((p) => (
            <tr key={p.player_id}>
              <td className="sc-left"><a className="pl-link" href={`https://www.faceit.com/fr/players/${p.nickname}`} target="_blank" rel="noreferrer noopener">{p.nickname}</a>{p.player_id === r.team.leader && <span className="st-legend"> · capitaine</span>}</td>
              <td className="mono">{p.level ?? "—"}</td>
              <td className="mono">{p.elo ?? "—"}</td>
              <td className="mono">{p.matches}/{r.record.played}</td>
              <td>{p.in_library && p.steamid ? <Link className="pl-link" to={`/players/${p.steamid}`}>Fiche joueur</Link> : <span className="st-legend">—</span>}</td>
            </tr>))}</tbody>
        </table>
      </section>

      <section className="panel section">
        <div className="fc-matches-head">
          <h2 className="display sc-title">Matchs</h2>
          {direct && !!importable.length && <Button variant="primary" onClick={() => importMatches(importable)} disabled={busy.length > 0} data-testid="faceit-import-all"><Icon name="download" />Importer les {importable.length} démo{importable.length > 1 ? "s" : ""}</Button>}
        </div>
        {!direct && !!importable.length && <ImportHelp teamId={r.team.team_id} canConfigure={!!status.data?.can_configure} />}
        <RemoteDownloads />
        {err && <p className="auth-error" role="alert">{err}</p>}
        {!r.matches.length ? <EmptyState title="Aucun match">{scope === "esea" ? "Pas de match ESEA récent pour ce roster : essayez « Tous les matchs d'équipe »." : "Pas de match d'équipe récent."}</EmptyState> : (
          <table className="st-table fc-table" data-testid="faceit-matches">
            <thead><tr><th className="sc-left">Date</th><th className="sc-left">Compétition</th><th className="sc-left">Adversaire</th><th className="sc-left">Carte</th><th>Résultat</th><th>Démo</th></tr></thead>
            <tbody>{r.matches.map((m) => (
              <tr key={m.match_id} data-testid="faceit-match">
                <td className="sc-left mono"><a className="pl-link" href={m.url} target="_blank" rel="noreferrer noopener">{fmtDate(m.started_at)}</a></td>
                <td className="sc-left fc-comp" title={m.competition}>{m.competition}</td>
                <td className="sc-left">{m.opponent.team_id ? <Link className="pl-link" to={`/scouting/faceit/${m.opponent.team_id}`}>{m.opponent.name}</Link> : m.opponent.name}</td>
                <td className="sc-left mono">{m.maps.map((mp) => `${name(mp.map)}${mp.score ? ` ${mp.score[0]}-${mp.score[1]}` : ""}`).join(" · ") || "—"}</td>
                <td><span className={`sc-chip ${m.won ? "W" : m.won === false ? "L" : "D"}`}>{m.won ? "V" : m.won === false ? "D" : "?"}</span></td>
                <td><DemoCell m={m} direct={direct} busy={busy.includes(m.match_id)} onImport={(url) => importMatches([m.match_id], url)} /></td>
              </tr>))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
