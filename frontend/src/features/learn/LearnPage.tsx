import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { GrenadeType, LearnEntry, LearnPoste, MapMeta, Side, Vec3 } from "../../shared/api/types";
import { usePlaceAt, usePlaceLabel } from "../../shared/callouts";
import { useMyPlayer } from "../../shared/myPlayer";
import { downloadText, lineupPackCfg, positionsCfg } from "../../shared/practiceCfg";
import { saveStudy, studyUrl, type StudyItem } from "../../shared/study";
import { useUrlParams } from "../../shared/useUrlParams";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { NADE } from "../grenades/GrenadesPage";
import { RADAR_SIZE, levelForZ, worldToRadar } from "../replay/engine/coords";
import { BUYS } from "../rounds/RoundsPage";
import { fmt, metrics, nadeSpots, tips, type PosteMetrics } from "./learn";
import {
  applyFilter, byPlayer, chronology, duels, NO_FILTER, posAt, posteSite, programme, progression, spots as findSpots, studyMarks,
  timeline, TL_MAX, TL_STEP, type Count, type LearnFilter, type SiteFilter, type Spot,
} from "./advanced";
import { RoleLearn } from "./RoleLearn";
import "./learn.css";

const AT = [10, 20, 30, 45];
type Who = "all" | "others" | "me";
type Tab = "synth" | "flow" | "duels" | "util" | "players" | "rounds" | "plan";
const TABS: [Tab, string][] = [["synth", "Synthèse"], ["flow", "Déroulé"], ["duels", "Duels"], ["util", "Utilitaires"], ["players", "Joueurs"],
  ["rounds", "Rounds"], ["plan", "Programme"]];
type Label = (place: string | null | undefined, pos?: Vec3 | null) => string | null;
const nadeLabel = (t: GrenadeType) => NADE[t].label;

/** Apprendre un poste : choisir une carte, un camp et un endroit (ex. ancre A en CT sur Mirage), puis voir comment les
 *  joueurs de la bibliothèque le jouent selon la situation, me comparer à eux, revoir leurs rounds à la suite avec des
 *  pauses commentées, et suivre un programme d'entraînement. */
export function LearnPage() {
  const [params, set] = useUrlParams();
  const nav = useNavigate();
  const loc = useLocation();
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const matches = useQuery({ queryKey: ["matches", "", ""], queryFn: () => api.matches() });
  const defaultMap = useMemo(() => {
    const n: Record<string, number> = {};
    matches.data?.forEach((m) => { n[m.map_name] = (n[m.map_name] ?? 0) + 1; });
    return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [matches.data]);
  const mapName = params.get("map") ?? defaultMap;
  const map = maps.data?.find((m) => m.name === mapName);
  const side = (params.get("side") === "T" ? "T" : "CT") as Side;
  const at = Number(params.get("at")) || 20;
  const places = (params.get("place") ?? "").split(",").filter(Boolean);
  const tab = (TABS.find(([k]) => k === params.get("tab"))?.[0] ?? "synth") as Tab;
  const mode = params.get("mode") === "role" ? "role" : "poste";
  const me = useMyPlayer();
  const placeLabel = usePlaceLabel(mapName);
  const placeAt = usePlaceAt(mapName);
  const label: Label = (place, pos) => (place ? placeLabel(place, pos) : placeAt(pos ?? null));
  const [who, setWho] = useState<Who>("all");
  const [layers, setLayers] = useState({ pos: true, path: false, deaths: true, nades: true, kills: false });
  const [filter, setFilter] = useState<LearnFilter>(NO_FILTER);
  const [time, setTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setFilter(NO_FILTER); setTime(null); setPlaying(false); }, [mapName, side, at, params.get("place")]);  // eslint-disable-line react-hooks/exhaustive-deps

  const postes = useQuery({ queryKey: ["learn", mapName, side, at], queryFn: () => api.learn(mapName!, side, undefined, at), enabled: !!mapName });
  const detail = useQuery({ queryKey: ["learn", mapName, side, at, places.join(",")], queryFn: () => api.learn(mapName!, side, places.join(","), at),
    enabled: !!mapName && places.length > 0 });
  const posteLabel = (p: LearnPoste | string) => {
    const po = typeof p === "string" ? postes.data?.postes.find((x) => x.place === p) : p;
    const place = typeof p === "string" ? p : p.place;
    return po?.label ?? placeLabel(place) ?? place;
  };
  const all = useMemo(() => detail.data?.entries ?? [], [detail.data]);
  const site = posteSite(all, detail.data?.sites);
  const spotList = useMemo(() => findSpots(all), [all]);
  const filtered = applyFilter(all, { ...filter, player: "" }, site, spotList);
  const mine = filtered.filter((e) => e.steamid === me);
  const others = filtered.filter((e) => e.steamid !== me && (!filter.player || e.steamid === filter.player));
  const shown = who === "me" ? mine : who === "others" ? others : [...others, ...mine];
  const title = places.map(posteLabel).join(" + ");
  const togglePlace = (p: string) => set("place", places.includes(p) ? places.filter((x) => x !== p).join(",") || undefined : [...places, p].join(","));

  // curseur de temps : lecture des positions au fil du round
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setTime((t) => {
      const n = (t ?? 0) + 0.5;
      if (n >= TL_MAX) { setPlaying(false); return TL_MAX; }
      return n;
    }), 125);
    return () => clearInterval(id);
  }, [playing]);

  const study = (es: LearnEntry[], what: string) => {
    const items: StudyItem[] = [...es].sort(byQuality).map((e) => ({
      match_id: e.match_id, round_number: e.round_number, steamid: e.steamid, start: e.start_tick, end: e.end_tick,
      label: `${e.name} (${e.team}) vs ${e.opponent} · R${e.round_number} · ${e.won ? "gagné" : "perdu"}${e.death ? ` · mort à ${fmt(e.death.time_s)}` : " · survit"}`,
      marks: studyMarks(e, label, nadeLabel),
    }));
    if (!items.length) return;
    saveStudy({ title: `${what} : ${title} ${side} — ${map?.display_name ?? mapName}`, back: loc.pathname + loc.search, items, pauses: true });
    nav(studyUrl(items[0], 0));
  };

  return (
    <div className={`ln ${mode === "role" ? "ln-role" : ""}`}>
      <aside className="ln-side">
        <div className="eyebrow">Joueurs</div>
        <h1 className="display ln-title">{mode === "role" ? "Apprendre un rôle" : "Apprendre un poste"}</h1>
        <Link to="/learn" className="btn btn-sm btn-ghost"><Icon name="back" />Version simple (histoire d’un round)</Link>
        <div className="map-pills ln-mode" role="group" aria-label="Mode">
          <button type="button" className={`pill ${mode === "poste" ? "on" : ""}`} onClick={() => set({ mode: null, role: null })} data-testid="mode-poste">Par poste</button>
          <button type="button" className={`pill ${mode === "role" ? "on" : ""}`} onClick={() => set({ mode: "role", place: null })} data-testid="mode-role">Par rôle</button>
        </div>
        <p className="st-legend">{mode === "role"
          ? "Entry, lurker, support, ancre, rotateur, AWPer… : les profils de rôle des joueurs de la bibliothèque, ce qu'on mesure pour chaque rôle, des repères pros et des joueurs modèles à étudier."
          : "Choisissez l'endroit où vous jouez : Sightline montre comment les joueurs de la bibliothèque le tiennent selon la situation, vous compare à eux et vous propose un programme."}</p>
        <label className="rf-group"><span className="rf-label">Carte</span>
          <select className="rf-select" value={mapName ?? ""} onChange={(e) => set({ map: e.target.value, place: null })} aria-label="Carte">
            {maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}
          </select></label>
        <div className="rf-group">
          <span className="rf-label">Camp</span>
          <div className="map-pills" role="group" aria-label="Camp">
            {(["CT", "T"] as const).map((x) => <button key={x} type="button" className={`pill pill-${x.toLowerCase()} ${side === x ? "on" : ""}`} onClick={() => set({ side: x, place: null })}>{x}</button>)}
          </div>
        </div>
        {mode === "poste" && <>
        <div className="rf-group" title="Le poste d'un joueur est l'endroit où il se trouve à cet instant du round">
          <span className="rf-label">Poste pris à</span>
          <div className="map-pills" role="group" aria-label="Instant">
            {AT.map((x) => <button key={x} type="button" className={`pill ${at === x ? "on" : ""}`} onClick={() => set({ at: x === 20 ? null : String(x), place: null })}>{fmt(x)}</button>)}
          </div>
        </div>
        {(() => {
          const minePostes = (postes.data?.postes ?? []).filter((p) => me && p.by_player[me]).sort((a, b) => b.by_player[me!] - a.by_player[me!]).slice(0, 4);
          return minePostes.length ? (
            <div className="rf-group" data-testid="my-postes">
              <span className="rf-label">Tes postes habituels</span>
              <div className="map-pills">
                {minePostes.map((p) => <button key={p.place} type="button" className={`pill ${places.includes(p.place) ? "on" : ""}`}
                  onClick={() => set("place", p.place)} title="Rounds où tu étais à ce poste">{posteLabel(p)} <small>{p.by_player[me!]}</small></button>)}
              </div>
            </div>
          ) : null;
        })()}
        <div className="rf-group">
          <span className="rf-label">Poste {places.length > 1 ? `(${places.length} lieux)` : ""}</span>
          <div className="ln-postes" data-testid="postes">
            {postes.isLoading ? <Spinner /> : postes.data?.postes.filter((p) => p.rounds >= 2).map((p) => (
              <button key={p.place} type="button" className={`ln-poste ${places.includes(p.place) ? "on" : ""}`} onClick={() => togglePlace(p.place)}
                aria-pressed={places.includes(p.place)} title={p.players.join(", ")}>
                <span className="ln-poste-name">{posteLabel(p)}</span>
                <span className="ln-poste-stat"><span className="ln-poste-bar"><i style={{ width: `${p.win_pct}%` }} /></span><span className="mono">{p.rounds} r · <b className={p.win_pct >= 50 ? "pos" : "neg"}>{p.win_pct} %</b></span></span>
              </button>
            ))}
          </div>
          <span className="st-legend">Cliquez plusieurs lieux pour un poste plus large (ex. site A + Jungle). Placez vos propres callouts dans « Callouts » pour des postes à vos mots.</span>
        </div>
        </>}
      </aside>
      {mode === "role" && mapName && <RoleLearn mapName={mapName} mapLabel={map?.display_name ?? mapName} side={side} role={params.get("role")}
        setRole={(r) => set("role", r)} me={me} />}
      {mode === "poste" && <>

      <section className="ln-map">
        {!map ? <Spinner /> : (
          <PosteMap map={map} postes={places.length ? [] : postes.data?.postes.filter((p) => p.rounds >= 2) ?? []} entries={shown} me={me} layers={layers}
            time={time} spot={spotList.find((s) => s.id === filter.spot) ?? null} onPick={togglePlace} posteLabel={posteLabel} />
        )}
        {places.length > 0 && (
          <div className="ln-bottom">
            <div className="ln-time" data-testid="time-bar">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { if (time === null || time >= TL_MAX) setTime(0); setPlaying(!playing); }}
                aria-label={playing ? "Pause" : "Lire le round"} data-testid="time-play"><Icon name={playing ? "pause" : "play"} /></button>
              <input type="range" min={0} max={TL_MAX} step={0.5} value={time ?? at} aria-label="Instant du round"
                onChange={(e) => { setPlaying(false); setTime(Number(e.target.value)); }} />
              <span className="mono ln-time-v">{time === null ? `poste à ${fmt(at)}` : fmt(time)}</span>
              {time !== null && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setPlaying(false); setTime(null); }}>Revenir au poste</button>}
            </div>
            <div className="ln-layers">
              {([["pos", time === null ? `Positions à ${fmt(at)}` : "Positions"], ["path", "Trajets"], ["deaths", "Morts"], ["kills", "Kills"], ["nades", "Utilitaires"]] as const).map(([k, l]) => (
                <label key={k}><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{l}</label>
              ))}
              <span className="ln-sep" />
              <div className="map-pills" role="group" aria-label="Rounds affichés">
                {([["all", "Tous"], ["others", "Les autres"], ["me", "Moi"]] as const).map(([k, l]) => (
                  <button key={k} type="button" className={`pill ${who === k ? "on" : ""}`} disabled={k === "me" && !mine.length} onClick={() => setWho(k)}>{l}</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      <aside className="ln-detail">
        {!places.length ? (
          <EmptyState icon="crosshair" title="Choisissez un poste">Sur la carte ou dans la liste : les postes sont les endroits où les joueurs se trouvent à {fmt(at)} en {side}.</EmptyState>
        ) : detail.isLoading ? <Spinner /> : !all.length ? <EmptyState title="Aucun round à ce poste" /> : (
          <div className="ln-panel" data-testid="poste-detail">
            <h2 className="display ln-h">{title} <span className={side === "CT" ? "gr-ct" : "gr-t"}>{side}</span></h2>
            <p className="st-legend">{others.length} rounds des autres ({new Set(others.map((e) => e.name)).size} joueurs){mine.length ? `, ${mine.length} à toi` : ""}
              {filtered.length < all.length ? ` · filtrés sur ${all.length}` : ""}.</p>
            <Situation all={all} filter={filter} setFilter={setFilter} site={site} spots={spotList} />
            <div className="ln-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => study(others, "Étude")} disabled={!others.length} data-testid="study-poste">
                <Icon name="play" />Étudier leurs rounds à la suite</button>
              {mine.length > 0 && <button type="button" className="btn btn-sm" onClick={() => study(mine, "Mes rounds")}><Icon name="play" />Revoir les miens</button>}
            </div>
            <nav className="ln-tabs" role="tablist" aria-label="Sections du poste">
              {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""}
                onClick={() => set("tab", k === "synth" ? undefined : k)} data-testid={`tab-${k}`}>{l}</button>)}
            </nav>
            {!others.length && !mine.length ? <p className="st-legend">Aucun round pour ces filtres.</p>
              : tab === "synth" ? <Synthesis others={others} mine={mine} me={me} label={label} />
              : tab === "flow" ? <Flow others={others} mine={mine} spots={spotList} filter={filter} setFilter={setFilter} label={label} placeAt={placeAt} />
              : tab === "duels" ? <DuelsTab others={others} mine={mine} label={label} />
              : tab === "util" ? <Utility others={others} mine={mine} side={side} mapName={mapName ?? ""} title={title} label={label} />
              : tab === "players" ? <Players others={others} mine={mine} model={filter.player} setModel={(p) => setFilter({ ...filter, player: p })} />
              : tab === "rounds" ? <Rounds es={[...mine, ...[...others].sort(byQuality)]} me={me} />
              : <Plan others={others} mine={mine} keyId={`${mapName}|${side}|${places.join(",")}`} placeAt={placeAt} />}
          </div>
        )}
      </aside>
      </>}
    </div>
  );
}

const byQuality = (a: LearnEntry, b: LearnEntry) => Number(b.won) - Number(a.won) || Number(!b.death) - Number(!a.death) || b.kills - a.kills;
const BUY_LABEL: Record<string, string> = Object.fromEntries(BUYS);

function Situation({ all, filter, setFilter, site, spots }: { all: LearnEntry[]; filter: LearnFilter; setFilter: (f: LearnFilter) => void; site: string | null; spots: Spot[] }) {
  const opps = [...new Set(all.map((e) => e.opponent))].sort();
  const n = (f: (e: LearnEntry) => boolean) => all.filter(f).length;
  const SITES: [SiteFilter, string, number][] = [["all", "Tous", all.length],
    ["this", `Bombe sur ${site ?? "ce site"}`, n((e) => !!site && e.bomb_site === site)],
    ["other", "Bombe ailleurs", n((e) => !!e.bomb_site && e.bomb_site !== site)], ["none", "Pas posée", n((e) => !e.bomb_site)]];
  const active = filter.site !== "all" || filter.buy.length || filter.opponent || filter.spot !== null;
  return (
    <div className="ln-situ" data-testid="situation">
      <div className="ln-situ-row">
        <span className="rf-label">Situation</span>
        <div className="map-pills" role="group" aria-label="Site attaqué">
          {SITES.map(([k, l, c]) => <button key={k} type="button" className={`pill ${filter.site === k ? "on" : ""}`} disabled={!c && k !== "all"}
            onClick={() => setFilter({ ...filter, site: k })}>{l} <small>{c}</small></button>)}
        </div>
      </div>
      <div className="ln-situ-row">
        <span className="rf-label">Économie</span>
        <div className="map-pills" role="group" aria-label="Économie">
          {BUYS.map(([k, l]) => {
            const on = filter.buy.includes(k), c = n((e) => e.buy === k);
            return <button key={k} type="button" className={`pill ${on ? "on" : ""}`} disabled={!c} aria-pressed={on}
              onClick={() => setFilter({ ...filter, buy: on ? filter.buy.filter((x) => x !== k) : [...filter.buy, k] })}>{l} <small>{c}</small></button>;
          })}
        </div>
      </div>
      <div className="ln-situ-row">
        <label className="ln-inline"><span className="rf-label">Adversaire</span>
          <select className="rf-select" value={filter.opponent} onChange={(e) => setFilter({ ...filter, opponent: e.target.value })} aria-label="Adversaire">
            <option value="">Tous</option>{opps.map((o) => <option key={o}>{o}</option>)}
          </select></label>
        {filter.spot !== null && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter({ ...filter, spot: null })}>
          Placement {spots.findIndex((s) => s.id === filter.spot) + 1} ✕</button>}
        {active ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter(NO_FILTER)} data-testid="situ-reset">Réinitialiser</button> : null}
      </div>
    </div>
  );
}

const p0 = (v: number) => `${Math.round(v)} %`;
const ROWS: [keyof PosteMetrics, string, (v: number) => string, 1 | -1 | 0][] = [
  ["rounds", "Rounds", (v) => String(v), 0],
  ["winPct", "Rounds gagnés", p0, 1],
  ["survivePct", "Survie", p0, 1],
  ["kpr", "Kills / round", (v) => v.toFixed(2), 1],
  ["adr", "Dégâts / round", (v) => v.toFixed(0), 1],
  ["openingDeathPct", "Premier mort du round", p0, -1],
  ["tradedPct", "Morts vengées", p0, 1],
  ["deathS", "Moment de la mort", fmt, 1],
  ["leftPct", "Quitte le poste", p0, 0],
  ["leftS", "… vers", fmt, 0],
  ["nadesPerRound", "Utilitaires / round", (v) => v.toFixed(1), 1],
];

function CompareTable({ a, b, aLabel, bLabel, testId }: { a: PosteMetrics; b: PosteMetrics | null; aLabel: string; bLabel: string; testId?: string }) {
  return (
    <table className="ln-cmp" data-testid={testId}>
      <thead><tr><th /><th>{aLabel}</th><th>{bLabel}</th></tr></thead>
      <tbody>
        {ROWS.map(([k, l, f, better]) => {
          const x = a[k], y = b?.[k] ?? null;
          const cls = y === null || x === null || better === 0 ? "" : (better > 0 ? y > x : y < x) ? "up" : (better > 0 ? y < x : y > x) ? "down" : "";
          return <tr key={k}><td>{l}</td><td className="mono">{x === null ? "–" : f(x)}</td><td className={`mono ${cls}`}>{y === null ? "–" : f(y)}</td></tr>;
        })}
      </tbody>
    </table>
  );
}

function Synthesis({ others, mine, me, label }: { others: LearnEntry[]; mine: LearnEntry[]; me: string | undefined; label: Label }) {
  const advice = tips(others, mine, label, nadeLabel);
  return (<>
    <h3 className="ln-sub">Comparaison</h3>
    <CompareTable a={metrics(others)} b={mine.length ? metrics(mine) : null} aLabel="Les autres" bLabel={mine.length ? "Moi" : me ? "Moi (aucun round)" : "Moi"} testId="poste-compare" />
    {!me && <p className="st-legend">Choisissez « Joueur suivi » sur le tableau de bord pour vous comparer.</p>}
    {advice.length > 0 && (<>
      <h3 className="ln-sub">Conseils</h3>
      <ul className="ln-tips" data-testid="poste-tips">
        {advice.map((t, k) => <li key={k} className={`ln-tip ${t.kind}`}>{t.text}</li>)}
      </ul>
    </>)}
  </>);
}

function Flow({ others, mine, spots, filter, setFilter, label, placeAt }: {
  others: LearnEntry[]; mine: LearnEntry[]; spots: Spot[]; filter: LearnFilter; setFilter: (f: LearnFilter) => void; label: Label; placeAt: (p: Vec3 | null) => string | null;
}) {
  const tl = timeline(others), tlMe = mine.length ? timeline(mine) : null;
  const chrono = chronology(others, placeAt, nadeLabel);
  const bestSurvive = Math.max(...spots.filter((s) => s.entries.length >= 2).map((s) => s.m.survivePct), -1);
  return (<>
    <h3 className="ln-sub">Déroulé type <small>(les autres)</small></h3>
    <TimelineChart cols={tl} testId="poste-timeline" />
    {tlMe && (<><h3 className="ln-sub">Mon déroulé</h3><TimelineChart cols={tlMe} /></>)}
    <div className="ln-legend"><i className="held" />Au poste<i className="left" />Parti<i className="dead" />Mort<i className="over" />Round fini</div>
    <h3 className="ln-sub">Chronologie type</h3>
    <ol className="ln-chrono" data-testid="poste-chrono">
      {chrono.map((c, k) => <li key={k} className={c.kind}><b className="mono">{fmt(c.t)}</b><span>{c.text}</span><small>{Math.round(c.pct)} % des rounds</small></li>)}
    </ol>
    <h3 className="ln-sub">Placements</h3>
    <p className="st-legend">Endroits précis où le poste est tenu (cliquez pour filtrer et le voir sur la carte).</p>
    <ul className="ln-spots" data-testid="poste-spots">
      {spots.map((s, k) => (
        <li key={s.id}>
          <button type="button" className={`ln-spot ${filter.spot === s.id ? "on" : ""}`} onClick={() => setFilter({ ...filter, spot: filter.spot === s.id ? null : s.id })}>
            <b>{k + 1}. {label(null, s.pos) ?? "Placement"}</b>
            {s.m.survivePct === bestSurvive && s.entries.length >= 2 && <span className="ln-badge">survit le mieux</span>}
            <small className="mono">{s.entries.length} r · survie {Math.round(s.m.survivePct)} % · {s.m.kpr.toFixed(2)} k/r{s.m.winPct !== null ? ` · ${Math.round(s.m.winPct)} % gagnés` : ""}</small>
          </button>
        </li>
      ))}
    </ul>
  </>);
}

function TimelineChart({ cols, testId }: { cols: ReturnType<typeof timeline>; testId?: string }) {
  const W = 360, H = 70, w = W / cols.length;
  return (
    <svg className="ln-tl" viewBox={`0 0 ${W} ${H + 14}`} data-testid={testId} role="img" aria-label="Part des rounds au poste, partis, morts, au fil du temps">
      {cols.map((c, i) => {
        let y = H;
        return (
          <g key={c.t}>
            <title>{`${fmt(c.t)} : au poste ${Math.round(c.held * 100)} %, parti ${Math.round(c.left * 100)} %, mort ${Math.round(c.dead * 100)} %, round fini ${Math.round(c.over * 100)} %`}</title>
            {(["held", "left", "dead", "over"] as const).map((k) => {
              const h = c[k] * H; y -= h;
              return h > 0 ? <rect key={k} x={i * w} y={y} width={Math.max(0.5, w - 0.6)} height={h} className={`tl-${k}`} /> : null;
            })}
          </g>
        );
      })}
      {[0, 15, 30, 45, 60, 75, 90].map((t) => <text key={t} x={Math.min(W, (t / TL_STEP) * w)} y={H + 11} fontSize={8} className="ln-axis"
        textAnchor={t === 0 ? "start" : t === TL_MAX ? "end" : "middle"}>{fmt(t)}</text>)}
    </svg>
  );
}

function Bars({ items, total, testId }: { items: Count[]; total: number; testId?: string }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <ul className="ln-bars" data-testid={testId}>
      {items.slice(0, 6).map((i) => (
        <li key={i.label}><span>{i.label}</span><i style={{ width: `${(100 * i.n) / max}%` }} /><small className="mono">{i.n} · {Math.round((100 * i.n) / Math.max(1, total))} %</small></li>
      ))}
    </ul>
  );
}

function DuelsTab({ others, mine, label }: { others: LearnEntry[]; mine: LearnEntry[]; label: Label }) {
  const d = duels(others, label), dm = mine.length ? duels(mine, label) : null;
  return (<>
    <h3 className="ln-sub">D'où viennent les morts <small>({d.deaths})</small></h3>
    <Bars items={d.deathsFrom} total={d.deaths} testId="deaths-from" />
    {dm && dm.deaths > 0 && (<><h3 className="ln-sub">Mes morts viennent de</h3><Bars items={dm.deathsFrom} total={dm.deaths} /></>)}
    <h3 className="ln-sub">Armes qui les tuent</h3>
    <Bars items={d.deathWeapons} total={d.deaths} />
    <h3 className="ln-sub">Où ils font leurs kills <small>({d.kills})</small></h3>
    <Bars items={d.killsOn} total={d.kills} />
    <h3 className="ln-sub">Distances</h3>
    <p className="st-legend">Distance médiane des duels perdus : <b>{d.deathDist === null ? "–" : `${Math.round(d.deathDist)} u`}</b>
      {dm?.deathDist != null && <> (toi : <b>{Math.round(dm.deathDist)} u</b>)</>} · des kills : <b>{d.killDist === null ? "–" : `${Math.round(d.killDist)} u`}</b>
      {dm?.killDist != null && <> (toi : <b>{Math.round(dm.killDist)} u</b>)</>}. Plus de 1500 u : duel à longue distance (AWP, angle ouvert).</p>
  </>);
}

function Utility({ others, mine, side, mapName, title, label }: { others: LearnEntry[]; mine: LearnEntry[]; side: Side; mapName: string; title: string; label: Label }) {
  const spots = nadeSpots(others).slice(0, 10);
  const mineSpots = nadeSpots(mine);
  const ref = others.filter((e) => e.won && !e.death).slice(0, 12);
  return (<>
    <h3 className="ln-sub">Utilitaires du poste
      <button type="button" className="btn btn-sm btn-ghost" disabled={!spots.some((s) => s.setpos) && !ref.length} data-testid="poste-cfg"
        title="Config CS2 : lineups du poste (lineup_N) et positions de référence (pos_N), à charger sur un serveur avec sv_cheats 1"
        onClick={() => {
          const ls = spots.filter((s) => s.setpos).map((s) => ({ type: s.type, setpos: s.setpos!, label: `${NADE[s.type].label} -> ${label(null, s.land) ?? "?"}` }));
          const ps = ref.map((e, k) => ({ name: `${k + 1}_${e.name}`, side, x: e.pos[0], y: e.pos[1], z: e.pos[2], yaw: e.yaw ?? 0 }));
          downloadText(`poste_${mapName}_${side}_${title.replace(/\W+/g, "_")}.cfg`,
            `${lineupPackCfg(mapName, ls)}\n${positionsCfg(`Positions de référence — ${title} ${side}`, ps)}`);
        }}><Icon name="download" />Entraînement .cfg</button>
    </h3>
    {spots.length ? (
      <ul className="ln-nades" data-testid="poste-nades">
        {spots.map((s, k) => {
          const mineN = mineSpots.find((x) => x.type === s.type && Math.hypot(x.land[0] - s.land[0], x.land[1] - s.land[1]) <= 250);
          return (
            <li key={k}><i style={{ background: NADE[s.type].color }} /><b>{NADE[s.type].label}</b> → {label(null, s.land) ?? "?"}
              <small className="mono"> · {Math.round(s.perRound * 100)} % des rounds · vers {fmt(s.timeS)}</small>
              {mine.length > 0 && <small className={mineN ? "gr-won" : "gr-lost"}> · {mineN ? `toi : ${Math.round(mineN.perRound * 100)} %` : "jamais par toi"}</small>}</li>
          );
        })}
      </ul>
    ) : <p className="st-legend">Peu d'utilitaires lancés depuis ce poste.</p>}
    <p className="st-legend">Le fichier .cfg contient un alias lineup_N par utilitaire (téléportation au point de lancer, grenade en main) et pos_N pour les placements des rounds gagnés sans mourir.</p>
  </>);
}

function Players({ others, mine, model, setModel }: { others: LearnEntry[]; mine: LearnEntry[]; model: string; setModel: (p: string) => void }) {
  const rows = byPlayer(others);
  const prog = progression(mine);
  return (<>
    <h3 className="ln-sub">Joueurs de référence</h3>
    <p className="st-legend">Choisissez un modèle : toutes les analyses ne montrent alors que ses rounds.</p>
    <table className="ln-cmp ln-players" data-testid="poste-players">
      <thead><tr><th>Joueur</th><th>R</th><th>Survie</th><th>K/r</th><th>Dgts</th><th /></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.steamid} className={model === r.steamid ? "on" : ""}>
            <td><b>{r.name}</b> <small>{r.team}</small></td><td className="mono">{r.entries.length}</td><td className="mono">{p0(r.m.survivePct)}</td>
            <td className="mono">{r.m.kpr.toFixed(2)}</td><td className="mono">{r.m.adr.toFixed(0)}</td>
            <td><button type="button" className="btn btn-sm btn-ghost" onClick={() => setModel(model === r.steamid ? "" : r.steamid)}>{model === r.steamid ? "✕" : "Modèle"}</button></td>
          </tr>
        ))}
      </tbody>
    </table>
    <h3 className="ln-sub">Ma progression</h3>
    {prog.length ? (
      <table className="ln-cmp" data-testid="poste-progress">
        <thead><tr><th>Match</th><th>R</th><th>Survie</th><th>K/r</th><th>Util./r</th></tr></thead>
        <tbody>
          {prog.map((r, i) => {
            const prev = prog[i - 1]?.m;
            const tr = (a: number, b: number | undefined) => (b === undefined ? "" : a > b ? "up" : a < b ? "down" : "");
            return (
              <tr key={r.key}><td>{r.label}{r.date ? <small> · {new Date(r.date).toLocaleDateString("fr-FR")}</small> : null}</td><td className="mono">{r.m.rounds}</td>
                <td className={`mono ${tr(r.m.survivePct, prev?.survivePct)}`}>{p0(r.m.survivePct)}</td><td className={`mono ${tr(r.m.kpr, prev?.kpr)}`}>{r.m.kpr.toFixed(2)}</td>
                <td className={`mono ${tr(r.m.nadesPerRound, prev?.nadesPerRound)}`}>{r.m.nadesPerRound.toFixed(1)}</td></tr>
            );
          })}
        </tbody>
      </table>
    ) : <p className="st-legend">Aucun de tes rounds à ce poste pour l'instant (joueur suivi sur le tableau de bord).</p>}
  </>);
}

function Rounds({ es, me }: { es: LearnEntry[]; me: string | undefined }) {
  return (
    <ul className="ln-rounds" data-testid="poste-rounds">
      {es.slice(0, 80).map((e) => (
        <li key={`${e.match_id}-${e.round_number}-${e.steamid}`} className={e.steamid === me ? "mine" : ""}>
          <span><b>{e.name}</b> <small>{e.team} vs {e.opponent} · R{e.round_number} · {BUY_LABEL[e.buy] ?? e.buy}{e.bomb_site ? ` · bombe ${e.bomb_site}` : ""}</small>
            <small className={e.won ? "gr-won" : "gr-lost"}> · {e.won ? "gagné" : "perdu"}</small>
            <small> · {e.kills} kill{e.kills > 1 ? "s" : ""} · {e.death ? `mort à ${fmt(e.death.time_s)}` : "survit"}</small></span>
          <Link className="btn btn-sm btn-ghost" to={`/matches/${e.match_id}/replay/${e.round_number}?t=${e.start_tick}&focus=${e.steamid}`} title="Revoir ce round en suivant le joueur"><Icon name="play" /></Link>
        </li>
      ))}
    </ul>
  );
}

function Plan({ others, mine, keyId, placeAt }: { others: LearnEntry[]; mine: LearnEntry[]; keyId: string; placeAt: (p: Vec3 | null) => string | null }) {
  const goals = programme(others, mine, placeAt, nadeLabel);
  const storeKey = `learn-plan:${keyId}`;
  const read = () => { try { return JSON.parse(localStorage.getItem(storeKey) ?? "{}") as Record<string, boolean>; } catch { return {}; } };
  const [done, setDone] = useState<Record<string, boolean>>(read);
  useEffect(() => { setDone(read()); }, [storeKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => {
    const n = { ...done, [id]: !done[id] };
    setDone(n);
    try { localStorage.setItem(storeKey, JSON.stringify(n)); } catch { /* stockage indisponible */ }
  };
  const ok = goals.filter((g) => (g.auto === undefined ? done[g.id] : g.auto)).length;
  return (<>
    <h3 className="ln-sub">Programme d'entraînement <small className="mono" data-testid="plan-score">{ok}/{goals.length}</small></h3>
    <div className="ln-progress"><i style={{ width: `${(100 * ok) / Math.max(1, goals.length)}%` }} /></div>
    <ul className="ln-plan" data-testid="poste-plan">
      {goals.map((g) => (
        <li key={g.id} className={g.auto === undefined ? "" : "auto"}>
          {g.auto === undefined
            ? <label><input type="checkbox" checked={!!done[g.id]} onChange={() => toggle(g.id)} />{g.text}</label>
            : <span><b className={g.auto ? "gr-won" : g.auto === false ? "gr-lost" : ""}>{g.auto ? "✓" : g.auto === false ? "✗" : "…"}</b> {g.text}
              <small>{g.auto === null ? " (pas encore de round à toi)" : " (vérifié sur tes rounds)"}</small></span>}
        </li>
      ))}
    </ul>
    <p className="st-legend">Les étapes cochées sont gardées sur cet appareil ; les objectifs chiffrés se vérifient tout seuls à chaque nouvelle démo.</p>
  </>);
}

function PosteMap({ map, postes, entries, me, layers, time, spot, onPick, posteLabel }: {
  map: MapMeta; postes: LearnPoste[]; entries: LearnEntry[]; me: string | undefined; time: number | null; spot: Spot | null;
  layers: { pos: boolean; path: boolean; deaths: boolean; nades: boolean; kills: boolean }; onPick: (p: string) => void; posteLabel: (p: LearnPoste) => string;
}) {
  const [level, setLevel] = useState(map.levels[0]?.name ?? "");
  const [view, setView] = useState({ x: 0, y: 0, s: RADAR_SIZE });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => { setLevel(map.levels[0]?.name ?? ""); }, [map.name]);  // eslint-disable-line react-hooks/exhaustive-deps
  // cadrage sur les points affichés (postes, ou positions et morts du poste choisi)
  const pts: Vec3[] = postes.length ? postes.map((p) => p.pos) : entries.flatMap((e) => [e.pos, ...(e.death ? [e.death.pos] : [])]);
  const fitKey = `${map.name}|${postes.length ? "postes" : entries.length ? `${entries[0].match_id}-${entries.length}` : ""}`;
  const fitted = useRef("");
  useEffect(() => {
    if (fitted.current === fitKey || !pts.length) return;
    fitted.current = fitKey;
    const rp = pts.map((p) => worldToRadar(map, p[0], p[1])), xs = rp.map((p) => p[0]), ys = rp.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const s = Math.min(RADAR_SIZE, Math.max(300, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.35);
    setView({ s, x: cx - s / 2, y: cy - s / 2 });
  });
  const onLevel = (v: Vec3) => map.levels.length < 2 || levelForZ(map, v[2]) === level;
  const P = (v: Vec3) => worldToRadar(map, v[0], v[1]);
  const k = view.s / RADAR_SIZE;
  const image = map.levels.find((l) => l.name === level)?.image ?? map.image;
  const maxR = Math.max(1, ...postes.map((p) => p.rounds));
  const t = time;
  const visible = (s: number) => t === null || s <= t;
  const cross = (x: number, y: number, s: number, color: string, w: number) => <path d={`M${x - s},${y - s}L${x + s},${y + s}M${x + s},${y - s}L${x - s},${y + s}`} stroke={color} strokeWidth={w} />;
  return (
    <div className="ln-mapwrap">
      {map.levels.length > 1 && (
        <div className="gr-levels map-pills" role="group" aria-label="Niveau">
          {map.levels.map((l) => <button key={l.name} type="button" className={`pill ${level === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>{l.name === "lower" ? "Bas" : l.name === "upper" ? "Haut" : l.name}</button>)}
        </div>
      )}
      <svg ref={svg} className="gr-svg" viewBox={`${view.x} ${view.y} ${view.s} ${view.s}`} data-testid="poste-map"
        onWheel={(e) => {
          const r = svg.current!.getBoundingClientRect();
          const fx = view.x + ((e.clientX - r.left) / r.width) * view.s, fy = view.y + ((e.clientY - r.top) / r.height) * view.s;
          const s = Math.min(RADAR_SIZE, Math.max(128, view.s * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
          setView({ s, x: fx - ((fx - view.x) * s) / view.s, y: fy - ((fy - view.y) * s) / view.s });
        }}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; }}
        onMouseMove={(e) => {
          if (!drag.current) return;
          const r = svg.current!.getBoundingClientRect(), f = view.s / r.width;
          setView((v) => ({ ...v, x: drag.current!.vx - (e.clientX - drag.current!.x) * f, y: drag.current!.vy - (e.clientY - drag.current!.y) * f }));
        }}
        onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}>
        <image href={`/maps/${image}`} x={0} y={0} width={RADAR_SIZE} height={RADAR_SIZE} />
        {postes.filter((p) => onLevel(p.pos)).map((p) => {
          const [x, y] = P(p.pos), r = (8 + 16 * Math.sqrt(p.rounds / maxR)) * k;
          return (
            <g key={p.place} className="ln-pt" onClick={() => onPick(p.place)} data-testid="poste-dot">
              <circle cx={x} cy={y} r={r} fill="var(--accent)" fillOpacity={0.25} stroke="var(--accent)" strokeWidth={1.5 * k} />
              <text x={x} y={y - r - 4 * k} textAnchor="middle" fontSize={15 * k} className="ln-label">{posteLabel(p)} · {p.rounds}</text>
            </g>
          );
        })}
        {spot && onLevel(spot.pos) && (() => { const [x, y] = P(spot.pos); return <circle cx={x} cy={y} r={30 * k} fill="none" stroke="var(--accent)" strokeWidth={2 * k} strokeDasharray={`${4 * k} ${3 * k}`} />; })()}
        {layers.path && entries.map((e, i) => {
          const pts = (t === null ? e.path : e.path.slice(0, Math.floor(t / TL_STEP) + 1)).filter(onLevel);
          return <polyline key={`p${i}`} points={pts.map((v) => P(v).join(",")).join(" ")} fill="none"
            stroke={e.steamid === me ? "#fff" : e.won ? "var(--ok)" : "var(--error)"} strokeOpacity={0.35} strokeWidth={1.2 * k} />;
        })}
        {layers.nades && entries.flatMap((e) => e.grenades.filter((g) => g.land && g.type !== "decoy" && onLevel(g.land) && visible(g.time_s)).map((g, j) => {
          const [x, y] = P(g.land!);
          return <circle key={`n${e.match_id}-${e.round_number}-${e.steamid}-${j}`} cx={x} cy={y} r={5 * k} fill={NADE[g.type].color} fillOpacity={0.35} stroke={NADE[g.type].color} strokeWidth={k} />;
        }))}
        {layers.kills && entries.flatMap((e) => e.kills_detail.filter((x) => onLevel(x.victim_pos) && visible(x.time_s)).map((x, j) => {
          const [vx, vy] = P(x.victim_pos), a = x.pos ? P(x.pos) : null;
          return (
            <g key={`k${e.match_id}-${e.round_number}-${e.steamid}-${j}`}>
              {a && <line x1={a[0]} y1={a[1]} x2={vx} y2={vy} stroke="var(--ok)" strokeOpacity={0.45} strokeWidth={k} strokeDasharray={`${3 * k} ${2 * k}`} />}
              {cross(vx, vy, 3.5 * k, "var(--ok)", 1.6 * k)}
            </g>
          );
        }))}
        {layers.deaths && entries.filter((e) => e.death && onLevel(e.death.pos) && visible(e.death.time_s)).map((e, i) => {
          const [x, y] = P(e.death!.pos), a = e.death!.attacker_pos ? P(e.death!.attacker_pos) : null;
          return (
            <g key={`d${i}`} className="ln-death">
              {a && <line x1={a[0]} y1={a[1]} x2={x} y2={y} stroke="var(--error)" strokeOpacity={0.45} strokeWidth={k} strokeDasharray={`${3 * k} ${2 * k}`} />}
              {a && <circle cx={a[0]} cy={a[1]} r={2.5 * k} fill="var(--error)" />}
              {cross(x, y, 4 * k, e.steamid === me ? "#fff" : "var(--error)", 2 * k)}
            </g>
          );
        })}
        {layers.pos && entries.map((e, i) => {
          const p = t === null ? e.pos : posAt(e, t);
          if (!p || !onLevel(p)) return null;
          const [x, y] = P(p);
          const yaw = t === null && e.yaw !== null ? (-e.yaw * Math.PI) / 180 : null;
          return (
            <g key={`s${i}`} data-testid="poste-pos">
              {yaw !== null && <line x1={x} y1={y} x2={x + Math.cos(yaw) * 14 * k} y2={y + Math.sin(yaw) * 14 * k} stroke="#fff" strokeOpacity={0.6} strokeWidth={k} />}
              <circle cx={x} cy={y} r={(e.steamid === me ? 5 : 4) * k} fill={e.won ? "var(--ok)" : "var(--error)"}
                stroke={e.steamid === me ? "#fff" : "#000"} strokeWidth={(e.steamid === me ? 2 : 1) * k} />
            </g>
          );
        })}
      </svg>
      {!postes.length && !entries.length && <p className="st-legend ln-empty">Aucune donnée.</p>}
    </div>
  );
}
