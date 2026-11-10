import { describe, expect, it } from "vitest";

import { base64UrlToBytes } from "./b64";

describe("base64url", () => {
  it("décode une clé VAPID (sans « = », avec - et _)", () => {
    expect(Array.from(base64UrlToBytes("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(base64UrlToBytes("-_8"))).toEqual([251, 255]);
    expect(base64UrlToBytes("B" + "A".repeat(86)).length).toBe(65); // point P-256 non compressé
  });
});
