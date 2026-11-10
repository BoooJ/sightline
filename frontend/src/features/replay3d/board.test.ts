import { describe, expect, it } from "vitest";
import type { BombEvent, KillEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import type { PlayerState } from "../replay/engine/state";
import { adrBefore, boardKey, KILL_FEED_S, povBoard, weaponSlots } from "./board";

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
  steamid: "a", name: "ZywOo", side: "T", slot: 1, x: 0, y: 0, z: 0, yaw: 0, hp: 100, armor: 100, alive: true, helmet: true,
  defuser: false, hasBomb: false, defusing: false, scoped: false, flash: 0, money: 4550, weapon: "AK-47",
  inventory: ["Glock-18", "AK-47", "Flashbang", "Smoke Grenade", "Flashbang"], equip: 0,
  pitch: 0, duck: 0, airborne: false, clip: 30, reserve: 90, zoom: 0, keys: 0, crosshair: null,
  fov: 0, viewmodel: null, ...over });
const kill = (over: Partial<KillEvent> = {}): KillEvent => ({
  tick: 2000, attacker: "t1", victim: "c2", assister: null, weapon: "ak47", headshot: false, penetrated: 0, through_smoke: false,
  noscope: false, attacker_blind: false, flash_assist: false, attacker_pos: [0, 0, 0], victim_pos: [0, 0, 0], is_opening: false,
  is_trade: false, ...over });
// round : freeze time jusqu'au tick 1000, fin au tick 9000, 64 ticks/s
const replay = (kills: KillEvent[] = [], bomb: BombEvent[] = [], winner: "CT" | "T" | null = null) => ({
  tickrate: 64, freezeEndTick: 1000, endTick: 9000,
  payload: {
    round: { number: 4, winner_side: winner },
    players: [
      { steamid: "t1", name: "NertZ", team_id: 1, side: "T" }, { steamid: "t2", name: "m0NESY", team_id: 1, side: "T" },
      { steamid: "c1", name: "dev1ce", team_id: 2, side: "CT" }, { steamid: "c2", name: "blameF", team_id: 2, side: "CT" },
    ],
    kills, bomb,
  },
}) as unknown as Replay;
// 10 joueurs dans le désordre (les emplacements font l'ordre)
const ten = () => [
  ...[3, 1, 5, 2, 4].map((slot) => player({ steamid: `t${slot}`, name: `T${slot}`, side: "T", slot })),
  ...[2, 5, 1, 4, 3].map((slot) => player({ steamid: `c${slot}`, name: `C${slot}`, side: "CT", slot, inventory: ["USP-S"], weapon: "USP-S" })),
];

describe("tableau du HUD complet (barre de score, fil des kills)", () => {
  it("deux camps de 5 rangés par emplacement ; vie, argent, arme principale sinon pistolet ; bombe et kit", () => {
    const st = ten();
    st[1] = { ...st[1], alive: false, hp: 0, inventory: [], weapon: "" };            // T1 mort
    st[3] = { ...st[3], hasBomb: true, money: 800 };                                 // T2 porte la bombe
    st[7] = { ...st[7], defuser: true, inventory: ["USP-S", "M4A1-S"] };             // C1 : kit, M4
    const b = povBoard(replay(), 3000, st);
    expect(b.ct.map((p) => p.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(b.t.map((p) => p.name)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(b.t[0]).toMatchObject({ alive: false, hp: 0, gun: null });
    expect(b.t[1]).toMatchObject({ alive: true, hp: 100, money: 800, gun: "AK-47", bomb: true, kit: false });
    expect(b.ct[0]).toMatchObject({ gun: "M4A1-S", kit: true });
    expect(b.ct[1]).toMatchObject({ gun: "USP-S" });  // pistolet seul
  });

  it("horloge du round : freeze time, en jeu, bombe posée", () => {
    expect(povBoard(replay(), 1000 - 64 * 10, ten()).clock).toEqual({ label: "0:10", phase: "freeze" });
    expect(povBoard(replay(), 1000 + 64 * 25, ten()).clock).toEqual({ label: "1:30", phase: "live" });
    const plant: BombEvent = { tick: 4000, type: "plant", player: "t1", site: "A", pos: [0, 0, 0] };
    expect(povBoard(replay([], [plant]), 4000 + 64 * 5, ten()).clock).toEqual({ label: "0:35", phase: "planted" });
  });

  it("kills des 6 dernières secondes jusqu'à l'instant, dans l'ordre, noms et camps résolus ; tueur inconnu ou absent : sans tueur", () => {
    const ks = [kill({ tick: 2000, headshot: true }), kill({ tick: 2100, attacker: null, victim: "t2", weapon: "world" }),
      kill({ tick: 5000, attacker: "c1", victim: "t1" })];
    const b = povBoard(replay(ks), 2200, ten());  // 6 s = 384 ticks : les deux premiers ; le troisième est à venir
    expect(b.kills).toHaveLength(2);
    expect(b.kills[0]).toMatchObject({ attacker: { steamid: "t1", name: "NertZ", side: "T" }, victim: { steamid: "c2", name: "blameF", side: "CT" },
      weapon: "ak47", headshot: true, wallbang: false, smoke: false, noscope: false, blind: false, assister: null, flashAssist: false });
    expect(b.kills[1].attacker).toBeNull();
    expect(b.kills[1].victim).toMatchObject({ name: "m0NESY", side: "T" });
    expect(povBoard(replay(ks), 5100, ten()).kills.map((k) => k.id)).toEqual(["5000-t1"]);  // les anciens sont sortis
  });

  it("particularités d'un kill, comme le fil du jeu : passeur (et passe par flash), tueur aveuglé, fumée, mur, sans lunette, tête", () => {
    const k = kill({ assister: "t2", flash_assist: true, attacker_blind: true, through_smoke: true, penetrated: 1, noscope: true, headshot: true });
    expect(povBoard(replay([k]), 2010, ten()).kills[0]).toMatchObject({
      assister: { steamid: "t2", name: "m0NESY", side: "T" }, flashAssist: true, blind: true, smoke: true, wallbang: true, noscope: true,
      headshot: true });
  });

  it(`fenêtre de ${KILL_FEED_S} s (observée : encore là à 5,75 s, partie à 6 s) : un kill à 383 ticks reste, à 384 il sort`, () => {
    expect(KILL_FEED_S).toBe(6);
    const r = replay([kill({ tick: 2000 })]);
    expect(povBoard(r, 2367, ten()).kills).toHaveLength(1);
    expect(povBoard(r, 2383, ten()).kills).toHaveLength(1);
    expect(povBoard(r, 2384, ten()).kills).toHaveLength(0);
    expect(povBoard(r, 1999, ten()).kills).toHaveLength(0);  // pas encore arrivé
    // la fenêtre suit le pas de la démo : à 128 ticks/s, 6 s = 768 ticks
    const fast = { ...replay([kill({ tick: 2000 })]), tickrate: 128 } as unknown as Replay;
    expect(povBoard(fast, 2767, ten()).kills).toHaveLength(1);
    expect(povBoard(fast, 2768, ten()).kills).toHaveLength(0);
  });

  it("au plus 5 lignes : les 5 plus récentes, du plus ancien au plus récent", () => {
    const ks = [0, 1, 2, 3, 4, 5, 6].map((i) => kill({ tick: 2000 + i * 10, victim: `v${i}` }));
    expect(povBoard(replay(ks), 2100, ten()).kills.map((k) => k.victim.steamid)).toEqual(["v2", "v3", "v4", "v5", "v6"]);
    expect(povBoard(replay(ks), 2030, ten()).kills.map((k) => k.victim.steamid)).toEqual(["v0", "v1", "v2", "v3"]);
  });

  it("clé : change quand un kill sort de la fenêtre (même sans autre changement), sinon il resterait affiché à l'arrêt", () => {
    const r = replay([kill({ tick: 2000 })]);
    const inside = povBoard(r, 2383, ten()), outside = povBoard(r, 2384, ten());
    expect(outside.clock.label).toBe(inside.clock.label);  // seule la liste des kills diffère
    expect(boardKey(outside)).not.toBe(boardKey(inside));
    // deux kills, le plus ancien sort : la clé change aussi
    const two = replay([kill({ tick: 2000 }), kill({ tick: 2100, victim: "t2" })]);
    expect(boardKey(povBoard(two, 2384, ten()))).not.toBe(boardKey(povBoard(two, 2383, ten())));
    // sixième kill dans la fenêtre : le plus ancien quitte les 5 lignes, la clé change
    const six = replay([0, 1, 2, 3, 4, 5].map((i) => kill({ tick: 2000 + i, victim: `v${i}` })));
    expect(boardKey(povBoard(six, 2004, ten()))).not.toBe(boardKey(povBoard(six, 2005, ten())));
  });

  it("par joueur aussi : armure et casque, grenades dans l'ordre du jeu, kills du round jusqu'à l'instant (adversaires seulement)", () => {
    const st = ten();
    st[3] = { ...st[3], armor: 0, helmet: false, inventory: ["Glock-18", "Smoke Grenade", "Flashbang", "High Explosive Grenade", "Flashbang"] };  // T2
    const ks = [kill({ tick: 1500, attacker: "t1", victim: "c2" }), kill({ tick: 1600, attacker: "t1", victim: "c1" }),
      kill({ tick: 1700, attacker: "t1", victim: "t2" }),  // coéquipier : ne compte pas
      kill({ tick: 4000, attacker: "c1", victim: "t1" })];  // pas encore arrivé
    const b = povBoard(replay(ks), 2000, st);
    expect(b.t[0]).toMatchObject({ steamid: "t1", kills: 2, armor: 100, helmet: true });
    expect(b.t[1]).toMatchObject({ armor: 0, helmet: false, nades: ["he", "flash", "flash", "smoke"] });
    expect(b.ct[0].kills).toBe(0);
  });

  it("fin du round : horloge à 0:00 et camp vainqueur (bandeau) ; avant la fin, pas de vainqueur", () => {
    expect(povBoard(replay([], [], "T"), 9001, ten())).toMatchObject({ clock: { label: "0:00", phase: "over" }, winner: "T" });
    expect(povBoard(replay([], [], "T"), 8999, ten()).winner).toBeNull();
    expect(povBoard(replay([], [], null), 9001, ten()).winner).toBeNull();
  });

  it("clé : ni la position ni le regard ni les munitions, mais vie, argent, vivant, arme, horloge et kills", () => {
    const r = replay([kill({ tick: 2000 })]);
    const k = boardKey(povBoard(r, 1100, ten()));
    const moved = ten().map((p) => ({ ...p, x: 99, y: 5, yaw: 90, pitch: 3, flash: 2, clip: 3, duck: 1 }));
    expect(boardKey(povBoard(r, 1100, moved))).toBe(k);
    expect(boardKey(povBoard(r, 1110, ten()))).toBe(k);  // même seconde affichée
    const changed = (f: (p: PlayerState) => PlayerState) => boardKey(povBoard(r, 1100, ten().map((p, i) => (i === 0 ? f(p) : p))));
    expect(changed((p) => ({ ...p, hp: 50 }))).not.toBe(k);
    expect(changed((p) => ({ ...p, money: 0 }))).not.toBe(k);
    expect(changed((p) => ({ ...p, alive: false }))).not.toBe(k);
    expect(changed((p) => ({ ...p, inventory: ["Glock-18"] }))).not.toBe(k);
    expect(changed((p) => ({ ...p, hasBomb: true }))).not.toBe(k);
    expect(changed((p) => ({ ...p, armor: 0 }))).not.toBe(k);
    expect(changed((p) => ({ ...p, helmet: false }))).not.toBe(k);
    expect(changed((p) => ({ ...p, inventory: [...p.inventory, "Molotov"] }))).not.toBe(k);
    expect(boardKey(povBoard(r, 1200, ten()))).not.toBe(k);   // autre seconde
    expect(boardKey(povBoard(r, 2000, ten()))).not.toBe(k);   // un kill de plus
  });
});

describe("armes du joueur par emplacement", () => {
  const names = (p: PlayerState) => weaponSlots(p).map((s) => [s.n, s.items.map((it) => `${it.name}${it.held ? "*" : ""}`)]);

  it("1 principale, 2 pistolet, 3 couteau (et zeus), 4 grenades dans l'ordre du jeu, 5 C4 ; celle en main marquée", () => {
    const p = player({ inventory: ["Knife", "Glock-18", "Flashbang", "AK-47", "C4 Explosive", "Smoke Grenade", "Zeus x27",
      "High Explosive Grenade", "Flashbang"] });
    expect(names(p)).toEqual([
      [1, ["AK-47*"]], [2, ["Glock-18"]], [3, ["Knife", "Zeus x27"]],
      [4, ["High Explosive Grenade", "Flashbang", "Flashbang", "Smoke Grenade"]], [5, ["C4 Explosive"]],
    ]);
  });
  it("grenade en main : la première de son type ; C4 en main ; couteau en main", () => {
    const inv = ["Knife", "USP-S", "Flashbang", "Flashbang", "C4 Explosive"];
    expect(names(player({ weapon: "Flashbang", inventory: inv }))[2]).toEqual([4, ["Flashbang*", "Flashbang"]]);
    expect(names(player({ weapon: "C4 Explosive", inventory: inv })).at(-1)).toEqual([5, ["C4 Explosive*"]]);
    expect(names(player({ weapon: "Knife", inventory: inv }))[1]).toEqual([3, ["Knife*"]]);
  });
  it("emplacements vides absents ; arme en main absente de l'inventaire : montrée quand même ; bombe sans C4 dans l'inventaire", () => {
    expect(names(player({ weapon: "Knife", inventory: ["Knife"] }))).toEqual([[3, ["Knife*"]]]);
    expect(names(player({ weapon: "Desert Eagle", inventory: ["Knife"] }))).toEqual([[2, ["Desert Eagle*"]], [3, ["Knife"]]]);
    expect(names(player({ weapon: "", inventory: [], hasBomb: true }))).toEqual([[5, ["C4 Explosive"]]]);
    expect(weaponSlots(player({ weapon: "", inventory: [] }))).toEqual([]);
  });
  it("grenade incendiaire : rangée avec les molotovs", () => {
    const s = weaponSlots(player({ weapon: "Incendiary Grenade", inventory: ["Incendiary Grenade", "Decoy Grenade"] }));
    expect(s).toEqual([{ n: 4, items: [{ name: "Incendiary Grenade", nade: "molotov", held: true }, { name: "Decoy Grenade", nade: "decoy", held: false }] }]);
  });
});

describe("ADR sous le nom du joueur suivi (règle du tableau des scores du jeu)", () => {
  type Pl = { steamid: string; name: string; team_id: number; side: "CT" | "T" };
  const pl = (ctFirst: boolean): Pl[] => [
    { steamid: "a", name: "a", team_id: 1, side: ctFirst ? "CT" : "T" }, { steamid: "b", name: "b", team_id: 1, side: ctFirst ? "CT" : "T" },
    { steamid: "x", name: "x", team_id: 2, side: ctFirst ? "T" : "CT" }];
  const dmg = (attacker: string | null, victim: string, d: number) => ({ tick: 1, attacker, victim, dmg: d, hitgroup: "chest" });
  const round = (number: number, damages: ReturnType<typeof dmg>[], ctFirst = true) =>
    ({ round: { number }, players: pl(ctFirst), damages }) as never;

  it("dégâts infligés aux adversaires pendant les rounds terminés avant ce round, divisés par leur nombre, arrondi à l'entier inférieur", () => {
    // valeurs relevées : 430 dégâts sur 4 rounds → 107 (107,5 tronqué) ; 37 sur 1 round → 37
    const r = [round(1, [dmg("a", "x", 100), dmg("x", "a", 40)]), round(2, [dmg("a", "x", 230)]), round(3, [dmg("a", "x", 70)], false),
      round(4, [dmg("a", "x", 30), dmg("b", "x", 9)], false)];
    const adr = adrBefore(r, 5)!;
    expect(adr.get("a")).toBe(107);  // 430 / 4 = 107,5
    expect(adr.get("x")).toBe(10);   // 40 / 4
    expect(adr.get("b")).toBe(2);    // 9 / 4
    expect(adrBefore([round(1, [dmg("a", "x", 37)])], 2)!.get("a")).toBe(37);
  });
  it("ni les dégâts aux coéquipiers, ni à soi-même, ni ceux du monde (chute, bombe) ; le round en cours ne compte pas", () => {
    const r = [round(1, [dmg("a", "b", 50), dmg("a", "a", 20), dmg(null, "a", 30), dmg("a", "x", 10)])];
    expect(adrBefore(r, 2)!.get("a")).toBe(10);
    expect(adrBefore(r, 2)!.get("b") ?? 0).toBe(0);
  });
  it("premier round : 0 pour tous (aucun round terminé) ; un round précédent pas encore chargé : inconnu (null)", () => {
    expect(adrBefore([], 1)!.size).toBe(0);
    expect(adrBefore([round(1, []), undefined], 3)).toBeNull();
  });
});
