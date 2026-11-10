import { describe, expect, it } from "vitest";
import { apply, extent, EYE_DUCK, EYE_STAND, eyeZ, invertAffine, yawDir } from "./world";

const S = 0.0254;
const W2M = [0, S, 0, 0, 0, 0, S, 0, S, 0, 0, 0, 0, 0, 0, 1];
const close = (a: number[], b: number[]) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], 6));

describe("zone jouable", () => {
  it("boîte des positions, élargie de la marge", () => {
    expect(extent([[0, 10, -5], [100, -20, 40]], [50, 50, 10])).toEqual({ min: [-50, -70, -15], max: [150, 60, 50] });
  });
  it("aucune position : pas de zone", () => {
    expect(extent([], [50, 50, 10])).toBeNull();
  });
});

describe("world", () => {
  it("applique la matrice de Source 2 Viewer (x_gltf = y, y_gltf = z, z_gltf = x)", () => {
    close(apply(W2M, [1, 2, 3]), [2 * S, 3 * S, 1 * S]);
  });
  it("inverse une matrice affine, translation comprise", () => {
    const m = [0, 2, 0, 5, 0, 0, 2, -3, 2, 0, 0, 7, 0, 0, 0, 1];
    close(apply(invertAffine(m), apply(m, [10, -20, 30])), [10, -20, 30]);
    close(apply(invertAffine(W2M), [2 * S, 3 * S, S]), [1, 2, 3]);
  });
  it("refuse une matrice non inversible", () => {
    expect(() => invertAffine(new Array(16).fill(0))).toThrow();
  });
  it("donne la direction du regard (0° = +X, 90° = +Y)", () => {
    close(yawDir(0), [1, 0, 0]);
    close(yawDir(90), [0, 1, 0]);
  });
});

describe("hauteur des yeux", () => {
  it("debout 64, accroupi 46, entre les deux pendant l'accroupissement", () => {
    expect([EYE_STAND, EYE_DUCK]).toEqual([64, 46]);
    expect(eyeZ(0)).toBe(64);
    expect(eyeZ(1)).toBe(46);
    expect(eyeZ(0.5)).toBe(55);
  });
});
