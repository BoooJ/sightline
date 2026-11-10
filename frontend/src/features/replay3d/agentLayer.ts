/**
 * Joueurs en modèles d'agents (fichiers « joueurs ») : un AgentRig par joueur, posé d'après le replay (agentPose), corps
 * des morts au sol, armes lâchées au sol. Pas d'anneau d'équipe sous les pieds (décision de l'utilisateur du 05/11/2026) :
 * le joueur choisi se repère à son étiquette, écrite à la couleur d'accent (players.ts). La couche des joueurs garde
 * étiquettes, regards, halos et clic ; la silhouette d'un joueur dessiné ici y est cachée (PlayerLayer.setModelled) et
 * sert encore au clic.
 *
 * CONTRAT (consommé par viewer.ts) :
 *   update(états, caché) à chaque instant affiché, comme PlayerLayer (`caché` : joueur dont on prend la vue, jamais
 *     dessiné) ; un joueur absent des états (autre round) est retiré ; les armes des inventaires sont demandées d'avance.
 *   animate(replay, tick, caméra, image) juste avant chaque rendu : pose et place les modèles ; rend les joueurs dessinés
 *     en modèle (vivants et corps) dans un ensemble GARDÉ par la couche et réécrit à l'appel suivant (à copier pour le
 *     garder : PlayerLayer.setModelled le copie) ; `image` : numéro d'image (alternance des joueurs lointains).
 *   deferred : vrai après un `animate` qui a laissé des joueurs lointains pour l'image suivante ; le Viewer doit alors en
 *     dessiner une autre, sans quoi, à l'arrêt, ils garderaient la pose de l'instant d'avant.
 *   setLibrary(bibliothèque | null, perdu = false), dispose(perdu = false) : modèles et armes au sol retirés ; `perdu` :
 *     contexte graphique perdu depuis les rendus (MEM3D) : aucun appel à la carte graphique, images encore gardées fermées
 *     (AgentRig.dispose(true), freeImages), la bibliothèque est alors libérée de même (AgentLibrary.dispose(true)).
 * Sans bibliothèque, ou tant que le modèle du camp ou les clips d'un joueur manquent (agentPose null) : rien pour lui, sa
 * silhouette reste.
 * Morts en ragdoll (`setRagdolls`, ragdolls.ts) : agentPose reçoit les trajectoires prêtes ; l'arrivée d'une trajectoire
 * (`version` des trajectoires) refait les poses comme l'arrivée d'un fichier ; un corps en ragdoll est « fini » à la fin de
 * sa trajectoire (plus de pose refaite jusqu'à la fin du round), comme un clip de mort tenu sur sa dernière image.
 *
 * Images par seconde (PC de l'équipe, puce graphique intégrée, 10 joueurs) :
 *  - la pose de l'instant (agentPose) n'est calculée que pour un joueur posé à cette image, et une fois pour un joueur
 *    pas encore vu avec ces fichiers et ce replay (dessiné en modèle ou non) ou pour un mort dont le corps n'est pas encore
 *    connu (sa place, l'arme au sol) ; un joueur qui n'est pas posé garde l'état et la pose de sa dernière évaluation, et
 *    sa place suit celle des états (ou de son corps déjà connu) ;
 *  - même instant (même replay, même tick, mêmes fichiers) : ni agentPose ni pose refaits (caméra qui bouge à l'arrêt) ;
 *  - hors du champ de la caméra (sphère de découpage du corps, celle que three teste) : pas reposé, mais sa place suit
 *    (three le découpe là où il est) ; il est posé dès qu'il entre dans le champ, avant le rendu ;
 *  - au loin : reposé une image sur deux (les joueurs d'indice pair et impair en alternance). Au loin = plus petit à
 *    l'écran qu'à FAR unités dans la perspective de 70° des autres caméras : la distance est rapportée au champ de la
 *    caméra (en lunette, bien plus loin) ; en vue de dessus, c'est son zoom qui compte ;
 *  - corps au sol : une fois son clip de mort fini, la pose ne change plus jusqu'à la fin du round (agentPose : clip tenu
 *    sur sa dernière image, corps à la position de la mort) : ni agentPose ni pose refaits pour les ticks suivants.
 *  Sans allocation à chaque image, hors agentPose (2.1 : une pose neuve à chaque appel, son calcul n'alloue rien ;
 *  appelée seulement pour les joueurs posés, voir plus haut) et la clé de pose (`AgentRig.posed`, une chaîne par instant
 *  posé) : l'ensemble rendu est mis à jour en place (ajout ou retrait d'un joueur seulement quand il change), modèles
 *  des camps et agents équipés (AgentLibrary.model : nom de fichier et validation mémorisés, aucune expression régulière ni
 *  chaîne refaite) et clips gardés (pas de clé de clip refaite à chaque image), armes des inventaires
 *  demandées une fois par nom.
 * Arme au sol (droppedWeapons, une par mort, identifiée par sa victime) : couchée sur le flanc, canon dans la direction de
 * son lacet, à la place de 2.1 (devant et à droite du point de mort, au sol). Elle ne suit pas le corps : dans le jeu,
 * l'arme tombe de la main près du point de mort, le corps recule (essai réel du 06/11/2026 : médiane à 10 u devant et
 * 4 u à droite du point de mort, corps 1 à 1,7 m plus loin) ; la placer d'après le bassin la posait sur les jambes.
 */
import { type AnimationClip, type Camera, Frustum, Group, Matrix4, type Object3D, type OrthographicCamera,
  type PerspectiveCamera, Quaternion, type SkinnedMesh, Sphere, Vector3 } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Side } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import type { PlayerState } from "../replay/engine/state";
import { type AgentBody, type AgentPose, agentPose, ANIM_SETS, type AnimSet, type DroppedWeapon, type RagdollLookup,
  droppedWeapons } from "./agentAnim";
import { AgentRig, BODY_SPHERE, disposeSkeletons, MODEL_TO_GAME, WEAPON_SPHERE } from "./agentRig";
import type { AgentLibrary, AgentModel } from "./agents";
import { freeImages } from "./dispose";
import { PERSP_FOV } from "./rig";
import { SRC_TO_GLTF } from "./viewmodel";
import { weaponKey } from "./viewmodelAnim";

/** Agent équipé par le joueur `sid` dans ce replay (null : celui du camp). */
const agentOf = (r: Replay, sid: string) => {
  const ps = r.players;
  for (let i = 0; i < ps.length; i++) if (ps[i].steamid === sid) return r.agentOf(ps[i].index);
  return null;
};

/** Distance (unités) au-delà de laquelle un joueur n'est reposé qu'une image sur deux, dans la perspective de PERSP_FOV
 *  degrés ; pour un autre champ, la distance où il paraît aussi petit (voir l'en-tête). */
export const FAR = 2500;
const DEG = Math.PI / 180;
/** Hauteur de vue (unités) à FAR dans la perspective de référence : au-delà, un joueur est au loin. */
const FAR_SPAN = 2 * Math.tan((PERSP_FOV / 2) * DEG) * FAR;
/** Mètres (fichiers) → unités du jeu. */
const TO_UNITS = MODEL_TO_GAME.getMaxScaleOnAxis();
/** Sphère de découpage du corps dans le repère du joueur (BODY_SPHERE ramenée au jeu : celle que three teste). */
const BODY_C = BODY_SPHERE.center.clone().applyMatrix4(MODEL_TO_GAME), BODY_R = BODY_SPHERE.radius * TO_UNITS;
/** Arme au sol, dans les axes Source de son os racine (canon +X, dessus +Z ; ceux du jeu) : couchée sur le flanc
 *  (rotation de 90° autour du canon), soulevée de 2 cm (son épaisseur, à peu près). */
const FLANK = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2), FLANK_LIFT = 0.02;
const M = new Matrix4(), EYE = new Vector3(), SPHERE = new Sphere();
/** Un joueur à sa place : hors du champ, au loin et laissé pour l'image suivante, ou à poser (AgentLayer.due). */
const OUT = 0, WAIT = 1, NOW = 2;

/** Un joueur dessiné en modèle. `clipOf` : AgentLibrary.clip gardé par jeu et par nom (sa clé texte n'est faite qu'au
 *  premier appel ; un clip rendu reste le même pour la vie du modèle). `pose` : sa pose de la dernière évaluation, null :
 *  rien à poser ; `fresh` : évaluée pour l'instant `seen` (numéro d'instant, AgentLayer.epoch) ; `evalBase` : évalué au
 *  moins une fois pour ces fichiers et ce replay (AgentLayer.base) ; `posedPose` : la pose posée sur le modèle (la même :
 *  rien à refaire) ; `still` : tick à partir duquel `pose` ne change plus (corps au sol), pour `stillBase` ; `body` : corps
 *  d'un mort (`bodyBase`), place prévue tant qu'il n'est pas reposé. */
interface Slot {
  rig: AgentRig;
  clipOf: (set: AnimSet, name: string) => AnimationClip | null;
  drawn: boolean;  // dans l'ensemble rendu
  seen: number;
  pose: AgentPose | null;
  fresh: boolean;
  evalBase: number;
  posedPose: AgentPose | null;
  still: number;
  stillBase: number;
  body: AgentBody | null;
  bodyBase: number;
}

export class AgentLayer {
  readonly group = new Group();
  /** Voir l'en-tête (contrat). */
  deferred = false;
  private lib: AgentLibrary | null = null;
  private rag: (RagdollLookup & { readonly version: number }) | null = null;
  private ragVersion = 0;
  private slots = new Map<string, Slot>();
  private dropped = new Map<string, Group>();  // armes au sol, par victime (DroppedWeapon.victim)
  private states: PlayerState[] = [];
  private hidden: string | null = null;
  private shown = new Set<string>();
  private asked: Record<Side, Set<string>> = { CT: new Set(), T: new Set() };  // armes des inventaires déjà demandées
  // instant posé : replay, tick et version des fichiers ; `epoch` change avec l'un des trois, `base` avec le replay ou
  // les fichiers (corps au sol, déplacement des bassins : à refaire)
  private r: Replay | null = null;
  private tick = NaN;
  private version = -1;
  private epoch = 0;
  private base = 0;
  private key = "";  // clé de pose de l'instant (`AgentRig.posed`), faite à la première pose de l'instant
  private keyEpoch = -1;
  private frustum = new Frustum();
  private aboveZ = Infinity;  // coupe « au-dessus de » de la vue de dessus (Infinity : aucune)
  private farDist = Infinity;  // distance à la caméra au-delà de laquelle un joueur est au loin, pour l'image en cours

  /** Fichiers « joueurs » (null : aucun) ; les modèles et armes au sol en place sont retirés (`lost` : contexte graphique
   *  perdu, voir l'en-tête) ; modèles des camps et jeux de clips demandés. */
  setLibrary(lib: AgentLibrary | null, lost = false) {
    for (const [sid, s] of this.slots) this.dropSlot(sid, s, lost);
    this.clearDrops(lost);
    this.shown.clear();
    this.lib = lib;
    if (lib) lib.inUse = this.modelInUse;  // plafond des agents équipés gardés : jamais un modèle encore posé sur un joueur
    this.r = null;  // le replay n'est plus retenu par la couche
    this.asked = { CT: new Set(), T: new Set() };
    lib?.preload(["CT", "T"], ANIM_SETS);
  }

  /** Hauteur de la coupe « au-dessus de » (Infinity : aucune), posée avant chaque image, appliquée par `animate` : comme les
   *  croix que les corps remplacent, un corps et l'arme au sol plus hauts que la coupe sont cachés en entier (une carte
   *  coupée laisserait flotter le repère de mort d'un autre étage). Les vivants ne sont jamais coupés. */
  cutAbove(z: number) {
    this.aboveZ = z;
  }

  /** Trajectoires des morts (ragdolls.ts) ; null : aucune, clips de mort. */
  setRagdolls(rag: (RagdollLookup & { readonly version: number }) | null) {
    this.rag = rag;
  }

  /** États des joueurs à l'instant affiché (positions interpolées) et joueur caché (vue du joueur). */
  update(states: PlayerState[], hidden: string | null) {
    this.states = states;
    this.hidden = hidden;
    this.slots.forEach(this.prune);
    const lib = this.lib;
    if (!lib) return;
    for (let k = 0; k < states.length; k++) {
      const p = states[k], inv = p.inventory, asked = this.asked[p.side];
      for (let w = 0; w < inv.length; w++) {
        if (asked.has(inv[w])) continue;
        asked.add(inv[w]);
        const key = weaponKey(inv[w], p.side);
        if (key) lib.weapon(key);
      }
    }
  }

  private modelInUse = (file: string) => {
    for (const s of this.slots.values()) if (s.rig.file === file) return true;
    return false;
  };

  /** Joueur absent des états (autre round) : retiré (forEach : sans allocation). */
  private prune = (s: Slot, sid: string) => {
    const states = this.states;
    for (let k = 0; k < states.length; k++) if (states[k].steamid === sid) return;
    this.dropSlot(sid, s);
  };

  /** Pose et place les modèles pour l'image (voir l'en-tête). */
  animate(r: Replay, tick: number, cam: Camera, frame: number): ReadonlySet<string> {
    const shown = this.shown, lib = this.lib;
    this.deferred = false;
    if (!lib) return shown;
    const rv = this.rag?.version ?? 0;
    if (r !== this.r || lib.version !== this.version || rv !== this.ragVersion) {
      if (r !== this.r) this.clearDrops(false);
      this.r = r;
      this.version = lib.version;
      this.ragVersion = rv;
      this.base++;
      this.epoch++;
      this.tick = tick;
    } else if (tick !== this.tick) {
      this.tick = tick;
      this.epoch++;
    }
    this.view(cam);
    const states = this.states;
    for (let k = 0; k < states.length; k++) this.place(r, tick, states[k], k, frame, lib);
    this.drops(r, tick, lib);
    return shown;
  }

  /** Modèle posé d'un joueur (tests, mesures), ou undefined. */
  rig(sid: string): AgentRig | undefined { return this.slots.get(sid)?.rig; }

  dispose(lost = false) {
    this.setLibrary(null, lost);
  }

  /** Champ de la caméra et distance « au loin » de l'image (voir l'en-tête). */
  private view(cam: Camera) {
    cam.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(M.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    EYE.setFromMatrixPosition(cam.matrixWorld);
    const c = cam as PerspectiveCamera & OrthographicCamera;
    this.farDist = c.isOrthographicCamera ? ((c.top - c.bottom) / c.zoom > FAR_SPAN ? 0 : Infinity)
      : (FAR_SPAN * c.zoom) / (2 * Math.tan((c.fov / 2) * DEG));
  }

  /** Un joueur pour l'image : pose de l'instant évaluée et posée s'il est dans le champ et pas laissé pour l'image
   *  suivante ; évaluée seule (pas posée) s'il n'est pas encore connu ; sinon rien que sa place (voir l'en-tête). */
  private place(r: Replay, tick: number, p: PlayerState, k: number, frame: number, lib: AgentLibrary) {
    const sid = p.steamid;
    let s = this.slots.get(sid);
    if (sid === this.hidden) {
      if (s) { s.rig.group.visible = false; this.draw(s, sid, false); }
      return;
    }
    // agent équipé, sinon celui du camp (affiché d'abord, remplacé à l'arrivée de l'agent : le joueur est recréé) ; demandé
    // à chaque image tant qu'il manque (nouvel essai après un échec)
    const model = lib.model(p.side, agentOf(r, sid));
    if (s && s.rig.file !== model?.file) { this.dropSlot(sid, s); s = undefined; }  // autre camp ou autre agent (autre modèle)
    if (!model) return;
    s ??= this.makeSlot(sid, p.side, model, lib);
    const g = s.rig.group;
    if (s.seen !== this.epoch) {
      s.seen = this.epoch;
      // corps au sol fini : même pose qu'à la dernière évaluation ; sinon pose de l'instant pas encore évaluée
      s.fresh = s.stillBase === this.base && tick >= s.still;
      // place : celle de la pose à jour ; sinon celle des états, ou du corps déjà connu d'un mort
      this.put(g, s.fresh ? s.pose?.body ?? p : !p.alive && s.bodyBase === this.base ? s.body! : p);
    }
    if (!s.fresh) {
      const due = s.evalBase === this.base && (p.alive || s.bodyBase === this.base) ? this.due(s, k, frame) : NOW;
      if (due === NOW) this.evaluate(s, r, tick, p, lib);
      else if (due === WAIT) this.deferred = true;
    }
    const pose = s.pose;
    if (!pose) {
      g.visible = false;
      this.draw(s, sid, false);
      return;
    }
    g.visible = p.alive || g.position.z <= this.aboveZ;
    this.draw(s, sid, true);
    if (!s.fresh || s.posedPose === pose) return;
    const due = this.due(s, k, frame);  // la pose a pu changer la place (corps)
    if (due !== NOW) {
      if (due === WAIT) this.deferred = true;
      return;
    }
    s.rig.setWeapon(pose.weapon, pose.weapon ? lib.weapon(pose.weapon) : null);
    s.rig.apply(pose, s.clipOf);
    s.rig.setKit(p.alive && p.defuser);
    if (this.keyEpoch !== this.epoch) {
      this.keyEpoch = this.epoch;
      this.key = `${tick}|${this.version}|${this.ragVersion}`;
    }
    s.rig.posed = this.key;
    s.posedPose = pose;
  }

  /** Pose de l'instant (agentPose) : place, corps fini, corps gardé pour la place prévue. */
  private evaluate(s: Slot, r: Replay, tick: number, p: PlayerState, lib: AgentLibrary) {
    const pose = s.pose = agentPose(r, tick, p.steamid, lib.duration, this.rag), body = pose?.body ?? null;
    s.fresh = true;
    s.evalBase = s.stillBase = this.base;
    s.still = this.settled(pose, lib) ? tick : Infinity;
    if (body) { s.body = body; s.bodyBase = this.base; }
    this.put(s.rig.group, body ?? p);  // corps au sol, sinon la position interpolée des états
  }

  /** Joueur à sa place (sphère de découpage du corps) : hors du champ, au loin et laissé pour l'image suivante (un joueur
   *  d'indice pair une image sur deux, impair l'autre ; jamais un joueur pas encore posé), ou à poser. */
  private due(s: Slot, k: number, frame: number): number {
    SPHERE.center.copy(s.rig.group.position).add(BODY_C);
    SPHERE.radius = BODY_R;
    if (!this.frustum.intersectsSphere(SPHERE)) return OUT;
    const far = SPHERE.center.distanceToSquared(EYE) > this.farDist * this.farDist;
    return s.posedPose && (frame + k) % 2 === 1 && far ? WAIT : NOW;
  }

  private put(g: Group, at: { x: number; y: number; z: number; yaw: number }) {
    g.position.set(at.x, at.y, at.z);
    g.rotation.set(0, 0, at.yaw * DEG);
  }

  /** Vrai si la pose d'un corps ne changera plus aux ticks suivants : trajectoire du ragdoll finie, ou son clip de mort
   *  seul, à sa dernière image. */
  private settled(pose: AgentPose | null, lib: AgentLibrary): boolean {
    if (pose?.ragdoll) return pose.ragdoll.t >= (pose.ragdoll.track.frames - 1) * pose.ragdoll.track.dt;
    if (!pose?.body || pose.layers.length !== 1) return false;
    const l = pose.layers[0];
    return l.t >= (lib.duration(l.set, l.clip) ?? Infinity);
  }

  private makeSlot(sid: string, side: Side, model: AgentModel, lib: AgentLibrary): Slot {
    const rig = new AgentRig(model.root, side, model.file);
    const clips = new Map<AnimSet, Map<string, AnimationClip>>();
    const clipOf = (set: AnimSet, name: string) => {
      let bySet = clips.get(set);
      const known = bySet?.get(name);
      if (known) return known;
      const c = lib.clip(model, set, name);
      if (c) {
        if (!bySet) clips.set(set, (bySet = new Map()));
        bySet.set(name, c);
      }
      return c;
    };
    const s: Slot = { rig, clipOf, drawn: false, seen: -1, pose: null, fresh: false, evalBase: -1, posedPose: null,
      still: Infinity, stillBase: -1, body: null, bodyBase: -1 };
    this.slots.set(sid, s);
    this.group.add(rig.group);
    return s;
  }

  /** Joueur retiré : libéré, ou, contexte perdu, sans appel à la carte graphique (AgentRig.dispose). */
  private dropSlot(sid: string, s: Slot, lost = false) {
    s.rig.dispose(lost);
    this.slots.delete(sid);
    this.shown.delete(sid);
  }

  /** Joueur entré dans l'ensemble rendu ou sorti : l'ensemble n'est touché qu'à un changement (le vider et le remplir à
   *  chaque image réalloue sa table). */
  private draw(s: Slot, sid: string, on: boolean) {
    if (s.drawn === on) return;
    s.drawn = on;
    if (on) this.shown.add(sid);
    else this.shown.delete(sid);
  }

  /** Armes au sol à l'instant : ajoutées quand leur modèle est là, retirées une fois ramassées ou avant la mort. */
  private drops(r: Replay, tick: number, lib: AgentLibrary) {
    const list = droppedWeapons(r);
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      let drop = this.dropped.get(d.victim);
      if (tick < d.from || tick >= d.until) {
        if (drop) this.removeDrop(d.victim, drop, false);
        continue;
      }
      if (drop) { drop.visible = d.z <= this.aboveZ; continue; }
      const model = lib.weapon(d.key);
      if (model) {
        drop = this.makeDrop(model, d);
        drop.visible = d.z <= this.aboveZ;
        this.dropped.set(d.victim, drop);
      }
    }
  }

  /** Arme au sol : repère du jeu (position, lacet ; mètres → unités) → couchée sur le flanc → support (annule la rotation
   *  des axes Source de l'os racine « weapon » : ses axes deviennent ceux du jeu) → clone. Pas de MODEL_TO_GAME ici : il
   *  ramène les axes du glTF à ceux du jeu, et ceux de l'arme, sous son support, sont déjà ceux de Source (sous lui, l'arme
   *  aurait le canon à la verticale). */
  private makeDrop(model: Object3D, d: DroppedWeapon): Group {
    const g = new Group(), flank = new Group(), support = new Group(), w = cloneSkinned(model);
    g.position.set(d.x, d.y, d.z);
    g.rotation.z = d.yaw * DEG;
    g.scale.setScalar(TO_UNITS);
    flank.quaternion.copy(FLANK);
    flank.position.z = FLANK_LIFT;
    support.quaternion.copy(SRC_TO_GLTF).invert();
    w.traverse((o) => { if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).boundingSphere = WEAPON_SPHERE.clone(); });
    g.add(flank.add(support.add(w)));
    this.group.add(g);
    return g;
  }

  /** Arme au sol retirée : squelette de son clone libéré, ou, contexte perdu, ses images encore gardées seules. */
  private removeDrop(victim: string, drop: Group, lost: boolean) {
    drop.removeFromParent();
    if (lost) freeImages(drop);
    else disposeSkeletons(drop);
    this.dropped.delete(victim);
  }

  private clearDrops(lost: boolean) {
    for (const [victim, drop] of this.dropped) this.removeDrop(victim, drop, lost);
  }
}
