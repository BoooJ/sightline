import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { TeamItem } from "../api/types";
import { formatDate } from "../format";
import { Icon } from "../ui/Icon";
import { ComparisonDialog } from "./ComparisonDialog";
import { useComparison } from "./comparison";
import { KINDS, LAST_N, MONTHS, type ContextState } from "./useContextFilters";
import "./context.css";

const ECONS: [string, string][] = [["", "Tous"], ["buy", "Achat"], ["eco", "Eco"], ["vs_eco", "Contre eco"], ["pistol", "Pistol"]];
const OPP: [string, string][] = [["", "Tous"], ["buy", "Achat"], ["eco", "Eco"]];
const KIND_LABEL: Record<string, string> = { official: "Officiels", practice: "Entraînement" };

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`ctx-field ${className}`}><span className="ctx-label">{label}</span>{children}</label>;
}

/** Barre de contexte commune aux pages de statistiques (équipe, carte, camp, période, nombre de matchs, achats,
 *  filtres d'organisation), avec le résumé de la sélection, la liste des matchs retenus et la référence de comparaison. */
export function ContextBar({ ctx, fixedTeam, roles, steamid, teamOnly }:
  { ctx: ContextState; fixedTeam?: { id: number; name: string }; roles?: boolean; steamid?: string; teamOnly?: boolean }) {
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams, staleTime: 60_000 });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets, staleTime: 30_000 });
  const labels = useQuery({ queryKey: ["role-labels"], queryFn: api.roleLabels, staleTime: Infinity, enabled: !!roles }).data ?? {};
  const libParams = fixedTeam ? { ...ctx.lib, team: String(fixedTeam.id) } : ctx.lib;
  const summary = useQuery({ queryKey: ["context", libParams, ctx.map ?? ""], queryFn: () => api.context({ ...libParams, map: ctx.map }), placeholderData: (prev) => prev });
  const [filters, setFilters] = useState(false);
  const [matches, setMatches] = useState(false);
  const [cmp, setCmp] = useState(false);
  const { settings } = useComparison();
  const custom = !!(ctx.dateFrom || ctx.dateTo);
  const [dates, setDates] = useState(custom);
  useEffect(() => { if (custom) setDates(true); }, [custom]);
  const nFilters = [ctx.folder, ctx.event, ctx.tag, ctx.kind].filter(Boolean).length;
  const teamName = (id: number) => teams.data?.find((t) => t.id === id)?.name ?? `Équipe ${id}`;
  const cmpLabel = settings.mode === "self" ? "vous-même (forme passée)"
    : settings.teams.length ? `${settings.teams.map(teamName).join(", ")} · ${settings.months} mois` : "aucune référence";
  const s = summary.data;
  return (
    <div className="ctx" data-testid="context-bar">
      <div className="ctx-row">
        {!teamOnly && (fixedTeam ? <Field label="Équipe"><span className="ctx-fixed">{fixedTeam.name}</span></Field> : (
          <Field label="Équipe">
            <select className="rf-select ctx-select" value={ctx.team ?? ""} onChange={(e) => ctx.set("team", e.target.value)} aria-label="Équipe">
              <option value="">Toute la bibliothèque</option>
              {teams.data?.map((t: TeamItem) => <option key={t.id} value={t.id}>{t.name} ({t.matches})</option>)}
            </select>
          </Field>
        ))}
        <Field label="Carte">
          <select className="rf-select ctx-select" value={ctx.map ?? ""} onChange={(e) => ctx.set("map", e.target.value)} aria-label="Carte">
            <option value="">Toutes les cartes</option>
            {maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}
          </select>
        </Field>
        <div className="ctx-field"><span className="ctx-label">Camp</span>
          <div className="ts-seg" role="radiogroup" aria-label="Camp">
            {([["", "Les deux"], ["CT", "CT"], ["T", "T"]] as const).map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={(ctx.side ?? "") === v} className={(ctx.side ?? "") === v ? "on" : ""} onClick={() => ctx.set("side", v)}>{l}</button>
            ))}
          </div>
        </div>
        <Field label="Période">
          <select className="rf-select ctx-select ctx-narrow" aria-label="Période" value={dates ? "custom" : ctx.months ? String(ctx.months) : ""}
            onChange={(e) => { const v = e.target.value; if (v === "custom") { setDates(true); ctx.set({ months: null }); } else { setDates(false); ctx.set({ months: v || null, date_from: null, date_to: null }); } }}>
            <option value="">Toute la période</option>
            {MONTHS.map((m) => <option key={m} value={m}>{m === 12 ? "12 derniers mois" : `${m} dernier${m > 1 ? "s" : ""} mois`}</option>)}
            <option value="custom">Dates…</option>
          </select>
        </Field>
        {dates && (
          <div className="ctx-field"><span className="ctx-label">Du → au</span>
            <div className="libf-dates">
              <input type="date" className="rf-select" value={ctx.dateFrom ?? ""} onChange={(e) => ctx.set("date_from", e.target.value)} aria-label="Du" />
              <input type="date" className="rf-select" value={ctx.dateTo ?? ""} onChange={(e) => ctx.set("date_to", e.target.value)} aria-label="Au" />
            </div>
          </div>
        )}
        <Field label="Matchs">
          <select className="rf-select ctx-select ctx-narrow" value={ctx.lastN ?? ""} onChange={(e) => ctx.set("last_n", e.target.value)} aria-label="Nombre de matchs">
            <option value="">Tous</option>
            {LAST_N.map((n) => <option key={n} value={n}>{n} dernier{n > 1 ? "s" : ""}</option>)}
          </select>
        </Field>
        <Field label="Nous">
          <select className="rf-select ctx-select ctx-narrow" value={ctx.econ ?? ""} onChange={(e) => ctx.set("econ", e.target.value)} aria-label="Notre achat">
            {ECONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Adversaire">
          <select className="rf-select ctx-select ctx-narrow" value={ctx.oppEcon ?? ""} onChange={(e) => ctx.set("opp_econ", e.target.value)} aria-label="Achat adverse">
            {OPP.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        {roles && (
          <Field label="Rôle">
            <select className="rf-select ctx-select ctx-narrow" value={ctx.role ?? ""} onChange={(e) => ctx.set("role", e.target.value)} aria-label="Rôle">
              <option value="">Tous</option>
              {Object.entries(labels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        )}
        <div className="ctx-field ctx-pop-anchor"><span className="ctx-label">&nbsp;</span>
          <button type="button" className={`btn btn-sm ${nFilters ? "ctx-on" : ""}`} onClick={() => setFilters(!filters)} aria-expanded={filters} data-testid="ctx-filters">
            <Icon name="settings" size={14} /> Filtres{nFilters ? ` (${nFilters})` : ""}</button>
          {filters && <FiltersPanel ctx={ctx} facets={facets.data} onClose={() => setFilters(false)} />}
        </div>
        <div className="ctx-summary">
          <span className="ctx-count mono" data-testid="ctx-maps"><b>{s?.maps ?? "–"}</b> carte{(s?.maps ?? 0) > 1 ? "s" : ""}</span>
          <span className="ctx-dot">·</span>
          <span className="ctx-count mono" data-testid="ctx-rounds"><b>{s?.rounds ?? "–"}</b> rounds</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMatches(!matches)} aria-expanded={matches} data-testid="ctx-show-matches">
            {matches ? "Masquer" : "Voir les matchs"} ({s?.matches ?? 0})</button>
        </div>
      </div>
      <div className="ctx-row ctx-cmp-row">
        <span className="ctx-label">Comparé à</span>
        <span className="ctx-cmp" data-testid="ctx-comparison">{cmpLabel}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCmp(true)} data-testid="ctx-edit-comparison"><Icon name="settings" size={14} /> Modifier</button>
        {settings.mode === "self" && !steamid && <span className="st-legend">Choisissez un joueur pour comparer à sa forme passée.</span>}
      </div>
      {matches && (
        <div className="panel ctx-matches" data-testid="ctx-matches">
          {!s?.list.length ? <p className="st-legend">Aucun match pour ces filtres.</p> : (
            <table className="ctx-table">
              <thead><tr><th>Carte</th><th>Match</th><th>Score</th><th>Rounds</th><th>Type</th><th>Date</th></tr></thead>
              <tbody>
                {s.list.map((m) => (
                  <tr key={m.id}>
                    <td>{m.map_display_name}</td>
                    <td><Link className="pl-link" to={`/matches/${m.id}`}>{m.team_a.name} vs {m.team_b.name}</Link></td>
                    <td className="mono">{m.score_a}:{m.score_b}</td>
                    <td className="mono">{m.rounds_count}</td>
                    <td>{m.kind ? KIND_LABEL[m.kind] : ""}</td>
                    <td className="mono">{m.date ? formatDate(m.date) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {cmp && <ComparisonDialog onClose={() => setCmp(false)} />}
    </div>
  );
}

function FiltersPanel({ ctx, facets, onClose }: { ctx: ContextState; facets?: { folders: { name: string; count: number }[]; events: { name: string; count: number }[]; tags: { name: string; count: number }[] }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", on); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", on); document.removeEventListener("keydown", key); };
  }, [onClose]);
  return (
    <div className="panel ctx-pop" ref={ref} role="dialog" aria-label="Filtres d'organisation">
      <div className="ctx-field"><span className="ctx-label">Type de match</span>
        <div className="ts-seg" role="radiogroup" aria-label="Type de match">
          {([["", "Tous"], ...KINDS.map((k) => [k, KIND_LABEL[k]])] as [string, string][]).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={(ctx.kind ?? "") === v} className={(ctx.kind ?? "") === v ? "on" : ""} onClick={() => ctx.set("kind", v)}>{l}</button>
          ))}
        </div>
        <p className="st-legend">Officiel = événement renseigné (ou dossier « Officiels »). Le reste est de l'entraînement.</p>
      </div>
      {!!facets?.folders.length && (
        <div className="ctx-field"><span className="ctx-label">Dossier</span>
          <div className="map-pills" role="group" aria-label="Dossier">
            <button type="button" className={`pill ${!ctx.folder ? "on" : ""}`} onClick={() => ctx.set("folder")}>Tous</button>
            {facets.folders.map((x) => <button key={x.name} type="button" className={`pill ${ctx.folder === x.name ? "on" : ""}`} onClick={() => ctx.set("folder", x.name)}>{x.name} <span className="mono libf-n">{x.count}</span></button>)}
          </div>
        </div>
      )}
      {!!facets?.events.length && (
        <Field label="Événement">
          <select className="rf-select" value={ctx.event ?? ""} onChange={(e) => ctx.set("event", e.target.value)} aria-label="Événement">
            <option value="">Tous</option>{facets.events.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.count})</option>)}
          </select>
        </Field>
      )}
      {!!facets?.tags.length && (
        <Field label="Étiquette">
          <select className="rf-select" value={ctx.tag ?? ""} onChange={(e) => ctx.set("tag", e.target.value)} aria-label="Étiquette">
            <option value="">Toutes</option>{facets.tags.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.count})</option>)}
          </select>
        </Field>
      )}
      <div className="ctx-pop-foot">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => ctx.set({ folder: null, event: null, tag: null, kind: null })}>Effacer</button>
        <button type="button" className="btn btn-sm" onClick={onClose}>Fermer</button>
      </div>
    </div>
  );
}
