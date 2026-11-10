import { type Box3, type Camera, OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import type { PlayerState } from "../replay/engine/state";
import { type Cutaway, dirOf, followPose, followTarget, freeStep, type FreePose, type MoveKeys, NO_CUT, NO_PUNCH, orbitCut, povFov,
  povPose, povVfov, type Punch, topCut } from "./cameras";
import type { CameraMode } from "./types";

// touches physiques : ZQSD en AZERTY = WASD en QWERTY ; E monte, A (Q en QWERTY) descend
const CODES: Record<string, keyof MoveKeys> = { KeyW: "fwd", KeyS: "back", KeyA: "left", KeyD: "right", KeyE: "up", KeyQ: "down" };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const noPunch = () => NO_PUNCH;
const idle = (): MoveKeys => ({ fwd: false, back: false, left: false, right: false, up: false, down: false });

const ORBIT = { yaw: 225, pitch: 35, dist: 700 };
/** Perspective hors vue du joueur : 70° en vertical, plan proche à 4 unités. Vue du joueur : FOV de CS2 (celui de la démo,
 *  lunette comprise) cadré sur la fenêtre (voir `povVfov`), et le même plan proche, à 4 (les bras et l'arme
 *  de la phase 3b auront leur propre caméra). */
export const PERSP_FOV = 70, PERSP_NEAR = 4, POV_NEAR = 4;

/** Forme de la fenêtre du navigateur (largeur / hauteur en pixels CSS), pas celle de la vue 3D. */
const windowAspect = () => window.innerWidth / Math.max(1, window.innerHeight);

/** Les 5 caméras et leurs commandes. Le clavier de la caméra libre n'agit que pendant le clic droit : le reste du
 *  temps, les raccourcis du replay (espace, flèches, lettres) restent actifs. Une touche prise pendant le clic droit
 *  reste avalée jusqu'à son keyup, même si le clic est relâché avant : ses répétitions ne doivent pas partir dans les
 *  raccourcis (S = signet en rafale, D = crayon…). */
export class CameraRig {
  readonly persp = new PerspectiveCamera(PERSP_FOV, 1, PERSP_NEAR, 40000);
  readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 1, 60000);
  mode: CameraMode = "follow";
  /** Coupe de la carte pour la pose courante (voir `Cutaway`). */
  cut: Cutaway = NO_CUT;
  /** Joueur réellement suivi (suivi, vue du joueur, TV : le choisi s'il vit, sinon le repli de `followTarget`, un
   *  coéquipier vivant d'abord), null en caméra libre et en vue de dessus ou sans vivant. Mis à jour par `update`. */
  target: string | null = null;
  private free: FreePose = { pos: [0, 0, 2000], yaw: 90, pitch: -35 };
  private orbit = { ...ORBIT };
  private top = { cx: 0, cy: 0, half: 2000, z: 10000 };
  private bounds: Box3 | null = null;
  private keys = idle();
  private held = new Set<string>();  // codes des touches prises par la caméra libre, jusqu'à leur keyup
  private fast = false;
  private rmb = false;
  private drag: { x: number; y: number } | null = null;
  private aspect = 1;  // de la vue 3D
  private winAspect = windowAspect();  // de la fenêtre : relue à chaque redimensionnement (vue 3D ou fenêtre), pas à chaque image
  private off: (() => void)[] = [];

  constructor(private el: HTMLElement, private changed: () => void) {
    this.persp.up.set(0, 0, 1);
    this.listen(el, "contextmenu", (e: Event) => e.preventDefault());
    this.listen(el, "pointerdown", (e: PointerEvent) => {
      if (e.button === 2) { this.rmb = true; el.setPointerCapture(e.pointerId); }
      this.drag = { x: e.clientX, y: e.clientY };
    });
    this.listen(el, "pointermove", (e: PointerEvent) => this.onMove(e));
    // pointerup n'arrive qu'une fois tous les boutons relâchés ; un bouton relâché pendant qu'un autre reste enfoncé
    // n'est signalé que par pointermove (e.buttons). Capture perdue, fenêtre quittée (Alt+Tab, Discord) : pointerup et
    // keyup peuvent ne jamais arriver, la caméra libre s'arrête.
    this.listen(window, "pointerup", () => { this.release(); this.drag = null; });
    this.listen(el, "lostpointercapture", () => this.release());
    this.listen(window, "blur", () => { this.release(); this.held.clear(); this.drag = null; });
    // la fenêtre peut changer sans que la vue 3D change de taille (colonnes de largeur fixe, barre de lecture) : le
    // cadrage de la vue du joueur en dépend aussi
    this.listen(window, "resize", () => {
      const a = windowAspect();
      if (a === this.winAspect) return;
      this.winAspect = a;
      this.changed();
    });
    this.listen(el, "wheel", (e: WheelEvent) => {
      const f = Math.exp(e.deltaY * 0.001);
      if (this.mode === "top") this.top.half = clamp(this.top.half * f, 200, 8000);
      else if (this.mode === "follow" || this.mode === "tv") this.orbit.dist = clamp(this.orbit.dist * f, 120, 4000);
      else return;
      e.preventDefault();
      this.changed();
    }, { passive: false });
    this.listen(window, "keydown", (e: KeyboardEvent) => {
      const k = CODES[e.code];
      if (!k && e.key !== "Shift") return;
      if (this.rmb && this.mode === "free") {
        this.held.add(e.code);
        if (k) this.keys[k] = true; else this.fast = true;
      } else if (!this.held.has(e.code)) return;  // touche prise, clic relâché : avalée sans déplacer
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true });
    this.listen(window, "keyup", (e: KeyboardEvent) => {
      const k = CODES[e.code];
      if (k) this.keys[k] = false;
      if (e.key === "Shift") this.fast = false;
      this.held.delete(e.code);
    }, { capture: true });
  }

  /** Cadre les caméras sur la carte (boîte en coordonnées du jeu). */
  setBounds(b: Box3) {
    this.bounds = b.clone();
    const c = b.getCenter(new Vector3()), s = b.getSize(new Vector3()), r = Math.max(s.x, s.y) / 2;
    this.top = { cx: c.x, cy: c.y, half: r * 1.05, z: b.max.z + 2000 };
    this.ortho.far = s.z + 4000;
    this.free = { pos: [c.x, c.y - r, b.max.z + r * 0.6], yaw: 90, pitch: -35 };
    this.changed();
  }

  /** Remet le cadrage de la carte : vue de dessus, point de départ de la caméra libre, orbite par défaut. */
  recenter() {
    this.orbit = { ...ORBIT };
    if (this.bounds) this.setBounds(this.bounds); else this.changed();
  }

  setMode(m: CameraMode) { this.mode = m; this.keys = idle(); this.cut = NO_CUT; this.changed(); }

  /** Nouvelle taille de la vue 3D (pixels CSS). La forme de la fenêtre est relue en même temps : l'ordre de l'observateur
   *  de taille et de l'événement `resize` de la fenêtre n'est pas garanti. */
  resize(w: number, h: number) {
    this.winAspect = windowAspect();
    this.aspect = w / Math.max(1, h);
    this.persp.aspect = this.aspect;
    this.persp.updateProjectionMatrix();
    this.changed();
  }

  camera(): Camera { return this.mode === "top" ? this.ortho : this.persp; }

  /** Place la caméra active ; vrai si elle bouge encore (caméra libre en déplacement). `ground` : les joueurs à leur
   *  hauteur au sol (voir `grounded`), pour la coupe de la vue de dessus. `punchOf` : recul de la caméra du joueur au
   *  tick affiché (voir `Replay.punchAt`), demandé pour le seul joueur de la vue du joueur ; ailleurs, aucun recul. Sans
   *  joueur à suivre, caméra et coupe restent. */
  update(dt: number, players: PlayerState[], selected: string | null, tvSid: string | null, ground = players,
         punchOf: (steamid: string) => Punch = noPunch): boolean {
    if (this.mode !== "pov") this.lens(PERSP_FOV, PERSP_NEAR);
    if (this.mode === "top") {
      this.target = null;
      const { cx, cy, half, z } = this.top;
      Object.assign(this.ortho, { left: -half * this.aspect, right: half * this.aspect, top: half, bottom: -half });
      this.ortho.position.set(cx, cy, z);
      this.ortho.lookAt(cx, cy, z - 1);  // vers le bas, « haut » de l'écran = +Y (le nord du radar 2D)
      this.ortho.updateProjectionMatrix();
      this.cut = topCut(ground, selected);
      return false;
    }
    if (this.mode === "free") {
      this.target = null;
      this.cut = NO_CUT;
      const moving = Object.values(this.keys).some(Boolean);
      if (moving) this.free = freeStep(this.free, this.keys, dt, this.fast);
      const { pos, yaw, pitch } = this.free, d = dirOf(yaw, pitch);
      this.persp.position.set(...pos);
      this.persp.lookAt(pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]);
      return moving;
    }
    const sid = this.mode === "tv" ? tvSid : selected;
    const p = followTarget(players, sid);
    this.target = p?.steamid ?? null;
    if (!p) return false;
    if (this.mode === "pov") {
      this.cut = NO_CUT;
      this.lens(povVfov(povFov(p), this.winAspect, this.aspect), POV_NEAR);
      const { eye, dir } = povPose(p, punchOf(p.steamid));
      this.persp.position.set(...eye);
      this.persp.lookAt(eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]);
    } else {
      const { pos, look } = followPose(p, this.orbit.yaw, this.orbit.pitch, this.orbit.dist);
      this.persp.position.set(...pos);
      this.persp.lookAt(...look);
      this.cut = orbitCut(pos, look, p.z);
    }
    return false;
  }

  dispose() { this.off.forEach((f) => f()); }

  /** Angle de vue vertical et plan proche de la perspective ; la projection n'est recalculée que s'ils changent. */
  private lens(fov: number, near: number) {
    if (this.persp.fov === fov && this.persp.near === near) return;
    this.persp.fov = fov;
    this.persp.near = near;
    this.persp.updateProjectionMatrix();
  }

  /** Clic droit relâché : la caméra libre s'arrête (les touches prises restent avalées jusqu'à leur keyup). */
  private release() { this.rmb = false; this.keys = idle(); this.fast = false; }

  private onMove(e: PointerEvent) {
    const rmb = (e.buttons & 2) !== 0;  // l'état réel du bouton droit, appuis à plusieurs boutons compris
    if (rmb && !this.rmb) this.rmb = true;
    else if (!rmb && this.rmb) this.release();
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag = { x: e.clientX, y: e.clientY };
    if (this.mode === "free" && this.rmb) {
      this.free = { ...this.free, yaw: this.free.yaw - dx * 0.2, pitch: clamp(this.free.pitch - dy * 0.2, -89, 89) };
    } else if (this.mode === "follow" || this.mode === "tv") {
      this.orbit.yaw -= dx * 0.3;
      this.orbit.pitch = clamp(this.orbit.pitch + dy * 0.3, 5, 85);
    } else if (this.mode === "top") {
      const k = (2 * this.top.half) / Math.max(1, this.el.clientHeight);
      this.top.cx -= dx * k;
      this.top.cy += dy * k;
    } else return;
    this.changed();
  }

  private listen<E extends Event>(t: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions) {
    const h = fn as unknown as EventListener;
    t.addEventListener(type, h, opts);
    this.off.push(() => t.removeEventListener(type, h, opts));
  }
}
