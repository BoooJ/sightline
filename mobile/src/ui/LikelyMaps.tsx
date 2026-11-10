import { StyleSheet, View } from "react-native";

import type { CalendarEvent } from "@/api/types";
import { t } from "@/i18n/fr";
import { likelyTop } from "@/lib/today";
import { Tag } from "@/ui/Badges";
import { Txt } from "@/ui/Txt";
import { color } from "@/ui/theme";

/** Cartes probables d'un match FACEIT (synchro du serveur) : les trois premières, tant que les cartes ne sont pas fixées. */
export function LikelyMaps({ event }: { event: CalendarEvent }) {
  const top = event.maps.length ? [] : likelyTop(event.likely_maps);
  if (!top.length) return null;
  const few = event.likely_maps?.few ?? false;
  return (
    <View style={styles.wrap} accessible accessibilityLabel={t.matches.likelyLabel(top.map((m) => `${m.name} ${m.pct} %`).join(", "))}>
      <Txt v="caption">{few ? t.matches.likelyFew : t.matches.likely}</Txt>
      <View style={styles.tags}>{top.map((m) => <Tag key={m.map} label={`${m.name} ${m.pct} %`} tone={color.text} />)}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
