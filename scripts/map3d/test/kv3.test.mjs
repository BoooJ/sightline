import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKv3 } from "../lib/kv3.mjs";

test("KV3 texte : objets, tableaux (virgules finales comprises), textes, nombres, booléens, null ; en-tête ignoré", () => {
  const text = '<!-- kv3 encoding:text:version{0} format:generic:version{0} -->\n{\n\ta = 1\n\tb = [ 1.5, -2, 3e-2, ]\n'
    + '\tc = { d = "x y" e = true f = false g = null }\n\th = [ [ 1, 2 ], [ ] ]\n\tm_x.y = -0.0\n}';
  assert.deepEqual(parseKv3(text), { a: 1, b: [1.5, -2, 0.03], c: { d: "x y", e: true, f: false, g: null }, h: [[1, 2], []], "m_x.y": -0 });
});

test("KV3 texte : valeur illisible ou « = » manquant : erreur qui dit où", () => {
  assert.throws(() => parseKv3("{ a = #[ 00 ] }"), /Valeur illisible à \d+/);
  assert.throws(() => parseKv3("{ a 1 }"), /« = » attendu après a/);
});

test("KV3 texte : chaîne non fermée : erreur claire (pas de dépassement de pile)", () => {
  assert.throws(() => parseKv3('{ a = [ "abc ]'), /Texte non fermé à \d+/);
});

test("KV3 texte : nombre mal formé (-, ., 1e) : erreur claire au lieu de NaN", () => {
  for (const bad of ["-", ".", "1e"]) assert.throws(() => parseKv3(`{ a = ${bad} }`), /Nombre illisible à \d+/, bad);
});
