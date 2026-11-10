import { describe, expect, it } from "vitest";
import type { Replay } from "../replay/engine/replay";
import { blindsOf, FLASH_MAX, flashOpacity, veilOpacity, veilWriter } from "./flash";

/** Replay factice : images aux ticks `ticks`, `flash[i][j]` = champ « flash » (flash_duration brut) du joueur j à l'image i. */
function fake(ticks: number[], flash: number[][] | null, tickrate = 64): Replay {
  const m = flash ? flash[0].length : 1;
  return {
    ticks: Int32Array.from(ticks), n: ticks.length, m, tickrate,
    players: Array.from({ length: m }, (_, index) => ({ steamid: String(index), index })),
    has: (k: string) => k === "flash" && flash !== null,
    value: (k: string, i: number, j: number) => (k === "flash" && flash ? flash[i][j] : 0),
  } as unknown as Replay;
}
const every = (n: number, step = 2) => Array.from({ length: n }, (_, i) => 1000 + i * step);

describe("opacité du voile blanc d'un aveuglement (palier, puis fondu sur 2 s)", () => {
  // valeurs relevées (démo d'exemple Dust2, NertZ aveuglé 4,808 s, vue du joueur), à 192, 224, 256, 282 et 307
  // ticks (tickrate 64) de l'aveuglement : 0,8317, 0,6017, 0,3717, 0,1848, 0,0051
  it("aveuglement de 4,808 s : 0,92 pendant 2,808 s, puis fondu linéaire jusqu'à 0 à 4,808 s", () => {
    expect(FLASH_MAX).toBe(0.92);
    expect(flashOpacity(4.808, -0.1)).toBe(0);  // pas encore aveuglé
    for (const t of [0, 0.5, 1, 2, 2.5, 2.808]) expect(flashOpacity(4.808, t)).toBeCloseTo(0.92, 9);
    expect(flashOpacity(4.808, 3)).toBeCloseTo(0.8317, 4);
    expect(flashOpacity(4.808, 3.5)).toBeCloseTo(0.6017, 4);
    expect(flashOpacity(4.808, 4)).toBeCloseTo(0.3717, 4);
    expect(flashOpacity(4.808, 282 / 64)).toBeCloseTo(0.1848, 4);
    expect(flashOpacity(4.808, 307 / 64)).toBeCloseTo(0.0051, 4);
    expect(flashOpacity(4.808, 4.808)).toBe(0);  // fini
    expect(flashOpacity(4.808, 6)).toBe(0);
  });
  it("aveuglement court : plus faible (durée / 2,5 du maximum), fondu sur toute sa durée", () => {
    expect(flashOpacity(1, 0)).toBeCloseTo(0.92 * 0.4, 9);
    expect(flashOpacity(1, 0.5)).toBeCloseTo(0.92 * 0.4 * 0.5, 9);
    expect(flashOpacity(1, 1)).toBe(0);
    // 2,5 s : plein, palier de 0,5 s puis fondu sur 2 s
    expect(flashOpacity(2.5, 0.5)).toBeCloseTo(0.92, 9);
    expect(flashOpacity(2.5, 1.5)).toBeCloseTo(0.46, 9);
  });
  it("durée nulle ou illisible : aucun voile", () => {
    for (const d of [0, -1, Number.NaN]) expect(flashOpacity(d, 0)).toBe(0);
  });
});

describe("aveuglements d'un replay (le champ « flash » est la durée de l'aveuglement, constante, pas le temps restant)", () => {
  it("un aveuglement commence quand la valeur apparaît, augmente ou change ; une valeur constante n'en fait pas un autre", () => {
    const t = every(12);
    const f = (...v: number[]) => v.map((x) => [x]);
    // 3,2 s à l'image 2 (tenue), rien, puis 1 s à l'image 8
    expect(blindsOf(fake(t, f(0, 0, 3.2, 3.2, 3.2, 0, 0, 0, 1, 1, 0, 0)))[0]).toEqual([{ tick: t[2], dur: 3.2 }, { tick: t[8], dur: 1 }]);
    // reflashé pendant l'aveuglement : valeur plus grande, puis plus petite (nouveau flash, durée propre)
    expect(blindsOf(fake(t, f(2, 2, 4, 4, 3, 3, 0, 0, 0, 0, 0, 0)))[0])
      .toEqual([{ tick: t[0], dur: 2 }, { tick: t[2], dur: 4 }, { tick: t[4], dur: 3 }]);
  });
  it("par joueur ; joueur jamais aveuglé : liste vide", () => {
    const t = every(4);
    const b = blindsOf(fake(t, [[0, 0], [0, 2], [0, 2], [0, 0]]));
    expect(b[0]).toEqual([]);
    expect(b[1]).toEqual([{ tick: t[1], dur: 2 }]);
  });
  it("replay sans champ « flash » : aucun aveuglement ; le résultat est gardé pour le même replay", () => {
    expect(blindsOf(fake(every(3), null))).toEqual([[]]);
    const r = fake(every(3), [[0], [1], [0]]);
    expect(blindsOf(r)).toBe(blindsOf(r));
  });
});

describe("voile à un instant donné (veilOpacity)", () => {
  // 4,808 s dès l'image de 1100 ; le champ brut reste à 4,808 pendant ≈ 1,4 fois la durée (mesuré sur les démos), puis 0
  const dur = 4.808, start = 1100, held = Math.round(1.4 * dur * 64);
  const ticks = every(400);
  const field = ticks.map((t) => [t >= start && t < start + held ? dur : 0]);
  const r = fake(ticks, field);
  const at = (s: number) => veilOpacity(r, 0, start + Math.round(s * 64));

  it("0 avant, 0,92 au palier, fondu, puis 0 dès la fin de l'aveuglement alors que le champ brut dure encore", () => {
    expect(veilOpacity(r, 0, start - 10)).toBe(0);
    expect(at(0)).toBeCloseTo(0.92, 9);
    expect(at(2)).toBeCloseTo(0.92, 9);
    expect(at(3.5)).toBeCloseTo(0.6017, 4);
    expect(at(282 / 64)).toBeCloseTo(0.1848, 4);
    expect(at(4.9)).toBe(0);
    expect(at(6)).toBe(0);  // le champ brut vaut encore 4,808 ici : pas de voile pour autant
    expect(field[ticks.indexOf(start + 6 * 64)][0]).toBe(dur);
  });
  it("instant entre deux images (tick fractionnaire) ; joueur hors liste : 0", () => {
    expect(veilOpacity(r, 0, start + 3.5 * 64 + 0.5)).toBeCloseTo(0.6017 - 0.5 / 64 * 0.46, 3);
    expect(veilOpacity(r, 5, start)).toBe(0);
    expect(veilOpacity(r, -1, start)).toBe(0);
  });
  it("deux aveuglements en même temps : le plus fort l'emporte", () => {
    const t = every(40);
    // image 2 : 1 s (palier 0,368) ; image 4 : 4 s (0,92, palier de 2 s)
    const both = fake(t, t.map((_, i) => [i >= 2 && i < 30 ? (i >= 4 ? 4 : 1) : 0]));
    expect(veilOpacity(both, 0, t[2])).toBeCloseTo(0.368, 9);
    expect(veilOpacity(both, 0, t[4] + 64)).toBeCloseTo(0.92, 9);
  });
  it("16 images par seconde (anciens replays) : même loi, à l'image près", () => {
    const t = every(100, 4), start16 = t[10];
    const old = fake(t, t.map((_, i) => [i >= 10 && i < 60 ? 3 : 0]));
    expect(veilOpacity(old, 0, start16)).toBeCloseTo(0.92, 9);
    expect(veilOpacity(old, 0, start16 + 2 * 64)).toBeCloseTo(0.92 * 0.5, 9);  // palier de 1 s, fondu de 2 s : à 2 s, la moitié
    expect(veilOpacity(old, 0, start16 + 3 * 64)).toBe(0);
  });
});

describe("écriture du voile (sans rendu React)", () => {
  const el = () => {
    const props = new Map<string, string>();
    return { props, style: { setProperty: (k: string, v: string) => { props.set(k, v); } } } as unknown as
      HTMLElement & { props: Map<string, string> };
  };
  it("la variable --r3-flash est posée sur le voile seul : opacité courante, et la dernière dès qu'il apparaît", () => {
    const w = veilWriter(), veil = el();
    w.set(0.46);  // la vue 3D change l'opacité avant que React n'affiche le calque (entrée en vue du joueur)
    w.ref(veil);
    expect(veil.props.get("--r3-flash")).toBe("0.46");
    w.set(0.2);  // fondu
    expect(veil.props.get("--r3-flash")).toBe("0.2");
    w.ref(null);  // calque retiré (autre caméra) : plus rien à écrire, aucune erreur
    w.set(0);
    expect(veil.props.get("--r3-flash")).toBe("0.2");
    const again = el();
    w.ref(again);  // de retour en vue du joueur : la dernière opacité (0)
    expect(again.props.get("--r3-flash")).toBe("0");
  });
});
