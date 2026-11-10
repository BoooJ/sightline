import { describe, expect, it } from "vitest";

import { rollingMean, trendSummary } from "./trend";

describe("tendance", () => {
  it("moyenne glissante", () => {
    expect(rollingMean([1, 2, 3, 4], 2)).toEqual([1, 1.5, 2.5, 3.5]);
    expect(rollingMean([], 3)).toEqual([]);
  });
  it("compare les derniers matchs aux précédents", () => {
    expect(trendSummary([1, 1, 1, 1.2, 1.2], 2)).toEqual({ recent: 1.2, before: 1, direction: "up" });
    expect(trendSummary([1.1, 1.1, 0.9], 1)).toMatchObject({ direction: "down" });
    expect(trendSummary([1, 1.01], 1).direction).toBe("flat");
    expect(trendSummary([1.05], 5)).toEqual({ recent: 1.05, before: null, direction: "flat" });
  });
});
