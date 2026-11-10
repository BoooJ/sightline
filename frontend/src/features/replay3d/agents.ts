/**
 * Fichiers « joueurs » (scripts/map3d/export.mjs joueurs, GET /api/assets3d) : modèles d'agents par camp (agent-ct :
 * SAS, agent-t : Phoenix), jeux de clips (anims-rifle, anims-pistol, anims-knife, anims-communes) et armes du monde
 * (monde-<clé>). Chargés à la demande, gardés pour la durée de la vue 3D, partagés par les joueurs (agentRig.ts clone les
 * modèles et les armes ; les clips ne sont jamais copiés).
 *
 * - `model(camp, agent)` : modèle prêt à cloner (os renommés à leur nom d'origine, pour que les pistes des clips s'y
 *   relient) : l'agent équipé par le joueur (fichier agent-<nom>) s'il est là, sinon celui du camp ; null tant qu'aucun
 *   n'est là ou s'il manque sur le serveur ; les demande au premier appel.
 * - `duration(jeu, clip)` : durée d'un clip (ClipDur de agentAnim.ts), null s'il manque ; demande le jeu de clips.
 * - `clip(modèle, jeu, clip)` : le clip réduit aux os de ce modèle (Phoenix n'a pas les 8 os « jiggle » de SAS : sans ce
 *   tri, three avertirait à chaque action créée).
 * - `weapon(clé)` : arme du monde prête à cloner (sous « sl_arme », os « weapon » remis à l'origine comme le font les
 *   clips du jeu), null sinon ; la demande.
 * - `version` : augmente à chaque fichier arrivé (les poses déjà faites sont à refaire).
 * - `ragdoll()` : le fichier « ragdoll » (extras de sa scène, contrôlés), null tant qu'il n'est pas là ou s'il manque ;
 *   le demande au premier appel. Contenu refusé par le contrôle : null, signalé une fois et mémorisé (pas de nouvel
 *   essai, contrairement à une préparation qui lève, ci-dessous).
 * Échecs : comme ViewModel (viewmodel.ts) — « absent » (chargeur qui renvoie null) mémorisé ; une erreur (réseau, 401,
 * 404 d'un fichier ré-exporté…) signalée une fois par `onError`, nouvel essai RETRY_MS plus tard au plus tôt. Un fichier
 * arrivé dont la préparation lève une exception (contenu inattendu) est un échec comme un autre : libéré, signalé, réessayé
 * après le délai (sinon chaque image le redemanderait).
 * Plafond : au plus MAX_EQUIPPED agents équipés chargés (hors modèles des camps) ; au-delà, à l'arrivée d'un nouveau, le moins
 * récemment demandé est libéré, sauf un modèle encore posé sur un joueur (`inUse`) ; redemandé, il est rechargé.
 * Mémoire, comme la carte et les bras (dispose.ts) : les images des textures des modèles et des armes sont libérées juste
 * après leur premier envoi à la carte graphique (`freeImagesAfterUpload` ; les clones de agentRig.ts partagent les
 * textures : un envoi pour tous) ; ce qui ne sera jamais dessiné (bras de première personne, reste d'un fichier d'arme,
 * arme sans « sl_arme ») est libéré dès l'arrivée, sauf ce que la partie gardée partage avec lui. Contexte graphique perdu puis rendu : si `imagesFreed()`, three ne
 * pourrait plus renvoyer ces textures ; le Viewer libère alors la bibliothèque (`dispose(true)`) et en crée une neuve
 * avec le même chargeur (fichiers relus depuis leurs copies gardées dans le navigateur, sans téléchargement).
 * Premier affichage (`warm`, appelé par le Viewer avant chaque rendu) : sans préchauffage, la première image des agents
 * compilait les shaders et envoyait toutes les textures d'un coup (488 puis 308 ms, mesuré à l'essai réel du 06/11/2026).
 * Un modèle ou une arme arrivé n'est donc rendu par `model` / `weapon` qu'une fois ses shaders compilés (`compileAsync`,
 * dans la scène du monde) et ses textures envoyées (`initTexture`, WARM_PER_FRAME par image) : en attendant, silhouette
 * ou main vide. Avec un rendu qui ne sait ni compiler ni envoyer (faux rendus des tests), rien n'est retenu.
 */
import { AnimationClip, type Camera, type Material, type Mesh, type Object3D, PropertyBinding, type Scene, type Texture,
  type WebGLRenderer } from "three";
import type { Side } from "../../shared/api/types";
import type { AnimSet, ClipDur } from "./agentAnim";
import { disposeTree, freeImages, freeImagesAfterUpload, imagesFreed } from "./dispose";
import { type RagdollFile, readRagdollFile } from "./ragdollDef";
import type { VmFile, VmLoad } from "./viewmodel";

/** Charge un fichier « joueurs » par son nom ; null : absent du serveur. Même forme que les fichiers « vue ». */
export type AgentLoad = VmLoad;
export const agentFile = (side: Side) => `agent-${side.toLowerCase()}`;
const AGENT_NAME = /^[a-z0-9_]{1,40}$/;
const nameFiles = new Map<string, string | null>();  // agent → fichier (validation et nom faits une fois par nom)
/** Fichier d'un agent équipé (« tm_leet_variantf » → « agent-tm_leet_variantf ») ; null pour un nom inattendu. Mémorisé :
 *  appelé à chaque image pour chaque joueur, il ne refait ni expression régulière ni chaîne. */
export const agentNameFile = (agent: string): string | null => {
  let file = nameFiles.get(agent);
  if (file === undefined) {
    file = AGENT_NAME.test(agent) ? `agent-${agent}` : null;
    if (nameFiles.size < 256) nameFiles.set(agent, file);  // plafond : un nom venu du serveur ne grossit pas la table sans fin
  }
  return file;
};
const SIDE_FILES: Record<Side, string> = { CT: agentFile("CT"), T: agentFile("T") };
/** Nombre d'agents équipés (hors modèles des camps) gardés en mémoire : au-delà, le moins récemment utilisé est libéré (une
 *  page qui enchaîne les matchs en verrait sinon s'accumuler, textures comprises). Un match en compte 20 au plus (10
 *  joueurs, un agent par camp) : 24 les garde tous, sans rechargement à la mi-temps ni en prolongation, avec de la marge
 *  pour un remplaçant ; un modèle posé sur un joueur n'est jamais libéré. */
export const MAX_EQUIPPED = 24;
export const animFile = (set: AnimSet) => `anims-${set}`;
export const worldFile = (key: string) => `monde-${key}`;
/** Fichier du ragdoll des agents (corps et articulations, le même pour tous : scripts/map3d/lib/ragdoll.mjs). */
export const RAGDOLL_FILE = "ragdoll";
/** Nœud du modèle d'arme dans les fichiers monde-<clé> et arme-<clé> (WEAPON_NODE de scripts/map3d/lib/viewmodel.mjs). */
export const WEAPON_NODE = "sl_arme";
/** Après un échec transitoire, délai avant une nouvelle demande du même fichier (ms). */
export const RETRY_MS = 10_000;

/** Nom d'origine d'un nœud (GLTFLoader rend les noms uniques : « weapon_1 »), sans les caractères réservés de three. */
const original = (o: Object3D) => PropertyBinding.sanitizeNodeName((o.userData.name as string | undefined) ?? o.name);

type Parts = Object3D & { geometry?: object; material?: Material | Material[] };
const materialsOf = (o: Parts): Material[] => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);
/** Préchauffage : textures envoyées à la carte graphique et compilations lancées, au plus, par image (une texture de
 *  512 px : quelques ms sur la puce graphique intégrée). */
export const WARM_PER_FRAME = 2;
/** Délai de sécurité d'une compilation (ms) : passé ce temps sans réponse (contexte perdu et jamais redessiné, extension
 *  de compilation parallèle qui ne répond plus), le modèle ou l'arme est rendu quand même (compilé à l'affichage). */
export const COMPILE_TIMEOUT_MS = 4000;
/** Textures des matériaux d'un arbre, chacune une fois. */
function texturesOf(root: Object3D): Texture[] {
  const out = new Set<Texture>();
  root.traverse((o: Parts) => {
    for (const m of materialsOf(o)) for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) out.add(v as Texture);
  });
  return [...out];
}
/** Modèle ou arme arrivé pas encore prêt : compilation (0 à lancer, 1 en cours, 2 faite) et textures à envoyer. */
interface Warming { compile: 0 | 1 | 2; textures: Texture[] }

/** Libère une partie retirée d'un fichier (bras de première personne, reste d'un fichier d'arme) sans rien libérer de ce
 *  que la partie gardée `kept` utilise encore : géométrie, matériau ou image partagés (une texture partagée, ou clonée,
 *  a la même image) sont d'abord retirés de la partie libérée. Squelettes : propres à chaque maillage (GLTFLoader), sans
 *  texture des os avant le premier rendu. */
function disposeApart(gone: Object3D, kept: Object3D) {
  const used = new Set<object>();
  kept.traverse((o: Parts) => {
    if (o.geometry) used.add(o.geometry);
    for (const m of materialsOf(o)) {
      used.add(m);
      for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) used.add((v as Texture).source);
    }
  });
  gone.traverse((o: Parts) => {
    if (o.geometry && used.has(o.geometry)) o.geometry = undefined;
    if (materialsOf(o).some((m) => used.has(m))) o.material = materialsOf(o).filter((m) => !used.has(m));
    for (const m of materialsOf(o)) {
      const props = m as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(props)) if ((v as Texture | null)?.isTexture && used.has((v as Texture).source)) props[k] = null;
    }
  });
  disposeTree(gone);
}

/** Modèle d'agent prêt à cloner : son fichier (« agent-ct »…), sa scène et les noms de ses nœuds. */
export interface AgentModel { file: string; root: Object3D; nodes: ReadonlySet<string> }

export class AgentLibrary {
  onError?: (name: string, error: unknown) => void;
  /** Vrai si un modèle (son fichier) est encore posé sur un joueur : jamais libéré, même au-delà de MAX_EQUIPPED (ses
   *  clones en partagent géométries, matériaux et textures). Posé par la couche des agents. */
  inUse?: (file: string) => boolean;
  /** Augmente à chaque fichier arrivé. */
  version = 0;
  private models = new Map<string, AgentModel | null>();  // par fichier
  private sets = new Map<AnimSet, Map<string, AnimationClip> | null>();
  private weapons = new Map<string, Object3D | null>();
  private ragdollFile: RagdollFile | null | undefined;  // undefined : pas encore demandé
  private reduced = new Map<string, AnimationClip | null>();  // « agent-ct:rifle:walk_n »
  // agents équipés : dernière demande de chacun (`clock`) ; le moins récent est libéré au-delà de MAX_EQUIPPED
  private used = new Map<string, number>();
  private clock = 0;
  private pending = new Set<string>();
  private failed = new Map<string, number>();
  private abort = new AbortController();
  private disposed = false;
  // préchauffage (voir l'en-tête) : modèles et armes arrivés pas encore prêts ; `gated` : un vrai rendu préchauffe, ils
  // ne sont rendus qu'une fois prêts
  private waiting = new Map<Object3D, Warming>();
  private timers = new Set<ReturnType<typeof setTimeout>>();  // délais de sécurité des compilations en cours
  private gated = false;

  constructor(private load: AgentLoad, private onChange: () => void) {}

  /** Modèle d'un joueur : l'agent équipé (« tm_leet_variantf ») s'il est sur le serveur, arrivé et préchauffé ; sinon (absent
   *  du serveur, pas encore là, nom inattendu) l'agent par défaut du camp. Un agent absent est mémorisé comme absent (un seul
   *  essai). */
  model(side: Side, agent: string | null = null): AgentModel | null {
    const file = agent ? agentNameFile(agent) : null;
    if (file && file !== SIDE_FILES.CT && file !== SIDE_FILES.T) this.used.set(file, ++this.clock);
    const own = file ? this.ready(this.modelFile(file)) : null;
    return own ?? this.ready(this.modelFile(SIDE_FILES[side]));
  }
  /** Un modèle rendu seulement une fois préchauffé (voir `warm`). */
  private ready(m: AgentModel | null): AgentModel | null {
    return m && this.gated && this.waiting.has(m.root) ? null : m;
  }

  readonly duration: ClipDur = (set, clip) => this.clips(set)?.get(clip)?.duration ?? null;

  clip(m: AgentModel, set: AnimSet, name: string): AnimationClip | null {
    const key = `${m.file}:${set}:${name}`, done = this.reduced.get(key);
    if (done !== undefined) return done;
    const src = this.clips(set)?.get(name);
    if (!src) return null;  // pas encore là : rien de mémorisé
    const c = new AnimationClip(src.name, src.duration, src.tracks.filter((t) => m.nodes.has(PropertyBinding.parseTrackName(t.name).nodeName)));
    this.reduced.set(key, c);
    return c;
  }

  weapon(key: string): Object3D | null {
    if (!this.weapons.has(key)) {
      this.fetch(worldFile(key), (f) => this.prepareWeapon(f), (v) => { this.weapons.set(key, v); if (v) this.arrived(v); }, () => this.weapons.has(key));
    }
    const w = this.weapons.get(key) ?? null;
    return w && this.gated && this.waiting.has(w) ? null : w;
  }

  /** Fichier « ragdoll » (voir l'en-tête) ; les morts gardent leurs clips sans lui. Erreur de chargement (réseau, 404) :
   *  un échec comme un autre (signalé, réessayé après RETRY_MS) ; contenu refusé par readRagdollFile : signalé une fois et
   *  mémorisé comme absent (le même fichier relu serait refusé de même ; un nouvel envoi change la liste, donc la
   *  bibliothèque). */
  ragdoll(): RagdollFile | null {
    if (this.ragdollFile === undefined) {
      this.fetch(RAGDOLL_FILE, (f) => this.prepareRagdoll(f), (v) => { this.ragdollFile = v; }, () => this.ragdollFile !== undefined);
    }
    return this.ragdollFile ?? null;
  }

  /** Préchauffage, avant chaque rendu (voir l'en-tête) : WARM_PER_FRAME compilations lancées et textures envoyées au
   *  plus ; un modèle ou une arme compilé et dont toutes les textures sont envoyées devient prêt (`version` augmente : les
   *  poses sont refaites, l'arme montée). Vrai s'il reste des textures à envoyer ou des compilations à lancer (une image
   *  de plus) ; une compilation finie appelle `onChange`. Rendu sans `compileAsync` / `initTexture` : tout est prêt. */
  warm(renderer: WebGLRenderer, camera: Camera, scene: Scene, max = WARM_PER_FRAME): boolean {
    if (this.disposed || this.waiting.size === 0) return false;
    if (typeof renderer.compileAsync !== "function" || typeof renderer.initTexture !== "function") {
      this.waiting.clear();
      return false;
    }
    this.gated = true;
    let started = 0, sent = 0, more = false;
    for (const [root, w] of this.waiting) {
      if (w.compile === 0 && started < max) {
        started++;
        w.compile = 1;
        // en échec (exception synchrone ou promesse refusée) ou sans réponse à temps : compilé au premier affichage, comme
        // sans préchauffage
        const finish = () => {
          if (w.compile === 2) return;
          w.compile = 2;
          this.timers.delete(timer);
          clearTimeout(timer);
          if (!this.disposed) this.onChange();
        };
        const timer = setTimeout(finish, COMPILE_TIMEOUT_MS);
        this.timers.add(timer);
        let compiling: Promise<unknown>;
        try {
          compiling = renderer.compileAsync(root, camera, scene);
        } catch (e) {
          compiling = Promise.reject(e);
        }
        compiling.catch(() => {}).then(finish);
      }
      while (w.textures.length > 0 && sent < max) {
        sent++;
        try {
          renderer.initTexture(w.textures.shift()!);
        } catch {
          // envoyée quand même au premier affichage
        }
      }
      if (w.compile === 2 && w.textures.length === 0) {
        this.waiting.delete(root);
        this.version++;
      } else if (w.compile === 0 || w.textures.length > 0) more = true;
    }
    return more;
  }

  /** Demande à l'avance les modèles des camps et des jeux de clips. */
  preload(sides: readonly Side[], sets: readonly AnimSet[]) {
    for (const s of sides) this.model(s);
    for (const s of sets) this.clips(s);
  }

  /** Vrai si l'image d'une texture d'un modèle ou d'une arme chargés a été libérée après son envoi : three ne pourrait pas
   *  la renvoyer à un nouveau contexte graphique (le Viewer recrée alors la bibliothèque, comme le ViewModel). */
  imagesFreed(): boolean {
    for (const m of this.models.values()) if (m && imagesFreed(m.root)) return true;
    for (const w of this.weapons.values()) if (w && imagesFreed(w)) return true;
    return false;
  }

  /** Libère tout et annule les chargements en cours ; les clones (agentRig.ts) sont à retirer avant : ils partagent
   *  géométries, matériaux et textures. `lost` : contexte graphique perdu depuis les rendus (contexte rendu, bibliothèque
   *  remplacée) : ressources parties avec lui, seules les images encore gardées sont fermées (`freeImages`). */
  dispose(lost = false) {
    this.disposed = true;
    this.abort.abort();
    const drop = lost ? freeImages : disposeTree;
    for (const m of this.models.values()) if (m) drop(m.root);
    for (const w of this.weapons.values()) if (w) drop(w);
    this.models.clear();
    this.used.clear();
    this.weapons.clear();
    this.ragdollFile = undefined;
    this.sets.clear();
    this.reduced.clear();
    this.waiting.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Modèle d'un fichier agent-… ; le demande au premier appel. */
  private modelFile(file: string): AgentModel | null {
    if (!this.models.has(file)) {
      this.fetch(file, (f) => this.prepareModel(f, file), (v) => { this.models.set(file, v); if (v) { this.arrived(v.root); this.trim(file); } }, () => this.models.has(file));
    }
    return this.models.get(file) ?? null;
  }

  /** Agents équipés chargés au-delà de MAX_EQUIPPED : le moins récemment demandé est libéré (jamais `fresh`, qui vient
   *  d'arriver, ni un modèle encore posé sur un joueur, `inUse`) ; redemandé, il est rechargé. */
  private trim(fresh: string) {
    const loaded: string[] = [];
    for (const f of this.used.keys()) if (this.models.get(f)) loaded.push(f);
    for (let excess = loaded.length - MAX_EQUIPPED; excess > 0; excess--) {
      let oldest: string | null = null;
      for (const f of loaded) {
        if (f === fresh || this.inUse?.(f) || !this.models.get(f)) continue;
        if (oldest === null || this.used.get(f)! < this.used.get(oldest)!) oldest = f;
      }
      if (oldest === null) return;
      const m = this.models.get(oldest)!;
      disposeTree(m.root);
      this.waiting.delete(m.root);
      this.models.delete(oldest);
      this.used.delete(oldest);
      this.failed.delete(oldest);
      for (const k of this.reduced.keys()) if (k.startsWith(`${oldest}:`)) this.reduced.delete(k);
    }
  }

  /** Modèle ou arme arrivé : à préchauffer (shaders, textures) avant d'être rendu (voir `warm`). */
  private arrived(root: Object3D) {
    this.waiting.set(root, { compile: 0, textures: texturesOf(root) });
  }

  private clips(set: AnimSet): Map<string, AnimationClip> | null {
    if (!this.sets.has(set)) this.fetch(animFile(set), (f) => this.prepareClips(f), (v) => this.sets.set(set, v), () => this.sets.has(set));
    return this.sets.get(set) ?? null;
  }

  /** Os renommés à leur nom d'origine (les pistes des clips le portent) ; maillages de première personne retirés et
   *  libérés (jamais dessinés : cachés, ils garderaient leurs images, puisqu'elles ne sont libérées qu'après leur envoi). */
  private prepareModel(f: VmFile, file: string): AgentModel {
    const firstPerson: Object3D[] = [], nodes = new Set<string>();
    f.scene.traverse((o) => { if ((o as Mesh).isMesh && /firstperson/i.test(o.name)) firstPerson.push(o); });
    for (const o of firstPerson) o.removeFromParent();
    for (const o of firstPerson) disposeApart(o, f.scene);
    f.scene.traverse((o) => {
      if ((o as Mesh).isMesh) return;
      o.name = original(o);
      nodes.add(o.name);
    });
    freeImagesAfterUpload(f.scene);
    return { file, root: f.scene, nodes };
  }

  /** Clips par nom ; pistes renommées au nom d'origine de leur nœud. Le squelette du fichier ne sert qu'à nommer. */
  private prepareClips(f: VmFile): Map<string, AnimationClip> {
    const alias = new Map<string, string>();
    f.scene.traverse((o) => alias.set(o.name, original(o)));
    for (const c of f.clips) {
      for (const t of c.tracks) {
        const { nodeName, propertyName } = PropertyBinding.parseTrackName(t.name);
        t.name = `${alias.get(nodeName) ?? nodeName}.${propertyName}`;
      }
    }
    disposeTree(f.scene);
    return new Map(f.clips.map((c) => [c.name, c]));
  }

  /** Ragdoll lu dans les extras de la scène (GLTFLoader les range dans userData) ; la scène, vide, est libérée. Contenu
   *  refusé : null (mémorisé, voir `ragdoll`), signalé une fois. */
  private prepareRagdoll(f: VmFile): RagdollFile | null {
    try {
      return readRagdollFile((f.scene.userData as { sl_ragdoll?: unknown }).sl_ragdoll);
    } catch (e) {
      console.warn(`Joueurs 3D : ${RAGDOLL_FILE} refusé (pas de nouvel essai) : morts en clips`, e);
      this.onError?.(RAGDOLL_FILE, e);
      return null;
    } finally {
      disposeTree(f.scene);
    }
  }

  /** Arme sous « sl_arme », os racine « weapon » remis à l'origine (comme dans les clips du jeu : seule sa rotation des
   *  axes Source reste, annulée par le support de agentRig.ts) ; null si le fichier n'a pas « sl_arme ». Le reste du
   *  fichier (tout, sans « sl_arme ») est libéré. Rien n'est détaché avant la fin : si la préparation lève une exception,
   *  le fichier entier est encore sous sa scène, que `fetch` libère. */
  private prepareWeapon(f: VmFile): Object3D | null {
    const model = f.scene.getObjectByName(WEAPON_NODE);
    if (!model) {
      disposeTree(f.scene);
      return null;
    }
    model.traverse((o) => { if (!(o as Mesh).isMesh && original(o) === "weapon") o.position.set(0, 0, 0); });
    model.removeFromParent();
    disposeApart(f.scene, model);
    freeImagesAfterUpload(model);
    return model;
  }

  /** Charge un fichier une fois (voir l'en-tête : absent mémorisé ; échec, préparation en exception comprise, signalé puis
   *  réessayé après RETRY_MS). */
  private fetch<T>(name: string, make: (f: VmFile) => T, store: (v: T | null) => void, has: () => boolean) {
    if (this.disposed || has() || this.pending.has(name)) return;
    const failedAt = this.failed.get(name);
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_MS) return;
    this.pending.add(name);
    const signal = this.abort.signal;
    this.load(name, signal).then((f) => {
      this.pending.delete(name);
      if (signal.aborted) { if (f) disposeTree(f.scene); return; }
      let v: T | null;
      try {
        v = f ? make(f) : null;
      } catch (e) {
        if (f) disposeTree(f.scene);  // fichier mal préparé : rien n'en est gardé
        this.fail(name, e);
        return;
      }
      this.failed.delete(name);
      store(v);
      this.version++;
      this.onChange();
    }, (e: unknown) => {
      this.pending.delete(name);
      if (signal.aborted) return;
      this.fail(name, e);
    });
  }

  /** Échec d'un fichier : daté (pas de nouvelle demande avant RETRY_MS), signalé une fois (sauf annulation). */
  private fail(name: string, e: unknown) {
    this.failed.set(name, Date.now());
    if ((e as Error)?.name !== "AbortError") {
      console.warn(`Joueurs 3D : ${name} non chargé (nouvel essai dans ${RETRY_MS / 1000} s)`, e);
      this.onError?.(name, e);
    }
    this.onChange();
  }
}
