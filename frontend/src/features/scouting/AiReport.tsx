import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { AiScoutReport, ReportBlock, ReportFact, ReportSection, Stat } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Markdown } from "../assistant/Markdown";
import { useAuth } from "../team/auth";
import { Count, type Mode } from "./scoutUi";

/** Rapport de scouting rédigé par l'IA à partir de la fiche de faits ; chaque chiffre a été vérifié par le logiciel. */

const asStat = (f: ReportFact): Stat | null => (f.k == null || f.n == null ? null : {
  k: f.k, n: f.n, pct: f.pct ?? null, lo: f.lo ?? 0, hi: f.hi ?? 100, level: f.level ?? "none", tone: "neutral", rounds: [],
});

function Sources({ ids, facts, mode }: { ids: string[]; facts: Record<string, ReportFact>; mode: Mode }) {
  const [open, setOpen] = useState(false);
  const list = ids.map((id) => facts[id]).filter(Boolean);
  if (!list.length) return null;
  return (
    <div className="ai-sources">
      <button type="button" className="pl-link ts-linkbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="search" size={12} /> D'où viennent ces chiffres ({list.length})
      </button>
      {open && (
        <ul className="ts-list">
          {list.map((f) => {
            const s = asStat(f);
            return (
              <li key={f.id}>
                <span>{f.label}{f.examples?.length ? <small className="st-legend"> · {f.examples.join(" ; ")}</small> : null}</span>
                {s ? <Count s={s} mode={mode} /> : <b className="mono">{f.value}</b>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Block({ b, facts, mode }: { b: ReportBlock; facts: Record<string, ReportFact>; mode: Mode }) {
  // remarques du relecteur (juge) : « contredit » toujours, « non soutenu » en mode avancé
  const alerts = (b.alerts ?? []).filter((a) => a.verdict === "contredit" || mode === "advanced");
  return (
    <div className="ai-block">
      {b.title && <h3 className="ts-h3">{b.title}</h3>}
      <div className="ai-text"><Markdown text={b.text} /></div>
      {!!alerts.length && (
        <ul className="ai-alerts" data-testid="ai-alerts">
          {alerts.map((a, i) => (
            <li key={i}><Icon name="search" size={12} /> <b>À vérifier</b> {a.verdict === "contredit" ? "(contredit par les chiffres)" : "(pas appuyé par un chiffre)"} : « {a.claim} » — {a.reason}</li>
          ))}
        </ul>
      )}
      <Sources ids={b.fact_ids} facts={facts} mode={mode} />
    </div>
  );
}

function Section({ s, facts, mode }: { s: ReportSection; facts: Record<string, ReportFact>; mode: Mode }) {
  return (
    <section className="ai-section" data-testid="ai-section">
      <h2 className="display ts-h">{s.key === "summary" ? "Synthèse" : s.title}</h2>
      {s.blocks.map((b, i) => <Block key={i} b={b} facts={facts} mode={mode} />)}
    </section>
  );
}

export function AiReport({ teamId, mapName, mode }: { teamId: number; mapName: string | undefined; mode: Mode }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canMake = !user || user.role === "owner" || user.role === "admin";
  const [all, setAll] = useState(false);
  const [model, setModel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["ai-report", teamId], queryFn: () => api.aiReport(teamId),
    refetchInterval: (query) => ((query.state.data as AiScoutReport | null | undefined)?.status === "running" ? 3000 : false),
  });
  const make = async () => {
    setErr(null);
    try { await api.makeAiReport(teamId, model || undefined); await qc.invalidateQueries({ queryKey: ["ai-report", teamId] }); } catch (e) { setErr((e as Error).message); }
  };
  const r = q.data;
  const sections = r?.content.sections ?? [];
  const facts = r?.content.facts ?? {};
  const [openMap, setOpenMap] = useState(false);
  const mapSection = sections.find((s) => s.map === mapName);
  const shown = all ? sections : sections.filter((s) => s.key === "summary" || (openMap && s.map === mapName));
  return (
    <section className="panel section ts-card ts-wide ai-report" data-testid="ai-report">
      <div className="ai-head">
        <div>
          <h2 className="display ts-h"><Icon name="comment" /> Rapport de l'IA</h2>
          <p className="st-legend">Rédigé par l'IA à partir des chiffres ci-dessous ; le logiciel vérifie chaque nombre du texte et retire les phrases qui ne collent pas.</p>
        </div>
        {canMake && r?.status !== "running" && (
          <div className="ai-make">
            <select className="rf-select" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modèle de rédaction" title="Mesuré sur 9 rapports : Opus fait le moins d'erreurs, Haiku coûte 10 à 30 fois moins">
              <option value="">Modèle de l'assistant</option>
              <option value="claude-haiku-5-5">Économique (Haiku, ≈ 0,02 $)</option>
              <option value="claude-sonnet-5-5">Équilibré (Sonnet, ≈ 0,15–0,35 $)</option>
              <option value="claude-opus-5-5">Le plus fiable (Opus, ≈ 0,60–0,90 $)</option>
            </select>
            <Button variant={r ? "ghost" : "primary"} onClick={make} data-testid="ai-make">{r ? "Régénérer" : "Rédiger le rapport"}</Button>
          </div>
        )}
      </div>
      {err && <p className="auth-error" role="alert">{err}</p>}
      {q.isLoading ? <Spinner /> : !r ? (
        <p className="cm-empty">{canMake ? "Pas encore de rapport : « Rédiger le rapport » (1 à 2 minutes)." : "Pas encore de rapport : demandez à un administrateur de le générer."}</p>
      ) : r.status === "running" ? (
        <div className="ai-wait"><Spinner /><span>Rédaction en cours, carte par carte, puis vérification des chiffres…</span></div>
      ) : r.status === "error" ? (
        <p className="auth-error">{r.error}</p>
      ) : (
        <>
          {shown.map((s) => <Section key={s.key} s={s} facts={facts} mode={mode} />)}
          {!all && mapSection && (
            <Button variant={openMap ? "ghost" : "primary"} className="ai-open-map" onClick={() => setOpenMap(!openMap)} data-testid="ai-open-map">
              {openMap ? `Refermer l'analyse de ${mapSection.title}` : `Lire l'analyse détaillée de ${mapSection.title}`}</Button>
          )}
          <div className="ai-foot">
            {sections.length > shown.length || all ? (
              <button type="button" className="pl-link ts-linkbtn" onClick={() => setAll(!all)}>{all ? "Afficher seulement la carte choisie" : `Afficher tout le rapport (${sections.length - 1} cartes)`}</button>
            ) : <span />}
            <small className="st-legend" data-testid="ai-checks">
              {r.checks.numbers_checked ?? 0} chiffres vérifiés
              {r.checks.judge_alerts ? ` · ${r.checks.judge_alerts} point${r.checks.judge_alerts > 1 ? "s" : ""} à vérifier (relecture)` : r.checks.judge_alerts === 0 ? " · relu sans remarque" : ""}
              {r.checks.removed_sentences ? ` · ${r.checks.removed_sentences} phrase${r.checks.removed_sentences > 1 ? "s" : ""} retirée${r.checks.removed_sentences > 1 ? "s" : ""}` : " · aucune phrase retirée"}
              {mode === "advanced" && <> · {r.model}{r.cost_usd != null ? ` · ${r.cost_usd.toFixed(3)} $` : ""}{r.latency_s != null ? ` · ${Math.round(r.latency_s)} s` : ""}</>}
              {r.created_at && ` · ${new Date(r.created_at + "Z").toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`}
            </small>
          </div>
        </>
      )}
    </section>
  );
}
