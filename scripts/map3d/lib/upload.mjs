import crypto from "node:crypto";
import fs from "node:fs";

export const CHUNK = 4 * 1024 * 1024;

export async function sha256File(file) {
  const h = crypto.createHash("sha256");
  for await (const block of fs.createReadStream(file)) h.update(block);
  return h.digest("hex");
}

/** Corps d'une réponse (Playwright ou fetch) : du JSON en principe, mais un proxy en panne (502 de Caddy pendant un
 *  redéploiement) renvoie une page HTML ou rien du tout ; on garde alors le début du texte comme motif. */
export async function readBody(res) {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "réponse vide" };
  }
}

/** Motif lisible d'un refus du serveur ({ detail: "…" } de FastAPI, ou autre chose). */
export const reason = (body) => (typeof body?.detail === "string" ? body.detail : JSON.stringify(body?.detail ?? body));

/** Avant l'export (plusieurs minutes) : le site répond-il, et le module 3D y est-il activé ? /api/health est public. */
export async function checkSite(site, get = fetch) {
  let res;
  try {
    res = await get(`${site}/api/health`, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    const why = e.cause?.code || e.cause?.message || e.message;  // localhost : AggregateError sans message, avec un code
    throw new Error(`Sightline injoignable (${site}) : ${why}. Vérifiez --site et la connexion.`);
  }
  const health = await readBody(res);
  if (!res.ok) throw new Error(`${site}/api/health répond ${res.status} : ${reason(health)}. Vérifiez --site.`);
  if (health?.ok !== true) throw new Error(`${site} ne répond pas comme un Sightline (/api/health) : vérifiez --site.`);
  if (!(health.modules ?? []).includes("replay3d")) {
    throw new Error(`Le module 3D n'est pas activé sur ${site} : ajoutez "replay3d" à modules dans config.toml puis redémarrez le site.`);
  }
}

/** Après la connexion : l'envoi est réservé aux propriétaires et administrateurs (require_admin côté serveur). Sans
 *  compte (mode ouvert, en local), c'est le serveur qui tranche. `hint` : comment changer de compte ; `what` : ce qui
 *  est envoyé. */
export function checkAdmin(me, hint = "", what = "de carte 3D") {
  const u = me?.user;
  if (u && u.role !== "owner" && u.role !== "admin") {
    throw new Error(`Le compte ${u.username} (${u.role}) ne peut pas envoyer ${what} : il faut un compte propriétaire ou admin.${hint}`);
  }
}

/** Envoie le .glb d'une carte (variante grise ou texturée). */
export const uploadVariant = ({ site, map, variant, ...rest }) =>
  uploadFile({ ...rest, base: `${site}/api/maps3d`, begin: `${map}/${variant}/upload` });

/** Envoie un .glb par morceaux d'affilée, avec reprise ; `request` : APIRequestContext de Playwright (ou un faux). Début
 *  par POST `${base}/${begin}` (/api/maps3d/<carte>/<variante>/upload, /api/assets3d/<type>/<nom>/upload), morceaux et
 *  fin sous `${base}/uploads/…`. */
export async function uploadFile({ request, base, begin: beginPath, file, meta, wait = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const size = fs.statSync(file).size, sha256 = await sha256File(file);
  const begin = await request.post(`${base}/${beginPath}`, { data: { ...meta, size, sha256 } });
  const st = await readBody(begin);
  if (!begin.ok()) throw new Error(`Envoi refusé (${begin.status()}) : ${reason(st)}`);
  const fd = fs.openSync(file, "r");
  try {
    // begin reprend un envoi coupé (même carte, variante, sha256 et taille) : on part des octets déjà reçus
    for (let off = st.received, failures = 0; off < size;) {
      const len = Math.min(CHUNK, size - off), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      const res = await request.put(`${base}/uploads/${st.id}?offset=${off}`,
        { data: buf, headers: { "content-type": "application/octet-stream" }, timeout: 300_000 }).catch(() => null);
      if (res?.ok()) {
        off += len;
        failures = 0;
        log(off, size);
        continue;
      }
      const status = res?.status(), body = res ? await readBody(res) : null, received = body?.detail?.received;
      // 409 : le serveur dit où il en est (réponse précédente perdue alors que le morceau était écrit) ; on y repart
      if (status === 409 && Number.isInteger(received) && received >= 0 && received <= size && received !== off) {
        off = received;
        log(off, size);
        continue;
      }
      // session expirée (401), droits (403), morceau refusé (413), disque plein (507)… : réessayer ne changerait rien
      if (status && ((status < 500 && status !== 408 && status !== 409 && status !== 429) || status === 507)) {
        throw new Error(`Envoi refusé (${status}) : ${reason(body)}`);
      }
      if (++failures >= 5) throw new Error(`Envoi interrompu à ${off} octets : relancez la commande pour reprendre.`);
      await wait(3000 * failures);
    }
  } finally {
    fs.closeSync(fd);
  }
  const done = await request.post(`${base}/uploads/${st.id}/complete`);
  const body = await readBody(done);
  if (!done.ok()) throw new Error(`Vérification refusée (${done.status()}) : ${reason(body)}`);
  return body;
}
