import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { Spinner } from "../../shared/ui/Spinner";
import { HeatCanvas } from "../heatmaps/HeatmapsPage";
import "../heatmaps/heatmaps.css";

/** Heatmaps de la fiche scouting : où l'équipe se trouve (ou meurt, ou tue) à un moment choisi du round, T et CT côte
 *  à côte. Les moments sont donnés à l'horloge du jeu (1:55 au début du round) ; la requête reste en secondes écoulées. */

type Win = { key: string; label: string; from: number; to: number | null; hint: string };
const WINDOWS: Win[] = [
  { key: "0-10", label: "1:55 – 1:45", from: 0, to: 10, hint: "10 premières secondes : sorties de spawn, premiers placements" },
  { key: "10-20", label: "1:45 – 1:35", from: 10, to: 20, hint: "10 à 20 s de jeu : placements installés, contrôle de carte" },
  { key: "20-35", label: "1:35 – 1:20", from: 20, to: 35, hint: "20 à 35 s de jeu : premiers contacts, rushs" },
  { key: "35-55", label: "1:20 – 1:00", from: 35, to: 55, hint: "35 à 55 s de jeu : prises de site, rotations" },
  { key: "55-", label: "après 1:00", from: 55, to: null, hint: "après 55 s de jeu : fins de round, après le plant" },
  { key: "all", label: "Tout le round", from: 0, to: null, hint: "Tout le round" },
];
const KINDS: [string, string][] = [["presence", "Présence"], ["deaths", "Leurs morts"], ["kills", "Leurs kills"]];

function Pills<T extends string>({ value, options, onChange, label, testid }: { value: T; options: [T, string, string?][]; onChange: (v: T) => void; label: string; testid?: string }) {
  return (
    <div className="ts-seg" role="radiogroup" aria-label={label} data-testid={testid}>
      {options.map(([v, l, h]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} title={h} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

function OneSide({ mapName, teamId, side, win, kind, level, armed }: { mapName: string; teamId: number; side: "T" | "CT"; win: Win; kind: string; level: string; armed: boolean }) {
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const map = maps.data?.find((m) => m.name === mapName);
  const buy = armed ? "full,force" : undefined;
  const t_to = win.to == null ? undefined : String(win.to);
  const heat = useQuery({
    queryKey: ["heatmap", mapName, kind, side, String(teamId), undefined, buy, `${win.from}-${t_to ?? ""}`],
    queryFn: () => api.heatmap({ map: mapName, kind, side, team: String(teamId), buy, t_from: String(win.from), t_to }),
    placeholderData: (p) => p,
  });
  const cells = heat.data?.levels[level] ?? [];
  const href = `/heatmaps?map=${mapName}&team=${teamId}&side=${side}&kind=${kind}${win.key !== "all" ? `&win=${win.from}-${win.to ?? ""}` : ""}${armed ? "&buy=full,force" : ""}`;
  return (
    <div className="sc-heat ts-heat-side" data-testid={`ts-heat-${side}`}>
      <div className="sc-heat-head"><b className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</b> {side === "T" ? "Leur attaque" : "Leur défense"}
        <Link className="pl-link" to={href}>Ouvrir dans Heatmaps ›</Link></div>
      {!map || !heat.data ? <Spinner />
        : !cells.length ? <p className="cm-empty">Rien d'enregistré à ce moment pour ce camp{level && map.levels.length > 1 ? " à cet étage" : ""}.</p>
          : <div className={heat.isPlaceholderData ? "ts-stale" : ""}><HeatCanvas map={map} level={level} kind={kind} cells={cells} bin={heat.data.bin} gamma={0.55} points={[]} /></div>}
    </div>
  );
}

export function ScoutHeat({ mapName, teamId, side, armed }: { mapName: string; teamId: number; side: "all" | "T" | "CT"; armed: boolean }) {
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const map = maps.data?.find((m) => m.name === mapName);
  const [winKey, setWin] = useState("10-20");
  const [kind, setKind] = useState("presence");
  const [level, setLevel] = useState<string>("");
  useEffect(() => setLevel(map?.levels[0]?.name ?? ""), [map]);
  const win = WINDOWS.find((w) => w.key === winKey) ?? WINDOWS[1];
  const sides = (["T", "CT"] as const).filter((s) => side === "all" || side === s);
  return (
    <section className="panel section ts-card ts-wide" data-testid="ts-heat">
      <div className="ts-block-head">
        <h2 className="display ts-h">Où ils jouent <small className="st-legend">heatmaps à l'horloge du jeu{armed ? " · rounds où ils sont armés" : ""}</small></h2>
      </div>
      <div className="ts-heat-bar">
        <Pills label="Moment du round" testid="ts-heat-win" value={winKey} onChange={setWin} options={WINDOWS.map((w) => [w.key, w.label, w.hint] as [string, string, string])} />
        <Pills label="Ce qui est montré" value={kind} onChange={setKind} options={KINDS} />
        {map && map.levels.length > 1 && <Pills label="Étage" value={level} onChange={setLevel} options={map.levels.map((l, i) => [l.name, i === 0 ? "Haut" : "Bas"] as [string, string])} />}
      </div>
      <p className="st-legend ts-heat-hint">{win.hint}.</p>
      <div className="ts-heat-grid">
        {sides.map((s) => <OneSide key={s} mapName={mapName} teamId={teamId} side={s} win={win} kind={kind} level={level} armed={armed} />)}
      </div>
    </section>
  );
}
