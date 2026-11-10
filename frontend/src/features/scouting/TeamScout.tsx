import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { BriefLine, BriefPistols, ScoutBrief, ScoutReport, Stat } from "../../shared/api/types";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { AiReport } from "./AiReport";
import { ScoutData } from "./ScoutingPage";
import { NADE_COLORS, PLAYER_COLORS, SpotsRadar, UtilRadar } from "./SpotsRadar";
import { Count, DefaultKinds, Dots, EngageSites, LEVEL, Term, type Mode } from "./scoutUi";
import { fromHere } from "../../shared/backLink";
import { ScoutHeat } from "./ScoutHeat";
import { NotesPanel } from "../notes/NotesPanel";
import "./scouting.css";
import { clockHint, gameClock } from "../../shared/roundTime";

/** Fiche de scouting d'une équipe : chiffres clés en tuiles, « à retenir » et « comment les jouer » côte à côte, puis le
 *  détail par carte en tableaux avec barres (styles d'attaque, placements, grenades) et les joueurs en cartes compactes.
 *  Chaque chiffre reste un comptage « k sur n » avec sa fiabilité. */

type Side = "all" | "T" | "CT";
type Tab = "resume" | "carte" | "revoir" | "joueurs" | "donnees";
const MODE_KEY = "sl-scout-mode";
const sideVisible = (side: Side, s: "T" | "CT") => side === "all" || side === s;

/** Liste dépliable des rounds cités, avec un lien vers le replay 2D (et retour ici). */
function RoundsToWatch({ ids, b, label = "Revoir" }: { ids: number[]; b: ScoutBrief; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!ids.length) return null;
  return (
    <span className="ts-rounds">
      <button type="button" className="pl-link ts-linkbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="play" size={12} /> {label} ({ids.length})
      </button>
      {open && (
        <span className="ts-round-list">
          {ids.slice(0, 12).map((id) => {
            const r = b.round_index[String(id)];
            return r ? <Link key={id} className={`ts-round ${r[2] ? "w" : "l"}`} to={`/matches/${r[0]}/replay/${r[1]}?${fromHere()}`} title={r[2] ? "Round gagné par eux" : "Round perdu par eux"}>R{r[1]}<span className="sr-only">{r[2] ? " gagné" : " perdu"}</span></Link> : null;
          })}
        </span>
      )}
    </span>
  );
}

/** Tuile « chiffre clé » : grand pourcentage, libellé, k sur n, fiabilité. */
function Kpi({ label, s, side, hint }: { label: string; s: Stat; side?: "T" | "CT"; hint?: string }) {
  return (
    <div className={`ts-kpi ${side ? side.toLowerCase() : ""}`} title={hint}>
      <span className="ts-kpi-label">{side && <span className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</span>}{label}</span>
      <b className={`ts-kpi-value display ${s.n ? s.tone : "none"}`}>{s.n ? `${s.pct} %` : "—"}</b>
      <span className="ts-kpi-sub mono">{s.n ? `${s.k} sur ${s.n}` : "aucun round"}{s.n ? <Dots s={s} /> : null}</span>
    </div>
  );
}

function KpiValue({ label, value, sub, side, hint }: { label: string; value: ReactNode; sub?: ReactNode; side?: "T" | "CT"; hint?: string }) {
  return (
    <div className={`ts-kpi ${side ? side.toLowerCase() : ""}`} title={hint}>
      <span className="ts-kpi-label">{side && <span className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</span>}{label}</span>
      <b className="ts-kpi-value display">{value}</b>
      {sub && <span className="ts-kpi-sub mono">{sub}</span>}
    </div>
  );
}

/** Ligne de tableau avec barre de part : libellé, k sur n, barre, gagnés. */
function ShareRow({ label, s, won, extra, b, mode }: { label: ReactNode; s: Stat; won?: Stat; extra?: ReactNode; b: ScoutBrief; mode: Mode }) {
  return (
    <tr>
      <td className="ts-td-label">{label}{extra}</td>
      <td className="ts-td-share"><span className="ts-share"><i style={{ width: `${s.pct ?? 0}%` }} /></span></td>
      <td className="mono ts-td-n">{s.k}<small className="rf-dim">/{s.n}</small> <small>({s.pct ?? 0} %)</small></td>
      <td className={`mono ts-td-won ${won && won.n ? won.tone : ""}`}>{won && won.n ? `${won.pct} %` : "—"}</td>
      <td className="ts-td-meta"><Dots s={s} />{mode === "advanced" && <RoundsToWatch ids={s.rounds} b={b} />}</td>
    </tr>
  );
}

function Line({ l, b, mode }: { l: BriefLine; b: ScoutBrief; mode: Mode }) {
  return (
    <li className={`ts-line ${l.side === "CT" ? "ct" : "t"}`}>
      <span className={`ts-side ${l.side === "CT" ? "sc-ct" : "sc-t"}`}>{l.side}</span>
      <span className="ts-line-text">{l.text}</span>
      <span className="ts-line-meta"><Dots s={l.stat} />{mode === "advanced" && <RoundsToWatch ids={l.stat.rounds} b={b} />}</span>
    </li>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ts-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

/** Site préféré en attaque, déduit des styles (plant ou majorité des T). */
function siteSplit(b: ScoutBrief): { A: number; B: number; none: number } {
  const out = { A: 0, B: 0, none: 0 };
  for (const s of b.t_styles) for (const [k, v] of Object.entries(s.sites)) out[(k === "A" || k === "B" ? k : "none") as "A" | "B" | "none"] += v;
  return out;
}

// ------------------------------------------------------------------------------------------------ onglets
function Resume({ r, b, mode, side, setMap }: { r: ScoutReport; b: ScoutBrief; mode: Mode; side: Side; setMap: (m: string) => void }) {
  const take = b.takeaways.filter((l) => sideVisible(side, l.side));
  const counters = b.counters.filter((l) => sideVisible(side, l.side));
  const sites = siteSplit(b);
  const siteN = sites.A + sites.B;
  const fav = siteN ? (sites.A === sites.B ? "A = B" : sites.A > sites.B ? "A" : "B") : "—";
  return (
    <>
      <section className="ts-kpis" data-testid="ts-kpis">
        {sideVisible(side, "T") && <Kpi label="Rounds gagnés" side="T" s={b.sides.T} />}
        {sideVisible(side, "CT") && <Kpi label="Rounds gagnés" side="CT" s={b.sides.CT} />}
        {sideVisible(side, "T") && <Kpi label="Pistol" side="T" s={b.pistols.T.result} hint="Round 1 et 13 en attaque" />}
        {sideVisible(side, "CT") && <Kpi label="Pistol" side="CT" s={b.pistols.CT.result} hint="Round 1 et 13 en défense" />}
        {sideVisible(side, "T") && <KpiValue label="Site visé" side="T" value={fav} sub={siteN ? `A ${Math.round((100 * sites.A) / siteN)} % · B ${Math.round((100 * sites.B) / siteN)} %` : "aucun round"} hint="Site de pose, sinon site le plus fréquenté par les T" />}
        {sideVisible(side, "T") && <KpiValue label="Premier contact" side="T" value={b.avg_contact_s != null ? gameClock(b.avg_contact_s) : "—"} sub={b.avg_contact_s != null ? `${Math.round(b.avg_contact_s)} s de jeu${b.avg_plant_s != null ? ` · plant vers ${gameClock(b.avg_plant_s)}` : ""}` : "aucun contact"} hint={`Horloge du jeu au moment moyen des premiers dégâts (le round commence à 1:55)${b.avg_contact_s != null ? ` : ${clockHint(b.avg_contact_s)}` : ""}`} />}
        {sideVisible(side, "CT") && <Kpi label="Site A tenu" side="CT" s={b.sites.A.held} hint="Site attaqué, pas de bombe posée, round gagné" />}
        {sideVisible(side, "CT") && <Kpi label="Site B tenu" side="CT" s={b.sites.B.held} hint="Site attaqué, pas de bombe posée, round gagné" />}
      </section>
      <p className="ts-legend st-legend" aria-label="Légende de la fiabilité">
        <span>{b.matches} match{b.matches > 1 ? "s" : ""} sur {b.display_name}{b.armed ? " · rounds armés contre armés seulement" : ""}</span>
        <span><Dots s={{ ...b.sides.T, level: "anecdotal" }} /> {LEVEL.anecdotal.label}</span>
        <span><Dots s={{ ...b.sides.T, level: "indicative" }} /> {LEVEL.indicative.label}</span>
        <span><Dots s={{ ...b.sides.T, level: "solid" }} /> {LEVEL.solid.label}</span>
        <span><b className="pos">vert</b> / <b className="neg">rouge</b> : nettement bon / mauvais pour eux</span>
      </p>
      <div className="ts-grid">
        <section className="panel section ts-card" data-testid="ts-takeaways">
          <h2 className="display ts-h">À retenir</h2>
          {take.length ? <ul className="ts-lines">{take.map((l, i) => <Line key={i} l={l} b={b} mode={mode} />)}</ul> : <p className="cm-empty">Pas assez de rounds pour en tirer des tendances.</p>}
        </section>
        <section className="panel section ts-card ts-counter" data-testid="ts-counters">
          <h2 className="display ts-h">Comment les jouer</h2>
          <p className="st-legend">Côté indiqué = votre camp. À adapter : une équipe peut changer de plan.</p>
          {counters.length ? <ul className="ts-lines">{counters.map((l, i) => <Line key={i} l={l} b={b} mode={mode} />)}</ul> : <p className="cm-empty">Aucune piste nette pour l'instant.</p>}
        </section>
        <NotesPanel className="ts-card ts-wide" title={`Vos notes contre ${r.team.name} sur ${b.display_name}`}
          filter={{ team: r.team.id, map: b.map }} draft={{ team_id: r.team.id, map: b.map }}
          empty={`Rien de noté contre ${r.team.name} sur ${b.display_name}. Une habitude repérée, un contre à essayer : notez-le ici ou depuis l'app.`} />
        <div className="ts-wide"><AiReport teamId={r.team.id} mapName={b.map} mode={mode} /></div>
        <section className="panel section ts-card ts-wide">
          <h2 className="display ts-h">Leurs cartes</h2>
          <div className="ts-maps">
            {r.maps.map((m) => (
              <button key={m.map} type="button" className={`ts-map panel ${m.map === b.map ? "on" : ""}`} onClick={() => setMap(m.map)} style={{ ["--radar" as string]: `url(/maps/${m.map}.png)` }}>
                <b className="display">{m.display_name}</b>
                <span>{m.won} victoire{m.won > 1 ? "s" : ""} sur {m.played} match{m.played > 1 ? "s" : ""}</span>
                <small className="mono">CT {Math.round(m.ct.win_pct)} % · T {Math.round(m.t.win_pct)} % des rounds gagnés</small>
              </button>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function PistolCard({ side, p, b, mode }: { side: "T" | "CT"; p: BriefPistols; b: ScoutBrief; mode: Mode }) {
  return (
    <div className={`ts-block ${side === "CT" ? "ct" : "t"}`}>
      <div className="ts-block-head"><h3 className="ts-h3"><span className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</span> <Term k="pistol">Pistol</Term> {side === "T" ? "en attaque" : "en défense"}</h3>
        <span className="ts-count-big"><Count s={p.result} mode={mode} /> <RoundsToWatch ids={p.result.rounds} b={b} /></span></div>
      {!!p.plays.length && (
        <table className="ts-table"><tbody>
          {p.plays.map((x) => <ShareRow key={x.key} label={x.label} s={x.count} b={b} mode={mode} />)}
        </tbody></table>
      )}
      <div className="ts-mini">
        {p.after_won && <span>Pistol gagné → round suivant gagné <Count s={p.after_won.won} mode={mode} /></span>}
        {side === "T" && (p.after_lost_planted || p.after_lost_unplanted) ? <>
          {p.after_lost_planted && <span data-testid="ts-plant-buy">Perdu avec la bombe posée → ils <Term k="plantbonus">achètent</Term> <Count s={p.after_lost_planted.bought} mode={mode} /></span>}
          {p.after_lost_unplanted && <span>Perdu sans poser → ils achètent <Count s={p.after_lost_unplanted.bought} mode={mode} /></span>}
        </> : p.after_lost && <span>Pistol perdu → ils <Term k="force">forcent</Term> <Count s={p.after_lost.bought} mode={mode} /></span>}
      </div>
    </div>
  );
}

function MapTab({ b, mode, side, teamId }: { b: ScoutBrief; mode: Mode; side: Side; teamId: number }) {
  const showT = sideVisible(side, "T"), showCT = sideVisible(side, "CT");
  // mode simple : les 4 styles les plus joués (l'ordre de l'API est fixe quand on garde tous les rounds)
  const styles = mode === "simple" ? b.t_styles.filter((s) => s.key !== "eco").sort((a, z) => z.count.k - a.count.k).slice(0, 4) : b.t_styles;
  const nUtil = mode === "simple" ? 5 : 8;
  return (
    <div className="ts-grid">
      {!b.armed && (
        <section className="panel section ts-card ts-wide">
          <h2 className="display ts-h">Pistols et économie</h2>
          <div className="ts-cols">
            {showT && <PistolCard side="T" p={b.pistols.T} b={b} mode={mode} />}
            {showCT && <PistolCard side="CT" p={b.pistols.CT} b={b} mode={mode} />}
          </div>
          <div className="ts-cols ts-guns">
            {(["T", "CT"] as const).filter((s) => sideVisible(side, s)).map((s) => (
              <p key={s} className="ts-gun"><span className={s === "CT" ? "sc-ct" : "sc-t"}>{s}</span> <Term k="gun">Premier round avec armes complètes</Term> gagné : <Count s={b.first_gun[s].result} mode={mode} /> <RoundsToWatch ids={b.first_gun[s].result.rounds} b={b} /></p>
            ))}
          </div>
        </section>
      )}
      {showT && (
        <section className="panel section ts-card" data-testid="ts-attack">
          <div className="ts-block-head"><h2 className="display ts-h"><span className="sc-t">T</span> Leur attaque <small className="st-legend">(votre défense)</small></h2>
            <span className="ts-count-big"><Count s={b.sides.T} mode={mode} /></span></div>
          <p className="st-legend">{b.avg_contact_s != null && <>Premier contact vers <b className="mono" title={clockHint(b.avg_contact_s)}>{gameClock(b.avg_contact_s)}</b> <small className="rf-dim">({Math.round(b.avg_contact_s)} s de jeu)</small></>}<EngageSites e={b.engage_by_site} first={b.avg_contact_s == null} />{b.avg_plant_s != null && <> · plant vers <b className="mono" title={clockHint(b.avg_plant_s)}>{gameClock(b.avg_plant_s)}</b> <small className="rf-dim">({Math.round(b.avg_plant_s)} s)</small></>}<small className="rf-dim"> · horloge du jeu, le round commence à 1:55</small></p>
          <h3 className="ts-h3">Leur façon d'attaquer</h3>
          <table className="ts-table" data-testid="ts-styles">
            <thead><tr><th>Style</th><th>Part des rounds</th><th /><th>Gagnés</th><th /></tr></thead>
            <tbody>
              {styles.map((s) => {
                const site = Object.entries(s.sites).sort((a, z) => z[1] - a[1])[0];
                return <ShareRow key={s.key} label={<Term k={s.key}>{s.label}</Term>} extra={<>{site && site[0] !== "none" ? <small className="rf-dim"> · surtout {site[0]} ({site[1]})</small> : null}<LibAvg s={s} />{s.kinds && <DefaultKinds kinds={s.kinds} />}</>} s={s.count} won={s.won} b={b} mode={mode} />;
              })}
            </tbody>
          </table>
          {b.ct_rotation && b.ct_rotation.n > 0 && <div className="ts-mini" data-testid="ts-ct-rotation"><span><Term k="ctrot">Rotation CT provoquée</Term> <Count s={b.ct_rotation} mode={mode} of="rounds sur" /></span></div>}
          <h3 className="ts-h3">Leurs grenades habituelles</h3>
          <UtilList list={b.utility.T.slice(0, nUtil)} mode={mode} b={b} />
        </section>
      )}
      {showCT && (
        <section className="panel section ts-card" data-testid="ts-defense">
          <div className="ts-block-head"><h2 className="display ts-h"><span className="sc-ct">CT</span> Leur défense <small className="st-legend">(votre attaque)</small></h2>
            <span className="ts-count-big"><Count s={b.sides.CT} mode={mode} /></span></div>
          <h3 className="ts-h3">Leur <Term k="setup">placement</Term> à 20 s</h3>
          <table className="ts-table" data-testid="ts-setups">
            <thead><tr><th>Placement</th><th>Part des rounds</th><th /><th>Gagnés</th><th /></tr></thead>
            <tbody>{b.ct_setups.slice(0, mode === "simple" ? 3 : 4).map((s) => <ShareRow key={s.setup} label={<span className="mono">{s.setup}</span>} extra={<LibAvg s={s} />} s={s.count} won={s.won} b={b} mode={mode} />)}</tbody>
          </table>
          <h3 className="ts-h3">Quand un site est attaqué</h3>
          <div className="ts-mini">
            {(["A", "B"] as const).map((k) => <span key={k}>Site {k} tenu <Count s={b.sites[k].held} mode={mode} /></span>)}
            {(["A", "B"] as const).map((k) => <span key={`r${k}`}>Retake {k} réussi <Count s={b.sites[k].retakes} mode={mode} /></span>)}
          </div>
          <h3 className="ts-h3">Leurs grenades habituelles</h3>
          <UtilList list={b.utility.CT.slice(0, nUtil)} mode={mode} b={b} />
        </section>
      )}
      <ScoutHeat mapName={b.map} teamId={teamId} side={side} armed={!!b.armed} />
    </div>
  );
}

/** « moy. biblio 18 % » : part du même style chez les autres équipes de la bibliothèque ; surligné si l'écart dépasse 15 points. */
function LibAvg({ s }: { s: { count: Stat; lib_pct?: number | null } }) {
  if (s.lib_pct == null || s.count.pct == null) return null;
  const gap = s.count.pct - s.lib_pct;
  return <small className={`ts-lib ${Math.abs(gap) >= 15 ? "far" : ""}`} data-testid="ts-lib"> · <Term k="biblio">moy. biblio {s.lib_pct} %</Term></small>;
}


/** Rounds à revoir, dans l'ordre d'un analyste : les stats repèrent, la démo confirme. Chaque groupe se rejoue superposé
 *  ou part dans une playlist pour la séance vidéo de l'équipe. */
function ReviewTab({ b, team, side }: { b: ScoutBrief; team: string; side: Side }) {
  const nav = useNavigate();
  const groups = (b.review ?? []).filter((g) => !g.side || sideVisible(side, g.side));
  const save = useMutation({
    mutationFn: async (g: { label: string; rounds: number[] }) => {
      const pl = await api.createPlaylist(`${team} · ${b.display_name} · ${g.label}`, `Rounds à revoir du scouting de ${team} sur ${b.display_name}.`);
      await api.addToPlaylist(pl.id, g.rounds);
      return pl;
    },
    onSuccess: (pl) => nav(`/playlists/${pl.id}`),
  });
  if (!groups.length) return <section className="panel section"><p className="cm-empty">Aucun round à revoir avec ces filtres.</p></section>;
  return (
    <>
      <p className="st-legend ts-review-intro">Méthode des analystes : les chiffres repèrent, la démo confirme. Chaque groupe garde un seul camp, pour superposer des rounds
        comparables : leurs pistols T entre eux, leurs pistols CT entre eux, puis leurs rounds armés, leurs forces et leurs prises de site. Cherchez ce qui revient d'un round à l'autre.</p>
      {(() => {
        const card = (g: (typeof groups)[number], i: number) => {
          const first = b.round_index[String(g.rounds[0])];
          const layers = g.rounds.slice(1, 25);
          const won = g.rounds.filter((id) => b.round_index[String(id)]?.[2]).length;
          const sideTxt = g.side === "CT" ? "en CT" : g.side === "T" ? "en T" : "";
          return (
            <section key={g.key} className={`panel section ts-card ts-review-group ${g.side === "CT" ? "ct" : g.side === "T" ? "t" : ""}`} data-testid="ts-review-group">
              <header className="ts-block-head">
                <h2 className="display ts-h"><b className="ts-num">{i + 1}</b>{g.side && <span className={g.side === "CT" ? "sc-ct" : "sc-t"}>{g.side}</span>} {g.label}</h2>
                <span className="mono st-legend">{g.rounds.length} round{g.rounds.length > 1 ? "s" : ""} · {won} gagné{won > 1 ? "s" : ""} par eux</span>
              </header>
              <p className="st-legend">{g.why}</p>
              <div className="ts-round-list">
                {g.rounds.slice(0, 30).map((id) => {
                  const r = b.round_index[String(id)];
                  return r ? <Link key={id} className={`ts-round ${r[2] ? "w" : "l"}`} to={`/matches/${r[0]}/replay/${r[1]}?${fromHere()}`} title={r[2] ? "Round gagné par eux" : "Round perdu par eux"}>R{r[1]}<span className="sr-only">{r[2] ? " gagné" : " perdu"}</span></Link> : null;
                })}
              </div>
              <div className="ts-review-actions">
                {first && <Link className="btn btn-sm btn-primary" to={`/matches/${first[0]}/replay/${first[1]}?${layers.length ? `layers=${layers.join(",")}&` : ""}${fromHere()}`} data-testid="ts-review-overlay">
                  <Icon name="layers" />{g.rounds.length > 1 ? `Superposer ces ${Math.min(25, g.rounds.length)} rounds ${sideTxt}` : "Rejouer"}</Link>}
                <button type="button" className="btn btn-sm btn-ghost" disabled={save.isPending} onClick={() => save.mutate(g)} data-testid="ts-review-playlist">
                  <Icon name="playlist" />Créer une playlist</button>
              </div>
            </section>
          );
        };
        // deux camps : leur attaque à gauche, leur défense à droite, groupe face à groupe (pistols T / pistols CT…)
        if (side === "all") {
          return (
            <div className="ts-review-cols" data-testid="ts-review">
              {(["T", "CT"] as const).map((s) => (
                <div key={s} className="ts-review-col">
                  <h2 className="display ts-h ts-review-colh"><span className={s === "CT" ? "sc-ct" : "sc-t"}>{s}</span> {s === "T" ? "Leur attaque" : "Leur défense"}</h2>
                  {groups.filter((g) => g.side === s).map((g, i) => card(g, i))}
                </div>
              ))}
            </div>
          );
        }
        return <div className="ts-review" data-testid="ts-review">{groups.map((g, i) => card(g, i))}</div>;
      })()}
      {save.isError && <p className="error">Playlist non créée : {(save.error as Error).message}</p>}
    </>
  );
}

const NADE_COLOR: Record<string, string> = { Smoke: "#b8c2cc", Flash: "#f5e16a", Molotov: "#ff7a3d", HE: "#7bd389" };

function UtilList({ list, mode, b }: { list: ScoutBrief["utility"]["T"]; mode: Mode; b: ScoutBrief }) {
  if (!list.length) return <p className="cm-empty">Aucune grenade récurrente.</p>;
  return (
    <div className="ts-util">
      <UtilRadar mapName={b.map} list={list} label={`Grenades habituelles sur ${b.display_name}`} />
      <table className="ts-table ts-util-table">
        <tbody>
          {list.map((u, i) => (
            <ShareRow key={i} label={<><b className="ts-num">{i + 1}</b><i className="sc-dot" style={{ background: NADE_COLORS[u.type] ?? NADE_COLOR[u.type] }} /><b>{u.type}</b> → {u.place}<small className="rf-dim"> · {u.players.join(", ")}</small></>} s={u.count} b={b} mode={mode} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ratingWord = (r: number) => (r >= 1.15 ? ["très bon", "pos"] : r >= 1.0 ? ["bon", "pos"] : r >= 0.9 ? ["moyen", ""] : ["en difficulté", "neg"]);

function PlayersTab({ r, b, mode, side, faceit }: { r: ScoutReport; b: ScoutBrief; mode: Mode; side: Side; faceit: Record<string, { level: number | null; elo: number | null }> }) {
  const [own, setOwn] = useState<"T" | "CT">("CT");
  const radarSide = side === "all" ? own : side;
  return (
    <>
    <section className="panel section ts-card ts-radar-card">
      <div className="ts-radar-head">
        <h2 className="display ts-h">Qui joue où <small className="st-legend">20 s après le début du round</small></h2>
        {side === "all" && <Seg label="Camp du radar" value={own} onChange={setOwn} options={[["CT", "En défense (CT)"], ["T", "En attaque (T)"]]} />}
      </div>
      <SpotsRadar mapName={b.map} players={b.players} side={radarSide} mode={mode} />
    </section>
    <div className="ts-players">
      {b.players.map((p, idx) => {
        const career = r.players.find((x) => x.steamid === p.steamid);
        const [word, tone] = career ? ratingWord(career.rating) : ["—", ""];
        const fc = faceit[p.name.toLowerCase()];
        return (
          <section key={p.steamid} className="panel section ts-player" data-testid="ts-player">
            <header>
              <Link className="display ts-pname pl-link" to={`/players/${p.steamid}`}><i className="ts-pcolor" style={{ background: PLAYER_COLORS[idx % PLAYER_COLORS.length] }} />{p.name}</Link>
              <span className="ts-badges">
                {p.awper && <span className="ts-badge awp"><Term k="awp">AWP</Term></span>}
                {b.entry === p.name && <span className="ts-badge entry"><Term k="entry">Entrée</Term></span>}
                {fc?.level != null && <span className="ts-badge" title={`ELO FACEIT ${fc.elo ?? "?"}`}>FACEIT niv. {fc.level}</span>}
              </span>
            </header>
            <dl className="ts-dl">
              {career && <><dt>Niveau</dt><dd><b className={tone}>{word}</b> <small className="st-legend mono">({career.rating.toFixed(2)}{mode === "advanced" ? ` · ADR ${career.adr.toFixed(0)} · KAST ${Math.round(career.kast <= 1 ? career.kast * 100 : career.kast)} % · K/D ${career.kills}/${career.deaths}${p.awp_kills ? ` · ${p.awp_kills} kills AWP` : ""}` : ""})</small></dd></>}
              {(["CT", "T"] as const).filter((s) => sideVisible(side, s)).map((s) => (
                <Fragment key={s}><dt><span className={s === "CT" ? "sc-ct" : "sc-t"}>{s}</span> à 20 s</dt>
                  <dd>{p.spots[s].length ? <><b>{p.spots[s][0].place}</b> <Count s={p.spots[s][0].count} mode={mode} of="rounds sur" />{mode === "advanced" && p.spots[s].slice(1).map((x) => <small key={x.place} className="st-legend"> · {x.place} {x.count.k}</small>)}</> : <span className="cm-empty">pas de poste fixe</span>}</dd></Fragment>
              ))}
              <dt><Term k="ouverture">Ouvertures</Term></dt><dd><Count s={p.opening} mode={mode} /></dd>
              {p.opening_attempts && <><dt><Term k="implication">1er duel</Term></dt><dd><Count s={p.opening_attempts} mode={mode} of="rounds sur" /></dd></>}
              {p.after_open_win && p.after_open_loss && (p.after_open_win.n > 0 || p.after_open_loss.n > 0) && <><dt>Round ensuite</dt>
                <dd className="ts-after-open" data-testid="ts-after-open">gagné {p.after_open_win.n ? <b className="pos">{p.after_open_win.k}/{p.after_open_win.n}</b> : "—"} s'il gagne son duel · {p.after_open_loss.n ? <b className="neg">{p.after_open_loss.k}/{p.after_open_loss.n}</b> : "—"} s'il le perd</dd></>}
            </dl>
          </section>
        );
      })}
    </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ page
export function TeamScoutPage() {
  const teamId = Number(useParams().teamId);
  const [params, setParams] = useSearchParams();
  const [mode, setModeState] = useState<Mode>(() => { try { return (localStorage.getItem(MODE_KEY) as Mode) || "simple"; } catch { return "simple"; } });
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* stockage indisponible */ } };
  const rep = useQuery({ queryKey: ["scout", teamId], queryFn: () => api.scoutReport(teamId), retry: false });
  const mapName = params.get("map") ?? rep.data?.maps[0]?.map;
  const tab = (params.get("tab") as Tab) || "resume";
  const side = (params.get("side") as Side) || "all";
  const armed = params.get("armed") === "1";
  const set = (k: string, v: string | undefined) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const brief = useQuery({ queryKey: ["scout-brief", teamId, mapName, armed], queryFn: () => api.scoutBrief(teamId, mapName!, armed), enabled: !!mapName, placeholderData: (p) => p });
  const fid = rep.data?.faceit_team_id;
  const faceit = useQuery({ queryKey: ["faceit-team", fid, "esea"], queryFn: () => api.faceitTeam(fid!, "esea"), enabled: !!fid, staleTime: 10 * 60_000, retry: false });
  useEffect(() => { if (mode === "simple" && tab === "donnees") set("tab", undefined); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rep.isLoading) return <div className="page"><Spinner /></div>;
  if (!rep.data) return <div className="page"><EmptyState title="Équipe introuvable" /></div>;
  const r = rep.data;
  const b = brief.data;
  const fcRoster = Object.fromEntries((faceit.data?.roster ?? []).map((p) => [p.nickname.toLowerCase(), { level: p.level, elo: p.elo }]));
  const ask = `Fais un rapport de scouting détaillé de l'équipe « ${r.team.name} » (scouting team_id ${r.team.id}${fid ? `, FACEIT ${fid}` : ""}) `
    + `pour notre prochain match, carte par carte : pistols T et CT, round après pistol, premier gun round, qui joue où, leur attaque, leur défense, `
    + `forces et faiblesses, puis comment les contrer. Utilise /api/scouting/teams/${r.team.id}/brief pour chaque carte et donne la fiabilité de chaque chiffre.`;
  const TABS: [Tab, string][] = [["resume", "Résumé"], ["carte", `Carte : ${b?.display_name ?? "…"}`], ["revoir", "Rounds à revoir"], ["joueurs", "Joueurs"], ...(mode === "advanced" ? [["donnees", "Toutes les données"] as [Tab, string]] : [])];
  return (
    <div className="page ts-page">
      <Link to="/scouting" className="back-link"><Icon name="back" />Scouting</Link>
      <header className="pl-hero panel sc-hero ts-hero">
        <div>
          <div className="eyebrow">Rapport de scouting</div>
          <h1 className="display pl-name" data-testid="ts-team">{r.team.name}</h1>
          <div className="pl-sub">{r.matches} match{r.matches > 1 ? "s" : ""} analysé{r.matches > 1 ? "s" : ""} : <b>{r.wins} gagné{r.wins > 1 ? "s" : ""}</b>, {r.matches - r.wins} perdu{r.matches - r.wins > 1 ? "s" : ""}
            {faceit.data && <> · FACEIT : {faceit.data.record.won} victoires sur {faceit.data.record.played} matchs ESEA</>}</div>
          <div className="sc-form" aria-label="Derniers matchs">
            {r.recent.map((m) => <Link key={m.id} to={`/matches/${m.id}`} className={`sc-chip ${m.result}`} title={`${m.score[0]}:${m.score[1]} contre ${m.opponent} — ${m.map_display_name}`}>{m.result === "W" ? "V" : m.result === "L" ? "D" : "N"}</Link>)}
          </div>
        </div>
        <div className="fc-actions">
          <Link className="btn btn-primary" to={`/match-prep`} data-testid="ts-prep"><Icon name="print" />Préparer le match</Link>
          <Link className="btn btn-ghost" to={`/assistant?q=${encodeURIComponent(ask)}`} data-testid="ts-ai"><Icon name="comment" />Poser une question à l'IA</Link>
          <Link className="btn btn-ghost" to={`/team-stats?team=${r.team.id}`} data-testid="ts-stats"><Icon name="team" />Stats d'équipe</Link>
          <Link className="btn btn-ghost" to={`/veto?b=${r.team.id}`}><Icon name="veto" />Préparer le veto</Link>
          {fid && <Link className="btn btn-ghost" to={`/scouting/faceit/${fid}`}>Fiche FACEIT</Link>}
        </div>
      </header>

      <div className="ts-bar panel" data-testid="ts-bar">
        <div className="ts-bar-maps" role="tablist" aria-label="Carte">
          {r.maps.map((m) => (
            <button key={m.map} type="button" role="tab" aria-selected={m.map === mapName} className={`ts-chip ${m.map === mapName ? "on" : ""}`} onClick={() => set("map", m.map)}>
              {m.display_name} <small>{m.played}</small>
            </button>
          ))}
        </div>
        <Seg label="Camp" value={side} onChange={(v) => set("side", v === "all" ? undefined : v)} options={[["all", "Les deux camps"], ["T", "Leur attaque (T)"], ["CT", "Leur défense (CT)"]]} />
        <Seg label="Rounds" value={armed ? "armed" : "all"} onChange={(v) => set("armed", v === "armed" ? "1" : undefined)} options={[["all", "Tous les rounds"], ["armed", "Armés contre armés"]]} />
        <Seg label="Niveau de détail" value={mode} onChange={setMode} options={[["simple", "Simple"], ["advanced", "Avancé"]]} />
      </div>

      <nav className="tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => set("tab", k === "resume" ? undefined : k)} data-testid={`ts-tab-${k}`}>{l}</button>)}
      </nav>

      {tab === "donnees" ? <ScoutData teamId={teamId} r={r} mapName={mapName} /> : brief.isLoading || !b ? <div className="ts-wait"><Spinner /><p className="st-legend">Analyse des rounds de la carte…</p></div> : (
        <div className={brief.isPlaceholderData ? "ts-stale" : ""}>
          {tab === "carte" ? <MapTab b={b} mode={mode} side={side} teamId={teamId} />
            : tab === "joueurs" ? <PlayersTab r={r} b={b} mode={mode} side={side} faceit={fcRoster} />
            : tab === "revoir" ? <ReviewTab b={b} team={r.team.name} side={side} />
              : <Resume r={r} b={b} mode={mode} side={side} setMap={(m) => set("map", m)} />}
        </div>
      )}
    </div>
  );
}
