import { Image } from "expo-image";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";

import { useCalendar, useDashboard, useMaps, useNotes, useNotifications, useScoutTeams } from "@/api/hooks";
import { useMyMatches, useMySteamid, useSeen } from "@/api/me";
import { useSession } from "@/api/session";
import { NoPlayer, noDemoYet } from "@/components/NoPlayer";
import { t } from "@/i18n/fr";
import { countdown, longDate, num, parseLocal, shortDate, time } from "@/lib/format";
import { mapLabel } from "@/lib/labels";
import { buildToday, readyFrom, type TodayCard } from "@/lib/today";
import { trendSummary } from "@/lib/trend";
import { ResultBadge, Tag } from "@/ui/Badges";
import { Card, CardHeader } from "@/ui/Card";
import { Sparkline } from "@/ui/charts/LineChart";
import { Icon } from "@/ui/Icon";
import { PressableScale } from "@/ui/PressableScale";
import { Screen } from "@/ui/Screen";
import { LikelyMaps } from "@/ui/LikelyMaps";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, radius, space, TOUCH } from "@/ui/theme";

export default function Today() {
  const sid = useMySteamid();
  const calendar = useCalendar();
  const teams = useScoutTeams();
  const matches = useMyMatches();
  const dash = useDashboard(sid);
  const notifs = useNotifications();
  const { seen, markSeen } = useSeen();
  const now = new Date();

  // isLoading : sans joueur lié (« Plus tard »), la requête de ses matchs ne part pas et resterait « en attente »
  const pending = matches.isLoading || calendar.isPending;
  const cards = buildToday({
    now, events: calendar.data ?? [], teams: teams.data ?? [], recent: matches.recent,
    trend: dash.data?.trend ?? [], seen, ready: readyFrom(notifs.data ?? []),
  });
  const refresh = () => void Promise.all([calendar.refetch(), teams.refetch(), matches.refetch(), dash.refetch(), notifs.refetch()]);

  return (
    <Screen
      title={t.today.title} subtitle={longDate(now)} onRefresh={refresh} refreshing={matches.isRefetching}
      right={<AccountButton />}
    >
      {!sid || noDemoYet(matches.error) ? <NoPlayer linked={!!sid} /> : null}
      {pending ? <Loading /> : matches.isError && calendar.isError ? <ErrorState error={matches.error} onRetry={refresh} />
        : cards.length === 0 ? <EmptyState text={t.today.empty} /> : (
          <View style={styles.cards}>
            {cards.map((c) => <TodayItem key={c.kind} card={c} now={now} onOpenDebrief={markSeen} />)}
          </View>
        )}
    </Screen>
  );
}

/** « 3 notes à relire » : mes notes (et celles de l'équipe) contre l'adversaire du prochain match. */
function PrepNotes({ teamId }: { teamId: number }) {
  const n = useNotes({ team: teamId }).data?.length ?? 0;
  if (!n) return null;
  return (
    <View style={styles.notes}>
      <Icon name="strats" size={16} color={color.accent} />
      <Txt v="subhead" color={color.accent}>{t.notes.toRead(n)}</Txt>
    </View>
  );
}

function AccountButton() {
  const { user } = useSession();
  const initial = (user?.display_name ?? "?").trim().charAt(0).toUpperCase();
  return (
    <PressableScale onPress={() => router.push("/today/account")} accessibilityRole="button" accessibilityLabel={t.today.account}
      hitSlop={6} style={styles.avatar}>
      <Txt v="headline" color={color.accent}>{initial}</Txt>
    </PressableScale>
  );
}

function TodayItem({ card, now, onOpenDebrief }: { card: TodayCard; now: Date; onOpenDebrief: (id: number) => void }) {
  const maps = useMaps().data ?? [];
  const mapName = (m: string) => mapLabel(m, maps.find((x) => x.name === m)?.display_name);
  switch (card.kind) {
    case "prep": {
      const at = parseLocal(card.event.starts_at);
      const open = () => (card.team
        ? router.push({ pathname: "/matches/prep/[teamId]", params: { teamId: String(card.team.id), map: card.event.maps[0] ?? "" } })
        : router.push("/matches/teams"));
      return (
        <Card onPress={open} accent={color.accent} label={t.today.prepTitle(card.event.opponent)}>
          <CardHeader label={card.soon ? t.today.prepSoon : card.event.title || "Prochain match"}
            right={<Txt v="dataSmall" color={color.accent}>{countdown(at, now)}</Txt>} />
          <Txt v="title">{t.today.prepTitle(card.event.opponent)}</Txt>
          <Txt v="subhead">{`${shortDate(card.event.starts_at, now)} · ${time(at)}`}</Txt>
          {card.event.maps.length ? (
            <View style={styles.tags}>{card.event.maps.map((m) => <Tag key={m} label={mapName(m)} />)}</View>
          ) : null}
          <LikelyMaps event={card.event} />
          {card.team ? <PrepNotes teamId={card.team.id} /> : <Txt v="caption">{t.today.prepNoTeam}</Txt>}
        </Card>
      );
    }
    case "debrief": {
      const m = card.match;
      return (
        <Card
          onPress={() => { onOpenDebrief(m.match_id); router.push({ pathname: "/matches/[id]", params: { id: String(m.match_id) } }); }}
          accent={card.fresh ? color.accent : undefined} label={card.fresh ? t.today.debriefFresh : t.today.debriefLast}
        >
          <CardHeader label={card.fresh ? t.today.debriefFresh : t.today.debriefLast}
            right={<Txt v="dataSmall">{shortDate(m.date, now)}</Txt>} />
          <View style={styles.match}>
            <ResultBadge won={m.won} />
            <View style={styles.flex}>
              <Txt v="headline">{`${t.common.vs} ${m.opponent}`}</Txt>
              <Txt v="caption">{m.display_name}</Txt>
            </View>
            <Txt v="number" style={styles.score}>{`${m.score[0]}–${m.score[1]}`}</Txt>
          </View>
          <View style={styles.line}>
            <Mini label={t.common.stats.rating} value={num(m.rating)} />
            <Mini label={t.common.stats.kd} value={`${m.kills}-${m.deaths}`} />
            <Mini label={t.common.stats.adr} value={num(m.adr, 0)} />
          </View>
        </Card>
      );
    }
    case "form": {
      const values = card.trend.slice(-10).map((p) => p.rating);
      const s = trendSummary(values, Math.min(5, Math.max(1, Math.floor(values.length / 2))));
      return (
        <Card onPress={() => router.push("/progress")} label={t.today.formTitle}>
          <CardHeader label={t.today.formTitle} />
          <View style={styles.match}>
            <View style={styles.flex}>
              <Txt v="number">{num(s.recent)}</Txt>
              <Txt v="caption">{t.today.formSummary(s.direction)}</Txt>
            </View>
            <Sparkline values={values} width={112} height={40} />
          </View>
        </Card>
      );
    }
    case "grenades":
      return <GrenadesCard map={card.map} />;
  }
}

function GrenadesCard({ map }: { map: string }) {
  const { api } = useSession();
  const meta = useMaps().data?.find((m) => m.name === map);
  const name = mapLabel(map, meta?.display_name);
  return (
    <Card onPress={() => router.push({ pathname: "/grenades/[map]", params: { map } })} label={t.today.grenadesTitle(name)}>
      <View style={styles.match}>
        <Image source={{ uri: api.assetUrl(`/maps/${meta?.image ?? `${map}.png`}`) }} style={styles.thumb} contentFit="cover"
          accessibilityIgnoresInvertColors />
        <View style={styles.flex}>
          <Txt v="headline">{t.today.grenadesTitle(name)}</Txt>
          <Txt v="caption">{t.today.grenadesLead}</Txt>
        </View>
        <Icon name="grenades" color={color.text3} />
      </View>
    </Card>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.mini}>
      <Txt v="caption">{label}</Txt>
      <Txt v="data">{value}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  cards: { gap: space.md, marginTop: space.lg },
  avatar: {
    width: TOUCH - 4, height: TOUCH - 4, borderRadius: radius.pill, backgroundColor: color.surface2, alignItems: "center",
    justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  notes: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  match: { flexDirection: "row", alignItems: "center", gap: space.md },
  flex: { flex: 1 },
  score: { fontSize: 26 },
  line: { flexDirection: "row", gap: space.lg, marginTop: space.xs, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  mini: { gap: 1 },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: color.surface },
});
