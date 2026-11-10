import * as Clipboard from "expo-clipboard";
import { useKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { Circle, G, Polyline } from "react-native-svg";

import { useCalendar, useCallouts, useGrenades, useMaps, useScoutTeams } from "@/api/hooks";
import { useMyTeam } from "@/api/me";
import { useSession } from "@/api/session";
import type { CalloutPlace, GrenadeType, Lineup, MapMeta } from "@/api/types";
import { t } from "@/i18n/fr";
import { num } from "@/lib/format";
import { mapLabel, NADE_LABEL, NADE_TYPES } from "@/lib/labels";
import { nearestPlace, parseSetpos } from "@/lib/lineups";
import { matchOpponent } from "@/lib/opponent";
import { levelForZ, levelImage, toRadarFraction, worldToRadar } from "@/lib/radar";
import { nextEvent } from "@/lib/today";
import { SideTag } from "@/ui/Badges";
import { Button } from "@/ui/Button";
import { ChipRow } from "@/ui/Chip";
import { Icon } from "@/ui/Icon";
import { ListGroup, ListRow } from "@/ui/ListRow";
import { tap } from "@/ui/PressableScale";
import { cropAround, Radar } from "@/ui/Radar";
import { Screen } from "@/ui/Screen";
import { Segmented } from "@/ui/Segmented";
import { Sheet } from "@/ui/Sheet";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, NADE_COLOR, radius, space } from "@/ui/theme";

type TypeFilter = "all" | Exclude<GrenadeType, "incendiary" | "decoy">;
type SideFilter = "all" | "T" | "CT";
type Source = "all" | "mine" | "opponent";

const keyOf = (l: Lineup) => `${l.type}:${l.throw.join(",")}:${l.land.join(",")}`;
const sameType = (l: Lineup, f: TypeFilter) => f === "all" || l.type === f || (f === "molotov" && l.type === "incendiary");

/** À côté du clavier : les lineups d'une carte sur le radar, filtrés en un geste, l'écran reste allumé. */
export default function MapGrenades() {
  useKeepAwake();
  const { map } = useLocalSearchParams<{ map: string }>();
  const { api } = useSession();
  const { width } = useWindowDimensions();
  const meta = useMaps().data?.find((m) => m.name === map);
  const myTeam = useMyTeam();
  const events = useCalendar().data ?? [];
  const teams = useScoutTeams().data ?? [];
  const ev = nextEvent(events, new Date());
  const opponent = ev ? matchOpponent(ev.opponent, teams) : null;

  const [type, setType] = useState<TypeFilter>("smoke");
  const [side, setSide] = useState<SideFilter>("all");
  const [source, setSource] = useState<Source>("all");
  const [levelPick, setLevel] = useState<string | null>(null);
  const [selected, setSelected] = useState<Lineup | null>(null);

  const team = source === "mine" ? myTeam ?? undefined : source === "opponent" ? opponent?.id : undefined;
  const grenades = useGrenades(map, team);
  const callouts = useCallouts(map).data?.places ?? [];
  const level = meta && meta.levels.length > 1 ? levelPick ?? meta.levels[0].name : null;

  const lineups = (grenades.data?.lineups ?? [])
    .filter((l) => l.count >= 2 && sameType(l, type) && (side === "all" || l.side === side))
    .filter((l) => !meta || !level || levelForZ(meta, l.land[2]) === level)
    .sort((a, b) => b.count - a.count);
  const size = Math.min(width - space.lg * 2, 560);
  const title = mapLabel(map, meta?.display_name);
  const uri = meta ? api.assetUrl(`/maps/${level ? levelImage(meta, level) : meta.image}`) : "";

  const sources = [
    { value: "all" as Source, label: t.grenades.source.all },
    ...(myTeam ? [{ value: "mine" as Source, label: t.grenades.source.mine }] : []),
    ...(opponent ? [{ value: "opponent" as Source, label: opponent.name }] : []),
  ];

  return (
    <View style={styles.root}>
      <Screen title={title} back hero={
        <View style={styles.hero}>
          <Txt v="label">{t.grenades.title}</Txt>
          <Txt v="largeTitle" accessibilityRole="header">{title}</Txt>
          <View style={styles.awake}><Icon name="eye" size={16} color={color.text3} /><Txt v="caption">{t.grenades.awake}</Txt></View>
        </View>
      }>
        <View style={styles.filters}>
          <ChipRow<TypeFilter> value={type} onChange={(v) => { setType(v); setSelected(null); }}
            items={[...NADE_TYPES.map((g) => ({ value: g as TypeFilter, label: NADE_LABEL[g], dot: NADE_COLOR[g] })), { value: "all", label: t.grenades.filters.all }]} />
          <Segmented<SideFilter> value={side} onChange={setSide}
            items={[{ value: "all", label: t.grenades.filters.all }, { value: "T", label: "T" }, { value: "CT", label: "CT" }]} />
          {sources.length > 1 ? <ChipRow<Source> value={source} onChange={setSource} items={sources} /> : null}
          {meta && meta.levels.length > 1 ? (
            <ChipRow<string> value={level ?? ""} onChange={setLevel} items={meta.levels.map((l) => ({ value: l.name, label: t.common.levels[l.name] ?? l.name }))} />
          ) : null}
        </View>

        {!meta || grenades.isPending ? <Loading blocks={2} /> : grenades.isError ? <ErrorState error={grenades.error} onRetry={() => void grenades.refetch()} /> : (
          <>
            <Radar uri={uri} size={size} label={`Radar de ${title} : ${lineups.length} lineups`}>
              {(u) => (
                <G>
                  {lineups.map((l) => {
                    const [x, y] = worldToRadar(meta, l.land[0], l.land[1]);
                    const on = !!selected && keyOf(selected) === keyOf(l);
                    return (
                      <G key={keyOf(l)} onPress={() => { tap("select"); setSelected(l); }}>
                        <Circle cx={x} cy={y} r={14 * u} fill="transparent" />
                        <Circle cx={x} cy={y} r={(on ? 7 : 5) * u} fill={NADE_COLOR[l.type]} stroke={color.bg} strokeWidth={1.5 * u}
                          opacity={selected && !on ? 0.45 : 0.95} />
                      </G>
                    );
                  })}
                </G>
              )}
            </Radar>
            <Txt v="caption" style={styles.count}>{t.grenades.lineups(lineups.length)}</Txt>
            {lineups.length === 0 ? <EmptyState text={t.grenades.none} /> : (
              <ListGroup>
                {lineups.slice(0, 40).map((l) => {
                  const land = nearestPlace(callouts, l.land) ?? "?";
                  const from = nearestPlace(callouts, l.throw);
                  return (
                    <ListRow key={keyOf(l)} leading={<View style={[styles.dot, { backgroundColor: NADE_COLOR[l.type] }]} />}
                      title={`${NADE_LABEL[l.type]} · ${land}`} subtitle={`${from ? `depuis ${from} · ` : ""}${l.side} · ${t.grenades.count(l.count)}`}
                      onPress={() => setSelected(l)} />
                  );
                })}
              </ListGroup>
            )}
          </>
        )}
      </Screen>
      <Sheet open={!!selected} onClose={() => setSelected(null)} height={0.86} label={t.grenades.lineup}>
        {selected && meta ? <LineupDetail l={selected} meta={meta} uri={uri} places={callouts} /> : null}
      </Sheet>
    </View>
  );
}

function LineupDetail({ l, meta, uri, places }: { l: Lineup; meta: MapMeta; uri: string; places: CalloutPlace[] }) {
  const { width, height } = useWindowDimensions();
  const [copied, setCopied] = useState(false);
  const sp = parseSetpos(l.setpos);
  const land = nearestPlace(places, l.land) ?? "?";
  const from = nearestPlace(places, l.throw);
  const pts = [l.throw, l.land, ...l.trajectory].map((p) => toRadarFraction(meta, p[0], p[1]));
  const crop = cropAround(pts, 0.28, 0.08);
  const size = Math.min(width - space.lg * 2, height * 0.27, 360);
  const [tx, ty] = worldToRadar(meta, l.throw[0], l.throw[1]);
  const [lx, ly] = worldToRadar(meta, l.land[0], l.land[1]);
  const path = l.trajectory.map((p) => worldToRadar(meta, p[0], p[1]).join(",")).join(" ");

  async function copy() {
    if (!l.setpos) return;
    await Clipboard.setStringAsync(l.setpos);
    tap("success");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <View style={styles.detail}>
      <View style={styles.detailHead}>
        <View style={[styles.dotLg, { backgroundColor: NADE_COLOR[l.type] }]} />
        <View style={styles.flex}>
          <Txt v="title">{`${NADE_LABEL[l.type]} · ${land}`}</Txt>
          <Txt v="subhead">{`${from ? `${t.grenades.throwFrom} : ${from} · ` : ""}${t.grenades.count(l.count)}`}</Txt>
        </View>
        <SideTag side={l.side} />
      </View>
      <View style={styles.center}>
        <Radar uri={uri} size={size} crop={crop} label={`${t.grenades.throwFrom} ${from ?? ""}, ${t.grenades.lands} ${land}`}>
          {(u) => (
            <G>
              {path ? <Polyline points={path} fill="none" stroke={color.text} strokeWidth={2 * u} strokeDasharray={`${6 * u} ${5 * u}`} opacity={0.8} /> : null}
              <Circle cx={tx} cy={ty} r={7 * u} fill={color.bg} stroke={color.accent} strokeWidth={2.5 * u} />
              <Circle cx={tx} cy={ty} r={2.5 * u} fill={color.accent} />
              <Circle cx={lx} cy={ly} r={9 * u} fill={NADE_COLOR[l.type]} opacity={0.35} />
              <Circle cx={lx} cy={ly} r={5 * u} fill={NADE_COLOR[l.type]} stroke={color.bg} strokeWidth={1.5 * u} />
            </G>
          )}
        </Radar>
      </View>
      <View style={styles.legend}>
        <View style={styles.legendItem}><View style={[styles.ring, { borderColor: color.accent }]} /><Txt v="caption">{t.grenades.throwFrom}</Txt></View>
        <View style={styles.legendItem}><View style={[styles.dot, { backgroundColor: NADE_COLOR[l.type] }]} /><Txt v="caption">{t.grenades.lands}</Txt></View>
      </View>
      {sp ? (
        <View style={styles.angles}>
          <Angle label={t.grenades.pitch} value={`${num(sp.pitch, 1)}°`} />
          <Angle label={t.grenades.yaw} value={`${num(sp.yaw, 1)}°`} />
        </View>
      ) : null}
      {l.players.length ? <Txt v="caption">{`${t.grenades.by} ${l.players.slice(0, 5).join(", ")}`}</Txt> : null}
      {l.setpos ? (
        <Button label={copied ? t.grenades.copied : t.grenades.copy} kind="secondary" icon={copied ? "check" : "copy"} onPress={() => void copy()} />
      ) : null}
    </View>
  );
}

function Angle({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.angle}>
      <Txt v="caption">{label}</Txt>
      <Txt v="number" style={styles.angleValue}>{value}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  hero: { gap: space.xs, marginBottom: space.md },
  awake: { flexDirection: "row", alignItems: "center", gap: 6 },
  filters: { gap: space.md, marginBottom: space.lg },
  count: { marginTop: space.sm, marginBottom: space.md },
  dot: { width: 12, height: 12, borderRadius: 6 },
  dotLg: { width: 16, height: 16, borderRadius: 8 },
  ring: { width: 12, height: 12, borderRadius: 6, borderWidth: 2.5 },
  detail: { gap: space.md, flex: 1 },
  detailHead: { flexDirection: "row", alignItems: "center", gap: space.md },
  center: { alignItems: "center" },
  legend: { flexDirection: "row", gap: space.lg, justifyContent: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  angles: { flexDirection: "row", gap: space.sm },
  angle: { flex: 1, backgroundColor: color.surface2, borderRadius: radius.md, padding: space.md, gap: 2 },
  angleValue: { fontSize: 26, lineHeight: 30 },
});
