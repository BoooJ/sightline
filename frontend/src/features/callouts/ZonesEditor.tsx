import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { CalloutZone, MapMeta } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { RADAR_SIZE, worldToRadar } from "../replay/engine/coords";

/** Couleurs des zones (sans violet) : dans l'ordre de la liste quand une zone n'a pas choisi la sienne. */
export const ZONE_COLORS = ["#2ee6a6", "#5b9dff", "#ffd23f", "#ff7a45", "#ff4d5e", "#3fd0e0", "#9be15d", "#ff8fb1", "#f2f2f2", "#d9a05b"];
const HIDDEN_KEY = "sl-zones-hidden";
type Pt = [number, number];

const colorOf = (z: CalloutZone, i: number) => z.color ?? ZONE_COLORS[i % ZONE_COLORS.length];
const center = (pts: Pt[]): Pt => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

function readHidden(map: string): string[] {
  try { return JSON.parse(localStorage.getItem(`${HIDDEN_KEY}:${map}`) ?? "[]"); } catch { return []; }
}

/** Zones de callouts de la carte, comme sur PRACC : polygones colorés, liste (couleur, nom, œil, corbeille), édition à
 *  la souris, puis « Enregistrer » pour toute l'équipe. Les noms servent partout (fil des kills, analyses, scouting) ;
 *  « Réinitialiser » revient aux zones de Sightline. Masquer une zone ne vaut que dans ce navigateur. */
export function ZonesEditor({ meta }: { meta: MapMeta }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["zones", meta.name], queryFn: () => api.mapZones(meta.name) });
  const [draft, setDraft] = useState<CalloutZone[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drawing, setDrawing] = useState<Pt[] | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [drag, setDrag] = useState<{ zone: number; vertex: number } | null>(null);
  const [level, setLevel] = useState(meta.levels[0]?.name ?? "default");
  const [hidden, setHiddenState] = useState<string[]>(() => readHidden(meta.name));
  const [focusName, setFocusName] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const zones = draft ?? q.data?.zones ?? [];
  const multi = meta.levels.length > 1;
  const onLevel = (z: CalloutZone) => !multi || !z.level || z.level === level;
  const R = (p: Pt | number[]): Pt => worldToRadar(meta, p[0], p[1]);
  const W = (p: Pt): Pt => [Math.round(meta.pos_x + p[0] * meta.scale), Math.round(meta.pos_y - p[1] * meta.scale)];
  const edit = (fn: (zs: CalloutZone[]) => void) => {
    const copy = zones.map((z) => ({ ...z, poly: z.poly.map((p) => [p[0], p[1]] as Pt) }));
    fn(copy);
    setDraft(copy);
    setMsg(null);
  };
  const setHidden = (v: string[]) => {
    setHiddenState(v);
    try { localStorage.setItem(`${HIDDEN_KEY}:${meta.name}`, JSON.stringify(v)); } catch { /* stockage indisponible */ }
  };

  // cadrage sur les zones enregistrées du niveau (pas sur le brouillon : la carte ne bouge pas pendant qu'on dessine)
  const { view, k } = useMemo(() => {
    const pts = (q.data?.zones ?? []).filter(onLevel).flatMap((z) => z.poly.map(R));
    if (pts.length < 3) return { view: `0 0 ${RADAR_SIZE} ${RADAR_SIZE}`, k: 1 };
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const size = Math.min(RADAR_SIZE, Math.max(320, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.12);
    return { view: `${(Math.min(...xs) + Math.max(...xs)) / 2 - size / 2} ${(Math.min(...ys) + Math.max(...ys)) / 2 - size / 2} ${size} ${size}`, k: size / RADAR_SIZE };
  }, [q.data, level]); // eslint-disable-line react-hooks/exhaustive-deps

  const toRadar = (e: RPointerEvent): Pt => {
    const svg = svgRef.current!, pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const r = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [r.x, r.y];
  };

  const finishDrawing = (pts: Pt[]) => {
    setDrawing(null); setCursor(null);
    if (pts.length < 3) return;
    const n = zones.length;
    edit((zs) => { zs.push({ name: `Zone ${n + 1}`, level: multi ? level : null, poly: pts.map(W), color: null }); });
    setSel(n); setFocusName(n);
  };
  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDrawing(null); setCursor(null); }
      if (e.key === "Enter") finishDrawing(drawing);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {  // modifications pas enregistrées : le navigateur prévient avant de quitter la page
    if (!draft) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);

  const save = async () => {
    if (!draft) return;
    if (draft.some((z) => !z.name.trim())) { setMsg("Chaque zone a besoin d'un nom."); return; }
    setSaving(true); setMsg(null);
    try {
      const r = await api.saveMapZones(meta.name, draft.map((z) => ({ ...z, name: z.name.trim() })));
      qc.setQueryData(["zones", meta.name], r);
      void qc.invalidateQueries({ queryKey: ["map-callouts", meta.name] });
      setDraft(null); setSel(null);
      setMsg("Zones enregistrées : leurs noms servent désormais partout (fil des kills, analyses, scouting).");
    } catch (e) { setMsg((e as Error).message); } finally { setSaving(false); }
  };
  const reset = async () => {
    setConfirmReset(false); setSaving(true);
    try {
      const r = await api.resetMapZones(meta.name);
      qc.setQueryData(["zones", meta.name], r);
      void qc.invalidateQueries({ queryKey: ["map-callouts", meta.name] });
      setDraft(null); setSel(null); setMsg("Zones de Sightline rétablies.");
    } catch (e) { setMsg((e as Error).message); } finally { setSaving(false); }
  };

  if (q.isLoading) return <Spinner />;
  const image = meta.levels.find((l) => l.name === level)?.image ?? meta.image;
  const selected = sel !== null && zones[sel] && onLevel(zones[sel]) && !hidden.includes(zones[sel].name) ? zones[sel] : null;
  const selPts = selected ? selected.poly.map(R) : [];
  const nearFirst = (p: Pt) => !!drawing && drawing.length >= 3 && Math.hypot(p[0] - drawing[0][0], p[1] - drawing[0][1]) <= 10 * k;

  return (
    <div className="co-layout">
      <section className="panel co-map">
        <div className="co-tools">
          <Button size="sm" variant={drawing ? "primary" : undefined} data-testid="zone-new"
            onClick={() => { if (drawing) finishDrawing(drawing); else { setDrawing([]); setSel(null); } }}>
            <Icon name="plus" />{drawing ? (drawing.length >= 3 ? "Terminer la zone" : "Cliquez les coins sur la carte…") : "Nouvelle zone"}</Button>
          {drawing && <Button size="sm" variant="ghost" onClick={() => { setDrawing(null); setCursor(null); }}>Annuler le tracé</Button>}
          {multi && (
            <div className="map-pills" role="group" aria-label="Niveau">
              {meta.levels.map((l) => <button key={l.name} type="button" className={`pill ${level === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>
                {l.name === "upper" ? "Haut" : l.name === "lower" ? "Bas" : l.name}</button>)}
            </div>
          )}
        </div>
        <svg ref={svgRef} viewBox={view} role="img" aria-label={`Zones de callouts de ${meta.display_name}`} data-testid="zone-map"
          className={drawing ? "co-placing" : ""}
          onPointerDown={(e) => {
            if (!drawing) { setSel(null); return; }
            e.preventDefault();
            const p = toRadar(e);
            if (nearFirst(p)) finishDrawing(drawing); else setDrawing([...drawing, p]);
          }}
          onPointerMove={(e) => {
            if (drag) edit((zs) => { zs[drag.zone].poly[drag.vertex] = W(toRadar(e)); });
            else if (drawing) setCursor(toRadar(e));
          }}
          onPointerUp={() => setDrag(null)}>
          <image href={`/maps/${image}`} width={RADAR_SIZE} height={RADAR_SIZE} />
          {zones.map((z, i) => ({ z, i })).filter(({ z }) => onLevel(z) && !hidden.includes(z.name)).map(({ z, i }) => {
            const pts = z.poly.map(R), c = colorOf(z, i), on = sel === i;
            const [cx, cy] = center(pts);
            return (
              <g key={i} className={`zn ${on ? "on" : ""}`} data-testid="zone-shape"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onPointerDown={(e) => { if (drawing) return; e.stopPropagation(); setSel(i); }}>
                <polygon points={pts.map((p) => p.join(",")).join(" ")} fill={c} fillOpacity={on ? 0.3 : hover === i ? 0.22 : 0.13}
                  stroke={c} strokeWidth={(on ? 2.4 : 1.4) * k} />
                <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize={12 * k} strokeWidth={3.5 * k} fill={c}>{z.name}</text>
              </g>
            );
          })}
          {selected && sel !== null && (
            <g className="zn-handles">
              {selPts.map((p, v) => {
                const q2 = selPts[(v + 1) % selPts.length];
                const mid: Pt = [(p[0] + q2[0]) / 2, (p[1] + q2[1]) / 2];
                return (
                  <circle key={`m${v}`} cx={mid[0]} cy={mid[1]} r={4 * k} className="zn-mid" strokeWidth={1.5 * k}
                    onPointerDown={(e) => {
                      e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId);
                      edit((zs) => { zs[sel].poly.splice(v + 1, 0, W(mid)); });
                      setDrag({ zone: sel, vertex: v + 1 });
                    }}><title>Ajouter un point</title></circle>
                );
              })}
              {selPts.map((p, v) => (
                <circle key={`v${v}`} cx={p[0]} cy={p[1]} r={6 * k} className="zn-vertex" fill={colorOf(selected, sel)} strokeWidth={2 * k}
                  data-testid="zone-vertex"
                  onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ zone: sel, vertex: v }); }}
                  onDoubleClick={(e) => { e.stopPropagation(); if (selected.poly.length > 3) edit((zs) => { zs[sel].poly.splice(v, 1); }); }}>
                  <title>Glisser pour déplacer · double-clic pour retirer</title></circle>
              ))}
            </g>
          )}
          {drawing && (
            <g className="zn-drawing">
              <polyline points={[...drawing, ...(cursor ? [cursor] : [])].map((p) => p.join(",")).join(" ")} strokeWidth={2 * k} />
              {drawing.map((p, j) => <circle key={j} cx={p[0]} cy={p[1]} r={(j === 0 ? 7 : 4) * k} strokeWidth={2 * k}
                className={j === 0 && cursor && nearFirst(cursor) ? "close" : ""} />)}
            </g>
          )}
        </svg>
        <p className="st-legend">Cliquez une zone pour la modifier : glissez ses points, un point « + » au milieu d'un côté en ajoute un, double-clic sur un point le retire. « Nouvelle zone » : cliquez les coins, puis le premier point (ou Entrée) pour fermer ; Échap annule.</p>
      </section>
      <section className="panel co-list">
        <div className="co-list-head">
          <h2 className="section-title">Zones <span className="rf-dim">· {zones.filter(onLevel).length}{q.data?.edited ? " · redessinées par l'équipe" : ""}</span></h2>
        </div>
        <p className="st-legend">Leurs noms nomment les positions dans le fil des kills, les analyses et le scouting. L'œil masque une zone sur votre écran seulement.</p>
        <ul className="zn-list">
          {zones.map((z, i) => ({ z, i })).filter(({ z }) => onLevel(z)).map(({ z, i }) => {
            const off = hidden.includes(z.name);
            return (
              <li key={i} className={`${sel === i ? "on" : ""} ${off ? "off" : ""}`} data-testid="zone-row"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => setSel(i)}>
                <button type="button" className="zn-swatch" style={{ background: colorOf(z, i) }} aria-label={`Changer la couleur de ${z.name}`} title="Changer la couleur"
                  onClick={(e) => { e.stopPropagation(); edit((zs) => { const cur = ZONE_COLORS.indexOf(colorOf(z, i)); zs[i].color = ZONE_COLORS[(cur + 1) % ZONE_COLORS.length]; }); }} />
                <input className="co-input" value={z.name} maxLength={40} aria-label={`Nom de la zone ${z.name}`} autoFocus={focusName === i}
                  onFocus={(e) => { if (focusName === i) { e.target.select(); setFocusName(null); } }}
                  onChange={(e) => { const v = e.target.value; edit((zs) => { zs[i].name = v; }); }} />
                <button type="button" className="btn btn-sm btn-ghost" aria-label={off ? `Afficher ${z.name}` : `Masquer ${z.name}`} aria-pressed={off}
                  onClick={(e) => { e.stopPropagation(); setHidden(off ? hidden.filter((n) => n !== z.name) : [...hidden, z.name]); }}>
                  <Icon name={off ? "eyeOff" : "eye"} /></button>
                <button type="button" className="btn btn-sm btn-ghost" aria-label={`Supprimer la zone ${z.name}`}
                  onClick={(e) => { e.stopPropagation(); edit((zs) => { zs.splice(i, 1); }); setSel(null); }}><Icon name="trash" /></button>
              </li>
            );
          })}
        </ul>
        {msg && <p className="st-legend zn-msg" role="status">{msg}</p>}
        <div className="zn-actions">
          {q.data?.edited && !draft && (confirmReset
            ? <><span className="st-legend">Revenir aux zones de Sightline ?</span>
                <Button size="sm" variant="danger" onClick={() => void reset()} disabled={saving}>Réinitialiser</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>Garder</Button></>
            : <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)} data-testid="zone-reset">Réinitialiser</Button>)}
          <span className="zn-spacer" />
          <Button size="sm" variant="ghost" disabled={!draft || saving} onClick={() => { setDraft(null); setSel(null); setMsg(null); }}>Annuler</Button>
          <Button size="sm" variant="primary" disabled={!draft || saving} onClick={() => void save()} data-testid="zone-save">Enregistrer</Button>
        </div>
      </section>
    </div>
  );
}
