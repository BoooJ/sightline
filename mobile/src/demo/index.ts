import type { DemoFixtures, DemoNote } from "@/api/demo";
import type { Strat } from "@/api/types";

import { shiftDates } from "./dates";
import fixtures from "./fixtures.json";
import notes from "./notes.json";
import strats from "./strats.json";

/** Données de la démo (matchs pro publics, stratégies et notes d'exemple), dates recalculées à partir d'aujourd'hui.
 *  Chargé à la demande. */
export async function loadDemo(): Promise<DemoFixtures> {
  const all = {
    ...(fixtures as unknown as Omit<DemoFixtures, "strats" | "notes">),
    strats: strats as unknown as Strat[], notes: notes as unknown as DemoNote[],
  };
  return shiftDates(all, new Date());
}
