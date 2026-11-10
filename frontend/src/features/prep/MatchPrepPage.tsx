import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { PrepTemplate, PrepTemplateWidget, PrepWidgetDef, PrepWidgetType } from "../../shared/api/types";
import { formatDate } from "../../shared/format";
import { useAuth } from "../team/auth";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import "../scouting/scouting.css";
import "./prep.css";

/** Match Prep (comme EDGE) : rapports générés (adversaire + carte, à partir d'un template à widgets), templates partagés ou privés. */
export function MatchPrepPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const reports = useQuery({ queryKey: ["prep-reports"], queryFn: () => api.prepReports() });
  const templates = useQuery({ queryKey: ["prep-templates"], queryFn: api.prepTemplates });
  const teams = useQuery({ queryKey: ["scout-teams"], queryFn: api.scoutTeams, staleTime: 60_000 });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const widgets = useQuery({ queryKey: ["prep-widgets"], queryFn: api.prepWidgets, staleTime: Infinity });
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState("");
  const [map, setMap] = useState("");
  const [tpl, setTpl] = useState("");
  const [editing, setEditing] = useState<PrepTemplate | "new" | null>(null);
  const [tab, setTab] = useState<"reports" | "templates">("reports");
  const gen = useMutation({
    mutationFn: () => api.createPrepReport({ team_id: Number(team), map, template_id: Number(tpl) || undefined }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["prep-reports"] }); setOpen(false); nav(`/match-prep/${r.id}`); },
  });
  const teamMaps = (() => { const t = teams.data?.find((x) => String(x.id) === team); return t ? maps.data ?? [] : []; })();
  const tplList = templates.data ?? [];
  const canGen = !!team && !!map;
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Adversaires</div><h1 className="display">Match Prep</h1></div>
        <div className="lib-tools">
          <Button variant="primary" onClick={() => { setOpen(true); if (!tpl && tplList[0]) setTpl(String(tplList[0].id)); }} data-testid="prep-new"><Icon name="print" />Nouveau rapport</Button>
        </div>
      </div>
      <nav className="tabs" role="tablist">
        {([["reports", "Rapports"], ["templates", "Modèles"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)} data-testid={`prep-tab-${k}`}>{l}</button>
        ))}
      </nav>
      {tab === "reports" && (
        reports.isLoading ? <Spinner /> : !reports.data?.length ? (
          <section className="panel section"><EmptyState icon="print" title="Aucun rapport généré">Choisissez un adversaire, une carte et un modèle : le rapport fige les chiffres du scouting du moment, et s'imprime en PDF.</EmptyState></section>
        ) : (
          <section className="panel prep-table-wrap">
            <div className="prep-thead"><span>Rapport</span><span>Équipe</span><span>Carte</span><span>Widgets</span><span>Auteur</span><span>Généré le</span><span /></div>
            {reports.data.map((r) => (
              <div key={r.id} className="prep-row" data-testid="prep-report-row">
                <Link to={`/match-prep/${r.id}`} className="prep-title">{r.title}</Link>
                <span>{r.team?.name ?? r.team_id}</span>
                <span>{r.display_name ?? r.map}</span>
                <span className="rf-dim">{r.widgets?.length ?? 0}</span>
                <span>{r.author ?? <span className="rf-dim">—</span>}</span>
                <span className="rf-dim">{formatDate(r.created_at)}</span>
                <span className="prep-actions">
                  <Link className="btn btn-sm" to={`/match-prep/${r.id}`}>Voir</Link>
                  <Button size="sm" variant="ghost" aria-label={`Supprimer ${r.title}`} onClick={async () => { await api.deletePrepReport(r.id); qc.invalidateQueries({ queryKey: ["prep-reports"] }); }}><Icon name="trash" /></Button>
                </span>
              </div>
            ))}
          </section>
        )
      )}
      {tab === "templates" && (
        <section className="panel section">
          <div className="prep-tpl-head">
            <p className="st-legend">Un modèle est une liste de widgets. Partagé : visible par toute l'équipe ; privé : seulement par vous.</p>
            <Button size="sm" onClick={() => setEditing("new")} data-testid="prep-tpl-new">+ Nouveau modèle</Button>
          </div>
          <div className="prep-tpls">
            {tplList.map((t) => (
              <div key={t.id} className="prep-tpl panel" data-testid="prep-tpl">
                <div className="prep-tpl-name"><b>{t.name}</b><span className={`mlab ${t.shared ? "folder" : ""}`}>{t.shared ? "partagé" : "privé"}</span>{t.author && <small className="rf-dim">· {t.author}</small>}</div>
                <div className="prep-tpl-widgets">{t.widgets.length ? t.widgets.map((w, i) => <span key={i} className="mlab">{widgets.data?.find((d) => d.type === w.type)?.label ?? w.type}</span>) : <span className="rf-dim">Ce modèle est vide.</span>}</div>
                <div className="lib-tools"><Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Modifier</Button>
                  <Button size="sm" variant="ghost" aria-label={`Supprimer le modèle ${t.name}`} onClick={async () => { await api.deletePrepTemplate(t.id); qc.invalidateQueries({ queryKey: ["prep-templates"] }); }}><Icon name="trash" /></Button></div>
              </div>
            ))}
          </div>
        </section>
      )}
      {open && (
        <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <form className="dialog panel libf-dialog" role="dialog" aria-label="Nouveau rapport" data-testid="prep-dialog" onSubmit={(e) => { e.preventDefault(); if (canGen) gen.mutate(); }}>
            <h3 className="display">Générer un rapport</h3>
            <label className="auth-field"><span>Adversaire</span>
              <select className="rf-select" value={team} onChange={(e) => { setTeam(e.target.value); setMap(""); }} aria-label="Adversaire" data-testid="prep-team">
                <option value="">Choisir…</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.matches} match{t.matches > 1 ? "s" : ""})</option>)}
              </select></label>
            <label className="auth-field"><span>Carte</span>
              <select className="rf-select" value={map} onChange={(e) => setMap(e.target.value)} aria-label="Carte" disabled={!team} data-testid="prep-map">
                <option value="">Choisir…</option>{teamMaps.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}
              </select></label>
            <label className="auth-field"><span>Modèle</span>
              <select className="rf-select" value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Modèle" data-testid="prep-template">
                {tplList.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.widgets.length} widget{t.widgets.length > 1 ? "s" : ""}{t.shared ? "" : ", privé"})</option>)}
              </select></label>
            {gen.isError && <p className="auth-error">{(gen.error as Error).message}</p>}
            <div className="sc-dialog-foot"><Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
              <Button type="submit" variant="primary" disabled={!canGen || gen.isPending} data-testid="prep-generate">{gen.isPending ? "Génération…" : "Générer"}</Button></div>
          </form>
        </div>
      )}
      {editing && widgets.data && <TemplateEditor tpl={editing === "new" ? null : editing} defs={widgets.data} onClose={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["prep-templates"] }); }} />}
    </div>
  );
}

function TemplateEditor({ tpl, defs, onClose }: { tpl: PrepTemplate | null; defs: PrepWidgetDef[]; onClose: () => void }) {
  const { user } = useAuth();
  const [name, setName] = useState(tpl?.name ?? "");
  const [shared, setShared] = useState(tpl?.shared ?? true);
  const [widgets, setWidgets] = useState<PrepTemplateWidget[]>(tpl?.widgets ?? []);
  const [add, setAdd] = useState<PrepWidgetType>("reads");
  const [err, setErr] = useState<string | null>(null);
  const move = (i: number, d: -1 | 1) => setWidgets((ws) => { const n = [...ws]; const j = i + d; if (j < 0 || j >= n.length) return ws; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const save = async () => {
    try {
      if (tpl) await api.updatePrepTemplate(tpl.id, { name, widgets, shared }); else await api.createPrepTemplate({ name, widgets, shared });
      onClose();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog panel libf-dialog prep-editor" role="dialog" aria-label="Modèle de rapport" data-testid="prep-tpl-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h3 className="display">{tpl ? "Modifier le modèle" : "Nouveau modèle"}</h3>
        <label className="auth-field"><span>Nom</span><input value={name} onChange={(e) => setName(e.target.value)} aria-label="Nom du modèle" autoFocus /></label>
        <label className="hm-check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Partagé avec l'équipe{!user && <small className="rf-dim"> (sans compte, tout est partagé)</small>}</label>
        <span className="rf-label">Widgets</span>
        {!widgets.length && <p className="cm-empty">Ce modèle est vide. Ajoutez un widget.</p>}
        <ol className="prep-wlist">
          {widgets.map((w, i) => {
            const def = defs.find((d) => d.type === w.type);
            return (
              <li key={i} className="prep-witem" data-testid="prep-widget">
                <span><b>{def?.label ?? w.type}</b><small className="rf-dim"> · {def?.help}</small>
                  {w.type === "notes" && <textarea className="prep-wtext" value={w.text ?? ""} placeholder="Texte des notes…" aria-label="Texte des notes" onChange={(e) => setWidgets((ws) => ws.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} />}</span>
                <span className="prep-wactions">
                  <Button size="sm" variant="ghost" aria-label="Monter" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" /></Button>
                  <Button size="sm" variant="ghost" aria-label="Descendre" disabled={i === widgets.length - 1} onClick={() => move(i, 1)}><Icon name="down" /></Button>
                  <Button size="sm" variant="ghost" aria-label="Retirer" onClick={() => setWidgets((ws) => ws.filter((_, k) => k !== i))}><Icon name="trash" /></Button>
                </span>
              </li>
            );
          })}
        </ol>
        <div className="prep-wadd">
          <select className="rf-select" value={add} onChange={(e) => setAdd(e.target.value as PrepWidgetType)} aria-label="Widget à ajouter">{defs.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}</select>
          <Button size="sm" onClick={() => setWidgets((ws) => [...ws, { type: add, ...(add === "notes" ? { text: "" } : {}) }])} data-testid="prep-add-widget">Ajouter le widget</Button>
        </div>
        {err && <p className="auth-error">{err}</p>}
        <div className="sc-dialog-foot"><Button variant="ghost" onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" disabled={!name.trim()} data-testid="prep-tpl-save">Enregistrer</Button></div>
      </form>
    </div>
  );
}
