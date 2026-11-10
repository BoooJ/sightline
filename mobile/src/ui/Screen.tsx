import { BlurView } from "expo-blur";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Platform, RefreshControl, StyleSheet, View } from "react-native";
import Animated, { interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/api/session";
import { t } from "@/i18n/fr";

import { DemoBanner } from "./DemoBanner";
import { Icon } from "./Icon";
import { PressableScale } from "./PressableScale";
import { Txt } from "./Txt";
import { color, space, TAB_BAR_H, TOUCH } from "./theme";

const BAR_H = 44;

/** Écran défilant façon iOS : grand titre dans le contenu, barre translucide qui apparaît dès qu'on défile
 *  (avec le titre en petit), bouton retour pour les écrans empilés. Le contenu passe sous la barre d'onglets. */
export function Screen({ title, subtitle, right, back, children, onRefresh, refreshing = false, hero }: {
  title: string; subtitle?: string; right?: ReactNode; back?: boolean; children: ReactNode;
  onRefresh?: () => void; refreshing?: boolean;
  /** contenu d'en-tête à la place du grand titre (écrans empilés : score d'un match…) */
  hero?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { mode } = useSession();
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => { y.set(e.contentOffset.y); });
  const barStyle = useAnimatedStyle(() => ({ opacity: interpolate(y.get(), [0, 24], [back ? 0.6 : 0, 1], "clamp") }));
  // petit titre : toujours là si un en-tête remplace le grand titre, sinon il prend le relais quand le grand titre sort
  const pinned = !!hero;
  const titleStyle = useAnimatedStyle(() => ({ opacity: pinned ? 1 : interpolate(y.get(), [28, 52], [0, 1], "clamp") }));
  const top = insets.top + BAR_H;
  const bottom = (Platform.OS === "web" ? TAB_BAR_H + insets.bottom : 0) + space.xxl;

  return (
    <View style={styles.root}>
      <Animated.ScrollView
        onScroll={onScroll} scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: back ? top + space.sm : insets.top + space.md, paddingBottom: bottom, paddingHorizontal: space.lg }}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.text3} progressViewOffset={top} /> : undefined}
        keyboardShouldPersistTaps="handled"
      >
        {hero ?? (
          <View style={styles.titleBlock}>
            {mode === "demo" && !back ? <DemoBanner /> : null}
            <View style={styles.titleRow}>
              <View style={styles.titleText}>
                <Txt v="largeTitle" accessibilityRole="header">{title}</Txt>
                {subtitle ? <Txt v="subhead" style={styles.subtitle}>{subtitle}</Txt> : null}
              </View>
              {!back && right ? <View style={styles.right}>{right}</View> : null}
            </View>
          </View>
        )}
        {children}
      </Animated.ScrollView>

      <View style={[styles.bar, { height: top, paddingTop: insets.top }]} pointerEvents="box-none">
        <Animated.View style={[StyleSheet.absoluteFill, barStyle]} pointerEvents="none">
          {Platform.OS === "android"
            ? <View style={[StyleSheet.absoluteFill, { backgroundColor: color.bg }]} />
            : <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill}><View style={styles.barTint} /></BlurView>}
          <View style={styles.barEdge} />
        </Animated.View>
        <View style={styles.barRow} pointerEvents="box-none">
          <View style={styles.side}>
            {back ? (
              <PressableScale onPress={() => (router.canGoBack() ? router.back() : router.replace("/today"))} hitSlop={8}
                accessibilityRole="button" accessibilityLabel={t.common.back} style={styles.backBtn}>
                <Icon name="chevronLeft" color={color.accent} size={26} />
              </PressableScale>
            ) : null}
          </View>
          <Animated.View style={[styles.barTitle, titleStyle]} pointerEvents="none">
            <Txt v="headline" numberOfLines={1}>{title}</Txt>
          </Animated.View>
          <View style={[styles.side, styles.sideRight]}>{back ? right : null}</View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  titleBlock: { marginBottom: space.sm, gap: space.sm },
  titleRow: { flexDirection: "row", alignItems: "flex-end", gap: space.md },
  titleText: { flex: 1 },
  subtitle: { marginTop: 2 },
  right: { paddingBottom: 4 },
  bar: { position: "absolute", left: 0, right: 0, top: 0 },
  barTint: { flex: 1, backgroundColor: color.bar },
  barEdge: { position: "absolute", left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: color.line },
  barRow: { flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm },
  side: { width: 64, justifyContent: "center" },
  sideRight: { alignItems: "flex-end" },
  backBtn: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" },
  barTitle: { flex: 1, alignItems: "center" },
});
