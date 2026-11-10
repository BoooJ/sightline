import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { ApiError } from "@/api/api";
import { APP_VERSION, SAME_ORIGIN, SERVER } from "@/api/config";
import { useDashboard } from "@/api/hooks";
import { useMySteamid } from "@/api/me";
import { useSession } from "@/api/session";
import { t } from "@/i18n/fr";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/webpush";
import { Button } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { ListGroup, ListRow } from "@/ui/ListRow";
import { tap } from "@/ui/PressableScale";
import { Screen } from "@/ui/Screen";
import { Section } from "@/ui/Section";
import { Skeleton } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, radius, space } from "@/ui/theme";

export default function Account() {
  const { mode, user, signOut } = useSession();
  const player = useDashboard(useMySteamid()).data?.player;
  const demo = mode === "demo";
  return (
    <Screen title={t.account.title} back>
      <Section label={t.account.player}>
        <ListGroup>
          <ListRow title={player?.name ?? user?.display_name ?? "—"} subtitle={player?.team}
            value={demo ? undefined : user?.steamid ? t.account.change : t.who.linkCta} onPress={demo ? undefined : () => router.push("/who")} />
        </ListGroup>
      </Section>
      {demo ? null : (
        <Section label={t.account.tsNickname} lead={t.account.tsHint}>
          <TsNickname />
        </Section>
      )}
      <Notifications demo={demo} />
      <Section label={t.account.server}>
        <ListGroup>
          <ListRow title={demo ? t.account.demoServer : SAME_ORIGIN ? t.account.teamSite : SERVER.replace("https://", "")}
            subtitle={demo ? t.demo.banner : user?.username} />
          <ListRow title={t.account.version} value={APP_VERSION} />
        </ListGroup>
        <Txt v="caption">{t.account.about}</Txt>
      </Section>
      <View style={styles.out}>
        <Button label={demo ? t.demo.leave : t.account.signOut} kind="secondary" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

function TsNickname() {
  const { api, user, setUser } = useSession();
  const [v, setV] = useState(user?.ts_nickname ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const save = async () => {
    if (busy) return;
    const next = v.trim() || null;
    if (next === (user?.ts_nickname ?? null)) return;
    setBusy(true);
    setError(false);
    try {
      setUser(await api.updateMe({ ts_nickname: next }));
      setV(next ?? "");
      setSaved(true);
    } catch {
      setSaved(false);
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.tsRow}>
      <TextInput value={v} onChangeText={(x) => { setV(x); setSaved(false); }} onBlur={() => void save()} onSubmitEditing={() => void save()}
        placeholder={t.account.tsNickname} placeholderTextColor={color.text3} autoCapitalize="none" autoCorrect={false} maxLength={64}
        accessibilityLabel={t.account.tsNickname} style={styles.tsInput} returnKeyType="done" />
      {saved ? <Txt v="caption" color={color.accent}>{t.account.saved}</Txt> : null}
      {error ? <Txt v="subhead" color={color.bad} accessibilityRole="alert">{t.account.tsError}</Txt> : null}
    </View>
  );
}

/** La permission n'est demandée qu'au toucher de « Activer », après avoir dit ce qu'on recevra. */
function Notifications({ demo }: { demo: boolean }) {
  const { api } = useSession();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void pushState().then(setState).catch(() => setState("unsupported"));
  }, []);

  async function run(action: () => Promise<PushState>) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      if (next === "on") tap("success");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.notifications.error);
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (demo) body = <Txt v="callout">{t.notifications.demo}</Txt>;
  else if (state === null) body = <Skeleton height={56} />;
  else if (state === "native") body = <Txt v="callout">{t.notifications.native}</Txt>;
  else if (state === "unsupported") body = <Txt v="callout">{t.notifications.unsupported}</Txt>;
  else if (state === "denied") body = <Txt v="callout">{t.notifications.denied}</Txt>;
  else if (state === "install") {
    body = (
      <View style={styles.guide}>
        <Txt v="headline">{t.notifications.installTitle}</Txt>
        {t.notifications.steps.map((s, i) => (
          <View key={i} style={styles.step}>
            <View style={styles.stepNum}><Txt v="data" color={color.accent}>{i + 1}</Txt></View>
            <Txt v="body" style={styles.flex}>{s}</Txt>
          </View>
        ))}
      </View>
    );
  } else if (state === "on") {
    body = (
      <View style={styles.on}>
        <View style={styles.onRow}>
          <Icon name="check" color={color.accent} />
          <Txt v="body" style={styles.flex}>{t.notifications.on}</Txt>
        </View>
        <Button label={t.notifications.disable} kind="plain" busy={busy} onPress={() => void run(() => disablePush(api))} />
      </View>
    );
  } else {
    body = <Button label={t.notifications.enable} busy={busy} onPress={() => void run(() => enablePush(api))} />;
  }

  return (
    <Section label={t.notifications.title} lead={demo ? undefined : t.notifications.lead}>
      {body}
      {error ? <Txt v="subhead" color={color.bad} accessibilityRole="alert">{error}</Txt> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  out: { marginTop: space.xxl },
  flex: { flex: 1 },
  guide: { backgroundColor: color.surface2, borderRadius: radius.card, padding: space.lg, gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  step: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  stepNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: color.accentDim, alignItems: "center", justifyContent: "center" },
  tsRow: { gap: space.xs },
  tsInput: { minHeight: 44, borderRadius: radius.md, backgroundColor: color.surface2, color: color.text, paddingHorizontal: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  on: { gap: space.sm },
  onRow: { flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: color.surface2, borderRadius: radius.card, padding: space.lg },
});
