import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";

import { ApiError } from "@/api/api";
import { useMaps, useStrat } from "@/api/hooks";
import { useSession } from "@/api/session";
import type { MapMeta, Strat } from "@/api/types";
import { NotesSection } from "@/components/NotesSection";
import { StratRadar } from "@/components/StratRadar";
import { t } from "@/i18n/fr";
import { gameClock } from "@/lib/format";
import { mapLabel, NADE_LABEL, STRAT_TYPE_LABEL } from "@/lib/labels";
import { levelImage } from "@/lib/radar";
import { initialLevel, updatedDay } from "@/lib/strats";
import { Tag } from "@/ui/Badges";
import { Button } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { ListGroup, ListRow } from "@/ui/ListRow";
import { Screen } from "@/ui/Screen";
import { Section } from "@/ui/Section";
import { Segmented } from "@/ui/Segmented";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, font, NADE_COLOR, space } from "@/ui/theme";

/** Une stratégie à côté du clavier : la carte, le plan, qui joue où, quelles grenades et quand. L'écran reste allumé. */
export default function StratDetail() {
  useKeepAwake();
  const { id } = useLocalSearchParams<{ id: string }>();
  const strat = useStrat(Number(id));
  const s = strat.data;
  const meta = useMaps().data?.find((m) => m.name === s?.map);
  const gone = strat.error instanceof ApiError && strat.error.status === 404;
  return (
    <Screen title={s?.name ?? t.strats.title} back hero={s ? <Hero s={s} mapName={mapLabel(s.map, meta?.display_name)} /> : undefined}>
      {strat.isPending ? <Loading blocks={2} />
        : gone ? <EmptyState text={t.strats.gone} />
        : strat.isError ? <ErrorState error={strat.error} onRetry={() => void strat.refetch()} />
        : s ? <Body s={s} meta={meta} /> : null}
    </Screen>
  );
}

function Hero({ s, mapName }: { s: Strat; mapName: string }) {
  const line = [s.author ? t.strats.by(s.author) : null, s.updated_at ? t.strats.updated(updatedDay(s.updated_at, new Date())) : null]
    .filter(Boolean).join(" · ");
  return (
    <View style={styles.hero}>
      <Txt v="label">{`${mapName} · ${s.side} · ${STRAT_TYPE_LABEL[s.type]}`}</Txt>
      <Txt v="largeTitle" accessibilityRole="header">{s.name}</Txt>
      {s.tags.length ? <View style={styles.tags}>{s.tags.map((tag) => <Tag key={tag} label={`#${tag}`} />)}</View> : null}
      {line ? <Txt v="caption">{line}</Txt> : null}
      <View style={styles.awake}><Icon name="eye" size={16} color={color.text3} /><Txt v="caption">{t.strats.awake}</Txt></View>
    </View>
  );
}

function Body({ s, meta }: { s: Strat; meta: MapMeta | undefined }) {
  const { api } = useSession();
  const { width } = useWindowDimensions();
  const [levelPick, setLevel] = useState<string | null>(null);
  const size = Math.min(width - space.lg * 2, 560);
  const level = meta ? levelPick ?? initialLevel(s, meta) : null;
  const sideColor = s.side === "CT" ? color.ct : color.t;
  const source = s.source;
  return (
    <View style={styles.body}>
      {meta && meta.levels.length > 1 ? (
        <Segmented<string> value={level ?? ""} onChange={setLevel}
          items={meta.levels.map((l) => ({ value: l.name, label: t.common.levels[l.name] ?? l.name }))} />
      ) : null}
      {meta && level ? (
        <StratRadar strat={s} meta={meta} level={level} size={size} uri={api.assetUrl(`/maps/${levelImage(meta, level)}`)} />
      ) : <Loading blocks={1} />}
      {s.description.trim() ? (
        <Section label={t.strats.plan}><Txt v="body">{s.description.trim()}</Txt></Section>
      ) : null}
      <NotesSection label={t.notes.stratTitle} filter={{ strat: s.id }} empty={t.notes.stratEmpty}
        draft={{ strat: String(s.id), map: s.map, side: s.side }} />
      {s.positions.length ? (
        <Section label={t.strats.positions}>
          <ListGroup>
            {s.positions.map((p, i) => (
              <ListRow key={`p${i}`} leading={<Num n={i + 1} bg={sideColor} />} title={p.name || t.strats.player(i + 1)} value={p.role || undefined} />
            ))}
          </ListGroup>
        </Section>
      ) : null}
      {s.grenades.length ? (
        <Section label={t.strats.grenadesTitle}>
          <ListGroup>
            {s.grenades.map((g, i) => (
              <ListRow key={`g${i}`} leading={<Num n={i + 1} bg={NADE_COLOR[g.type] ?? color.text3} />}
                title={[NADE_LABEL[g.type], g.player || null, g.timing_s != null ? gameClock(g.timing_s) : null].filter(Boolean).join(" · ")}
                subtitle={g.note || undefined} />
            ))}
          </ListGroup>
        </Section>
      ) : null}
      {source ? (
        <View style={styles.source}>
          <Button label={t.strats.source} kind="secondary" icon="external"
            onPress={() => router.push({ pathname: "/matches/[id]", params: { id: String(source.match_id) } })} />
        </View>
      ) : null}
    </View>
  );
}

/** Numéro d'un joueur ou d'une grenade, le même que sur la carte. */
function Num({ n, bg }: { n: number; bg: string }) {
  return (
    <View style={[styles.num, { backgroundColor: bg }]}>
      <Txt v="dataSmall" color={color.bg} style={styles.numText}>{String(n)}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.xs, marginBottom: space.md },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xs },
  awake: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: space.xs },
  body: { gap: space.md },
  source: { marginTop: space.xl },
  num: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  numText: { fontFamily: font.monoBold },
});
