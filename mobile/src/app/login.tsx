import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError } from "@/api/api";
import { useSession } from "@/api/session";
import { Logo } from "@/components/Logo";
import { t } from "@/i18n/fr";
import { Button } from "@/ui/Button";
import { Txt } from "@/ui/Txt";
import { color, radius, space, TOUCH, type as typeScale } from "@/ui/theme";

export default function Login() {
  const { login, startDemo } = useSession();
  const insets = useSafeAreaInsets();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"login" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pwd = useRef<React.ComponentRef<typeof TextInput>>(null);

  async function submit() {
    if (!username.trim() || !password) return setError(t.login.missing);
    setBusy("login");
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.offline);
      setBusy(null);
    }
  }

  async function demo() {
    setBusy("demo");
    try {
      await startDemo();
    } catch {
      setError(t.common.loadingError);
      setBusy(null);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled">
        <View style={styles.brand}>
          <Logo size={72} />
          <Txt v="largeTitle" style={styles.name}>{t.app.name}</Txt>
          <Txt v="callout">{t.app.tagline}</Txt>
        </View>

        <View style={styles.form}>
          <Txt v="title" accessibilityRole="header">{t.login.title}</Txt>
          <Txt v="callout">{t.login.lead}</Txt>
          <Field label={t.login.username}>
            <TextInput
              value={username} onChangeText={setUsername} style={styles.input} autoCapitalize="none" autoCorrect={false}
              autoComplete="username" textContentType="username" returnKeyType="next" placeholderTextColor={color.text3}
              onSubmitEditing={() => pwd.current?.focus()} accessibilityLabel={t.login.username}
            />
          </Field>
          <Field label={t.login.password}>
            <TextInput
              ref={pwd} value={password} onChangeText={setPassword} style={styles.input} secureTextEntry autoComplete="current-password"
              textContentType="password" returnKeyType="go" onSubmitEditing={submit} accessibilityLabel={t.login.password}
            />
          </Field>
          {error ? <Txt v="subhead" color={color.bad} accessibilityRole="alert">{error}</Txt> : null}
          <Button label={busy === "login" ? t.login.submitting : t.login.submit} onPress={submit} busy={busy === "login"} disabled={busy === "demo"} />
        </View>

        <View style={styles.demo}>
          <Button label={t.login.demo} kind="secondary" onPress={demo} busy={busy === "demo"} disabled={busy === "login"} icon="eye" />
          <Txt v="caption" style={styles.center}>{t.login.demoHint}</Txt>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Txt v="label">{label}</Txt>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { paddingHorizontal: space.xl, gap: space.xxl, flexGrow: 1, maxWidth: 480, width: "100%", alignSelf: "center" },
  brand: { alignItems: "center", gap: space.xs },
  name: { marginTop: space.md },
  form: { gap: space.md },
  field: { gap: 6 },
  input: {
    ...typeScale.body, minHeight: TOUCH + 4, borderRadius: radius.md, backgroundColor: color.surface2, color: color.text,
    paddingHorizontal: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  demo: { gap: space.sm, marginTop: "auto" },
  center: { textAlign: "center" },
});
