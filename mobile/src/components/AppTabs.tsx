import { NativeTabs } from "expo-router/native-tabs";

import { t } from "@/i18n/fr";
import { color } from "@/ui/theme";

/** Barre d'onglets du système (iPhone : vraie barre iOS, Liquid Glass sur iOS 26 ; Android : Material). */
export default function AppTabs() {
  return (
    <NativeTabs tintColor={color.accent} backgroundColor={color.bg} labelStyle={{ color: color.text3 }} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="today">
        <NativeTabs.Trigger.Label>{t.tabs.today}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "sun.max", selected: "sun.max.fill" }} md="wb_sunny" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="matches">
        <NativeTabs.Trigger.Label>{t.tabs.matches}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "list.bullet.rectangle", selected: "list.bullet.rectangle.fill" }} md="format_list_bulleted" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="strats">
        <NativeTabs.Trigger.Label>{t.tabs.strats}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "list.clipboard", selected: "list.clipboard.fill" }} md="assignment" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="grenades">
        <NativeTabs.Trigger.Label>{t.tabs.grenades}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "smoke", selected: "smoke.fill" }} md="blur_on" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="progress">
        <NativeTabs.Trigger.Label>{t.tabs.progress}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chart.line.uptrend.xyaxis" md="trending_up" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
