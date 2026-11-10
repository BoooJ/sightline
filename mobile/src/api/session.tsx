import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { Api } from "./api";
import { API_BASE, SAME_ORIGIN } from "./config";
import { createDemoApi, type DemoNote } from "./demo";
import { createHttpApi, loginWithPassword } from "./http";
import { prefs, tokenStore } from "./storage";
import type { AppUser } from "./types";

export type SessionStatus = "loading" | "signedOut" | "signedIn" | "demo";

interface Session {
  status: SessionStatus;
  user: AppUser | null;
  api: Api;
  mode: "http" | "demo";
  login(username: string, password: string): Promise<void>;
  startDemo(): Promise<void>;
  signOut(): Promise<void>;
  setUser(u: AppUser): void;
}

interface State { status: SessionStatus; user: AppUser | null; demo: Api | null }

const MODE_KEY = "sl-mode";
const DEMO_NOTES_KEY = "sl-demo-notes";
const SIGNED_OUT: State = { status: "signedOut", user: null, demo: null };

// Le jeton vit hors de React : le client HTTP le lit à chaque requête, la session le remplace à la connexion.
let token: string | null = null;
let onExpired = () => {};
const httpApi = createHttpApi({
  baseUrl: API_BASE, useCookies: SAME_ORIGIN, getToken: () => token, onUnauthorized: () => onExpired(),
});

async function demoState(): Promise<State> {
  const { loadDemo } = await import("@/demo");
  const fixtures = await loadDemo();
  // les notes écrites dans la démo restent sur le téléphone jusqu'à « Quitter la démo »
  let initial = fixtures.notes ?? [];
  try {
    const saved = await prefs.get(DEMO_NOTES_KEY);
    if (saved) initial = JSON.parse(saved) as DemoNote[];
  } catch {
    // sauvegarde illisible : on repart des notes d'exemple
  }
  const notes = { initial, save: (list: DemoNote[]) => void prefs.set(DEMO_NOTES_KEY, JSON.stringify(list)) };
  return { status: "demo", user: fixtures.me, demo: createDemoApi({ fixtures, now: () => new Date(), assetBase: API_BASE, notes }) };
}

/** Reprise : démo ouverte la dernière fois, jeton gardé (natif) ou cookie du site (web). */
async function restore(): Promise<State> {
  if ((await prefs.get(MODE_KEY)) === "demo") return demoState();
  token = SAME_ORIGIN ? null : await tokenStore.get().catch(() => null);
  if (!SAME_ORIGIN && !token) return SIGNED_OUT;
  try {
    const me = await httpApi.me();
    return me.user ? { status: "signedIn", user: me.user, demo: null } : SIGNED_OUT;
  } catch {
    return SIGNED_OUT;
  }
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<State>({ status: "loading", user: null, demo: null });

  useEffect(() => {
    let alive = true;
    onExpired = () => {
      token = null;
      void tokenStore.clear().catch(() => {});
      setState(SIGNED_OUT);
    };
    void restore().then((s) => { if (alive) setState(s); });
    return () => {
      alive = false;
      onExpired = () => {};
    };
  }, []);

  const session: Session = {
    status: state.status,
    user: state.user,
    mode: state.status === "demo" ? "demo" : "http",
    api: state.status === "demo" && state.demo ? state.demo : httpApi,
    async login(username, password) {
      const r = await loginWithPassword({ baseUrl: API_BASE, useCookies: SAME_ORIGIN, username, password });
      if (r.token) {
        token = r.token;
        await tokenStore.set(r.token).catch(() => {});
      }
      await prefs.set(MODE_KEY, "http");
      qc.clear();
      setState({ status: "signedIn", user: r.user, demo: null });
    },
    async startDemo() {
      await prefs.set(MODE_KEY, "demo");
      qc.clear();
      setState(await demoState());
    },
    async signOut() {
      if (state.status !== "demo") await httpApi.logout().catch(() => {});
      else await prefs.remove(DEMO_NOTES_KEY);  // la démo suivante repart des notes d'exemple
      token = null;
      await tokenStore.clear().catch(() => {});
      await prefs.remove(MODE_KEY);
      qc.clear();
      setState(SIGNED_OUT);
    },
    setUser: (u) => setState((s) => ({ ...s, user: u })),
  };

  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession hors de SessionProvider");
  return s;
}
