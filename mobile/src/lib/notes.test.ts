import { describe, expect, it } from "vitest";

import type { NoteT } from "@/api/types";

import { draftFromParams, filterNotes, groupNotesByMap, noteContext, noteMeta } from "./notes";

const note = (over: Partial<NoteT> = {}): NoteT => ({
  id: 1, map: "de_inferno", side: null, body: "Garder une molo pour apps", shared: false, mine: true,
  author: "ZywOo", author_id: 0, match: null, team: null, strat: null,
  created_at: "2026-10-20T18:00:00", updated_at: "2026-10-20T18:00:00", ...over,
});
const now = new Date(2026, 9, 21, 20, 0);

describe("filterNotes", () => {
  const list = [note({ id: 1, side: "T" }), note({ id: 2, side: "CT" }), note({ id: 3 }), note({ id: 4, map: "de_dust2", side: "T" })];
  it("une note « les deux camps » vaut pour T comme pour CT", () => {
    expect(filterNotes(list, null, "T").map((n) => n.id)).toEqual([1, 3, 4]);
    expect(filterNotes(list, null, "CT").map((n) => n.id)).toEqual([2, 3]);
    expect(filterNotes(list, null, "all")).toHaveLength(4);
  });
  it("filtre par carte", () => {
    expect(filterNotes(list, "de_dust2", "all").map((n) => n.id)).toEqual([4]);
  });
});

describe("groupNotesByMap", () => {
  it("garde l'ordre de la liste (les plus récentes d'abord) et regroupe par carte", () => {
    const g = groupNotesByMap([note({ id: 1, map: "de_dust2" }), note({ id: 2 }), note({ id: 3, map: "de_dust2" })]);
    expect(g.map((x) => [x.map, x.items.map((n) => n.id)])).toEqual([["de_dust2", [1, 3]], ["de_inferno", [2]]]);
  });
});

describe("noteContext / noteMeta", () => {
  it("dit à quoi la note est rattachée", () => {
    const n = note({
      team: { id: 1, name: "MOUZ" }, match: { id: 2, title: "Team Vitality vs MOUZ", date: "2026-10-18" },
      strat: { id: 3, name: "Default, puis Banane" },
    });
    expect(noteContext(n, now)).toEqual(["contre MOUZ", "match du 18 oct.", "strat Default, puis Banane"]);
  });
  it("donne l'âge, le partage et l'auteur quand ce n'est pas moi", () => {
    expect(noteMeta(note({ team: { id: 1, name: "MOUZ" } }), now)).toBe("contre MOUZ · hier");
    expect(noteMeta(note({ shared: true, mine: false, author: "apEX" }), now)).toBe("hier · Équipe · par apEX");
    expect(noteMeta(note({ shared: true }), now)).toBe("hier · Équipe");
  });
});

describe("draftFromParams", () => {
  it("lit les paramètres d'adresse d'une nouvelle note", () => {
    expect(draftFromParams({ map: "de_inferno", side: "CT", match: "2", team: "1", strat: "x" }))
      .toEqual({ map: "de_inferno", side: "CT", match_id: 2, team_id: 1, strat_id: null });
    expect(draftFromParams({ side: "B" })).toEqual({ map: "", side: null, match_id: null, team_id: null, strat_id: null });
  });
});
