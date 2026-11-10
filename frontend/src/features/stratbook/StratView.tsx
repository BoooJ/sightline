import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { MapMeta, Strat, StratCategory, StratRole, StratStatus, StratType } from "../../shared/api/types";
import { formatDate } from "../../shared/format";
import { downloadText, aliasName } from "../../shared/practiceCfg";
import { useUrlParams } from "../../shared/useUrlParams";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Popover } from "../../shared/ui/Popover";
import { Spinner } from "../../shared/ui/Spinner";
import { StratBoard } from "./StratBoard";
import { StratMap } from "./StratMap";
import { StratPanel, type PanelTab } from "./StratPanel";
import { STRAT_CATEGORIES, STRAT_STATUS, STRAT_TYPES, stratCfg } from "./strat";

/** Stratégie choisie : bandeau et grande carte au centre (ou tableau tactique avec `board=1`), panneau à onglets à droite. */
export function StratView({ id, maps, tab, onTab }: { id: number; maps: MapMeta[]; tab: PanelTab; onTab: (t: PanelTab) => void }) {
  const qc = useQueryClient();
  const [params, set] = useUrlParams();
  const board = params.get("board") === "1";
  // en passant d'une stratégie à l'autre, la précédente reste affichée le temps de charger la suivante
  const q = useQuery({ queryKey: ["strat", id], queryFn: () => api.strat(id), retry: false, placeholderData: keepPreviousData });
  // joueur suivi et édition : liés à une stratégie, oubliés quand on en change
  const [focusOf, setFocusOf] = useState<{ id: number; i: number } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  // tableau tactique : les joueurs à nommer et les grenades à attribuer sont dans les onglets Joueurs / Grenades
  useEffect(() => { if (board && (tab === "plan" || tab === "notes")) onTab("players"); }, [board]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <section className="panel sb-center sb-span sb-loading"><Spinner /></section>;
  if (!q.data) return <section className="panel sb-center sb-span"><EmptyState icon="book" title="Stratégie introuvable">Elle a peut-être été supprimée.</EmptyState></section>;
  const s = q.data;
  const map = maps.find((m) => m.name === s.map);
  const focus = focusOf?.id === s.id ? focusOf.i : null;
  const setFocus = (i: number | null) => setFocusOf(i === null ? null : { id: s.id, i });
  const save = async (p: Partial<Strat>) => { qc.setQueryData(["strat", s.id], await api.updateStrat(s.id, p)); void qc.invalidateQueries({ queryKey: ["strats"] }); };
  const remove = async () => {
    await api.deleteStrat(s.id);
    qc.removeQueries({ queryKey: ["strat", s.id] });
    await qc.invalidateQueries({ queryKey: ["strats"] });
    set({ s: null, board: null });
  };
  const meta = [map?.display_name ?? s.map, s.author, s.updated_at && `modifiée le ${formatDate(s.updated_at)}`].filter(Boolean).join(" · ");
  return (
    <>
      <section className="panel sb-center" aria-label={`Stratégie ${s.name}`}>
        <header className="sb-bar">
          <div className="sb-bar-id">
            <div className="sb-bar-line">
              <span className={`sb-side ${s.side.toLowerCase()}`}>{s.side}</span>
              <h2 className="display sb-title" title={s.name}>{s.name}</h2>
            </div>
            <div className="sb-bar-meta">
              {s.category && <span className="sb-cat" style={{ "--cat": STRAT_CATEGORIES[s.category].color } as React.CSSProperties}>{STRAT_CATEGORIES[s.category].label}</span>}
              {s.status && <span className={`sb-status ${s.status}`}>{STRAT_STATUS[s.status]}</span>}
              {s.type !== "other" && <span className={`sb-type ${s.type}`}>{STRAT_TYPES[s.type]}</span>}
              <span className="sb-bar-sub" title={meta}>{meta}</span>
              {s.tags.map((t) => <span key={t} className="mlab">#{t}</span>)}
            </div>
          </div>
          <div className="sb-bar-tools sb-noprint">
            <Button size="sm" variant={board ? "primary" : undefined} onClick={() => set("board", board ? null : "1")} data-testid="board-toggle"
              title={board ? "Revenir à la lecture" : "Placer les joueurs, les grenades et les déplacements sur la carte"}>
              <Icon name="pen" size={14} />{board ? "Terminer le dessin" : "Dessiner"}</Button>
            {/* écran étroit : icônes seules, le nom reste dans l'infobulle et pour les lecteurs d'écran */}
            <Button size="sm" variant="ghost" onClick={() => downloadText(`strat_${s.map}_${aliasName(s.name)}.cfg`, stratCfg(s))} data-testid="strat-cfg"
              aria-label="Config CS2" title="Config CS2 : fichier .cfg avec les setpos des joueurs et des grenades, pour un serveur privé">
              <Icon name="download" size={14} /><span className="sb-btn-l">Config CS2</span></Button>
            <Button size="sm" variant="ghost" onClick={() => window.print()} aria-label="PDF" title="Imprimer ou enregistrer en PDF">
              <Icon name="print" size={14} /><span className="sb-btn-l">PDF</span></Button>
            <Popover label="Plus d'actions" button={<Icon name="more" />} testId="strat-menu">
              {(close) => <StratMenu s={s} onEdit={() => { close(); setEditing(s.id); }} onDelete={remove} onClose={close} />}
            </Popover>
          </div>
        </header>
        <div className="sb-stage">
          {!map ? <Spinner /> : board ? <StratBoard key={s.id} map={map} strat={s} onSave={save} />
            : <StratMap key={s.id} map={map} strat={s} focus={focus} onFocus={setFocus} />}
        </div>
      </section>
      <StratPanel s={s} tab={tab} onTab={onTab} board={board} focus={focus} onFocus={setFocus} save={save} onEdit={() => setEditing(s.id)} />
      {editing === s.id && (
        <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="dialog panel sb-dlg" role="dialog" aria-label="Modifier la stratégie" onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}>
            <div className="sb-new-head"><h2 className="display">Modifier la stratégie</h2><Button size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label="Fermer">✕</Button></div>
            <EditStrat s={s} onSave={async (p) => { await save(p); setEditing(null); }} onCancel={() => setEditing(null)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Menu « ⋯ » : modifier, round d'origine, supprimer (en deux temps). */
function StratMenu({ s, onEdit, onDelete, onClose }: { s: Strat; onEdit: () => void; onDelete: () => Promise<void>; onClose: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="sb-menu" role="menu">
      <button type="button" role="menuitem" onClick={onEdit}><Icon name="settings" />Modifier</button>
      {s.source && (
        <Link role="menuitem" to={`/matches/${s.source.match_id}/replay/${s.source.round_number}${s.source.tick ? `?t=${s.source.tick}` : ""}`} onClick={onClose}>
          <Icon name="play" />Round d'origine</Link>
      )}
      {confirm ? (
        <div className="sb-menu-confirm">
          <span>Supprimer « {s.name} » ?</span>
          <span className="sb-menu-confirm-actions">
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Non</Button>
            <Button size="sm" variant="danger" onClick={() => void onDelete()}>Supprimer</Button>
          </span>
        </div>
      ) : (
        <button type="button" role="menuitem" className="sb-menu-danger" onClick={() => setConfirm(true)} aria-label="Supprimer la stratégie"><Icon name="trash" />Supprimer</button>
      )}
    </div>
  );
}

function EditStrat({ s, onSave, onCancel }: { s: Strat; onSave: (p: Partial<Strat>) => Promise<void>; onCancel: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(s.name), [type, setType] = useState<StratType>(s.type);
  const [tags, setTags] = useState(s.tags.join(", ")), [desc, setDesc] = useState(s.description);
  const [category, setCategory] = useState<StratCategory | null>(s.category), [status, setStatus] = useState<StratStatus | null>(s.status);
  // toujours 5 lignes de consignes (une par joueur), plus celles déjà saisies au-delà
  const [roles, setRoles] = useState<StratRole[]>(() => [...s.roles, ...Array.from({ length: Math.max(0, 5 - s.roles.length) }, () => ({ player: "", call: "" }))]);
  const [links, setLinks] = useState(s.links.map((l) => l.url).join("\n"));
  const [positions, setPositions] = useState(s.positions);
  const submit = async () => {
    setErr(null);
    try {
      await onSave({
        name, type, category, status, description: desc, positions, tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        // une consigne sans nom garde le numéro de sa ligne : les lignes vides sont retirées ensuite
        roles: roles.map((r, i) => (!r.player.trim() && r.call.trim() ? { ...r, player: `Joueur ${i + 1}` } : r))
          .filter((r) => r.player.trim() || r.call.trim()),
        links: links.split(/\s+/).filter((u) => /^https?:\/\//.test(u)).map((url) => ({ url, label: s.links.find((l) => l.url === url)?.label ?? "" })),
      });
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <form className="sb-edit" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="rf-row">
        <label className="auth-field"><span>Nom</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="auth-field"><span>Type</span>
          <select className="rf-select" value={type} onChange={(e) => setType(e.target.value as StratType)}>{Object.entries(STRAT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="auth-field"><span>Étiquettes</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ex. pistol, anti-eco" /></label>
      </div>
      <div className="rf-row">
        <label className="auth-field"><span>Genre de round (code couleur)</span>
          <select className="rf-select" value={category ?? ""} onChange={(e) => setCategory((e.target.value || null) as StratCategory | null)}>
            <option value="">—</option>{Object.entries(STRAT_CATEGORIES).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</select></label>
        <label className="auth-field"><span>État</span>
          <select className="rf-select" value={status ?? ""} onChange={(e) => setStatus((e.target.value || null) as StratStatus | null)}>
            <option value="">—</option>{Object.entries(STRAT_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      </div>
      <label className="auth-field"><span>Plan (le déroulé, les timings, les appels)</span><textarea className="sb-textarea" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.stopPropagation()} autoFocus={!s.description} /></label>
      <div className="sb-calls-edit" role="group" aria-label="Consignes par joueur">
        <span className="sb-sub-title">Consignes par joueur</span>
        {roles.map((r, i) => (
          <div key={i} className="sb-call-row">
            <input value={r.player} placeholder={`Joueur ${i + 1}`} aria-label={`Joueur ${i + 1}`} maxLength={64} onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setRoles(roles.map((x, k) => (k === i ? { ...x, player: e.target.value } : x)))} />
            <textarea value={r.call} placeholder="sa consigne : où il va, ce qu'il lance, quand" aria-label={`Consigne du joueur ${i + 1}`} maxLength={600} rows={2}
              onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setRoles(roles.map((x, k) => (k === i ? { ...x, call: e.target.value } : x)))} />
          </div>
        ))}
      </div>
      <label className="auth-field"><span>Références (une adresse par ligne : démo, replay, clip)</span>
        <textarea className="sb-textarea sb-textarea-sm" value={links} onChange={(e) => setLinks(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="https://…" /></label>
      {!!positions.length && (
        <div className="sb-roles">
          {positions.map((p, i) => (
            <label key={i} className="auth-field"><span>{i + 1}. {p.name} — rôle</span>
              <input value={p.role} onChange={(e) => setPositions(positions.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)))} placeholder="ex. entry, support" /></label>
          ))}
        </div>
      )}
      {err && <p className="auth-error" role="alert">{err}</p>}
      <div className="lib-tools sb-edit-actions"><Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button><Button type="submit" variant="primary" size="sm">Enregistrer</Button></div>
    </form>
  );
}
