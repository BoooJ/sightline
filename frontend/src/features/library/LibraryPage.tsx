import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { useDemoEvents } from "../../shared/api/useDemoEvents";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Skeleton } from "../../shared/ui/Skeleton";
import { DropZone } from "./DropZone";
import { ImportUrlButton, RemoteDownloads } from "./ImportUrl";
import { DeleteMatchesDialog } from "./DeleteMatches";
import { MatchRow } from "./DemoRow";
import { FoldersDialog } from "./FoldersDialog";
import { useUploads, uploadFiles } from "./uploads";
import { FolderPicker, LabelsDialog, LibraryFilterBar, useLibFilters } from "./LibraryFilters";
import { AddToPlaylist } from "../playlists/AddToPlaylist";
import { useUrlParams } from "../../shared/useUrlParams";
import type { MatchSummary } from "../../shared/api/types";
import "./library.css";

const STATUS: Record<string, { tone: "neutral" | "warn" | "error" | "ok"; label: string }> = {
  pending: { tone: "neutral", label: "En attente" }, parsing: { tone: "warn", label: "Analyse" },
  error: { tone: "error", label: "Erreur" }, ready: { tone: "ok", label: "Prête" },
};

const mb = (b: number) => (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0);
function fmtUpload(u: { sent: number; size: number; bps: number; status: string }): string {
  const base = `${mb(u.sent)} / ${mb(u.size)} Mo`;
  if (u.status !== "uploading" || u.bps <= 0) return base;
  const left = (u.size - u.sent) / u.bps;
  return `${base} · ${mb(u.bps)} Mo/s · ${left > 90 ? `${Math.round(left / 60)} min` : `${Math.round(left)} s`}`;
}

export function LibraryPage() {
  const qc = useQueryClient();
  const live = useDemoEvents();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [map, setMap] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [folders, setFolders] = useState(false);
  // sélection (dossier, playlist, suppression) ; gardée en session pour survivre à un aller-retour sur un match
  const [selected, setSelectedState] = useState<Set<number>>(() => { try { return new Set<number>(JSON.parse(sessionStorage.getItem("lib-selected") ?? "[]")); } catch { return new Set(); } });
  const setSelected = (u: Set<number> | ((s: Set<number>) => Set<number>)) => setSelectedState((s) => {
    const n = typeof u === "function" ? u(s) : u;
    try { sessionStorage.setItem("lib-selected", JSON.stringify([...n])); } catch { /* stockage indisponible */ }
    return n;
  });
  const lastPick = useRef<number | null>(null);
  const [deleting, setDeleting] = useState<MatchSummary[] | null>(null);
  const [bulkFolder, setBulkFolder] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets, staleTime: 30_000 });
  const [urlParams] = useUrlParams();
  const team = urlParams.get("team") ?? undefined;
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);

  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const demos = useQuery({ queryKey: ["demos"], queryFn: api.demos });
  // dossiers de démos : utiles quand l'application tourne sur l'ordinateur du joueur, pas sur le serveur
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const showFolders = local || !!settings.data?.demo_folders.length;
  const lib = useLibFilters();
  const [labelling, setLabelling] = useState<MatchSummary | null>(null);
  const matches = useQuery({ queryKey: ["matches", map, debounced, lib, team], queryFn: () => api.matches({ map, q: debounced, ...lib, team }),
    placeholderData: (prev) => prev });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["demos"] }); qc.invalidateQueries({ queryKey: ["matches"] }); };

  const onFiles = useCallback(async (files: File[], rejected: string[]) => {
    if (rejected.length) setNotice(`Ignoré (format non supporté) : ${rejected.join(", ")}`);
    if (!files.length) return;
    const { results, failed } = await uploadFiles(files);
    const dup = results.filter((r) => !r.created).length;
    setNotice([`${results.length - dup} démo(s) ajoutée(s)${dup ? `, ${dup} déjà présente(s)` : ""}.`,
      failed.length ? `Échec : ${failed.join(", ")}` : ""].filter(Boolean).join(" "));
    refresh();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    try {
      const res = await api.scan();
      const created = res.filter((r) => r.created).length;
      setNotice(created ? `${created} nouvelle(s) démo(s) trouvée(s).` : "Aucune nouvelle démo.");
    } catch (e) {
      setNotice(`Échec du scan : ${(e as Error).message}`);
    }
    refresh();
  };

  const inProgress = (demos.data ?? []).filter((d) => d.status !== "ready");
  const uploads = Object.values(useUploads((st) => st.items));
  const clearUpload = useUploads((st) => st.clear);
  return (
    <div className="page">
      <div className="lib-head">
        <div>
          <div className="eyebrow">Matchs</div>
          <h1 className="display">Bibliothèque <span className="lib-count mono">{matches.data?.length ?? 0}</span></h1>
        </div>
        <div className="lib-tools">
          {showFolders && <>
            <Button onClick={scan}><Icon name="refresh" />Scanner les dossiers</Button>
            <Button variant="ghost" onClick={() => setFolders(true)}><Icon name="folder" />Dossiers…</Button>
          </>}
          <ImportUrlButton />
          <DropZone onFiles={onFiles} />
        </div>
      </div>

      <div className="lib-filters">
        <label className="search"><Icon name="search" />
          <input placeholder="Rechercher une équipe ou un joueur…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div className="map-pills" role="group" aria-label="Carte">
          <button type="button" className={`pill ${map === "" ? "on" : ""}`} onClick={() => setMap("")}>Toutes</button>
          {maps.data?.map((m) => (
            <button key={m.name} type="button" className={`pill ${map === m.name ? "on" : ""}`} onClick={() => setMap(m.name)}>
              {m.display_name}
            </button>
          ))}
        </div>
      </div>
      <LibraryFilterBar withTeam />
      {notice && <div className="notice" onClick={() => setNotice(null)}>{notice}</div>}
      <RemoteDownloads />

      {inProgress.length + uploads.length > 0 && (
        <section className="panel imports" aria-label="Imports en cours">
          <h2 className="section-title">Imports</h2>
          {uploads.map((u) => (
            <div key={u.id} className="import-row" data-testid="upload-row">
              <span className="import-name mono">{u.name}</span>
              <Badge tone={u.status === "error" ? "error" : u.status === "retrying" ? "warn" : "neutral"}>
                {u.status === "queued" ? "En file" : u.status === "error" ? "Erreur" : u.status === "retrying" ? "Reprise" : "Envoi"}</Badge>
              {u.status === "error" ? <span className="import-error">{u.error}</span>
                : <div className="progress"><div style={{ transform: `scaleX(${u.sent / Math.max(1, u.size)})` }} /></div>}
              <span className="import-step mono">{fmtUpload(u)}</span>
              {u.status === "error" ? <Button size="sm" variant="ghost" onClick={() => clearUpload(u.id)}><Icon name="trash" /></Button>
                : u.status === "queued" ? <span /> : <Spinner />}
            </div>
          ))}
          {inProgress.map((d) => {
            const ev = live[d.id];
            const status = ev?.status ?? d.status;
            const progress = ev?.progress ?? d.progress;
            return (
              <div key={d.id} className="import-row" data-testid="import-row">
                <span className="import-name mono">{d.file_name}</span>
                <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>
                {status === "parsing" || status === "pending" ? (
                  <div className="progress"><div style={{ transform: `scaleX(${progress / 100})` }} /></div>
                ) : <span className="import-error">{ev?.error ?? d.error_message}</span>}
                <span className="import-step">{ev?.step ?? d.step ?? ""}</span>
                {status === "parsing" ? <Spinner /> : (
                  <span className="import-actions">
                    <Button size="sm" onClick={() => api.reparse(d.id).then(refresh)}><Icon name="refresh" />Ré-analyser</Button>
                    <Button size="sm" variant="ghost" onClick={() => api.deleteDemo(d.id).then(refresh)} title="Retirer cette démo de la liste (le fichier est supprimé)"><Icon name="trash" />Retirer</Button>
                  </span>
                )}
              </div>
            );
          })}
        </section>
      )}

      {selected.size > 0 && (
        <div className="sel-bar panel" role="region" aria-label="Sélection" data-testid="selection-bar">
          <b>{selected.size} match{selected.size > 1 ? "s" : ""} sélectionné{selected.size > 1 ? "s" : ""}</b>
          <span className="sel-hint rf-dim">Cliquez une ligne pour la cocher, Maj+clic pour une plage.</span>
          <div className="sel-folder">
            {bulkOpen ? (<>
              <FolderPicker value={bulkFolder} onChange={setBulkFolder} folders={facets.data?.folders ?? []} testId="bulk-folder" />
              <Button size="sm" variant="primary" data-testid="bulk-folder-apply" onClick={async () => {
                const r = await api.bulkLabels({ ids: [...selected], folder: bulkFolder });
                setNotice(`${r.updated} match(s) ${bulkFolder ? `placé(s) dans « ${bulkFolder} »` : "sorti(s) de leur dossier"}.`);
                setBulkOpen(false); setBulkFolder(""); refresh(); qc.invalidateQueries({ queryKey: ["facets"] });
              }}>Appliquer</Button>
              <Button size="sm" variant="ghost" onClick={() => setBulkOpen(false)}>Annuler</Button>
            </>) : <Button size="sm" onClick={() => setBulkOpen(true)} data-testid="bulk-folder-open"><Icon name="folder" />Mettre dans un dossier</Button>}
          </div>
          <AddToPlaylist size="sm" variant="ghost" matchIds={[...selected]} onDone={(msg) => setNotice(msg)} />
          <Button size="sm" variant="danger" onClick={() => setDeleting((matches.data ?? []).filter((m) => selected.has(m.id)))} data-testid="delete-selected">
            <Icon name="trash" />Supprimer</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Tout désélectionner</Button>
        </div>
      )}
      <section className="match-table panel">
        <div className="match-thead">
          {!!matches.data?.length && <input type="checkbox" className="match-check" aria-label="Tout sélectionner"
            checked={selected.size > 0 && selected.size === matches.data.length}
            ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < (matches.data?.length ?? 0); }}
            onChange={(e) => setSelected(e.target.checked ? new Set(matches.data!.map((m) => m.id)) : new Set())} />}
          <span>Carte</span><span className="th-center">Match</span><span>Rounds</span><span>Durée</span><span>Date</span>
        </div>
        {matches.isLoading && <Skeleton rows={6} />}
        {matches.data?.length === 0 && !inProgress.length && (
          <EmptyState icon="upload" title="Aucune démo">Glissez des fichiers .dem ici ou configurez un dossier de démos.</EmptyState>
        )}
        {matches.data?.map((m, idx) => {
          const toggle = (shift: boolean) => setSelected((s) => {
            const n = new Set(s);
            const rows = matches.data ?? [];
            if (shift && lastPick.current !== null) {  // Maj+clic : toute la plage depuis la dernière case cochée
              const a = Math.min(lastPick.current, idx), b = Math.max(lastPick.current, idx);
              for (let k = a; k <= b; k++) n.add(rows[k].id);
            } else if (n.has(m.id)) n.delete(m.id); else n.add(m.id);
            lastPick.current = idx;
            return n;
          });
          return (
          <div key={m.id} className={`match-item ${selected.has(m.id) ? "sel" : ""}`}>
            <label className="match-select" title="Sélectionner (Maj+clic : plage)" onClick={(e) => { if (e.shiftKey) { e.preventDefault(); toggle(true); } }}>
              <input type="checkbox" className="match-check" aria-label={`Sélectionner ${m.team_a.name} contre ${m.team_b.name}`} checked={selected.has(m.id)}
                onChange={() => toggle(false)} data-testid="match-check" />
            </label>
            <MatchRow m={m} selecting={selected.size > 0} onToggle={toggle} />
            <div className="match-actions">
              <Button size="sm" variant="ghost" title="Organiser (dossier, événement, étiquettes, date)" aria-label="Organiser" onClick={() => setLabelling(m)}><Icon name="folder" /></Button>
              <a className="btn btn-sm btn-ghost" href={api.demoFileUrl(m.demo_id)} download title="Télécharger la démo" aria-label="Télécharger la démo"><Icon name="download" /></a>
              <Button size="sm" variant="ghost" title="Ré-analyser" onClick={() => api.reparse(m.demo_id).then(refresh)}><Icon name="refresh" /></Button>
              <Button size="sm" variant="ghost" title="Supprimer ce match" aria-label="Supprimer ce match" onClick={() => setDeleting([m])} data-testid="delete-match"><Icon name="trash" /></Button>
            </div>
          </div>
          );
        })}
      </section>
      {labelling && <LabelsDialog m={labelling} onClose={() => setLabelling(null)} />}
      {deleting && <DeleteMatchesDialog matches={deleting} onClose={() => setDeleting(null)}
        onDeleted={() => { setSelected((s) => { const n = new Set(s); deleting.forEach((m) => n.delete(m.id)); return n; }); refresh(); }} />}
      {folders && <FoldersDialog onClose={() => setFolders(false)} onSaved={refresh} />}
    </div>
  );
}
