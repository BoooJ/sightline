import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapMeta } from "../../shared/api/types";
import type { PlayerState } from "../replay/engine/state";
import type { Board, BoardKill, BoardPlayer } from "./board";
import type { RadarSource } from "./MiniRadar";
import { Ammo, HUD_BASE_H, HUD_BASE_W, hudScale, HudKillFeed, Money, PovHud, PovLayer, Scoreboard, Vitals, WeaponSlots,
  WinBanner } from "./PovHud";

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
  steamid: "a", name: "ZywOo", side: "T", slot: 1, x: 0, y: 0, z: 0, yaw: 0, hp: 100, armor: 100, alive: true, helmet: true,
  defuser: false, hasBomb: false, defusing: false, scoped: false, flash: 0, money: 4550, weapon: "AK-47",
  inventory: ["Glock-18", "AK-47", "Flashbang", "Smoke Grenade", "Flashbang"], equip: 0,
  pitch: 0, duck: 0, airborne: false, clip: 30, reserve: 90, zoom: 0, keys: 0, crosshair: null,
  fov: 0, viewmodel: null, ...over });
const card = (side: "CT" | "T", slot: number, over: Partial<BoardPlayer> = {}): BoardPlayer => ({
  steamid: `${side}${slot}`, name: `${side}-${slot}`, side, slot, alive: true, hp: 100, money: 800, gun: "Glock-18",
  bomb: false, kit: false, armor: 100, helmet: false, nades: [], kills: 0, ...over });
const board = (over: Partial<Board> = {}): Board => ({
  clock: { label: "1:30", phase: "live" },
  ct: [1, 2, 3, 4, 5].map((s) => card("CT", s)), t: [1, 2, 3, 4, 5].map((s) => card("T", s)),
  kills: [], winner: null, ...over });
const kill = (over: Partial<BoardKill> = {}): BoardKill => ({
  id: "2000-CT2", attacker: { steamid: "T1", name: "T1", side: "T" }, assister: null, flashAssist: false,
  victim: { steamid: "CT2", name: "CT2", side: "CT" }, weapon: "ak47", headshot: false, wallbang: false, smoke: false, noscope: false,
  blind: false, ...over });
const html = (el: ReactElement) => renderToStaticMarkup(el);
const count = (h: string, re: RegExp) => h.match(re)?.length ?? 0;
const MAP = { name: "de_nuke", display_name: "Nuke", pos_x: 0, pos_y: 0, scale: 5, image: "de_nuke.png", levels: [],
  bomb_a: null, bomb_b: null } as MapMeta;
const radar: RadarSource = { map: MAP, frame: { current: null }, placeAt: () => null };

describe("échelle du HUD (relevée : dessiné pour 1080 px de haut, réduit selon la hauteur de la vue)", () => {
  it("hauteur de la vue / 1080 : 627 px → 0,5806 (fenêtre de 1024 × 768), 939 px → 0,8694 (1920 × 1080), 459 px → 0,425", () => {
    expect(HUD_BASE_H).toBe(1080);
    expect(hudScale(948, 627)).toBeCloseTo(0.580556, 5);
    expect(hudScale(1844, 939)).toBeCloseTo(0.869444, 5);
    expect(hudScale(1204, 459)).toBeCloseTo(0.425, 5);
  });
  it("vue étroite : bornée par la largeur pour que le radar, la barre de score et le bas ne se chevauchent pas", () => {
    expect(hudScale(536, 520)).toBeCloseTo(536 / HUD_BASE_W, 5);
    expect(hudScale(536, 520)).toBeLessThan(520 / 1080);
    expect(hudScale(0, 0)).toBe(0);
  });
});

describe("barre de score (en haut au centre)", () => {
  it("horloge et score des deux camps au centre ; 5 joueurs CT à gauche, 5 T à droite, dans l'ordre des emplacements", () => {
    const h = html(createElement(Scoreboard, { board: board(), me: "T3", ct: 3, t: 5 }));
    expect(h).toContain('data-testid="pov-board"');
    expect(h).toContain(">1:30<");
    expect(h).toMatch(/r3-score ct[^>]*>3</);
    expect(h).toMatch(/r3-score t[^>]*>5</);
    expect([...h.matchAll(/data-sid="(\w+)"/g)].map((m) => m[1]))
      .toEqual(["CT1", "CT2", "CT3", "CT4", "CT5", "T1", "T2", "T3", "T4", "T5"]);
    expect(h.indexOf('data-sid="CT5"')).toBeLessThan(h.indexOf(">1:30<"));
    expect(h.indexOf(">1:30<")).toBeLessThan(h.indexOf('data-sid="T1"'));
  });
  it("joueurs en vie de chaque camp sous le score", () => {
    const b = board({ ct: [card("CT", 1, { alive: false, hp: 0 }), ...[2, 3, 4, 5].map((s) => card("CT", s))] });
    const h = html(createElement(Scoreboard, { board: b, me: "", ct: 0, t: 0 }));
    expect(h).toMatch(/r3-alive ct[^>]*aria-label="4 en vie"/);
    expect(h).toMatch(/r3-alive t[^>]*aria-label="5 en vie"/);
  });
  it("par joueur : nom, portrait neutre (pas d'avatar dans les replays), vie chiffrée, argent sans séparateur, arme, grenades, armure", () => {
    const b = board({ t: [card("T", 1, { gun: "AK-47", money: 4550, hp: 25, nades: ["he", "flash"], helmet: true }),
      ...[2, 3, 4, 5].map((s) => card("T", s))] });
    const h = html(createElement(Scoreboard, { board: b, me: "T1", ct: 0, t: 0 }));
    expect(h).toContain(">T-1<");
    expect(count(h, /class="r3-face"/g)).toBe(10);
    expect(h).toContain('aria-label="25 points de vie"');
    expect(h).toMatch(/r3-card-hp[^"]*"[^>]*>.*?<b>25<\/b>/);
    expect(h).toContain(">$4550<");
    expect(h).toContain('aria-label="AK-47"');
    expect(h).toContain('aria-label="HE"');
    expect(h).toContain('aria-label="Flash"');
    expect(h).toContain('aria-label="Gilet et casque"');
    expect(h).toContain('aria-label="Gilet seul"');
    expect(count(h, /r3-card [^"]*\bme\b/g)).toBe(1);
    expect(h).toMatch(/r3-card t me[^>]*data-sid="T1"/);
  });
  it("kills du round : une marque par kill, morts compris ; mort : carte courte, ni vie, ni arme, ni grenades, ni armure", () => {
    const b = board({ ct: [card("CT", 1, { alive: false, hp: 0, gun: null, kills: 2, nades: ["smoke"] }), card("CT", 2, { kit: true, kills: 1 }),
      ...[3, 4, 5].map((s) => card("CT", s))], t: [card("T", 1, { bomb: true }), ...[2, 3, 4, 5].map((s) => card("T", s))] });
    const h = html(createElement(Scoreboard, { board: b, me: "T1", ct: 0, t: 0 }));
    expect(count(h, /r3-card [^"]*\bdead\b/g)).toBe(1);
    expect(h).toMatch(/r3-card ct dead[^>]*data-sid="CT1"/);
    expect(h).toContain('aria-label="CT-1 mort"');
    expect(count(h, /class="r3-card-hp/g)).toBe(9);
    expect(h).toContain('aria-label="2 kills dans ce round"');
    expect(h).toContain('aria-label="1 kill dans ce round"');
    const dead = h.slice(h.indexOf('data-sid="CT1"'), h.indexOf('data-sid="CT2"'));
    expect(dead).not.toContain("Smoke");
    expect(dead).not.toContain("Gilet");
    expect(dead).toContain(">$800<");
    expect(h).toContain('aria-label="Kit de désamorçage"');
    expect(h).toContain('aria-label="Porte la bombe"');
  });
  it("bombe posée : l'horloge laisse la place à la bombe (comme le jeu, sans compte à rebours) ; freeze time ; fin du round", () => {
    const planted = html(createElement(Scoreboard, { board: board({ clock: { label: "0:35", phase: "planted" } }), me: "", ct: 0, t: 0 }));
    expect(planted).toMatch(/r3-clock planted/);
    expect(planted).toContain('aria-label="Bombe posée"');
    expect(planted).not.toContain("0:35");
    expect(html(createElement(Scoreboard, { board: board({ clock: { label: "0:12", phase: "freeze" } }), me: "", ct: 0, t: 0 })))
      .toMatch(/r3-clock freeze[^>]*>.*0:12/);
    // fin du round : le point du vainqueur est compté tout de suite (score d'avant le round + 1)
    const over = html(createElement(Scoreboard, { board: board({ clock: { label: "0:00", phase: "over" }, winner: "T" }), me: "", ct: 3, t: 5 }));
    expect(over).toMatch(/r3-score ct[^>]*>3</);
    expect(over).toMatch(/r3-score t[^>]*>6</);
  });
  it("étiquette « POV n » sous l'horloge : numéro du joueur suivi de 1 à 10 dans l'ordre de la barre (CT puis T)", () => {
    expect(html(createElement(Scoreboard, { board: board(), me: "T2", ct: 0, t: 0 }))).toMatch(/data-testid="pov-label"[^>]*>POV 7</);
    expect(html(createElement(Scoreboard, { board: board(), me: "CT1", ct: 0, t: 0 }))).toMatch(/data-testid="pov-label"[^>]*>POV 1</);
    expect(html(createElement(Scoreboard, { board: board(), me: "x", ct: 0, t: 0 }))).not.toContain("pov-label");
  });
});

describe("fil des kills (en haut à droite)", () => {
  it("tueur, arme, victime dans l'ordre ; noms aux couleurs des camps ; kills du joueur suivi cerclés de rouge", () => {
    const kills = [kill(), kill({ id: "2500-T4", attacker: { steamid: "CT1", name: "CT1", side: "CT" }, victim: { steamid: "T4", name: "T4", side: "T" }, weapon: "awp" })];
    const h = html(createElement(HudKillFeed, { kills, me: "T1" }));
    expect(h).toContain('data-testid="pov-killfeed"');
    expect(count(h, /class="r3-kill[" ]/g)).toBe(2);
    expect(h.indexOf(">T1<")).toBeLessThan(h.indexOf(">T4<"));
    expect(h).toContain('aria-label="AK-47"');
    expect(h).toContain('aria-label="AWP"');
    expect(count(h, /r3-kill mine/g)).toBe(1);
    expect(h).toMatch(/r3-kill-name t[^>]*>T1</);
    expect(h).toMatch(/r3-kill-name ct[^>]*>CT2</);
  });
  it("pictogrammes du jeu, dans son ordre : aveuglé avant le tueur, + passeur (flash), arme, sans lunette, fumée, mur, tête", () => {
    const k = kill({ blind: true, assister: { steamid: "T2", name: "T2", side: "T" }, flashAssist: true, noscope: true, smoke: true,
      wallbang: true, headshot: true });
    const h = html(createElement(HudKillFeed, { kills: [k], me: "x" }));
    const order = ["Tueur aveuglé", ">T1<", "r3-kill-plus", "Passe décisive par flash", ">T2<", 'aria-label="AK-47"', "Sans lunette",
      "À travers une fumée", "À travers un mur", "Dans la tête", ">CT2<"].map((s) => h.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const plain = html(createElement(HudKillFeed, { kills: [kill()], me: "x" }));
    for (const s of ["Tueur aveuglé", "r3-kill-plus", "Sans lunette", "fumée", "mur", "Dans la tête"]) expect(plain).not.toContain(s);
  });
  it("sans tueur (chute, bombe) : la victime seule ; aucun kill : bloc vide", () => {
    const h = html(createElement(HudKillFeed, { kills: [kill({ attacker: null, weapon: "world" })], me: "x" }));
    expect(count(h, /r3-kill-name/g)).toBe(1);
    expect(count(html(createElement(HudKillFeed, { kills: [], me: "x" })), /class="r3-kill[" ]/g)).toBe(0);
  });
});

describe("armes par emplacement (à droite)", () => {
  it("1 principale, 2 pistolet, 3 couteau empilés ; en bas : 4 grenades côte à côte et 5 C4 ; celle en main avec son nom", () => {
    const p = player({ inventory: ["Knife", "Glock-18", "AK-47", "Flashbang", "C4 Explosive"] });
    const h = html(createElement(WeaponSlots, { p }));
    expect(h).toContain('data-testid="pov-weapons"');
    expect([...h.matchAll(/r3-slot-n[^>]*>(\d)</g)].map((m) => m[1])).toEqual(["1", "2", "3", "5", "4"]);
    expect(h.indexOf('data-slot="5"')).toBeGreaterThan(h.indexOf('class="r3-slots-low'));
    expect(h.indexOf('data-slot="4"')).toBeGreaterThan(h.indexOf('class="r3-slots-low'));
    expect(count(h, /r3-slot [^"]*\bheld\b/g)).toBe(1);
    expect(h).toMatch(/r3-slot held[^>]*data-slot="1"/);
    expect(count(h, /class="r3-slot-label"/g)).toBe(1);
    expect(h).toContain(">AK-47<");
    expect(h).toContain('aria-label="C4 Explosive"');
  });
  it("grenades : une icône par type, avec ×n s'il y en a plusieurs ; grenade en main : son emplacement en évidence", () => {
    const inv = ["Knife", "USP-S", "Flashbang", "Smoke Grenade", "Flashbang"];
    const h = html(createElement(WeaponSlots, { p: player({ weapon: "Smoke Grenade", inventory: inv }) }));
    expect(h).toMatch(/r3-slot held[^>]*data-slot="4"/);
    expect(count(h, /aria-label="Flashbang"/g)).toBe(1);
    expect(h).toContain(">x2<");
    expect(h).toContain(">Smoke Grenade<");
    expect(html(createElement(WeaponSlots, { p: player({ weapon: "C4 Explosive", inventory: [...inv, "C4 Explosive"] }) })))
      .toMatch(/r3-slot held[^>]*data-slot="5"/);
  });
});

describe("grenades : 4 places, les vides en points (comme le jeu)", () => {
  it("1 grenade : 3 points ; aucune : 4 points sans numéro ; 4 grenades : aucun point ; mort : rien", () => {
    const one = html(createElement(WeaponSlots, { p: player({ inventory: ["Knife", "Glock-18", "Flashbang"] }) }));
    expect(count(one, /class="r3-pip"/g)).toBe(3);
    const none = html(createElement(WeaponSlots, { p: player({ inventory: ["Knife", "Glock-18"], weapon: "Glock-18" }) }));
    expect(count(none, /class="r3-pip"/g)).toBe(4);
    expect(none).not.toContain('data-slot="4"');
    expect(none.indexOf('class="r3-pip"')).toBeGreaterThan(none.indexOf('class="r3-slots-low'));
    const four = html(createElement(WeaponSlots, { p: player({ inventory: ["Flashbang", "Flashbang", "Smoke Grenade", "Molotov"] }) }));
    expect(count(four, /class="r3-pip"/g)).toBe(0);
  });
});

describe("bas de l'écran : argent, vie et armure, joueur, arme et munitions", () => {
  it("argent du joueur suivi (en bas à gauche), sans séparateur comme le jeu", () => {
    const h = html(createElement(Money, { p: player() }));
    expect(h).toContain('data-testid="pov-money"');
    expect(h).toContain(">$4550<");
  });
  it("armure et casque, vie, nom, ADR, portrait neutre ; ADR inconnu (rounds précédents pas encore chargés) : tiret", () => {
    const h = html(createElement(Vitals, { p: player({ defuser: true, side: "CT" }), adr: 37 }));
    expect(h).toContain('data-testid="pov-vitals"');
    expect(h).toContain('aria-label="100 points de vie"');
    expect(h).toContain('aria-label="100 d&#x27;armure"');
    expect(h).toContain('aria-label="Gilet et casque"');
    expect(h).toContain(">ZywOo<");
    expect(h).toMatch(/r3-adr[^>]*>ADR<b>37<\/b>/);
    expect(h).toContain('class="r3-face"');
    expect(h).toContain('aria-label="Kit de désamorçage"');
    expect(html(createElement(Vitals, { p: player(), adr: null }))).toMatch(/r3-adr[^>]*>ADR<b>—<\/b>/);
    expect(html(createElement(Vitals, { p: player({ hp: 1 }), adr: 0 }))).toContain('aria-label="1 point de vie"');
    expect(html(createElement(Vitals, { p: player({ armor: 0, helmet: false }), adr: 0 }))).not.toContain("Gilet");
  });
  it("arme en main : son nom (la ligne du skin reste vide : pas de données de skins) ; chargeur et réserve (si connue, > 0)", () => {
    const h = html(createElement(Ammo, { p: player({ reserve: 2 }) }));
    expect(h).toContain('data-testid="pov-ammo"');
    expect(h).toMatch(/r3-weapon-name[^>]*>AK-47</);
    expect(h).toMatch(/<span class="r3-skin"><\/span>/);
    expect(h).toContain('aria-label="30 balles dans le chargeur, 2 chargeurs de réserve"');
    expect(h).toMatch(/r3-ammo-n[^>]*>30</);
    expect(h).toMatch(/r3-reserve[^>]*>2</);
    expect(html(createElement(Ammo, { p: player({ reserve: 1 }) }))).toContain('aria-label="30 balles dans le chargeur, 1 chargeur de réserve"');
    const none = html(createElement(Ammo, { p: player({ reserve: 0 }) }));
    expect(none).toContain('aria-label="30 balles dans le chargeur"');
    expect(none).not.toContain("r3-reserve");
    expect(html(createElement(Ammo, { p: player({ reserve: null }) }))).not.toContain("r3-reserve");
    const empty = html(createElement(Ammo, { p: player({ clip: 0, reserve: 3 }) }));
    expect(empty).toMatch(/r3-ammo-n empty/);
  });
  it("couteau, C4, grenade : le nom de l'arme seul, sans munitions ; zeus : sa charge ; sans arme : rien", () => {
    for (const weapon of ["Knife", "C4 Explosive", "High Explosive Grenade"]) {
      const h = html(createElement(Ammo, { p: player({ weapon, clip: 0, reserve: 1 }) }));
      expect(h).not.toContain("balle");
      expect(h).toContain(`>${weapon}<`);
    }
    expect(html(createElement(Ammo, { p: player({ weapon: "Zeus x27", clip: 1, reserve: 0 }) }))).toContain('aria-label="1 balle dans le chargeur"');
    expect(html(createElement(Ammo, { p: player({ weapon: "", clip: null }) }))).toBe("");
  });
});

describe("fin du round", () => {
  it("bandeau du camp vainqueur", () => {
    expect(html(createElement(WinBanner, { side: "T" }))).toMatch(/data-testid="pov-win"[^>]*>.*Les terroristes gagnent/);
    expect(html(createElement(WinBanner, { side: "CT" }))).toContain("Les antiterroristes gagnent");
  });
});

describe("HUD complet", () => {
  it("tous les blocs, le dégradé sombre du bas en premier ; sans tableau (première image) ni radar : le bas de l'écran et les armes", () => {
    const h = html(createElement(PovHud, { p: player(), board: board(), ct: 1, t: 2, radar, adr: 0 }));
    for (const id of ["pov-hud", "pov-shade", "pov-board", "pov-killfeed", "pov-radar", "pov-weapons", "pov-money", "pov-vitals", "pov-ammo"]) {
      expect(h).toContain(`data-testid="${id}"`);
    }
    expect(h.indexOf('data-testid="pov-shade"')).toBeLessThan(h.indexOf('data-testid="pov-radar"'));
    expect(h).not.toContain("pov-win");
    const bare = html(createElement(PovHud, { p: player(), board: null, ct: 1, t: 2, radar: null, adr: null }));
    expect(bare).not.toContain("pov-board");
    expect(bare).not.toContain("pov-killfeed");
    expect(bare).not.toContain("pov-radar");
    expect(bare).toContain('data-testid="pov-vitals"');
    expect(bare).toContain('data-testid="pov-weapons"');
  });
  it("fin du round : le bandeau du vainqueur", () => {
    const h = html(createElement(PovHud, { p: player(), board: board({ clock: { label: "0:00", phase: "over" }, winner: "CT" }), ct: 1, t: 2,
      radar: null, adr: 0 }));
    expect(h).toContain("Les antiterroristes gagnent");
  });
});

describe("calque de la vue du joueur : caméra « Joueur » seulement ; voile des flashs au-dessus de tout", () => {
  const layer = (over: Record<string, unknown> = {}) => html(createElement(PovLayer, {
    mode: "pov", followed: player({ weapon: "Glock-18" }), board: board(), ct: 0, t: 0, windowHeight: 768, radar, adr: null, ...over }));
  it("hors caméra « Joueur », ou personne à suivre : rien", () => {
    for (const mode of ["free", "follow", "top", "tv"]) expect(layer({ mode })).toBe("");
    expect(layer({ followed: null })).toBe("");
  });
  it("caméra « Joueur » : réticule, HUD (barre de score, fil des kills, armes), puis le voile", () => {
    const h = layer();
    expect(h).toContain('data-testid="pov-layer"');
    expect(h).toContain('data-testid="crosshair"');
    expect(h).not.toContain('data-testid="scope"');
    expect(h.indexOf('data-testid="crosshair"')).toBeLessThan(h.indexOf('data-testid="pov-hud"'));
    for (const id of ["pov-board", "pov-killfeed", "pov-weapons"]) expect(h).toContain(`data-testid="${id}"`);
  });
  it("ordre des calques : lunette < réticule < HUD (et son dégradé) < voile blanc, le dernier : un flash blanchit tout uniformément", () => {
    const h = layer();
    expect(count(h, /data-testid="pov-flash"/g)).toBe(1);
    expect(h).toMatch(/<div class="r3-veil" data-testid="pov-flash" aria-hidden="true"><\/div><\/div>$/);  // dernier enfant du calque
    expect(h.indexOf('data-testid="crosshair"')).toBeLessThan(h.indexOf('data-testid="pov-hud"'));
    expect(h.indexOf('data-testid="pov-shade"')).toBeLessThan(h.indexOf('data-testid="pov-flash"'));
    expect(h.indexOf('data-testid="pov-hud"')).toBeLessThan(h.indexOf('data-testid="pov-flash"'));
    const scoped = layer({ followed: player({ weapon: "AWP", scoped: true, zoom: 1 }) });
    expect(scoped.indexOf('data-testid="scope"')).toBeLessThan(scoped.indexOf('data-testid="pov-hud"'));
    expect(scoped.indexOf('data-testid="pov-hud"')).toBeLessThan(scoped.indexOf('data-testid="pov-flash"'));
    for (const mode of ["free", "follow", "top", "tv"]) expect(layer({ mode })).not.toContain("pov-flash");
  });
  it("en lunette : la lunette, pas de réticule, le HUD (et son dégradé) par-dessus", () => {
    const h = layer({ followed: player({ weapon: "AWP", scoped: true, zoom: 1 }) });
    expect(h).toContain('data-testid="scope"');
    expect(h).not.toContain('data-testid="crosshair"');
    expect(h.indexOf('data-testid="scope"')).toBeLessThan(h.indexOf('data-testid="pov-shade"'));
    expect(h).toContain('data-testid="pov-board"');
  });
  it("ADR du joueur suivi lu dans la table des ADR (0 s'il n'a fait aucun dégât) ; table inconnue : tiret", () => {
    expect(layer({ adr: new Map([["a", 37]]) })).toMatch(/r3-adr[^>]*>ADR<b>37<\/b>/);
    expect(layer({ adr: new Map() })).toMatch(/r3-adr[^>]*>ADR<b>0<\/b>/);
    expect(layer({ adr: null })).toMatch(/r3-adr[^>]*>ADR<b>—<\/b>/);
  });
});
