import { describe, expect, it } from "vitest";
import { CHUNK, missingChunks } from "./uploads";

describe("missingChunks", () => {
  it("découpe tout le fichier quand rien n'est reçu", () => {
    expect(missingChunks(CHUNK * 2 + 10, [])).toEqual([[0, CHUNK], [CHUNK, 2 * CHUNK], [2 * CHUNK, 2 * CHUNK + 10]]);
  });
  it("ne renvoie que les morceaux absents (reprise, réception dans le désordre)", () => {
    expect(missingChunks(CHUNK * 3, [[CHUNK, 2 * CHUNK]])).toEqual([[0, CHUNK], [2 * CHUNK, 3 * CHUNK]]);
    expect(missingChunks(CHUNK * 3, [[0, CHUNK * 3]])).toEqual([]);
  });
  it("renvoie un morceau partiellement reçu en entier", () => {
    expect(missingChunks(CHUNK * 2, [[0, CHUNK + 5]])).toEqual([[CHUNK, 2 * CHUNK]]);
  });
});
