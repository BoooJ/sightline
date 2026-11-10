import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ComparisonSettings } from "../api/types";
import { Button } from "../ui/Button";
import { useComparison, usePresets } from "./comparison";
import { MONTHS } from "./useContextFilters";

const MAX = 5;

/** Fenêtre « Modifier la comparaison » : équipes de la bibliothèque (5 au plus) sur une fenêtre, ou soi-même ;
 *  presets réutilisables. */
export function ComparisonDialog({ onClose }: { onClose: () => void }) {
  const { settings, update } = useComparison();
  const { presets, setPresets } = usePresets();
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams, staleTime: 60_000 });
  const [draft, setDraft] = useState<ComparisonSettings>({ ...settings, teams: [...settings.teams] });
  const [q, setQ] = useState("");
  const [presetName, setPresetName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  const toggle = (id: number) => setDraft((d) => ({ ...d, teams: d.teams.includes(id) ? d.teams.filter((t) => t !== id) : d.teams.length < MAX ? [...d.teams, id] : d.teams }));
  const apply = async () => { setBusy(true); try { await update(draft); onClose(); } finally { setBusy(false); } };
  const name = (id: number) => teams.data?.find((t) => t.id === id)?.name ?? `Équipe ${id}`;
  const list = (teams.data ?? []).filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog panel cmp-dialog" role="dialog" aria-label="Modifier la comparaison" data-testid="comparison-dialog">
        <h3 className="display">Comparé à</h3>
        <p className="dialog-hint">Chaque statistique est affichée à côté de cette référence (« Comp. ») avec l'écart.</p>
        <div className="cmp-mode ts-seg" role="radiogroup" aria-label="Type de comparaison">
          <button type="button" role="radio" aria-checked={draft.mode === "teams"} className={draft.mode === "teams" ? "on" : ""} onClick={() => setDraft({ ...draft, mode: "teams" })}>Équipes</button>
          <button type="button" role="radio" aria-checked={draft.mode === "self"} className={draft.mode === "self" ? "on" : ""} onClick={() => setDraft({ ...draft, mode: "self" })}>Vous-même</button>
        </div>
        {draft.mode === "self" ? (
          <p className="st-legend">Le joueur affiché est comparé à sa propre forme passée : ses matchs précédant la sélection courante, en nombre égal. Choisissez une période ou un nombre de matchs dans la barre pour que la comparaison ait un sens.</p>
        ) : (<>
          <div className="ctx-field"><span className="ctx-label">Fenêtre</span>
            <div className="ts-seg" role="radiogroup" aria-label="Fenêtre">
              {MONTHS.map((m) => <button key={m} type="button" role="radio" aria-checked={draft.months === m} className={draft.months === m ? "on" : ""} onClick={() => setDraft({ ...draft, months: m })}>{m} mois</button>)}
            </div>
          </div>
          <div className="ctx-field"><span className="ctx-label">Équipes de référence ({draft.teams.length}/{MAX})</span>
            <div className="cmp-chips">
              {draft.teams.map((id) => <button key={id} type="button" className="pill on" onClick={() => toggle(id)} title="Retirer">{name(id)} ✕</button>)}
              {!draft.teams.length && <span className="st-legend">Aucune équipe choisie : pas de référence.</span>}
            </div>
            <input className="input cmp-search" placeholder="Rechercher une équipe de la bibliothèque…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une équipe" />
            <ul className="cmp-list">
              {list.map((t) => (
                <li key={t.id}>
                  <label className="hm-check"><input type="checkbox" checked={draft.teams.includes(t.id)} disabled={!draft.teams.includes(t.id) && draft.teams.length >= MAX} onChange={() => toggle(t.id)} />
                    {t.name} <span className="mono libf-n">{t.matches} match{t.matches > 1 ? "s" : ""}</span></label>
                </li>
              ))}
              {!list.length && <li className="st-legend">Aucune équipe.</li>}
            </ul>
          </div>
          <div className="ctx-field"><span className="ctx-label">Presets</span>
            <div className="cmp-chips">
              {presets.map((p) => (
                <span key={p.name} className="cmp-preset">
                  <button type="button" className="pill" onClick={() => setDraft({ mode: "teams", teams: p.teams.slice(0, MAX), months: p.months })} title={p.teams.map(name).join(", ")}>{p.name}</button>
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Supprimer le preset ${p.name}`} onClick={() => setPresets(presets.filter((x) => x.name !== p.name))}>✕</button>
                </span>
              ))}
              {!presets.length && <span className="st-legend">Enregistrez une sélection que vous réutilisez souvent.</span>}
            </div>
            <div className="cmp-save">
              <input className="input" placeholder="Nom du preset" value={presetName} onChange={(e) => setPresetName(e.target.value)} aria-label="Nom du preset" />
              <Button size="sm" disabled={!presetName.trim() || !draft.teams.length}
                onClick={() => { setPresets([...presets.filter((p) => p.name !== presetName.trim()), { name: presetName.trim(), teams: draft.teams, months: draft.months }]); setPresetName(""); }}>Enregistrer</Button>
            </div>
          </div>
        </>)}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={() => void apply()} disabled={busy} data-testid="comparison-apply">Appliquer</Button>
        </div>
      </div>
    </div>
  );
}
