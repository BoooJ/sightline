import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import { createHttpApi, loginWithPassword } from "./http";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("client HTTP", () => {
  it("lit le cahier des stratégies", async () => {
    const { fn, calls } = fakeFetch(200, []);
    const api = createHttpApi({ baseUrl: "https://srv", useCookies: false, getToken: () => "tok", onUnauthorized: vi.fn(), fetchFn: fn });
    await api.strats();
    await api.strat(7);
    expect(calls.map((c) => c.url)).toEqual(["https://srv/api/strats", "https://srv/api/strats/7"]);
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
  });
  it("envoie le jeton Bearer et les paramètres", async () => {
    const { fn, calls } = fakeFetch(200, { throws: [], lineups: [] });
    const api = createHttpApi({ baseUrl: "https://srv", useCookies: false, getToken: () => "tok", onUnauthorized: vi.fn(), fetchFn: fn });
    await api.grenades("de_dust2", { team: 4 });
    expect(calls[0].url).toBe("https://srv/api/grenades?map=de_dust2&team=4&lineups=true&throws=false");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(calls[0].init.credentials).toBe("omit");
    expect(api.assetUrl("/maps/de_dust2.png")).toBe("https://srv/maps/de_dust2.png");
  });
  it("utilise le cookie du site sur le web (même origine)", async () => {
    const { fn, calls } = fakeFetch(200, []);
    const api = createHttpApi({ baseUrl: "", useCookies: true, getToken: () => null, onUnauthorized: vi.fn(), fetchFn: fn });
    await api.calendar();
    expect(calls[0].url).toBe("/api/calendar");
    expect(calls[0].init.credentials).toBe("include");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
  it("signale une session expirée et lit le message d'erreur", async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch(401, { detail: "Connexion requise" });
    const api = createHttpApi({ baseUrl: "", useCookies: true, getToken: () => null, onUnauthorized, fetchFn: fn });
    await expect(api.scoutTeams()).rejects.toEqual(new ApiError(401, "Connexion requise"));
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it("n'appelle pas onUnauthorized pour les routes de connexion", async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch(401, {});
    const api = createHttpApi({ baseUrl: "", useCookies: true, getToken: () => null, onUnauthorized, fetchFn: fn });
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
  it("envoie le corps en JSON", async () => {
    const { fn, calls } = fakeFetch(200, { id: 1 });
    const api = createHttpApi({ baseUrl: "", useCookies: true, getToken: () => null, onUnauthorized: vi.fn(), fetchFn: fn });
    await api.updateMe({ steamid: "765" });
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].init.body).toBe('{"steamid":"765"}');
  });
  it("envoie le pseudo TeamSpeak", async () => {
    const { fn, calls } = fakeFetch(200, { id: 1, ts_nickname: "sk1zy" });
    const api = createHttpApi({ baseUrl: "", useCookies: true, getToken: () => null, onUnauthorized: vi.fn(), fetchFn: fn });
    await api.updateMe({ ts_nickname: "sk1zy" });
    expect(calls[0].init.body).toBe('{"ts_nickname":"sk1zy"}');
  });
});

describe("connexion", () => {
  it("natif : demande un jeton", async () => {
    const { fn, calls } = fakeFetch(200, { token: "abc", user: { id: 1 } });
    const r = await loginWithPassword({ baseUrl: "https://srv", useCookies: false, username: "a", password: "b", fetchFn: fn });
    expect(calls[0].url).toBe("https://srv/api/auth/token");
    expect(r).toEqual({ token: "abc", user: { id: 1 } });
  });
  it("web : cookie du site, pas de jeton gardé", async () => {
    const { fn, calls } = fakeFetch(200, { user: { id: 1 }, setup_required: false });
    const r = await loginWithPassword({ baseUrl: "", useCookies: true, username: "a", password: "b", fetchFn: fn });
    expect(calls[0].url).toBe("/api/auth/login");
    expect(r.token).toBeNull();
  });
  it("mauvais mot de passe : message du serveur", async () => {
    const { fn } = fakeFetch(401, { detail: "Identifiant ou mot de passe incorrect" });
    await expect(loginWithPassword({ baseUrl: "", useCookies: true, username: "a", password: "b", fetchFn: fn }))
      .rejects.toThrow("Identifiant ou mot de passe incorrect");
  });
});
