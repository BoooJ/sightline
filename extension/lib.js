// Logique de l'extension « Sightline · PRACC », sans API chrome (testée par extension/test/lib.test.mjs).
// La session PRACC est liée à l'adresse IP de l'utilisateur : elle ne sert que depuis son Chrome. L'extension lit donc
// PRACC ici, et n8n (W1, deploy/n8n/build_workflows.py) décide quoi importer dans Sightline. De même pour FACEIT, qui
// refuse les téléchargements au serveur : l'extension relève, sur la page d'un match, le lien de sa démo.
export const PRACC_DEMOS = "https://pracc.com/api/team/server/demos";
export const PRACC_CALENDAR = "https://pracc.com/api/matches"; // matchs ESEA et pracs réservés
export const N8N_HOOK = "https://n8n.example.com/webhook/pracc";
export const SECRET_HEADER = "X-Sightline-Extension";
const ACCEPT = { Accept: "application/vnd.pracc.v1+json" };
export const faceitRoom = (id) => `https://www.faceit.com/fr/cs2/room/${id}`;

/** Secret partagé avec n8n (identifiant « Extension PRACC ») : 32 octets aléatoires en hexadécimal. */
export function newSecret(random = (a) => crypto.getRandomValues(a)) {
  return Array.from(random(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Secret collé depuis une autre extension (un coéquipier) : même forme, sinon null. */
export function cleanSecret(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/** Lien de stockage signé d'une démo : PRACC redirige vers son stockage ; on garde l'adresse finale, pas le fichier. */
export async function storageUrl(fetchFn, downloadUrl) {
  let url;
  try { url = new URL(downloadUrl); } catch { return null; }
  if (url.origin !== "https://pracc.com") return null; // la session PRACC ne part que vers pracc.com
  const stop = new AbortController();
  try {
    const r = await fetchFn(url.href, { credentials: "include", headers: ACCEPT, signal: stop.signal });
    return r.ok && r.redirected && r.url.startsWith("https://") ? r.url : null;
  } catch {
    return null;
  } finally {
    stop.abort(); // le téléchargement commencé est coupé : Sightline téléchargera la démo lui-même
  }
}

/** Envoi à W1 (n8n), avec le secret de l'équipe. */
function hook(fetchFn, secret) {
  return async (payload) => {
    const r = await fetchFn(N8N_HOOK, { method: "POST", body: JSON.stringify(payload),
                                        headers: { "Content-Type": "application/json", [SECRET_HEADER]: secret } });
    if (r.status === 403) throw new Error("n8n refuse le secret : recopie-le dans l'identifiant « Extension PRACC »");
    if (!r.ok) throw new Error(`n8n a répondu ${r.status}`);
    return r.json();
  };
}

/** Un tour : liste PRACC → W1, calendrier PRACC → W1, puis liens des pracs à récupérer → W1. Ne lève jamais : renvoie
 *  l'état à afficher. */
export async function runTour({ fetchFn, secret, now = () => new Date() }) {
  const at = now().toISOString();
  const post = hook(fetchFn, secret);
  try {
    let res;
    try { res = await fetchFn(PRACC_DEMOS, { credentials: "include", headers: ACCEPT }); }
    catch { return { at, state: "error", message: "PRACC injoignable", imported: 0 }; }
    const expired = res.status === 401 || res.status === 403;
    const body = res.ok ? await res.json().catch(() => null) : null;
    const answer = await post({ step: "list", statusCode: res.status, body }).catch((e) => {
      if (expired) return { expired: true }; // l'alerte Discord attendra, le badge suffit
      throw e;
    });
    if (expired || answer.expired) {
      return { at, state: "expired", message: "Session PRACC expirée : reconnecte-toi à pracc.com", imported: 0 };
    }
    // calendrier de l'équipe : Sightline le garde à jour (site, app mobile, message de prép sur Discord) ; même pendant la
    // pause du backup, qui ne concerne que les imports
    const cal = await fetchFn(PRACC_CALENDAR, { credentials: "include", headers: ACCEPT });
    await post({ step: "calendar", statusCode: cal.status, body: cal.ok ? await cal.json().catch(() => null) : null });
    if (answer.quiet) return { at, state: "ok", message: "En pause pendant le backup du serveur (05:00–07:30 UTC)", imported: 0 };
    const wanted = Array.isArray(answer.fetch) ? answer.fetch : [];
    const items = [];
    for (const d of wanted) {
      const link = await storageUrl(fetchFn, d.downloadUrl);
      if (link) items.push({ uid: d.uid, createdAt: d.createdAt, opponent: d.opponent, storageUrl: link });
    }
    if (items.length) await post({ step: "import", items });
    const missed = wanted.length - items.length;
    const message = items.length ? `${items.length} prac(s) envoyé(s) à Sightline` : "Rien de nouveau";
    return { at, state: missed ? "error" : "ok", imported: items.length,
             message: missed ? `${message} ; ${missed} lien(s) de démo introuvable(s), nouvel essai au prochain tour` : message };
  } catch (e) {
    return { at, state: "error", message: String(e?.message || e), imported: 0 };
  }
}

/** Démos FACEIT demandées (/demos sur Discord, ou d'office pour chaque nouvel adversaire) : W1 donne les matchs,
 *  `openRoom` relève les liens sur leur page faceit.com, W1 les transmet à Sightline qui télécharge les démos. Ne lève
 *  jamais : renvoie l'état à afficher. */
export async function runFaceit({ fetchFn, secret, openRoom, now = () => new Date() }) {
  const at = now().toISOString();
  const post = hook(fetchFn, secret);
  try {
    const answer = await post({ step: "faceit-wanted" });
    const wanted = Array.isArray(answer.wanted) ? answer.wanted.slice(0, 3) : [];
    if (!wanted.length) {
      return { at, state: "ok", sent: 0,
               message: answer.low_disk ? "FACEIT : serveur presque plein, pas de nouvel import" : "FACEIT : rien à récupérer" };
    }
    let sent = 0;
    for (const w of wanted) {
      let got;
      try { got = await openRoom(faceitRoom(w.match_id)); } catch (e) { got = { error: String(e?.message || e) }; }
      await post({ step: "faceit-links", match_id: w.match_id, ...got });
      sent += got.links?.length || 0;
      if (got.error === "login") return { at, state: "expired", sent, message: "Connecte-toi à faceit.com : des démos FACEIT attendent" };
    }
    return { at, state: "ok", sent,
             message: sent ? `FACEIT : ${sent} démo(s) envoyée(s) à Sightline` : "FACEIT : aucun lien de démo, nouvel essai plus tard" };
  } catch (e) {
    return { at, state: "error", sent: 0, message: `FACEIT : ${e?.message || e}` };
  }
}

/** Exécutée DANS la page d'un match faceit.com (chrome.scripting, monde MAIN), comme un clic de l'utilisateur : le bouton
 *  « Regarder la démo » ouvre le lien signé et temporaire de la démo (un menu « Démo 1, Démo 2… » quand il y en a
 *  plusieurs) ; on le note au lieu de l'ouvrir. Autonome (Chrome la sérialise) : rien d'extérieur. */
export async function grabDemoLinks(tick = 500) {
  const WATCH = /regarder la d[ée]mo|watch demo|ver demo|demo ansehen/i;
  const ITEM = /^\s*d[ée]mo\s+\d+\s*$/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const buttons = (re) => [...document.querySelectorAll("button")].filter((b) => re.test(b.textContent || ""));
  const links = [];
  const open = window.open;
  window.open = (u) => {
    const s = String(u);
    if (/\.dem/i.test(s.split("?")[0]) && !links.includes(s)) links.push(s);
    return null;
  };
  try {
    let watch;
    for (let i = 0; i < 40 && !(watch = buttons(WATCH)[0]); i++) await sleep(tick);
    if (!watch) {
      const out = /se connecter|connexion|log ?in|sign ?in/i.test(document.body?.innerText || "");
      return { error: out ? "login" : "Pas de bouton « Regarder la démo » sur la page du match" };
    }
    watch.click();
    await sleep(tick * 3);
    let count = buttons(ITEM).length;
    if (!count) { // une seule démo : le lien part tout de suite, parfois après la vérification de la page
      for (let i = 0; i < 30 && !links.length; i++) await sleep(tick);
      if (!links.length) { // pas de réponse au premier clic : un second
        buttons(WATCH)[0]?.click();
        await sleep(tick * 3);
        count = buttons(ITEM).length;
        if (!count) for (let i = 0; i < 30 && !links.length; i++) await sleep(tick);
      }
    }
    for (let k = 0; k < count; k++) {
      let item = buttons(ITEM)[k];
      if (!item) { // menu refermé après un choix : on le rouvre
        buttons(WATCH)[0]?.click();
        await sleep(tick * 2);
        item = buttons(ITEM)[k];
      }
      if (!item) continue;
      const before = links.length;
      item.click();
      for (let i = 0; i < 20 && links.length === before; i++) await sleep(tick);
    }
    return links.length ? { links } : { error: "Aucun lien de démo (expirée ou pas encore disponible)" };
  } finally {
    window.open = open;
  }
}
