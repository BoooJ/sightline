import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE } from "./testRagdoll";

type Msg = { type: string; id?: number; track?: { p: Float32Array; q: Float32Array } | null; why?: string | null };

/** Le worker sans navigateur : `self` simulé (onmessage + postMessage), module rechargé à chaque test. */
async function load() {
  const sent: { m: Msg; transfer: Transferable[] }[] = [];
  const scope = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: Msg, transfer: Transferable[]) => { sent.push({ m, transfer }); } };
  vi.stubGlobal("self", scope);
  vi.resetModules();
  await import("./ragdollWorker");
  return { sent, send: (data: unknown) => scope.onmessage!({ data }) };
}
const floor = () => new Float32Array([-1000, -1000, 0, 1000, -1000, 0, 1000, 1000, 0, -1000, -1000, 0, 1000, 1000, 0, -1000, 1000, 0]);
const start = () => ({ p: Float64Array.from([0, 0, 40, 10, 0, 40]), q: Float64Array.from([0, 0, 0, 1, 0, 0, -0.7071068, 0.7071068]),
  v: new Float64Array(6), w: new Float64Array(6) });

afterEach(() => vi.unstubAllGlobals());

describe("worker du ragdoll (self simulé, sans navigateur)", () => {
  it("def et map : aucune réponse ; mort : réponse du même id, tampons transférés", async () => {
    const { sent, send } = await load();
    send({ type: "def", file: structuredClone(FILE) });
    send({ type: "map", key: "k", tri: floor() });
    expect(sent).toHaveLength(0);
    send({ type: "death", id: 5, key: "k", start: start() });
    expect(sent).toHaveLength(1);
    const { m, transfer } = sent[0];
    expect([m.type, m.id, m.why]).toEqual(["track", 5, null]);
    expect(transfer).toEqual([m.track!.p.buffer, m.track!.q.buffer]);
  });
  it("sans collision : réponse avec raison et sans tampon transféré ; un message qui échoue ne bloque pas le suivant", async () => {
    const { sent, send } = await load();
    send({ type: "def", file: structuredClone(FILE) });
    send({ type: "death", id: 1, key: "k", start: start() });
    send({ type: "map", key: "k", tri: new Float32Array([0, 0, 0, 1e9, 0, 0, 0, 1e9, 0]) });  // grille impossible : réponse d'erreur
    send({ type: "map", key: "k", tri: floor() });
    send({ type: "death", id: 2, key: "k", start: start() });
    expect(sent.map((s) => [s.m.id, s.m.track === null])).toEqual([[1, true], [-1, true], [2, false]]);
    expect(sent[0].m.why).toBe("collision absente");
    expect(sent[0].transfer).toEqual([]);
  });
  it("collision retirée (unmap) : aucune réponse ; la mort suivante répond toujours (collision absente)", async () => {
    const { sent, send } = await load();
    send({ type: "def", file: structuredClone(FILE) });
    send({ type: "map", key: "k", tri: floor() });
    send({ type: "unmap" });
    expect(sent).toHaveLength(0);
    send({ type: "death", id: 3, key: "k", start: start() });
    expect(sent.map((s) => [s.m.id, s.m.why])).toEqual([[3, "collision absente"]]);
  });
});
