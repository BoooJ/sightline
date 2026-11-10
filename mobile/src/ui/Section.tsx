import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Txt } from "./Txt";
import { space } from "./theme";

/** Section d'écran : étiquette façon onglet de carnet, phrase d'explication facultative, contenu. */
export function Section({ label, lead, right, children }: { label: string; lead?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Txt v="label" accessibilityRole="header">{label}</Txt>
        {right}
      </View>
      {lead ? <Txt v="caption" style={styles.lead}>{lead}</Txt> : null}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: space.xl },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 20 },
  lead: { marginTop: 2 },
  body: { marginTop: space.md, gap: space.sm },
});
