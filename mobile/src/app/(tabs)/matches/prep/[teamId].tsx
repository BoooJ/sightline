import { router, useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { useBrief, useScoutReport } from "@/api/hooks";
import type { BriefLine, BriefPlayer, ScoutBrief, Stat } from "@/api/types";
import { NotesSection } from "@/components/NotesSection";
import { t } from "@/i18n/fr";
import { clock, pct } from "@/lib/format";
import { mapLabel, placeLabel } from "@/lib/labels";
import { ShareBar } from "@/ui/charts/Bars";
import { ChipRow } from "@/ui/Chip";
import { ConfidenceTag } from "@/ui/ConfidenceTag";
import { SideTag, Tag } from "@/ui/Badges";
import { Screen } from "@/ui/Screen";
import { Section } from "@/ui/Section";
import { StatGrid, StatTile } from "@/ui/StatTile";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, radius, space } from "@/ui/theme";

/** Avant le match : ce qu'il faut savoir de l'adversaire sur une carte, en phrases et en chiffres qualifiés. */
export default function Prep() {
  const { teamId, map: mapParam } = useLocalSearchParams<{ teamId: string; map?: string }>();
  const id = Number(teamId);
  const report = useScoutReport(id);
  const maps = [...(report.data?.maps ?? [])].sort((a, b) => b.played - a.played);
  const map = mapParam && maps.some((m) => m.map === mapParam) ? mapParam : maps[0]?.map ?? mapParam ?? null;
  const brief = useBrief(id, map);
  const onMap = maps.find((m) => m.map === map);
  const team = report.data?.team.name ?? "";
  const mapName = onMap?.display_name ?? (map ? mapLabel(map) : "");
  // mes notes contre cette équipe sur cette carte : juste après « Pour les contrer », là où l'on se remémore avant de jouer
  const notes = map && team ? (
    <NotesSection label={t.notes.prepTitle(team)} filter={{ team: id, map }} draft={{ team: String(id), map }}
      empty={t.notes.prepEmpty(team, mapName)} seeAll={{ map, label: t.notes.seeAll(mapName) }} />
  ) : null;

  const hero = (
    <View style={styles.hero}>
      <Txt v="label">{t.prep.title}</Txt>
      <Txt v="largeTitle" accessibilityRole="header">{team || " "}</Txt>
      {report.data ? (
        <Txt v="subhead">{t.prep.record(t.common.matches(report.data.matches), report.data.wins)}</Txt>
      ) : null}
      {maps.length ? (
        <ChipRow value={map ?? ""} onChange={(m) => router.setParams({ map: m })}
          items={maps.map((m) => ({ value: m.map, label: `${m.display_name} · ${m.played}` }))} />
      ) : null}
    </View>
  );

  return (
    <Screen title={team || t.prep.title} back hero={hero}
      onRefresh={() => void Promise.all([report.refetch(), brief.refetch()])} refreshing={brief.isRefetching}>
      {/* sans carte (équipe jamais vue), la requête du brief ne part pas : pas de chargement sans fin */}
      {report.isPending || (map && brief.isPending) ? <Loading />
        : report.isError ? <ErrorState error={report.error} onRetry={() => void report.refetch()} />
          : brief.isError ? <ErrorState error={brief.error} onRetry={() => void brief.refetch()} />
            : !brief.data || brief.data.matches === 0 ? <View><EmptyState text={t.prep.noData} />{notes}</View> : (
              <Brief b={brief.data} mapWin={onMap ? { won: onMap.won, played: onMap.played } : null} notes={notes} />
            )}
    </Screen>
  );
}

function Brief({ b, mapWin, notes }: { b: ScoutBrief; mapWin: { won: number; played: number } | null; notes: ReactNode }) {
  return (
    <View>
      <StatGrid>
        {mapWin ? <StatTile label={t.prep.mapWins(b.display_name)} value={`${mapWin.won}/${mapWin.played}`} /> : null}
        <StatTile label={t.prep.sideRounds("T")} value={pct(b.sides.T.pct)} hint={`${b.sides.T.k}/${b.sides.T.n}`} />
        <StatTile label={t.prep.sideRounds("CT")} value={pct(b.sides.CT.pct)} hint={`${b.sides.CT.k}/${b.sides.CT.n}`} />
        <StatTile label={t.prep.contact} value={clock(b.avg_contact_s)} hint={t.prep.contactHint} />
      </StatGrid>

      {b.takeaways.length ? (
        <Section label={t.prep.takeaways}>
          {b.takeaways.map((l, i) => <Line key={i} line={l} />)}
        </Section>
      ) : null}

      {b.counters.length ? (
        <Section label={t.prep.counters}>
          {b.counters.map((l, i) => <Line key={i} line={l} accent />)}
        </Section>
      ) : null}

      {notes}

      <Section label={t.prep.attack} lead={b.avg_plant_s != null ? `${t.prep.plant} vers ${clock(b.avg_plant_s)} en moyenne.` : undefined}>
        <View style={styles.panel}>
          {b.t_styles.map((s) => (
            <View key={s.key} style={styles.row}>
              <View style={styles.rowHead}>
                <Txt v="subhead" color={color.text} style={styles.flex}>{s.label}</Txt>
                <Txt v="data">{pct(s.count.pct)}</Txt>
              </View>
              <ShareBar share={(s.count.pct ?? 0) / 100} tone={color.t} />
              <View style={styles.rowFoot}>
                <Txt v="dataSmall">{`${s.won.k}/${s.won.n} ${t.prep.won}${siteText(s.sites)}`}</Txt>
                {s.lib_pct != null ? <Txt v="dataSmall" color={color.text3}>{`ailleurs ${pct(s.lib_pct)}`}</Txt> : null}
              </View>
              <ConfidenceTag stat={s.count} />
            </View>
          ))}
        </View>
      </Section>

      <Section label={t.prep.defense}>
        <View style={styles.panel}>
          {b.ct_setups.slice(0, 4).map((s) => (
            <View key={s.setup} style={styles.row}>
              <View style={styles.rowHead}>
                <Txt v="data" color={color.text} style={styles.flex}>{s.setup}</Txt>
                <Txt v="data">{pct(s.count.pct)}</Txt>
              </View>
              <ShareBar share={(s.count.pct ?? 0) / 100} tone={color.ct} />
              <View style={styles.rowFoot}>
                <Txt v="dataSmall">{`${s.won.k}/${s.won.n} ${t.prep.won}`}</Txt>
                <ConfidenceTag stat={s.count} />
              </View>
            </View>
          ))}
        </View>
        <StatGrid>
          {(["A", "B"] as const).map((site) => (
            <SiteTile key={site} site={site} held={b.sites[site].held} retakes={b.sites[site].retakes} />
          ))}
        </StatGrid>
      </Section>

      <Section label={t.prep.pistols}>
        {(["T", "CT"] as const).map((side) => {
          const p = b.pistols[side];
          const main = p.plays[0];
          return (
            <View key={side} style={styles.line}>
              <SideTag side={side} />
              <View style={styles.flex}>
                <Txt v="body">{t.prep.pistol(p.result.k, p.result.n, main ? main.label.toLowerCase() : null)}</Txt>
                <ConfidenceTag stat={p.result} />
              </View>
            </View>
          );
        })}
      </Section>

      {b.players.length ? (
        <Section label={t.prep.players}>
          {[...b.players].sort((x, y) => (y.opening_attempts?.pct ?? 0) - (x.opening_attempts?.pct ?? 0)).slice(0, 5)
            .map((p) => <PlayerRow key={p.steamid} p={p} entry={b.entry === p.name} />)}
        </Section>
      ) : null}
    </View>
  );
}

function siteText(sites: Record<string, number>): string {
  const parts = Object.entries(sites).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function Line({ line, accent }: { line: BriefLine; accent?: boolean }) {
  return (
    <View style={[styles.line, accent && styles.lineAccent]}>
      <SideTag side={line.side} />
      <View style={styles.flex}>
        <Txt v="body">{line.text}</Txt>
        <ConfidenceTag stat={line.stat} />
      </View>
    </View>
  );
}

function SiteTile({ site, held, retakes }: { site: "A" | "B"; held: Stat; retakes: Stat }) {
  return (
    <View style={styles.site}>
      <Txt v="label">{`Site ${site}`}</Txt>
      <View style={styles.rowHead}>
        <Txt v="caption" style={styles.flex}>{t.prep.held}</Txt>
        <Txt v="data">{`${held.k}/${held.n}`}</Txt>
      </View>
      <View style={styles.rowHead}>
        <Txt v="caption" style={styles.flex}>{t.prep.retakes}</Txt>
        <Txt v="data">{`${retakes.k}/${retakes.n}`}</Txt>
      </View>
    </View>
  );
}

function PlayerRow({ p, entry }: { p: BriefPlayer; entry: boolean }) {
  const spotT = placeLabel(p.spots.T[0]?.place);
  const spotCT = placeLabel(p.spots.CT[0]?.place);
  return (
    <View style={styles.player}>
      <View style={styles.rowHead}>
        <Txt v="headline" style={styles.flex}>{p.name}</Txt>
        {p.awper ? <Tag label={t.prep.awper} tone={color.accent} bg={color.accentDim} /> : null}
        {entry ? <Tag label={t.prep.entry} tone={color.accent} bg={color.accentDim} /> : null}
      </View>
      <Txt v="callout">
        {t.prep.openingLine(pct(p.opening_attempts?.pct), pct(p.opening.pct))}
      </Txt>
      {spotT || spotCT ? (
        <View style={styles.spots}>
          {spotT ? <View style={styles.spot}><SideTag side="T" /><Txt v="dataSmall">{spotT}</Txt></View> : null}
          {spotCT ? <View style={styles.spot}><SideTag side="CT" /><Txt v="dataSmall">{spotCT}</Txt></View> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.xs, marginBottom: space.lg },
  flex: { flex: 1 },
  panel: { backgroundColor: color.surface2, borderRadius: radius.card, padding: space.lg, gap: space.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  row: { gap: 6 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  rowFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  line: {
    flexDirection: "row", gap: space.md, backgroundColor: color.surface2, borderRadius: radius.card, padding: space.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.line,
  },
  lineAccent: { borderColor: color.accentLine },
  site: { flexBasis: "47%", flexGrow: 1, backgroundColor: color.surface2, borderRadius: radius.card, padding: space.md, gap: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  player: { backgroundColor: color.surface2, borderRadius: radius.card, padding: space.md, gap: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  spots: { flexDirection: "row", gap: space.md, flexWrap: "wrap" },
  spot: { flexDirection: "row", alignItems: "center", gap: 6 },
});
