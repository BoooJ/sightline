import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { Strat, StratGrenade } from "../../shared/api/types";
import { clockHint, gameClock } from "../../shared/roundTime";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { NADE } from "../grenades/GrenadesPage";
import { NotesPanel } from "../notes/NotesPanel";
import { Rich, useCodewords } from "./Codewords";
import { grenadeOwner, ownerColor } from "./StratMap";
import { STRAT_CATEGORIES, STRAT_STATUS, hostLabel } from "./strat";

export type PanelTab = "plan" | "players" | "grenades" | "notes";
type Save = (p: Partial<Strat>) => Promise<void>;

/** Colonne de droite : Plan · Joueurs · Grenades · Notes de la stratégie choisie. Plan, Joueurs et Grenades restent dans
 *  la page (masqués) pour que l'impression les montre tous les trois. */
export function StratPanel({ s, tab, onTab, board, focus, onFocus, save, onEdit }: {
  s: Strat; tab: PanelTab; onTab: (t: PanelTab) => void; board: boolean;
  focus: number | null; onFocus: (i: number | null) => void; save: Save; onEdit: () => void;
}) {
  // même clé que NotesPanel : une seule requête pour le compte de l'onglet et la liste
  const notes = useQuery({ queryKey: ["notes", { strat: s.id }], queryFn: () => api.notes({ strat: s.id }) });
  const tabs: [PanelTab, string, number | undefined][] = [
    ["plan", "Plan", undefined], ["players", "Joueurs", s.positions.length], ["grenades", "Grenades", s.grenades.length], ["notes", "Notes", notes.data?.length],
  ];
  const panel = (k: PanelTab) => ({ role: "tabpanel", id: `sb-tp-${k}`, "aria-labelledby": `sb-tab-${k}`, hidden: tab !== k, className: `sb-tp sb-tp-${k}` });
  return (
    <aside className="panel sb-col sb-panel" aria-label="Détails de la stratégie">
      <div className="sb-col-in">
        <div className="tabs sb-ptabs sb-noprint" role="tablist" aria-label="Détails de la stratégie">
          {tabs.map(([k, label, n]) => (
            <button key={k} type="button" role="tab" id={`sb-tab-${k}`} aria-selected={tab === k} aria-controls={`sb-tp-${k}`}
              className={`tab ${tab === k ? "on" : ""}`} onClick={() => onTab(k)} data-testid={`sb-tab-${k}`}>
              {label}{!!n && <span className="sb-tab-n mono">{n}</span>}</button>
          ))}
        </div>
        <div className="sb-col-body">
          <div {...panel("plan")}>
            <h3 className="section-title sb-print-title">Plan</h3>
            <Plan s={s} onEdit={onEdit} />
          </div>
          <div {...panel("players")}>
            <h3 className="section-title sb-print-title">Joueurs</h3>
            <Players s={s} board={board} focus={focus} onFocus={onFocus} save={save} />
          </div>
          <div {...panel("grenades")}>
            <h3 className="section-title sb-print-title">Grenades</h3>
            {board ? <GrenadesEdit s={s} save={save} /> : <Grenades key={s.id} s={s} focus={focus} save={save} />}
          </div>
          {tab === "notes" && (
            <div {...panel("notes")}>
              <NotesPanel title="Notes" filter={{ strat: s.id }} draft={{ map: s.map, side: s.side, strat_id: s.id }}
                empty="Aucune note sur cette stratégie. Ce qui a marché, ce qui coince, qui oublie sa smoke…" className="sb-noprint sb-notes" />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Onglet Plan : le genre de round et l'état, le plan, la consigne de chaque joueur (annonces du lexique soulignées) et
 *  les démos ou clips de référence. */
function Plan({ s, onEdit }: { s: Strat; onEdit: () => void }) {
  const words = useCodewords();
  const cat = s.category ? STRAT_CATEGORIES[s.category] : null;
  if (!s.description && !s.roles.length && !s.links.length && !cat && !s.status) return (
    <div className="sb-plan-empty">
      <p className="cm-empty">Pas encore de plan : la consigne de chaque joueur, les timings, les appels.</p>
      <Button size="sm" onClick={onEdit} className="sb-noprint">Modifier</Button>
    </div>
  );
  return (
    <div className="sb-plan">
      {(cat || s.status) && (
        <div className="sb-badges">
          {cat && <span className="sb-cat" style={{ "--cat": cat.color } as React.CSSProperties}>{cat.label}</span>}
          {s.status && <span className={`sb-status ${s.status}`}>{STRAT_STATUS[s.status]}</span>}
        </div>
      )}
      {s.description && <p className="sb-desc"><Rich text={s.description} words={words} /></p>}
      {s.roles.length > 0 && (
        <section className="sb-sub">
          <h4 className="sb-sub-title">Consignes</h4>
          <ol className="sb-calls" data-testid="strat-calls">
            {s.roles.map((r, i) => (
              <li key={i}><b>{r.player || `Joueur ${i + 1}`}</b><span><Rich text={r.call} words={words} /></span></li>
            ))}
          </ol>
        </section>
      )}
      {s.links.length > 0 && (
        <section className="sb-sub">
          <h4 className="sb-sub-title">Références</h4>
          <ul className="sb-links">
            {s.links.map((l, i) => (
              <li key={i}><a href={l.url} target="_blank" rel="noreferrer noopener" title={l.url}><Icon name="play" size={12} />{hostLabel(l)}</a></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Players({ s, board, focus, onFocus, save }: { s: Strat; board: boolean; focus: number | null; onFocus: (i: number | null) => void; save: Save }) {
  const nades = (i: number) => s.grenades.filter((g) => grenadeOwner(s, g.player) === i).length;
  return (
    <>
      <ol className="sb-list">
        {s.positions.map((p, i) => board ? (
          <li key={`${i}-${p.name}`} className="sb-editrow"><b className="mono">{i + 1}</b>
            <input defaultValue={p.name} aria-label={`Nom du joueur ${i + 1}`} onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => e.target.value !== p.name && save({ positions: s.positions.map((x, k) => (k === i ? { ...x, name: e.target.value.slice(0, 64) } : x)) })} />
            <input defaultValue={p.role} placeholder="rôle" aria-label={`Rôle du joueur ${i + 1}`} onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => e.target.value !== p.role && save({ positions: s.positions.map((x, k) => (k === i ? { ...x, role: e.target.value.slice(0, 64) } : x)) })} />
          </li>
        ) : (
          <li key={i} className={focus !== null && focus !== i ? "sb-faded" : undefined}>
            <button type="button" className={`sb-pick ${focus === i ? "on" : ""}`} aria-pressed={focus === i} data-testid="strat-player"
              onClick={() => onFocus(focus === i ? null : i)} title="Voir seulement ce joueur sur la carte">
              <b className="mono">{i + 1}</b>
              <i className="sb-pdot" style={{ background: ownerColor(s, i) ?? "var(--line-strong)" }} />
              <span className="sb-pick-name">{p.name || "—"}{p.role && <span className="rf-dim"> · {p.role}</span>}</span>
              {nades(i) > 0 && <span className="sb-pick-n mono" title={`${nades(i)} grenade${nades(i) > 1 ? "s" : ""}`}><Icon name="grenade" size={12} />{nades(i)}</span>}
            </button>
          </li>
        ))}
      </ol>
      {!s.positions.length && <p className="cm-empty">Aucune position.{board ? " Outil « Joueur » : cliquez sur la carte." : " « Dessiner » pour placer les joueurs."}</p>}
      {!board && s.positions.length > 0 && <p className="st-legend sb-tp-hint sb-noprint">Un clic sur un joueur, ici ou sur la carte, ne montre que son tracé et ses grenades.</p>}
    </>
  );
}

type Group = { key: string; owner: number | null; name: string; color: string | null; items: [StratGrenade, number][] };

/** Grenades groupées par lanceur (dans l'ordre des joueurs), chaque groupe repliable ; numéros = ceux de la carte. */
function Grenades({ s, focus, save }: { s: Strat; focus: number | null; save: Save }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const all = s.grenades.map((g, i) => [g, i] as [StratGrenade, number]);
  const owned = s.positions.map((p, i): Group => ({ key: `p${i}`, owner: i, name: p.name || `Joueur ${i + 1}`, color: ownerColor(s, i),
    items: all.filter(([g]) => grenadeOwner(s, g.player) === i) }));
  // lanceurs qui ne sont pas parmi les positions (lineup ajouté depuis la page Grenades, joueur renommé…)
  const rest = new Map<string, [StratGrenade, number][]>();
  all.filter(([g]) => grenadeOwner(s, g.player) === null).forEach((x) => rest.set(x[0].player, [...(rest.get(x[0].player) ?? []), x]));
  const groups = [...owned, ...[...rest].map(([name, items]): Group => ({ key: `x${name}`, owner: null, name: name || "Sans lanceur", color: null, items }))]
    .filter((g) => g.items.length);
  const toggle = (k: string) => setClosed((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div className="sb-ngroups" data-testid="strat-grenades">
      {groups.map((gr) => {
        const open = !closed.has(gr.key) || (focus !== null && gr.owner === focus);
        const faded = focus !== null && gr.owner !== focus;
        return (
          <section key={gr.key} className="sb-ngroup">
            <button type="button" className={`sb-ngroup-head ${faded ? "sb-faded" : ""}`} aria-expanded={open} onClick={() => toggle(gr.key)}>
              <Icon name="down" size={14} />
              <i className="sb-pdot" style={{ background: gr.color ?? "var(--line-strong)" }} />
              <span className="sb-ngroup-name">{gr.name}</span>
              <span className="mono rf-dim">{gr.items.length}</span>
            </button>
            <ol className="sb-list sb-nlist" hidden={!open}>
              {gr.items.map(([g, i]) => (
                <li key={i} className={faded ? "sb-faded" : undefined}>
                  <b className="mono">{i + 1}</b>
                  <span className="sb-nade"><i className="sc-dot" style={{ background: NADE[g.type]?.color }} />{NADE[g.type]?.label ?? g.type}</span>
                  {g.timing_s != null && <span className="sb-clock mono" title={clockHint(g.timing_s)}>{gameClock(g.timing_s)}</span>}
                  <span className="sb-g-actions sb-noprint">
                    {g.setpos && <Button size="sm" variant="ghost" title={g.setpos} onClick={() => navigator.clipboard?.writeText(g.setpos!)}>setpos</Button>}
                    <Button size="sm" variant="ghost" aria-label={`Retirer la grenade ${i + 1}`} onClick={() => save({ grenades: s.grenades.filter((_, k) => k !== i) })}><Icon name="trash" size={14} /></Button>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
      {!s.grenades.length && <p className="cm-empty">Aucune grenade. Outil « Grenade » du tableau, ou lineups depuis la page Grenades.</p>}
    </div>
  );
}

/** Tableau tactique ouvert : liste à plat, lanceur et moment modifiables. */
function GrenadesEdit({ s, save }: { s: Strat; save: Save }) {
  return (
    <>
      <ol className="sb-list" data-testid="strat-grenades">
        {s.grenades.map((g, i) => (
          <li key={i}>
            <b className="mono">{i + 1}</b>
            <span className="sb-editrow"><i className="sc-dot" style={{ background: NADE[g.type]?.color }} />{NADE[g.type]?.label ?? g.type}
              <input defaultValue={g.player} placeholder="joueur" aria-label={`Lanceur de la grenade ${i + 1}`} onKeyDown={(e) => e.stopPropagation()}
                onBlur={(e) => e.target.value !== g.player && save({ grenades: s.grenades.map((x, k) => (k === i ? { ...x, player: e.target.value.slice(0, 64) } : x)) })} />
              <input defaultValue={g.timing_s ?? ""} placeholder="s" inputMode="decimal" className="sb-timing" title="Secondes après le début du round (affiché ensuite à l'horloge du jeu)" aria-label={`Moment du lancer de la grenade ${i + 1} (secondes après le début du round)`} onKeyDown={(e) => e.stopPropagation()}
                onBlur={(e) => { const v = e.target.value.trim() === "" ? null : Number(e.target.value.replace(",", ".")); if (v !== g.timing_s && (v === null || Number.isFinite(v))) save({ grenades: s.grenades.map((x, k) => (k === i ? { ...x, timing_s: v } : x)) }); }} />
            </span>
            <span className="sb-g-actions">
              {g.setpos && <Button size="sm" variant="ghost" title={g.setpos} onClick={() => navigator.clipboard?.writeText(g.setpos!)}>setpos</Button>}
              <Button size="sm" variant="ghost" aria-label={`Retirer la grenade ${i + 1}`} onClick={() => save({ grenades: s.grenades.filter((_, k) => k !== i) })}><Icon name="trash" size={14} /></Button>
            </span>
          </li>
        ))}
      </ol>
      {!s.grenades.length && <p className="cm-empty">Aucune grenade. Outil « Grenade » : glisser du point de lancer jusqu'à l'impact.</p>}
    </>
  );
}
