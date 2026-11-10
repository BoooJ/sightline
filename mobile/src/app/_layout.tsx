import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { SessionProvider, useSession } from "@/api/session";
import { useAppFonts } from "@/ui/fonts";
import { SafeAreaInsets } from "@/ui/SafeArea";
import { color } from "@/ui/theme";

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } });

// retour au premier plan : les écrans visibles se remettent à jour (react-query ne voit pas AppState tout seul)
if (Platform.OS !== "web") {
  AppState.addEventListener("change", (s) => focusManager.setFocused(s === "active"));
}

const navTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: color.bg, card: color.bg, primary: color.accent, text: color.text, border: color.line },
};

export default function RootLayout() {
  const fonts = useAppFonts();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.bg }}>
      <SafeAreaInsets>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <ThemeProvider value={navTheme}>
              <StatusBar style="light" />
              <Gate fontsLoaded={fonts} />
            </ThemeProvider>
          </SessionProvider>
        </QueryClientProvider>
      </SafeAreaInsets>
    </GestureHandlerRootView>
  );
}

/** Écran de lancement tant que les polices et la session ne sont pas prêtes ; puis l'app ou la connexion. */
function Gate({ fontsLoaded }: { fontsLoaded: boolean }) {
  const { status } = useSession();
  const ready = fontsLoaded && status !== "loading";
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;
  const signed = status === "signedIn" || status === "demo";
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
      <Stack.Protected guard={signed}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="who" />
        {/* éditeur de note : plein écran, au-dessus des onglets (présenté en modale sur iPhone et Android) */}
        <Stack.Screen name="note" options={{ presentation: Platform.OS === "web" ? "card" : "modal" }} />
      </Stack.Protected>
      <Stack.Protected guard={!signed}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}
