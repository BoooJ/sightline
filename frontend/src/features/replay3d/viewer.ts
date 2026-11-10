import { Box3, type Camera, Color, DirectionalLight, HemisphereLight, type Material, Matrix4, type Object3D, Plane, Raycaster,
  Scene, Vector2, Vector3, WebGLRenderer } from "three";
import type { KillEvent } from "../../shared/api/types";
import { sampleIndex } from "../replay/engine/interp";
import type { Replay } from "../replay/engine/replay";
import { bombStateAt, deathsUntil, playerStateAt, type PlayerState } from "../replay/engine/state";
import type { Theme } from "../replay/renderer/theme";
import { warmAgentAnim } from "./agentAnim";
import { AgentLayer } from "./agentLayer";
import { AgentLibrary, type AgentLoad } from "./agents";
import { type Board, boardKey, povBoard } from "./board";
import { type Cutaway, grounded, JUMP_S, NO_PUNCH, playZone, type Punch, tvTarget, type TvShot } from "./cameras";
import { disposeTree, freeImages, freeImagesAfterUpload, imagesFreed } from "./dispose";
import { veilOpacity } from "./flash";
import { BombMarker, NadeLayer } from "./nadeLayer";
import { PlayerLayer, tagPx, unitsPerPx } from "./players";
import { type RagdollPort, Ragdolls, spawnRagdollWorker } from "./ragdolls";
import { CameraRig } from "./rig";
import { adaptSourceMaterials } from "./sourceMaterials";
import type { CameraMode } from "./types";
import { type VmLoad, ViewModel, vmLighting, vmView } from "./viewmodel";
import { viewmodelPose } from "./viewmodelAnim";
import { invertAffine } from "./world";

/** Ciel de la vue du joueur : bleu ciel très clair, échantillonné sur des captures (moyenne du haut du ciel de
 *  Dust2, rgb(196, 244, 253) ; plus blanc près de l'horizon) ; les autres caméras gardent le fond du thème. */
export const POV_SKY = "#c4f4fd";

/** Reprises des bras après une erreur de la 2e passe, par chargeur de fichiers « vue » : une à chaque entrée en vue du
 *  joueur, puis la vue reste sans bras jusqu'à d'autres fichiers. */
export const VM_RETRIES = 3;

/** Aucun joueur dessiné en modèle d'agent (pas de fichiers « joueurs », ou modèles retirés après une erreur). */
const NO_AGENTS: ReadonlySet<string> = new Set();

/** Libère géométries, matériaux et textures d'un arbre three.js : celui de `dispose.ts`, partagé avec les bras de la vue du
 *  joueur, réexporté pour les importeurs de ce fichier. */
export { disposeTree } from "./dispose";

export const cutUniforms = () => ({ uCutFrom: { value: new Vector3() }, uCutTo: { value: new Vector3() }, uCutR: { value: 0 },
  uCutFloorZ: { value: -1e9 }, uCutAboveZ: { value: 1e9 } });
type CutUniforms = ReturnType<typeof cutUniforms>;

/** Fait respecter la coupe (`Cutaway` : cylindre et « au-dessus de ») aux matériaux de la carte : leurs fragments
 *  concernés sont jetés (grenades, croix et bombe : voir `abovePlanes` ; joueurs : jamais coupés). Uniformes partagés :
 *  un seul jeu de valeurs pour toute la carte, mis à jour avant chaque rendu, sans recompiler les shaders au changement
 *  de caméra. Réservé aux matériaux de la carte : les chaînes remplacées n'existent pas dans tous les shaders. Porte
 *  aussi la couleur neutre des mélanges par multiplication du jeu (`SL_BLEND_NEUTRAL`, voir `sourceMaterials.ts`). */
export function applyCutaway(root: Object3D, u: CutUniforms) {
  root.traverse((o) => {
    const m = (o as Object3D & { material?: Material | Material[] }).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, u);
        sh.vertexShader = sh.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vCutPos;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvCutPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        sh.fragmentShader = sh.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vCutPos;\nuniform vec3 uCutFrom, uCutTo;\nuniform float uCutR, uCutFloorZ, uCutAboveZ;")
          .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
if (vCutPos.z > uCutAboveZ) discard;
if (uCutR > 0.0 && vCutPos.z > uCutFloorZ) {
  vec3 ab = uCutTo - uCutFrom;
  float t = clamp(dot(vCutPos - uCutFrom, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
  if (distance(vCutPos, uCutFrom + ab * t) < uCutR) discard;
}`)
          // après l'encodage sRGB : le mélange se fait sur les valeurs écrites dans l'image
          .replace("#include <colorspace_fragment>", `#include <colorspace_fragment>
#ifdef SL_BLEND_NEUTRAL
gl_FragColor.rgb = mix(vec3(SL_BLEND_NEUTRAL), gl_FragColor.rgb, gl_FragColor.a);
#endif`);
      };
    }
  });
}

/** Coupe « au-dessus de » des trajectoires des grenades et des croix de mort (lignes et plats : rien ne s'y voit
 *  creux) : plan de découpe local de three (`clippingPlanes` de leurs matériaux, `renderer.localClippingEnabled`), le
 *  même pour tous. Il garde ce qui est à z ≤ sa constante et reste en place hors de la vue de dessus, rejeté au loin :
 *  le nombre de plans ne change jamais, pas de recompilation. Volumes des grenades et bombe : cachés en entier
 *  (`cutAbove`), comme les corps et armes au sol des modèles d'agents. Joueurs vivants et étiquettes : jamais coupés. */
export const abovePlanes = () => [new Plane(new Vector3(0, 0, -1), 1e9)];

/** Pose la coupe de la pose courante : uniformes de la carte et plan des trajectoires et croix (`abovePlanes`). */
export function setCut(u: CutUniforms, above: Plane[], c: Cutaway) {
  u.uCutFrom.value.set(...c.from);
  u.uCutTo.value.set(...c.to);
  u.uCutR.value = c.radius;
  u.uCutFloorZ.value = Math.max(c.floorZ, -1e9);
  u.uCutAboveZ.value = Math.min(c.aboveZ, 1e9);
  above[0].constant = u.uCutAboveZ.value;
}

/** Éclairage (l'export n'en a pas) : ciel + soleil. La scène a Z vers le haut, three place le ciel de la lumière
 *  hémisphérique en +Y par défaut : on le remet en +Z. Sols sous le ciel, murs à mi-chemin, plafonds dans la teinte du
 *  sol. Les bras de la vue du joueur reprennent les deux (`vmLighting`). */
export function sceneLights(): [HemisphereLight, DirectionalLight] {
  const hemi = new HemisphereLight(0xffffff, 0x8a9099, 1.1);
  hemi.position.set(0, 0, 1);
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.4, 0.3, 1);
  return [hemi, sun];
}

/** Contexte WebGL perdu (pilote réinitialisé, mémoire graphique pleine) : on demande au navigateur de le rendre, puis
 *  on redessine ; s'il ne revient pas dans le délai, `onGiveUp` (retour au radar 2D). Renvoie de quoi arrêter l'écoute. */
export function watchContext(canvas: HTMLCanvasElement, onGiveUp: () => void, onRestored: () => void, wait = 3000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = (e: Event) => { e.preventDefault(); clearTimeout(timer); timer = setTimeout(onGiveUp, wait); };
  const restored = () => { clearTimeout(timer); onRestored(); };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  return () => {
    clearTimeout(timer);
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
  };
}

/** Ce que montre le HUD de la vue du joueur (joueur, vie, armure, kit, argent, arme, munitions, lunette, inventaire,
 *  bombe, réticule) : `onFollow` n'est appelé que si cela change, pas à chaque image (position et regard n'y sont pas).
 *  "" : personne. */
export function followKey(p: PlayerState | null): string {
  if (!p) return "";
  return [p.steamid, p.name, p.side, p.slot, p.alive, p.hp, p.armor, p.helmet, p.defuser, p.hasBomb, p.money, p.weapon,
    p.clip, p.reserve, p.scoped, p.zoom, p.crosshair, p.inventory.join(",")].join("|");
}

/** Scène 3D du replay (unités du jeu, Z vers le haut) : carte, joueurs (silhouettes, ou modèles d'agents avec les fichiers
 *  « joueurs »), utilitaires, bombe, caméras. Ne redessine que si quelque chose change (instant, sélection, caméra,
 *  taille, fichier arrivé) ou tant que la caméra libre se déplace, plus une image pour les joueurs lointains laissés à
 *  l'image suivante (AgentLayer.deferred). */
export class Viewer {
  readonly rig: CameraRig;
  /** Joueur suivi, ou ce qu'en montre le HUD, changé (voir `followKey`) ; appelé depuis la boucle de dessin. */
  onFollow?: (p: PlayerState | null) => void;
  /** Barre de score et fil des kills de la vue du joueur changés (voir `boardKey`) ; calculés en vue du joueur
   *  seulement, au plus une fois par instant affiché ; appelé depuis la boucle de dessin. */
  onBoard?: (b: Board) => void;
  /** Opacité (0 à 1) du voile blanc des flashs du joueur suivi, en vue du joueur seulement (0 ailleurs) : appelé quand elle
   *  change, pas à chaque image (palier, puis fondu) ; depuis la boucle de dessin. */
  onFlash?: (opacity: number) => void;
  /** Bras dessinés ou non à la dernière image (attribut `data-arms` de la vue) : appelé quand cela change, pas à chaque
   *  image ; depuis la boucle de dessin. */
  onArms?: (shown: boolean) => void;
  /** Fichier « vue » en échec (401, 404 après un nouvel export…) : la vue du joueur reste sans bras ; de quoi relire la
   *  liste des fichiers. Jamais `onFail`, réservé à la perte de la 3D. */
  onVmError?: (name: string, err: unknown) => void;
  /** Joueurs dessinés en modèles d'agents ou non (attribut `data-agents` de la vue) : appelé quand cela change, pas à
   *  chaque image ; depuis la boucle de dessin. */
  onAgents?: (shown: boolean) => void;
  /** Fichier « joueurs » en échec (401, 404 après un nouvel export…) : ces joueurs restent en silhouettes ; de quoi relire
   *  la liste des fichiers. Jamais `onFail`. */
  onAgentsError?: (name: string, err: unknown) => void;
  /** Morts du replay affiché dont la trajectoire du ragdoll est prête (attribut `data-ragdolls` de la vue) : appelé quand
   *  ce nombre change ; depuis la boucle de dessin, et 0 dès que les fichiers « joueurs » sont retirés ou remplacés. */
  onRagdolls?: (n: number) => void;
  /** Carte à relire : contexte graphique rendu alors que des images de ses textures avaient été libérées après leur envoi
   *  (`freeImagesAfterUpload`). Elle est cachée (`shown` : null) jusqu'à la suivante (`setMap`). */
  onMapLost?: () => void;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private lights = sceneLights();  // gardées : les bras reprennent leurs couleurs et leurs directions
  private vm: ViewModel | null = null;  // bras et arme de la vue du joueur (fichiers « vue » du serveur)
  private load: VmLoad | null = null;  // chargeur de ces fichiers (setViewmodel), gardé pour une reprise
  private vmRetries = 0;  // reprises déjà faites pour ce chargeur
  private armsShown = false;  // bras dessinés à la dernière image
  private aspect = 1;  // du canvas (caméra des bras)
  private map: Object3D | null = null;
  private mapName = "";
  private lostMap = false;  // carte dessinée dans un contexte perdu depuis, cachée en attendant la suivante (`restored`)
  private players: PlayerLayer;
  private agents = new AgentLayer();  // joueurs en modèles d'agents (fichiers « joueurs » du serveur)
  private agentLib: AgentLibrary | null = null;
  private agentLoad: AgentLoad | null = null;  // chargeur de ces fichiers (setAgents), gardé pour le retour du contexte
  private agentsOn: AgentLibrary | null = null;  // bibliothèque posée sur la couche (en pause : à la reprise, `syncAgents`)
  private warmed: Replay | null = null;  // round déjà préchauffé (warmAgentAnim)
  private ragdolls: Ragdolls;  // morts en ragdoll : départ, worker, trajectoires (ragdolls.ts)
  private ragShown = 0;  // trajectoires prêtes annoncées à `onRagdolls`
  private ragdollsOff = false;  // ragdoll arrêté après une erreur (morts en clips), jusqu'aux prochains fichiers « joueurs »
  private agentsShown = false;  // joueurs dessinés en modèles à la dernière image
  private renderNo = 0;  // images dessinées, image de plus demandée par AgentLayer.deferred comprise
  private nades: NadeLayer;
  private bomb: BombMarker;
  private states: PlayerState[] = [];
  private ground: PlayerState[] = [];
  private replay: Replay | null = null;
  private framedFor = "";  // carte déjà cadrée sur une zone jouable
  private selected: string | null = null;
  private deaths: KillEvent[] = [];
  private hidden: string | null = null;  // joueur dont on prend la vue : caché
  private aids = true;  // aides d'analyse montrées (noms, regards, halos, croix, trajectoires) : pas en vue du joueur
  private bg: Color;    // fond des autres caméras : celui du thème
  private sky = new Color(POV_SKY);
  private followedKey = "";
  private tick = 0;
  private frameNo = 0;    // instants reçus (setFrame)
  private boardFrame = -1;  // instant pour lequel le tableau a été calculé
  private boardSeen = "";
  private veil = 0;  // dernière opacité du voile transmise à `onFlash`
  private tv: TvShot = { sid: null, since: 0 };
  private dirty = true;
  private raf = 0;
  private paused = false;  // vue cachée (replay en 2D) : plus aucune image (`pause`, `resume`)
  private disposed = false;
  private loop: FrameRequestCallback;
  private last = performance.now();
  private ray = new Raycaster();
  private cut = cutUniforms();
  private above = abovePlanes();
  private height: number;  // du canvas, en pixels CSS (taille des étiquettes)
  private unwatch: () => void;

  /** `onFail` : la 3D ne peut plus s'afficher (contexte graphique perdu pour de bon). */
  constructor(canvas: HTMLCanvasElement, private gl: WebGL2RenderingContext, theme: Theme, onFail: (reason: string) => void,
    spawnRagdoll: () => RagdollPort | null = spawnRagdollWorker) {
    this.renderer = new WebGLRenderer({ canvas, context: gl, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.localClippingEnabled = true;  // plan de `abovePlanes`
    this.height = canvas.clientHeight;
    this.unwatch = watchContext(canvas, () => onFail("contexte graphique perdu"), () => this.restored());
    this.bg = new Color(theme.bg);
    this.scene.background = this.bg;
    this.scene.add(...this.lights);
    this.players = new PlayerLayer(theme, this.above);
    this.nades = new NadeLayer(theme, this.above);
    this.bomb = new BombMarker(theme);
    this.scene.add(this.players.group, this.agents.group, this.nades.group, this.bomb.group);
    // worker lancé à la première collision reçue ; à l'arrivée d'une trajectoire, l'image est à refaire
    this.ragdolls = new Ragdolls(spawnRagdoll, () => { this.dirty = true; });
    this.agents.setRagdolls(this.ragdolls);
    this.rig = new CameraRig(canvas, () => { this.dirty = true; });
    const loop = this.loop = (now: number) => {
      try {
        const dt = Math.min(0.1, (now - this.last) / 1000);
        this.last = now;
        const moving = this.rig.update(dt, this.states, this.selected, this.tv.sid, this.ground, this.punchOf);
        this.track();
        // contexte perdu : three ne dessine rien, l'image est à refaire à son retour (dirty reste vrai)
        if ((this.dirty || moving) && !this.gl.isContextLost()) {
          setCut(this.cut, this.above, this.rig.cut);
          this.nades.cutAbove(this.rig.cut.aboveZ);
          this.bomb.cutAbove(this.rig.cut.aboveZ);
          this.agents.cutAbove(this.rig.cut.aboveZ);
          const cam = this.rig.camera(), u = unitsPerPx(cam, this.height), px = tagPx(this.height), top = this.rig.mode === "top";
          this.players.setTagSize(u, px, top);
          this.bomb.setTagSize(u, px, top);
          const more = this.animateAgents(cam);
          this.renderer.render(this.scene, cam);
          // 2e passe (vue du joueur) : bras et arme par-dessus ; un post-traitement futur viendrait après
          const arms = this.drawArms(cam);
          if (arms !== this.armsShown) {
            this.armsShown = arms;
            this.onArms?.(arms);
          }
          // joueurs lointains laissés pour l'image suivante : une image de plus, même à l'arrêt
          this.dirty = more;
        }
      } catch (e) {
        // hors de React, la limite d'erreur ne voit rien : sans ceci la vue resterait figée
        console.error(e);
        onFail("la 3D s'est arrêtée sur une erreur : rechargez la page");
        return;
      }
      if (!this.paused) this.raf = requestAnimationFrame(loop);  // pause demandée pendant cette image : pas de suivante
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Indice (`ReplayPlayer.index`) du joueur dans le replay affiché, undefined s'il n'y est pas. */
  private indexOf(sid: string): number | undefined { return this.replay?.players.find((p) => p.steamid === sid)?.index; }

  /** Recul de la caméra du joueur `sid` au tick affiché (`Replay.punchAt`), demandé par la caméra en vue du joueur. */
  private punchOf = (sid: string): Punch => {
    const j = this.indexOf(sid);
    return j === undefined ? NO_PUNCH : this.replay!.punchAt(j, this.tick);
  };

  /** État du joueur suivi (`rig.target`) à l'instant affiché, ou null (caméra libre, vue de dessus, personne en vie). */
  followed(): PlayerState | null {
    const sid = this.rig.target;
    return sid === null ? null : this.states.find((p) => p.steamid === sid) ?? null;
  }

  /** Nom de la carte affichée (null : aucune, ou cachée en attendant d'être relue : `onMapLost`). */
  shown(): string | null { return this.map && !this.lostMap ? this.mapName : null; }

  /** Pose la carte : le fichier est en coordonnées glTF, la scène en coordonnées du jeu. L'autre version de la même carte
   *  (grise → texturée) garde le cadrage, la caméra et la collision ; une autre carte libère la collision de l'ancienne
   *  (grille du worker), la sienne arrive ensuite (`setCollision`). */
  setMap(root: Object3D, worldToModel: number[], name: string) {
    const same = this.map !== null && name === this.mapName;
    if (this.mapName && name !== this.mapName) this.ragdolls.setMap(name, null);
    this.mapName = name;
    if (this.map) { this.scene.remove(this.map); this.drop(this.map); }
    this.lostMap = false;
    root.matrixAutoUpdate = false;
    root.matrix.copy(new Matrix4().fromArray(invertAffine(worldToModel)).transpose());  // ligne par ligne → colonnes
    root.updateMatrixWorld(true);
    adaptSourceMaterials(root);
    applyCutaway(root, this.cut);
    // images des textures libérées à leur envoi à la carte graphique (premier rendu qui les dessine) ; un contexte rendu
    // fait relire la carte (`restored`)
    freeImagesAfterUpload(root);
    this.scene.add(root);
    this.map = root;
    if (!same) { this.framedFor = ""; this.frame(); }
    this.dirty = true;
  }

  /** Cadre les caméras sur la zone jouable (positions des joueurs du premier round reçu de cette carte, + marge) prise
   *  dans la carte : le décor lointain (hélicoptère de Vertigo, bâtiments du ciel de Nuke) ne doit pas éloigner la vue
   *  d'ensemble ni celle de dessus. Une fois par carte : changer de round ne touche pas à la caméra de l'utilisateur.
   *  Avec le round d'une autre carte (match précédent encore affiché pendant le chargement) : toute la carte en attendant. */
  private frame() {
    if (!this.map) return;
    const box = new Box3().setFromObject(this.map);
    if (this.replay?.payload.map_name === this.mapName) {
      this.framedFor = this.mapName;
      const play = playZone(this.replay, this.mapName);
      const inside = play && box.clone().intersect(new Box3(new Vector3(...play.min), new Vector3(...play.max)));
      if (inside && !inside.isEmpty()) box.copy(inside);
    }
    this.rig.setBounds(box);
  }

  setFrame(r: Replay, tick: number, selected: string | null) {
    this.replay = r;
    this.tick = tick;
    this.frameNo++;
    if (this.map && this.framedFor !== this.mapName && r.payload.map_name === this.mapName) this.frame();
    this.states = playerStateAt(r, tick);
    const from = sampleIndex(r.ticks, tick - JUMP_S * r.tickrate).i, to = sampleIndex(r.ticks, tick).i;
    this.ground = grounded(this.states, (k) => {
      const zs: number[] = [];
      for (let s = from; s <= to; s++) zs.push(r.value("z", s, r.players[k].index));
      return zs;
    });
    this.selected = selected;
    const bomb = bombStateAt(r, tick);
    this.tv = tvTarget(r.payload.kills, this.states, bomb.pos, tick, r.tickrate, selected, this.tv);
    this.deaths = deathsUntil(r, tick);
    this.players.update(this.states, this.deaths, selected, this.hidden, this.aids);
    this.syncAgents();
    this.nades.update(r, tick);
    this.bomb.update(bomb, tick, r.tickrate);
    this.dirty = true;
  }

  setMode(m: CameraMode) {
    // entrée en vue du joueur, bras retirés après une erreur : nouvel essai, VM_RETRIES fois au plus par chargeur
    if (m === "pov" && this.rig.mode !== "pov" && !this.vm && this.load && this.vmRetries < VM_RETRIES) {
      this.vmRetries++;
      this.vm = this.makeVm(this.load);
    }
    this.rig.setMode(m);
  }

  /** Après le choix de la caméra (`rig.update`, à chaque image) : en vue du joueur, celui-ci est caché, les aides d'analyse
   *  aussi (noms et vies, regards, halos, croix des morts, trajectoires des grenades, étiquette de la bombe : la vue montre
   *  ce que voyait le joueur) et le ciel est clair ; le HUD est prévenu si le joueur suivi ou ce qu'il en montre a changé, ou si son
   *  tableau (score, kills) a changé. La cible peut changer sans nouvel instant (mode, mort, choix d'un joueur) : c'est
   *  ici, juste avant le dessin, qu'on la suit. */
  private track() {
    const pov = this.rig.mode === "pov", hidden = pov ? this.rig.target : null, aids = !pov;
    if (hidden !== this.hidden || aids !== this.aids) {
      this.hidden = hidden;
      this.aids = aids;
      this.scene.background = aids ? this.bg : this.sky;
      this.players.update(this.states, this.deaths, this.selected, hidden, aids);
      this.syncAgents();
      this.nades.setAids(aids);
      this.bomb.setAids(aids);
      this.dirty = true;
    }
    const p = this.followed(), key = followKey(p);
    if (key !== this.followedKey) {
      this.followedKey = key;
      this.onFollow?.(p);
    }
    // voile blanc des flashs : celui du joueur suivi en vue du joueur seulement ; sous 0,004, rien
    const j = this.rig.mode === "pov" && p ? this.indexOf(p.steamid) : undefined;
    let veil = j === undefined ? 0 : veilOpacity(this.replay!, j, this.tick);
    if (veil < 0.004) veil = 0;
    if (veil !== this.veil) {
      this.veil = veil;
      this.onFlash?.(veil);
    }
    // tableau (10 joueurs, horloge, kills) : seulement pour un nouvel instant, et seulement en vue du joueur
    if (this.rig.mode === "pov" && this.replay && this.boardFrame !== this.frameNo) {
      this.boardFrame = this.frameNo;
      const b = povBoard(this.replay, this.tick, this.states), bk = boardKey(b);
      if (bk !== this.boardSeen) {
        this.boardSeen = bk;
        this.onBoard?.(b);
      }
    }
  }

  /** Contexte graphique rendu (après sa perte) : three a tout oublié et renvoie à la carte graphique, au fil des rendus,
   *  géométries et textures depuis ce qu'il en garde ; mais pas les textures dont l'image a été libérée après le premier
   *  envoi (`freeImagesAfterUpload`). La carte qui en a est cachée (sinon dessinée sans elles : noire, avec un
   *  avertissement par texture et par image) et redemandée (`onMapLost` : Scene3D la relit comme au premier affichage,
   *  depuis sa copie gardée dans le navigateur) ; une seule fois tant qu'elle est cachée. Les bras sont rechargés : nouveau
   *  ViewModel, fichiers relus de la même façon ; sans image libérée, seuls leurs reflets (texture rendue, perdue avec le
   *  contexte) sont refaits. Modèles d'agents, même règle : images libérées, ils sont retirés et la bibliothèque libérée
   *  sans appel à la carte graphique (leurs ressources sont parties avec le contexte), puis une bibliothèque neuve relit
   *  les fichiers depuis leurs copies gardées dans le navigateur ; sinon three renvoie tout de lui-même. */
  private restored() {
    if (this.map && !this.lostMap && imagesFreed(this.map)) {
      this.lostMap = true;
      this.map.visible = false;
      this.onMapLost?.();
    }
    if (this.vm && this.load && this.vm.imagesFreed()) {
      this.vm.dispose(true);
      this.vm = this.makeVm(this.load);
    } else this.vm?.setLighting(vmLighting(...this.lights));
    if (this.agentLib?.imagesFreed() && this.agentLoad) this.replaceAgentLib(this.makeAgentLib(this.agentLoad), true);
    this.dirty = true;
  }

  /** Carte retirée : libérée (sur la carte graphique aussi), ou, perdue avec le contexte, ses images seules (`freeImages`). */
  private drop(map: Object3D) {
    if (this.lostMap) freeImages(map);
    else disposeTree(map);
  }

  /** Remet le cadrage de la carte (bouton « Recentrer », raccourci 0). */
  recenter() { this.rig.recenter(); }

  /** Vue cachée (replay repassé en 2D) : la boucle de dessin s'arrête, plus aucune image ni aucun calcul par image ; carte,
   *  textures sur le GPU, caméra et bras restent tels quels pour le retour (`resume`). */
  pause() {
    if (this.paused) return;
    this.paused = true;
    cancelAnimationFrame(this.raf);
  }

  /** Vue de nouveau affichée : la boucle repart et redessine tout de suite l'instant courant (la vue a pu être vidée ou
   *  redimensionnée pendant qu'elle était cachée) ; la couche des agents rattrape ce qui a été reçu en pause. Rien après
   *  `dispose`. */
  resume() {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    this.syncAgents();
    this.dirty = true;
    this.last = performance.now();  // pas de saut de la caméra (temps écoulé pendant la pause)
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Fichiers des bras et des armes (fichiers « vue » du serveur) ; null : aucun, la vue du joueur reste sans bras.
   *  Libère le ViewModel précédent. Même chargeur : rien (le cache des armes est gardé). Rien après `dispose`. */
  setViewmodel(load: VmLoad | null) {
    if (this.disposed || load === this.load) return;
    this.load = load;
    this.vmRetries = 0;
    this.vm?.dispose();
    this.vm = load ? this.makeVm(load) : null;
    this.dirty = true;
  }

  /** ViewModel neuf : à l'arrivée d'un fichier, l'image est à refaire ; lumière de la scène du monde, aspect du canvas. */
  private makeVm(load: VmLoad): ViewModel {
    const vm = new ViewModel(load, () => { this.dirty = true; });
    vm.setLighting(vmLighting(...this.lights));
    vm.resize(this.aspect);
    vm.onError = (name, err) => this.onVmError?.(name, err);
    return vm;
  }

  /** Fichiers « joueurs » (modèles d'agents, clips, armes du monde) ; null : aucun, les joueurs restent en silhouettes.
   *  Libère les précédents. Même chargeur : rien (pas de nouvel essai après une erreur de pose, voir `animateAgents`). En
   *  pause : rien n'est demandé avant la reprise. Rien après `dispose` (aucune bibliothèque que plus personne ne
   *  libérerait). */
  setAgents(load: AgentLoad | null) {
    if (this.disposed || load === this.agentLoad) return;
    this.agentLoad = load;
    this.replaceAgentLib(load ? this.makeAgentLib(load) : null);
    this.dirty = true;
  }

  /** Collision de la carte (triangles du jeu, collision.ts : fichier `collision` de la carte) ; null : aucune, les morts
   *  gardent leurs clips. Rien après `dispose`. */
  setCollision(map: string, tri: Float32Array | null) {
    if (this.disposed) return;
    this.ragdolls.setMap(map, tri);
    this.dirty = true;
  }

  /** Bibliothèque remplacée : modèles retirés de la couche d'abord (ils partagent les ressources de l'ancienne), puis
   *  l'ancienne libérée, puis la nouvelle posée (`syncAgents`). `lost` : contexte graphique perdu depuis les rendus, rien
   *  n'est libéré sur la carte graphique (AgentLayer.setLibrary, AgentLibrary.dispose). */
  private replaceAgentLib(next: AgentLibrary | null, lost = false) {
    this.agents.setLibrary(null, lost);
    this.ragdolls.setLibrary(null, lost);  // ses clones de travail partagent aussi les ressources de l'ancienne
    this.agentsOn = null;
    this.agentLib?.dispose(lost);
    this.agentLib = next;
    this.ragdolls.setLibrary(next);
    this.ragdollsOff = false;  // nouveaux fichiers : nouvel essai
    this.showRagdolls(0);  // trajectoires oubliées : sans bibliothèque, la boucle ne relit plus le compte
    this.syncAgents();
  }

  /** Mort suivante vers le worker s'il est libre. Une erreur du ragdoll ne retire pas les modèles des joueurs : le ragdoll
   *  s'arrête (morts en clips, trajectoires déjà calculées gardées), signalé une fois, sans nouvel essai à chaque image. */
  private pumpRagdolls(r: Replay) {
    if (this.ragdollsOff) return;
    try {
      this.ragdolls.pump(r, this.tick);
    } catch (e) {
      this.ragdollsOff = true;
      console.error("Ragdoll 3D : arrêté après une erreur (morts en clips)", e);
    }
  }

  /** Nombre de trajectoires prêtes annoncé à `onRagdolls`, au changement seulement. */
  private showRagdolls(n: number) {
    if (n === this.ragShown) return;
    this.ragShown = n;
    this.onRagdolls?.(n);
  }

  /** Bibliothèque neuve : à l'arrivée d'un fichier, l'image est à refaire ; ses échecs relayés à `onAgentsError`. */
  private makeAgentLib(load: AgentLoad): AgentLibrary {
    const lib = new AgentLibrary(load, () => { this.dirty = true; });
    lib.onError = (name, err) => this.onAgentsError?.(name, err);
    return lib;
  }

  /** Couche des agents à jour de ce qui a été reçu : bibliothèque posée (modèles des camps et clips demandés), états de
   *  l'instant et joueur caché (armes des inventaires demandées), round préchauffé (`warmAgentAnim` : phases des pas et
   *  armes au sol, au chargement du round plutôt qu'à sa première pose, qui les calculerait d'un coup). Sans fichiers
   *  « joueurs », rien ; en pause (replay en 2D), rien non plus : `resume` le fait. */
  private syncAgents() {
    const lib = this.agentLib;
    if (!lib || this.paused) return;
    if (this.agentsOn !== lib) {
      this.agentsOn = lib;
      this.agents.setLibrary(lib);
    }
    this.agents.update(this.states, this.hidden);
    if (this.replay && this.replay !== this.warmed) {
      this.warmed = this.replay;
      warmAgentAnim(this.replay);
    }
  }

  /** Avant chaque rendu : modèles d'agents posés (AgentLayer.animate) et silhouettes des joueurs dessinés en modèle cachées
   *  (PlayerLayer.setModelled, qui compare sans allouer : appelé à chaque image). Le numéro d'image avance à CHAQUE dessin,
   *  l'image de plus demandée par `deferred` comprise : sinon un joueur lointain, laissé pour l'image suivante, le serait
   *  de nouveau à chacune et la boucle redessinerait sans fin à l'arrêt. Sans fichiers « joueurs » : aucun appel à la
   *  couche. Une erreur ici retire les modèles et libère la bibliothèque sans arrêter la 3D (silhouettes jusqu'à d'autres
   *  fichiers, rien vers `onFail`). Vrai s'il faut une image de plus (`deferred` de la pose de CETTE image : celui d'une
   *  pose plus ancienne, couche retirée ou en erreur depuis, ferait redessiner sans fin ; ou préchauffage des fichiers
   *  arrivés pas fini, AgentLibrary.warm : sans lui, la première image des agents compilait et envoyait tout d'un coup). */
  private animateAgents(cam: Camera): boolean {
    const no = this.renderNo++, lib = this.agentsOn, r = this.replay;
    let shown = NO_AGENTS, more = false;
    if (lib && r) {
      try {
        const warming = lib.warm(this.renderer, cam, this.scene);
        this.pumpRagdolls(r);  // mort suivante vers le worker s'il est libre (ses erreurs ne retirent pas les modèles)
        shown = this.agents.animate(r, this.tick, cam, no);
        this.showRagdolls(this.ragdolls.count(r));
        more = this.agents.deferred || warming;
      } catch (e) {
        console.error("Joueurs 3D : modèles retirés après une erreur", e);
        this.agentLib = this.agentsOn = null;
        // déjà en échec : la 3D continue en silhouettes (rien vers onFail) ; deux essais séparés, pour que la bibliothèque
        // soit libérée même si le retrait des modèles lève
        try {
          this.agents.setLibrary(null);
          this.ragdolls.setLibrary(null);
          this.showRagdolls(0);
        } catch {
          // la bibliothèque est libérée quand même, juste après
        }
        try {
          lib.dispose();
        } catch {
          // rien de plus à libérer
        }
      }
    }
    this.players.setModelled(shown);
    if ((shown.size > 0) !== this.agentsShown) {
      this.agentsShown = shown.size > 0;
      this.onAgents?.(this.agentsShown);
    }
    return more;
  }

  resize(w: number, h: number) {
    this.height = h;
    this.aspect = w / Math.max(1, h);
    this.vm?.resize(this.aspect);
    this.renderer.setSize(w, h, false);
    this.rig.resize(w, h);
  }

  /** Joueur sous le point (coordonnées dans le canvas), ou null. */
  pick(x: number, y: number, w: number, h: number): string | null {
    this.ray.setFromCamera(new Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.rig.camera());
    return this.players.pick(this.ray);
  }

  /** 2e passe en vue du joueur : bras et arme du joueur suivi (repli compris), posés d'après le replay au tick affiché
   *  (`viewmodelPose`, pure : même pose à l'arrêt, en retour arrière ou après un saut ; le sway, petit état de rendu,
   *  repart de zéro sur un saut : `VmMotion`), dessinés sur l'image de la carte après effacement de la profondeur, avec
   *  la même chaîne de couleur (`ViewModel.render`). Rien hors de la vue du joueur (aucun appel au ViewModel), sans
   *  fichiers, sans joueur suivi, mort, en lunette, arme sans bras, ou tant que bras et arme ne sont pas chargés. Une
   *  erreur ici retire les bras sans arrêter la 3D ; ils sont repris à la prochaine entrée en vue du joueur (`setMode`,
   *  VM_RETRIES fois au plus par chargeur). Vrai si les bras sont dessinés. */
  private drawArms(cam: Camera): boolean {
    const vm = this.vm, r = this.replay;
    if (!vm || !r || this.rig.mode !== "pov") return false;
    const p = this.followed();
    if (!p) return false;
    try {
      const pose = viewmodelPose(r, this.tick, p.steamid, vm.duration);
      return !!pose && vm.update(pose, vmView(r, this.tick, p, cam.quaternion)) && vm.render(this.renderer);
    } catch (e) {
      console.error("Vue du joueur : bras retirés après une erreur", e);
      this.vm = null;
      try {
        vm.dispose();
      } catch {
        // déjà en échec : la 3D continue sans ces bras (rien vers onFail)
      }
      return false;
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unwatch();
    this.rig.dispose();
    this.players.dispose();
    this.agents.dispose();  // avant la bibliothèque, dont les modèles partagent les ressources
    this.ragdolls.dispose();  // clones de travail, worker
    this.agentLib?.dispose();
    this.agentLib = this.agentsOn = null;
    this.nades.dispose();
    this.bomb.dispose();
    this.vm?.dispose();
    this.vm = null;
    if (this.map) this.drop(this.map);
    this.renderer.dispose();
  }
}
