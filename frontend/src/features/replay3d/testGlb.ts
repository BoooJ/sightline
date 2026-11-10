/** Petits .glb fabriqués en mémoire pour les tests (vitest et Playwright), au format des fichiers `vue` de
 *  scripts/map3d : bras avec un os « wpn » et un triangle visible ; arme avec son modèle sous « sl_arme », le squelette
 *  des clips sous « sl_clips » (un second « weapon », renommé « weapon_1 » par GLTFLoader) et des clips nommés par rôle.
 *  Et une carte texturée : un sol d'une couleur unie, dont l'image est dans le fichier. */
const enc = new TextEncoder();

function glb(json: object, bin: Uint8Array): Uint8Array<ArrayBuffer> {
  const js = enc.encode(JSON.stringify(json)), jsPad = (4 - (js.length % 4)) % 4, binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + js.length + jsPad + 8 + bin.length + binPad;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);  // « glTF »
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, js.length + jsPad, true);
  dv.setUint32(16, 0x4e4f534a, true);  // JSON
  out.set(js, 20);
  out.fill(0x20, 20 + js.length, 20 + js.length + jsPad);
  const o = 20 + js.length + jsPad;
  dv.setUint32(o, bin.length + binPad, true);
  dv.setUint32(o + 4, 0x004e4942, true);  // BIN
  out.set(bin, o + 8);
  return out;
}

/** Tampon binaire et accessors glTF, ajoutés à la suite (flottants seulement). */
function packer() {
  const parts: number[][] = [], accessors: object[] = [], bufferViews: object[] = [];
  let offset = 0;
  const add = (values: number[], type: "SCALAR" | "VEC2" | "VEC3" | "VEC4", minmax = false) => {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], count = values.length / size;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: values.length * 4 });
    const acc: Record<string, unknown> = { bufferView: bufferViews.length - 1, componentType: 5126, count, type };
    if (minmax) {
      acc.min = Array.from({ length: size }, (_, k) => Math.min(...values.filter((_, i) => i % size === k)));
      acc.max = Array.from({ length: size }, (_, k) => Math.max(...values.filter((_, i) => i % size === k)));
    }
    accessors.push(acc);
    parts.push(values);
    offset += values.length * 4;
    return accessors.length - 1;
  };
  const bin = () => new Uint8Array(new Float32Array(parts.flat()).buffer);
  return { add, accessors, bufferViews, bin, length: () => offset };
}

// triangle en bas à droite de l'œil (repère des bras : regard +Z, haut +Y, droite −X)
const TRIANGLE = [-0.2, -0.2, 0.4, -0.05, -0.1, 0.4, -0.1, -0.3, 0.4];
/** Position de l'os wpn au repos (AK-47 de l'essai : 13 cm à droite, 6 cm plus bas, 37 cm devant). */
export const WPN_IDLE = [-0.1315, -0.063, 0.3749];
/** Rotation que les clips de vue donnent à l'os racine « weapon » (axes Source → glTF). */
export const SRC_Q = [-0.5, -0.5, -0.5, 0.5];

export function armsGlb(): Uint8Array<ArrayBuffer> {
  const p = packer(), pos = p.add(TRIANGLE, "VEC3", true);
  return glb({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: "bras", children: [1, 2] }, { name: "wpn", translation: [0, 0, 0.5] }, { name: "gants", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: pos } }] }],
    accessors: p.accessors, bufferViews: p.bufferViews, buffers: [{ byteLength: p.length() }],
  }, p.bin());
}

/** Arme : idle (1 clé), draw (1 s, l'arme monte de 30 cm), shoot (0,5 s, l'arme recule de 7 cm). */
export function weaponGlb(): Uint8Array<ArrayBuffer> {
  const p = packer(), pos = p.add(TRIANGLE.map((v, i) => (i % 3 === 2 ? v + 0.1 : v)), "VEC3", true);
  const t0 = p.add([0], "SCALAR", true), t1 = p.add([0, 1], "SCALAR", true), t05 = p.add([0, 0.5], "SCALAR", true);
  const idle = p.add(WPN_IDLE, "VEC3"), q = p.add(SRC_Q, "VEC4"), zero = p.add([0, 0, 0], "VEC3");
  const draw = p.add([WPN_IDLE[0], WPN_IDLE[1] - 0.3, WPN_IDLE[2], ...WPN_IDLE], "VEC3");
  const shoot = p.add([...WPN_IDLE, WPN_IDLE[0], WPN_IDLE[1], WPN_IDLE[2] - 0.07], "VEC3");
  // nœud 4 : wpn ; nœud 5 : weapon du squelette des clips (les pistes visent ce nœud, le modèle a le sien en nœud 1)
  const anim = (name: string, input: number, wpn: number) => ({ name,
    samplers: [{ input, output: wpn }, { input: t0, output: q }, { input: t0, output: zero }],
    channels: [{ sampler: 0, target: { node: 4, path: "translation" } }, { sampler: 1, target: { node: 5, path: "rotation" } },
      { sampler: 2, target: { node: 5, path: "translation" } }] });
  return glb({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 3] }],
    nodes: [{ name: "sl_arme", children: [1] }, { name: "weapon", translation: [-0.005, 0.0757, 0.0754], children: [2] },
      { name: "corps", mesh: 0 }, { name: "sl_clips", children: [4, 5] }, { name: "wpn" }, { name: "weapon" }],
    meshes: [{ primitives: [{ attributes: { POSITION: pos } }] }],
    animations: [anim("idle", t0, idle), anim("draw", t1, draw), anim("shoot", t05, shoot)],
    accessors: p.accessors, bufferViews: p.bufferViews, buffers: [{ byteLength: p.length() }],
  }, p.bin());
}

/** Image PNG unie de `w` × `h` pixels (RVB), sans compression (un bloc « stored » de zlib, 65 535 octets au plus). */
export function solidPng(w: number, h: number, rgb: readonly [number, number, number]): Uint8Array<ArrayBuffer> {
  const crc = (b: Uint8Array) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(enc.encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);  // 8 bits par composante, RVB, deflate, filtres standard, sans entrelacement
  const raw = new Uint8Array(h * (1 + 3 * w));  // par ligne : filtre 0, puis les pixels
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (1 + 3 * w) + 1 + 3 * x);
  const z = new Uint8Array(2 + 5 + raw.length + 4), zv = new DataView(z.buffer);
  z.set([0x78, 0x01, 1, raw.length & 0xff, raw.length >> 8, ~raw.length & 0xff, (~raw.length >> 8) & 0xff]);
  z.set(raw, 7);
  let a = 1, b = 0;
  for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  zv.setUint32(7 + raw.length, ((b << 16) | a) >>> 0);  // Adler-32
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", z),
    chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Carte texturée : un sol carré à plat (glTF : Y en haut), de `half` m de demi-côté, d'une couleur unie (image PNG de
 *  4 × 4 pixels dans le fichier, envoyée à la carte graphique comme celles des vraies cartes). */
export function texturedMapGlb(rgb: readonly [number, number, number] = [230, 30, 30], half = 2000): Uint8Array<ArrayBuffer> {
  const p = packer(), S = half;
  const pos = p.add([-S, 0, -S, S, 0, -S, S, 0, S, -S, 0, -S, S, 0, S, -S, 0, S], "VEC3", true);
  const uv = p.add([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], "VEC2");
  const png = solidPng(4, 4, rgb), floats = p.bin(), pad = (4 - (png.length % 4)) % 4;
  p.bufferViews.push({ buffer: 0, byteOffset: floats.length, byteLength: png.length });
  const bin = new Uint8Array(floats.length + png.length + pad);
  bin.set(floats);
  bin.set(png, floats.length);
  return glb({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "sol", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: pos, TEXCOORD_0: uv }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [{ bufferView: p.bufferViews.length - 1, mimeType: "image/png" }],
    accessors: p.accessors, bufferViews: p.bufferViews, buffers: [{ byteLength: bin.length }],
  }, bin);
}

// ---------------------------------------------------------------- fichiers « joueurs » (agentGlb, animsGlb, mondeGlb)

/** Squelette des agents de test, aux noms de CS2 (mètres, Y en haut, regard +Z, gauche +X). Indices : 0 racine, 1
 *  root_motion, 2 pelvis, 3 à 6 spine_0 à spine_3, 7 head_0, 8 clavicle_R, 9 hand_R, 10 wpnPivot, 11 wpn. */
const SKELETON = [
  { name: "agent", children: [1] },
  { name: "root_motion", children: [2, 10] },
  { name: "pelvis", translation: [0, 1, 0], children: [3] },
  { name: "spine_0", translation: [0, 0.1, 0], children: [4] },
  { name: "spine_1", translation: [0, 0.1, 0], children: [5] },
  { name: "spine_2", translation: [0, 0.1, 0], children: [6] },
  { name: "spine_3", translation: [0, 0.1, 0], children: [7, 8] },
  { name: "head_0", translation: [0, 0.25, 0] },
  { name: "clavicle_R", translation: [-0.1, 0, 0], children: [9] },
  { name: "hand_R", translation: [-0.1, -0.3, 0.25] },
  { name: "wpnPivot", translation: [0, 1.4, 0], children: [11] },
  { name: "wpn", translation: [-0.2, -0.05, 0.3] },
];
const PELVIS = 2;

/** Agent (agent-ct, agent-t) : le squelette, un triangle sous le bassin (thirdperson_body, non skinné : il suit le bassin)
 *  et un kit de désamorçage (defusekit) sous spine_0. */
export function agentGlb(): Uint8Array<ArrayBuffer> {
  const p = packer(), pos = p.add([-0.2, 0, 0, 0.2, 0, 0, 0, 0.6, 0], "VEC3", true);
  const nodes = structuredClone(SKELETON) as { name: string; children?: number[]; mesh?: number }[];
  nodes[PELVIS].children!.push(12);
  nodes[3].children!.push(13);
  nodes.push({ name: "thirdperson_body", mesh: 0 }, { name: "defusekit", mesh: 0 });
  return glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: pos } }] }],
    accessors: p.accessors, bufferViews: p.bufferViews, buffers: [{ byteLength: p.length() }] }, p.bin());
}

/** Clips de test : nom → [instants, hauteurs du bassin (m)] ; le bassin seul est animé. */
type ClipDef = Record<string, [number[], number[]]>;
const DIR8 = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
/** Jeu de clips d'une classe (anims-rifle, anims-pistol, anims-knife) : repos, 8 directions de marche, course et accroupi,
 *  saut et vol sur place, désamorçage, pose du C4. */
export const CLASS_CLIPS: ClipDef = {
  idle: [[0], [1]], idle_crouch: [[0], [0.6]], jump_stand: [[0, 0.4], [1, 1.2]], inair_stand: [[0, 0.3333], [1.2, 1.2]],
  defuse_enter: [[0, 1], [1, 0.7]], defuse: [[0, 2], [0.7, 0.7]], plant: [[0, 3.3], [0.7, 0.7]],
  ...Object.fromEntries(DIR8.flatMap((d) => [[`walk_${d}`, [[0, 1], [1, 1.04]]], [`run_${d}`, [[0, 0.7333], [1, 1.08]]],
    [`crouch_${d}`, [[0, 0.8], [0.6, 0.64]]]])),
};
/** Jeu « communes » : une mort (le bassin tombe de 1 m à 0,15 m en 2,5 s) et un atterrissage. */
export const COMMON_CLIPS: ClipDef = { mort_chest_a: [[0, 2.5], [1, 0.15]], land_rifle: [[0, 0.6333], [0.8, 1]] };

/** Fichier de clips (anims-<jeu>) : le squelette sans maillage et les clips nommés par rôle. */
export function animsGlb(clips: ClipDef = CLASS_CLIPS): Uint8Array<ArrayBuffer> {
  const p = packer(), animations = Object.entries(clips).map(([name, [times, ys]]) => ({ name,
    samplers: [{ input: p.add(times, "SCALAR", true), output: p.add(ys.flatMap((y) => [0, y, 0]), "VEC3") }],
    channels: [{ sampler: 0, target: { node: PELVIS, path: "translation" } }] }));
  return glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: SKELETON, animations,
    accessors: p.accessors, bufferViews: p.bufferViews, buffers: [{ byteLength: p.length() }] }, p.bin());
}

/** Arme du monde (monde-<clé>) : modèle sous « sl_arme », os racine « weapon » à sa pose de repos (rotation des axes
 *  Source), un triangle. */
export function mondeGlb(): Uint8Array<ArrayBuffer> {
  const p = packer(), pos = p.add([0, 0, -0.3, 0, 0.1, 0.4, 0, -0.1, 0.4], "VEC3", true);
  return glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: "sl_arme", children: [1] }, { name: "weapon", translation: [-0.005, 0.0757, 0.0754], rotation: SRC_Q, children: [2] },
      { name: "corps", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: pos } }] }],
    accessors: p.accessors, bufferViews: p.bufferViews, buffers: [{ byteLength: p.length() }] }, p.bin());
}

// ---------------------------------------------------------------- ragdoll et collision (morts en ragdoll)

/** Ragdoll des agents de test (fichier « ragdoll », format de scripts/map3d/lib/ragdoll.mjs), INVENTÉ (masses assez fortes
 *  pour qu'une force de fusil estimée ne l'envoie pas hors du monde local de 256 u autour de la mort) et calé sur le
 *  squelette de test : bassin (capsule de 20 u vers le haut de l'os, axe y du modèle) et tête (sphère), une rotule au cou
 *  (la tête est 0,65 m = 25,6 u au-dessus du bassin) ; repères des os, pouces ; bindPose : axes du modèle dans ceux du jeu. */
export const AGENT_RAGDOLL = {
  v: 1, bones: ["pelvis", "head_0"],
  bindPose: [[0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 39.37], [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 64.96]],
  parts: [{ mass: 200, linDamp: 0, angDamp: 2, inertiaScale: 5, spheres: [], capsules: [{ a: [0, 0, 0], b: [0, 20, 0], r: 6 }] },
    { mass: 50, linDamp: 0, angDamp: 1, inertiaScale: 5, spheres: [{ c: [0, 4, 0], r: 5 }], capsules: [] }],
  joints: [{ type: 4, a: 0, b: 1, fa: [0, 25.6, 0, 1, 0, 0, 0, 1], fb: [0, 0, 0, 1, 0, 0, 0, 1], swing: 0.5, twist: [-0.3, 0.3] }],
};

/** Fichier « ragdoll » : une scène vide « sl_ragdoll », le ragdoll dans ses extras. */
export function ragdollGlb(rag: object = AGENT_RAGDOLL): Uint8Array<ArrayBuffer> {
  return glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ name: "sl_ragdoll", extras: { sl_ragdoll: rag } }] }, new Uint8Array(0));
}

/** Fichier « collision » d'une carte de test (contrat de scripts/map3d/lib/collision.mjs : maillage sl_collision dans le
 *  repère de l'export, extras sl_collision) : un carré à plat de `half` unités de demi-côté sous chaque point (x, y, z) du
 *  jeu. */
export function collisionGlb(points: readonly (readonly [number, number, number])[], half = 400): Uint8Array<ArrayBuffer> {
  const p = packer(), pos: number[] = [], I = 0.0254;
  const at = (x: number, y: number, z: number) => [y * I, z * I, x * I];  // jeu → repère de l'export (SOURCE_TO_GLTF)
  for (const [x, y, z] of points.length ? points : [[0, 0, 0] as const]) {
    pos.push(...at(x - half, y - half, z), ...at(x + half, y - half, z), ...at(x + half, y + half, z),
      ...at(x - half, y - half, z), ...at(x + half, y + half, z), ...at(x - half, y + half, z));
  }
  const acc = p.add(pos, "VEC3", true);
  return glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0], extras: { sl_collision: { v: 1, error_u: 2 } } }],
    nodes: [{ name: "sl_collision", mesh: 0 }], meshes: [{ name: "sl_collision", primitives: [{ attributes: { POSITION: acc } }] }],
    accessors: p.accessors, bufferViews: p.bufferViews, buffers: [{ byteLength: p.length() }] }, p.bin());
}
