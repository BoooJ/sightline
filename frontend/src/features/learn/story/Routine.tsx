import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../shared/api/client";
import type { MapMeta, PlayerRoutine, RoutineRef, RoutineStat, Side } from "../../../shared/api/types";
import { Spinner } from "../../../shared/ui/Spinner";
import { RADAR_SIZE, levelForZ, worldToRadar } from "../../replay/engine/coords";
import { NADE_COLORS } from "../../scouting/SpotsRadar";
import { Count, Term } from "../../scouting/scoutUi";
import { CoachPanel } from "./Coach";

/** « Sa routine » : ce que le joueur fait d'habitude en round armé (achat, postes dans le temps, grenades et leur
 *  moment, rotations, lieux de mort), sur cette démo ou sur toutes ses démos de la carte. Chaque ligne mène aux rounds. */

// moments successifs du round : une seule teinte (menthe), du plus clair (le plus tôt) au plus profond — ni camp, ni grenade
const TIME_COLORS = ["#d1fae5", "#84edbe", "#3ad198", "#33a377"];
/** « 1 round sur 9 », « 3 rounds sur 9 ». */
const roundsOf = (c: { k: number; n: number }) => `${c.k} round${c.k > 1 ? "s" : ""} sur ${c.n}`;
const NADE_FR: Record<string, string> = { smoke: "Smoke", flash: "Flash", he: "HE", molotov: "Molotov", incendiary: "Molotov", decoy: "Leurre" };

function Refs({ refs, onRound }: { refs?: RoutineRef[]; onRound: (r: RoutineRef) => void }) {
  if (!refs?.length) return null;
  return (
    <span className="rt-refs">
      {refs.map((r) => (
        <button key={`${r.match_id}-${r.number}`} type="button" className={`ts-round ${r.won ? "w" : "l"}`} onClick={() => onRound(r)}
          title={`Round ${r.won ? "gagné" : "perdu"} — voir ce round étape par étape`}>R{r.number}<span className="sr-only">{r.won ? " gagné" : " perdu"}</span></button>
      ))}
    </span>
  );
}

function Row({ label, s, onRound, extra }: { label: React.ReactNode; s: RoutineStat; onRound: (r: RoutineRef) => void; extra?: React.ReactNode }) {
  return (
    <li>
      <span>{label}{extra}</span>
      <Count s={s} mode="simple" of="rounds sur" />
      <Refs refs={s.refs} onRound={onRound} />
    </li>
  );
}

function RoutineMap({ map, r }: { map: MapMeta; r: PlayerRoutine }) {
  const multi = map.levels.length > 1;
  const pts = [...r.times.flatMap((t, i) => (t.places[0]?.pos ? [{ pos: t.places[0].pos, i }] : [])), ...r.nades.flatMap((n) => (n.pos ? [{ pos: n.pos, i: -1 }] : []))];
  const [level, setLevel] = useState(() => (multi && pts[0] ? levelForZ(map, pts[0].pos[2]) : map.levels[0]?.name ?? ""));
  const onLevel = (z: number) => !multi || levelForZ(map, z) === level;
  const view = useMemo(() => {
    const rp = pts.map((p) => worldToRadar(map, p.pos[0], p.pos[1]));
    if (!rp.length) return { x: 0, y: 0, s: RADAR_SIZE };
    const xs = rp.map((p) => p[0]), ys = rp.map((p) => p[1]);
    const s = Math.min(RADAR_SIZE, Math.max(420, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.5);
    return { s, x: (Math.min(...xs) + Math.max(...xs)) / 2 - s / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 - s / 2 };
  }, [map, r]);  // eslint-disable-line react-hooks/exhaustive-deps
  const k = (2 * view.s) / RADAR_SIZE;
  const image = map.levels.find((l) => l.name === level)?.image ?? map.image;
  const P = (x: number, y: number) => worldToRadar(map, x, y);
  const route = r.times.map((t) => t.places[0]?.pos).filter((p) => p && onLevel(p[2])).map((p) => P(p![0], p![1]).join(",")).join(" ");
  return (
    <div className="rt-map">
      {multi && (
        <div className="map-pills" role="group" aria-label="Niveau">
          {map.levels.map((l) => <button key={l.name} type="button" className={`pill ${level === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>
            {l.name === "lower" ? "Bas" : l.name === "upper" ? "Haut" : l.name}</button>)}
        </div>
      )}
      <svg viewBox={`${view.x} ${view.y} ${view.s} ${view.s}`} className="sy-svg rt-svg" data-testid="routine-map" role="img" aria-label="Sa routine sur la carte">
        <image href={`/maps/${image}`} width={RADAR_SIZE} height={RADAR_SIZE} />
        <polyline points={route} fill="none" stroke="#fff" strokeOpacity={0.5} strokeWidth={2.5 * k} strokeDasharray={`${6 * k} ${4 * k}`} />
        {(() => { const placed: [number, number][] = []; return r.nades.filter((n) => n.pos && onLevel(n.pos[2])).map((n, i) => {
          const [x, y] = P(n.pos![0], n.pos![1]);
          // étiquette seulement si aucune autre n'est déjà écrite tout près (sinon les textes s'empilent) ; détail au survol
          const free = !placed.some(([px, py]) => Math.abs(px - x) < 70 * k && Math.abs(py - y) < 26 * k);
          if (free) placed.push([x, y]);
          return (
            <g key={`n${i}`}>
              <circle cx={x} cy={y} r={11 * k} fill={NADE_COLORS[NADE_FR[n.type]] ?? "#fff"} fillOpacity={0.55} stroke="#000" strokeWidth={1.2 * k} />
              {free && <text x={x} y={y + 22 * k} textAnchor="middle" fontSize={9 * k} className="sy-plabel">{NADE_FR[n.type]} {n.clock}</text>}
              <title>{`${NADE_FR[n.type]} vers ${n.place}, vers ${n.clock} (${roundsOf(n.count)})`}</title>
            </g>
          );
        }); })()}
        {r.times.map((t, i) => {
          const p = t.places[0];
          if (!p?.pos || !onLevel(p.pos[2])) return null;
          const [x, y] = P(p.pos[0], p.pos[1]);
          return (
            <g key={t.t} data-testid="routine-spot">
              <circle cx={x} cy={y} r={14 * k} fill={TIME_COLORS[i]} stroke="#000" strokeWidth={1.5 * k} />
              <text x={x} y={y + 4.5 * k} textAnchor="middle" fontSize={11 * k} className="sy-num">{t.clock}</text>
              <title>{`À ${t.clock} : ${p.place} (${roundsOf(p.count)})`}</title>
            </g>
          );
        })}
      </svg>
      <p className="rt-legend">
        {r.times.map((t, i) => <span key={t.t}><i style={{ background: TIME_COLORS[i] }} />{t.clock}</span>)}
        <span><i className="rt-nade" /> grenades (point d'arrivée, moment habituel)</span>
      </p>
    </div>
  );
}

export function Routine({ matchId, steamid, side, map, onRound }: { matchId: number; steamid: string; side: Side; map: MapMeta; onRound: (r: RoutineRef) => void }) {
  const [scope, setScope] = useState<"match" | "map">("match");
  const [armed, setArmed] = useState(true);
  const q = useQuery({ queryKey: ["routine", matchId, steamid, side, scope, armed], queryFn: () => api.routine(matchId, steamid, side, scope, armed) });
  const r = q.data;
  return (
    <div className="sy-main rt" data-testid="routine">
      {q.isLoading || !r ? <div className="sy-body"><Spinner /></div> : <RoutineMap map={map} r={r} />}
      <aside className="sy-panel">
        <div className="rt-head">
          <h2 className="sy-h">Sa routine {side === "CT" ? "en défense (CT)" : "en attaque (T)"}</h2>
          <div className="map-pills" role="group" aria-label="Démos prises en compte">
            <button type="button" className={`pill ${scope === "match" ? "on" : ""}`} onClick={() => setScope("match")}>Cette démo</button>
            <button type="button" className={`pill ${scope === "map" ? "on" : ""}`} onClick={() => setScope("map")} data-testid="routine-scope-map">Toutes ses démos ici</button>
          </div>
          <label className="rt-armed"><input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} /> <Term k="gun">Rounds armés</Term> seulement</label>
        </div>
        {r && (
          r.rounds === 0 ? <p className="cm-empty">Aucun round {armed ? "armé " : ""}dans ce camp.</p> : <>
            <CoachPanel request={{ kind: "routine", match: matchId, steamid, side, scope }} label="Comment jouer ce poste comme lui"
              intro="Un guide simple tiré de sa routine : achat, placement, grenades et timings." />
            <p className="rt-sum">Sur <b>{r.rounds} round{r.rounds > 1 ? "s" : ""}</b>{r.matches > 1 ? ` (${r.matches} démos)` : ""} : gagnés <Count s={r.won} mode="simple" /></p>
            <section><h3 className="ts-h3">Son équipement</h3>
              <ul className="ts-list" data-testid="routine-buys">{r.buys.map((b) => <li key={b.buy}><span>{b.kind === "item" ? "Achète " : "Joue "}<b>{b.buy}</b></span><span><Count s={b.count} mode="simple" of="rounds sur" />{b.unused && b.unused.n > 0 && <small className="st-legend"> · non lancée {b.unused.k}/{b.unused.n}</small>}</span></li>)}</ul></section>
            <section><h3 className="ts-h3">Où il est</h3>
              <ul className="ts-list" data-testid="routine-times">
                {r.times.map((t, i) => t.places[0] && (
                  <Row key={t.t} s={t.places[0].count} onRound={onRound}
                    label={<><i className="rt-dot" style={{ background: TIME_COLORS[i] }} /><b className="mono">{t.clock}</b> à <b>{t.places[0].place}</b></>}
                    extra={t.places[1] ? <small className="st-legend rt-alt"> · sinon {t.places[1].place} ({t.places[1].count.k})</small> : null} />
                ))}
              </ul></section>
            <section><h3 className="ts-h3">Ses grenades</h3>
              {r.nades.length ? (
                <ul className="ts-list" data-testid="routine-nades">
                  {r.nades.map((n) => (
                    <Row key={`${n.type}-${n.place}`} s={n.count} onRound={onRound}
                      label={<><i className="sc-dot" style={{ background: NADE_COLORS[NADE_FR[n.type]] }} /><b>{NADE_FR[n.type] ?? n.type}</b> vers <b>{n.place}</b></>}
                      extra={<small className="st-legend"> · vers <b className="mono">{n.clock}</b>{n.early_clock !== n.late_clock ? ` (entre ${n.early_clock} et ${n.late_clock})` : ""}{n.from[0] ? ` depuis ${n.from[0]}` : ""}</small>} />
                  ))}
                </ul>
              ) : <p className="cm-empty">Pas de grenade récurrente.</p>}</section>
            {!!r.rotations.length && <section><h3 className="ts-h3">Ses rotations</h3>
              <ul className="ts-list">{r.rotations.map((x) => <Row key={x.place} s={x.count} onRound={onRound} label={<>Part vers <b>{x.place}</b></>} />)}</ul></section>}
            {!!r.deaths.length && <section><h3 className="ts-h3">Où il meurt</h3>
              <ul className="ts-list">{r.deaths.map((x) => <Row key={x.place} s={x.count} onRound={onRound} label={<b>{x.place}</b>} />)}</ul></section>}
          </>
        )}
      </aside>
    </div>
  );
}
