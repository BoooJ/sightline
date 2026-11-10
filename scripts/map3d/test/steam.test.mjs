import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findCs2, mapVpk, pakVpk, parseLibraryFolders } from "../lib/steam.mjs";
import { tmpDir } from "./tmp.mjs";

test("lit les bibliothèques Steam", () => {
  const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t}\n}';
  assert.deepEqual(parseLibraryFolders(vdf), ["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary"]);
});

test("trouve CS2 dans une seconde bibliothèque et lit sa version", (t) => {
  const root = tmpDir(t, "map3d-steam-");
  const steam = path.join(root, "Steam"), lib = path.join(root, "Lib");
  fs.mkdirSync(path.join(steam, "steamapps"), { recursive: true });
  fs.writeFileSync(path.join(steam, "steamapps", "libraryfolders.vdf"), `"libraryfolders"{"1"{"path" "${lib.replace(/\\/g, "\\\\")}"}}`);
  const csgo = path.join(lib, "steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo");
  fs.mkdirSync(path.join(csgo, "maps"), { recursive: true });
  fs.writeFileSync(path.join(csgo, "steam.inf"), "ClientVersion=2000873\nPatchVersion=1.41.0.0\n");
  fs.writeFileSync(path.join(csgo, "maps", "de_nuke.vpk"), "");
  assert.deepEqual(findCs2(steam), { csgo, version: "2000873" });
  assert.equal(mapVpk(csgo, "de_nuke"), path.join(csgo, "maps", "de_nuke.vpk"));
  assert.throws(() => mapVpk(csgo, "de_atlantis"), /introuvable/);
  assert.throws(() => findCs2(path.join(root, "rien")), /CS2 introuvable[\s\S]*STEAM_PATH/);
});

test("archive principale du jeu (bras et armes) : pak01_dir.vpk, message clair s'il manque", (t) => {
  const csgo = tmpDir(t, "map3d-pak-");
  assert.throws(() => pakVpk(csgo), /pak01_dir\.vpk introuvable/);
  fs.writeFileSync(path.join(csgo, "pak01_dir.vpk"), "");
  assert.equal(pakVpk(csgo), path.join(csgo, "pak01_dir.vpk"));
});
