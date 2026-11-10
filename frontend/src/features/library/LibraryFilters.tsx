import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { MatchSummary } from "../../shared/api/types";
import { useUrlParams } from "../../shared/useUrlParams";
import { Button } from "../../shared/ui/Button";

export const LIB_KEYS = ["folder", "event", "tag", "date_from", "date_to"] as const;
export type LibFilters = Partial<Record<(typeof LIB_KEYS)[number], string>>;

/** Filtres de bibliothèque (dossier, événement, étiquette, période) partagés par les pages Matchs, Rounds et Joueurs. */
export function useLibFilters(): LibFilters {
  const [params] = useUrlParams();
  return Object.fromEntries(LIB_KEYS.map((k) => [k, params.get(k) ?? undefined]).filter(([, v]) => v)) as LibFilters;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400_000));

/** Sélecteur de dossier : liste déroulante des dossiers existants, « Aucun », et « Nouveau dossier… » qui ouvre un champ. */
export function FolderPicker({ value, onChange, folders, label = "Dossier", allowNew = true, testId }: {
  value: string; onChange: (v: string) => void; folders: { name: string; count?: number }[]; label?: string; allowNew?: boolean; testId?: string;
}) {
  const known = folders.some((f) => f.name === value);
  const [creating, setCreating] = useState(!!value && !known);
  return (
    <span className="folder-picker">
      <select className="rf-select" value={creating ? "__new" : value} aria-label={label} data-testid={testId}
        onChange={(e) => { if (e.target.value === "__new") { setCreating(true); onChange(""); } else { setCreating(false); onChange(e.target.value); } }}>
        <option value="">Aucun dossier</option>
        {folders.map((f) => <option key={f.name} value={f.name}>{f.name}{f.count != null ? ` (${f.count})` : ""}</option>)}
        {allowNew && <option value="__new">Nouveau dossier…</option>}
      </select>
      {creating && <input className="rf-select" autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder="Nom du nouveau dossier" aria-label="Nouveau dossier" />}
    </span>
  );
}

export function LibraryFilterBar({ withTeam }: { withTeam?: boolean }) {
  const [params, set] = useUrlParams();
  const f = useLibFilters();
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets, staleTime: 30_000 });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams, staleTime: 60_000, enabled: !!withTeam });
  const fa = facets.data;
  const team = withTeam ? params.get("team") ?? "" : "";
  const active = Object.keys(f).length > 0 || !!team;
  const preset = (days: number | null) => set({ date_from: days ? daysAgo(days) : null, date_to: null });
  return (
    <div className="libf" role="group" aria-label="Organisation">
      {withTeam && !!teams.data?.length && (
        <label className="libf-field"><span className="rf-label">Équipe</span>
          <select className="rf-select" value={team} onChange={(e) => set("team", e.target.value)} aria-label="Équipe" data-testid="lib-team">
            <option value="">Toutes</option>{teams.data.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.matches})</option>)}
          </select></label>
      )}
      {!!fa?.folders.length && (
        <label className="libf-field"><span className="rf-label">Dossier</span>
          <select className="rf-select" value={f.folder ?? ""} onChange={(e) => set("folder", e.target.value)} aria-label="Dossier" data-testid="lib-folder">
            <option value="">Tous</option>{fa.folders.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.count})</option>)}
          </select></label>
      )}
      {!!fa?.events.length && (
        <label className="libf-field"><span className="rf-label">Événement</span>
          <select className="rf-select" value={f.event ?? ""} onChange={(e) => set("event", e.target.value)} aria-label="Événement">
            <option value="">Tous</option>{fa.events.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.count})</option>)}
          </select></label>
      )}
      {!!fa?.tags.length && (
        <label className="libf-field"><span className="rf-label">Étiquette</span>
          <select className="rf-select" value={f.tag ?? ""} onChange={(e) => set("tag", e.target.value)} aria-label="Étiquette">
            <option value="">Toutes</option>{fa.tags.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.count})</option>)}
          </select></label>
      )}
      <div className="libf-field"><span className="rf-label">Période</span>
        <div className="libf-dates">
          <input type="date" className="rf-select" value={params.get("date_from") ?? ""} onChange={(e) => set("date_from", e.target.value)} aria-label="Du" />
          <span className="rf-dim">→</span>
          <input type="date" className="rf-select" value={params.get("date_to") ?? ""} onChange={(e) => set("date_to", e.target.value)} aria-label="Au" />
          {([[30, "30 j"], [90, "90 j"], [365, "1 an"]] as const).map(([d, l]) => (
            <button key={d} type="button" className={`pill ${f.date_from === daysAgo(d) && !f.date_to ? "on" : ""}`} onClick={() => preset(d)}>{l}</button>
          ))}
        </div>
      </div>
      {active && <button type="button" className="btn btn-sm btn-ghost libf-reset" onClick={() => set({ ...Object.fromEntries(LIB_KEYS.map((k) => [k, null])), ...(withTeam ? { team: null } : {}) })}>Effacer</button>}
    </div>
  );
}

/** Fenêtre « Organiser » d'un match : dossier, événement, étiquettes, date de jeu. */
export function LabelsDialog({ m, onClose }: { m: MatchSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets, staleTime: 30_000 });
  const [folder, setFolder] = useState(m.labels?.folder ?? "");
  const [event, setEvent] = useState(m.labels?.event ?? "");
  const [tags, setTags] = useState((m.labels?.tags ?? []).join(", "));
  const [played, setPlayed] = useState(m.labels?.played_on ?? "");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await api.setLabels(m.id, { folder, event, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), played_on: played || null });
      qc.invalidateQueries({ queryKey: ["matches"] }); qc.invalidateQueries({ queryKey: ["facets"] });
      onClose();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog panel libf-dialog" role="dialog" aria-label="Organiser le match" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="labels-dialog">
        <h3 className="display">Organiser</h3>
        <p className="st-legend">{m.team_a.name} vs {m.team_b.name} · {m.map_display_name}</p>
        <div className="auth-field"><span>Dossier</span><FolderPicker value={folder} onChange={setFolder} folders={facets.data?.folders ?? []} /></div>
        <label className="auth-field"><span>Événement</span><input list="lib-events" value={event} onChange={(e) => setEvent(e.target.value)} placeholder="ex. ESL Pro League S22" /></label>
        <label className="auth-field"><span>Étiquettes (séparées par des virgules)</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ex. anti-eco, nouveau setup" /></label>
        <label className="auth-field"><span>Date du match</span><input type="date" value={played} onChange={(e) => setPlayed(e.target.value)} /></label>
        <datalist id="lib-events">{facets.data?.events.map((x) => <option key={x.name} value={x.name} />)}</datalist>
        {err && <p className="auth-error">{err}</p>}
        <div className="sc-dialog-foot"><Button variant="ghost" onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Enregistrer</Button></div>
      </form>
    </div>
  );
}
