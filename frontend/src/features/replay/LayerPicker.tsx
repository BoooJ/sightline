import { useEffect, useRef, useState } from "react";
import type { MatchDetail } from "../../shared/api/types";
import { Icon } from "../../shared/ui/Icon";
import { BUY_LAYERS, buyOf, matchingRounds, sideOf, type LayerFilter } from "./layerFilter";

const BUY_SHORT: Record<string, string> = { pistol: "pistol", eco: "eco", semi: "semi", force: "force", full: "full" };

/** Choix des rounds à superposer au round affiché (analyse multi-rounds) : à la main, ou d'un coup par filtre (camp,
 *  achat, résultat) du point de vue d'une équipe. */
export function LayerPicker({ match, current, layers, onChange }: {
  match: MatchDetail; current: number; layers: number[]; onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = match.rounds.find((r) => r.number === current);
  const [f, setF] = useState<LayerFilter>({ team: cur?.ct_team_id ?? match.team_a.id, side: "same", buy: null, result: "any" });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const toggle = (id: number) => onChange(layers.includes(id) ? layers.filter((x) => x !== id) : [...layers, id]);
  const matching = matchingRounds(match.rounds, cur, f);
  const matchIds = new Set(matching.map((r) => r.id));
  const filtered = f.side !== "any" || f.buy !== null || f.result !== "any";
  const teamSide = cur ? sideOf(cur, f.team) : null;
  const set = (p: Partial<LayerFilter>) => setF({ ...f, ...p });

  return (
    <div className="pl-menu-wrap" ref={ref}>
      <button type="button" className={`btn btn-sm btn-ghost ${layers.length ? "on" : ""}`} onClick={() => setOpen(!open)}
        title="Superposer d'autres rounds (analyse multi-rounds)" data-testid="layers-toggle">
        <Icon name="layers" />Superposer{layers.length > 0 && <span className="rp-tool-count">{layers.length}</span>}
      </button>
      {open && (
        <div className="pl-menu panel lp-menu" role="dialog" aria-label="Rounds superposés">
          <div className="lp-head">
            <span className="rf-label">Rounds à superposer</span>
            <button type="button" className="pill" onClick={() => onChange([])} disabled={!layers.length}>Aucun</button>
          </div>

          <div className="lp-filters">
            <span className="lp-flabel">Équipe</span>
            <div className="lp-row">
              {[match.team_a, match.team_b].map((t) => (
                <button key={t.id} type="button" className={`pill ${f.team === t.id ? "on" : ""}`} onClick={() => set({ team: t.id })}>{t.name}</button>
              ))}
            </div>
            <span className="lp-flabel">Camp</span>
            <div className="lp-row">
              <button type="button" className={`pill ${f.side === "same" ? "on" : ""}`} onClick={() => set({ side: "same" })}
                title="Rounds où l'équipe joue du même côté qu'au round affiché">{teamSide ? `En ${teamSide}` : "Même camp"}</button>
              <button type="button" className={`pill ${f.side === "any" ? "on" : ""}`} onClick={() => set({ side: "any" })}>Les deux</button>
            </div>
            <span className="lp-flabel">Achat</span>
            <div className="lp-row" data-testid="layer-buys">
              <button type="button" className={`pill ${f.buy === null ? "on" : ""}`} onClick={() => set({ buy: null })}>Tous</button>
              {BUY_LAYERS.map(([k, label]) => (
                <button key={k} type="button" className={`pill ${f.buy === k ? "on" : ""}`} onClick={() => set({ buy: k })}>{label}</button>
              ))}
            </div>
            <span className="lp-flabel">Résultat</span>
            <div className="lp-row">
              {([["any", "Tous"], ["won", "Gagnés"], ["lost", "Perdus"]] as const).map(([k, label]) => (
                <button key={k} type="button" className={`pill ${f.result === k ? "on" : ""}`} onClick={() => set({ result: k })}>{label}</button>
              ))}
            </div>
          </div>
          {/* enveloppé : le style générique des entrées de menu (.pl-menu > button) ne doit pas s'appliquer */}
          <div className="lp-apply-wrap"><button type="button" className="btn btn-sm btn-primary lp-apply" disabled={!matching.length} onClick={() => onChange(matching.map((r) => r.id))}
            data-testid="layers-apply">
            <Icon name="layers" />Superposer {matching.length ? `ces ${matching.length} round${matching.length > 1 ? "s" : ""}` : "(aucun round)"}
          </button></div>

          <div className="lp-grid">
            {match.rounds.filter((r) => r.number !== current).map((r) => (
              <button key={r.id} type="button" data-testid="layer-round" title={`Round ${r.number} · achat ${buyOf(r, f.team)} · ${r.winner_team_id === f.team ? "gagné" : "perdu"}`}
                className={`lp-cell ${r.winner_side === "CT" ? "ct" : r.winner_side === "T" ? "t" : ""} ${layers.includes(r.id) ? "on" : ""} ${filtered && !matchIds.has(r.id) ? "dim" : ""}`}
                aria-pressed={layers.includes(r.id)} onClick={() => toggle(r.id)}>
                {r.number}<small>{BUY_SHORT[buyOf(r, f.team)] ?? ""}</small>
              </button>
            ))}
          </div>
          <p className="st-legend">Achat indiqué pour l'équipe choisie. Les joueurs des rounds choisis apparaissent en fantômes, alignés sur le temps écoulé depuis la fin du freeze time. Depuis la page Rounds, vous pouvez aussi superposer des rounds de plusieurs matchs.</p>
        </div>
      )}
    </div>
  );
}
