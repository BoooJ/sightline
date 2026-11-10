import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SITE, parseCli, USAGE } from "../lib/cli.mjs";

test("options : forme « --site=… » et forme séparée, nom de carte en minuscules", () => {
  assert.deepEqual(parseCli(["Nuke", "--site=http://127.0.0.1:8100/"]),
    { map: "de_nuke", site: "http://127.0.0.1:8100", s2v: undefined, variants: ["gray", "textured", "collision"], dryRun: false });
  assert.deepEqual(parseCli(["DE_Inferno", "--site", "https://a.example", "--only", "gray", "--s2v", "X:/s2v.exe", "--dry-run"]),
    { map: "de_inferno", site: "https://a.example", s2v: "X:/s2v.exe", variants: ["gray"], dryRun: true });
  assert.equal(parseCli(["mirage"]).site, DEFAULT_SITE);
});

test("option inconnue ou mal écrite : refus avec l'usage, rien ne part", () => {
  assert.throws(() => parseCli(["nuke", "--dryrun"]), /--dryrun[\s\S]*Usage/);
  assert.throws(() => parseCli(["nuke", "--sites", "http://127.0.0.1:8100"]), /--sites[\s\S]*Usage/);
  assert.throws(() => parseCli(["nuke", "--site"]), /--site[\s\S]*Usage/);
});

test("valeur donnée à --dry-run, ou --only= vide : refus avec le bon motif", () => {
  assert.throws(() => parseCli(["nuke", "--dry-run=true"]), /--dry-run ne prend pas de valeur[\s\S]*Usage/);
  assert.throws(() => parseCli(["nuke", "--site"]), /Valeur manquante pour --site[\s\S]*Usage/);
  assert.throws(() => parseCli(["nuke", "--only="]), /--only invalide \(\) : gray, textured ou collision[\s\S]*Usage/);
});

test("carte absente, en double ou mal formée, --only ou --site invalides : refus avec l'usage", () => {
  assert.throws(() => parseCli([]), /Usage/);
  assert.throws(() => parseCli(["nuke", "inferno"]), /Usage/);
  assert.throws(() => parseCli(["../nuke"]), /carte[\s\S]*Usage/i);
  assert.throws(() => parseCli(["nuke", "--only", "color"]), /gray, textured ou collision[\s\S]*Usage/);
  assert.throws(() => parseCli(["nuke", "--site", "127.0.0.1:8100"]), /http[\s\S]*Usage/);
});

test("l'usage cite STEAM_PATH", () => {
  assert.throws(() => parseCli([]), /STEAM_PATH/);
});

test("vue : bras et armes de la vue du joueur, --only en clés séparées par des virgules", () => {
  assert.deepEqual(parseCli(["vue", "--site=http://127.0.0.1:8100/"]),
    { vue: true, site: "http://127.0.0.1:8100", s2v: undefined, only: null, dryRun: false });
  assert.deepEqual(parseCli(["VUE", "--only", "AK47, usp_silencer,bras", "--dry-run", "--s2v", "X:/s2v.exe"]),
    { vue: true, site: DEFAULT_SITE, s2v: "X:/s2v.exe", only: ["ak47", "usp_silencer", "bras"], dryRun: true });
  assert.throws(() => parseCli(["vue", "--only="]), /--only invalide \(\) : clés d'armes[\s\S]*Usage/);
  assert.throws(() => parseCli(["vue", "--only", "ak47,../x"]), /--only invalide[\s\S]*Usage/);
  assert.throws(() => parseCli(["vue", "--site", "ftp://x"]), /--site invalide[\s\S]*Usage/);
  assert.match(USAGE, /export\.mjs vue/);
});

test("joueurs : joueurs vus de l'extérieur, --only en mots et clés séparés par des virgules", () => {
  assert.deepEqual(parseCli(["joueurs", "--site=http://127.0.0.1:8131/"]),
    { joueurs: true, site: "http://127.0.0.1:8131", s2v: undefined, only: null, dryRun: false });
  assert.deepEqual(parseCli(["JOUEURS", "--only", "Agents, clips_rifle,ak47", "--dry-run"]),
    { joueurs: true, site: DEFAULT_SITE, s2v: undefined, only: ["agents", "clips_rifle", "ak47"], dryRun: true });
  assert.throws(() => parseCli(["joueurs", "--only="]), /--only invalide \(\) : agents, clips_<classe>, clips_communes[\s\S]*Usage/);
  assert.match(USAGE, /export\.mjs joueurs/);
});

test("carte : --only collision exporte la collision seule (corps des morts du replay 3D)", () => {
  assert.deepEqual(parseCli(["dust2", "--only", "collision"]).variants, ["collision"]);
  assert.match(USAGE, /--only gray\|textured\|collision/);
});
