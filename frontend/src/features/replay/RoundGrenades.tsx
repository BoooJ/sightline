import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { GrenadeType, Side } from "../../shared/api/types";
import { usePlaceAt } from "../../shared/callouts";
import { downloadText, lineupCfg, lineupPackCfg } from "../../shared/practiceCfg";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Copy, NADE } from "../grenades/GrenadesPage";
import { AddLineupToStrat } from "../stratbook/AddToStratbook";
import { roundGrenades, type RoundNade } from "./roundNades";
import "../grenades/grenades.css";

const KINDS: { key: string; label: string; types: GrenadeType[] }[] = [
  { key: "smoke", label: "Smoke", types: ["smoke"] }, { key: "flash", label: "Flash", types: ["flash"] },
  { key: "molotov", label: "Molotov", types: ["molotov", "incendiary"] }, { key: "he", label: "HE", types: ["he"] },
];

/** place occupée sur le radar : largeur de .rp-nades (340 px) et sa marge droite (--sp-3) */
export const NADES_PANEL_PX = 352;

interface Props {
  matchId: number; map: string; round: number; tickrate: number; focus: number | null;
  /** grenade choisie (null : aucune) et instant où placer la lecture */
  onFocus: (id: number | null, tick?: number) => void;
  onClose: () => void;
}

/** Grenades lancées pendant le round, avec leur lineup (setpos, config CS2, stratbook) et leur fréquence dans la bibliothèque. */
export function RoundGrenades({ matchId, map, round, tickrate, focus, onFocus, onClose }: Props) {
  const [kinds, setKinds] = useState<string[]>(KINDS.map((k) => k.key));
  const [side, setSide] = useState<Side | null>(null);
  const match = useQuery({ queryKey: ["grenades", map, "match", matchId],
    queryFn: () => api.grenades({ map, match: String(matchId), lineups: "false" }), staleTime: 5 * 60_000 });
  // même requête que la page Grenades (cache partagé) : sert à compter chaque lineup dans la bibliothèque
  const library = useQuery({ queryKey: ["grenades", map], queryFn: () => api.grenades({ map, lineups: "false" }), staleTime: 5 * 60_000 });
  const placeAt = usePlaceAt(map);
  const types = KINDS.filter((k) => kinds.includes(k.key)).flatMap((k) => k.types);
  const items = useMemo(() => roundGrenades(match.data?.throws ?? [], round, { types, side }, library.data?.throws),
    [match.data, library.data, round, types.join(","), side]);  // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (key: string) => {
    const next = kinds.includes(key) ? kinds.filter((k) => k !== key) : [...kinds, key];
    if (next.length) setKinds(next);
  };
  const label = (n: RoundNade) => {
    const to = placeAt(n.t.land);
    return `${n.clock} ${NADE[n.t.type].label} ${n.t.side} · ${n.t.thrower_name}${to ? ` → ${to}` : ""}`;
  };
  const withPos = items.filter((n) => n.t.setpos);

  return (
    <aside className="rp-comments rp-nades" data-testid="round-nades" aria-label={`Grenades du round ${round}`}>
      <div className="rp-comments-head">
        <h2 className="section-title">Grenades · Round {round}</h2>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Fermer les grenades">✕</button>
      </div>
      <div className="rg-filters">
        {KINDS.map((k) => (
          <button key={k.key} type="button" className={`pill ${kinds.includes(k.key) ? "on" : ""}`} aria-pressed={kinds.includes(k.key)}
            onClick={() => toggle(k.key)}>{k.label}</button>
        ))}
        <span className="rg-sep" />
        {(["CT", "T"] as Side[]).map((sd) => (
          <button key={sd} type="button" className={`pill ${side === sd ? "on" : ""}`} aria-pressed={side === sd}
            onClick={() => setSide(side === sd ? null : sd)}>{sd}</button>
        ))}
      </div>
      <div className="rg-pack">
        <span className="st-legend">{items.length} grenade{items.length > 1 ? "s" : ""}</span>
        <button type="button" className="btn btn-sm" data-testid="round-nades-pack" disabled={!withPos.length}
          title="Config CS2 : un alias lineup_N par grenade affichée (serveur avec sv_cheats 1)"
          onClick={() => downloadText(`lineups_${map}_r${round}.cfg`,
            lineupPackCfg(map, withPos.map((n) => ({ type: n.t.type, setpos: n.t.setpos!, label: label(n) }))))}>
          <Icon name="download" />Pack .cfg du round</button>
      </div>
      {match.isLoading ? <Spinner /> : !items.length ? <p className="st-legend">Aucune grenade pour ces filtres.</p> : (
        <ul className="rg-list">
          {items.map((n) => {
            const on = focus === n.t.id, from = placeAt(n.t.throw), to = placeAt(n.t.land);
            return (
              <li key={n.t.id} className={on ? "on" : ""}>
                <button type="button" className="rg-item" data-testid="round-nade" aria-expanded={on}
                  onClick={() => onFocus(on ? null : n.t.id, on ? undefined : n.t.throw_tick - 2 * tickrate)}>
                  <span className="rg-clock mono">{n.clock}</span>
                  <span className="gr-dot" style={{ background: NADE[n.t.type].color }} />
                  <span className="rg-main">
                    <span><b>{NADE[n.t.type].label}</b> <span className={`gr-side ${n.t.side === "CT" ? "gr-ct" : "gr-t"}`}>{n.t.side}</span> {n.t.thrower_name}</span>
                    {(from || to) && <small className="rg-where">{from && to ? `${from} → ${to}` : from ? `depuis ${from}` : `→ ${to}`}</small>}
                  </span>
                  {n.seen !== null && <span className="rg-seen mono" title="Lancers du même lineup dans la bibliothèque (celui-ci compris)">
                    {n.seen > 1 ? `×${n.seen}` : "unique"}</span>}
                </button>
                {on && <Detail n={n} map={map} />}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function Detail({ n, map }: { n: RoundNade; map: string }) {
  const t = n.t;
  return (
    <div className="rg-detail" data-testid="round-nade-detail">
      {t.setpos ? (
        <div className="gr-cmd">
          <span className="rf-label">Position de lancer (console)</span>
          <code className="mono" data-testid="round-nade-setpos">{t.setpos}</code>
          <div className="gr-cmd-actions">
            <Copy text={t.setpos} />
            <button type="button" className="btn btn-sm" data-testid="round-nade-cfg" onClick={() => downloadText(`lineup_${map}_${t.type}.cfg`,
              lineupCfg(map, { type: t.type, setpos: t.setpos!, label: `${NADE[t.type].label} ${t.side} · ${t.thrower_name}` }))}>
              <Icon name="download" />.cfg</button>
            <AddLineupToStrat map={map} side={t.side} grenade={{ type: t.type, player: t.thrower_name, throw: t.throw, land: t.land,
              setpos: t.setpos, trajectory: t.trajectory, timing_s: Math.round(t.time_s), note: "" }} />
          </div>
        </div>
      ) : <p className="st-legend">Angles de vue indisponibles pour ce lancer.</p>}
      <p className="st-legend">
        {n.seen === null ? "Bibliothèque en cours de chargement…"
          : n.seen > 1 ? `Lineup lancé ${n.seen} fois dans la bibliothèque.` : "Lancer unique dans la bibliothèque."}
        {" "}<Link to={`/grenades?map=${encodeURIComponent(map)}&type=${t.type}&side=${t.side}`}>Voir les lineups {NADE[t.type].label} {t.side}</Link>
      </p>
    </div>
  );
}
