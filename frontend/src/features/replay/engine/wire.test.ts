import { describe, expect, it } from "vitest";
import { decodeWireArray } from "./wire";

const bytes = (a: Int16Array | Uint32Array) => new Uint8Array(a.buffer.slice(0));

describe("decodeWireArray", () => {
  it("décode les différences par joueur (dpm) en float32 rangé image par image", () => {
    // 3 images × 2 joueurs ; joueur 0 : 1, 2, 4 ; joueur 1 : -10, -10, -7 (échelle 4)
    const d = new Int16Array([4, 4, 8, -40, 0, 12]);
    const out = decodeWireArray({ dtype: "<i2", data: bytes(d), enc: "dpm", scale: 4 }, 3, 2);
    expect(Array.from(out)).toEqual([1, -10, 2, -10, 4, -7]);
  });
  it("cumule les offsets (d)", () => {
    const out = decodeWireArray({ dtype: "<i2", data: bytes(new Int16Array([0, 2, 0, 3])), enc: "d" });
    expect(out).toBeInstanceOf(Uint32Array);
    expect(Array.from(out)).toEqual([0, 2, 2, 5]);
  });
});
