import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { CalloutPlace, CustomCallout, MapMeta, Vec3 } from "../../shared/api/types";
import { CUSTOM_RADIUS, humanizePlace } from "../../shared/callouts";
import { useUrlParams } from "../../shared/useUrlParams";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { levelForZ, RADAR_SIZE, worldToRadar } from "../replay/engine/coords";
import { ZonesEditor } from "./ZonesEditor";
import "./callouts.css";

/** Callouts de l'équipe : zones de callouts dessinées sur la carte (onglet Zones), noms d'équipe des lieux du jeu et
 *  callouts placés à la main (onglet Lieux du jeu). Ils remplacent les noms du jeu dans le fil des kills, l'analyse,
 *  les moments forts et le scouting. */
export function CalloutsPage() {
  const [params, set] = useUrlParams();
  const maps = useQuery({ queryKey: ["maps", "all"], queryFn: api.allMaps, staleTime: Infinity });
  // carte par défaut : la première du pool actuel
  const matches = useQuery({ queryKey: ["matches", "", ""], queryFn: () => api.matches() });
  const played = Object.entries((matches.data ?? []).reduce<Record<string, number>>((n, m) => ({ ...n, [m.map_name]: (n[m.map_name] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const map = params.get("map") ?? played ?? maps.data?.find((m) => m.active_duty)?.name ?? maps.data?.[0]?.name;
  const meta = maps.data?.find((m) => m.name === map);
  const view = params.get("view");
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Cartes</div><h1 className="display">Callouts</h1></div>
      </div>
      <p className="st-legend co-intro">{view === "places"
        ? <>Renommez les lieux du jeu, ou placez vos propres callouts où vous voulez sur la carte (« Placer un callout », puis un clic).
            Ils remplacent les noms du jeu dans le fil des kills, l'analyse des matchs et le scouting.</>
        : <>Les zones de callouts de l'équipe : dessinez-les, renommez-les, colorez-les. Elles nomment les positions partout
            (fil des kills, analyses, scouting) ; un callout placé à la main garde la priorité dans son rayon.</>}</p>
      <div className="map-pills co-views" role="tablist" aria-label="Affichage">
        <button type="button" role="tab" aria-selected={view !== "places"} className={`pill ${view !== "places" ? "on" : ""}`} onClick={() => set("view", null)}>Zones</button>
        <button type="button" role="tab" aria-selected={view === "places"} className={`pill ${view === "places" ? "on" : ""}`} onClick={() => set("view", "places")} data-testid="view-places">Lieux du jeu</button>
      </div>
      <div className="lib-filters">
        <div className="map-pills" role="group" aria-label="Carte">
          {maps.data?.map((m) => (
            <button key={m.name} type="button" className={`pill ${map === m.name ? "on" : ""} ${m.active_duty ? "" : "co-reserve"}`} onClick={() => set("map", m.name)}
              title={m.active_duty ? "Pool compétitif actuel" : "Hors du pool actuel"}>{m.display_name}</button>
          ))}
        </div>
      </div>
      {!meta ? <Spinner /> : view === "places" ? <MapCallouts key={meta.name} meta={meta} /> : <ZonesEditor key={meta.name} meta={meta} />}
    </div>
  );
}

function MapCallouts({ meta }: { meta: MapMeta }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["callouts", meta.name], queryFn: () => api.callouts(meta.name) });
  const [focus, setFocus] = useState<string | null>(null);
  const [level, setLevel] = useState(meta.levels[0]?.name ?? "default");
  const [placing, setPlacing] = useState(false);
  const [draft, setDraft] = useState<{ at: [number, number]; value: string } | null>(null);
  const [drag, setDrag] = useState<{ id: number; at: [number, number] } | null>(null);
  const [search, setSearch] = useState("");
  const svgRef = useRef<SVGSVGElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["callouts", meta.name] });
  const places = q.data?.places ?? [], custom = q.data?.custom ?? [];
  const onLevel = (pos: Vec3 | null) => meta.levels.length < 2 || !pos || levelForZ(meta, pos[2]) === level;
  const shown = places.filter((p) => p.pos && onLevel(p.pos)).map((p) => ({ p, xy: worldToRadar(meta, p.pos![0], p.pos![1]) }));
  const mine = custom.filter((c) => onLevel(c.pos)).map((c) => ({ c, xy: worldToRadar(meta, c.pos[0], c.pos[1]) }));
  // cadrage sur les lieux connus du niveau ; carte entière s'il n'y en a pas encore
  const all = [...shown.map((s) => s.xy), ...mine.map((m) => m.xy)];
  let view = `0 0 ${RADAR_SIZE} ${RADAR_SIZE}`, k = 1;
  if (all.length > 2) {
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const size = Math.min(RADAR_SIZE, Math.max(320, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.3);
    view = `${(Math.min(...xs) + Math.max(...xs)) / 2 - size / 2} ${(Math.min(...ys) + Math.max(...ys)) / 2 - size / 2} ${size} ${size}`;
    k = size / RADAR_SIZE;
  }
  const toRadar = (e: RPointerEvent): [number, number] => {
    const svg = svgRef.current!, pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const r = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [r.x, r.y];
  };
  // radar → monde ; hauteur : lieu connu le plus proche sur ce niveau, sinon milieu du niveau
  const toWorld = ([px, py]: [number, number]): Vec3 => {
    const x = meta.pos_x + px * meta.scale, y = meta.pos_y - py * meta.scale;
    const lvl = meta.levels.find((l) => l.name === level) ?? meta.levels[0];
    const known = places.filter((p) => p.pos && onLevel(p.pos));
    let z = lvl ? (lvl.z_min < -5000 && lvl.z_max > 5000 ? 0 : lvl.z_min < -5000 ? lvl.z_max - 64 : lvl.z_max > 5000 ? lvl.z_min + 64 : (lvl.z_min + lvl.z_max) / 2) : 0;
    if (known.length) z = known.reduce((b, p) => (Math.hypot(p.pos![0] - x, p.pos![1] - y) < Math.hypot(b.pos![0] - x, b.pos![1] - y) ? p : b)).pos![2];
    return [Math.round(x), Math.round(y), Math.round(z)];
  };
  const save = async () => {
    if (!draft) return;
    const v = draft.value.trim(); const at = draft.at; setDraft(null);
    if (!v) return;
    await api.addCustomCallout(meta.name, v, toWorld(at));
    setPlacing(false); refresh();
  };
  return (
    <div className="co-layout">
      <section className="panel co-map">
        <div className="co-tools">
          <Button size="sm" variant={placing ? "primary" : undefined} onClick={() => { setPlacing(!placing); setDraft(null); }} data-testid="place-callout">
            <Icon name="pin" />{placing ? "Cliquez sur la carte…" : "Placer un callout"}</Button>
          {meta.levels.length > 1 && (
            <div className="map-pills" role="group" aria-label="Niveau">
              {meta.levels.map((l) => <button key={l.name} type="button" className={`pill ${level === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>
                {l.name === "upper" ? "Haut" : l.name === "lower" ? "Bas" : l.name}</button>)}
            </div>
          )}
        </div>
        <svg ref={svgRef} viewBox={view} role="img" aria-label={`Callouts de ${meta.display_name}`} data-testid="callout-map"
          className={placing ? "co-placing" : ""} style={{ ["--k" as string]: k }}
          onPointerDown={(e) => {
            if (placing && !draft) { e.preventDefault(); setDraft({ at: toRadar(e), value: "" }); }
          }}
          onPointerMove={(e) => { if (drag) setDrag({ ...drag, at: toRadar(e) }); }}
          onPointerUp={async () => {
            if (!drag) return;
            const d = drag; setDrag(null);
            await api.updateCustomCallout(d.id, { pos: toWorld(d.at) }); refresh();
          }}>
          <image href={`/maps/${meta.levels.find((l) => l.name === level)?.image ?? meta.image}`} width={RADAR_SIZE} height={RADAR_SIZE} />
          {shown.map(({ p, xy: [x, y] }) => (
            <g key={p.place} className={`co-pin ${focus === p.place ? "on" : ""} ${p.label ? "custom" : ""}`} onMouseEnter={() => setFocus(p.place)} onMouseLeave={() => setFocus(null)}>
              <circle cx={x} cy={y} r={5 * k} strokeWidth={2 * k} />
              <text x={x} y={y - 10 * k} textAnchor="middle" fontSize={15 * k} strokeWidth={4 * k}>{p.label ?? humanizePlace(p.place)}</text>
            </g>
          ))}
          {mine.map(({ c, xy }) => {
            const [x, y] = drag?.id === c.id ? drag.at : xy;
            return (
              <g key={`c${c.id}`} className={`co-own ${focus === `c${c.id}` ? "on" : ""}`} data-testid="custom-pin"
                onMouseEnter={() => setFocus(`c${c.id}`)} onMouseLeave={() => setFocus(null)}
                onPointerDown={(e) => { if (placing) return; e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ id: c.id, at: xy }); }}>
                <circle cx={x} cy={y} r={CUSTOM_RADIUS / meta.scale} className="co-own-zone" />
                <rect x={x - 6 * k} y={y - 6 * k} width={12 * k} height={12 * k} transform={`rotate(45 ${x} ${y})`} strokeWidth={2 * k} />
                <text x={x} y={y - 12 * k} textAnchor="middle" fontSize={16 * k} strokeWidth={4 * k}>{c.label}</text>
              </g>
            );
          })}
          {draft && (
            <foreignObject x={draft.at[0] - 4 * k} y={draft.at[1] - 18 * k} width={260 * k} height={40 * k}>
              <input className="co-draft" autoFocus value={draft.value} placeholder="Nom du callout, puis Entrée" aria-label="Nom du nouveau callout"
                style={{ fontSize: 14 * k, height: 32 * k }} data-testid="callout-draft"
                onChange={(e) => setDraft({ ...draft, value: e.target.value })} onBlur={() => void save()}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(null); }} />
            </foreignObject>
          )}
        </svg>
        <p className="st-legend">Losanges : vos callouts (glissez pour les déplacer ; le cercle montre la zone qu'ils couvrent). Points : lieux du jeu.</p>
      </section>
      <section className="panel co-list">
        <h2 className="section-title">Vos callouts</h2>
        {!custom.length ? <p className="st-legend">Aucun pour l'instant : « Placer un callout » puis cliquez sur la carte.</p> : (
          <ul className="co-own-list">
            {custom.map((c) => <OwnRow key={c.id} c={c} on={focus === `c${c.id}`} onFocus={setFocus} onChange={refresh} />)}
          </ul>
        )}
        <div className="co-list-head">
          <h2 className="section-title co-gap">Lieux du jeu <span className="rf-dim">· {places.length}{places.some((p) => p.label) ? ` · ${places.filter((p) => p.label).length} renommé${places.filter((p) => p.label).length > 1 ? "s" : ""}` : ""}</span></h2>
          <label className="search co-search"><Icon name="search" /><input placeholder="Chercher un lieu…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Chercher un lieu" /></label>
        </div>
        <p className="st-legend">Survolez une ligne pour voir le lieu sur la carte. Tapez votre nom d'équipe dans la colonne de droite : il remplace le nom du jeu partout.</p>
        {q.isLoading ? <Spinner /> : !places.length ? <p className="st-legend">Ils apparaîtront après l'import d'un match sur cette carte.</p> : (
          <table className="st-table co-table">
            <thead><tr><th>Lieu du jeu</th><th title="Kills dans ce lieu (tueur ou victime)">Kills</th><th>Nom de l'équipe</th></tr></thead>
            <tbody>{places.filter((p) => !search || humanizePlace(p.place).toLowerCase().includes(search.toLowerCase()) || (p.label ?? "").toLowerCase().includes(search.toLowerCase()))
              .map((p) => <Row key={p.place} map={meta.name} p={p} focus={focus === p.place} onFocus={setFocus} />)}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function OwnRow({ c, on, onFocus, onChange }: { c: CustomCallout; on: boolean; onFocus: (k: string | null) => void; onChange: () => void }) {
  return (
    <li className={on ? "co-focus" : ""} onMouseEnter={() => onFocus(`c${c.id}`)} onMouseLeave={() => onFocus(null)} data-testid="custom-row">
      <Icon name="pin" />
      <input className="co-input" defaultValue={c.label} aria-label={`Nom du callout ${c.label}`}
        onBlur={async (e) => { const v = e.target.value.trim(); if (v && v !== c.label) { await api.updateCustomCallout(c.id, { label: v }); onChange(); } }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      <button type="button" className="btn btn-sm btn-ghost" aria-label={`Supprimer le callout ${c.label}`}
        onClick={async () => { await api.deleteCustomCallout(c.id); onChange(); }}><Icon name="trash" /></button>
    </li>
  );
}

function Row({ map, p, focus, onFocus }: { map: string; p: CalloutPlace; focus: boolean; onFocus: (p: string | null) => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(p.label ?? "");
  const [saved, setSaved] = useState(false);
  const save = async () => {
    if (value.trim() === (p.label ?? "")) return;
    await api.setCallout(map, p.place, value.trim());
    await qc.invalidateQueries({ queryKey: ["callouts", map] });
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  };
  return (
    <tr className={focus ? "co-focus" : ""} onMouseEnter={() => onFocus(p.place)} onMouseLeave={() => onFocus(null)} data-testid="callout-row">
      <td>{humanizePlace(p.place)}</td>
      <td className="mono">{p.count}</td>
      <td><input className="co-input" value={value} placeholder={humanizePlace(p.place)} aria-label={`Nom d'équipe pour ${humanizePlace(p.place)}`}
        onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} maxLength={64} />
        {saved && <span className="co-saved">Enregistré</span>}</td>
    </tr>
  );
}
