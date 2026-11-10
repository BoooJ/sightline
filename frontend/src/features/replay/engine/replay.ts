import type { ReplayPayload, Side } from "../../../shared/api/types";
import { decodeWireArray, type Typed } from "./wire";

export interface ReplayPlayer { steamid: string; name: string; side: Side; index: number; slot: number }
/** Réglages des bras d'un joueur (viewmodel_fov et viewmodel_offset_x/y/z de son CS2). */
export interface Viewmodel { fov: number; x: number; y: number; z: number }
/** Recul de la caméra : décroissance exp(-18·dt) depuis le dernier tir, ignoré au-delà de 2 s (valeurs relevées). */
const PUNCH_DECAY = 18, PUNCH_MAX_S = 2;
/** Tirs d'un joueur par ordre de tick, avec le recul de la caméra enregistré au tir (degrés). */
interface PlayerShots { ticks: Int32Array; pitch: Float64Array; yaw: Float64Array }

export class Replay {
  readonly payload: ReplayPayload;
  readonly ticks: Int32Array;
  readonly n: number;
  readonly m: number;
  readonly players: ReplayPlayer[];
  readonly tickrate: number;
  readonly startTick: number;
  readonly freezeEndTick: number;
  readonly endTick: number;
  readonly lastTick: number;
  private fields: Record<string, Typed> = {};
  private invOffsets: Uint32Array;
  private invItems: Uint16Array;
  private xhair: (string | null)[];
  private vm: (Viewmodel | null)[];
  private agents: (string | null)[];
  private shots: PlayerShots[] = [];
  private forces = new Map<number, readonly [number, number, number]>();  // force de la mort, par tick × 1024 + joueur
  readonly weapons: string[];

  constructor(p: ReplayPayload) {
    this.payload = p;
    this.tickrate = p.tickrate;
    this.startTick = p.round.start_tick;
    this.freezeEndTick = p.round.freeze_end_tick;
    this.endTick = p.round.end_tick;
    const fr = p.frames;
    if (!fr) throw new Error("Ce round n'a pas de positions enregistrées (ré-analysez la démo).");
    this.ticks = decodeWireArray(fr.ticks) as Int32Array;
    this.n = fr.n;
    this.m = fr.m;
    for (const [k, v] of Object.entries(fr.fields)) this.fields[k] = decodeWireArray(v, this.n, this.m);
    this.invOffsets = decodeWireArray(fr.inv_offsets) as Uint32Array;
    this.invItems = decodeWireArray(fr.inv_items) as Uint16Array;
    this.weapons = fr.weapons;
    this.xhair = fr.xhair ?? [];
    this.agents = fr.agents ?? [];
    this.vm = (fr.vm ?? []).map((v) => (v ? { fov: v[0], x: v[1], y: v[2], z: v[3] } : null)); // objets créés une fois
    this.shots = groupShots(fr.punch ?? [], fr.m);
    for (const [tick, j, fx, fy, fz] of fr.forces ?? []) if (j >= 0 && j < fr.m) this.forces.set(tick * 1024 + j, [fx, fy, fz]);
    const info = new Map(p.players.map((x) => [x.steamid, x]));
    const slots: Record<Side, number> = { CT: 0, T: 0 };
    this.players = fr.players.map((sid, index) => {
      const i = info.get(sid);
      const side = i?.side ?? "T";
      return { steamid: sid, name: i?.name ?? sid, side, index, slot: ++slots[side] };
    });
    this.lastTick = this.ticks[this.n - 1] ?? this.endTick;
  }
  field(name: string): Typed { return this.fields[name]; }
  /** Vrai si les images ont ce champ (un replay analysé avant le 30/10/2026 n'a ni pitch, ni duck, ni keys…). */
  has(name: string): boolean { return Object.hasOwn(this.fields, name); }
  /** Code de partage du réticule du joueur d'indice `j` (`ReplayPlayer.index`), null si inconnu. */
  crosshairOf(j: number): string | null { return this.xhair[j] || null; }
  /** Réglages des bras du joueur d'indice `j` (`ReplayPlayer.index`), null si inconnus (ou replay plus ancien). */
  viewmodelOf(j: number): Viewmodel | null { return this.vm[j] ?? null; }
  /** Agent équipé par le joueur d'indice `j` (« tm_leet_variantf »), null : agent par défaut du camp, ou replay plus ancien. */
  agentOf(j: number): string | null { return this.agents[j] ?? null; }
  /** Force de la mort (unités du jeu) du joueur d'indice `j` mort au tick `tick`, lue dans la démo ; null si elle n'a pas
   *  été lue (replay analysé avant le ragdoll, démo sans la prop) : deathForce.ts l'estime alors. */
  deathForce(j: number, tick: number): readonly [number, number, number] | null { return this.forces.get(tick * 1024 + j) ?? null; }
  /** Recul de la caméra du joueur d'indice `j` au tick `tick` : [vertical, horizontal] en degrés. C'est le recul enregistré au
   *  dernier tir du joueur à ce tick ou avant, multiplié par exp(-18·dt) (dt en secondes) ; [0, 0] sans tir dans les 2 s
   *  précédentes, pour un joueur sans tir, ou dans un replay sans tirs.
   *
   *  Signes : les deux composantes sont dans la convention des angles du jeu (QAngle), la même que `PlayerState.pitch` et
   *  `PlayerState.yaw`, et s'ajoutent TELLES QUELLES au regard (le jeu ajoute le view punch aux angles de vue composante par
   *  composante) :
   *  - le vertical à `pitch` : négatif = vers le haut (un tir d'AK donne de −1 à −3), positif = vers le bas ;
   *  - l'horizontal à `yaw` : positif = vers la gauche (sens trigonométrique vu de dessus), comme `yaw`.
   *  Vérifié sur 2 994 tirs d'une démo : le vertical est toujours négatif (−3,4 à −0,4), l'horizontal est symétrique (−1,8 à
   *  +2,8, moyenne 0,03), le roulis est toujours nul (non transmis) ; et le `yaw` de la démo est bien l'angle trigonométrique
   *  (direction du déplacement d'un joueur qui avance − yaw : médiane −0,07°, contre 38° d'écart avec le signe inversé).
   *  Non vérifié : la démo ne contient pas la caméra du client, donc le sens du recul horizontal à l'écran n'a pas été comparé
   *  à l'image du jeu (seul l'ajout du vertical à l'angle vertical a été relevé). */
  punchAt(j: number, tick: number): [number, number] {
    const s = this.shots[j];
    if (!s) return [0, 0];
    let lo = 0, hi = s.ticks.length; // premier tir strictement après `tick`
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.ticks[mid] <= tick) lo = mid + 1; else hi = mid; }
    if (lo === 0) return [0, 0];
    const k = lo - 1, dt = (tick - s.ticks[k]) / this.tickrate;
    if (dt > PUNCH_MAX_S) return [0, 0];
    const f = Math.exp(-PUNCH_DECAY * dt);
    return [s.pitch[k] * f, s.yaw[k] * f];
  }
  value(name: string, i: number, j: number): number { return this.fields[name][i * this.m + j]; }
  weaponAt(i: number, j: number): string { return this.weapons[this.value("weapon", i, j)] ?? ""; }
  inventoryAt(i: number, j: number): string[] {
    const k = i * this.m + j;
    return Array.from(this.invItems.subarray(this.invOffsets[k], this.invOffsets[k + 1]), (w) => this.weapons[w]);
  }
}

/** Range les tirs [tick, joueur, vertical, horizontal] par joueur (0 ≤ joueur < m) et par ordre de tick, quel que soit l'ordre
 *  reçu (le recul de visée qui peut suivre ne sert pas à la caméra). */
function groupShots(punch: readonly (readonly [number, number, number, number, ...number[]])[], m: number): PlayerShots[] {
  const by: [number, number, number][][] = Array.from({ length: m }, () => []);
  for (const [tick, j, pitch, yaw] of punch) if (j >= 0 && j < m) by[j].push([tick, pitch, yaw]);
  return by.map((rows) => {
    rows.sort((a, b) => a[0] - b[0]);
    return { ticks: Int32Array.from(rows, (r) => r[0]), pitch: Float64Array.from(rows, (r) => r[1]), yaw: Float64Array.from(rows, (r) => r[2]) };
  });
}
