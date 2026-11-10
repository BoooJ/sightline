import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWeapons, clipPathsIn, loadWeapons, optionalRolesFor, pickClips, rolesFor } from "../lib/weapons.mjs";

const AK = "animation/anims/viewmodel/rifle/rifle_ak";
const REV = "animation/anims/viewmodel/pistol/pistol_revolver";
const VM = "animation/anims/viewmodel";
const at = (folder, names) => names.map((n) => `${folder}/${n}`);

test("liste des clips : chemins de l'agent (anim_names.tsv) comme de --vpk_list, sans doublon", () => {
  const tsv = `1873\t${AK}/shoot1_ak\t0.7667\t24\t306\tak47\n1881\t${AK}/idle_ak\t0\t1\t306\tak47\n`;
  const vpk = `${AK}/idle_ak.vnmclip_c CRC:00fcda5e0b size:4342\r\n${AK}/idle_ak.vnmclip+non_additive.vnmclip_c CRC:0 size:1\r\n`;
  assert.deepEqual(clipPathsIn(tsv), [`${AK}/shoot1_ak`, `${AK}/idle_ak`]);
  assert.deepEqual(clipPathsIn(vpk), [`${AK}/idle_ak`]);
});

test("clips d'une arme par rôle : le nom le plus court, sans variantes (vide, glissière, _lgcy, autre dossier)", () => {
  const names = ["shoot1_revolver", "dryfire_revolver", "reload_revolver", "idle_revolver", "draw_revolver", "draw_2_revolver"]
    .map((n) => `${REV}/${n}`).concat([`${REV}/sous/idle_x`, "animation/anims/viewmodel/pistol/pistol_p250/idle_p250"]);
  assert.deepEqual(pickClips(REV, names, rolesFor("pistolet")), { idle: `${REV}/idle_revolver`, draw: `${REV}/draw_revolver`,
    shoot: `${REV}/shoot1_revolver`, reload: `${REV}/reload_revolver` });
  const elite = "animation/anims/viewmodel/pistol/pistol_elite";
  assert.deepEqual(pickClips(elite, ["idle_leftempty_elite", "idle_elite", "shoot_right1_elite", "shoot_rightlast_elite",
    "reload_elite", "draw_elite"].map((n) => `${elite}/${n}`), ["idle", "shoot"]), { idle: `${elite}/idle_elite`, shoot: `${elite}/shoot_right1_elite` });
  const ssg = "animation/anims/viewmodel/rifle/rifle_ssg08";
  assert.equal(pickClips(ssg, [`${ssg}/idle_ssg08_lgcy`, `${ssg}/idle_ssg08`], ["idle"]).idle, `${ssg}/idle_ssg08`);
  assert.deepEqual(rolesFor("couteau"), ["idle", "draw", "attack", "attack2"]);
  assert.deepEqual(rolesFor("grenade"), ["idle", "draw", "pullpin", "throw"]);
  assert.deepEqual(rolesFor("zeus"), ["idle", "draw", "shoot"]);
});

test("weapons.json fabriqué depuis armes.json ; arme sans clip de repos : erreur", () => {
  const armes = { armes: [{ nom_interne: "weapon_ak47", nom_demoparser2: "AK-47", categorie: "fusil", modele: "weapons/models/ak47/weapon_rif_ak47.vmdl_c",
    zoom: null, dossiers_clips_vue: [{ dossier: AK, clips_references: 11 }, { dossier: "animation/anims/viewmodel/rifle/rifle_m249", clips_references: 1 }] }] };
  const clips = ["idle_ak", "draw_ak", "shoot1_ak", "reload_ak", "lookat01_ak"].map((n) => `${AK}/${n}`);
  assert.deepEqual(buildWeapons(armes, clips, "essai"), { _source: "essai", weapons: [{ key: "ak47", name: "AK-47", category: "fusil",
    model: "weapons/models/ak47/weapon_rif_ak47.vmdl_c", hideScoped: false,
    clips: { idle: `${AK}/idle_ak`, draw: `${AK}/draw_ak`, shoot: `${AK}/shoot1_ak`, reload: `${AK}/reload_ak` } }] });
  assert.throws(() => buildWeapons(armes, clips.slice(1), "essai"), /ak47 : clips idle introuvables/);
});

test("rôles facultatifs d'un pistolet : dernier coup, rechargement à vide, glissière en arrière (pas dryfire, ni reload2_empty)", () => {
  const glock = `${VM}/pistol/pistol_glock18`;
  const names = at(glock, ["shoot1_glock", "shoot_empty_glock", "reload_glock", "reload_empty_glock", "idle_glock", "draw_glock", "idle_slide_back_glock"]);
  const out = pickClips(glock, names, optionalRolesFor("pistolet"));
  assert.deepEqual(out, { shoot_empty: `${glock}/shoot_empty_glock`, reload_empty: `${glock}/reload_empty_glock`, idle_empty: `${glock}/idle_slide_back_glock` });
  assert.deepEqual(Object.keys(out), optionalRolesFor("pistolet"));  // ordre de la liste, pour un JSON stable
  const cz = `${VM}/pistol/pistol_cz75a`;  // reload2_empty_cz75a : variante, le rechargement à vide est reload_empty_cz75a
  assert.equal(pickClips(cz, at(cz, ["reload2_empty_cz75a", "reload_empty_cz75a"]), ["reload_empty"]).reload_empty, `${cz}/reload_empty_cz75a`);
  // le revolver n'a que dryfire (clic sans balle) : pas de dernier coup ; un fusil sans clip à vide n'en a aucun
  assert.deepEqual(pickClips(REV, at(REV, ["dryfire_revolver", "idle_revolver", "shoot1_revolver"]), optionalRolesFor("pistolet")), {});
  assert.deepEqual(pickClips(AK, at(AK, ["idle_ak", "shoot1_ak", "reload_ak", "ironsight_shoot_ak"]), optionalRolesFor("fusil")), {});
  // Dual Berettas : une seule main comme pour « shoot » (droite) ; au chargeur vide, les deux glissières sont en arrière
  const elite = `${VM}/pistol/pistol_elite`;
  assert.deepEqual(pickClips(elite, at(elite, ["shoot_left1_elite", "shoot_leftlast_elite", "shoot_right1_elite", "shoot_rightlast_elite", "idle_elite",
    "idle_leftempty_elite", "idle_leftrightempty_elite"]), optionalRolesFor("pistolet")),
  { shoot_empty: `${elite}/shoot_rightlast_elite`, idle_empty: `${elite}/idle_leftrightempty_elite` });
  assert.deepEqual(optionalRolesFor("zeus"), []);
});

test("rôles facultatifs du couteau (touché, dans le dos, 2e variante), de la grenade (par-dessous) et du C4 (pose)", () => {
  const k = `${VM}/knife/_default_knife`;
  const clips = ["light_miss1_knife", "light_miss2_knife", "light_hit1_knife", "light_hit2_knife", "light_backstab_knife", "light_backstab2_knife",
    "heavy_miss1_knife", "heavy_hit1_knife", "heavy_backstab_knife", "draw_knife", "lookat01_knife", "idle_knife", "idle2_knife"];
  // suffixe 2 = coup lourd (clic droit), comme attack2 ; suffixe _alt = 2e variante du même coup
  assert.deepEqual(pickClips(k, at(k, clips), optionalRolesFor("couteau")), {
    attack_alt: `${k}/light_miss2_knife`, hit: `${k}/light_hit1_knife`, hit_alt: `${k}/light_hit2_knife`,
    backstab: `${k}/light_backstab_knife`, backstab_alt: `${k}/light_backstab2_knife`, hit2: `${k}/heavy_hit1_knife`, backstab2: `${k}/heavy_backstab_knife` });
  assert.deepEqual(pickClips(k, at(k, ["heavy_miss1_knife", "heavy_miss2_knife", "heavy_hit2_knife", "heavy_backstab2_knife"]), optionalRolesFor("couteau")),
    { attack2_alt: `${k}/heavy_miss2_knife`, hit2_alt: `${k}/heavy_hit2_knife`, backstab2_alt: `${k}/heavy_backstab2_knife` });
  assert.deepEqual(pickClips(k, at(k, ["light_miss1_knife", "heavy_miss1_knife"]), optionalRolesFor("couteau")), {});  // coups dans le vide seulement

  const g = `${VM}/grenade/grenade_flashbang`;
  assert.deepEqual(pickClips(g, at(g, ["throw_overhand_flashbang", "throw_underhand_flashbang", "throwcharge_low_flashbang", "pullpin_flashbang"]),
    optionalRolesFor("grenade")), { throw_underhand: `${g}/throw_underhand_flashbang` });
  const c4 = `${VM}/equipment/c4`;
  assert.deepEqual(pickClips(c4, at(c4, ["draw_c4", "idle_c4", "plant_c4", "lookat01_c4"]), optionalRolesFor("C4")), { plant: `${c4}/plant_c4` });
});

test("weapons.json fabriqué : tous les rôles obligatoires de la catégorie exigés (erreur au nom de l'arme), facultatifs seulement s'ils existent", () => {
  const glock = `${VM}/pistol/pistol_glock18`;
  const armes = { armes: [{ nom_interne: "weapon_glock", nom_demoparser2: "Glock-18", categorie: "pistolet", modele: "weapons/models/glock/weapon_pist_glock18.vmdl_c",
    zoom: null, dossiers_clips_vue: [{ dossier: glock, clips_references: 9 }] }] };
  const all = ["idle_glock", "draw_glock", "shoot1_glock", "reload_glock", "shoot_empty_glock", "idle_slide_back_glock"];
  const [w] = buildWeapons(armes, at(glock, all), "essai").weapons;
  assert.deepEqual(w.clips, { idle: `${glock}/idle_glock`, draw: `${glock}/draw_glock`, shoot: `${glock}/shoot1_glock`, reload: `${glock}/reload_glock`,
    shoot_empty: `${glock}/shoot_empty_glock`, idle_empty: `${glock}/idle_slide_back_glock` });  // obligatoires d'abord, pas de reload_empty : absent
  assert.deepEqual(Object.keys(w.clips), ["idle", "draw", "shoot", "reload", "shoot_empty", "idle_empty"]);
  assert.throws(() => buildWeapons(armes, at(glock, all.filter((n) => !/^(shoot1|reload)_/.test(n))), "essai"), /glock : clips shoot, reload introuvables/);
  const sansVide = buildWeapons(armes, at(glock, all.slice(0, 4)), "essai").weapons[0];  // aucun clip à vide : pas une erreur
  assert.deepEqual(Object.keys(sansVide.clips), ["idle", "draw", "shoot", "reload"]);
});

test("lib/weapons.json versionné : 44 armes, clés uniques, rôles obligatoires de leur catégorie partout (+ facultatifs)", () => {
  const list = loadWeapons();
  assert.equal(list.length, 44);
  assert.equal(new Set(list.map((w) => w.key)).size, 44);
  for (const w of list) {
    assert.match(w.model, /^weapons\/models\/.+\.vmdl_c$/, w.key);
    const keys = Object.keys(w.clips);  // rôles obligatoires de la catégorie, puis facultatifs présents (dans l'ordre de la liste)
    assert.deepEqual(keys, [...rolesFor(w.category), ...optionalRolesFor(w.category).filter((r) => keys.includes(r))], w.key);
    assert.equal(new Set(Object.values(w.clips)).size, keys.length, `${w.key} : un clip différent par rôle`);
    for (const p of Object.values(w.clips)) assert.match(p, /^animation\/anims\/viewmodel\/[a-z0-9_/]+$/, w.key);
  }
  const by = Object.fromEntries(list.map((w) => [w.key, w]));
  assert.equal(by.ak47.clips.shoot, `${AK}/shoot1_ak`);
  assert.equal(by.knife_t.clips.attack, "animation/anims/viewmodel/knife/knife_default_t/light_miss1_default_t");
  assert.deepEqual(list.filter((w) => w.hideScoped).map((w) => w.key).sort(), ["awp", "g3sg1", "scar20", "ssg08"]);
});

test("lib/weapons.json versionné : rôles facultatifs (USP-S, Glock, Dual Berettas, couteaux, flash, C4) et armes sans", () => {
  const by = Object.fromEntries(loadWeapons().map((w) => [w.key, w]));
  const optional = (key) => Object.fromEntries(Object.entries(by[key].clips).filter(([r]) => optionalRolesFor(by[key].category).includes(r)));
  assert.deepEqual(optional("usp_silencer"), { shoot_empty: `${VM}/pistol/_default_pistol/shoot_empty_pistol`,
    reload_empty: `${VM}/pistol/_default_pistol/reload_empty_pistol`, idle_empty: `${VM}/pistol/_default_pistol/idle_slide_back_pistol` });
  assert.deepEqual(optional("glock"), { shoot_empty: `${VM}/pistol/pistol_glock18/shoot_empty_glock`,
    reload_empty: `${VM}/pistol/pistol_glock18/reload_empty_glock`, idle_empty: `${VM}/pistol/pistol_glock18/idle_slide_back_glock` });
  assert.deepEqual(optional("elite"), { shoot_empty: `${VM}/pistol/pistol_elite/shoot_rightlast_elite`, idle_empty: `${VM}/pistol/pistol_elite/idle_leftrightempty_elite` });
  const knife = (dir, s) => ({ attack_alt: `${dir}/light_miss2_${s}`, hit: `${dir}/light_hit1_${s}`, hit_alt: `${dir}/light_hit2_${s}`,
    backstab: `${dir}/light_backstab_${s}`, backstab_alt: `${dir}/light_backstab2_${s}`, hit2: `${dir}/heavy_hit1_${s}`, backstab2: `${dir}/heavy_backstab_${s}` });
  assert.deepEqual(optional("knife"), knife(`${VM}/knife/_default_knife`, "knife"));
  assert.deepEqual(optional("knife_t"), knife(`${VM}/knife/knife_default_t`, "default_t"));
  assert.deepEqual(optional("flashbang"), { throw_underhand: `${VM}/grenade/grenade_flashbang/throw_underhand_flashbang` });
  assert.deepEqual(optional("c4"), { plant: `${VM}/equipment/c4/plant_c4` });
  // sans clip à vide ni variante : revolver (dryfire), fusils, mitrailleuse sans clip à vide, zeus
  for (const key of ["revolver", "ak47", "awp", "mp9", "m249", "taser"]) if (by[key]) assert.deepEqual(optional(key), {}, key);
  // décomptes : 11 armes avec un dernier coup à vide, 8 avec un rechargement à vide, 9 avec la glissière, 6 grenades par-dessous
  const count = (role) => Object.values(by).filter((w) => role in w.clips).length;
  assert.deepEqual(["shoot_empty", "reload_empty", "idle_empty", "throw_underhand", "plant", "hit", "backstab"].map(count), [11, 8, 9, 6, 1, 2, 2]);
});
