import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { MapMeta, Side } from "../../shared/api/types";
import { usePlaceLabel } from "../../shared/callouts";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { levelForZ, RADAR_SIZE, worldToRadar } from "../replay/engine/coords";
import { gameClock } from "../../shared/roundTime";
import { DEFAULT_KIND_LABEL } from "./defaultPhases";

const fmt = gameClock;  // horloge du jeu (1:55 au début du round)

/** Carte des timings : où l'équipe se trouve à chaque instant du round et quand elle arrive dans chaque zone,
 *  par camp ou pour une tactique du playbook. */
export function TimingsSection({ teamId, map }: { teamId: number; map: MapMeta }) {
  const [side, setSide] = useState<Side>("T");
  const [tactic, setTactic] = useState("");
  const [t, setT] = useState(20);
  const [playing, setPlaying] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [level, setLevel] = useState(map.levels[0]?.name ?? "default");
  const place = usePlaceLabel(map.name);
  const pb = useQuery({ queryKey: ["playbook", teamId, map.name], queryFn: () => api.playbook(teamId, map.name) });
  const q = useQuery({ queryKey: ["timings", teamId, map.name, side, tactic], queryFn: () => api.timings(teamId, map.name, side, tactic || undefined),
    placeholderData: (prev) => prev });
  useEffect(() => { setTactic(""); }, [side, map.name]);
  // lecture : avance de 5 s toutes les 700 ms, de 0 à 90 s
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setT((v) => { if (v >= (q.data?.max_s ?? 90)) { setPlaying(false); return v; } return v + 5; }), 700);
    return () => window.clearInterval(id);
  }, [playing, q.data?.max_s]);

  const tactics = !pb.data ? [] : side === "T"
    ? pb.data.t.categories.flatMap((c) => [
      { value: `t:${c.key}`, label: `${c.label} (${c.n})` },
      // fins du default : « t:default::<sous-type> »
      ...(c.key === "default" ? (pb.data!.t.default_kinds ?? []).map((k) => ({ value: `t:default::${k.key}`, label: `Default ${DEFAULT_KIND_LABEL[k.key]} (${k.n})` })) : []),
    ])
    : pb.data.ct.setups.slice(0, 8).map((g) => ({ value: `ct:${g.key}`, label: `Placement ${g.label} (${g.n})` }));
  const d = q.data;
  const onLevel = (z: number) => map.levels.length < 2 || levelForZ(map, z) === level;
  const dots = (d?.slices[String(t)] ?? []).filter((p) => onLevel(p[2]));
  const zones = (d?.zones ?? []).filter((z) => z.pct >= 15);
  const color = side === "CT" ? "var(--ct)" : "var(--t)";
  // cadrage sur les zones et les positions du niveau affiché (la carte occupe rarement tout le radar)
  const pts = [...zones.filter((z) => onLevel(z.pos[2])).map((z) => worldToRadar(map, z.pos[0], z.pos[1])),
    ...Object.values(d?.slices ?? {}).flat().filter((p) => onLevel(p[2])).map((p) => worldToRadar(map, p[0], p[1]))];
  let view = `0 0 ${RADAR_SIZE} ${RADAR_SIZE}`, k = 1;
  if (pts.length > 1) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const size = Math.min(RADAR_SIZE, Math.max(320, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.18);
    view = `${(Math.min(...xs) + Math.max(...xs)) / 2 - size / 2} ${(Math.min(...ys) + Math.max(...ys)) / 2 - size / 2} ${size} ${size}`;
    k = size / RADAR_SIZE;
  }
  // ton de chaque zone : tôt = clair, tard = sombre (une seule teinte, du camp)
  const shade = (s: number) => 0.25 + 0.75 * (1 - Math.min(1, s / (d?.max_s ?? 90)));
  return (
    <div className="tm" data-testid="timings">
      <div className="tm-bar">
        <div className="map-pills" role="group" aria-label="Camp des timings">
          {(["T", "CT"] as const).map((s) => <button key={s} type="button" className={`pill pill-${s.toLowerCase()} ${side === s ? "on" : ""}`} onClick={() => setSide(s)}>{s}</button>)}
        </div>
        <select className="rf-select" value={tactic} onChange={(e) => setTactic(e.target.value)} aria-label="Tactique" data-testid="timings-tactic">
          <option value="">Tous les rounds {side}</option>
          {tactics.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        {map.levels.length > 1 && (
          <div className="map-pills" role="group" aria-label="Niveau">
            {map.levels.map((l) => <button key={l.name} type="button" className={`pill ${level === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>{l.name === "upper" ? "Haut" : l.name === "lower" ? "Bas" : l.name}</button>)}
          </div>
        )}
        <span className="st-legend">{d ? `${d.rounds} round${d.rounds > 1 ? "s" : ""} analysé${d.rounds > 1 ? "s" : ""}` : ""}</span>
      </div>
      {!d ? <Spinner /> : !d.rounds ? <p className="cm-empty">Aucun round {side} avec positions sur cette carte.</p> : (
        <div className="tm-grid">
          <div className="tm-map">
            <svg viewBox={view} className="tm-svg" role="img" aria-label={`Positions de l'équipe à ${fmt(t)}`}>
              <image href={`/maps/${map.levels.find((l) => l.name === level)?.image ?? map.image}`} width={RADAR_SIZE} height={RADAR_SIZE} opacity={0.85} />
              {zones.filter((z) => onLevel(z.pos[2])).map((z) => {
                const [x, y] = worldToRadar(map, z.pos[0], z.pos[1]);
                const reached = z.median_s <= t;
                return (
                  <g key={z.place} className={`tm-zone ${focus === z.place ? "on" : ""}`} onMouseEnter={() => setFocus(z.place)} onMouseLeave={() => setFocus(null)}>
                    <circle cx={x} cy={y} r={30 * k} fill={color} fillOpacity={reached ? 0.18 * shade(z.median_s) + 0.06 : 0.03}
                      stroke={color} strokeOpacity={reached ? 0.9 : 0.35} strokeWidth={(focus === z.place ? 3 : 1.5) * k} strokeDasharray={reached ? undefined : `${6 * k} ${5 * k}`} />
                    <text x={x} y={y - 34 * k} textAnchor="middle" className="tm-zlabel" fontSize={17 * k} strokeWidth={4 * k}>{place(z.place)}</text>
                    <text x={x} y={y + 6 * k} textAnchor="middle" className="tm-ztime" fontSize={15 * k} strokeWidth={4 * k}>{fmt(z.median_s)}</text>
                  </g>
                );
              })}
              {dots.map((p, i) => {
                const [x, y] = worldToRadar(map, p[0], p[1]);
                return <circle key={i} cx={x} cy={y} r={6 * k} fill={color} fillOpacity={0.55} stroke="var(--bg-0)" strokeWidth={k} />;
              })}
            </svg>
            <div className="tm-time">
              <button type="button" className="btn btn-sm" onClick={() => { if (t >= d.max_s) setT(0); setPlaying(!playing); }} aria-label={playing ? "Pause" : "Lecture"}>
                <Icon name={playing ? "pause" : "play"} /></button>
              <input type="range" min={0} max={d.max_s} step={d.slice_s} value={t} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
                aria-label="Instant du round (secondes après le freeze time)" data-testid="timings-slider" />
              <b className="mono tm-clock">{fmt(t)}</b>
            </div>
            <p className="st-legend">Points : joueurs de l'équipe à cet instant, tous rounds confondus. Cercles : zones, avec l'heure d'arrivée médiane ; plein quand l'équipe y est habituellement déjà.</p>
          </div>
          <div className="tm-list">
            <table className="st-table tm-table">
              <thead><tr><th className="sb-name">Zone</th><th title="Rounds où l'équipe passe par cette zone">Rounds</th><th title="Arrivée médiane après le freeze time">Médiane</th>
                <th title="Arrivée la plus rapide">Plus tôt</th><th className="tm-axis-h">Arrivée (moitié des rounds dans la barre)</th></tr></thead>
              <tbody>
                {d.zones.map((z) => (
                  <tr key={z.place} className={focus === z.place ? "tm-focus" : ""} onMouseEnter={() => setFocus(z.place)} onMouseLeave={() => setFocus(null)} data-testid="timing-row">
                    <td className="sb-name">{place(z.place)}</td>
                    <td className="mono">{z.pct.toFixed(0)}%</td>
                    <td className="mono">{fmt(z.median_s)}</td>
                    <td className="mono">{fmt(z.fastest_s)}</td>
                    <td className="tm-axis" title={`${fmt(z.p25_s)} – ${fmt(z.p75_s)} · ${z.players.toFixed(1)} joueur(s) en moyenne`}>
                      <span className="tm-iqr" style={{ left: `${(100 * z.p25_s) / d.max_s}%`, width: `${Math.max(1.5, (100 * (z.p75_s - z.p25_s)) / d.max_s)}%`, background: color }} />
                      <span className="tm-med" style={{ left: `${(100 * z.median_s) / d.max_s}%` }} />
                      <span className="tm-now" style={{ left: `${(100 * t) / d.max_s}%` }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
