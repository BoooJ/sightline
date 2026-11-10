import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { MapMeta, PlaybookEntryT, PlaybookKind, Side } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Rich, useCodewords } from "./Codewords";

const SECTIONS: { kind: PlaybookKind; title: string; hint: string; empty: string }[] = [
  { kind: "roles", title: "Rôles par carte", hint: "Qui joue quel spot, en T et en CT.", empty: "Aucun rôle pour cette sélection." },
  { kind: "codeword", title: "Lexique des annonces", hint: "Les mots de l'équipe : ils sont soulignés dans les stratégies, définition au survol.", empty: "Aucune annonce." },
  { kind: "rule", title: "Rappels", hint: "Les principes de jeu, par situation (5 vs 4, avantage, désavantage…).", empty: "Aucun rappel pour cette sélection." },
  { kind: "note", title: "Notes d'équipe", hint: "Vote du map pool, objectifs par carte, le reste.", empty: "Aucune note." },
];

/** Mémo d'équipe du stratbook : rôles par carte, lexique des annonces, rappels de jeu et notes. Filtré par la carte et
 *  le camp choisis en haut de la page (une entrée sans carte ou sans camp vaut pour toutes). */
export function Memo({ maps, map, side }: { maps: MapMeta[]; map?: string; side?: Side }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["memo"], queryFn: api.memo });
  const words = useCodewords();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Partial<PlaybookEntryT> | null>(null);
  const mapName = (m: string | null) => (m ? maps.find((x) => x.name === m)?.display_name ?? m : null);
  const fits = (e: PlaybookEntryT) => (!map || !e.map || e.map === map) && (!side || !e.side || e.side === side);
  const needle = search.trim().toLowerCase();
  const items = (kind: PlaybookKind) => (q.data ?? []).filter((e) => e.kind === kind && (kind === "codeword"
    ? !needle || `${e.title} ${e.body}`.toLowerCase().includes(needle) : fits(e)));
  const refresh = () => qc.invalidateQueries({ queryKey: ["memo"] });
  if (q.isLoading) return <Spinner />;
  return (
    <div className="mm" data-testid="memo">
      {SECTIONS.map((sec) => {
        const list = items(sec.kind);
        return (
          <section key={sec.kind} className={`panel mm-sec mm-${sec.kind}`} aria-label={sec.title}>
            <header className="mm-head">
              <div><h2 className="section-title">{sec.title} <span className="mono rf-dim">{list.length}</span></h2><p className="st-legend">{sec.hint}</p></div>
              <div className="mm-tools">
                {sec.kind === "codeword" && <input className="mm-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Chercher une annonce" aria-label="Chercher une annonce" />}
                <Button size="sm" onClick={() => setEditing({ kind: sec.kind, map: sec.kind === "codeword" ? null : map ?? null, side: side ?? null })}>
                  <Icon name="plus" size={14} />Ajouter</Button>
              </div>
            </header>
            {list.length ? (
              <div className="mm-grid">
                {list.map((e) => (
                  <article key={e.id} className="mm-card">
                    <header>
                      <h3>{e.title}</h3>
                      <span className="mm-tags">
                        {e.side && <span className={`sb-side ${e.side.toLowerCase()}`}>{e.side}</span>}
                        {e.map && e.kind !== "roles" && <span className="mlab">{mapName(e.map)}</span>}
                      </span>
                    </header>
                    {e.body && <p className="mm-body">{e.kind === "codeword" ? e.body : <Rich text={e.body} words={words} />}</p>}
                    <footer>
                      {e.link && <a href={e.link} target="_blank" rel="noreferrer noopener" className="mm-link"><Icon name="play" size={12} />Voir le clip</a>}
                      <span className="mm-actions">
                        <Button size="sm" variant="ghost" aria-label={`Modifier « ${e.title} »`} onClick={() => setEditing(e)}><Icon name="pen" size={13} /></Button>
                        <DeleteButton title={e.title} onDelete={async () => { await api.deleteMemo(e.id); await refresh(); }} />
                      </span>
                    </footer>
                  </article>
                ))}
              </div>
            ) : <p className="cm-empty">{sec.empty}</p>}
          </section>
        );
      })}
      {!q.data?.length && <EmptyState icon="book" title="Mémo vide">Le lexique, les rappels et les rôles de l'équipe se rangent ici.</EmptyState>}
      {editing && <EditEntry entry={editing} maps={maps} onClose={() => setEditing(null)}
        onSave={async (p) => { if (editing.id) await api.updateMemo(editing.id, p); else await api.createMemo(p); await refresh(); setEditing(null); }} />}
    </div>
  );
}

function DeleteButton({ title, onDelete }: { title: string; onDelete: () => Promise<void> }) {
  const [sure, setSure] = useState(false);
  return sure ? (
    <span className="mm-confirm"><Button size="sm" variant="ghost" onClick={() => setSure(false)}>Non</Button>
      <Button size="sm" variant="danger" onClick={() => void onDelete()}>Supprimer</Button></span>
  ) : <Button size="sm" variant="ghost" aria-label={`Supprimer « ${title} »`} onClick={() => setSure(true)}><Icon name="trash" size={13} /></Button>;
}

function EditEntry({ entry, maps, onSave, onClose }: {
  entry: Partial<PlaybookEntryT>; maps: MapMeta[]; onSave: (p: Partial<PlaybookEntryT>) => Promise<void>; onClose: () => void;
}) {
  const [f, setF] = useState({ title: entry.title ?? "", body: entry.body ?? "", map: entry.map ?? "", side: entry.side ?? "", link: entry.link ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const word = entry.kind === "codeword";
  const submit = async () => {
    setErr(null);
    try {
      await onSave({ kind: entry.kind, title: f.title, body: f.body, link: f.link.trim() || null,
        map: word ? null : f.map || null, side: word ? null : (f.side || null) as Side | null });
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog panel sb-dlg" role="dialog" aria-label={entry.id ? "Modifier l'entrée" : "Nouvelle entrée du mémo"}
        onSubmit={(e) => { e.preventDefault(); void submit(); }} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="sb-new-head"><h2 className="display">{entry.id ? "Modifier" : "Ajouter au mémo"}</h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer">✕</Button></div>
        <label className="auth-field"><span>{word ? "Annonce" : "Titre"}</span><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={120} autoFocus /></label>
        <label className="auth-field"><span>{word ? "Définition" : "Texte"}</span>
          <textarea className="sb-textarea" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={4000} /></label>
        {!word && (
          <div className="rf-row">
            <label className="auth-field"><span>Carte</span>
              <select className="rf-select" value={f.map} onChange={(e) => setF({ ...f, map: e.target.value })}>
                <option value="">Toutes les cartes</option>{maps.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}</select></label>
            <label className="auth-field"><span>Camp</span>
              <select className="rf-select" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}>
                <option value="">Les deux</option><option value="T">T</option><option value="CT">CT</option></select></label>
          </div>
        )}
        <label className="auth-field"><span>Lien (clip, démo)</span><input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder="https://…" /></label>
        {err && <p className="auth-error">{err}</p>}
        <div className="lib-tools sb-edit-actions"><Button size="sm" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" size="sm">Enregistrer</Button></div>
      </form>
    </div>
  );
}
