import { describe, expect, it, vi } from "vitest";
import type { KillEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { F } from "../replay/engine/state";
import { AgentLibrary, type AgentLoad } from "./agents";
import { parseGlbAnimated } from "./loader";
import { RagdollEngine, type RagdollIn, type RagdollOut } from "./ragdollEngine";
import { FORCE_SCALE, HIT_PART, Ragdolls, START_DT } from "./ragdolls";
import { MAX_V, type RagdollStart } from "./ragdollSolver";
import { AGENT_RAGDOLL, agentGlb, animsGlb, COMMON_CLIPS, ragdollGlb } from "./testGlb";

const FILES: Record<string, () => Uint8Array<ArrayBuffer>> = {
  "agent-ct": agentGlb, "agent-t": agentGlb, "anims-rifle": () => animsGlb(), "anims-pistol": () => animsGlb(),
  "anims-knife": () => animsGlb(), "anims-communes": () => animsGlb(COMMON_CLIPS), ragdoll: () => ragdollGlb(),
};
const until = (ok: () => boolean) => vi.waitFor(() => { if (!ok()) throw new Error("pas encore"); });
/** Bibliothèque des fichiers de test, modèles, clips et ragdoll arrivés (ou absents). */
async function library(files = FILES) {
  const load: AgentLoad = async (name) => (files[name] ? parseGlbAnimated(files[name]().buffer) : null);
  const lib = new AgentLibrary(load, () => {});
  lib.preload(["CT", "T"], ["rifle", "pistol", "knife", "communes"]);
  lib.ragdoll();
  await until(() => lib.version === 7);
  return lib;
}
/** Worker factice : le vrai moteur, appelé à l'envoi ; ses réponses rendues par `flush()` (comme à l'image suivante). */
function fakePort() {
  const engine = new RagdollEngine(), sent: RagdollIn[] = [], queue: RagdollOut[] = [];
  const port = {
    sent, onmessage: null as ((e: MessageEvent<RagdollOut>) => void) | null, onerror: null as ((e: Event) => void) | null,
    terminate: vi.fn(),
    postMessage(m: RagdollIn) { sent.push(m); const out = engine.handle(m); if (out) queue.push(out); },
    flush() { for (const out of queue.splice(0)) port.onmessage?.({ data: out } as MessageEvent<RagdollOut>); },
  };
  return port;
}
const deaths = (p: ReturnType<typeof fakePort>) => p.sent.filter((m) => m.type === "death") as Extract<RagdollIn, { type: "death" }>[];
/** Sol plat à z = 0, 4000 u de côté. */
const floor = () => new Float32Array([-2000, -2000, 0, 2000, -2000, 0, 2000, 2000, 0, -2000, -2000, 0, 2000, 2000, 0, -2000, 2000, 0]);
const KILL_A = { tick: 200, victim: "a", attacker: "b", weapon: "ak47", victim_pos: [0, 0, 0], attacker_pos: [300, 0, 0] } as KillEvent;
const KILL_B = { tick: 600, victim: "b", attacker: "a", weapon: "ak47", victim_pos: [300, 0, 0], attacker_pos: [0, 0, 0] } as KillEvent;
/** a (CT) en x 0 et b (T) en x 300, immobiles, morts à leur kill ; `read` : force lue dans la démo. */
function replay(kills: KillEvent[], read: [number, number, number] | null = null, damages: object[] = []): Replay {
  return {
    ticks: Int32Array.from({ length: 400 }, (_, i) => 2 * i), n: 400, m: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "T", slot: 1, index: 1 }],
    has: () => false,
    value: (k: string, i: number, j: number) => (k === "x" ? [0, 300][j]
      : k === "flags" ? (kills.some((q) => q.victim === ["a", "b"][j] && 2 * i >= q.tick) ? 0 : F.ALIVE) : 0),
    weaponAt: () => "AK-47", inventoryAt: () => ["AK-47"], agentOf: () => null, deathForce: () => read,
    payload: { map_name: "de_nuke", kills, damages, bomb: [], grenades: [] },
  } as unknown as Replay;
}

describe("morts en ragdoll", () => {
  it("une mort : départ posé sur le modèle de la victime au point de la mort, simulé par le moteur, rendu ; version et onChange", async () => {
    const lib = await library(), port = fakePort(), changed = vi.fn(), rag = new Ragdolls(() => port, changed);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    const r = replay([KILL_A]);
    rag.pump(r, 0);
    expect(port.sent.map((m) => m.type)).toEqual(["map", "def", "death"]);
    expect(rag.track(r, "a", 200)).toBeNull();  // pas encore arrivée
    const start: RagdollStart = deaths(port)[0].start;
    expect([start.p[0], start.p[1]].map((x) => +x.toFixed(3))).toEqual([0, 0]);  // bassin au point de la mort
    expect(start.p[2]).toBeCloseTo(1 / 0.0254, 1);  // à sa hauteur (clip idle : 1 m)
    port.flush();
    const t = rag.track(r, "a", 200)!;
    expect(t.bones).toEqual(AGENT_RAGDOLL.bones);
    expect(t.frames).toBeGreaterThan(10);
    expect([rag.version, changed.mock.calls.length, rag.count(r)]).toEqual([1, 1, 1]);
  });
  it("une mort à la fois, la plus proche du tick affiché d'abord ; chacune une seule fois", async () => {
    const lib = await library(), port = fakePort(), rag = new Ragdolls(() => port, () => {});
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    const r = replay([KILL_A, KILL_B]);
    rag.pump(r, 590);
    rag.pump(r, 590);  // calcul en cours : rien de plus
    expect(deaths(port)).toHaveLength(1);
    port.flush();
    expect(rag.track(r, "b", 600)).not.toBeNull();
    expect(rag.track(r, "a", 200)).toBeNull();
    rag.pump(r, 590);
    port.flush();
    expect(rag.track(r, "a", 200)).not.toBeNull();
    rag.pump(r, 590);
    expect(deaths(port)).toHaveLength(2);  // plus rien à calculer
  });
  it("impulsion : force de la démo, 30 % sur le corps de la zone touchée, le reste sur tout le corps", async () => {
    const lib = await library(), port = fakePort(), rag = new Ragdolls(() => port, () => {});
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    rag.pump(replay([KILL_A], [24000, 0, 0], [{ tick: 200, victim: "a", attacker: "b", dmg: 100, hitgroup: "head" }]), 0);
    const v = deaths(port)[0].start.v, M = 200 + 50;  // masses de AGENT_RAGDOLL ; corps immobile avant la mort
    expect(v[0]).toBeCloseTo((24000 * FORCE_SCALE * (1 - HIT_PART)) / M, 3);  // bassin
    expect(v[3]).toBeCloseTo((24000 * FORCE_SCALE * (1 - HIT_PART)) / M + (24000 * FORCE_SCALE * HIT_PART) / 50, 3);  // tête
    expect([HIT_PART, FORCE_SCALE, START_DT]).toEqual([0.3, 1, 1 / 32]);
  });
  it("rien sans worker, sans fichier « ragdoll », ou sans la collision de la carte du round : les morts gardent leurs clips", async () => {
    const lib = await library(), r = replay([KILL_A]);
    const none = new Ragdolls(() => null, () => {});
    none.setLibrary(lib);
    none.setMap("de_nuke", floor());
    none.pump(r, 0);
    expect(none.track(r, "a", 200)).toBeNull();
    const { ragdoll: _gone, ...rest } = FILES, noFile = await library(rest), port = fakePort(), rag = new Ragdolls(() => port, () => {});
    rag.setLibrary(noFile);
    rag.setMap("de_nuke", floor());
    rag.pump(r, 0);
    expect(port.sent.map((m) => m.type)).toEqual(["map"]);
    const port2 = fakePort(), other = new Ragdolls(() => port2, () => {});
    other.setLibrary(lib);
    other.setMap("de_dust2", floor());  // collision d'une autre carte que celle du round
    other.pump(r, 0);
    other.setMap("de_nuke", null);
    other.pump(r, 0);
    expect(deaths(port2)).toHaveLength(0);
  });
  it("modèle sans les os du ragdoll : pas de trajectoire pour ses morts (clip), sans rien envoyer", async () => {
    const lib = await library({ ...FILES, ragdoll: () => ragdollGlb({ ...AGENT_RAGDOLL, bones: ["pelvis", "ankle_l"] }) });
    const port = fakePort(), rag = new Ragdolls(() => port, () => {}), r = replay([KILL_A, KILL_B]);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    rag.pump(r, 0);
    rag.pump(r, 0);
    expect(deaths(port)).toHaveLength(0);
    expect([rag.track(r, "a", 200), rag.track(r, "b", 600), rag.count(r)]).toEqual([null, null, 0]);
  });
  it("nouvelle bibliothèque : trajectoires oubliées, réponse d'un calcul abandonné ignorée ; dispose arrête le worker", async () => {
    const lib = await library(), port = fakePort(), rag = new Ragdolls(() => port, () => {}), r = replay([KILL_A]);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    rag.pump(r, 0);
    rag.setLibrary(await library());
    port.flush();  // réponse de l'ancien calcul
    expect([rag.track(r, "a", 200), rag.version]).toEqual([null, 0]);
    rag.pump(r, 0);
    port.flush();
    expect(rag.track(r, "a", 200)).not.toBeNull();
    rag.dispose();
    expect(port.terminate).toHaveBeenCalledTimes(1);
  });
  it("collision illisible (réponse sans mort, id -1) : journalisée une fois, ni blocage ni boucle ; les morts gardent leurs clips", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lib = await library(), port = fakePort(), rag = new Ragdolls(() => port, () => {}), r = replay([KILL_A]);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]));
    port.flush();
    port.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/collision illisible/);
    rag.pump(r, 0);  // la mort part quand même (la carte d'avant, ou aucune : réponse « collision absente »)
    port.flush();
    expect(rag.track(r, "a", 200)).toBeNull();
    expect(deaths(port)).toHaveLength(1);
    warn.mockRestore();
  });
  it("mort la plus proche sans le modèle de son camp : sautée, la suivante part ; elle attend sans bloquer les autres", async () => {
    const { "agent-t": _t, ...noT } = FILES, lib = await library(noT);
    const port = fakePort(), rag = new Ragdolls(() => port, () => {}), r = replay([KILL_A, KILL_B]);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    rag.pump(r, 590);  // la plus proche : b (T, modèle absent) ; a (CT) part
    expect(deaths(port)).toHaveLength(1);
    expect(+deaths(port)[0].start.p[0].toFixed(3)).toBe(0);  // bassin de a (x 0), pas de b (x 300)
    port.flush();
    expect([rag.track(r, "a", 200) !== null, rag.track(r, "b", 600)]).toEqual([true, null]);
    for (let k = 0; k < 3; k++) rag.pump(r, 590);
    expect(deaths(port)).toHaveLength(1);  // b attend toujours son modèle
  });
  it("mort en attente (clips pas encore là) : pas de pose du mourant refaite à chaque image ; nouvel essai quand la bibliothèque change", async () => {
    const { "anims-rifle": _rifle, ...noRifle } = FILES, lib = await library(noRifle);
    const port = fakePort(), rag = new Ragdolls(() => port, () => {}), r = replay([KILL_A, KILL_B]);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    const dur = vi.spyOn(lib, "duration");
    rag.pump(r, 590);
    const first = dur.mock.calls.length;
    expect(first).toBeGreaterThan(0);  // les deux morts essayées une fois (dyingPose : clips du fusil absents)
    for (let k = 0; k < 5; k++) rag.pump(r, 590);
    expect(dur.mock.calls.length).toBe(first);  // images suivantes : rien de refait
    lib.version++;  // un fichier arrivé : on réessaie
    rag.pump(r, 590);
    expect(dur.mock.calls.length).toBeGreaterThan(first);
    expect(deaths(port)).toHaveLength(0);
  });
  it("count et track sans allocation par image : compteur par replay (aucun parcours), victime jamais mise en chaîne", async () => {
    const lib = await library(), port = fakePort(), rag = new Ragdolls(() => port, () => {}), r = replay([KILL_A, KILL_B]);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    expect(rag.count(r)).toBe(0);
    rag.pump(r, 0);
    port.flush();
    const walks = [vi.spyOn(Map.prototype, "values"), vi.spyOn(Map.prototype, "entries"), vi.spyOn(Map.prototype, "keys"),
      vi.spyOn(Map.prototype, "forEach"), vi.spyOn(Map.prototype, Symbol.iterator)];
    expect(rag.count(r)).toBe(1);
    for (const s of walks) expect(s).not.toHaveBeenCalled();
    for (const s of walks) s.mockRestore();
    const prim = vi.fn(() => "a"), sid = { [Symbol.toPrimitive]: prim, toString: prim } as unknown as string;
    rag.track(r, sid, 200);
    expect(prim).not.toHaveBeenCalled();  // pas de clé « victime:tick » construite à chaque appel
    expect(rag.track(r, "a", 200)).not.toBeNull();
    rag.pump(r, 0);
    port.flush();
    expect(rag.count(r)).toBe(2);
    rag.setLibrary(lib);
    expect([rag.count(r), rag.track(r, "a", 200)]).toEqual([0, null]);
  });
  it("worker en échec (onerror : script introuvable, plantage) : journalisé une fois, arrêté, jamais relancé ; les morts gardent leurs clips", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lib = await library(), port = fakePort(), spawn = vi.fn(() => port), rag = new Ragdolls(spawn, () => {});
    const r = replay([KILL_A, KILL_B]);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    rag.pump(r, 0);
    expect(deaths(port)).toHaveLength(1);
    port.onerror!(new Event("error"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/worker/);
    expect(port.terminate).toHaveBeenCalledTimes(1);
    port.flush();  // rien ne doit plus être rangé (calcul abandonné)
    for (let k = 0; k < 3; k++) rag.pump(r, 0);
    rag.setMap("de_nuke", floor());
    expect([spawn.mock.calls.length, deaths(port).length, port.sent.length]).toEqual([1, 1, 3]);  // map, def, death
    expect([rag.track(r, "a", 200), rag.track(r, "b", 600), rag.count(r), rag.version]).toEqual([null, null, 0, 0]);
    rag.dispose();
    expect(port.terminate).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it("masses réalistes (≈ 272 en tout, tête 10) : fusil et AWP à la tête, vitesse de départ sous MAX_V, trajectoire rendue par le moteur", async () => {
    const parts = AGENT_RAGDOLL.parts, real = { ...AGENT_RAGDOLL, parts: [{ ...parts[0], mass: 262 }, { ...parts[1], mass: 10 }] };
    const lib = await library({ ...FILES, ragdoll: () => ragdollGlb(real) }), M = 272, HEAD = 10;
    const head = [{ tick: 200, victim: "a", attacker: "b", dmg: 100, hitgroup: "head" }];
    for (const [weapon, norm] of [["ak47", 24000 * 1.3], ["awp", 28000 * 1.3]] as const) {
      const port = fakePort(), rag = new Ragdolls(() => port, () => {}), r = replay([{ ...KILL_A, weapon }], null, head);
      rag.setLibrary(lib);
      rag.setMap("de_nuke", floor());
      rag.pump(r, 0);
      const v = deaths(port)[0].start.v, vh = Math.hypot(v[3], v[4], v[5]), want = norm * ((1 - HIT_PART) / M + HIT_PART / HEAD);
      console.info(`Ragdoll réaliste : ${weapon} à la tête, ${norm.toFixed(0)} → tête ${vh.toFixed(0)} u/s (MAX_V ${MAX_V}), corps ${Math.hypot(v[0], v[1], v[2]).toFixed(0)} u/s`);
      expect(vh).toBeCloseTo(want, 0);  // pas bornée : sous MAX_V
      expect(vh).toBeLessThan(MAX_V);
      port.flush();
      const t = rag.track(r, "a", 200);
      expect(t).not.toBeNull();  // ni chute hors du monde local ni nombres non finis
      const lp = (t!.frames - 1) * t!.bodies * 3;  // bassin, dernière image
      console.info(`  ${t!.frames} images ; bassin de (${[0, 1, 2].map((c) => t!.p[c].toFixed(0))}) à (${[0, 1, 2].map((c) => t!.p[lp + c].toFixed(0))})`);
    }
  });
  it("collision retirée (setMap(carte, null)) : grille libérée dans le worker ; sans worker lancé, aucun n'est lancé pour cela", async () => {
    const lib = await library(), port = fakePort(), rag = new Ragdolls(() => port, () => {}), r = replay([KILL_A]);
    rag.setLibrary(lib);
    rag.setMap("de_nuke", floor());
    rag.setMap("de_nuke", null);
    expect(port.sent.map((m) => m.type)).toEqual(["map", "unmap"]);
    rag.setMap("de_nuke", null);  // déjà libérée : rien de plus
    expect(port.sent).toHaveLength(2);
    rag.pump(r, 0);
    expect(deaths(port)).toHaveLength(0);
    const spawn = vi.fn(() => fakePort()), idle = new Ragdolls(spawn, () => {});
    idle.setMap("de_nuke", null);
    expect(spawn).not.toHaveBeenCalled();
  });
});
