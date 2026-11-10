import type { WireArray } from "../../../shared/api/types";
export type Typed = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int32Array | Int16Array;

const CTORS: Record<string, { new (b: ArrayBuffer): Typed; BYTES_PER_ELEMENT: number }> = {
  "<f4": Float32Array, "<u1": Uint8Array, "|u1": Uint8Array, "<u2": Uint16Array, "<u4": Uint32Array, "<i4": Int32Array,
  "<i2": Int16Array,
};

/** Copie les octets dans un ArrayBuffer aligné puis crée la vue typée (little-endian, comme x86/ARM). */
function raw(a: WireArray): Typed {
  const C = CTORS[a.dtype];
  if (!C) throw new Error(`dtype non supporté : ${a.dtype}`);
  const buf = new ArrayBuffer(a.data.byteLength);
  new Uint8Array(buf).set(a.data);
  return new C(buf);
}

/** Décode un tableau du format de transport. `n` × `m` (images × joueurs) est requis pour l'encodage « dpm ». */
export function decodeWireArray(a: WireArray, n = 0, m = 0): Typed {
  const v = raw(a);
  if (a.enc === "dpm") {
    // différences successives par joueur, rangées joueur par joueur → float32 rangé image par image
    const out = new Float32Array(n * m), inv = 1 / (a.scale ?? 1);
    for (let j = 0; j < m; j++) {
      let acc = 0;
      for (let i = 0; i < n; i++) { acc += v[j * n + i]; out[i * m + j] = acc * inv; }
    }
    return out;
  }
  if (a.enc === "d") {
    const out = new Uint32Array(v.length);
    let acc = 0;
    for (let i = 0; i < v.length; i++) { acc += v[i]; out[i] = acc; }
    return out;
  }
  return v;
}
