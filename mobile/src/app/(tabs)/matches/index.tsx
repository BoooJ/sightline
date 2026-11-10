import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useCalendar, useMaps, useScoutTeams } from "@/api/hooks";
import { useMyMatches, useMySteamid } from "@/api/me";
import { NoPlayer, noDemoYet } from "@/components/NoPlayer";
import type { CalendarEvent, ScoutTeam } from "@/api/types";
import { t } from "@/i18n/fr";
import { countdown, num, parseLocal, shortDate, time } from "@/lib/format";
import { EVENT_KIND_LABEL, mapLabel } from "@/lib/labels";
import { matchOpponent } from "@/lib/opponent";
import { ResultBadge, Tag } from "@/ui/Badges";
import { Card, CardHeader } from "@/ui/Card";
import { ListGroup, ListRow } from "@/ui/ListRow";
import { Screen } from "@/ui/Screen";
import { Segmented } from "@/ui/Segmented";
import { LikelyMaps } from "@/ui/LikelyMaps";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, space } from "@/ui/theme";

type Tab = "upcoming" | "played";
const PLAYED_KINDS: CalendarEvent["kind"][] = ["match", "tournament", "scrim"];

export default function Matches() {
  const calendar = useCalendar();
  const teams = useScoutTeams();
  const mine = useMyMatches();
  const sid = useMySteamid();
  const now = new Date();
  const upcoming = (calendar.data ?? [])
    .filter((e) => PLAYED_KINDS.includes(e.kind) && parseLocal(e.starts_at).getTime() >= now.getTime())
    .sort((a, b) => parseLocal(a.starts_at).getTime() - parseLocal(b.starts_at).getTime());
  const [tab, setTab] = useState<Tab | null>(null);
  const current: Tab = tab ?? (upcoming.length ? "upcoming" : "played");
  const refresh = () => void Promise.all([calendar.refetch(), teams.refetch(), mine.refetch()]);

  return (
    <Screen title={t.matches.title} onRefresh={refresh} refreshing={calendar.isRefetching || mine.isRefetching}>
      <View style={styles.segment}>
        <Segmented<Tab> value={current} onChange={setTab}
          items={[{ value: "upcoming", label: t.matches.upcoming }, { value: "played", label: t.matches.played }]} />
      </View>
      {current === "upcoming"
        ? calendar.isPending ? <Loading /> : calendar.isError ? <ErrorState error={calendar.error} onRetry={refresh} />
          : upcoming.length === 0 ? <EmptyState text={t.matches.noUpcoming} /> : (
            <View style={styles.list}>
              {upcoming.map((e) => <EventCard key={e.id} event={e} team={matchOpponent(e.opponent, teams.data ?? [])} now={now} />)}
            </View>
          )
        : !sid || noDemoYet(mine.error) ? <NoPlayer linked={!!sid} />
          : mine.isPending ? <Loading /> : mine.isError ? <ErrorState error={mine.error} onRetry={refresh} />
          : mine.recent.length === 0 ? <EmptyState text={t.matches.noPlayed} /> : (
            <ListGroup>
              {mine.recent.map((m) => (
                <ListRow
                  key={m.match_id} leading={<ResultBadge won={m.won} size={30} />}
                  title={`${t.common.vs} ${m.opponent}`} subtitle={`${m.display_name} · ${shortDate(m.date, now)} · ${t.matches.rating(num(m.rating))}`}
                  value={`${m.score[0]}–${m.score[1]}`} valueColor={m.won ? color.text : color.text2}
                  onPress={() => router.push({ pathname: "/matches/[id]", params: { id: String(m.match_id) } })}
                  label={t.matches.rowLabel(m.won ? t.common.win : t.common.loss, t.common.score(m.score[0], m.score[1]), m.opponent, m.display_name)}
                />
              ))}
            </ListGroup>
          )}
    </Screen>
  );
}

function EventCard({ event, team, now }: { event: CalendarEvent; team: ScoutTeam | null; now: Date }) {
  const maps = useMaps().data ?? [];
  const at = parseLocal(event.starts_at);
  const open = () => (team
    ? router.push({ pathname: "/matches/prep/[teamId]", params: { teamId: String(team.id), map: event.maps[0] ?? "" } })
    : router.push("/matches/teams"));
  return (
    <Card onPress={open} label={`${event.opponent}, ${shortDate(event.starts_at, now)} ${time(at)}`}>
      <CardHeader label={`${EVENT_KIND_LABEL[event.kind]}${event.title ? ` · ${event.title}` : ""}`}
        right={<Txt v="dataSmall" color={color.accent}>{countdown(at, now)}</Txt>} />
      <Txt v="title">{event.opponent}</Txt>
      <Txt v="subhead">{`${shortDate(event.starts_at, now)} · ${time(at)}`}</Txt>
      {event.maps.length ? (
        <View style={styles.tags}>
          {event.maps.map((m) => <Tag key={m} label={mapLabel(m, maps.find((x) => x.name === m)?.display_name)} />)}
        </View>
      ) : null}
      <LikelyMaps event={event} />
      <Txt v="caption" color={team ? color.accent : color.text3}>{team ? t.prep.title : t.matches.pickTeam}</Txt>
    </Card>
  );
}

const styles = StyleSheet.create({
  segment: { marginTop: space.md, marginBottom: space.lg },
  list: { gap: space.md },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
