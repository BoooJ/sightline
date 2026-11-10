// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferGeometry, CanvasTexture, DataTexture, Group, type Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, Texture,
  WebGLRenderTarget } from "three";
import { disposeTree, freeImages, freeImagesAfterUpload, imagesFreed } from "./dispose";

// ImageBitmap absent de jsdom : image décodée factice, qui compte ses fermetures (`close` rend sa mémoire tout de suite)
class Bitmap { width = 512; height = 512; closed = 0; close() { this.closed++; this.width = this.height = 0; } }
beforeEach(() => vi.stubGlobal("ImageBitmap", Bitmap));
afterEach(() => vi.unstubAllGlobals());

const bitmap = () => new Bitmap() as Bitmap & ImageBitmap;
const mesh = (mat: Material) => new Mesh(new BufferGeometry(), mat);
/** Envoi d'une texture à la carte graphique, comme three (`WebGLTextures.uploadTexture`) : son image est lue (notée), puis
 *  `onUpdate` ; sans image, rien n'est envoyé (three : avertissement, texture vide). */
const read: unknown[] = [];
const upload = (t: Texture) => {
  if (t.image === null) return false;
  read.push(t.image);
  t.onUpdate?.(t);
  return true;
};
afterEach(() => { read.length = 0; });

describe("images des textures libérées après leur envoi à la carte graphique", () => {
  it("au premier envoi seulement, jamais avant ; une texture jamais dessinée (hors du champ) garde la sienne", () => {
    const a = bitmap(), b = bitmap(), c = bitmap();
    const map = new Texture(a), normalMap = new Texture(b), far = new Texture(c);
    const root = new Group().add(mesh(new MeshStandardMaterial({ map, normalMap })), mesh(new MeshBasicMaterial({ map: far })));
    freeImagesAfterUpload(root);
    expect([a.closed, b.closed, c.closed]).toEqual([0, 0, 0]);  // carte posée, pas encore dessinée : rien de libéré
    expect(map.image).toBe(a);
    expect(imagesFreed(root)).toBe(false);
    expect(upload(map)).toBe(true);
    expect(read).toEqual([a]);  // lue par l'envoi, libérée ensuite
    expect(a.closed).toBe(1);
    expect(map.image).toBeNull();
    expect(imagesFreed(root)).toBe(true);
    upload(normalMap);
    expect([b.closed, c.closed]).toEqual([1, 0]);
    expect(far.image).toBe(c);
  });

  it("même texture dans plusieurs matériaux, ou pour deux propriétés (ORM : rugosité et métal) : libérée une fois", () => {
    const a = bitmap(), orm = new Texture(a);
    const root = new Group().add(mesh(new MeshStandardMaterial({ roughnessMap: orm, metalnessMap: orm })),
      mesh(new MeshStandardMaterial({ roughnessMap: orm })));
    freeImagesAfterUpload(root);
    upload(orm);
    expect(a.closed).toBe(1);
    expect(upload(orm)).toBe(false);  // déjà envoyée : three ne la relit plus
  });

  it("image partagée par plusieurs textures (clone aux autres réglages : three l'envoie pour chacune) : gardée", () => {
    const a = bitmap(), t = new Texture(a), other = t.clone();
    other.anisotropy = 4;
    const root = new Group().add(mesh(new MeshBasicMaterial({ map: t })), mesh(new MeshBasicMaterial({ map: other })));
    freeImagesAfterUpload(root);
    upload(t);
    expect(upload(other)).toBe(true);
    expect(a.closed).toBe(0);
    expect(imagesFreed(root)).toBe(false);
  });

  it("seules les images décodées (ImageBitmap, image du DOM) : jamais les données des autres textures (os, rendus, canvas)", () => {
    const data = new DataTexture(new Uint8Array(16), 2, 2), canvas = new CanvasTexture(document.createElement("canvas"));
    const target = new WebGLRenderTarget(4, 4), img = document.createElement("img"), dom = new Texture(img);
    const root = new Group().add(mesh(new MeshStandardMaterial({ map: data, emissiveMap: canvas, envMap: target.texture })),
      mesh(new MeshBasicMaterial({ map: dom })));
    const before = [data.image, canvas.image, target.texture.image];
    freeImagesAfterUpload(root);
    for (const t of [data, canvas, target.texture, dom]) upload(t);
    expect([data.image, canvas.image, target.texture.image]).toEqual(before);  // gardées : relues à chaque envoi
    // image du DOM (navigateurs sans createImageBitmap : GLTFLoader passe alors par TextureLoader) : libérée aussi
    expect(dom.image).toBeNull();
    expect(imagesFreed(root)).toBe(true);
  });

  it("un onUpdate déjà posé est gardé (appelé, puis l'image libérée)", () => {
    const a = bitmap(), t = new Texture(a), seen: unknown[] = [];
    t.onUpdate = (x) => seen.push(x.image);
    freeImagesAfterUpload(new Group().add(mesh(new MeshBasicMaterial({ map: t }))));
    upload(t);
    expect(seen).toEqual([a]);
    expect(a.closed).toBe(1);
  });
});

describe("disposeTree", () => {
  it("libère géométries, matériaux et textures, et ferme les images encore gardées (envoyées ou non), une fois chacune", () => {
    const a = bitmap(), b = bitmap(), sent = new Texture(a), kept = new Texture(b);
    const mat = new MeshStandardMaterial({ map: sent, normalMap: kept }), m = mesh(mat), root = new Group().add(m);
    const freed = { geometry: vi.fn(), material: vi.fn(), sent: vi.fn(), kept: vi.fn() };
    m.geometry.addEventListener("dispose", freed.geometry);
    mat.addEventListener("dispose", freed.material);
    sent.addEventListener("dispose", freed.sent);
    kept.addEventListener("dispose", freed.kept);
    freeImagesAfterUpload(root);
    upload(sent);
    disposeTree(root);
    expect(Object.values(freed).map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect([a.closed, b.closed]).toEqual([1, 1]);  // déjà libérée : pas fermée deux fois
    expect([sent.image, kept.image]).toEqual([null, null]);
  });

  it("freeImages (arbre d'un contexte graphique perdu) : images encore gardées fermées, rien de libéré sur la carte graphique", () => {
    const a = bitmap(), b = bitmap(), sent = new Texture(a), kept = new Texture(b), data = new DataTexture(new Uint8Array(16), 2, 2);
    const mat = new MeshStandardMaterial({ map: sent, normalMap: kept, aoMap: data }), m = mesh(mat), root = new Group().add(m);
    const freed = vi.fn();
    for (const x of [m.geometry, mat, sent, kept, data]) x.addEventListener("dispose", freed);
    freeImagesAfterUpload(root);
    upload(sent);
    const pixels = data.image;
    freeImages(root);
    expect([a.closed, b.closed]).toEqual([1, 1]);
    expect(freed).not.toHaveBeenCalled();
    expect(data.image).toBe(pixels);
  });
});
