import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { fromHere } from "../../shared/backLink";
import { api } from "../../shared/api/client";
import type { PlaybookGroup } from "../../shared/api/types";
import { clockHint } from "../../shared/roundTime";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { ctRotationCount, DEFAULT_KIND_LABEL, engageParts } from "./defaultPhases";
import { Term } from "./scoutUi";

const NOT_MEASURABLE = "Non mesurable : les sites A et B sont trop proches sur cette carte";
const CAT_CLASS: Record<string, string> = { rush: "pb-rush", execute: "pb-exec", split: "pb-exec", fake: "pb-exec", default: "pb-default", eco: "pb-eco" };

/** Ouvre le premier round d'un groupe avec les autres superposés (analyse multi-rounds). */
function useOverlay() {
  const nav = useNavigate();
  return async (roundIds: number[]) => {
    if (!roundIds.length) return;
    const first = await api.replay(roundIds[0]);  // donne match et numéro du premier round (déjà en cache ensuite)
    nav(`/matches/${first.match_id}/replay/${first.round.number}?${roundIds.length > 1 ? `layers=${roundIds.slice(1).join(",")}&` : ""}${fromHere()}`);
  };
}

/** Ligne d'un groupe (catégorie T, setup CT) ; en sous-ligne (`sub`), une fin de default sous la ligne Default, avec ses
 *  propres testids pour ne pas changer les comptes de `pb-group` et `pb-rounds`. */
function GroupRow({ g, cls, onOverlay, rounds, label, sub, testId = "pb-group" }: {
  g: PlaybookGroup; cls?: string; onOverlay: () => void; rounds?: string; label?: ReactNode; sub?: boolean; testId?: string;
}) {
  return (
    <div className={`pb-row ${sub ? "pb-sub" : ""}`} data-testid={testId}>
      {sub ? <span className="pb-sub-label">{label ?? g.label}</span> : <span className={`pb-tag ${cls ?? ""}`}>{label ?? g.label}</span>}
      <div className="sc-bar"><i style={{ width: `${g.pct}%` }} /></div>
      <span className="mono pb-pct" title={sub ? "Part de tous les rounds T" : undefined}>{g.pct.toFixed(0)}%</span>
      <span className="mono pb-n" title="Rounds gagnés / joués">{g.won}/{g.n}</span>
      <span className={`mono pb-win ${g.win_pct >= 50 ? "pos" : "neg"}`}>{g.win_pct.toFixed(0)}% V</span>
      {rounds ? <Link className="btn btn-sm btn-ghost" to={rounds} title={sub ? "Lister ces rounds" : "Lister ces rounds (filtre par tactique)"} data-testid={sub ? "pb-kind-rounds" : "pb-rounds"}><Icon name="rounds" />Rounds</Link> : <span />}
      <button type="button" className="btn btn-sm btn-ghost" onClick={onOverlay} title="Voir ces rounds superposés dans le replay"><Icon name="layers" />Superposer</button>
    </div>
  );
}

export function PlaybookSection({ teamId, mapName }: { teamId: number; mapName: string }) {
  const pb = useQuery({ queryKey: ["playbook", teamId, mapName], queryFn: () => api.playbook(teamId, mapName) });
  const overlay = useOverlay();
  if (pb.isLoading) return <Spinner />;
  if (!pb.data) return null;
  const { t, ct } = pb.data;
  const tacticUrl = (tactic: string) => `/rounds?${new URLSearchParams({ team: String(teamId), map: mapName, tactic })}`;
  const kinds = (t.default_kinds ?? []).filter((k) => k.n > 0);
  const engaged = engageParts(t.engage_by_site);
  const rotation = ctRotationCount(t.list);
  return (
    <div className="pb" data-testid="playbook">
      <div className="pb-col">
        <div className="sc-heat-head"><b className="sc-t">T</b> Façon de jouer · {t.rounds} round{t.rounds > 1 ? "s" : ""}
          <span className="pb-meta mono">{t.avg_contact_s != null && `contact moy. ${t.avg_contact_s.toFixed(0)} s`}{t.avg_plant_s != null && ` · pose moy. ${t.avg_plant_s.toFixed(0)} s`}</span></div>
        {t.categories.map((g) => (
          <div key={g.key}>
            <GroupRow g={g} cls={CAT_CLASS[g.key]} onOverlay={() => overlay(g.rounds)} rounds={tacticUrl(`t:${g.key}`)} />
            {t.sites_by_category[g.key] && g.key !== "eco" && (
              <div className="pb-sites">{Object.entries(t.sites_by_category[g.key]).map(([s, n]) => <span key={s}>{s === "none" ? "Sans site" : `Site ${s}`} <b className="mono">{n}</b></span>)}</div>
            )}
            {g.key === "default" && !!kinds.length && (
              <div className="pb-kinds" data-testid="pb-default-kinds" title="Comment finissent leurs rounds Default">
                {kinds.map((k) => (
                  <GroupRow key={k.key} sub testId="pb-kind" g={{ ...k, pct: (100 * k.n) / Math.max(1, t.rounds) }}
                    label={<Term k={`default_${k.key}`}>{DEFAULT_KIND_LABEL[k.key]}</Term>}
                    rounds={tacticUrl(`t:default::${k.key}`)} onOverlay={() => overlay(k.rounds)} />
                ))}
              </div>
            )}
          </div>
        ))}
        {t.rounds > 0 && (!!engaged.length || rotation.armed > 0) && (
          <div className="pb-defense" data-testid="site-engage">
            {!!engaged.length && <span className="rf-label">Prise des sites</span>}
            {engaged.map((e) => (
              <div key={e.site} className="pb-def-row">
                <b>Site {e.site}</b>
                <span><span className="mono">{e.n}</span> prise{e.n > 1 ? "s" : ""}</span>
                <span title={clockHint(e.median_s)}>méd. <span className="mono">{e.median_s.toFixed(0)} s</span></span>
                <span title="Rounds gagnés après une prise de ce site">gagnés <b className={`mono ${2 * e.won >= e.n ? "pos" : "neg"}`}>{e.won}/{e.n}</b></span>
              </div>
            ))}
            {rotation.armed > 0 && <p className="pb-rot" data-testid="pb-ct-rotation"><Term k="ctrot">Rotation CT provoquée</Term> dans <b className="mono">{rotation.rot}</b> round{rotation.rot > 1 ? "s" : ""} sur <span className="mono">{rotation.armed}</span> hors eco</p>}
          </div>
        )}
        {!t.rounds && <p className="cm-empty">Aucun round T avec positions sur cette carte.</p>}
      </div>
      <div className="pb-col">
        <div className="sc-heat-head"><b className="sc-ct">CT</b> Setups à 20 s · {ct.rounds} round{ct.rounds > 1 ? "s" : ""}</div>
        {ct.setups.slice(0, 8).map((g) => <GroupRow key={g.key} g={g} onOverlay={() => overlay(g.rounds)} rounds={tacticUrl(`ct:${g.key}`)} />)}
        {ct.rounds > 0 && (
          <div className="pb-defense" data-testid="site-defense">
            <span className="rf-label">Défense des sites</span>
            {Object.entries(ct.sites).map(([site, d]) => (
              <div key={site} className="pb-def-row">
                <b>Site {site}</b>
                <span>{d.attacked} attaque{d.attacked > 1 ? "s" : ""}</span>
                <span title="Rounds gagnés sans laisser poser la bombe">tenu <b className={`mono ${d.hold_pct >= 50 ? "pos" : "neg"}`}>{d.held}/{d.attacked}</b></span>
                <span title="Rounds gagnés après une pose sur ce site">retake <b className="mono">{d.retakes_won}/{d.plants}</b></span>
              </div>
            ))}
          </div>
        )}
        {!ct.rounds && <p className="cm-empty">Aucun round CT avec positions sur cette carte.</p>}
      </div>
      <details className="pb-details">
        <summary>Détail des rounds T</summary>
        <table className="st-table pb-table">
          <thead><tr><th className="sb-name">Round</th><th className="sb-name">Adversaire</th><th className="sb-name">Type</th><th>Site</th><th>Contact</th>
            <th title="Prise du site : au moins 3 T tiennent A ou B pendant 1 s, la pose, ou un T tué sur le site avec un coéquipier à côté (le premier des trois)">Prise</th>
            <th>Pose</th><th title="Moment où un CT venu de l'autre site arrive près du site pressé (dans les 15 s après la pression)">Rotation CT</th><th>Utilitaires</th><th>Résultat</th></tr></thead>
          <tbody>
            {t.list.map((x) => (
              <tr key={x.round_id} data-testid="pb-t-row">
                <td className="sb-name"><Link className="pl-link" to={`/matches/${x.match_id}/replay/${x.number}?${fromHere()}`}>R{x.number}</Link></td>
                <td className="sb-name rf-dim">{x.opponent}</td>
                <td className="sb-name"><span className={`pb-tag ${CAT_CLASS[x.category]}`}>{t.categories.find((c) => c.key === x.category)?.label ?? x.category}</span>
                  {x.default_kind && <small className="rf-dim"> {DEFAULT_KIND_LABEL[x.default_kind]}</small>}</td>
                <td className="mono">{x.site ?? "—"}</td>
                <td className="mono">{x.contact_s != null ? `${x.contact_s.toFixed(0)} s` : "—"}</td>
                <td className="mono" data-testid="pb-engage" title={x.engage_s != null ? clockHint(x.engage_s) : "Pas de prise du site"}>
                  {x.engage_s != null ? `${x.engage_s.toFixed(0)} s${x.engage_site ? ` · ${x.engage_site}` : ""}` : "—"}</td>
                <td className="mono">{x.plant_s != null ? `${x.plant_s.toFixed(0)} s` : "—"}</td>
                <td className="mono" data-testid="pb-rotation" title={!x.rotation_measurable ? NOT_MEASURABLE : x.ct_rotation_s != null ? clockHint(x.ct_rotation_s) : "Aucune rotation CT"}>
                  {x.rotation_measurable && x.ct_rotation_s != null ? `${x.ct_rotation_s.toFixed(0)} s` : "—"}</td>
                <td className="mono">{x.util_before}</td>
                <td className={`mono ${x.won ? "pos" : "neg"}`}>{x.won ? "Gagné" : "Perdu"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
