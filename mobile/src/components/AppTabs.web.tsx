import { BlurView } from "expo-blur";
import { TabList, TabSlot, Tabs, TabTrigger, type TabTriggerSlotProps } from "expo-router/ui";
import type { ComponentRef, Ref } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { t } from "@/i18n/fr";
import { Icon, type IconName } from "@/ui/Icon";
import { Txt } from "@/ui/Txt";
import { color, TAB_BAR_H } from "@/ui/theme";

const TABS: { name: string; href: "/today" | "/matches" | "/strats" | "/grenades" | "/progress"; label: string; icon: IconName }[] = [
  { name: "today", href: "/today", label: t.tabs.today, icon: "today" },
  { name: "matches", href: "/matches", label: t.tabs.matches, icon: "matches" },
  { name: "strats", href: "/strats", label: t.tabs.strats, icon: "strats" },
  { name: "grenades", href: "/grenades", label: t.tabs.grenades, icon: "grenades" },
  { name: "progress", href: "/progress", label: t.tabs.progress, icon: "progress" },
];

type TabButtonProps = Omit<TabTriggerSlotProps, "ref"> & { label: string; icon: IconName; ref?: Ref<ComponentRef<typeof Pressable>> };

// React 19 : `ref` est une prop comme une autre (TabTrigger asChild la transmet).
function TabButton({ isFocused, label, icon, ref, ...p }: TabButtonProps) {
  const tint = isFocused ? color.accent : color.text3;
  return (
    <Pressable ref={ref} {...p} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: !!isFocused }}>
      <Icon name={icon} size={24} color={tint} strokeWidth={isFocused ? 2 : 1.75} />
      <Txt v="caption" color={tint} style={[styles.label, isFocused && styles.labelOn]}>{label}</Txt>
    </Pressable>
  );
}

/** Barre d'onglets de la version web : même dessin qu'une barre iOS, translucide, le contenu défile dessous. */
export default function AppTabs() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs>
      <TabSlot style={styles.slot} />
      <TabList asChild>
        {/* enfant d'un Slot : style aplati obligatoire */}
        <View style={StyleSheet.flatten([styles.bar, { height: TAB_BAR_H + insets.bottom, paddingBottom: insets.bottom }])}>
          <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill}><View style={styles.tint} /></BlurView>
          <View style={styles.edge} />
          {TABS.map((tab) => (
            <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
              <TabButton label={tab.label} icon={tab.icon} />
            </TabTrigger>
          ))}
        </View>
      </TabList>
    </Tabs>
  );
}

const styles = StyleSheet.create({
  slot: { height: "100%" },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row" },
  tint: { flex: 1, backgroundColor: color.bar },
  edge: { position: "absolute", left: 0, right: 0, top: 0, height: StyleSheet.hairlineWidth, backgroundColor: color.lineStrong },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2, paddingTop: 6 },
  label: { fontSize: 11, lineHeight: 14 },
  labelOn: { fontWeight: "600" },
});
