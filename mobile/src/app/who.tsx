import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { usePlayers } from "@/api/hooks";
import { useWhoLater } from "@/api/me";
import { useSession } from "@/api/session";
import { t } from "@/i18n/fr";
import { num } from "@/lib/format";
import { normalizeName } from "@/lib/opponent";
import { parseSteamId } from "@/lib/steam";
import { Button } from "@/ui/Button";
import { ListGroup, ListRow } from "@/ui/ListRow";
import { Screen } from "@/ui/Screen";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, radius, space, TOUCH, type as typeScale } from "@/ui/theme";

/** Lier son compte à son joueur (SteamID) : l'app en a besoin pour « mes matchs » et « ma progression ».
 *  Depuis le Compte (« Changer ») : bouton retour. À la première connexion, l'écran est imposé (pas de retour : les
 *  onglets y renverraient). Un membre qu'aucune démo ne montre encore colle son SteamID, ou entre « Plus tard ». */
export default function Who() {
  const { api, user, setUser, signOut } = useSession();
  const { later, setLater } = useWhoLater();
  const forced = !user?.steamid && !later;
  const players = usePlayers();
  const [q, setQ] = useState("");
  const [steam, setSteam] = useState("");
  const [steamError, setSteamError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needle = normalizeName(q);
  const list = (players.data ?? [])
    .filter((p) => !needle || normalizeName(p.name).includes(needle) || normalizeName(p.team).includes(needle))
    .sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name));

  async function pick(steamid: string) {
    try {
      setUser(await api.updateMe({ steamid }));
      if (forced || !router.canGoBack()) router.replace("/today");
      else router.back();
    } catch {
      setError(t.who.saveError);
    }
  }

  function linkTyped() {
    const sid = parseSteamId(steam);
    if (sid) void pick(sid);
    else setSteamError(t.who.steamInvalid);
  }

  function skip() {
    setLater(true);
    router.replace("/today");
  }

  return (
    <Screen title={t.who.title} subtitle={t.who.lead} back={!forced}>
      <TextInput
        value={q} onChangeText={setQ} placeholder={t.who.search} placeholderTextColor={color.text3} style={styles.search}
        autoCorrect={false} autoCapitalize="none" accessibilityLabel={t.who.search} clearButtonMode="while-editing"
      />
      {error ? <Txt v="subhead" color={color.bad} style={styles.error}>{error}</Txt> : null}
      {players.isPending ? <Loading /> : players.isError ? <ErrorState error={players.error} onRetry={() => void players.refetch()} />
        : list.length === 0 ? <EmptyState text={t.who.empty} /> : (
          <ListGroup>
            {list.slice(0, 80).map((p) => (
              <ListRow key={p.steamid} title={p.name} subtitle={`${p.team} · ${t.common.matches(p.matches)}`}
                value={num(p.rating)} onPress={() => void pick(p.steamid)} />
            ))}
          </ListGroup>
        )}
      <View style={styles.out}>
        <Txt v="caption">{t.who.notListed}</Txt>
        <TextInput
          value={steam} onChangeText={(v) => { setSteam(v); setSteamError(null); }} placeholder={t.who.steamPlaceholder}
          placeholderTextColor={color.text3} style={[styles.search, styles.steam]} autoCorrect={false} autoCapitalize="none"
          accessibilityLabel={t.who.steamLabel} inputMode="url" returnKeyType="done" onSubmitEditing={linkTyped}
        />
        {steamError ? <Txt v="subhead" color={color.bad}>{steamError}</Txt> : null}
        <Button label={t.who.steamLink} kind="secondary" onPress={linkTyped} disabled={!steam.trim()} />
        {forced ? (
          <>
            <Button label={t.who.later} kind="plain" onPress={skip} />
            <Txt v="caption">{t.who.laterHint}</Txt>
            <Button label={t.account.signOut} kind="plain" onPress={() => void signOut()} />
          </>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    ...typeScale.body, minHeight: TOUCH, borderRadius: radius.md, backgroundColor: color.surface2, color: color.text,
    paddingHorizontal: space.md, marginVertical: space.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  error: { marginBottom: space.md },
  steam: { marginVertical: 0 },
  out: { marginTop: space.xl, gap: space.md },
});
