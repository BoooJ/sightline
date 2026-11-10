import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useDashboard, useGoals, useProfile } from "@/api/hooks";
import { useMySteamid, useMyTeamState } from "@/api/me";
import type { DashComparison, ProfileAvg, TeamGoalT } from "@/api/types";
import { NoPlayer, noDemoYet } from "@/components/NoPlayer";
import { t } from "@/i18n/fr";
import { num, pct, shortDate, signed } from "@/lib/format";
import { trendSummary } from "@/lib/trend";
import { Tag } from "@/ui/Badges";
import { DeltaBar } from "@/ui/charts/Bars";
import { LineChart } from "@/ui/charts/LineChart";
import { ListGroup, ListRow } from "@/ui/ListRow";
import { Screen } from "@/ui/Screen";
import { Section } from "@/ui/Section";
import { Segmented } from "@/ui/Segmented";
import { StatGrid, StatTile } from "@/ui/StatTile";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, radius, space } from "@/ui/theme";

type Period = "10" | "20" | "all";
// mesures où « moins » vaut mieux (morts par round)
const LOWER_IS_BETTER = new Set(["dpr", "deaths_pr"]);

function formatMetric(key: string, v: number): string {
  if (key.endsWith("_pct") || key === "kast") return pct(v);
  if (key === "adr" || key === "utility_pr") return num(v, key === "adr" ? 0 : 1);
  return num(v);
}

/** Ma progression : rating match par match, mes derniers matchs contre les précédents, moi contre les autres. */
export default function Progress() {
  const sid = useMySteamid();
  const dash = useDashboard(sid);
  const profile = useProfile(sid);
  const team = useMyTeamState();
  const goals = useGoals(team.id);
  const [period, setPeriod] = useState<Period>("10");

  const trend = dash.data?.trend ?? [];
  const shown = period === "all" ? trend : trend.slice(-Number(period));
  const values = shown.map((p) => p.rating);
  const summary = values.length ? trendSummary(values, Math.min(5, Math.max(1, Math.floor(values.length / 2)))) : null;
  const avg = values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  const player = dash.data?.player;
  const activeGoals = (goals.data ?? []).filter((g) => !g.archived);
  const now = new Date();

  return (
    <Screen title={t.progress.title} subtitle={player ? `${player.name} · ${player.team}` : undefined}
      onRefresh={() => void Promise.all([dash.refetch(), profile.refetch(), team.id !== null ? goals.refetch() : null])} refreshing={dash.isRefetching}>
      {!sid || noDemoYet(dash.error) ? <NoPlayer linked={!!sid} />
        : dash.isPending ? <Loading /> : dash.isError ? <ErrorState error={dash.error} onRetry={() => void dash.refetch()} /> : (
        <View>
          <Section label={t.progress.rating}>
            <View style={styles.panel}>
              <Segmented<Period> value={period} onChange={setPeriod}
                items={[{ value: "10", label: t.progress.period[10] }, { value: "20", label: t.progress.period[20] }, { value: "all", label: t.progress.period.all }]} />
              {values.length === 0 ? <EmptyState text={t.matches.noPlayed} /> : (
                <>
                  <LineChart
                    points={shown.map((p) => ({ value: p.rating, good: p.won }))} average={avg}
                    firstLabel={shortDate(shown[0].date, now)} lastLabel={shortDate(shown[shown.length - 1].date, now)}
                    summary={summary ? t.progress.chartSummary(num(summary.recent), summary.before === null ? null : num(summary.before), summary.direction) : ""}
                  />
                  <View style={styles.legend}>
                    <View style={styles.legendItem}><View style={[styles.dot, { backgroundColor: color.good }]} /><Txt v="caption">{t.common.win}</Txt></View>
                    <View style={styles.legendItem}><View style={[styles.dot, { backgroundColor: color.bad }]} /><Txt v="caption">{t.common.loss}</Txt></View>
                  </View>
                </>
              )}
            </View>
          </Section>

          <Section label={t.progress.recentVsBefore}
            lead={profile.data?.progression.previous ? t.progress.recentVsBeforeLead(profile.data.progression.n) : t.progress.noPrevious}>
            {profile.data?.progression.recent ? <Periods recent={profile.data.progression.recent} previous={profile.data.progression.previous} /> : null}
          </Section>

          {dash.data && dash.data.comparisons.length ? (
            <Section label={t.progress.library}>
              <View style={styles.panel}>
                {dash.data.comparisons.map((c) => (
                  <DeltaBar key={c.key} label={c.label} value={formatMetric(c.key, c.value)} deltaPct={c.delta_pct}
                    better={LOWER_IS_BETTER.has(c.key) ? "down" : "up"} />
                ))}
              </View>
              <View style={styles.pair}>
                <Highlights title={t.progress.strengths} list={dash.data.strengths} tone={color.good} />
                <Highlights title={t.progress.weaknesses} list={dash.data.weaknesses} tone={color.bad} />
              </View>
            </Section>
          ) : null}

          {dash.data && dash.data.maps.length ? (
            <Section label={t.progress.maps}>
              <ListGroup>
                {dash.data.maps.map((m) => (
                  <ListRow key={m.map} title={m.display_name} subtitle={`${t.common.matches(m.matches)} · ${t.common.winPct(pct(m.win_pct))}`} value={num(m.rating)} />
                ))}
              </ListGroup>
            </Section>
          ) : null}

          <Section label={t.progress.goals}>
            {/* équipe inconnue (aucun match) : pas de requête, donc pas de chargement sans fin */}
            {team.pending || goals.isLoading ? <Loading blocks={1} />
              : goals.isError ? <ErrorState error={goals.error} onRetry={() => void goals.refetch()} />
                : activeGoals.length === 0 ? <EmptyState text={team.id === null ? t.progress.noTeam : t.progress.noGoals} />
                  : activeGoals.map((g) => <GoalCard key={g.id} g={g} />)}
          </Section>
        </View>
      )}
    </Screen>
  );
}

function Periods({ recent, previous }: { recent: ProfileAvg; previous: ProfileAvg | null }) {
  const d = (a: number, b: number | undefined, digits: number, points = false) => (b === undefined ? null
    : { text: points ? t.common.points(signed(a - b, digits)) : signed(a - b, digits), sign: Math.sign(Number((a - b).toFixed(digits))) });
  return (
    <StatGrid>
      <StatTile label={t.common.stats.rating} value={num(recent.rating)} delta={d(recent.rating, previous?.rating, 2)} hint={t.common.matches(recent.matches)} />
      <StatTile label={t.common.stats.adr} value={num(recent.adr, 0)} delta={d(recent.adr, previous?.adr, 0)} />
      <StatTile label={t.common.stats.kast} value={pct(recent.kast)} delta={d(recent.kast, previous?.kast, 0, true)} />
      <StatTile label={t.common.stats.dpr} value={num(recent.dpr)} delta={d(recent.dpr, previous?.dpr, 2)} better="down" />
    </StatGrid>
  );
}

function Highlights({ title, list, tone }: { title: string; list: DashComparison[]; tone: string }) {
  if (!list.length) return null;
  return (
    <View style={styles.highlight}>
      <Txt v="label" color={tone}>{title}</Txt>
      {list.map((c) => <Txt key={c.key} v="subhead" color={color.text}>{c.label}</Txt>)}
    </View>
  );
}

const STATUS_TONE: Record<string, string> = { better: color.good, worse: color.bad, flat: color.text2, early: color.text3, waiting: color.text3 };

function GoalCard({ g }: { g: TeamGoalT }) {
  const status = g.status ?? "waiting";
  return (
    <View style={styles.panel} accessible accessibilityLabel={`${g.title}, ${t.progress.goalStatus[status]}`}>
      <View style={styles.goalHead}>
        <Txt v="headline" style={styles.flex}>{g.title}</Txt>
        <Tag label={t.progress.goalStatus[status]} tone={STATUS_TONE[status]} />
      </View>
      <Txt v="caption">{g.metric_label}</Txt>
      <View style={styles.goalRow}>
        <View>
          <Txt v="caption">{t.progress.before}</Txt>
          <Txt v="data">{pct(g.before?.pct)}</Txt>
        </View>
        <Txt v="data" color={color.text3}>→</Txt>
        <View>
          <Txt v="caption">{t.progress.after}</Txt>
          <Txt v="data" color={STATUS_TONE[status]}>{pct(g.after?.pct)}</Txt>
        </View>
        {g.target != null ? (
          <View style={styles.target}>
            <Txt v="caption">{t.progress.target}</Txt>
            <Txt v="data">{`${g.better === "down" ? "≤" : "≥"} ${pct(g.target)}`}</Txt>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  panel: { backgroundColor: color.surface2, borderRadius: radius.card, padding: space.lg, gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  legend: { flexDirection: "row", gap: space.lg },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  pair: { flexDirection: "row", gap: space.sm },
  highlight: { flex: 1, backgroundColor: color.surface2, borderRadius: radius.card, padding: space.md, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  goalHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  goalRow: { flexDirection: "row", alignItems: "flex-end", gap: space.lg },
  target: { marginLeft: "auto", alignItems: "flex-end" },
});
