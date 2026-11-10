import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import { useUrlParams } from "../../shared/useUrlParams";
import type { GrenadeThrow, GrenadeType, MapMeta } from "../../shared/api/types";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { RADAR_SIZE, levelForZ, worldToRadar } from "../replay/engine/coords";
import { cluster, type Group } from "./cluster";
import { findCombos, type Combo } from "./combos";
import { DemoSelect } from "../library/DemoSelect";
import { downloadText, lineupCfg, lineupPackCfg } from "../../shared/practiceCfg";
import { AddLineupToStrat } from "../stratbook/AddToStratbook";
import { usePlaceAt } from "../../shared/callouts";
import "./grenades.css";
import { gameClock } from "../../shared/roundTime";

export const NADE: Record<GrenadeType, { label: string; color: string }> = {
  smoke: { label: "Smoke", color: "var(--smoke)" }, flash: { label: "Flash", color: "var(--flash)" },
  he: { label: "HE", color: "var(--he)" }, molotov: { label: "Molotov", color: "var(--fire)" },
  incendiary: { label: "Incendiaire", color: "var(--fire)" }, decoy: { label: "Leurre", color: "var(--fg-2)" },
};
const TYPE_ORDER: GrenadeType[] = ["smoke", "flash", "he", "molotov", "incendiary", "decoy"];

export function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="btn btn-sm gr-copy" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* presse-papiers refusé */ }
    }}>{ok ? "Copié ✓" : "Copier"}</button>
  );
}

export function GrenadesPage() {
  const [params, set] = useUrlParams();
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const matches = useQuery({ queryKey: ["matches", "", ""], queryFn: () => api.matches() });
  // carte par défaut : la plus jouée de la bibliothèque
  const defaultMap = useMemo(() => {
    const n: Record<string, number> = {};
    matches.data?.forEach((m) => { n[m.map_name] = (n[m.map_name] ?? 0) + 1; });
    return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [matches.data]);
  const mapName = params.get("map") ?? defaultMap;
  const map = maps.data?.find((m) => m.name === mapName);
  const types = (params.get("type")?.split(",").filter(Boolean) ?? ["smoke"]) as GrenadeType[];
  const side = params.get("side") ?? undefined, team = params.get("team") ?? undefined, player = params.get("player") ?? undefined;
  const mode = params.get("mode") === "throws" ? "throws" : params.get("mode") === "combos" ? "combos" : "lineups";
  const [level, setLevel] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const data = useQuery({ queryKey: ["grenades", mapName], queryFn: () => api.grenades({ map: mapName, lineups: "false" }), enabled: !!mapName });
  useEffect(() => { setLevel(null); setSelected(null); }, [mapName]);
  const lvl = level ?? map?.levels[0]?.name ?? "";

  const matchId = params.get("match") ?? undefined;
  const all = (data.data?.throws ?? []).filter((t) => !matchId || String(t.match_id) === matchId);
  const filtered = all.filter((t) => types.includes(t.type) && (!side || t.side === side) && (!team || String(t.team_id) === team)
    && (!player || t.thrower === player) && (!map || !t.land || map.levels.length < 2 || levelForZ(map, t.land[2]) === lvl));
  const placeAt = usePlaceAt(mapName);
  // combinaisons : toutes les grenades de l'équipe (type, joueur et niveau ignorés), filtrées par camp, équipe et démo
  const comboThrows = useMemo(() => all.filter((t) => (!side || t.side === side) && (!team || String(t.team_id) === team)),
    [data.data, matchId, side, team]);  // eslint-disable-line react-hooks/exhaustive-deps
  const combos = useMemo(() => (mode === "combos" ? findCombos(comboThrows) : []), [comboThrows, mode]);
  const [comboKey, setComboKey] = useState<string | null>(null);
  const [comboHover, setComboHover] = useState<string | null>(null);
  useEffect(() => { setComboKey(null); }, [mapName, side, team, matchId]);
  const combo = combos.find((c) => c.key === comboKey) ?? null;
  const shownCombo = combo ?? combos.find((c) => c.key === comboHover) ?? combos[0] ?? null;
  const comboGroups = useMemo((): Group[] => (shownCombo ? shownCombo.items.map((it, i) => ({
    key: `c${i}`, type: it.type, side: shownCombo.side, throw: it.sample.throw, land: it.land, trajectory: it.sample.trajectory,
    throws: shownCombo.rounds.map((r) => r.throws[i]), players: [] })) : []), [shownCombo]);
  const groups = useMemo(() => (mode === "combos" ? [] : mode === "lineups" ? cluster(filtered)
    : filtered.filter((t) => t.land).map((t): Group => ({ key: `t${t.id}`, type: t.type, side: t.side, throw: t.throw, land: t.land!, trajectory: t.trajectory, throws: [t], players: [t.thrower_name] }))),
  [filtered, mode]);  // eslint-disable-line react-hooks/exhaustive-deps
  const sel = groups.find((g) => g.key === selected) ?? null;
  const teams = [...new Map(all.map((t) => [t.team_id, t.team])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const players = [...new Map(all.filter((t) => !team || String(t.team_id) === team).map((t) => [t.thrower, t.thrower_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const counts = Object.fromEntries(TYPE_ORDER.map((ty) => [ty, all.filter((t) => t.type === ty && (!side || t.side === side)
    && (!team || String(t.team_id) === team) && (!player || t.thrower === player)).length]));
  const toggleType = (ty: GrenadeType) => {
    const s = new Set(types); s.has(ty) ? s.delete(ty) : s.add(ty);
    set("type", s.size ? [...s].join(",") : "smoke");
  };

  return (
    <div className="gr">
      <aside className="gr-filters">
        <div className="eyebrow">Cartes</div>
        <h1 className="display gr-title">Grenades</h1>
        <div className="rf-group">
          <span className="rf-label">Carte</span>
          <select className="rf-select" value={mapName ?? ""} onChange={(e) => set({ map: e.target.value, match: null, team: null, player: null })} aria-label="Carte">
            {maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}
          </select>
        </div>
        {mode !== "combos" && <div className="rf-group">
          <span className="rf-label">Type</span>
          <div className="gr-types" role="group" aria-label="Type de grenade">
            {TYPE_ORDER.map((ty) => (
              <button key={ty} type="button" className={`gr-type ${types.includes(ty) ? "on" : ""}`} onClick={() => toggleType(ty)}
                style={{ ["--c" as string]: NADE[ty].color }}>
                <i />{NADE[ty].label}<span className="mono">{counts[ty]}</span>
              </button>
            ))}
          </div>
        </div>}
        <div className="rf-group">
          <span className="rf-label">Camp</span>
          <div className="map-pills" role="group" aria-label="Camp">
            {([undefined, "CT", "T"] as const).map((s) => (
              <button key={s ?? "all"} type="button" className={`pill ${side === s ? "on" : ""} ${s ? `pill-${s.toLowerCase()}` : ""}`} onClick={() => set("side", s)}>{s ?? "Tous"}</button>
            ))}
          </div>
        </div>
        <DemoSelect map={mapName} value={matchId} onChange={(v) => set({ match: v, team: null, player: null })} />
        <label className="rf-group"><span className="rf-label">Équipe</span>
          <select className="rf-select" value={team ?? ""} onChange={(e) => set({ team: e.target.value, player: null })}>
            <option value="">Toutes</option>{teams.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select></label>
        {mode !== "combos" && <label className="rf-group"><span className="rf-label">Joueur</span>
          <select className="rf-select" value={player ?? ""} onChange={(e) => set("player", e.target.value || undefined)}>
            <option value="">Tous</option>{players.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select></label>}
        <div className="rf-group">
          <span className="rf-label">Affichage</span>
          <div className="map-pills" role="group" aria-label="Affichage">
            <button type="button" className={`pill ${mode === "lineups" ? "on" : ""}`} onClick={() => set("mode")}>Lineups</button>
            <button type="button" className={`pill ${mode === "throws" ? "on" : ""}`} onClick={() => set("mode", "throws")}>Tous les lancers</button>
            <button type="button" className={`pill ${mode === "combos" ? "on" : ""}`} onClick={() => set("mode", "combos")} data-testid="mode-combos"
              title="Pattern finder : grenades lancées ensemble par une équipe dans plusieurs rounds">Combinaisons</button>
          </div>
        </div>
        {mode === "combos" && <p className="st-legend">Grenades qu'une équipe lance ensemble (même salve, mêmes zones) dans au moins deux rounds. Choisissez une équipe et un camp pour affiner.</p>}
        {mode === "combos" ? <p className="gr-count mono" data-testid="grenade-count">{combos.length} combinaison(s)</p> : <p className="gr-count mono" data-testid="grenade-count">{groups.length} {mode === "lineups" ? "lineup(s)" : "lancer(s)"} · {filtered.length} lancer(s)</p>}
      </aside>

      <section className="gr-map">
        {map && map.levels.length > 1 && (
          <div className="gr-levels map-pills" role="group" aria-label="Niveau">
            {map.levels.map((l) => <button key={l.name} type="button" className={`pill ${lvl === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>{l.name === "lower" ? "Bas" : l.name === "upper" ? "Haut" : l.name}</button>)}
          </div>
        )}
        {!mapName || data.isLoading || !map ? <Spinner /> : !all.length ? (
          <EmptyState icon="grenade" title="Aucune grenade">Aucun lancer sur cette carte. Importez des démos ou changez de carte.</EmptyState>
        ) : mode === "combos" ? <NadeMap map={map} level={lvl} groups={comboGroups} selected={null} hover={hover} onHover={setHover} onSelect={() => undefined} />
          : <NadeMap map={map} level={lvl} groups={groups} selected={selected} hover={hover} onHover={setHover} onSelect={(k) => setSelected(k === selected ? null : k)} />}
      </section>

      <aside className="gr-detail">
        {mode === "combos" ? (combo ? <ComboDetail c={combo} placeAt={placeAt} onClose={() => setComboKey(null)} /> : (
          <div className="gr-list">
            <div className="gr-list-head"><h2 className="section-title">Combinaisons</h2></div>
            {combos.slice(0, 50).map((c) => (
              <button key={c.key} type="button" className={`gr-item gr-combo ${shownCombo === c ? "hover" : ""}`} data-testid="combo-item"
                onMouseEnter={() => setComboHover(c.key)} onMouseLeave={() => setComboHover(null)} onClick={() => setComboKey(c.key)}>
                <span className="gr-item-main">
                  <ComboItems c={c} placeAt={placeAt} />
                  <small>{c.team} · <span className={c.side === "CT" ? "gr-ct" : "gr-t"}>{c.side}</span> · vers {fmtS(c.time_s)}
                    {c.winRate !== null && <> · {Math.round(c.winRate * 100)} % gagnés</>}</small>
                </span>
                <span className="mono gr-item-n" title="Rounds où la combinaison apparaît">×{c.rounds.length}</span>
              </button>
            ))}
            {!combos.length && <p className="st-legend">Aucune combinaison répétée pour ces filtres.</p>}
          </div>
        )) : sel ? <Detail g={sel} map={mapName ?? ""} onClose={() => setSelected(null)} /> : (
          <div className="gr-list">
            <div className="gr-list-head">
              <h2 className="section-title">{mode === "lineups" ? "Lineups" : "Lancers"}</h2>
              <button type="button" className="btn btn-sm btn-ghost" data-testid="cfg-pack" disabled={!groups.some((x) => x.throws.some((t) => t.setpos))}
                title="Config CS2 : un alias lineup_N par lineup affiché (60 max.)"
                onClick={() => {
                  const ls = groups.slice(0, 60).map((x) => ({ x, t: x.throws.find((t) => t.setpos) })).filter((v) => v.t)
                    .map(({ x, t }) => ({ type: x.type, setpos: t!.setpos!, label: `${NADE[x.type].label} ${x.side} · ${x.players.join(", ")}` }));
                  downloadText(`lineups_${mapName}.cfg`, lineupPackCfg(mapName ?? "", ls));
                }}><Icon name="download" />.cfg</button>
            </div>
            {groups.slice(0, 60).map((g) => (
              <button key={g.key} type="button" className={`gr-item ${hover === g.key ? "hover" : ""}`} data-testid="lineup-item"
                onMouseEnter={() => setHover(g.key)} onMouseLeave={() => setHover(null)} onClick={() => setSelected(g.key)}>
                <i style={{ background: NADE[g.type].color }} />
                <span className="gr-item-main">
                  <span>{NADE[g.type].label} <span className={g.side === "CT" ? "gr-ct" : "gr-t"}>{g.side}</span>
                    {placeAt(g.land) && <span className="gr-where"> → {placeAt(g.land)}</span>}</span>
                  <small>{g.players.slice(0, 3).join(", ")}{g.players.length > 3 ? "…" : ""}</small>
                </span>
                <span className="mono gr-item-n">×{g.throws.length}</span>
              </button>
            ))}
            {!groups.length && <p className="st-legend">Aucun lancer pour ces filtres.</p>}
          </div>
        )}
      </aside>
    </div>
  );
}

const fmtS = gameClock;  // horloge du jeu (1:55 au début du round)

function ComboItems({ c, placeAt }: { c: Combo; placeAt: (p: [number, number, number] | null) => string | null }) {
  return (
    <span className="gr-combo-items">
      {c.items.map((it, i) => (
        <span key={i} className="gr-combo-chip"><i style={{ background: NADE[it.type].color }} />{NADE[it.type].label}
          {placeAt(it.land) && <span className="gr-where"> → {placeAt(it.land)}</span>}</span>
      ))}
    </span>
  );
}

function ComboDetail({ c, placeAt, onClose }: { c: Combo; placeAt: (p: [number, number, number] | null) => string | null; onClose: () => void }) {
  return (
    <div className="gr-sel" data-testid="combo-detail">
      <div className="gr-sel-head">
        <h2 className="display">Combinaison</h2>
        <span className={`gr-side ${c.side === "CT" ? "gr-ct" : "gr-t"}`}>{c.side}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Fermer"><Icon name="back" /></button>
      </div>
      <ComboItems c={c} placeAt={placeAt} />
      <p className="gr-sub">{c.team} · {c.rounds.length} rounds · lancée vers {fmtS(c.time_s)} à l'horloge ({Math.round(c.time_s)} s de jeu)
        {c.winRate !== null && <> · <b>{Math.round(c.winRate * 100)} %</b> de rounds gagnés</>}</p>
      <span className="rf-label">Rounds</span>
      <ul className="gr-occ">
        {c.rounds.map((r) => (
          <li key={`${r.match_id}-${r.round_number}`}>
            <span><b>R{r.round_number}</b> <small>{r.team} vs {r.opponent} · {fmtS(r.time_s)}</small>
              {r.won !== null && <small className={r.won ? "gr-won" : "gr-lost"}> · {r.won ? "gagné" : "perdu"}</small>}</span>
            <Link className="btn btn-sm btn-ghost" title="Voir la salve dans le replay"
              to={`/matches/${r.match_id}/replay/${r.round_number}?t=${Math.max(0, r.tick - 192)}`}><Icon name="play" /></Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Detail({ g, map, onClose }: { g: Group; map: string; onClose: () => void }) {
  const best = g.throws.find((t) => t.setpos) ?? g.throws[0];
  return (
    <div className="gr-sel" data-testid="lineup-detail">
      <div className="gr-sel-head">
        <span className="gr-dot" style={{ background: NADE[g.type].color }} />
        <h2 className="display">{NADE[g.type].label}</h2>
        <span className={`gr-side ${g.side === "CT" ? "gr-ct" : "gr-t"}`}>{g.side}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Fermer"><Icon name="back" /></button>
      </div>
      <p className="gr-sub">{g.throws.length} lancer{g.throws.length > 1 ? "s" : ""} · {g.players.join(", ")}</p>
      {best.setpos ? (
        <div className="gr-cmd">
          <span className="rf-label">Position de lancer (console)</span>
          <code className="mono" data-testid="setpos">{best.setpos}</code>
          <div className="gr-cmd-actions">
            <Copy text={best.setpos} />
            <button type="button" className="btn btn-sm" data-testid="cfg-lineup" onClick={() => downloadText(`lineup_${map}_${g.type}.cfg`,
              lineupCfg(map, { type: g.type, setpos: best.setpos!, label: `${NADE[g.type].label} ${g.side} · ${best.thrower_name}` }))}>
              <Icon name="download" />Config CS2 (.cfg)</button>
            <AddLineupToStrat map={map} side={g.side} grenade={{ type: g.type, player: best.thrower_name, throw: best.throw, land: best.land,
              setpos: best.setpos, trajectory: best.trajectory, timing_s: null, note: "" }} />
          </div>
          <p className="st-legend">Collez dans la console (serveur avec sv_cheats 1) pour vous placer à l'endroit du lancer.</p>
        </div>
      ) : <p className="st-legend">Angles de vue indisponibles pour ce lancer.</p>}
      <span className="rf-label">Occurrences</span>
      <ul className="gr-occ">
        {g.throws.map((t: GrenadeThrow) => (
          <li key={t.id}>
            <span><b>{t.thrower_name}</b> <small>{t.team} vs {t.opponent} · R{t.round_number}</small></span>
            <Link className="btn btn-sm btn-ghost" title="Voir le lancer dans le replay"
              to={`/matches/${t.match_id}/replay/${t.round_number}?t=${Math.max(0, t.throw_tick - 128)}`}><Icon name="play" /></Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NadeMap({ map, level, groups, selected, hover, onHover, onSelect }: {
  map: MapMeta; level: string; groups: Group[]; selected: string | null; hover: string | null;
  onHover: (k: string | null) => void; onSelect: (k: string) => void;
}) {
  const [view, setView] = useState({ x: 0, y: 0, s: RADAR_SIZE });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  // cadrage initial sur la zone des lancers (l'image radar contient beaucoup de vide autour de la carte)
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitted.current === map.name || !groups.length) return;
    fitted.current = map.name;
    const pts = groups.flatMap((g) => [g.throw, g.land]).map((p) => worldToRadar(map, p[0], p[1]));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const s = Math.min(RADAR_SIZE, Math.max(320, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.25);
    setView({ s, x: cx - s / 2, y: cy - s / 2 });
  }, [map, groups]);
  const image = map.levels.find((l) => l.name === level)?.image ?? map.image;
  const P = (v: [number, number, number]) => worldToRadar(map, v[0], v[1]);
  const k = view.s / RADAR_SIZE; // tailles constantes à l'écran quel que soit le zoom
  const focus = selected ?? hover;
  const onWheel = (e: React.WheelEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const fx = view.x + ((e.clientX - r.left) / r.width) * view.s, fy = view.y + ((e.clientY - r.top) / r.height) * view.s;
    const s = Math.min(RADAR_SIZE, Math.max(128, view.s * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
    setView({ s, x: fx - ((fx - view.x) * s) / view.s, y: fy - ((fy - view.y) * s) / view.s });
  };
  return (
    <svg ref={svg} className="gr-svg" viewBox={`${view.x} ${view.y} ${view.s} ${view.s}`} data-testid="nade-map" onWheel={onWheel}
      onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; }}
      onMouseMove={(e) => {
        if (!drag.current) return;
        const r = svg.current!.getBoundingClientRect(), f = view.s / r.width;
        setView((v) => ({ ...v, x: drag.current!.vx - (e.clientX - drag.current!.x) * f, y: drag.current!.vy - (e.clientY - drag.current!.y) * f }));
      }}
      onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}>
      <image href={`/maps/${image}`} x={0} y={0} width={RADAR_SIZE} height={RADAR_SIZE} />
      {groups.map((g) => {
        const on = focus === g.key, dim = !!focus && !on;
        const [lx, ly] = P(g.land), [tx, ty] = P(g.throw);
        const r = Math.min(22, 7 + 2.2 * Math.sqrt(g.throws.length)) * k;
        return (
          <g key={g.key} className={`gr-g ${on ? "on" : ""}`} opacity={dim ? 0.18 : 1} style={{ ["--c" as string]: NADE[g.type].color }}
            onMouseEnter={() => onHover(g.key)} onMouseLeave={() => onHover(null)} onClick={() => onSelect(g.key)}>
            {(on || !focus) && <polyline points={g.trajectory.map((p) => P(p).join(",")).join(" ")} fill="none" stroke="var(--c)"
              strokeOpacity={on ? 0.95 : 0.35} strokeWidth={(on ? 2 : 1.2) * k} strokeDasharray={on ? undefined : `${4 * k} ${3 * k}`} />}
            <circle cx={tx} cy={ty} r={(on ? 5 : 3) * k} fill={g.side === "CT" ? "var(--ct)" : "var(--t)"} stroke="#000" strokeWidth={k} />
            <circle cx={lx} cy={ly} r={r} fill="var(--c)" fillOpacity={0.28} stroke="var(--c)" strokeWidth={(on ? 2.5 : 1.5) * k} />
            {g.throws.length > 1 && <text x={lx} y={ly} dy={3.5 * k} textAnchor="middle" fontSize={10 * k} className="gr-n">{g.throws.length}</text>}
          </g>
        );
      })}
    </svg>
  );
}
