import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DefaultKind, EngageSite, PlaybookRoundT, Stat } from "../../shared/api/types";
import { ctRotationCount, DEFAULT_KIND_LABEL, DEFAULT_KINDS, engageParts, shownKinds } from "./defaultPhases";
import { EngageSites } from "./scoutUi";

const S = (k: number, n = 10): Stat => ({ k, n, pct: n ? Math.round((100 * k) / n) : null, lo: 0, hi: 100, level: "indicative", tone: "neutral", rounds: [] });
const K = (key: DefaultKind, k: number) => ({ key, label: DEFAULT_KIND_LABEL[key], count: S(k), won: S(Math.min(k, 1), k) });
const E = (n: number, median_s: number | null): EngageSite => ({ n, won: Math.min(n, 1), win_pct: 0, rounds: [], median_s, p25_s: null, p75_s: null });
const R = (category: string, ct_rotation_s: number | null, rotation_measurable = true): PlaybookRoundT => ({
  round_id: 1, match_id: 1, number: 1, won: true, opponent: "X", category, site: null, buy: "full", contact_s: null, plant_s: null,
  util_before: 0, near_site: 0, engage_s: null, engage_site: null, default_kind: null, pressure_s: ct_rotation_s, pressure_site: null, ct_rotation_s,
  rotation_measurable,
});

describe("fins du default", () => {
  it("ordre fixe et libellés", () => {
    expect(DEFAULT_KINDS).toEqual(["exec", "take", "duels", "no_take"]);
    expect(DEFAULT_KINDS.map((k) => DEFAULT_KIND_LABEL[k])).toEqual(["puis exécution", "puis prise", "aux duels", "sans prise"]);
  });

  it("shownKinds retire les comptes nuls et remet l'ordre", () => {
    const out = shownKinds([K("duels", 3), K("no_take", 0), K("exec", 2), K("take", 5)]);
    expect(out.map((x) => x.key)).toEqual(["exec", "take", "duels"]);
    expect(out[1].count.k).toBe(5);
    expect(shownKinds([K("no_take", 1), K("take", 1)]).map((x) => x.key)).toEqual(["take", "no_take"]);
  });

  it("shownKinds sans données", () => {
    expect(shownKinds(undefined)).toEqual([]);
    expect(shownKinds(null)).toEqual([]);
    expect(shownKinds([K("exec", 0)])).toEqual([]);
  });
});

describe("prise des sites", () => {
  it("engageParts garde A puis B, avec prises et heure connue", () => {
    expect(engageParts({ B: E(2, 62), A: E(3, 57) })).toEqual([
      { site: "A", median_s: 57, n: 3, won: 1 },
      { site: "B", median_s: 62, n: 2, won: 1 },
    ]);
  });

  it("engageParts saute un site sans prise ou sans heure", () => {
    expect(engageParts({ A: E(0, null), B: E(2, 62) }).map((x) => x.site)).toEqual(["B"]);
    expect(engageParts({ A: E(3, 57), B: E(2, null) }).map((x) => x.site)).toEqual(["A"]);
    expect(engageParts({ A: E(0, 40) })).toEqual([]);
    expect(engageParts({})).toEqual([]);
  });

  it("engageParts sans données (anciens rapports)", () => {
    expect(engageParts(undefined)).toEqual([]);
    expect(engageParts(null)).toEqual([]);
  });

  it("EngageSites : « · » seulement après un autre élément de la phrase", () => {
    const e = { A: E(3, 57) };
    expect(renderToStaticMarkup(createElement(EngageSites, { e }))).toMatch(/^<span[^>]*> · <abbr[^>]*>prise du site<\/abbr>/);
    expect(renderToStaticMarkup(createElement(EngageSites, { e, first: true }))).toMatch(/^<span[^>]*><abbr[^>]*>Prise du site<\/abbr> <span>A vers/);
    expect(renderToStaticMarkup(createElement(EngageSites, { e: {}, first: true }))).toBe("");
  });
});

describe("rotations CT provoquées", () => {
  it("ignore les rounds eco", () => {
    expect(ctRotationCount([R("default", 48), R("rush", null), R("eco", 30)])).toEqual({ rot: 1, armed: 2 });
  });

  it("liste vide", () => {
    expect(ctRotationCount([])).toEqual({ rot: 0, armed: 0 });
  });

  it("ignore les rounds où la rotation n'est pas mesurable (Nuke : sites superposés)", () => {
    expect(ctRotationCount([R("default", null, false), R("rush", null, false), R("eco", null, false)])).toEqual({ rot: 0, armed: 0 });
    expect(ctRotationCount([R("default", 48), R("rush", null), R("split", null, false)])).toEqual({ rot: 1, armed: 2 });
  });

  it("sans le champ (anciennes données), la rotation n'est pas comptée", () => {
    const old = { ...R("default", 48) };
    delete old.rotation_measurable;
    expect(ctRotationCount([old])).toEqual({ rot: 0, armed: 0 });
  });
});
