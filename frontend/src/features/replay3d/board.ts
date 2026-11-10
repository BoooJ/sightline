import type { ReplayPayload, Side } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { deathsUntil, recentKills, roundClock, type PlayerState } from "../replay/engine/state";
import { nadeKind, type NadeKind, sortInventory, weaponClass } from "../replay/hud";

/** Un joueur dans la barre de score du HUD de la vue du joueur. */
export interface BoardPlayer {
  steamid: string; name: string; side: Side; slot: number; alive: boolean; hp: number; money: number;
  /** arme principale, sinon pistolet, sinon null */
  gun: string | null;
  bomb: boolean; kit: boolean;
  /** armure (0 : aucune) et casque : pictogramme de la carte */
  armor: number; helmet: boolean;
  /** grenades portées, dans l'ordre du jeu (une entrée par grenade) */
  nades: NadeKind[];
  /** adversaires tués dans ce round jusqu'à l'instant (une marque par kill sur la carte, comme le jeu) */
  kills: number;
}
export interface KillSide { steamid: string; name: string; side: Side }
/** Une ligne du fil des kills, avec les particularités que le jeu dessine en pictogrammes : tueur (null : chute, bombe, joueur
 *  inconnu), passeur (et passe par flash), arme (nom interne du kill), tueur aveuglé, à travers une fumée, à travers un mur,
 *  sans lunette, dans la tête. */
export interface BoardKill {
  id: string; attacker: KillSide | null; assister: KillSide | null; flashAssist: boolean; victim: KillSide; weapon: string;
  blind: boolean; smoke: boolean; wallbang: boolean; noscope: boolean; headshot: boolean;
}
/** Fil des kills : un kill reste affiché moins de 6 s (observé : encore là à 5,75 s, parti à 6 s), 5 lignes au
 *  plus. */
export const KILL_FEED_S = 6, KILL_FEED_MAX = 5;

/** Ce que montrent la barre de score et le fil des kills de la vue du joueur, à un instant. */
export interface Board {
  clock: { label: string; phase: ReturnType<typeof roundClock>["phase"] };
  ct: BoardPlayer[]; t: BoardPlayer[];
  /** kills des `KILL_FEED_S` dernières secondes (au plus `KILL_FEED_MAX`, les plus récents), du plus ancien au plus récent */
  kills: BoardKill[];
  /** camp vainqueur une fois le round fini (bandeau de fin de round), sinon null */
  winner: Side | null;
}

const NADE_ORDER: NadeKind[] = ["he", "flash", "smoke", "molotov", "decoy"];
const nadesOf = (inv: string[]): NadeKind[] =>
  inv.map(nadeKind).filter((k): k is NadeKind => !!k).sort((a, b) => NADE_ORDER.indexOf(a) - NADE_ORDER.indexOf(b));

const card = (p: PlayerState, kills: number): BoardPlayer => {
  const inv = sortInventory(p.inventory);
  return { steamid: p.steamid, name: p.name, side: p.side, slot: p.slot, alive: p.alive, hp: p.alive ? p.hp : 0,
    money: p.money, gun: inv.primary ?? inv.pistol ?? null, bomb: p.hasBomb, kit: p.defuser, armor: p.armor, helmet: p.helmet,
    nades: nadesOf(p.inventory), kills };
};

/** Tableau de la vue du joueur à l'instant `tick` : horloge du round (0:00 une fois fini, comme le jeu), les deux camps
 *  rangés par emplacement (les mêmes numéros que le radar), kills récents (voir `KILL_FEED_S`), vainqueur une fois le round
 *  fini. `states` : `playerStateAt(r, tick)`. */
export function povBoard(r: Replay, tick: number, states: PlayerState[]): Board {
  const info = new Map(r.payload.players.map((p) => [p.steamid, p]));
  const who = (sid: string | null): KillSide | null => {
    const p = sid ? info.get(sid) : undefined;
    return p ? { steamid: p.steamid, name: p.name, side: p.side } : null;
  };
  const frags = new Map<string, number>();
  for (const k of deathsUntil(r, tick)) {
    const a = k.attacker ? info.get(k.attacker) : undefined, v = info.get(k.victim);
    if (a && v && a.side !== v.side) frags.set(a.steamid, (frags.get(a.steamid) ?? 0) + 1);
  }
  const side = (s: Side) => states.filter((p) => p.side === s).sort((a, b) => a.slot - b.slot)
    .map((p) => card(p, frags.get(p.steamid) ?? 0));
  const { label, phase } = roundClock(r, tick);
  return {
    clock: { label: phase === "over" ? "0:00" : label, phase }, ct: side("CT"), t: side("T"),
    // fenêtre exclusive : tick − k.tick < KILL_FEED_S · tickrate
    kills: recentKills(r, tick, KILL_FEED_S * r.tickrate - 1).slice(-KILL_FEED_MAX).map((k) => ({
      id: `${k.tick}-${k.victim}`, attacker: who(k.attacker), assister: who(k.assister), flashAssist: !!k.assister && k.flash_assist,
      weapon: k.weapon, blind: k.attacker_blind, smoke: k.through_smoke, wallbang: k.penetrated > 0, noscope: k.noscope,
      headshot: k.headshot, victim: who(k.victim) ?? { steamid: k.victim, name: k.victim, side: "T" },
    })),
    winner: phase === "over" ? r.payload.round?.winner_side ?? null : null,
  };
}

const playerKey = (p: BoardPlayer) =>
  [p.steamid, p.name, p.slot, p.alive ? 1 : 0, p.hp, p.money, p.gun ?? "", p.bomb ? 1 : 0, p.kit ? 1 : 0, p.armor > 0 ? 1 : 0,
    p.helmet ? 1 : 0, p.nades.join("."), p.kills].join(",");

/** Résumé de ce qu'affiche le tableau : `onBoard` n'est appelé que s'il change (une seconde d'horloge, une vie, un
 *  achat, un kill qui arrive ou qui sort de la fenêtre), pas à chaque image (positions, regard et munitions n'y sont pas).
 *  La liste des kills étant celle des seuls kills récents, la clé change d'elle-même quand l'un d'eux sort. */
export function boardKey(b: Board): string {
  return [b.clock.label, b.clock.phase, b.ct.map(playerKey).join(";"), b.t.map(playerKey).join(";"),
    b.kills.map((k) => k.id).join(";"), b.winner ?? ""].join("|");
}

/** ADR affiché sous le nom du joueur suivi, à la manière du tableau des scores du jeu (ses dégâts
 *  divisés par les rounds joués) : dégâts infligés aux adversaires pendant les rounds
 *  terminés avant le round `current`, divisés par le nombre de ces rounds, arrondi à l'entier inférieur (430 sur 4 rounds :
 *  107). Les dégâts du round en cours ne comptent qu'au round suivant ; au premier round, 0 pour tous. Ni les dégâts aux
 *  coéquipiers, ni à soi-même, ni ceux du monde (chute, bombe). `rounds` : les replays des rounds 1 à `current − 1` (dans
 *  n'importe quel ordre) ; un round manquant (pas encore chargé) : null. Joueur absent de la table : 0. */
export function adrBefore(rounds: (Pick<ReplayPayload, "round" | "players" | "damages"> | undefined)[], current: number):
  Map<string, number> | null {
  if (rounds.some((r) => !r)) return null;
  const total = new Map<string, number>();
  let n = 0;
  for (const r of rounds) {
    if (!r || r.round.number >= current) continue;
    n++;
    const side = new Map(r.players.map((p) => [p.steamid, p.side]));
    for (const d of r.damages) {
      const a = d.attacker ? side.get(d.attacker) : undefined;
      if (!a || d.attacker === d.victim || a === side.get(d.victim)) continue;
      total.set(d.attacker!, (total.get(d.attacker!) ?? 0) + d.dmg);
    }
  }
  const adr = new Map<string, number>();
  if (n > 0) for (const [sid, dmg] of total) adr.set(sid, Math.floor(dmg / n));
  return adr;
}

/** Une arme dans la liste par emplacement ; `nade` : type de grenade (icône et couleur). */
export interface SlotItem { name: string; held: boolean; nade?: NadeKind }
export interface WeaponSlot { n: 1 | 2 | 3 | 4 | 5; items: SlotItem[] }

const C4 = "C4 Explosive";

/** Armes du joueur par emplacement, comme le jeu : 1 principale, 2 pistolet, 3 couteau (et zeus), 4 grenades (dans l'ordre
 *  du jeu), 5 C4 ; emplacements vides absents. L'arme en main est marquée (grenade : la première de son type) ; si
 *  l'inventaire ne la contient pas, elle est ajoutée. La bombe portée compte même si l'inventaire ne l'a pas. */
export function weaponSlots(p: Pick<PlayerState, "weapon" | "inventory" | "hasBomb">): WeaponSlot[] {
  const inv = p.weapon && !p.inventory.includes(p.weapon) ? [...p.inventory, p.weapon] : p.inventory;
  const { primary, pistol } = sortInventory(inv);
  const item = (name: string): SlotItem => ({ name, held: name === p.weapon });
  const melee = [inv.find((w) => weaponClass(w) === "knife"), inv.find((w) => weaponClass(w) === "zeus")]
    .filter((w): w is string => !!w);
  const held = nadeKind(p.weapon);
  let marked = false;
  const nades = inv.filter((w) => nadeKind(w))
    .map((name) => ({ name, nade: nadeKind(name)! }))
    .sort((a, b) => NADE_ORDER.indexOf(a.nade) - NADE_ORDER.indexOf(b.nade))
    .map(({ name, nade }) => {
      const h = !marked && nade === held;
      if (h) marked = true;
      return { name, nade, held: h };
    });
  const slots: WeaponSlot[] = [
    { n: 1, items: primary ? [item(primary)] : [] },
    { n: 2, items: pistol ? [item(pistol)] : [] },
    { n: 3, items: melee.map(item) },
    { n: 4, items: nades },
    { n: 5, items: inv.includes(C4) || p.hasBomb ? [item(C4)] : [] },
  ];
  return slots.filter((s) => s.items.length > 0);
}
