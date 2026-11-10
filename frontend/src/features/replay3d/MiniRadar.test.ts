// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import type { MapMeta } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { MiniRadar, RADAR_HZ, type RadarFrame } from "./MiniRadar";

// le dessin du radar 2D est compté, pas exécuté (pas de canvas 2D sous jsdom)
const draw = vi.hoisted(() => ({ fits: 0, calls: [] as { tick: number; level: string; selected: string | null; width: number; names: boolean;
  view: unknown }[] }));
vi.mock("../replay/renderer/draw", () => ({
  drawFrame: (_ctx: unknown, a: { tick: number; level: string; selected: string | null; width: number; options: { names: boolean }; view: unknown }) => {
    draw.calls.push({ tick: a.tick, level: a.level, selected: a.selected, width: a.width, names: a.options.names, view: a.view });
    return { offsets: {}, scale: 1, originX: 0, originY: 0 };
  },
  fitView: () => { draw.fits++; return { zoom: 2, panX: 10, panY: 10 }; },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  draw.calls.length = 0;
  draw.fits = 0;
});

// Nuke : étage du bas sous z −495 ; le joueur a (suivi) est en bas, b en haut
const MAP = { name: "de_nuke", display_name: "Nuke", pos_x: -3453, pos_y: 2887, scale: 7, image: "de_nuke.png", bomb_a: null, bomb_b: null,
  levels: [{ name: "upper", image: "de_nuke.png", z_min: -495, z_max: 1e9 }, { name: "lower", image: "de_nuke_lower.png", z_min: -1e9, z_max: -495 }],
} as unknown as MapMeta;
const replay = {
  ticks: new Int32Array([0, 6400]), n: 2, tickrate: 64,
  players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "T", slot: 1, index: 1 }],
  value: (k: string, _i: number, j: number) => ({ flags: 1, hp: 100, x: [10, 500][j], y: [20, 0][j], z: [-700, 0][j] } as Record<string, number>)[k] ?? 0,
  weaponAt: () => "", inventoryAt: () => [], has: () => false, crosshairOf: () => null, viewmodelOf: () => null,
  payload: { map_name: "de_nuke", grenades: [], kills: [], bomb: [] },
} as unknown as Replay;

function mount(frame: { current: RadarFrame | null }, placeAt = vi.fn((_pos: [number, number, number]): string | null => "Ramp")) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }) as never);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(180);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(180);
  const div = document.createElement("div");
  const root = createRoot(div);
  roots.push(root);
  act(() => root.render(createElement(MiniRadar, { radar: { map: MAP, frame, placeAt }, sid: "a" })));
  return { div, placeAt };
}

describe("petit radar de la vue du joueur", () => {
  it("rendu statique : un canvas et la ligne du nom de zone", () => {
    const h = renderToStaticMarkup(createElement(MiniRadar, { radar: { map: MAP, frame: { current: null }, placeAt: () => null }, sid: "a" }));
    expect(h).toContain('data-testid="pov-radar"');
    expect(h).toContain("<canvas");
    expect(h).toContain('class="r3-radar-zone"');
  });

  it(`radar 2D redessiné au plus ${RADAR_HZ} fois par seconde, seulement si l'instant a changé ; étage et zone du joueur suivi`, () => {
    vi.useFakeTimers();
    const frame: { current: RadarFrame | null } = { current: { replay, tick: 0 } };
    const { div, placeAt } = mount(frame);
    expect(draw.calls).toHaveLength(1);  // dès le montage
    expect(draw.calls[0]).toMatchObject({ level: "lower", selected: "a", width: 180, names: false });
    for (let i = 1; i <= 60; i++) {  // une seconde de lecture à 60 images/s
      frame.current = { replay, tick: i * 2 };
      act(() => { vi.advanceTimersByTime(1000 / 60); });
    }
    expect(draw.calls.length).toBeGreaterThanOrEqual(RADAR_HZ - 1);
    expect(draw.calls.length).toBeLessThanOrEqual(RADAR_HZ + 1);
    act(() => { vi.advanceTimersByTime(1000 / RADAR_HZ); });  // pause : le dernier instant est dessiné une fois…
    expect(draw.calls.at(-1)!.tick).toBe(120);
    const n = draw.calls.length;
    act(() => { vi.advanceTimersByTime(2000); });  // … puis plus rien à redessiner
    expect(draw.calls).toHaveLength(n);
    expect(placeAt).toHaveBeenLastCalledWith([10, 20, -700]);
    expect(div.querySelector(".r3-radar-zone")!.textContent).toBe("Ramp");
  });

  it("toute la carte, nord en haut, comme le radar du jeu : pas de cadrage sur la zone jouée", () => {
    vi.useFakeTimers();
    mount({ current: { replay, tick: 0 } });
    expect(draw.calls[0].view).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(draw.fits).toBe(0);
  });

  it("démonté (sortie de la vue du joueur) : plus de dessin", () => {
    vi.useFakeTimers();
    const frame: { current: RadarFrame | null } = { current: { replay, tick: 0 } };
    mount(frame);
    act(() => roots.splice(0).forEach((r) => r.unmount()));
    const n = draw.calls.length;
    frame.current = { replay, tick: 99 };
    vi.advanceTimersByTime(1000);
    expect(draw.calls).toHaveLength(n);
  });
});
