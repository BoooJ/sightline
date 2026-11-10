/**
 * Morts en ragdoll du round affiché. Pour chaque kill (le premier de chaque victime, comme agentPose) : l'état de départ —
 * pose du mourant (dyingPose) posée sur un clone de travail du modèle de la victime au tick du kill et START_DT avant,
 * os des corps lus dans le monde (AgentRig.boneStates), vitesses par différences, vitesse du corps prise des positions du
 * replay (celle de la démo est parfois fausse : sonde 0.6), posé au point de la mort ; impulsion de la force de la mort
 * (deathForce : lue, sinon estimée) dont HIT_PART sur le corps de la zone touchée — ; puis la simulation dans le worker
 * (ragdollWorker.ts : aucune physique sur le fil du rendu), une mort à la fois, la plus proche du tick affiché d'abord ;
 * une mort dont le modèle ou les clips ne sont pas encore là est sautée (la suivante part) et n'est réessayée qu'au
 * prochain fichier arrivé (`AgentLibrary.version`) : rien n'est refait à chaque image pour elle.
 * Trajectoires gardées par replay (WeakMap : libérées avec lui), par victime puis par tick du kill ; `track` les rend
 * (RagdollLookup d'agentAnim.ts), null sinon : clip de mort ; `count` lit un compteur. Ni `track` ni `count` n'allouent
 * (appelés à chaque image). `version` augmente à chaque réponse (les poses des morts sont à refaire). Rien sans worker,
 * sans fichier « ragdoll » ou sans la collision de la carte du round ; worker en échec (`onerror`) : arrêté, jamais
 * relancé, les morts gardent leurs clips. Rejouable : une trajectoire ne dépend que du replay, du modèle, du ragdoll et
 * de la collision ; elle est calculée une fois et relue telle quelle dans les deux sens de lecture.
 */
import type { KillEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { type AgentBody, type DeathTrack, dyingPose, type RagdollLookup } from "./agentAnim";
import { AgentRig } from "./agentRig";
import type { AgentLibrary, AgentModel } from "./agents";
import { deathForce, HIT_BODY } from "./deathForce";
import type { RagdollFile } from "./ragdollDef";
import type { RagdollIn, RagdollOut } from "./ragdollEngine";
import { MAX_V, type RagdollStart } from "./ragdollSolver";

/** Ce que Ragdolls attend d'un worker (Worker, ou un faux dans les tests). */
export interface RagdollPort {
  postMessage(m: RagdollIn, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<RagdollOut>) => void) | null;
  /** Script du worker qui ne se charge pas (404 du fichier), ou exception hors du moteur. */
  onerror: ((e: Event) => void) | null;
  terminate(): void;
}
/** Worker du ragdoll (Vite le construit à part) ; null sans Worker (tests, navigateur ancien) ou s'il ne démarre pas. */
export function spawnRagdollWorker(): RagdollPort | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./ragdollWorker.ts", import.meta.url), { type: "module" }) as unknown as RagdollPort;
  } catch {
    return null;
  }
}
/** Écart (s) entre les deux poses du départ : une image du replay à 32 i/s. */
export const START_DT = 1 / 32;
/** Impulsion = force × FORCE_SCALE, dont HIT_PART sur le corps de la zone touchée (banc d'essai, sonde 0.6). */
export const FORCE_SCALE = 1, HIT_PART = 0.3;
/** Déplacement (u) du joueur pendant START_DT au-delà duquel c'est un saut de position (début de round) : vitesse nulle. */
export const TELEPORT_START = 32;
const DEG = Math.PI / 180;

/** Morts d'un replay : celles à calculer et les trajectoires rendues. */
interface Deaths {
  /** Morts pas encore calculées (le premier kill de chaque victime, comme agentPose ; établi une fois par replay). */
  queue: KillEvent[];
  /** Morts sautées faute de modèle ou de clips : version de la bibliothèque de leur dernier essai (réessayées quand elle
   *  change, pas avant). */
  waits: Map<KillEvent, number>;
  /** Trajectoires rendues (null : pas de ragdoll, clip de mort), par victime puis par tick du kill. */
  tracks: Map<string, Map<number, DeathTrack | null>>;
  /** Trajectoires non nulles de `tracks` (`count`, sans parcours). */
  ready: number;
}

export class Ragdolls implements RagdollLookup {
  version = 0;
  private lib: AgentLibrary | null = null;
  private port: RagdollPort | null | undefined;  // undefined : pas encore lancé ; null : aucun, ou en échec (jamais relancé)
  private defSent: RagdollFile | null = null;
  private mapKey = "";
  private mapSent = false;  // une grille est dans le worker (à libérer quand la collision est retirée)
  private deaths = new WeakMap<Replay, Deaths>();
  private pending: { r: Replay; id: number; kill: KillEvent } | null = null;
  private nextId = 0;
  private mapWarned = false;
  private rigs = new Map<string, AgentRig>();  // clones de travail, par fichier de modèle

  constructor(private spawn: () => RagdollPort | null, private onChange: () => void) {}

  /** Fichiers « joueurs » (null : aucun) : trajectoires oubliées (elles dépendent des modèles), compteurs remis à zéro,
   *  calcul en cours abandonné, clones de travail libérés (`lost` : contexte graphique perdu, comme AgentRig.dispose). */
  setLibrary(lib: AgentLibrary | null, lost = false) {
    for (const rig of this.rigs.values()) rig.dispose(lost);
    this.rigs.clear();
    this.deaths = new WeakMap();
    this.pending = null;
    this.defSent = null;
    this.lib = lib;
  }

  /** Collision de la carte affichée (triangles du jeu, collision.ts), envoyée au worker (tampon transféré) ; null : aucune,
   *  la grille gardée par le worker est libérée (sans lancer de worker pour cela). */
  setMap(map: string, tri: Float32Array | null) {
    this.mapKey = tri ? map : "";
    if (!tri) {
      if (this.mapSent && this.port) this.port.postMessage({ type: "unmap" });
      this.mapSent = false;
      return;
    }
    const port = this.portOf();
    if (!port) return;
    port.postMessage({ type: "map", key: map, tri }, [tri.buffer]);
    this.mapSent = true;
  }

  track(r: Replay, sid: string, killTick: number): DeathTrack | null {
    return this.deaths.get(r)?.tracks.get(sid)?.get(killTick) ?? null;
  }

  /** Trajectoires prêtes du replay (attribut `data-ragdolls` de la vue). */
  count(r: Replay): number {
    return this.deaths.get(r)?.ready ?? 0;
  }

  /** À chaque image : si le worker est libre, la mort pas encore calculée la plus proche du tick affiché part (voir
   *  l'en-tête) ; modèle ou clips pas encore là : sautée (la suivante est essayée), réessayée au prochain fichier arrivé. */
  pump(r: Replay, tick: number) {
    const lib = this.lib;
    if (!lib || this.pending || !this.mapKey || r.payload.map_name !== this.mapKey) return;
    const file = lib.ragdoll(), port = file ? this.portOf() : null;
    if (!file || !port) return;
    if (this.defSent !== file) {
      port.postMessage({ type: "def", file });
      this.defSent = file;
    }
    const d = this.deathsOf(r), queue = d.queue, v = lib.version;
    for (;;) {
      let best = -1, bd = Infinity;
      for (let q = 0; q < queue.length; q++) {
        if (d.waits.get(queue[q]) === v) continue;  // en attente d'un fichier : rien de neuf depuis son essai
        const dist = Math.abs(queue[q].tick - tick);
        if (dist < bd) { best = q; bd = dist; }
      }
      if (best < 0) return;
      const kill = queue[best], start = this.startOf(r, kill, lib, file);
      if (start === undefined) { d.waits.set(kill, v); continue; }  // la suivante
      queue.splice(best, 1);
      d.waits.delete(kill);
      if (start === null) { this.store(d, kill, null); return; }  // une seule pose du mourant posée par image
      const id = ++this.nextId;
      this.pending = { r, id, kill };
      port.postMessage({ type: "death", id, key: this.mapKey, start });
      return;
    }
  }

  dispose() {
    this.setLibrary(null);
    this.port?.terminate();
    this.port = null;
  }

  private deathsOf(r: Replay): Deaths {
    let d = this.deaths.get(r);
    if (!d) {
      const seen = new Set<string>();
      const queue = r.payload.kills.filter((k) => !seen.has(k.victim) && !!seen.add(k.victim));  // comme agentPose
      this.deaths.set(r, (d = { queue, waits: new Map(), tracks: new Map(), ready: 0 }));
    }
    return d;
  }

  private store(d: Deaths, k: KillEvent, t: DeathTrack | null) {
    let byTick = d.tracks.get(k.victim);
    if (!byTick) d.tracks.set(k.victim, (byTick = new Map()));
    if (byTick.get(k.tick)) d.ready--;
    byTick.set(k.tick, t);
    if (t) d.ready++;
  }

  private portOf(): RagdollPort | null {
    if (this.port === undefined) {
      this.port = this.spawn();
      if (this.port) {
        this.port.onmessage = this.received;
        this.port.onerror = this.crashed;
      }
    }
    return this.port;
  }

  /** Worker en échec (script introuvable, plantage) : journalisé une fois, arrêté et jamais relancé (`port` à null) ;
   *  le calcul en cours est abandonné, les morts gardent leurs clips. */
  private crashed = (e: Event) => {
    const port = this.port;
    if (!port) return;
    console.warn("Ragdoll : worker en échec, arrêté : morts en clips", e);
    this.port = null;
    this.pending = null;
    this.mapSent = false;
    port.onmessage = port.onerror = null;
    port.terminate();
  };

  private received = (e: MessageEvent<RagdollOut>) => {
    const m = e.data, p = this.pending;
    // collision illisible (id -1, pas de mort associée) : journalisée une fois, sans bloquer ni rejouer en boucle
    if (m.id === -1) {
      if (!this.mapWarned) { this.mapWarned = true; console.warn(`Ragdoll : ${m.why ?? "collision refusée"} : morts en clips`); }
      return;
    }
    if (!p || m.id !== p.id) return;  // réponse d'un calcul abandonné (autre bibliothèque, worker en échec)
    this.pending = null;
    const d = this.deaths.get(p.r);
    if (d) this.store(d, p.kill, m.track ? { ...m.track, bones: this.defSent?.bones ?? [] } : null);
    // temps de calcul (dans le worker) relevé par l'essai réel ; niveau « Verbose » de la console
    console.debug(`Ragdoll : mort ${p.kill.victim}:${p.kill.tick} calculée en ${m.ms.toFixed(0)} ms${m.why ? `, sans trajectoire (${m.why}) : clip de mort` : ""}`);
    this.version++;
    this.onChange();
  };

  private rigOf(model: AgentModel, side: "CT" | "T"): AgentRig {
    let rig = this.rigs.get(model.file);
    if (!rig) this.rigs.set(model.file, (rig = new AgentRig(model.root, side, model.file)));
    return rig;
  }

  /** État de départ d'une mort (voir l'en-tête) ; undefined : modèle ou clips pas encore là ; null : pas de ragdoll pour
   *  elle (victime absente du replay, os du ragdoll absents de son modèle). */
  private startOf(r: Replay, k: KillEvent, lib: AgentLibrary, file: RagdollFile): RagdollStart | null | undefined {
    const pl = r.players.find((p) => p.steamid === k.victim);
    if (!pl) return null;
    const model = lib.model(pl.side, r.agentOf(pl.index));
    if (!model) return undefined;
    const p1 = dyingPose(r, k.tick, k.victim, k, lib.duration), p0 = dyingPose(r, k.tick - START_DT * r.tickrate, k.victim, k, lib.duration);
    if (!p1?.body || !p0?.body) return undefined;
    const rig = this.rigOf(model, pl.side), clipOf = (set: Parameters<AgentLibrary["clip"]>[1], name: string) => lib.clip(model, set, name);
    let dx = p1.body.x - p0.body.x, dy = p1.body.y - p0.body.y, dz = p1.body.z - p0.body.z;
    if (Math.hypot(dx, dy, dz) > TELEPORT_START) dx = dy = dz = 0;
    const [vx, vy, vz] = k.victim_pos, n = file.bones.length, A = new Float64Array(7 * n), B = new Float64Array(7 * n);
    const put = (at: AgentBody) => { rig.group.position.set(at.x, at.y, at.z); rig.group.rotation.set(0, 0, at.yaw * DEG); };
    put({ x: vx - dx, y: vy - dy, z: vz - dz, yaw: p0.body.yaw });
    rig.apply(p0, clipOf);
    if (!rig.boneStates(file.bones, A)) return null;
    put({ x: vx, y: vy, z: vz, yaw: p1.body.yaw });
    rig.apply(p1, clipOf);
    rig.boneStates(file.bones, B);
    const s: RagdollStart = { p: new Float64Array(3 * n), q: new Float64Array(4 * n), v: new Float64Array(3 * n), w: new Float64Array(3 * n) };
    for (let i = 0; i < n; i++) {
      const o = 7 * i;
      for (let c = 0; c < 3; c++) { s.p[3 * i + c] = B[o + c]; s.v[3 * i + c] = (B[o + c] - A[o + c]) / START_DT; }
      for (let c = 0; c < 4; c++) s.q[4 * i + c] = B[o + 3 + c];
      // vitesse angulaire : 2 (qB · conj(qA)).xyz / dt, signe de la plus courte rotation
      const bx = B[o + 3], by = B[o + 4], bz = B[o + 5], bw = B[o + 6], ax = -A[o + 3], ay = -A[o + 4], az = -A[o + 5], aw = A[o + 6];
      let wx = bw * ax + bx * aw + by * az - bz * ay, wy = bw * ay - bx * az + by * aw + bz * ax, wz = bw * az + bx * ay - by * ax + bz * aw;
      if (bw * aw - bx * ax - by * ay - bz * az < 0) { wx = -wx; wy = -wy; wz = -wz; }
      s.w[3 * i] = (2 * wx) / START_DT; s.w[3 * i + 1] = (2 * wy) / START_DT; s.w[3 * i + 2] = (2 * wz) / START_DT;
    }
    // impulsion : HIT_PART sur le corps de la zone touchée (s'il est dans le ragdoll), le reste sur tout le corps
    const { f, zone } = deathForce(r, k), masses = file.parts.map((p) => p.mass), M = masses.reduce((a, b) => a + b, 0);
    const want = (HIT_BODY[zone] ?? HIT_BODY.generic).toLowerCase(), hit = file.bones.findIndex((b) => b.toLowerCase() === want);
    const part = hit >= 0 ? HIT_PART : 0;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) s.v[3 * i + c] += (f[c] * FORCE_SCALE * (1 - part)) / M;
    if (hit >= 0) for (let c = 0; c < 3; c++) s.v[3 * hit + c] += (f[c] * FORCE_SCALE * part) / masses[hit];
    // bornée comme dans le solveur (il ne la borne qu'après son premier sous-pas)
    for (let i = 0; i < n; i++) {
      const sp = Math.hypot(s.v[3 * i], s.v[3 * i + 1], s.v[3 * i + 2]);
      if (sp > MAX_V) for (let c = 0; c < 3; c++) s.v[3 * i + c] *= MAX_V / sp;
    }
    return s;
  }
}
