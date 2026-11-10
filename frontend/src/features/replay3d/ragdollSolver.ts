/**
 * Ragdoll : corps rigides reliés par des articulations, simulés pas à pas (XPBD : positions corrigées, vitesses déduites),
 * dans le repère du jeu (unités, Z en haut, secondes). PUR et déterministe : mêmes entrées, même trajectoire (aucun
 * hasard, aucune horloge, ordre de calcul fixe). Ni three ni DOM : tourne dans un worker ou dans les tests.
 */

/** Repère d'une articulation dans celui de l'os de son corps : position (unités) et rotation (x, y, z, w). */
export interface JointFrame { p: [number, number, number]; q: [number, number, number, number] }
/** Articulation : corps a (parent) et b ; type 3 = charnière (axes de torsion alignés), 4 = rotule (cône) ; limites en
 *  radians (cône : angle max entre les axes de torsion ; torsion : [min, max] autour de cet axe, de a vers b). */
export interface RagdollJoint { a: number; b: number; type: 3 | 4; fa: JointFrame; fb: JointFrame; swing: number | null; twist: [number, number] | null }
/** Sphère de collision d'un corps, dans le repère de son os. */
export interface RagdollSphere { body: number; c: [number, number, number]; r: number }
export interface RagdollDef {
  bones: string[];                       // os de chaque corps
  mass: number[];
  com: [number, number, number][];       // centre de masse dans le repère de l'os
  inertia: number[][];                   // inverse du tenseur d'inertie (3 × 3, rangé par lignes) autour du centre de masse, repère de l'os
  linDamp: number[];
  angDamp: number[];
  spheres: RagdollSphere[];
  joints: RagdollJoint[];
}
/** Triangles de la carte près d'un point (indices dans `tri`, 9 nombres par triangle). */
export interface World { tri: Float32Array; near(x: number, y: number, z: number, r: number, out: number[]): number }
/** État de départ : os de chaque corps dans le repère du jeu (position, rotation), vitesses linéaire et angulaire. */
export interface RagdollStart { p: Float64Array; q: Float64Array; v: Float64Array; w: Float64Array }
/** Trajectoire : `frames` images toutes les `dt` s ; os de chaque corps (position 3, rotation 4) par image. */
export interface RagdollTrack { dt: number; frames: number; bodies: number; p: Float32Array; q: Float32Array }

export const GRAVITY = 800, DT = 1 / 60, SUBSTEPS = 4, MAX_S = 3, FRICTION = 0.8;
export const SLEEP_V = 6, SLEEP_W = 0.6, SLEEP_FRAMES = 20, MAX_V = 1500;
export const TWIST_AXIS = 2;  // axe de torsion des repères d'articulation : Z (sonde 0.3)

// ─── vecteurs et quaternions dans des tableaux, sans allocation ───
function qmulInto(o: Float64Array, oi: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number) {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3], bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by;
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
/** v tourné par le quaternion q[qi..] → o[oi..]. */
function rotInto(o: Float64Array, oi: number, q: ArrayLike<number>, qi: number, x: number, y: number, z: number) {
  const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  o[oi] = x + qw * tx + (qy * tz - qz * ty);
  o[oi + 1] = y + qw * ty + (qz * tx - qx * tz);
  o[oi + 2] = z + qw * tz + (qx * ty - qy * tx);
}
function normQ(q: Float64Array, i: number) {
  const l = Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3]) || 1;
  q[i] /= l; q[i + 1] /= l; q[i + 2] /= l; q[i + 3] /= l;
}

/** Simulation d'une mort : trajectoire des os des corps, de l'état de départ jusqu'au repos (ou MAX_S). */
export function simulate(def: RagdollDef, start: RagdollStart, world: World): RagdollTrack {
  const n = def.mass.length, h = DT / SUBSTEPS, maxFrames = Math.round(MAX_S / DT);
  const x = new Float64Array(3 * n), q = new Float64Array(4 * n), v = new Float64Array(3 * n), w = new Float64Array(3 * n);
  const xp = new Float64Array(3 * n), qp = new Float64Array(4 * n), invM = def.mass.map((m) => 1 / m);
  const T = new Float64Array(16);  // brouillon
  // centre de masse : os + rotation × com
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 4; c++) q[4 * i + c] = start.q[4 * i + c];
    normQ(q, 4 * i);  // départ non normalisé (le moteur refuse un quaternion nul)
    rotInto(T, 0, q, 4 * i, ...def.com[i]);
    for (let c = 0; c < 3; c++) { x[3 * i + c] = start.p[3 * i + c] + T[c]; v[3 * i + c] = start.v[3 * i + c]; w[3 * i + c] = start.w[3 * i + c]; }
  }
  /** Inverse d'inertie dans le repère du monde appliqué à (vx, vy, vz) → T[o..o+2]. */
  const iw = (i: number, vx: number, vy: number, vz: number, o: number) => {
    // repère du corps : rotation inverse, I⁻¹, rotation
    const qi = 4 * i, cx = -q[qi], cy = -q[qi + 1], cz = -q[qi + 2], cw = q[qi + 3];
    const tx = 2 * (cy * vz - cz * vy), ty = 2 * (cz * vx - cx * vz), tz = 2 * (cx * vy - cy * vx);
    const lx = vx + cw * tx + (cy * tz - cz * ty), ly = vy + cw * ty + (cz * tx - cx * tz), lz = vz + cw * tz + (cx * ty - cy * tx);
    const I = def.inertia[i];
    rotInto(T, o, q, qi, I[0] * lx + I[1] * ly + I[2] * lz, I[3] * lx + I[4] * ly + I[5] * lz, I[6] * lx + I[7] * ly + I[8] * lz);
  };
  /** Rotation de q[i] par le vecteur (petit) s : q += ½ [s, 0] q. */
  const turn = (i: number, sx: number, sy: number, sz: number) => {
    const qi = 4 * i, qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
    q[qi] += 0.5 * (sw0(sx, sy, sz, qx, qy, qz, qw, 0));
    q[qi + 1] += 0.5 * (sw0(sx, sy, sz, qx, qy, qz, qw, 1));
    q[qi + 2] += 0.5 * (sw0(sx, sy, sz, qx, qy, qz, qw, 2));
    q[qi + 3] += 0.5 * (-sx * qx - sy * qy - sz * qz);
    normQ(q, qi);
  };
  /** Déplace le point (rA du corps a) de dx par rapport au point (rB du corps b ; b < 0 : la carte, immobile). */
  const positional = (a: number, rax: number, ray: number, raz: number, b: number, rbx: number, rby: number, rbz: number,
    dx: number, dy: number, dz: number) => {
    const c = Math.hypot(dx, dy, dz);
    if (c < 1e-9) return;
    const nx = dx / c, ny = dy / c, nz = dz / c;
    let wsum = 0;
    // a
    let ux = ray * nz - raz * ny, uy = raz * nx - rax * nz, uz = rax * ny - ray * nx;
    iw(a, ux, uy, uz, 4);
    wsum += invM[a] + ux * T[4] + uy * T[5] + uz * T[6];
    if (b >= 0) {
      ux = rby * nz - rbz * ny; uy = rbz * nx - rbx * nz; uz = rbx * ny - rby * nx;
      iw(b, ux, uy, uz, 8);
      wsum += invM[b] + ux * T[8] + uy * T[9] + uz * T[10];
    }
    const lam = c / wsum, px = lam * nx, py = lam * ny, pz = lam * nz;
    x[3 * a] += px * invM[a]; x[3 * a + 1] += py * invM[a]; x[3 * a + 2] += pz * invM[a];
    iw(a, ray * pz - raz * py, raz * px - rax * pz, rax * py - ray * px, 4);
    turn(a, T[4], T[5], T[6]);
    if (b >= 0) {
      x[3 * b] -= px * invM[b]; x[3 * b + 1] -= py * invM[b]; x[3 * b + 2] -= pz * invM[b];
      iw(b, rby * pz - rbz * py, rbz * px - rbx * pz, rbx * py - rby * px, 8);
      turn(b, -T[8], -T[9], -T[10]);
    }
  };
  /** Tourne le corps a de (cx, cy, cz) (vecteur de rotation) par rapport au corps b, partagé selon leurs inerties. */
  const angular = (a: number, b: number, cx: number, cy: number, cz: number) => {
    const th = Math.hypot(cx, cy, cz);
    if (th < 1e-9) return;
    const nx = cx / th, ny = cy / th, nz = cz / th;
    iw(a, nx, ny, nz, 4);
    iw(b, nx, ny, nz, 8);
    const lam = th / (nx * T[4] + ny * T[5] + nz * T[6] + nx * T[8] + ny * T[9] + nz * T[10]);
    iw(a, lam * nx, lam * ny, lam * nz, 4);
    turn(a, T[4], T[5], T[6]);
    iw(b, lam * nx, lam * ny, lam * nz, 8);
    turn(b, -T[8], -T[9], -T[10]);
  };
  const J = new Float64Array(24);  // repères des articulations, axes
  const ax = TWIST_AXIS, rx = (TWIST_AXIS + 1) % 3;
  const E = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const joints = () => {
    for (const j of def.joints) {
      // ancres
      rotInto(T, 0, q, 4 * j.a, j.fa.p[0] - def.com[j.a][0], j.fa.p[1] - def.com[j.a][1], j.fa.p[2] - def.com[j.a][2]);
      const rax = T[0], ray = T[1], raz = T[2];
      rotInto(T, 0, q, 4 * j.b, j.fb.p[0] - def.com[j.b][0], j.fb.p[1] - def.com[j.b][1], j.fb.p[2] - def.com[j.b][2]);
      const rbx = T[0], rby = T[1], rbz = T[2];
      positional(j.a, rax, ray, raz, j.b, rbx, rby, rbz,
        x[3 * j.b] + rbx - x[3 * j.a] - rax, x[3 * j.b + 1] + rby - x[3 * j.a + 1] - ray, x[3 * j.b + 2] + rbz - x[3 * j.a + 2] - raz);
      // axes de torsion (z) et de référence (r) des deux repères
      qmulInto(J, 0, q, 4 * j.a, j.fa.q, 0);
      qmulInto(J, 4, q, 4 * j.b, j.fb.q, 0);
      rotInto(J, 8, J, 0, E[ax][0], E[ax][1], E[ax][2]);
      rotInto(J, 11, J, 4, E[ax][0], E[ax][1], E[ax][2]);
      const za = [J[8], J[9], J[10]], zb = [J[11], J[12], J[13]];
      let cx = za[1] * zb[2] - za[2] * zb[1], cy = za[2] * zb[0] - za[0] * zb[2], cz = za[0] * zb[1] - za[1] * zb[0];
      const sn = Math.hypot(cx, cy, cz), phi = Math.atan2(sn, za[0] * zb[0] + za[1] * zb[1] + za[2] * zb[2]);
      const limit = j.type === 3 ? 0 : j.swing;
      if (limit !== null && phi > limit && sn > 1e-9) {
        const k = (phi - limit) / sn;
        angular(j.a, j.b, cx * k, cy * k, cz * k);
      }
      if (!j.twist) continue;
      qmulInto(J, 0, q, 4 * j.a, j.fa.q, 0);
      qmulInto(J, 4, q, 4 * j.b, j.fb.q, 0);
      rotInto(J, 8, J, 0, E[ax][0], E[ax][1], E[ax][2]);
      rotInto(J, 11, J, 4, E[ax][0], E[ax][1], E[ax][2]);
      rotInto(J, 14, J, 0, E[rx][0], E[rx][1], E[rx][2]);
      rotInto(J, 17, J, 4, E[rx][0], E[rx][1], E[rx][2]);
      let mx = J[8] + J[11], my = J[9] + J[12], mz = J[10] + J[13];
      const ml = Math.hypot(mx, my, mz) || 1;
      mx /= ml; my /= ml; mz /= ml;
      const da = J[14] * mx + J[15] * my + J[16] * mz, db = J[17] * mx + J[18] * my + J[19] * mz;
      const pax = J[14] - mx * da, pay = J[15] - my * da, paz = J[16] - mz * da, pbx = J[17] - mx * db, pby = J[18] - my * db, pbz = J[19] - mz * db;
      cx = pay * pbz - paz * pby; cy = paz * pbx - pax * pbz; cz = pax * pby - pay * pbx;
      const psi = Math.atan2(cx * mx + cy * my + cz * mz, pax * pbx + pay * pby + paz * pbz);
      const lo = j.twist[0], hi = j.twist[1], over = psi > hi ? psi - hi : psi < lo ? psi - lo : 0;
      if (over !== 0) angular(j.a, j.b, mx * over, my * over, mz * over);
    }
  };
  // contacts : triangles candidats relevés une fois par image pour chaque sphère (rayon + marge du déplacement), avec le
  // côté du triangle où se trouvait le centre à ce moment (+1 devant sa normale, -1 derrière) : un centre qui passe de
  // l'autre côté pendant l'image est repoussé du côté d'où il vient, jamais au travers.
  // Limite connue : au plus CAP = 256 triangles candidats par sphère et par image (les suivants sont ignorés sans signal) ;
  // à vérifier à l'essai réel sur une carte dense.
  const ns = def.spheres.length, CAP = 256;
  const cand = new Int32Array(ns * CAP), side = new Int8Array(ns * CAP), ncand = new Int32Array(ns);
  const near: number[] = [], S = new Float64Array(3), touch = new Uint8Array(n);
  const centre = (k: number, o: Float64Array) => {
    const s = def.spheres[k], i = s.body;
    rotInto(o, 0, q, 4 * i, s.c[0] - def.com[i][0], s.c[1] - def.com[i][1], s.c[2] - def.com[i][2]);
  };
  const gather = (margin: number) => {
    for (let k = 0; k < ns; k++) {
      const s = def.spheres[k], i = s.body;
      centre(k, S);
      const cx = x[3 * i] + S[0], cy = x[3 * i + 1] + S[1], cz = x[3 * i + 2] + S[2];
      const m = Math.min(CAP, world.near(cx, cy, cz, s.r + margin, near));
      ncand[k] = m;
      for (let t = 0; t < m; t++) {
        const tr = near[t], o = 9 * tr, tri = world.tri;
        const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
        const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        cand[k * CAP + t] = tr;
        side[k * CAP + t] = (cx - tri[o]) * nx + (cy - tri[o + 1]) * ny + (cz - tri[o + 2]) * nz >= 0 ? 1 : -1;
      }
    }
  };
  const contacts = () => {
    touch.fill(0);
    const tri = world.tri;
    for (let k = 0; k < ns; k++) {
      const s = def.spheres[k], i = s.body;
      for (let t = 0; t < ncand[k]; t++) {
        const tr = cand[k * CAP + t], o = 9 * tr, sd = side[k * CAP + t];
        centre(k, S);
        const rax = S[0], ray = S[1], raz = S[2];
        const sx = x[3 * i] + rax, sy = x[3 * i + 1] + ray, sz = x[3 * i + 2] + raz;
        closest(tri, tr, sx, sy, sz, S);
        let dx = sx - S[0], dy = sy - S[1], dz = sz - S[2];
        const d = Math.hypot(dx, dy, dz);
        // normale du triangle, du côté d'où venait le centre
        const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
        const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const nl = sd / (Math.hypot(nx, ny, nz) || 1);
        nx *= nl; ny *= nl; nz *= nl;
        // passé au travers de la face (point le plus proche à l'intérieur du triangle, centre de l'autre côté) : repoussé
        // du côté d'où il venait ; sinon contact ordinaire (deux faces), seulement à moins du rayon
        const along = dx * nx + dy * ny + dz * nz, crossed = along < 0 && -along > 0.99 * d && d < 2 * s.r;
        if (!crossed && d >= s.r) continue;
        let pen: number;
        if (crossed || d < 1e-6) { dx = nx; dy = ny; dz = nz; pen = s.r + d; }
        else { dx /= d; dy /= d; dz /= d; pen = s.r - d; }
        positional(i, rax, ray, raz, -1, 0, 0, 0, dx * pen, dy * pen, dz * pen);
        // frottement statique : déplacement tangent du point de contact pendant ce sous-pas, annulé s'il est petit
        centre(k, S);
        const ox = S[0], oy = S[1], oz = S[2];
        rotInto(T, 12, qp, 4 * i, s.c[0] - def.com[i][0], s.c[1] - def.com[i][1], s.c[2] - def.com[i][2]);
        let mx = x[3 * i] + ox - xp[3 * i] - T[12], my = x[3 * i + 1] + oy - xp[3 * i + 1] - T[13], mz = x[3 * i + 2] + oz - xp[3 * i + 2] - T[14];
        const mn = mx * dx + my * dy + mz * dz;
        mx -= mn * dx; my -= mn * dy; mz -= mn * dz;
        if (Math.hypot(mx, my, mz) < FRICTION * pen) positional(i, ox, oy, oz, -1, 0, 0, 0, -mx, -my, -mz);
        touch[i] = 1;
      }
    }
  };
  const P = new Float32Array(3 * n * maxFrames), Q = new Float32Array(4 * n * maxFrames);
  let frames = 0, still = 0;
  const record = () => {
    for (let i = 0; i < n; i++) {
      rotInto(T, 0, q, 4 * i, -def.com[i][0], -def.com[i][1], -def.com[i][2]);
      for (let c = 0; c < 3; c++) P[(frames * n + i) * 3 + c] = x[3 * i + c] + T[c];
      for (let c = 0; c < 4; c++) Q[(frames * n + i) * 4 + c] = q[4 * i + c];
    }
    frames++;
  };
  record();
  while (frames < maxFrames) {
    let vmax0 = 0;
    for (let i = 0; i < n; i++) vmax0 = Math.max(vmax0, Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]));
    gather(vmax0 * DT + 2);
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      xp.set(x);
      qp.set(q);
      for (let i = 0; i < n; i++) {
        v[3 * i + 2] -= GRAVITY * h;
        for (let c = 0; c < 3; c++) x[3 * i + c] += h * v[3 * i + c];
        turn(i, h * w[3 * i], h * w[3 * i + 1], h * w[3 * i + 2]);
      }
      joints();
      contacts();
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) v[3 * i + c] = (x[3 * i + c] - xp[3 * i + c]) / h;
        // w = 2 (q · conj(qp)).xyz / h
        const qi = 4 * i, ax2 = q[qi], ay2 = q[qi + 1], az2 = q[qi + 2], aw2 = q[qi + 3];
        const bx = -qp[qi], by = -qp[qi + 1], bz = -qp[qi + 2], bw = qp[qi + 3];
        let dx = aw2 * bx + ax2 * bw + ay2 * bz - az2 * by, dy = aw2 * by - ax2 * bz + ay2 * bw + az2 * bx, dz = aw2 * bz + ax2 * by - ay2 * bx + az2 * bw;
        const dw = aw2 * bw - ax2 * bx - ay2 * by - az2 * bz;
        if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; }
        const kl = 1 / (1 + h * def.linDamp[i]), ka = 1 / (1 + h * def.angDamp[i]);
        for (let c = 0; c < 3; c++) v[3 * i + c] *= kl;
        const sp0 = Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]);
        if (sp0 > MAX_V) for (let c = 0; c < 3; c++) v[3 * i + c] *= MAX_V / sp0;
        if (touch[i]) {
          // frottement de glissement (Coulomb) : vitesse tangente freinée de FRICTION × g par seconde au contact
          const sp = Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]), cut = FRICTION * GRAVITY * h;
          const kf = sp > cut ? 1 - cut / sp : 0;
          for (let c = 0; c < 3; c++) v[3 * i + c] *= kf;
        }
        w[3 * i] = (2 * dx / h) * ka; w[3 * i + 1] = (2 * dy / h) * ka; w[3 * i + 2] = (2 * dz / h) * ka;
      }
    }
    record();
    let vmax = 0, wmax = 0;
    for (let i = 0; i < n; i++) {
      vmax = Math.max(vmax, Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]));
      wmax = Math.max(wmax, Math.hypot(w[3 * i], w[3 * i + 1], w[3 * i + 2]));
    }
    still = vmax < SLEEP_V && wmax < SLEEP_W ? still + 1 : 0;
    if (still >= SLEEP_FRAMES) break;
  }
  return { dt: DT, frames, bodies: n, p: P.slice(0, 3 * n * frames), q: Q.slice(0, 4 * n * frames) };
}

/** Composante c de [s, 0] ⊗ q (s : vecteur), sans allocation. */
function sw0(sx: number, sy: number, sz: number, qx: number, qy: number, qz: number, qw: number, c: number): number {
  if (c === 0) return sx * qw + sy * qz - sz * qy;
  if (c === 1) return sy * qw + sz * qx - sx * qz;
  return sz * qw + sx * qy - sy * qx;
}

/** Point du triangle t le plus proche de p → o[0..2] (Ericson, Real-Time Collision Detection, 5.1.5). */
export function closest(tri: Float32Array, t: number, px: number, py: number, pz: number, o: Float64Array) {
  const k = 9 * t, ax = tri[k], ay = tri[k + 1], az = tri[k + 2], bx = tri[k + 3], by = tri[k + 4], bz = tri[k + 5];
  const cx = tri[k + 6], cy = tri[k + 7], cz = tri[k + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { o[0] = ax; o[1] = ay; o[2] = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { o[0] = bx; o[1] = by; o[2] = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const u = d1 / (d1 - d3); o[0] = ax + u * abx; o[1] = ay + u * aby; o[2] = az + u * abz; return; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { o[0] = cx; o[1] = cy; o[2] = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const u = d2 / (d2 - d6); o[0] = ax + u * acx; o[1] = ay + u * acy; o[2] = az + u * acz; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const u = (d4 - d3) / (d4 - d3 + (d5 - d6));
    o[0] = bx + u * (cx - bx); o[1] = by + u * (cy - by); o[2] = bz + u * (cz - bz); return;
  }
  const den = 1 / (va + vb + vc), vv = vb * den, ww = vc * den;
  o[0] = ax + abx * vv + acx * ww; o[1] = ay + aby * vv + acy * ww; o[2] = az + abz * vv + acz * ww;
}
