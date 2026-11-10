import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { StratSummary } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { STRAT_CATEGORIES, STRAT_TYPES } from "./strat";

/** Colonne de gauche du stratbook : les stratégies de la carte choisie, en deux groupes T et CT. Une ligne = camp, nom,
 *  type (sauf « Autre »), nombre de grenades ; la ligne choisie est surlignée. Changer de ligne ne change que `s` dans
 *  l'adresse (même page). */
export function StratList({ list, selectedId, mapLabel, onNew, filters }: {
  list: StratSummary[]; selectedId: number | undefined; mapLabel: string; onNew: () => void; filters?: ReactNode;
}) {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const body = useRef<HTMLDivElement>(null);
  // la ligne choisie au clavier (↑ ↓) reste visible dans la colonne
  useEffect(() => { body.current?.querySelector(".sb-row.on")?.scrollIntoView({ block: "nearest" }); }, [selectedId]);
  const href = (id: number) => {
    const p = new URLSearchParams(params);
    p.set("s", String(id)); p.delete("board");
    return `?${p}`;
  };
  const prefetch = (id: number) => void qc.prefetchQuery({ queryKey: ["strat", id], queryFn: () => api.strat(id) });
  const groups = (["T", "CT"] as const).map((sd) => ({ side: sd, items: list.filter((s) => s.side === sd) })).filter((g) => g.items.length);
  return (
    <aside className="panel sb-col sb-listcol" aria-label={`Stratégies · ${mapLabel}`}>
      <div className="sb-col-in">
        <div className="sb-list-head sb-noprint">
          <Button size="sm" onClick={onNew} data-testid="new-strat"><Icon name="plus" size={14} />Nouvelle stratégie</Button>
          {filters}
        </div>
        <div className="sb-col-body sb-list-body" ref={body}>
          {groups.map((g) => (
            <section key={g.side} className="sb-rgroup" aria-label={g.side === "T" ? "Stratégies T" : "Stratégies CT"}>
              <h3 className={`sb-rgroup-title ${g.side.toLowerCase()}`}><b>{g.side}</b><span className="mono">{g.items.length}</span></h3>
              <ul>
                {g.items.map((s) => {
                  const on = s.id === selectedId;
                  return (
                    <li key={s.id}>
                      <Link to={href(s.id)} replace className={`sb-row ${on ? "on" : ""}`} aria-current={on ? "true" : undefined}
                        data-testid="strat-row" onMouseEnter={() => prefetch(s.id)} title={s.name}>
                        <i className={`sb-row-dot ${s.side.toLowerCase()}`} aria-hidden="true"
                          style={s.category ? { background: STRAT_CATEGORIES[s.category].color } : undefined} />
                        <span className="sb-row-main">
                          <span className="sb-row-name">{s.name}</span>
                          <span className="sb-row-meta">
                            {s.category ? <span className="sb-row-type">{STRAT_CATEGORIES[s.category].label}</span>
                              : s.type !== "other" && <span className="sb-row-type">{STRAT_TYPES[s.type]}</span>}
                            {s.status === "wip" && <span className="sb-row-wip">à travailler</span>}
                            {s.counts.grenades > 0 && (
                              <span className="sb-row-n mono" title={`${s.counts.grenades} grenade${s.counts.grenades > 1 ? "s" : ""}`}>
                                <Icon name="grenade" size={12} />{s.counts.grenades}</span>
                            )}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        {list.length > 1 && <p className="st-legend sb-list-foot sb-noprint"><kbd>↑</kbd><kbd>↓</kbd> changer de stratégie</p>}
      </div>
    </aside>
  );
}
