import { describe, expect, it } from "vitest";
import { compDelta } from "./Comp";

describe("écart à la référence", () => {
  it("plus / moins / égal", () => {
    expect(compDelta(1.3, 1.0)).toEqual({ pct: 30, tone: "pos", label: "30 % de plus" });
    expect(compDelta(0.9, 1.0)).toEqual({ pct: -10, tone: "neg", label: "10 % de moins" });
    expect(compDelta(1.004, 1.0)).toEqual({ pct: 0, tone: "flat", label: "égal" });
  });
  it("moins = mieux inverse la couleur, pas le libellé", () => {
    expect(compDelta(0.5, 1.0, true)).toEqual({ pct: -50, tone: "pos", label: "50 % de moins" });
  });
  it("référence nulle ou absente", () => {
    expect(compDelta(1, 0).tone).toBe("flat");
    expect(compDelta(NaN, 1).label).toBe("—");
  });
});
