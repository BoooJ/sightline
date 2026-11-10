import { StyleSheet, View } from "react-native";

import type { NoteT } from "@/api/types";
import { noteMeta } from "@/lib/notes";
import { SideTag } from "@/ui/Badges";
import { PressableScale } from "@/ui/PressableScale";
import { Txt } from "@/ui/Txt";
import { color, radius, space } from "@/ui/theme";

/** Une note dans une liste : ses trois premières lignes, puis à quoi elle est rattachée, son âge et qui l'a partagée. */
export function NoteRow({ note, now, onPress }: { note: NoteT; now: Date; onPress: () => void }) {
  const meta = noteMeta(note, now);
  return (
    <PressableScale onPress={onPress} haptic="light" accessibilityRole="button" accessibilityLabel={`${note.body}. ${meta}`}
      style={styles.card}>
      <View style={styles.top}>
        {note.side ? <SideTag side={note.side} /> : null}
        <Txt v="body" numberOfLines={3} style={styles.flex}>{note.body}</Txt>
      </View>
      {meta ? <Txt v="caption" numberOfLines={1}>{meta}</Txt> : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 6, padding: space.md, backgroundColor: color.surface2, borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.line,
  },
  top: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  flex: { flex: 1 },
});
