import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { fromHere } from "../../shared/backLink";
import { api } from "../../shared/api/client";
import type { PlaybookRound, PlaybookTactic, Side, Tactic } from "../../shared/api/types";
import { ContextBar } from "../../shared/context/ContextBar";
import { useContextFilters } from "../../shared/context/useContextFilters";
import { formatDate } from "../../shared/format";
import { useUrlParams } from "../../shared/useUrlParams";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { DEFAULT_KIND_LABEL } from "../scouting/defaultPhases";
import "../scouting/scouting.css";
import "./playbook.css";

const TABS: [string, string][] = [["tactics", "Tactiques"], ["rounds", "Round par round"], ["manage", "Gérer"]];
const BUY: Record<string, string> = { full: "Full", force: "Force", semi: "Semi", eco: "Eco", pistol: "Pistol" };
export const clock = (s: number) => { const left = Math.max(0, 115 - s); return `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`; };

/** Ouvre le premier round d'une liste avec les autres superposés (analyse multi-rounds). */
function useOverlay() {
  const nav = useNavigate();
  return async (roundIds: number[]) => {
    if (!roundIds.length) return;
    const first = await api.replay(roundIds[0]);
    nav(`/matches/${first.match_id}/replay/${first.round.number}?${roundIds.length > 1 ? `layers=${roundIds.slice(1).join(",")}&` : ""}${fromHere()}`);
  };
}

function TacticRow({ t, total, bucket, onOverlay, onRounds, open }: { t: PlaybookTactic; total: number; bucket: string; onOverlay: () => void; onRounds: () => void; open: boolean }) {
  const used = bucket === "full" ? t.used : t.buckets[bucket] ?? 0;
  const pct = total ? Math.round((100 * used) / total) : 0;
  return (
    <div className={`pb2-row ${used ? "" : "pb2-unused"}`} data-testid="pb2-tactic">
      <button type="button" className="pb2-name" onClick={onRounds} aria-expanded={open} title="Voir les rounds">{t.name}{t.builtin && <small className="rf-dim"> auto</small>}</button>
      <div className="sc-bar"><i style={{ width: `${pct}%` }} /></div>
      <b className="mono pb2-pct">{pct}%</b>
      <span className="mono pb2-n" title="Rounds où la tactique est utilisée">{used}</span>
      <span className={`mono pb2-win ${t.used && t.win_pct >= 50 ? "pos" : t.used ? "neg" : "rf-dim"}`} title="Rounds gagnés quand elle est utilisée">{t.used ? `${t.win_pct}% V` : "—"}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onOverlay} disabled={!t.used} title="Superposer ces rounds dans le replay"><Icon name="layers" /></button>
    </div>
  );
}

function Tactics({ pb, teamId }: { pb: ReturnType<typeof api.playbook2> extends Promise<infer T> ? T : never; teamId: number }) {
  const [bucket, setBucket] = useState("full");
  const [open, setOpen] = useState<string | null>(null);
  const overlay = useOverlay();
  const total = pb.total;
  const openTactic = pb.categories.flatMap((c) => c.tactics).find((t) => String(t.id) === open);
  const rounds = openTactic ? pb.rounds.filter((r) => openTactic.rounds.includes(r.round_id)) : [];
  return (<>
    <div className="pb2-bar">
      <div className="ts-seg" role="radiogroup" aria-label="Tranche de temps">
        {[["full", "Tout le round"], ...pb.buckets.map((b) => [b, b.replace("-", "–")])].map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={bucket === k} className={bucket === k ? "on" : ""} onClick={() => setBucket(k)}>{l}</button>
        ))}
      </div>
      <span className="st-legend">{total} round{total > 1 ? "s" : ""} {pb.side} analysé{total > 1 ? "s" : ""} · Utilisée = part des rounds où la tactique est déclenchée{bucket !== "full" ? " dans cette tranche" : ""}.</span>
      <Link className="btn btn-sm" to={`/playbook/editor?map=${pb.map}&side=${pb.side}&team=${teamId}`} data-testid="pb2-new"><Icon name="book" />Nouvelle tactique</Link>
    </div>
    {!pb.categories.length ? <EmptyState icon="book" title="Aucune tactique">Créez une tactique (zones, utilitaires, pose, contact) : elle sera détectée dans tous les rounds de toutes les équipes.</EmptyState> : (
      <div className="pb2-cats">
        {pb.categories.map((c) => (
          <section key={c.key} className="panel section pb2-cat" data-testid="pb2-category">
            <h2 className="section-title">{c.label} <span className="rf-dim">{c.tactics.length}</span></h2>
            <div className="pb2-rows">
              {c.tactics.map((t) => <TacticRow key={t.id} t={t} total={total} bucket={bucket} open={open === String(t.id)} onOverlay={() => void overlay(t.rounds)} onRounds={() => setOpen(open === String(t.id) ? null : String(t.id))} />)}
            </div>
          </section>
        ))}
      </div>
    )}
    {openTactic && (
      <section className="panel section" data-testid="pb2-rounds-of">
        <div className="lb-head"><h2 className="section-title">{openTactic.name} · {rounds.length} round{rounds.length > 1 ? "s" : ""}</h2><Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Fermer</Button></div>
        <RoundsTable rounds={rounds} highlight={String(openTactic.id)} side={pb.side} />
      </section>
    )}
    <div className="pl-grid">
      <section className="panel section" data-testid="pb2-tempo">
        <h2 className="section-title">Tempo d'attaque</h2>
        <p className="st-legend">Quand l'attaque arrive sur le site (pose, sinon premier contact), {pb.tempo.rounds} rounds hors eco.</p>
        <div className="tst-bars">
          {pb.tempo.buckets.map((b) => <div key={b.label} className="tst-bar"><span className="mono">{b.label.replace("-", "–")}</span><div className="tst-track"><i style={{ width: `${(100 * b.n) / Math.max(1, pb.tempo.rounds)}%` }} /></div><b className="mono">{Math.round((100 * b.n) / Math.max(1, pb.tempo.rounds))}%</b><small className="rf-dim mono">{b.n}</small></div>)}
        </div>
      </section>
      <section className="panel section" data-testid="pb2-sites">
        <h2 className="section-title">Sites attaqués</h2>
        <div className="tst-bars">
          {(["A", "B", "none"] as const).map((k) => <div key={k} className="tst-bar"><span className="mono">{k === "none" ? "aucun" : `Site ${k}`}</span><div className="tst-track"><i className={k === "none" ? "dim" : ""} style={{ width: `${(100 * pb.sites[k]) / Math.max(1, pb.sites.rounds)}%` }} /></div><b className="mono">{Math.round((100 * pb.sites[k]) / Math.max(1, pb.sites.rounds))}%</b><small className="rf-dim mono">{pb.sites[k]}</small></div>)}
        </div>
      </section>
    </div>
  </>);
}

function RoundsTable({ rounds, highlight, side }: { rounds: PlaybookRound[]; highlight?: string; side?: Side }) {
  const isT = side === "T";
  return (
    <table className="st-table pf-table pb2-table" data-testid="pb2-rounds">
      <thead><tr><th>Round</th><th>Issue</th><th className="sb-name">Économie</th><th className="sb-name">Adversaire</th><th className="sb-name">Date</th>
        {isT && <th title="Prise du site : au moins 3 T tiennent A ou B pendant 1 s, la pose, ou un T tué sur le site avec un coéquipier à côté">Prise</th>}
        <th className="sb-name">Séquence de tactiques</th><th /></tr></thead>
      <tbody>
        {rounds.map((r) => (
          <tr key={r.round_id} data-testid="pb2-round">
            <td className="mono"><b>{r.number}</b></td>
            <td className={`mono ${r.won ? "pos" : "neg"}`}>{r.won ? "V" : "D"}</td>
            <td className="sb-name">{BUY[r.buy] ?? r.buy} <span className="rf-dim">vs {BUY[r.opp_buy] ?? r.opp_buy}</span></td>
            <td className="sb-name">{r.opponent}</td>
            <td className="sb-name mono">{formatDate(r.date)}</td>
            {isT && <td className="mono">{r.engage_s != null ? `${clock(r.engage_s)}${r.engage_site ? ` · ${r.engage_site}` : ""}` : "—"}</td>}
            <td className="sb-name pb2-seq">{r.sequence.length ? r.sequence.map((s, i) => (
              <span key={i} className={`pb2-chip ${String(s.tactic) === highlight ? "on" : ""}`}>{s.name} {s.tactic === "auto:default" && r.default_kind
                ? <small>· {DEFAULT_KIND_LABEL[r.default_kind]}</small> : <small className="mono">({clock(s.at_s)})</small>}</span>
            )) : <span className="rf-dim">—</span>}</td>
            <td><Link className="btn btn-sm btn-ghost" to={`/matches/${r.match_id}/replay/${r.number}?${fromHere()}`} title="Replay en 2D"><Icon name="play" /></Link></td>
          </tr>
        ))}
        {!rounds.length && <tr><td colSpan={isT ? 8 : 7} className="st-legend">Aucun round.</td></tr>}
      </tbody>
    </table>
  );
}

function Manage({ map, side, team }: { map: string; side: Side; team: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tactics", map, side], queryFn: () => api.tactics({ map, side }) });
  const del = async (t: Tactic) => {
    if (!window.confirm(`Supprimer la tactique « ${t.name} » ?`)) return;
    await api.deleteTactic(Number(t.id));
    qc.invalidateQueries({ queryKey: ["tactics"] }); qc.invalidateQueries({ queryKey: ["playbook2"] });
  };
  const rows = q.data ?? [];
  return (
    <section className="panel section">
      <div className="lb-head"><h2 className="section-title">Tactiques définies · {map.replace("de_", "")} · {side}</h2>
        <Link className="btn btn-sm btn-primary" to={`/playbook/editor?map=${map}&side=${side}&team=${team}`}><Icon name="book" />Nouvelle tactique</Link></div>
      <p className="st-legend">Une tactique est propre à une carte et un camp, et s'applique à toutes les équipes : définissez votre jeu, puis regardez ce que l'adversaire fait des mêmes zones.</p>
      <table className="st-table pf-table" data-testid="pb2-manage">
        <thead><tr><th className="sb-name">Nom</th><th className="sb-name">Catégorie</th><th className="sb-name">Conditions</th><th className="sb-name">Tags</th><th /></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} data-testid="pb2-manage-row">
              <td className="sb-name"><b>{t.name}</b>{t.description && <div className="rf-dim pb2-desc">{t.description}</div>}</td>
              <td className="sb-name">{t.category_label}</td>
              <td className="sb-name rf-dim">{t.definition.conditions.map((c) => COND_LABEL[c.kind]).join(" + ")}</td>
              <td className="sb-name">{t.tags.map((x) => <span key={x} className="pill pb2-tag">{x}</span>)}</td>
              <td className="pb2-actions"><Link className="btn btn-sm btn-ghost" to={`/playbook/editor/${t.id}?team=${team}`}>Modifier</Link><Button size="sm" variant="ghost" onClick={() => void del(t)} aria-label={`Supprimer ${t.name}`}><Icon name="trash" /></Button></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="st-legend">Aucune tactique définie pour cette carte et ce camp.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

export const COND_LABEL: Record<string, string> = { players_in_zone: "joueurs dans une zone", utility_in_zone: "utilitaires dans une zone", bomb_planted: "bombe posée", contact_before: "contact avant", no_contact_before: "pas de contact avant" };

export function PlaybookPage() {
  const ctx = useContextFilters();
  const [params, set] = useUrlParams();
  const tab = TABS.some(([k]) => k === params.get("tab")) ? params.get("tab")! : "tactics";
  const side: Side = ctx.side ?? "T";
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams, staleTime: 60_000 });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const ready = !!ctx.team && !!ctx.map;
  const pb = useQuery({ queryKey: ["playbook2", ctx.team, ctx.map, side, ctx.lib], queryFn: () => api.playbook2(ctx.team!, { map: ctx.map, side, ...ctx.lib }), enabled: ready, placeholderData: (prev) => prev });
  const teamName = useMemo(() => teams.data?.find((t) => t.id === ctx.team)?.name, [teams.data, ctx.team]);
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Adversaires</div><h1 className="display">Playbook{teamName ? <> <span className="lib-count">{teamName}</span></> : ""}</h1></div>
      </div>
      <ContextBar ctx={ctx} />
      {!ready ? (
        <section className="panel section"><EmptyState icon="book" title="Choisissez une équipe et une carte">Le playbook se lit par équipe, par carte et par camp (T par défaut).</EmptyState>
          <div className="dash-pick pb2-pick">
            <select className="rf-select" value={ctx.team ?? ""} onChange={(e) => ctx.set("team", e.target.value)} aria-label="Équipe du playbook"><option value="">Équipe…</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            <select className="rf-select" value={ctx.map ?? ""} onChange={(e) => ctx.set("map", e.target.value)} aria-label="Carte du playbook"><option value="">Carte…</option>{maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}</select>
          </div>
        </section>
      ) : (<>
        <nav className="tabs" role="tablist" data-testid="pb2-tabs">
          {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => set("tab", k === "tactics" ? null : k)}>{l}</button>)}
        </nav>
        {tab === "manage" ? <Manage map={ctx.map!} side={side} team={ctx.team!} /> : pb.isLoading || !pb.data ? <Spinner /> : tab === "rounds" ? (
          <section className="panel section"><RoundsTable rounds={pb.data.rounds} side={pb.data.side} /></section>
        ) : <Tactics pb={pb.data} teamId={ctx.team!} />}
      </>)}
    </div>
  );
}
