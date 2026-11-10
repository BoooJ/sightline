import assert from "node:assert/strict";
import { test } from "node:test";
import { selectVue } from "../lib/vue.mjs";
import { loadWeapons } from "../lib/weapons.mjs";

test("vue : tout par défaut ; --only choisit armes et bras ; clé inconnue refusée avec la liste", () => {
  const all = loadWeapons();
  assert.deepEqual(selectVue(all, null), { arms: ["ct", "t"], weapons: all });
  const some = selectVue(all, ["usp_silencer", "ak47"]);
  assert.deepEqual(some.arms, []);
  assert.deepEqual(some.weapons.map((w) => w.key).sort(), ["ak47", "usp_silencer"]);
  assert.deepEqual(selectVue(all, ["bras"]), { arms: ["ct", "t"], weapons: [] });
  assert.throws(() => selectVue(all, ["ak74"]), /Arme inconnue : ak74 \(clés de scripts\/map3d\/lib\/weapons\.json : .*ak47/);
});
