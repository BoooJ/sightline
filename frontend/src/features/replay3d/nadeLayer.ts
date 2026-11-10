import { BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry, Color, Group, Line, LineBasicMaterial, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, type Plane, SphereGeometry, Sprite, SpriteMaterial, Vector3 } from "three";
import type { GrenadeEvent, Vec3 } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { activeGrenades, BOMB_TIME_S } from "../replay/engine/state";
import type { Theme } from "../replay/renderer/theme";
import { nadeLook, trail3d } from "./nades";
import { applyTag, paintTag, tagSize } from "./players";

type NadeType = GrenadeEvent["type"];
const COLOR: Record<NadeType, keyof Theme> = { smoke: "smoke", flash: "flash", he: "he", molotov: "fire", incendiary: "fire", decoy: "fg" };
// z : position de la grenade (point d'éclatement une fois posée) ; shown : assez opaque pour être dessinée ; trailed : a une
// trajectoire à montrer (au moins deux points)
interface Item { mesh: Mesh; trail: Line; z: number; shown: boolean; trailed: boolean }

/** Grenades du round : trajectoire en 3D, puis volume de smoke, nappe de feu ou éclat. Coupe « au-dessus de » de la vue
 *  de dessus : les trajectoires sont coupées au plan `clip` (voir `abovePlanes`) ; une grenade au-dessus de la coupe est
 *  cachée en entier (`cutAbove`), car une sphère coupée en travers serait creuse vue d'en haut (faces arrière non
 *  dessinées) : une smoke de l'étage suivi doit rester pleine. Les trajectoires sont une aide d'analyse : cachées en vue du
 *  joueur (`setAids`), qui ne montre que les grenades elles-mêmes (en vol, fumée, feu, éclat). */
export class NadeLayer {
  readonly group = new Group();
  private items = new Map<number, Item>();
  private sphere = new SphereGeometry(1, 24, 16);
  private disc = new CircleGeometry(1, 40);
  private byId = new Map<number, GrenadeEvent>();
  private payload: unknown = null;
  private aboveZ = Infinity;
  private aids = true;

  constructor(private theme: Theme, private clip: Plane[]) {}

  /** Aides d'analyse (trajectoires) montrées ou non (vue du joueur : non), posé quand la caméra change ; sans effet sur les
   *  grenades elles-mêmes. Les trajectoires, toujours tenues à jour, reviennent aussitôt. */
  setAids(on: boolean) {
    this.aids = on;
    for (const it of this.items.values()) this.show(it);
  }

  /** Hauteur de la coupe « au-dessus de » (Infinity : aucune), posée avant chaque image. */
  cutAbove(z: number) {
    this.aboveZ = z;
    for (const it of this.items.values()) this.show(it);
  }

  update(r: Replay, tick: number) {
    if (this.payload !== r.payload) {  // autre round : on repart de zéro
      this.payload = r.payload;
      this.byId = new Map(r.payload.grenades.map((g) => [g.id, g]));
      for (const [id, it] of this.items) this.drop(id, it);
    }
    const seen = new Set<number>();
    for (const v of activeGrenades(r, tick)) {
      const g = this.byId.get(v.id);
      if (!g) continue;
      seen.add(v.id);
      const look = nadeLook(v), it = this.items.get(v.id) ?? this.create(v.id, g.type);
      const det = g.detonate_tick ?? g.trajectory[g.trajectory.length - 1][0];
      const pts = trail3d(g, v.phase === "flying" ? tick : det);
      it.trail.geometry.dispose();
      it.trail.geometry = new BufferGeometry().setFromPoints(pts.map(([x, y, z]) => new Vector3(x, y, z)));
      it.trailed = pts.length > 1;
      const [x, y, z] = v.pos;
      it.mesh.geometry = look.kind === "fire" ? this.disc : this.sphere;
      it.mesh.position.set(x, y, look.kind === "fire" ? z + 3 : look.kind === "smoke" ? z + look.radius * 0.6 : z);
      it.mesh.scale.set(look.radius, look.radius, look.kind === "smoke" ? look.radius * 0.75 : look.radius);
      (it.mesh.material as MeshBasicMaterial).opacity = look.opacity;
      it.z = z;
      it.shown = look.opacity > 0.01;
      this.show(it);
    }
    for (const [id, it] of this.items) if (!seen.has(id)) this.drop(id, it);
  }

  dispose() {
    for (const [id, it] of this.items) this.drop(id, it);
    this.sphere.dispose();
    this.disc.dispose();
  }

  private show(it: Item) {
    it.mesh.visible = it.shown && it.z <= this.aboveZ;
    it.trail.visible = this.aids && it.trailed;
  }

  private create(id: number, type: NadeType): Item {
    const color = new Color(this.theme[COLOR[type]]);
    const mat = type === "smoke"
      ? new MeshLambertMaterial({ color, transparent: true, depthWrite: false })
      : new MeshBasicMaterial({ color, transparent: true, depthWrite: false });
    const mesh = new Mesh(this.sphere, mat);
    const trail = new Line(new BufferGeometry(),
      new LineBasicMaterial({ color, transparent: true, opacity: 0.8, clippingPlanes: this.clip }));
    this.group.add(mesh, trail);
    const it = { mesh, trail, z: 0, shown: false, trailed: false };
    this.items.set(id, it);
    return it;
  }

  private drop(id: number, it: Item) {
    this.group.remove(it.mesh, it.trail);
    (it.mesh.material as MeshBasicMaterial).dispose();
    it.trail.geometry.dispose();
    (it.trail.material as LineBasicMaterial).dispose();
    this.items.delete(id);
  }
}

/** Bombe posée ou lâchée : repère au sol et, posée, secondes restantes. Au-dessus de la coupe de la vue de dessus
 *  (`cutAbove`), repère et étiquette sont cachés ensemble, selon la hauteur de la bombe. L'étiquette (« C4 » ou secondes,
 *  visible à travers les murs) est une aide d'analyse : cachée en vue du joueur (`setAids`), où l'on ne
 *  voit que la bombe elle-même ; le repère reste. */
export class BombMarker {
  readonly group = new Group();
  private box: Mesh;
  private label: Sprite;
  private canvas = document.createElement("canvas");
  private text = "";
  private shown = false;  // posée ou lâchée
  private z = 0;
  private aboveZ = Infinity;

  constructor(theme: Theme) {
    this.box = new Mesh(new BoxGeometry(18, 12, 8), new MeshBasicMaterial({ color: new Color(theme.he) }));
    this.canvas.width = 128; this.canvas.height = 40;
    this.label = new Sprite(new SpriteMaterial({ map: new CanvasTexture(this.canvas), depthTest: false, sizeAttenuation: false }));
    this.label.scale.set(0.06, 0.019, 1);
    this.label.renderOrder = 10;
    this.group.add(this.box, this.label);
    this.group.visible = false;
  }

  /** Hauteur de la coupe « au-dessus de » (Infinity : aucune), posée avant chaque image. */
  cutAbove(z: number) {
    this.aboveZ = z;
    this.show();
  }

  /** Étiquette montrée ou non (vue du joueur : non), posé quand la caméra change ; le repère ne change pas. */
  setAids(on: boolean) { this.label.visible = on; }

  /** Taille de l'étiquette, comme celles des joueurs (un peu plus petite : texte court). */
  setTagSize(unitsPerPixel: number, px: number, top: boolean) {
    applyTag(this.label, tagSize(unitsPerPixel, px * 0.8, 3.2, top));
  }

  update(b: { state: string; pos: Vec3 | null; plantTick: number | null }, tick: number, tickrate: number) {
    this.shown = (b.state === "planted" || b.state === "dropped") && !!b.pos;
    if (this.shown) this.z = b.pos![2];
    this.show();
    if (!this.shown) return;
    const [x, y, z] = b.pos!;
    this.box.position.set(x, y, z + 4);
    this.label.position.set(x, y, z + 40);
    const text = b.state === "planted" && b.plantTick !== null
      ? `${Math.max(0, Math.ceil(BOMB_TIME_S - (tick - b.plantTick) / tickrate))} s` : "C4";
    if (text !== this.text) {
      this.text = text;
      paintTag(this.canvas, text);
      (this.label.material as SpriteMaterial).map!.needsUpdate = true;
    }
  }

  private show() { this.group.visible = this.shown && this.z <= this.aboveZ; }

  dispose() {
    this.box.geometry.dispose();
    (this.box.material as MeshBasicMaterial).dispose();
    (this.label.material as SpriteMaterial).map?.dispose();
    (this.label.material as SpriteMaterial).dispose();
  }
}
