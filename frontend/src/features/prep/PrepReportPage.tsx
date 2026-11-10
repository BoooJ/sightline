import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import { formatDate } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { PrepWidgetView } from "./PrepWidgets";
import "../scouting/scouting.css";
import "../match/report.css";
import "./prep.css";

/** Rapport de préparation généré : widgets figés, notes de l'équipe, impression / PDF. */
export function PrepReportPage() {
  const id = Number(useParams().reportId);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["prep-report", id], queryFn: () => api.prepReport(id), retry: false });
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (q.data) setNotes(q.data.notes); }, [q.data]);
  if (q.isLoading) return <div className="page"><Spinner /></div>;
  if (!q.data) return <div className="page"><EmptyState title="Rapport introuvable" /></div>;
  const r = q.data, c = r.content;
  const saveNotes = async () => { await api.updatePrepReport(id, { notes }); qc.invalidateQueries({ queryKey: ["prep-report", id] }); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  return (
    <div className="page report prep-report" data-testid="prep-report">
      <div className="report-actions rp-noprint">
        <Link to="/match-prep" className="back-link"><Icon name="back" />Match Prep</Link>
        <div className="lib-tools">
          <Link className="btn" to={`/scouting/${c.team.id}?map=${c.map}`}><Icon name="scout" />Fiche scouting</Link>
          <Button variant="primary" onClick={() => window.print()} data-testid="prep-print"><Icon name="print" />Imprimer ou PDF</Button>
        </div>
      </div>
      <header className="report-head">
        <div className="eyebrow">Rapport de préparation · {c.display_name}</div>
        <h1 className="display">{r.title}</h1>
        <p className="st-legend">Adversaire : <b>{c.team.name}</b> · {c.matches_on_map} match{c.matches_on_map > 1 ? "s" : ""} analysé{c.matches_on_map > 1 ? "s" : ""} sur {c.display_name} · généré le {formatDate(r.created_at)}{r.author ? ` par ${r.author}` : ""}. Les chiffres sont figés à la génération.</p>
      </header>
      {c.widgets.map((w, i) => (
        <section key={i} className="panel section prep-widget" data-testid="prep-widget-view" data-type={w.type}>
          <h2 className="section-title">{w.title}</h2>
          <PrepWidgetView w={w} team={c.team} />
        </section>
      ))}
      <section className="panel section prep-widget">
        <h2 className="section-title">Notes de l'équipe</h2>
        <textarea className="prep-notes rp-noprint" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Consignes, rappels, plan de match…" aria-label="Notes de l'équipe" data-testid="prep-notes" />
        <p className="prep-notes-print">{r.notes || "—"}</p>
        <div className="lib-tools rp-noprint"><Button size="sm" variant="primary" onClick={() => void saveNotes()} disabled={notes === r.notes} data-testid="prep-notes-save">{saved ? "Enregistré ✓" : "Enregistrer les notes"}</Button></div>
      </section>
    </div>
  );
}
