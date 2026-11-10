import { describe, expect, it } from "vitest";
import { parseContext, toApiParams, toLibParams } from "./useContextFilters";

describe("barre de contexte : lecture de l'URL", () => {
  it("lit les filtres valides et ignore les autres", () => {
    const f = parseContext(new URLSearchParams("team=3&map=de_nuke&side=ct&econ=buy&opp_econ=eco&months=3&last_n=20&kind=official&role=awper"));
    expect(f).toMatchObject({ team: 3, map: "de_nuke", side: "CT", econ: "buy", oppEcon: "eco", months: 3, lastN: 20, kind: "official", role: "awper" });
    const bad = parseContext(new URLSearchParams("team=x&side=both&opp_econ=pistol&months=4&last_n=7&kind=scrim"));
    expect(bad).toEqual({ team: undefined, map: undefined, side: undefined, econ: undefined, oppEcon: undefined, months: undefined,
      dateFrom: undefined, dateTo: undefined, lastN: undefined, folder: undefined, event: undefined, tag: undefined, kind: undefined, role: undefined });
  });
  it("produit des paramètres d'API et de sélection de matchs", () => {
    const f = parseContext(new URLSearchParams("team=3&side=T&months=6&folder=Scrims&econ=eco"));
    expect(toApiParams(f)).toMatchObject({ team: "3", side: "T", months: "6", folder: "Scrims", econ: "eco", last_n: undefined });
    expect(toLibParams(f)).toEqual({ team: "3", months: "6", date_from: undefined, date_to: undefined, last_n: undefined, folder: "Scrims", event: undefined, tag: undefined, kind: undefined });
  });
});
