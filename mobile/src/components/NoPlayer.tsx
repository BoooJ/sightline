import { router } from "expo-router";
import { StyleSheet, View } from "react-native";

import { ApiError } from "@/api/api";
import { t } from "@/i18n/fr";
import { Button } from "@/ui/Button";
import { Txt } from "@/ui/Txt";
import { space } from "@/ui/theme";

/** Joueur lié mais absent des démos importées (SteamID collé à la main) : le serveur répond 404. */
export const noDemoYet = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/** Écran perso d'un membre entré sans joueur (« Plus tard ») ou sans démo à son nom : quoi faire, au lieu d'un
 *  chargement sans fin ou d'une erreur. */
export function NoPlayer({ linked }: { linked: boolean }) {
  return (
    <View style={styles.box}>
      <Txt v="callout" style={styles.center}>{linked ? t.who.noStats : t.who.noPlayer}</Txt>
      {linked ? null : <Button label={t.who.linkCta} kind="secondary" onPress={() => router.push("/who")} />}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", gap: space.md, paddingVertical: space.xl, paddingHorizontal: space.lg },
  center: { textAlign: "center" },
});
