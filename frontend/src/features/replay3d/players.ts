import { BoxGeometry, BufferGeometry, type Camera, CanvasTexture, CapsuleGeometry, Color, Float32BufferAttribute, Group, Line,
  LineBasicMaterial, Mesh, MeshBasicMaterial, MeshLambertMaterial, type OrthographicCamera, type PerspectiveCamera,
  type Plane, type Raycaster, Sprite, SpriteMaterial } from "three";
import type { KillEvent } from "../../shared/api/types";
import type { PlayerState } from "../replay/engine/state";
import type { Theme } from "../replay/renderer/theme";
import { BODY_H, BODY_R, EYE_Z, yawDir } from "./world";

/** Étiquette dessinée sur un canvas (texte, en blanc ou de la couleur `color`, et, si `hp` est donné, une barre de vie). */
export function paintTag(canvas: HTMLCanvasElement, text: string, hp?: number, color = "#ffffff") {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "600 26px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.fillStyle = color;
  ctx.strokeText(text, canvas.width / 2, 2); ctx.fillText(text, canvas.width / 2, 2);
  if (hp === undefined) return;
  const w = canvas.width * 0.6, x = (canvas.width - w) / 2;
  ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(x, 38, w, 10);
  ctx.fillStyle = hp > 50 ? "#4ade80" : hp > 20 ? "#facc15" : "#ef4444"; ctx.fillRect(x, 38, (w * hp) / 100, 10);
}

/** Hauteur à l'écran des étiquettes (px) : au moins 22 (texte d'environ 11 px), 2 % de la vue sur un grand écran. */
export const tagPx = (canvasHeight: number) => Math.max(22, canvasHeight * 0.02);

/** Échelle d'un sprite sans atténuation (`sizeAttenuation: false`) pour un pixel du canvas (`h` px de haut). En
 *  perspective, three la multiplie par la distance : elle se compte en hauteur de vue (2·tan(fov/2) pour tout le
 *  canvas). En orthographique (vue de dessus), elle reste en unités du jeu (2 × demi-hauteur pour tout le canvas). */
export function unitsPerPx(cam: Camera, h: number): number {
  const c = cam as PerspectiveCamera & OrthographicCamera;
  const view = c.isOrthographicCamera ? c.top - c.bottom : 2 * Math.tan((c.fov * Math.PI) / 360);
  return view / c.zoom / Math.max(1, h);
}

/** Taille d'étiquette : échelle (largeur, hauteur) et ancrage vertical. Vue de dessus : l'étiquette passe au-dessus du
 *  point du joueur, qu'elle cacherait sinon (en perspective, elle est déjà posée au-dessus de la tête). */
export interface TagSize { w: number; h: number; anchor: number }
export const tagSize = (unitsPerPixel: number, px: number, aspect: number, top: boolean): TagSize =>
  ({ w: px * unitsPerPixel * aspect, h: px * unitsPerPixel, anchor: top ? -0.4 : 0.5 });
export function applyTag(s: Sprite, t: TagSize) {
  s.scale.set(t.w, t.h, 1);
  s.center.set(0.5, t.anchor);
}
const TAG_ASPECT = 5;  // canvas de 256 × 52

/** Joueur dessiné en modèle d'agent, en perspective : bas de sa barre de vie (ancre du sprite, ligne 48 du canvas de 52)
 *  à MODEL_TAG_Z unités au-dessus des pieds, debout comme accroupi. Hauteur réglée à l'essai réel du 06/11/2026, juste
 *  au-dessus du sommet de la tête (≈ 72) : ancrée dans le monde, l'étiquette est
 *  à la même hauteur au-dessus de la tête de près comme de loin (seule sa taille à l'écran reste constante). La
 *  silhouette, elle, garde son étiquette centrée 26 u au-dessus d'elle. */
export const MODEL_TAG_Z = 73;
const TAG_BOTTOM = 4 / 52;

/** `shown` : joueur en vie et pas celui dont on prend la vue (silhouette dessinée, ou cachée sous son modèle d'agent, mais
 *  toujours cliquable) ; `z` : du dernier instant, pour replacer l'étiquette (`setModelled`). */
interface Item { body: Mesh; look: Line; label: Sprite; canvas: HTMLCanvasElement; halo: Sprite; key: string; shown: boolean;
  z: number }

/** Joueurs : silhouette aux couleurs de l'équipe, pseudo et PV, trait du regard, halo quand il est flashé ; croix au
 *  sol à l'endroit de chaque mort du round. Le joueur choisi : silhouette et nom de l'étiquette à la couleur d'accent.
 *  Seules les croix suivent la coupe « au-dessus de » (`clip`, voir `abovePlanes`) : un joueur de l'étage du dessus reste
 *  visible en vue de dessus. Un joueur dessiné en modèle d'agent (agentLayer.ts, `setModelled`) n'a plus de silhouette
 *  visible (elle sert encore au clic), ni de croix sous son corps ; le nom à la couleur d'accent le désigne alors seul. */
export class PlayerLayer {
  readonly group = new Group();
  private items = new Map<string, Item>();
  private crosses = new Group();
  private crossKey: { n: number; last: KillEvent | null } = { n: -1, last: null };
  private modelled = new Set<string>();
  // comparaison et copie de l'ensemble de setModelled par forEach (appelé à chaque image : pas d'itérateur alloué)
  private same = true;
  private probe = (sid: string) => { if (!this.modelled.has(sid)) this.same = false; };
  private copy = (sid: string) => { this.modelled.add(sid); };
  private deaths: KillEvent[] = [];
  private accent: string;
  private bodyGeo = new CapsuleGeometry(BODY_R, BODY_H - 2 * BODY_R, 4, 12).rotateX(Math.PI / 2);  // axe Y → Z
  private crossGeo = new BoxGeometry(44, 7, 2);
  private mats: Record<"CT" | "T", MeshLambertMaterial>;
  private selMat: MeshLambertMaterial;
  private lineMat: LineBasicMaterial;
  private crossMat: MeshBasicMaterial;
  private haloMat: SpriteMaterial;
  private tag: TagSize = { w: 0.12, h: 0.024, anchor: 0.5 };
  private top = false;  // vue de dessus (setTagSize)

  constructor(theme: Theme, clip: Plane[]) {
    this.mats = { CT: new MeshLambertMaterial({ color: new Color(theme.ct) }), T: new MeshLambertMaterial({ color: new Color(theme.t) }) };
    this.selMat = new MeshLambertMaterial({ color: new Color(theme.accent), emissive: new Color(theme.accent), emissiveIntensity: 0.4 });
    this.lineMat = new LineBasicMaterial({ color: new Color(theme.fg) });
    this.crossMat = new MeshBasicMaterial({ color: new Color(theme.fg), transparent: true, opacity: 0.8, clippingPlanes: clip });
    this.haloMat = new SpriteMaterial({ color: new Color(theme.flash), transparent: true, depthWrite: false });
    this.accent = theme.accent;
    this.group.add(this.crosses);
  }

  /** `hidden` : joueur dont on prend la vue (vue du joueur) ; ni corps, ni regard, ni étiquette, ni halo devant l'œil. Ses
   *  objets restent dans le groupe, seulement cachés. `aids` : aides d'analyse (étiquette de pseudo et de vie, trait du
   *  regard, halo des flashés, croix des morts) ; faux en vue du joueur, qui ne montre que les corps, comme ce que voyait
   *  le joueur : leurs objets sont alors cachés et laissés tels quels (rien à dessiner), et reprennent leur place au
   *  prochain `update` avec `aids` vrai. */
  update(states: PlayerState[], deaths: KillEvent[], selected: string | null, hidden: string | null = null, aids = true) {
    // un joueur absent des états courants (autre round, autre match de la playlist) quitte la scène
    const seen = new Set(states.map((p) => p.steamid));
    for (const [sid, it] of this.items) if (!seen.has(sid)) this.drop(sid, it);
    for (const p of states) {
      const it = this.items.get(p.steamid) ?? this.create(p);
      const shown = p.alive && p.steamid !== hidden, tagged = shown && aids;
      it.shown = shown;
      it.body.visible = shown && !this.modelled.has(p.steamid);
      it.look.visible = it.label.visible = tagged;
      it.halo.visible = tagged && p.flash > 0;
      if (!shown) continue;
      it.body.material = p.steamid === selected ? this.selMat : this.mats[p.side];
      it.body.position.set(p.x, p.y, p.z + BODY_H / 2);
      if (!tagged) continue;
      const d = yawDir(p.yaw), pos = it.look.geometry.getAttribute("position");
      pos.setXYZ(0, p.x, p.y, p.z + EYE_Z);
      pos.setXYZ(1, p.x + d[0] * 90, p.y + d[1] * 90, p.z + EYE_Z);
      pos.needsUpdate = true;
      it.look.geometry.computeBoundingSphere();
      it.z = p.z;
      it.label.position.x = p.x;
      it.label.position.y = p.y;
      this.placeTag(p.steamid, it);
      it.halo.position.set(p.x, p.y, p.z + EYE_Z);
      (it.halo.material as SpriteMaterial).opacity = Math.min(0.9, p.flash / 2);
      const chosen = p.steamid === selected, key = `${p.name}|${p.hp}|${p.hasBomb}|${chosen}`;
      if (key !== it.key) {
        it.key = key;
        paintTag(it.canvas, `${p.hasBomb ? "C4 · " : ""}${p.name}`, p.hp, chosen ? this.accent : undefined);
        (it.label.material as SpriteMaterial).map!.needsUpdate = true;
      }
    }
    this.crosses.visible = aids;
    this.deaths = deaths;
    this.drawCrosses(deaths);
  }

  /** Joueurs dessinés en modèle d'agent (agentLayer.ts), vivants et corps : silhouette cachée (le clic la trouve
   *  toujours), étiquette posée au-dessus de sa tête (MODEL_TAG_Z), pas de croix sous son corps. L'ensemble est copié (l'appelant
   *  peut le réécrire ensuite) ; le même contenu : rien. */
  setModelled(sids: ReadonlySet<string>) {
    if (sids.size === this.modelled.size) {
      this.same = true;
      sids.forEach(this.probe);
      if (this.same) return;
    }
    this.modelled.clear();
    sids.forEach(this.copy);
    for (const [sid, it] of this.items) {
      it.body.visible = it.shown && !this.modelled.has(sid);
      this.placeTag(sid, it);
    }
    this.crossKey = { n: -1, last: null };  // croix à refaire
    this.drawCrosses(this.deaths);
  }

  /** Taille des étiquettes, recalculée avant chaque image (voir `unitsPerPx`, `tagPx`). */
  setTagSize(unitsPerPixel: number, px: number, top: boolean) {
    this.tag = tagSize(unitsPerPixel, px, TAG_ASPECT, top);
    this.top = top;
    this.items.forEach(this.sizeTag);
  }

  /** Joueur sous le rayon (clic), ou null. */
  pick(ray: Raycaster): string | null {
    const bodies = [...this.items.values()].filter((i) => i.shown).map((i) => i.body);
    return (ray.intersectObjects(bodies, false)[0]?.object.userData.sid as string | undefined) ?? null;
  }

  dispose() {
    for (const [sid, it] of this.items) this.drop(sid, it);
    for (const x of [this.bodyGeo, this.crossGeo, this.mats.CT, this.mats.T, this.selMat, this.lineMat, this.crossMat, this.haloMat]) x.dispose();
  }

  private create(p: PlayerState): Item {
    const body = new Mesh(this.bodyGeo, this.mats[p.side]);
    body.userData.sid = p.steamid;
    const lookGeo = new BufferGeometry();
    lookGeo.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
    const look = new Line(lookGeo, this.lineMat);
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 52;
    const label = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), depthTest: false, sizeAttenuation: false }));
    applyTag(label, this.tag);
    label.renderOrder = 10;
    const halo = new Sprite(this.haloMat.clone());
    halo.scale.set(70, 70, 1);
    this.group.add(body, look, label, halo);
    const it = { body, look, label, canvas, halo, key: "", shown: false, z: 0 };
    this.items.set(p.steamid, it);
    return it;
  }

  private drop(sid: string, it: Item) {
    this.group.remove(it.body, it.look, it.label, it.halo);
    it.look.geometry.dispose();
    (it.label.material as SpriteMaterial).map?.dispose();
    (it.label.material as SpriteMaterial).dispose();
    (it.halo.material as SpriteMaterial).dispose();
    this.items.delete(sid);
  }

  /** Taille de l'étiquette, puis son ancre (forEach : sans allocation à chaque image). */
  private sizeTag = (it: Item, sid: string) => {
    applyTag(it.label, this.tag);
    if (this.modelled.has(sid) && !this.top) it.label.center.y = TAG_BOTTOM;
  };

  /** Hauteur et ancre de l'étiquette : silhouette, centre 26 u au-dessus d'elle ; joueur dessiné en modèle, en
   *  perspective, bas de la barre de vie à MODEL_TAG_Z au-dessus des pieds (voir MODEL_TAG_Z). */
  private placeTag(sid: string, it: Item) {
    const m = this.modelled.has(sid);
    it.label.position.z = it.z + (m ? MODEL_TAG_Z : BODY_H + 26);
    it.label.center.y = m && !this.top ? TAG_BOTTOM : this.tag.anchor;
  }

  private drawCrosses(deaths: KillEvent[]) {
    // dans un round, la liste ne change qu'en avançant ou en reculant : son nombre et sa dernière mort suffisent (un
    // autre round a d'autres objets, même avec autant de morts)
    const last = deaths[deaths.length - 1] ?? null;
    if (deaths.length === this.crossKey.n && last === this.crossKey.last) return;
    this.crossKey = { n: deaths.length, last };
    this.crosses.clear();
    for (const k of deaths) {
      if (this.modelled.has(k.victim)) continue;  // son corps est au sol (agentLayer.ts)
      const [x, y, z] = k.victim_pos;
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        const bar = new Mesh(this.crossGeo, this.crossMat);
        bar.position.set(x, y, z + 2);
        bar.rotation.z = a;
        this.crosses.add(bar);
      }
    }
  }
}
