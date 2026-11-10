import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { BriefPlayer } from "../../shared/api/types";
import { levelForZ, RADAR_SIZE, worldToRadar } from "../replay/engine/coords";
import type { Mode } from "./scoutUi";

/** « Qui joue où » sur le radar : le poste habituel de chaque joueur 20 s après le début du round (position moyenne
 * réelle), une couleur par joueur. En mode avancé, ses deux autres postes apparaissent en plus petit. */

export const PLAYER_COLORS = ["#4fc3f7", "#ffb74d", "#2ee6a6", "#81c784", "#f06292", "#fff176", "#90a4ae"];

export function SpotsRadar({ mapName, players, side, mode }: { mapName: string; players: BriefPlayer[]; side: "T" | "CT"; mode: Mode }) {
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const meta = maps.data?.find((m) => m.name === mapName);
  const [level, setLevel] = useState<string | null>(null);
  if (!meta) return null;
  const lvl = level ?? meta.levels[0]?.name ?? "default";
  const image = meta.levels.find((l) => l.name === lvl)?.image ?? meta.image;
  const dots = players.flatMap((p, i) => p.spots[side].slice(0, mode === "advanced" ? 3 : 1).map((s, k) => ({ p, s, k, color: PLAYER_COLORS[i % PLAYER_COLORS.length] })))
    .filter(({ s }) => s.pos && (meta.levels.length < 2 || levelForZ(meta, s.pos[2]) === lvl));
  return (
    <figure className="sr" data-testid="spots-radar">
      {meta.levels.length > 1 && (
        <div className="map-pills sr-levels" role="group" aria-label="Niveau">
          {meta.levels.map((l) => <button key={l.name} type="button" className={`pill ${lvl === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>
            {l.name === "upper" ? "Haut" : l.name === "lower" ? "Bas" : l.name}</button>)}
        </div>
      )}
      <svg viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`} role="img" aria-label={`Postes des joueurs en ${side} sur ${meta.display_name}`}>
        <image href={`/maps/${image}`} width={RADAR_SIZE} height={RADAR_SIZE} opacity={0.85} />
        {dots.map(({ p, s, k, color }) => {
          const [x, y] = worldToRadar(meta, s.pos![0], s.pos![1]);
          const main = k === 0;
          return (
            <g key={`${p.steamid}-${k}`} className={`sr-dot ${main ? "main" : ""}`}>
              <circle cx={x} cy={y} r={main ? 15 : 9} fill={color} fillOpacity={main ? 0.9 : 0.45} stroke="#0c0f12" strokeWidth={3} />
              {main && <text x={x} y={y - 22} textAnchor="middle">{p.name}</text>}
              <title>{`${p.name} — ${s.place} : ${s.count.k} rounds sur ${s.count.n}`}</title>
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-legend">
        {players.map((p, i) => (
          <span key={p.steamid}><i style={{ background: PLAYER_COLORS[i % PLAYER_COLORS.length] }} />{p.name}
            {p.spots[side][0] ? <small> · {p.spots[side][0].place} ({p.spots[side][0].count.k}/{p.spots[side][0].count.n})</small> : <small> · pas de poste fixe</small>}</span>
        ))}
      </figcaption>
    </figure>
  );
}

export const NADE_COLORS: Record<string, string> = { Smoke: "#cfd8dc", Flash: "#fff176", Molotov: "#ff7a3d", HE: "#e57373" };

/** Grenades habituelles sur le radar : point d'arrivée moyen de chaque groupe, couleur par type, taille selon la
 * fréquence. */
export function UtilRadar({ mapName, list, label }: { mapName: string; list: { type: string; place: string; count: { k: number; n: number }; pos?: [number, number, number] }[]; label: string }) {
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const meta = maps.data?.find((m) => m.name === mapName);
  const [level, setLevel] = useState<string | null>(null);
  if (!meta || !list.some((u) => u.pos)) return null;
  const lvl = level ?? meta.levels[0]?.name ?? "default";
  const image = meta.levels.find((l) => l.name === lvl)?.image ?? meta.image;
  // numéro = rang dans la liste (même filtré par niveau)
  const pts = list.map((u, i) => ({ u, i })).filter(({ u }) => u.pos && (meta.levels.length < 2 || levelForZ(meta, u.pos[2]) === lvl));
  const maxK = Math.max(1, ...list.map((u) => u.count.k));
  return (
    <figure className="sr sr-util" data-testid="util-radar">
      {meta.levels.length > 1 && (
        <div className="map-pills sr-levels" role="group" aria-label="Niveau">
          {meta.levels.map((l) => <button key={l.name} type="button" className={`pill ${lvl === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>
            {l.name === "upper" ? "Haut" : l.name === "lower" ? "Bas" : l.name}</button>)}
        </div>
      )}
      <svg viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`} role="img" aria-label={label}>
        <image href={`/maps/${image}`} width={RADAR_SIZE} height={RADAR_SIZE} opacity={0.85} />
        {pts.map(({ u, i }) => {
          const [x, y] = worldToRadar(meta, u.pos![0], u.pos![1]);
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={10 + 14 * (u.count.k / maxK)} fill={NADE_COLORS[u.type] ?? "#fff"} fillOpacity={0.75} stroke="#0c0f12" strokeWidth={3} />
              <text x={x} y={y + 5} textAnchor="middle" className="sr-num">{i + 1}</text>
              <title>{`${u.type} vers ${u.place} : ${u.count.k} rounds sur ${u.count.n}`}</title>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
