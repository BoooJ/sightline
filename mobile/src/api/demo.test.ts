import { describe, expect, it } from "vitest";

import { readyFrom } from "@/lib/today";

import { ApiError } from "./api";
import { createDemoApi, type DemoFixtures, type DemoNote } from "./demo";
import type { Strat } from "./types";

const strat = {
  id: 4, name: "Exécution B", map: "de_dust2", side: "T", type: "execute", tags: ["b"], author: "Démo", updated_at: "2026-10-17T16:00:00",
  counts: { positions: 0, grenades: 0, shapes: 0 }, description: "Plan", source: null, shapes: [],
  positions: [{ name: "flameZ", role: "Entry", pos: [0, 0, 0], yaw: 0 }],
  grenades: [{ type: "smoke", player: "apEX", note: "", throw: null, land: [1, 2, 3], setpos: null, timing_s: 40, trajectory: [] }],
} as Strat;

const fixtures = {
  me: { id: 0, username: "demo", display_name: "ZywOo", role: "member", created_at: null, steamid: "7656" },
  event: { title: "ESL Pro League", opponent: "MOUZ", maps: ["de_inferno"], inDays: 2, hour: 20 },
  readyMatchId: 3,
  readyTitle: "Match prêt : Vitality 13–9 MOUZ",
  teams: [{ id: 2, name: "MOUZ", matches: 3, wins: 1, maps: 3 }],
  scoutReports: {}, briefs: {}, players: [], profile: {}, dashboard: {}, matches: {}, analyses: {}, debriefs: {},
  maps: [], callouts: {}, goals: {}, strats: [strat],
  grenades: { de_inferno: { throws: [], lineups: [{ key: 1 }] }, "de_inferno:2": { throws: [], lineups: [{ key: 2 }] } },
} as unknown as DemoFixtures;

const now = new Date(2026, 9, 19, 18, 30);
const api = createDemoApi({ fixtures, now: () => now, assetBase: "https://srv" });

describe("client démo", () => {
  it("place le prochain match par rapport à aujourd'hui", async () => {
    const [ev] = await api.calendar();
    expect(ev).toMatchObject({ opponent: "MOUZ", kind: "match", starts_at: "2026-10-21T20:00" });
  });
  it("annonce le dernier match comme tout juste analysé", async () => {
    const ready = readyFrom(await api.notifications());
    expect(ready).toEqual([{ match_id: 3, at: new Date(now.getTime() - 2 * 3_600_000) }]);
  });
  it("sert les grenades de la carte, ou d'une équipe", async () => {
    expect((await api.grenades("de_inferno")).lineups).toEqual([{ key: 1 }]);
    expect((await api.grenades("de_inferno", { team: 2 })).lineups).toEqual([{ key: 2 }]);
    expect((await api.grenades("de_nuke")).lineups).toEqual([]);
  });
  it("sert les stratégies d'exemple : résumés, fiche, 404", async () => {
    const [s] = await api.strats();
    expect(s).toMatchObject({ id: 4, name: "Exécution B", counts: { positions: 1, grenades: 1, shapes: 0 } });
    expect(s).not.toHaveProperty("grenades");
    expect((await api.strat(4)).description).toBe("Plan");
    await expect(api.strat(99)).rejects.toMatchObject({ status: 404 });
  });
  it("refuse proprement ce qui n'est pas dans la démo", async () => {
    await expect(api.match(99)).rejects.toEqual(new ApiError(404, "Match absent de la démo"));
    await expect(api.profile("autre")).rejects.toBeInstanceOf(ApiError);
  });
  it("garde le joueur de la démo", async () => {
    expect((await api.updateMe({ steamid: null })).steamid).toBe("7656");
    expect(api.assetUrl("/maps/de_inferno.png")).toBe("https://srv/maps/de_inferno.png");
  });
});

describe("notes de la démo, gardées sur le téléphone", () => {
  const seed: DemoNote[] = [
    { id: 1, map: "de_dust2", side: "T", body: "à moi", shared: false, author_id: 0, author: "ZywOo", match_id: 3, team_id: 2,
      strat_id: 4, created_at: "2026-10-18T10:00:00", updated_at: "2026-10-18T10:00:00" },
    { id: 2, map: "de_inferno", side: null, body: "de l'IGL", shared: true, author_id: 7, author: "apEX", match_id: null,
      team_id: null, strat_id: null, created_at: "2026-10-17T10:00:00", updated_at: "2026-10-17T10:00:00" },
  ];
  const withMatch = {
    ...fixtures,
    matches: { 3: { id: 3, map_name: "de_dust2", date: "2026-10-18", team_a: { id: 2, name: "MOUZ" }, team_b: { id: 1, name: "Vitality" } } },
  } as unknown as DemoFixtures;
  function make() {
    const saved: DemoNote[][] = [];
    const demo = createDemoApi({ fixtures: withMatch, now: () => now, assetBase: "", notes: { initial: seed, save: (l) => saved.push(l) } });
    return { demo, saved };
  }

  it("rend les notes avec leur contexte, les plus récentes d'abord", async () => {
    const { demo } = make();
    const [a, b] = await demo.notes();
    expect(a).toMatchObject({ id: 1, mine: true, match: { id: 3, title: "MOUZ vs Vitality", date: "2026-10-18" },
      team: { id: 2, name: "MOUZ" }, strat: { id: 4, name: "Exécution B" } });
    expect(b).toMatchObject({ id: 2, mine: false, author: "apEX", match: null });
    expect((await demo.notes({ side: "CT" })).map((n) => n.id)).toEqual([2]);
    expect((await demo.notes({ map: "de_dust2", team: 2 })).map((n) => n.id)).toEqual([1]);
    expect((await demo.notes({ strat: 4 })).map((n) => n.id)).toEqual([1]);
  });
  it("crée, modifie et supprime, et enregistre la liste après chaque écriture", async () => {
    const { demo, saved } = make();
    const n = await demo.createNote({ map: "de_inferno", body: "  nouvelle  ", side: "CT", team_id: 2 });
    expect(n).toMatchObject({ id: 3, body: "nouvelle", mine: true, author: "ZywOo", shared: false, team: { id: 2, name: "MOUZ" } });
    expect((await demo.notes())[0].id).toBe(3);
    const up = await demo.updateNote(3, { body: "corrigée", shared: true, team_id: null });
    expect(up).toMatchObject({ body: "corrigée", shared: true, team: null, side: "CT" });
    await demo.deleteNote(3);
    await expect(demo.note(3)).rejects.toMatchObject({ status: 404 });
    expect(saved).toHaveLength(3);
    expect(saved[2].map((x) => x.id)).toEqual([1, 2]);
  });
  it("refuse une note vide ou trop longue, et la note d'un coéquipier", async () => {
    const { demo } = make();
    await expect(demo.createNote({ map: "de_inferno", body: "  " })).rejects.toMatchObject({ status: 400 });
    await expect(demo.createNote({ map: "de_inferno", body: "a".repeat(2001) })).rejects.toMatchObject({ status: 400 });
    await expect(demo.updateNote(2, { body: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(demo.deleteNote(2)).rejects.toMatchObject({ status: 403 });
  });
  it("part des notes d'exemple des données de démo sans sauvegarde", async () => {
    const demo = createDemoApi({ fixtures: { ...withMatch, notes: seed }, now: () => now, assetBase: "" });
    expect(await demo.notes()).toHaveLength(2);
  });
});
