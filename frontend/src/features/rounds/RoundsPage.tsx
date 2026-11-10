import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../shared/api/client";
import { useUrlParams } from "../../shared/useUrlParams";
import type { RoundHit } from "../../shared/api/types";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon, type IconName } from "../../shared/ui/Icon";
import { Skeleton } from "../../shared/ui/Skeleton";
import { AddToPlaylist } from "../playlists/AddToPlaylist";
import { LIB_KEYS, LibraryFilterBar } from "../library/LibraryFilters";
import { formatDate, weaponLabel } from "../../shared/format";
import { DemoSelect } from "../library/DemoSelect";
import { DEFAULT_KIND_LABEL } from "../scouting/defaultPhases";
import "../match/match.css";
import "./rounds.css";

export const BUYS = [["pistol", "Pistol"], ["eco", "Eco"], ["semi", "Semi"], ["force", "Force"], ["full", "Full"]] as const;
const BUY_LABEL = Object.fromEntries(BUYS) as Record<string, string>;
export const END_REASON: Record<string, string> = {
  ct_killed: "Élimination", t_killed: "Élimination", bomb_exploded: "Explosion", bomb_defused: "Désamorçage",
  target_saved: "Temps écoulé", time_ran_out: "Temps écoulé", ct_surrender: "Abandon", t_surrender: "Abandon",
};

type Opt = readonly [string | undefined, string];
function Pills({ label, value, options, onChange }: { label: string; value?: string; options: readonly Opt[]; onChange: (v?: string) => void }) {
  return (
    <div className="rf-group">
      <span className="rf-label">{label}</span>
      <div className="map-pills" role="group" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={v ?? "all"} type="button" className={`pill ${value === v ? "on" : ""} ${v === "CT" ? "pill-ct" : v === "T" ? "pill-t" : ""}`}
            onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

/** Sélection multiple (types d'achat) : valeur CSV dans l'URL. */
function MultiPills({ label, value, options, onChange }: { label: string; value?: string; options: readonly (readonly [string, string])[]; onChange: (v?: string) => void }) {
  const set = new Set(value ? value.split(",") : []);
  const toggle = (v: string) => { set.has(v) ? set.delete(v) : set.add(v); onChange(set.size ? [...set].join(",") : undefined); };
  return (
    <div className="rf-group">
      <span className="rf-label">{label}</span>
      <div className="map-pills" role="group" aria-label={label}>
        <button type="button" className={`pill ${!set.size ? "on" : ""}`} onClick={() => onChange(undefined)}>Tous</button>
        {options.map(([v, l]) => <button key={v} type="button" className={`pill ${set.has(v) ? "on" : ""}`} onClick={() => toggle(v)}>{l}</button>)}
      </div>
    </div>
  );
}

const KEYS = ["map", "match", "team", "opponent", "side", "buy", "opp_buy", "result", "bomb", "half", "pistol", "quick", "weapon", "tactic", ...LIB_KEYS] as const;
const QUICK = [["pistol", "Pistols"], ["second", "2e rounds"], ["opening_won", "Ouverture gagnée"], ["opening_lost", "Ouverture perdue"],
  ["clutch_won", "Clutch gagné"], ["eco_won", "Éco gagnée"], ["commented", "Commentés"], ["annotated", "Annotés"]] as const;

export function RoundsPage() {
  const [params, setUrl] = useUrlParams();
  const f = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? undefined])) as Record<(typeof KEYS)[number], string | undefined>;
  // la tactique dépend de l'équipe et de la carte : elle est effacée quand l'une ou l'autre change
  const set = (k: string, v?: string) => setUrl(k === "team" && !v ? { team: null, result: null, opponent: null, tactic: null }
    : k === "map" ? { map: v, tactic: null, match: null } : k === "team" ? { [k]: v, tactic: null } : { [k]: v });
  const nav = useNavigate();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams });
  const weaponList = useQuery({ queryKey: ["round-weapons", f.map ?? ""], queryFn: () => api.roundWeapons(f.map) });
  // tactiques détectées par le playbook de l'équipe sur cette carte (filtre « Tactique » d'EDGE)
  const pb = useQuery({ queryKey: ["playbook", f.team, f.map], queryFn: () => api.playbook(Number(f.team), f.map!), enabled: !!f.team && !!f.map });
  const SITE = (s: string) => (s === "none" ? "sans site" : `site ${s}`);
  const tactics = pb.data ? [
    ...pb.data.t.categories.flatMap((c) => [
      { value: `t:${c.key}`, label: `T · ${c.label} (${c.n})` },
      ...Object.entries(pb.data!.t.sites_by_category[c.key] ?? {}).filter(([, n]) => n > 0 && c.n > n)
        .map(([site, n]) => ({ value: `t:${c.key}:${site}`, label: `T · ${c.label} ${SITE(site)} (${n})` })),
      // fins du default : « t:default::<sous-type> »
      ...(c.key === "default" ? (pb.data!.t.default_kinds ?? []).map((k) => ({ value: `t:default::${k.key}`, label: `T · Default ${DEFAULT_KIND_LABEL[k.key]} (${k.n})` })) : []),
    ]),
    ...pb.data.ct.setups.map((g) => ({ value: `ct:${g.key}`, label: `CT · placement ${g.label} (${g.n})` })),
  ] : [];
  // « Pistols » est un préfiltre visuel mais un filtre à part côté API (pistol=true)
  const quickSet = new Set([...(f.quick ? f.quick.split(",") : []), ...(f.pistol === "true" ? ["pistol"] : [])]);
  const toggleQuick = (q: string) => {
    if (q === "pistol") { set("pistol", f.pistol === "true" ? undefined : "true"); return; }
    const n = new Set(f.quick ? f.quick.split(",") : []);
    n.has(q) ? n.delete(q) : n.add(q);
    set("quick", n.size ? [...n].join(",") : undefined);
  };
  const res = useQuery({ queryKey: ["round-search", f], queryFn: () => api.searchRounds(f), placeholderData: (prev) => prev });
  // filtres secondaires repliés par défaut ; ouverts d'office si l'un d'eux est actif
  const ADVANCED = ["opponent", "weapon", "half", "bomb", "buy", "opp_buy", ...LIB_KEYS] as const;
  const advancedCount = ADVANCED.filter((k) => f[k as keyof typeof f]).length;
  const [moreState, setMore] = useState<boolean | null>(null);
  const moreOpen = moreState ?? advancedCount > 0;
  const rows = res.data?.rounds ?? [];
  const pov = !!(f.team || f.side);
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const ids = useMemo(() => rows.filter((r) => selected.has(r.id)).map((r) => r.id), [rows, selected]);
  const active = KEYS.some((k) => f[k]);

  return (
    <div className="page">
      <div className="lib-head">
        <div>
          <div className="eyebrow">Matchs</div>
          <h1 className="display">Rounds <span className="lib-count mono">{res.data?.total ?? 0}</span></h1>
        </div>
        <div className="lib-tools">
          {active && <button type="button" className="btn btn-ghost" onClick={() => setUrl(Object.fromEntries(KEYS.map((k) => [k, null])))}><Icon name="refresh" />Réinitialiser</button>}
          <button type="button" className="btn" disabled={ids.length < 2} data-testid="overlay-selection"
            title="Ouvrir le premier round sélectionné avec les autres superposés (même carte)"
            onClick={() => {
              const sel = rows.filter((r) => selected.has(r.id));
              const first = sel[0], rest = sel.slice(1).filter((r) => r.match.map_name === first.match.map_name);
              if (rest.length < sel.length - 1) setNotice("Seuls les rounds de la même carte que le premier sont superposés.");
              nav(`/matches/${first.match.id}/replay/${first.number}?layers=${rest.map((r) => r.id).join(",")}`);
            }}><Icon name="layers" />Superposer ({ids.length})</button>
          <AddToPlaylist roundIds={ids} onDone={(m) => { setNotice(m); setSelected(new Set()); }} />
        </div>
      </div>

      <section className="panel rf-panel">
        <div className="rf-group">
          <span className="rf-label">Carte</span>
          <div className="map-pills" role="group" aria-label="Carte">
            <button type="button" className={`pill ${!f.map ? "on" : ""}`} onClick={() => set("map")}>Toutes</button>
            {maps.data?.map((m) => <button key={m.name} type="button" className={`pill ${f.map === m.name ? "on" : ""}`} onClick={() => set("map", m.name)}>{m.display_name}</button>)}
          </div>
        </div>
        <div className="rf-row">
          <label className="rf-group">
            <span className="rf-label">Équipe</span>
            <select className="rf-select" value={f.team ?? ""} onChange={(e) => set("team", e.target.value || undefined)}>
              <option value="">Toutes les équipes</option>
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.matches})</option>)}
            </select>
          </label>
          <Pills label="Camp" value={f.side} onChange={(v) => set("side", v)} options={[[undefined, "Tous"], ["CT", "CT"], ["T", "T"]]} />
          <Pills label="Résultat" value={f.result} onChange={(v) => set("result", v)}
            options={pov ? [[undefined, "Tous"], ["won", "Gagnés"], ["lost", "Perdus"]] : [[undefined, "Tous"]]} />
          <DemoSelect map={f.map} value={f.match} onChange={(v) => set("match", v)} />
          <label className="rf-group" title={!f.team || !f.map ? "Choisissez une équipe et une carte" : "Tactiques détectées automatiquement (playbook)"}>
            <span className="rf-label">Tactique</span>
            <select className="rf-select" value={f.tactic ?? ""} disabled={!f.team || !f.map} onChange={(e) => set("tactic", e.target.value || undefined)}
              aria-label="Tactique" data-testid="tactic-filter">
              <option value="">{!f.team || !f.map ? "Équipe + carte d'abord" : "Toutes les tactiques"}</option>
              {tactics.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
        </div>
        <div className="rf-group">
          <span className="rf-label">Préfiltres</span>
          <div className="map-pills" role="group" aria-label="Préfiltres">
            {QUICK.map(([q, l]) => (
              <button key={q} type="button" className={`pill ${quickSet.has(q) ? "on" : ""}`} aria-pressed={quickSet.has(q)} onClick={() => toggleQuick(q)}>{l}</button>
            ))}
          </div>
          {pov ? null : <span className="st-legend">Choisissez une équipe ou un camp pour que « ouverture » et « gagné » se lisent de son point de vue.</span>}
        </div>
        <div className="rf-more-bar">
          <button type="button" className="btn btn-sm btn-ghost" aria-expanded={moreOpen} onClick={() => setMore(!moreOpen)} data-testid="more-filters">
            <Icon name={moreOpen ? "up" : "down"} />Plus de filtres{advancedCount ? ` (${advancedCount} actif${advancedCount > 1 ? "s" : ""})` : ""}</button>
        </div>
        {moreOpen && (<>
          <div className="rf-row">
            <label className="rf-group">
              <span className="rf-label">Adversaire</span>
              <select className="rf-select" value={f.opponent ?? ""} disabled={!f.team} onChange={(e) => set("opponent", e.target.value || undefined)}>
                <option value="">Tous</option>
                {teams.data?.filter((t) => String(t.id) !== f.team).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="rf-group">
              <span className="rf-label">Kill à l'arme</span>
              <select className="rf-select" value={f.weapon ?? ""} onChange={(e) => set("weapon", e.target.value || undefined)} aria-label="Arme">
                <option value="">Toutes les armes</option>
                {weaponList.data?.map((w) => <option key={w.weapon} value={w.weapon}>{weaponLabel(w.weapon)} ({w.kills})</option>)}
              </select>
            </label>
            <Pills label="Mi-temps" value={f.half} onChange={(v) => set("half", v)}
              options={[[undefined, "Toutes"], ["first", "1re"], ["second", "2e"], ["ot", "Prol."]]} />
            <Pills label="Bombe" value={f.bomb} onChange={(v) => set("bomb", v)}
              options={[[undefined, "Toutes"], ["planted", "Posée"], ["A", "Site A"], ["B", "Site B"], ["none", "Non posée"]]} />
          </div>
          <div className="rf-row">
            <MultiPills label={pov ? "Achat" : "Achat (un des camps)"} value={f.buy} onChange={(v) => set("buy", v)} options={BUYS} />
            {pov && <MultiPills label="Achat adverse" value={f.opp_buy} onChange={(v) => set("opp_buy", v)} options={BUYS} />}
          </div>
          <LibraryFilterBar />
        </>)}
      </section>
      {notice && <div className="notice" onClick={() => setNotice(null)}>{notice}</div>}

      <section className="panel rf-results" aria-busy={res.isFetching}>
        {res.isLoading ? <Skeleton rows={10} /> : !rows.length ? <EmptyState icon="rounds" title="Aucun round">Aucun round ne correspond à ces filtres.</EmptyState> : (
          <table className="st-table rf-table">
            <thead>
              <tr>
                <th className="rf-check"><input type="checkbox" aria-label="Tout sélectionner" checked={allOn}
                  onChange={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                <th>Round</th><th>Score</th><th className="sb-name">Achats</th><th className="sb-name">Vainqueur</th><th className="sb-name">Fin</th>
                <th>Bombe</th><th>Kills</th><th>Durée</th><th />
              </tr>
            </thead>
            {groupByMatch(rows).map((g) => (
              <tbody key={g.match.id} className="rf-match" data-testid="round-group">
                <tr className="rf-mhead">
                  <td colSpan={10}><div className="rf-mhead-in">
                    <span className="rf-map"><img src={`/maps/${g.match.map_name}.png`} alt="" loading="lazy" />{g.match.map_display_name}</span>
                    <Link className="rf-mlink" to={`/matches/${g.match.id}`} title="Ouvrir le match">
                      {g.match.team_a.name} <b className="mono rf-score">{g.match.score_a}:{g.match.score_b}</b> {g.match.team_b.name}</Link>
                    <span className="rf-dim">{formatDate(g.match.date ?? g.match.imported_at)}</span>
                    <span className="rf-dim rf-count">{g.rounds.length} round{g.rounds.length > 1 ? "s" : ""}</span>
                  </div></td>
                </tr>
                {g.rounds.map((r) => <Row key={r.id} r={r} checked={selected.has(r.id)} onToggle={() => toggle(r.id)} />)}
              </tbody>
            ))}
          </table>
        )}
        {res.data && res.data.total > rows.length && <p className="st-legend">{rows.length} premiers rounds affichés sur {res.data.total} : affinez les filtres.</p>}
      </section>
    </div>
  );
}

const END_ICON: Record<string, IconName> = { ct_killed: "skull", t_killed: "skull", bomb_exploded: "bomb", bomb_defused: "defuse",
  target_saved: "pause", time_ran_out: "pause" };

/** Les rounds affichés, regroupés par match dans l'ordre d'arrivée : le match n'est écrit qu'une fois, en tête de groupe. */
function groupByMatch(rows: RoundHit[]): { match: RoundHit["match"]; rounds: RoundHit[] }[] {
  const out: { match: RoundHit["match"]; rounds: RoundHit[] }[] = [];
  for (const r of rows) {
    const g = out[out.length - 1];
    if (g && g.match.id === r.match.id) g.rounds.push(r); else out.push({ match: r.match, rounds: [r] });
  }
  return out;
}

function Row({ r, checked, onToggle }: { r: RoundHit; checked: boolean; onToggle: () => void }) {
  const m = r.match;
  const name = (id: number) => (id === m.team_a.id ? m.team_a.name : m.team_b.name);
  const prevA = r.score_a_after - (r.winner_team_id === m.team_a.id ? 1 : 0);
  const prevB = r.score_b_after - (r.winner_team_id === m.team_b.id ? 1 : 0);
  const navigate = useNavigate();
  const won = r.pov_side ? r.winner_side === r.pov_side : null;
  const end = r.end_reason ?? "";
  return (
    <tr data-testid="round-hit" className={`rf-hit ${won === true ? "won" : won === false ? "lost" : ""} ${checked ? "rf-sel" : ""}`}
      title="Ouvrir le replay de ce round"
      onClick={(e) => { if (!(e.target as HTMLElement).closest("a, button, input, label")) navigate(`/matches/${m.id}/replay/${r.number}`); }}>
      <td className="rf-check"><input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Sélectionner le round ${r.number}`} /></td>
      <td className="rf-num"><b>{r.number}</b>{r.number === 1 || r.number === 13 ? <small>pistol</small> : null}</td>
      <td className="mono rf-dim">{prevA}:{prevB}</td>
      <td className="sb-name rf-buys">
        <span className="rf-buy ct" title={`${name(r.ct_team_id)} — ${r.ct_equip_value} $`}><i>CT</i>{BUY_LABEL[r.ct_buy_type] ?? r.ct_buy_type}</span>
        <span className="rf-buy t" title={`${name(r.t_team_id)} — ${r.t_equip_value} $`}><i>T</i>{BUY_LABEL[r.t_buy_type] ?? r.t_buy_type}</span>
      </td>
      <td className="sb-name">
        {r.winner_side && <span className={`rf-winner ${r.winner_side.toLowerCase()}`}><i className={`badge badge-${r.winner_side.toLowerCase()}`}>{r.winner_side}</i>{name(r.winner_team_id!)}</span>}
        {won !== null && <span className={`rf-res ${won ? "pos" : "neg"}`} title={won ? "Round gagné (de votre point de vue)" : "Round perdu (de votre point de vue)"}>{won ? "Gagné" : "Perdu"}</span>}
      </td>
      <td className="sb-name rf-dim"><span className="rf-end">{END_ICON[end] && <Icon name={END_ICON[end]} size={14} />}{END_REASON[end] ?? end ?? "—"}</span>
        {r.pov_side && r.clutch?.[r.pov_side] && r.winner_side === r.pov_side && <span className="rf-clutch" title="Clutch gagné">1v{r.clutch[r.pov_side]}</span>}</td>
      <td>{r.bomb_planted ? <span className="rf-site">{r.bomb_site ?? "✓"}</span> : <span className="rf-dim">—</span>}</td>
      <td className="mono">{r.kills}</td>
      <td className="mono rf-dim">{Math.floor(r.duration_s / 60)}:{String(Math.round(r.duration_s % 60)).padStart(2, "0")}</td>
      <td><Link className="btn btn-sm btn-ghost" to={`/matches/${m.id}/replay/${r.number}`} title="Voir le replay"><Icon name="play" /></Link></td>
    </tr>
  );
}
