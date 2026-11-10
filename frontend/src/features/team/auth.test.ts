// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeCaches } from "../replay3d/fakeCaches";
import { FILES3D_CACHE } from "../replay3d/glbCache";
import { AuthGate, signOut } from "./auth";

// serveur remplacé : qui est connecté (`me`), déconnexion (`logout`)
const api = vi.hoisted(() => ({ me: vi.fn(), logout: vi.fn() }));
vi.mock("../../shared/api/client", () => ({ api }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = { id: 1, username: "coach", display_name: "Coach", role: "admin", created_at: null };
let caches: FakeCaches;
const roots: Root[] = [];
beforeEach(async () => {
  caches = new FakeCaches();
  vi.stubGlobal("caches", caches);
  await caches.open(FILES3D_CACHE);  // copies d'une visite précédente
});
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  api.me.mockReset();
  api.logout.mockReset();
});

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
async function gate(publicRoute = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const div = document.createElement("div"), root = createRoot(div);
  roots.push(root);
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(AuthGate, { publicRoute, children: createElement("p", { id: "app" }) }))));
  for (let i = 0; i < 50 && div.querySelector(".spinner"); i++) await settle();  // réponse de `me` arrivée
  return div;
}
const kept = async () => (await caches.keys()).includes(FILES3D_CACHE);
const login = (div: HTMLElement) => div.querySelector('[data-testid="login-form"]');

describe("copies des fichiers 3D (cartes, bras) et session", () => {
  it("le serveur ne connaît plus personne (session expirée, compte retiré) : écran de connexion, copies effacées", async () => {
    api.me.mockResolvedValue({ user: null, setup_required: false });
    expect(login(await gate())).not.toBeNull();
    expect(await kept()).toBe(false);
  });

  it("même sur une page publique (lien de partage) : personne de connecté, copies effacées", async () => {
    api.me.mockResolvedValue({ user: null, setup_required: false });
    expect((await gate(true)).querySelector("#app")).not.toBeNull();
    expect(await kept()).toBe(false);
  });

  it("connecté, ou accès ouvert sans compte : copies gardées ; serveur injoignable (écran de connexion par défaut) : gardées aussi", async () => {
    api.me.mockResolvedValue({ user: USER, setup_required: false });
    expect((await gate()).querySelector("#app")).not.toBeNull();
    api.me.mockResolvedValue({ user: null, setup_required: true });
    await gate();
    // redémarrage du serveur, réseau coupé : rien ne dit que la session a pris fin, on ne vide pas ≈ 550 Mo pour si peu
    api.me.mockRejectedValue(new Error("Failed to fetch"));
    expect(login(await gate())).not.toBeNull();
    expect(await kept()).toBe(true);
  });

  it("session expirée en cours de route (401 → « auth-required », puis le serveur ne connaît plus personne) : copies effacées", async () => {
    api.me.mockResolvedValue({ user: USER, setup_required: false });
    const div = await gate();
    expect(div.querySelector("#app")).not.toBeNull();
    expect(await kept()).toBe(true);
    api.me.mockResolvedValue({ user: null, setup_required: false });
    act(() => { window.dispatchEvent(new Event("auth-required")); });
    for (let i = 0; i < 50 && !login(div); i++) await settle();  // `me` relu
    expect(login(div)).not.toBeNull();
    expect(await kept()).toBe(false);
  });

  it("déconnexion : copies effacées même si le serveur ne répond pas ; sinon session oubliée", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});  // jsdom ne sait pas changer de page (location.assign)
    const qc = new QueryClient();
    qc.setQueryData(["me"], { user: USER, setup_required: false });
    api.logout.mockRejectedValue(new Error("Failed to fetch"));
    await expect(signOut(qc)).rejects.toThrow("Failed to fetch");
    expect(await kept()).toBe(false);
    await caches.open(FILES3D_CACHE);
    api.logout.mockResolvedValue({ ok: true });
    await signOut(qc);
    expect(qc.getQueryData(["me"])).toBeUndefined();
    expect(await kept()).toBe(false);
  });
});
