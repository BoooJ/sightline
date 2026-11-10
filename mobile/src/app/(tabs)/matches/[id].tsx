import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Linking, StyleSheet, View } from "react-native";

import { API_BASE, SAME_ORIGIN, SERVER } from "@/api/config";
import { useAnalysis, useDashboard, useDebrief, useMatch } from "@/api/hooks";
import { useMyMatches, useMySteamid, useSeen } from "@/api/me";
import { useSession } from "@/api/session";
import type { AnalysisDeath, MatchDetail } from "@/api/types";
import { NotesSection } from "@/components/NotesSection";
import { t } from "@/i18n/fr";
import { costliestDeaths, reasonsOf } from "@/lib/deaths";
import { num, pct, shortDate, signed } from "@/lib/format";
import { AIM_ZONE_LABEL, AIM_ZONES, placeLabel, weaponLabel } from "@/lib/labels";
import { ResultBadge, Tag } from "@/ui/Badges";
import { Button } from "@/ui/Button";
import { SplitBar } from "@/ui/charts/Bars";
import { Screen } from "@/ui/Screen";
import { Section } from "@/ui/Section";
import { StatGrid, StatTile } from "@/ui/StatTile";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, radius, sideColor, space } from "@/ui/theme";

/** Après le match : ma ligne, mes morts qui ont coûté le plus, mes duels, et deux points pour l'équipe. */
export default function Debrief() {
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const sid = useMySteamid();
  const { mode } = useSession();
  const match = useMatch(id);
  const analysis = useAnalysis(id);
  const mine = useMyMatches();
  const avg = useDashboard(sid).data?.player;
  const myTeam = match.data?.players.find((p) => p.steamid === sid)?.team_id ?? null;
  const debrief = useDebrief(id, myTeam);
  // une note de match vise aussi l'équipe d'en face : elle reviendra dans la prochaine préparation contre elle
  const opponent = match.data && myTeam !== null
    ? [match.data.team_a.id, match.data.team_b.id].find((x) => x !== myTeam) ?? null : null;
  const { markSeen } = useSeen();
  useEffect(() => { if (id) markSeen(id); }, [id, markSeen]);

  const line = mine.recent.find((r) => r.match_id === id);
  const me = analysis.data?.players.find((p) => p.steamid === sid);
  const deaths = analysis.data && sid ? costliestDeaths(analysis.data, sid) : [];
  const m = match.data;

  return (
    <Screen title={t.debrief.title} back hero={m ? <Hero m={m} myTeam={myTeam} /> : undefined}
      onRefresh={() => void Promise.all([match.refetch(), analysis.refetch(), debrief.refetch()])} refreshing={match.isRefetching}>
      {match.isPending ? <Loading /> : match.isError ? <ErrorState error={match.error} onRetry={() => void match.refetch()} /> : (
        <View>
          {line ? (
            <Section label={t.debrief.yourLine} lead={avg ? t.debrief.vsAverage : undefined}>
              <StatGrid>
                <StatTile label={t.common.stats.rating} value={num(line.rating)} delta={avg ? { text: signed(line.rating - avg.rating, 2), sign: Math.sign(line.rating - avg.rating) } : null} />
                <StatTile label={t.common.stats.kd} value={`${line.kills}-${line.deaths}`} hint={t.debrief.assists(line.assists)} />
                <StatTile label={t.common.stats.adr} value={num(line.adr, 0)} delta={avg ? { text: signed(line.adr - avg.adr, 0), sign: Math.sign(line.adr - avg.adr) } : null} />
                <StatTile label={t.common.stats.kast} value={pct(line.kast)} delta={avg ? { text: t.common.points(signed(line.kast - avg.kast, 0)), sign: Math.sign(line.kast - avg.kast) } : null} />
              </StatGrid>
            </Section>
          ) : null}

          <Section label={t.debrief.costliest} lead={t.debrief.costliestLead}>
            {analysis.isPending ? <Loading blocks={2} /> : analysis.isError ? <ErrorState error={analysis.error} />
              : deaths.length === 0 ? <EmptyState text={t.debrief.noDeaths} /> : deaths.map((d) => <DeathCard key={`${d.round}-${d.tick}`} d={d} />)}
          </Section>

          {me ? (
            <Section label={t.debrief.duels} lead={t.debrief.duelsLead}>
              <View style={styles.panel}>
                {AIM_ZONES.filter((z) => me.duels[z]).map((z) => (
                  <SplitBar key={z} label={AIM_ZONE_LABEL[z].title} sub={AIM_ZONE_LABEL[z].range} won={me.duels[z]![0]} lost={me.duels[z]![1]} />
                ))}
                <SplitBar label={t.debrief.dry} sub={t.debrief.drySub} won={me.dry[0]} lost={me.dry[1]} />
              </View>
            </Section>
          ) : null}

          {debrief.data?.issues.length ? (
            <Section label={t.debrief.team}>
              {debrief.data.issues.slice(0, 2).map((i) => (
                <View key={i.key} style={styles.panel}>
                  <Txt v="headline">{i.label}</Txt>
                  <Txt v="callout">{i.text}</Txt>
                  {i.drill ? (
                    <View style={styles.drill}>
                      <Txt v="label" color={color.accent}>{t.debrief.drill}</Txt>
                      <Txt v="body">{i.drill}</Txt>
                    </View>
                  ) : null}
                </View>
              ))}
            </Section>
          ) : null}

          {m && myTeam ? (
            <Section label={t.debrief.rounds}>
              <RoundStrip m={m} myTeam={myTeam} />
            </Section>
          ) : null}

          {m ? (
            <NotesSection label={t.notes.matchTitle} filter={{ match: id }} empty={t.notes.matchEmpty}
              draft={{ match: String(id), map: m.map_name, ...(opponent ? { team: String(opponent) } : {}) }} />
          ) : null}

          {mode === "http" && sid ? (
            <View style={styles.pc}>
              <Button label={t.debrief.replayOnPc} kind="secondary" icon="external"
                onPress={() => void Linking.openURL(`${SAME_ORIGIN ? "" : API_BASE || SERVER}/matches/${id}?tab=analysis&player=${sid}`)} />
            </View>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

function Hero({ m, myTeam }: { m: MatchDetail; myTeam: number | null }) {
  const mineIsA = myTeam === null || m.team_a.id === myTeam;
  const [us, them] = mineIsA ? [m.team_a, m.team_b] : [m.team_b, m.team_a];
  const [s1, s2] = mineIsA ? [m.score_a, m.score_b] : [m.score_b, m.score_a];
  const won = s1 === s2 ? null : s1 > s2;
  return (
    <View style={styles.hero}>
      <Txt v="label">{`${t.debrief.title} · ${m.map_display_name} · ${shortDate(m.date ?? m.played_at, new Date())}`}</Txt>
      <View style={styles.scoreRow}>
        <ResultBadge won={won} size={40} />
        <View style={styles.flex}>
          <Txt v="headline" numberOfLines={1}>{us.name}</Txt>
          <Txt v="subhead" numberOfLines={1}>{`${t.common.vs} ${them.name}`}</Txt>
        </View>
        <Txt v="number" style={styles.score} accessibilityLabel={t.common.score(s1, s2)}>{`${s1}–${s2}`}</Txt>
      </View>
    </View>
  );
}

function DeathCard({ d }: { d: AnalysisDeath }) {
  return (
    <View style={styles.panel} accessible accessibilityLabel={t.debrief.deathLabel(t.debrief.round(d.round), Math.round(d.cost * 100), reasonsOf(d).join(", "))}>
      <View style={styles.rowHead}>
        <Txt v="headline" style={styles.flex}>{t.debrief.round(d.round)}</Txt>
        <Txt v="data" color={color.bad}>{`−${Math.round(d.cost * 100)} %`}</Txt>
      </View>
      <Txt v="callout">{`${t.debrief.killedBy(d.attacker_name, weaponLabel(d.weapon))}${d.place ? ` · ${placeLabel(d.place)}` : ""}`}</Txt>
      <View style={styles.tags}>
        <Tag label={d.side} tone={sideColor(d.side)} bg={d.side === "CT" ? color.ctDim : color.tDim} />
        {reasonsOf(d).map((r) => <Tag key={r} label={r} />)}
      </View>
      {d.aim_zone && d.aim_offset != null ? (
        <Txt v="dataSmall">{t.debrief.aim(AIM_ZONE_LABEL[d.aim_zone].title.toLowerCase(), Math.round(d.aim_offset))}</Txt>
      ) : null}
    </View>
  );
}

/** Un trait par round : plein si gagné, couleur de mon camp ; séparation à chaque mi-temps. */
function RoundStrip({ m, myTeam }: { m: MatchDetail; myTeam: number }) {
  const rounds = [...m.rounds].sort((a, b) => a.number - b.number);
  const won = rounds.filter((r) => r.winner_team_id === myTeam).length;
  return (
    <View style={styles.panel} accessible accessibilityLabel={t.debrief.roundsWon(won, rounds.length)}>
      <View style={styles.strip}>
        {rounds.map((r) => {
          const side = r.ct_team_id === myTeam ? "CT" : "T";
          const w = r.winner_team_id === myTeam;
          const half = r.number > 1 && (r.number === 13 || (r.number > 24 && (r.number - 25) % 3 === 0));
          return (
            <View key={r.id} style={[styles.cell, half && styles.half, w
              ? { backgroundColor: sideColor(side) }
              : { borderColor: sideColor(side), borderWidth: 1, opacity: 0.55 }]} />
          );
        })}
      </View>
      <View style={styles.legend}>
        <Txt v="dataSmall">plein : gagné · vide : perdu</Txt>
        <View style={styles.legendSides}>
          <Tag label="T" tone={color.t} bg={color.tDim} />
          <Tag label="CT" tone={color.ct} bg={color.ctDim} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hero: { gap: space.sm, marginBottom: space.sm },
  scoreRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  score: { fontSize: 34, lineHeight: 40 },
  panel: { backgroundColor: color.surface2, borderRadius: radius.card, padding: space.lg, gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  rowHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  drill: { gap: 4, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  strip: { flexDirection: "row", flexWrap: "wrap", gap: 3 },
  cell: { width: 9, height: 22, borderRadius: 2 },
  half: { marginLeft: 6 },
  legend: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  legendSides: { flexDirection: "row", gap: 6 },
  pc: { marginTop: space.xl },
});
