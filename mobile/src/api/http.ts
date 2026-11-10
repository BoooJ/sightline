import { ApiError, type Api } from "./api";
import type { AppUser } from "./types";

type Fetch = typeof fetch;
type Query = Record<string, string | number | boolean | null | undefined>;

export interface HttpOptions {
  /** « » pour la version web servie par le site (même origine), sinon l'adresse du serveur */
  baseUrl: string;
  /** web même origine : cookie de session du site ; natif : jeton Bearer */
  useCookies: boolean;
  getToken: () => string | null;
  onUnauthorized: () => void;
  fetchFn?: Fetch;
}

function qs(p: Query): string {
  const s = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
}

async function failure(r: Response): Promise<ApiError> {
  let detail = "";
  try {
    const j = await r.json();
    if (typeof j?.detail === "string") detail = j.detail;
  } catch {
    // corps vide ou pas du JSON : le statut suffit
  }
  return new ApiError(r.status, detail || `Erreur ${r.status}`);
}

export function createHttpApi(o: HttpOptions): Api {
  const f = o.fetchFn ?? fetch;
  async function req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const token = o.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await f(`${o.baseUrl}${path}`, {
      method: init.method ?? "GET", headers, credentials: o.useCookies ? "include" : "omit",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (r.status === 401 && !path.startsWith("/api/auth/")) o.onUnauthorized();
    if (!r.ok) throw await failure(r);
    return (r.status === 204 ? undefined : await r.json()) as T;
  }
  return {
    me: () => req("/api/auth/me"),
    updateMe: (p) => req("/api/auth/me", { method: "PATCH", body: p }),
    logout: async () => { await req("/api/auth/logout", { method: "POST" }); },
    calendar: () => req("/api/calendar"),
    scoutTeams: () => req("/api/scouting/teams"),
    scoutReport: (id) => req(`/api/scouting/teams/${id}`),
    scoutBrief: (id, map) => req(`/api/scouting/teams/${id}/brief${qs({ map })}`),
    players: () => req("/api/players"),
    profile: (sid) => req(`/api/players/${encodeURIComponent(sid)}/profile`),
    dashboard: (sid) => req(`/api/players/${encodeURIComponent(sid)}/dashboard`),
    match: (id) => req(`/api/matches/${id}`),
    analysis: (id) => req(`/api/matches/${id}/analysis`),
    debrief: (id, team) => req(`/api/matches/${id}/debrief${qs({ team })}`),
    maps: () => req("/api/maps"),
    grenades: (map, flt) => req(`/api/grenades${qs({ map, team: flt?.team, lineups: true, throws: false })}`),
    callouts: (map) => req(`/api/callouts${qs({ map })}`),
    strats: () => req("/api/strats"),
    strat: (id) => req(`/api/strats/${id}`),
    goals: (teamId) => req(`/api/teams/${teamId}/goals`),
    notes: (flt = {}) => req(`/api/notes${qs({ ...flt })}`),
    note: (id) => req(`/api/notes/${id}`),
    createNote: (p) => req("/api/notes", { method: "POST", body: p }),
    updateNote: (id, p) => req(`/api/notes/${id}`, { method: "PATCH", body: p }),
    deleteNote: async (id) => { await req(`/api/notes/${id}`, { method: "DELETE" }); },
    notifications: (after) => req(`/api/notifications${qs({ after, limit: 50 })}`),
    pushKey: async () => (await req<{ key: string }>("/api/push/key")).key,
    pushSubscribe: async (sub) => { await req("/api/push/subscriptions", { method: "POST", body: sub }); },
    pushUnsubscribe: async (endpoint) => { await req("/api/push/subscriptions", { method: "DELETE", body: { endpoint } }); },
    assetUrl: (p) => `${o.baseUrl}${p}`,
  };
}

/** Connexion : cookie du site pour la version web, jeton à garder dans le trousseau pour l'app native. */
export async function loginWithPassword(o: {
  baseUrl: string; useCookies: boolean; username: string; password: string; fetchFn?: Fetch;
}): Promise<{ user: AppUser; token: string | null }> {
  const f = o.fetchFn ?? fetch;
  const r = await f(`${o.baseUrl}${o.useCookies ? "/api/auth/login" : "/api/auth/token"}`, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    credentials: o.useCookies ? "include" : "omit",
    body: JSON.stringify({ username: o.username, password: o.password }),
  });
  if (!r.ok) throw await failure(r);
  const j = await r.json();
  return { user: j.user, token: o.useCookies ? null : j.token };
}
