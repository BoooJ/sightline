import { Image } from "expo-image";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";

import { useMaps } from "@/api/hooks";
import { useSession } from "@/api/session";
import { t } from "@/i18n/fr";
import { PressableScale } from "@/ui/PressableScale";
import { Screen } from "@/ui/Screen";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, radius, space } from "@/ui/theme";

/** Choix de la carte : vignettes des radars, cartes du moment en premier. */
export default function GrenadeMaps() {
  const { api } = useSession();
  const maps = useMaps();
  const list = [...(maps.data ?? [])].sort((a, b) => Number(!!b.active_duty) - Number(!!a.active_duty) || a.display_name.localeCompare(b.display_name));
  return (
    <Screen title={t.grenades.title} subtitle={t.grenades.lead} onRefresh={() => void maps.refetch()} refreshing={maps.isRefetching}>
      {maps.isPending ? <Loading /> : maps.isError ? <ErrorState error={maps.error} onRetry={() => void maps.refetch()} />
        : list.length === 0 ? <EmptyState text={t.grenades.none} /> : (
          <View style={styles.grid}>
            {list.map((m) => (
              <PressableScale key={m.name} style={styles.tile} haptic="light" accessibilityRole="button" accessibilityLabel={`Grenades de ${m.display_name}`}
                onPress={() => router.push({ pathname: "/grenades/[map]", params: { map: m.name } })}>
                <Image source={{ uri: api.assetUrl(`/maps/${m.image}`) }} style={styles.radar} contentFit="cover" accessibilityIgnoresInvertColors />
                <View style={styles.name}>
                  <Txt v="headline">{m.display_name}</Txt>
                </View>
              </PressableScale>
            ))}
          </View>
        )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: space.lg },
  tile: {
    flexBasis: "47%", flexGrow: 1, backgroundColor: color.surface2, borderRadius: radius.card, overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.line,
  },
  radar: { width: "100%", aspectRatio: 1, backgroundColor: color.surface, opacity: 0.9 },
  name: { padding: space.md },
});
