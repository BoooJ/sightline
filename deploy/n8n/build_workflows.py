"""Workflows n8n de Sightline : W0 (erreurs → Discord), W1 (PRACC → Sightline), W2 (Sightline → Discord, avec un agent
qui résume le match), W4 (formulaire d'import), W5 (prép d'avant-match), W6 (FACEIT → calendrier), et le modèle de
credentials VIDES que l'installation importe. Source unique : on modifie ce
fichier, puis on relance
  python deploy/n8n/build_workflows.py          écrit deploy/n8n/workflows/*.json et credentials.template.json
  python deploy/n8n/build_workflows.py --check  échoue si ces fichiers ne sont pas à jour (test backend)
Versions de nœuds vérifiées dans le conteneur n8n 2.44.6 (dist/types/nodes.json)."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SL = "https://sightline.example.com"
CRED = {
    "extension": {"httpHeaderAuth": {"id": "slCredExtPracc01", "name": "Extension PRACC"}},
    "sightline": {"httpHeaderAuth": {"id": "slCredSightline1", "name": "Sightline"}},
    "hook": {"jwtAuth": {"id": "slCredSlHook0001", "name": "Sightline webhook"}},
    "anthropic": {"anthropicApi": {"id": "slCredAnthropic1", "name": "Anthropic"}},
    "discord": {"discordWebhookApi": {"id": "slCredDiscord001", "name": "Discord Sightline"}},
    "form": {"httpBasicAuth": {"id": "slCredFormBasic1", "name": "Formulaire d'import"}},
}


def node(wid, n, name, type_, ver, pos, params, creds=None, **extra):
    d = {"id": f"{wid}-0000-4000-8000-{n:012d}", "name": name, "type": type_, "typeVersion": ver, "position": pos,
         "parameters": params}
    if creds:
        d["credentials"] = creds
    d.update(extra)
    return d


def main(*targets):
    """Connexions principales : une sortie par cible (une seule pour un nœud simple, deux pour un aiguillage)."""
    return {"main": [[{"node": t, "type": "main", "index": 0}] for t in targets]}


def fan(*outputs):
    """Comme main(), mais chaque sortie peut alimenter plusieurs nœuds : fan(["A", "B"], ["C"])."""
    return {"main": [[{"node": t, "type": "main", "index": 0} for t in targets] for targets in outputs]}


def respond(wid, n, name, pos, body=None):
    """Réponse au webhook : `body` fixe (JSON), sinon le premier élément reçu."""
    p = {"respondWith": "json", "responseBody": json.dumps(body), "options": {}} if body is not None else \
        {"respondWith": "firstIncomingItem", "options": {}}
    return node(wid, n, name, "n8n-nodes-base.respondToWebhook", 1.5, pos, p)


def discord(wid, n, name, pos, embed=False):
    p = {"authentication": "webhook", "operation": "sendLegacy", "content": "={{ $json.content }}", "options": {}}
    if embed:
        p["embeds"] = {"values": [{"inputMethod": "json", "json": "={{ JSON.stringify($json.embed) }}"}]}
    return node(wid, n, name, "n8n-nodes-base.discord", 2, pos, p, CRED["discord"],
                retryOnFail=True, maxTries=3, waitBetweenTries=5000)


def code(wid, n, name, pos, js):
    return node(wid, n, name, "n8n-nodes-base.code", 2, pos, {"jsCode": js.strip() + "\n"})


def sl_post(wid, n, name, pos, path, body, **extra):
    return node(wid, n, name, "n8n-nodes-base.httpRequest", 4.2, pos,
                {"method": "POST", "url": f"{SL}{path}", "authentication": "genericCredentialType",
                 "genericAuthType": "httpHeaderAuth", "sendBody": True, "specifyBody": "json", "jsonBody": body,
                 "options": {}}, CRED["sightline"], **extra)


def workflow(id_, name, nodes, connections, error=True, **settings_extra):
    settings = {"executionOrder": "v1", "timezone": "UTC", **settings_extra}
    if error:
        settings["errorWorkflow"] = "sightlineW0err01"
    return {"id": id_, "name": name, "active": False, "nodes": nodes, "connections": connections,
            "settings": settings, "pinData": {}}


# ------------------------------------------------------------------ W5 · prép d'avant-match → Discord
W5_MSG = r"""
// Un message par match, scrim ou tournoi qui commence dans les 24 h (Sightline ne le rend qu'une fois). L'heure est un
// horodatage Discord : chacun la voit dans son fuseau (l'équipe est répartie entre plusieurs pays).
const safe = (s) => String(s ?? '').replace(/@/g, '@' + String.fromCharCode(0x200b)); // pas de mention venue des données
const KIND = { match: 'Match officiel', scrim: 'Prac', tournament: 'Tournoi' };
const ICON = { win: '✅', loss: '❌', draw: '➖' };
return ($input.first().json.events || []).map((e) => {
  const t = Math.floor(Date.parse(e.starts_at) / 1000);
  const kind = KIND[e.kind] || 'Match';
  const h = e.history || {};
  const lines = [`🕗 <t:${t}:F> · <t:${t}:R>`];
  const info = String(e.notes || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^https?:/.test(l)).slice(0, 2);
  if (info.length) lines.push(safe(info.join(' · ')));
  const past = h.matches || [];
  if (past.length) {
    lines.push('', `**Contre eux** : ${h.win} V – ${h.loss} D${h.draw ? ` – ${h.draw} N` : ''}`);
    for (const m of past.slice(0, 3)) {
      lines.push(`${ICON[m.result] || '•'} ${safe(m.map)} ${m.score[0]}–${m.score[1]}${m.date ? ` · ${m.date}` : ''}${m.url ? ` · [revoir](${m.url})` : ''}`);
    }
  } else {
    lines.push('', 'Pas encore de match contre eux dans Sightline.');
  }
  if ((e.their_maps || []).length) {
    lines.push(`**Leurs cartes** (dans nos démos) : ${e.their_maps.map((x) => `${safe(x.map)} ×${x.count}`).join(' · ')}`);
  }
  // cartes probables du BO1 (match FACEIT) : leurs cartes × les nôtres, avec leur bilan sur chacune
  const odds = e.likely_maps;
  if (odds && (odds.maps || []).length) {
    const top = odds.maps.filter((m) => m.pct >= 5).slice(0, 4);
    lines.push('', `**Cartes probables** : ${top.map((m) => `${safe(m.name)} ${m.pct} %`).join(' · ')}`);
    const rec = top.filter((m) => m.played).map((m) => `${safe(m.name)} ${m.won}/${m.played}`);
    if (rec.length) lines.push(`Leur bilan ESEA : ${rec.join(' · ')}`);
    lines.push(`_D'après leurs ${odds.them} matchs ESEA et nos ${odds.us}${odds.few ? ' : peu de matchs, à prendre avec prudence' : ''}._`);
  }
  return { json: { content: `📅 ${kind} dans 24 h`, embed: {
    title: safe(`${kind} contre ${e.opponent || e.title}`).slice(0, 256), url: e.url || undefined, color: 0x3ddc97,
    description: lines.join('\n').slice(0, 4000), footer: { text: safe(e.title).slice(0, 200) },
  } } };
});
"""

# ------------------------------------------------------------------ W6 · FACEIT → calendrier, horaire déplacé → Discord
W6_MSG = r"""
// Après la synchro FACEIT : un message par match dont l'horaire vient de changer, en heures Discord (chacun les voit dans
// son fuseau). Sightline ou FACEIT injoignable : une alerte par jour au plus, le calendrier reste tel quel.
const safe = (s) => String(s ?? '').replace(/@/g, '@' + String.fromCharCode(0x200b)); // pas de mention venue des données
const state = $getWorkflowStaticData('global');
const r = $input.first().json;
if (!Array.isArray(r.moved)) {
  const now = Date.now();
  if (state.faceitAlertAt && now - state.faceitAlertAt < 24 * 3600 * 1000) return [];
  state.faceitAlertAt = now;
  const why = r.error?.message || r.detail || 'réponse inattendue';
  return [{ json: { content: safe(`⚠️ Calendrier FACEIT : synchro impossible (${why}). Nouvel essai toutes les 15 min.`).slice(0, 1900) } }];
}
delete state.faceitAlertAt; // de nouveau joignable : la prochaine panne sera signalée
const t = (iso) => Math.floor(Date.parse(iso) / 1000);
return r.moved.map((m) => ({ json: { content: safe(
  `⏰ **${m.title}** déplacé : ~~<t:${t(m.before)}:f>~~ → **<t:${t(m.after)}:F>** (<t:${t(m.after)}:R>)`).slice(0, 1900) } }));
"""

# ------------------------------------------------------------------ W4 · formulaire d'import → Sightline
W4_FILE = r"""
// Le fichier déposé dans le formulaire, sous un nom fixe pour l'envoi à Sightline, et l'adversaire s'il est donné.
const item = $input.first();
const key = Object.keys(item.binary || {})[0];
if (!key) throw new Error('Aucune démo dans le formulaire');
const opponent = String(item.json.opponent ?? item.json.Adversaire ?? '').trim().slice(0, 64);
return [{ json: { opponent }, binary: { demo: item.binary[key] } }];
"""

# ------------------------------------------------------------------ W0 · erreurs → Discord
W0_MSG = r"""
// Message court pour Discord : quel workflow, sur quel nœud, quelle erreur.
const e = $input.first().json;
const wf = e.workflow?.name || 'Un workflow';
const node = e.execution?.lastNodeExecuted || '?';
const msg = e.execution?.error?.message || 'erreur inconnue';
const safe = (s) => String(s).replace(/@/g, '@' + String.fromCharCode(0x200b)); // pas de mention @everyone venue des données
return [{ json: { content: safe(`⚙️ ${wf} a planté sur « ${node} » : ${msg}`).slice(0, 1900) } }];
"""

# ------------------------------------------------------------------ W1 · PRACC → Sightline (appelé par l'extension Chrome)
# La session PRACC est liée à l'adresse IP de l'utilisateur : utilisée depuis le serveur, PRACC la ferme. L'extension lit
# donc PRACC dans son Chrome et envoie à W1 la réponse brute (étape « list ») ; W1 trie et répond les pracs à récupérer.
# L'extension suit alors la redirection de chaque démo et renvoie le lien de stockage signé (étape « import »).
W1_WINDOW = r"""
// Le backup OVH gèle le disque vers 06:00 UTC : aucun import entre 05:00 et 07:30 UTC (un tour lancé à 05:30 pourrait
// encore analyser quand le disque gèle). Toujours une sortie : l'extension attend une réponse.
const now = new Date($input.first().json.timestamp ?? Date.now());
const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
const sent = $input.first().json.body || {}; // envoi de l'extension : { step, statusCode, body } (réponse de PRACC)
return [{ json: { quiet: minutes >= 5 * 60 && minutes < 7 * 60 + 30, statusCode: sent.statusCode, body: sent.body } }];
"""
W1_SORT = r"""
// Réponse de PRACC relayée par l'extension : 401/403 = session expirée, sinon la liste des démos du serveur.
const res = $input.first().json;
if (res.statusCode === 401 || res.statusCode === 403) return [{ json: { expired: true, status: res.statusCode } }];
// PRACC répond en application/vnd.pracc.v1+json : n8n peut laisser le corps en texte
let body = res.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* pas du JSON : traité comme une erreur ci-dessous */ } }
if (res.statusCode !== 200 || !Array.isArray(body)) throw new Error(`PRACC a répondu ${res.statusCode}`);
delete $getWorkflowStaticData('global').praccAlertAt; // session valide : la prochaine expiration sera signalée
// notre équipe : celle qui apparaît dans le plus de pracs (hôte ou invitée)
const seen = {};
for (const d of body) for (const t of [d.Team, d.OtherTeam]) if (t && t.ID != null) seen[t.ID] = (seen[t.ID] || 0) + 1;
const us = Number(Object.entries(seen).sort((a, b) => b[1] - a[1])[0]?.[0]);
if (Number.isFinite(us)) $getWorkflowStaticData('global').praccTeamId = us; // relu par l'étape calendrier
// l'extension n'ouvre que des liens pracc.com (sa session) : lien relatif ou https://pracc.com/…, sinon la démo est ignorée
const onPracc = (u) => /^\/(?!\/)/.test(u) || u.startsWith('https://pracc.com/');
// pas d'arriéré : seulement les pracs créés après la mise en service (choix du 23/10) ; une date illisible = ignorée
const since = Date.parse('2026-10-23T02:45:00Z');
const demos = body
  .filter((d) => d.Uploaded && d.Uid && d.DownloadUrl && onPracc(String(d.DownloadUrl)) && Date.parse(d.CreatedAt) >= since)
  .sort((a, b) => String(b.CreatedAt).localeCompare(String(a.CreatedAt)))
  .slice(0, 200) // /api/integrations/known accepte 500 identifiants au plus
  .map((d) => {
    const them = d.Team && Number(d.Team.ID) !== us ? d.Team : d.OtherTeam;
    const path = String(d.DownloadUrl);
    return { uid: String(d.Uid), downloadUrl: path.startsWith('/') ? `https://pracc.com${path}` : path,
             createdAt: d.CreatedAt, opponent: them?.Name || '' };
  });
return [{ json: { expired: false, uids: demos.map((d) => d.uid), demos } }];
"""
W1_ALERT = r"""
// Une alerte par jour au plus : inutile de répéter toutes les 30 minutes que la session a expiré.
const state = $getWorkflowStaticData('global');
const now = Date.now();
if (state.praccAlertAt && now - state.praccAlertAt < 24 * 3600 * 1000) return [];
state.praccAlertAt = now;
return [{ json: { content: '🔑 Session PRACC expirée : reconnecte-toi à pracc.com dans Chrome, l\'extension Sightline reprendra toute seule.' } }];
"""
W1_FACEIT_ALERT = r"""
// L'extension n'est pas connectée à FACEIT : les démos demandées attendent. Une alerte par jour au plus ; une démo
// récupérée efface l'alerte (la prochaine déconnexion sera signalée).
const r = $input.first().json;
const state = $getWorkflowStaticData('global');
if (r.status === 'started') delete state.faceitLoginAt;
if (r.status !== 'login') return [];
const now = Date.now();
if (state.faceitLoginAt && now - state.faceitLoginAt < 24 * 3600 * 1000) return [];
state.faceitLoginAt = now;
return [{ json: { content: '🔑 Démos FACEIT en attente : connecte-toi à faceit.com dans Chrome, l\'extension Sightline les récupérera toute seule.' } }];
"""
W1_CAL = r"""
// Calendrier PRACC relayé par l'extension (GET /api/matches) : les matchs ESEA (Events) et les pracs réservés (Matches),
// envoyés à Sightline, qui remplace ses événements PRACC à venir. Session expirée ou réponse inattendue : rien n'est
// envoyé, pour ne jamais vider le calendrier par erreur.
const sent = $input.first().json.body || {};
const body = sent.body;
if (sent.statusCode !== 200 || !body || !Array.isArray(body.Events) || !Array.isArray(body.Matches)) return [];
const us = Number($getWorkflowStaticData('global').praccTeamId);
const vs = (title) => (String(title || '').split(/\bvs\.?\s+/i)[1] || '').trim();
const events = [];
for (const e of body.Events) {
  if (!e || e.ID == null || !e.Time) continue;
  events.push({ external_id: `event-${e.ID}`, kind: /esea|faceit|league|cup/i.test(String(e.ExternalSource || '')) ? 'match' : 'other',
                title: String(e.Title || 'Événement PRACC').slice(0, 120), opponent: vs(e.Title).slice(0, 128), starts_at: e.Time,
                notes: [e.Description, e.ExternalUrl].filter(Boolean).join('\n').slice(0, 5000) });
}
for (const m of body.Matches) {
  const time = m && (m.Time || m.Date || m.StartTime || m.StartsAt);
  if (!m || m.ID == null || !time) continue;
  // les deux équipes du prac, où qu'elles soient rangées ; l'adversaire est celle qui n'est pas la nôtre
  const teams = [...Object.values(m), ...(Array.isArray(m.Teams) ? m.Teams : [])]
    .filter((t) => t && typeof t === 'object' && !Array.isArray(t) && t.ID != null && t.Name);
  const them = teams.find((t) => Number(t.ID) !== us);
  const opponent = String(them?.Name || '').slice(0, 128);
  events.push({ external_id: `match-${m.ID}`, kind: 'scrim', title: (opponent ? `Prac vs. ${opponent}` : 'Prac PRACC').slice(0, 120),
                opponent, starts_at: time, notes: '' });
}
return [{ json: { source: 'pracc', events } }];
"""
W1_PICK = r"""
// Seulement les pracs que Sightline n'a pas, 3 par tour au plus : une seule analyse à la fois sur le serveur.
// Une seule sortie, même vide : c'est la réponse à l'extension.
const known = new Set($input.first().json.known || []);
return [{ json: { fetch: $('Trier').first().json.demos.filter((d) => !known.has(d.uid)).slice(0, 3) } }];
"""
W1_PREP = r"""
// L'extension a suivi la redirection de PRACC : storageUrl est le lien de stockage signé (valable peu de temps : l'import
// part tout de suite). Une démo sans lien https est ignorée ce tour-ci et redemandée au suivant.
const items = $input.first().json.body?.items;
const out = [];
for (const d of Array.isArray(items) ? items.slice(0, 3) : []) {
  let url;
  try { url = new URL(String(d.storageUrl)); } catch { continue; }
  if (url.protocol !== 'https:' || !d.uid) continue;
  const opponent = String(d.opponent || '').slice(0, 64); // une étiquette fait 64 caractères au plus
  const created = new Date(d.createdAt);
  out.push({ json: {
    url: url.href, source: 'pracc', external_id: String(d.uid),
    label: { folder: 'PRACC', played_on: Number.isNaN(created.getTime()) ? null : created.toISOString().slice(0, 10),
             tags: ['pracc', opponent].filter(Boolean), opponent },
  } });
}
return out;
"""

# ------------------------------------------------------------------ W2 · Sightline → Discord
W2_MSG = r"""
// Un message par événement Sightline. « Match analysé » d'un match de notre équipe passe par Claude, qui écrit le
// débrief ; le match d'une autre équipe (scouting) n'a qu'une ligne, sans appel à Claude.
const { event, data = {} } = $input.first().json.body || {};
const safe = (s) => String(s ?? '').replace(/@/g, '@' + String.fromCharCode(0x200b)); // pas de mention venue des données
const who = data.opponent ? `prac contre ${safe(data.opponent)}` : safe(data.file_name || 'une démo');
const texts = {
  'demo.imported': `📥 Nouveau match importé : ${who}, analyse en cours.`,
  'demo.failed': `⚠️ Import échoué${data.source ? ` (${safe(data.source)} ${safe(data.external_id)})` : ''} : ${safe(data.error || 'erreur inconnue')}`,
  'comms.ready': `🎙 Comms ajoutées : ${safe(data.title)} · ${Number(data.tracks) || 0} ${Number(data.tracks) === 1 ? 'piste' : 'pistes'} TeamSpeak · ${data.url || `https://sightline.example.com${data.path || ''}`}`,
  ping: '✅ Sightline est bien relié à n8n.',
};
if (event === 'match.ready') {
  const [a, b] = data.teams || ['?', '?'];
  const [sa, sb] = data.score || ['?', '?'];
  const title = safe(`${a} ${sa}–${sb} ${b} · ${data.map_name || data.map}`);
  const url = data.url || `https://sightline.example.com${data.path || ''}`;
  if (!data.our_team) return [{ json: { isMatch: false, content: `🎯 Match analysé : ${title} · ${url}`.slice(0, 1900) } }];
  return [{ json: { isMatch: true, match_id: data.match_id, kind: data.kind, our_team: data.our_team || null,
    our_team_id: data.our_team_id ?? null,
    title, url } }];
}
if (!texts[event]) return [];
return [{ json: { isMatch: false, content: texts[event].slice(0, 1900) } }];
"""
W2_EMBED = r"""
// Le résumé de Claude dans l'embed du match ; sans résumé si l'appel a échoué.
const m = $('Message').first().json;
const summary = String($input.first().json.text || '').trim();
return [{ json: { content: '🎯 Match analysé', embed: {
  title: String(m.title).slice(0, 256), url: m.url, color: 0x3ddc97,
  description: (summary || 'Analyse terminée : replay, stats et débrief sont prêts.').replace(/@/g, '@' + String.fromCharCode(0x200b)).slice(0, 4000),
  footer: { text: m.kind === 'practice' ? 'Prac · Sightline' : 'Officiel · Sightline' },
} } }];
"""
W2_DATA = r"""
// Débrief et stats du match, lus par n8n, en texte compact pour Claude : un seul appel, sans outils. Une partie
// illisible (404, erreur) est omise.
const m = $('Message').first().json;
const part = (name, max) => {
  const j = $(name).first().json;
  return j && !j.error ? JSON.stringify(j).slice(0, max) : null;
};
const debrief = part('Débrief', 12000);
const stats = part('Stats', 9000);
const lines = [`Match Sightline n°${m.match_id} : ${m.title}.`];
if (m.our_team) lines.push(`Notre équipe, celle qui lit ce salon : ${m.our_team}. Le débrief ci-dessous est le sien.`);
if (debrief) lines.push(`Débrief (JSON) : ${debrief}`);
if (stats) lines.push(`Stats (JSON) : ${stats}`);
lines.push('Écris le résumé.');
return [{ json: { prompt: lines.join('\n\n') } }];
"""
SYSTEM = ("Tu écris pour le salon Discord d'une équipe CS2. Réponds en français, en 3 lignes au plus, sans titre ni liste "
          "à puces : le fait marquant du match, ce qui a marché, ce qui a coûté des rounds. N'utilise que des chiffres "
          "présents dans les données fournies ; si une donnée manque, n'en parle pas. Quand notre équipe est indiquée, écris "
          "de son point de vue (« nous ») : ses points forts, puis ce qui lui a coûté des rounds. Ne répète pas le "
          "titre ni le score du match : ils sont déjà affichés au-dessus.")


def sl_get(n, name, pos, path):
    """Lecture d'une route de match Sightline avec la clé « read » ; une erreur laisse passer la suite (résumé partiel).
    `path` peut contenir une expression n8n (`{{ … }}`)."""
    return node("c2000000", n, name, "n8n-nodes-base.httpRequest", 4.2, pos,
                {"url": f"={SL}/api/matches/{{{{ $('Message').first().json.match_id }}}}{path}",
                 "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth", "options": {}},
                CRED["sightline"], onError="continueRegularOutput")


def build() -> dict[Path, str]:
    w0 = workflow("sightlineW0err01", "W0 · Erreurs → Discord", [
        node("a0000000", 1, "Erreur d'un workflow", "n8n-nodes-base.errorTrigger", 1, [0, 0], {}),
        code("a0000000", 2, "Message d'erreur", [240, 0], W0_MSG),
        discord("a0000000", 3, "Discord", [480, 0]),
    ], {"Erreur d'un workflow": main("Message d'erreur"), "Message d'erreur": main("Discord")}, error=False)

    # Positions : n8n (ordre v1) exécute les branches de haut en bas ; chaque réponse à l'extension est donc au-dessus
    # de la suite de sa branche (alerte, import), pour que l'extension soit servie même si la suite ne produit rien.
    w1 = workflow("sightlineW1prac1", "W1 · PRACC → Sightline", [
        node("b1000000", 1, "Extension PRACC", "n8n-nodes-base.webhook", 2.2, [0, 0],
             {"httpMethod": "POST", "path": "pracc", "authentication": "headerAuth", "responseMode": "responseNode",
              "options": {}}, CRED["extension"], webhookId="8b3c2d1e-4f5a-4b6c-9d7e-0f1a2b3c4d5e"),
        node("b1000000", 2, "Étape ?", "n8n-nodes-base.switch", 3.2, [220, 0],
             {"mode": "expression", "numberOutputs": 5,
              "output": "={{ ({ import: 1, calendar: 2, 'faceit-wanted': 3, 'faceit-links': 4 })[$json.body && $json.body.step] || 0 }}"}),
        code("b1000000", 3, "Hors backup", [440, -160], W1_WINDOW),
        node("b1000000", 4, "Calme ?", "n8n-nodes-base.switch", 3.2, [660, -160],
             {"mode": "expression", "numberOutputs": 2, "output": "={{ $json.quiet ? 0 : 1 }}"}),
        respond("b1000000", 5, "Répondre · plus tard", [880, -320], {"fetch": [], "quiet": True}),
        code("b1000000", 6, "Trier", [880, -160], W1_SORT),
        node("b1000000", 7, "Session expirée ?", "n8n-nodes-base.switch", 3.2, [1100, -160],
             {"mode": "expression", "numberOutputs": 2, "output": "={{ $json.expired ? 0 : 1 }}"}),
        respond("b1000000", 8, "Répondre · session expirée", [1320, -480], {"fetch": [], "expired": True}),
        code("b1000000", 9, "Alerte (1 par jour)", [1320, -320], W1_ALERT),
        discord("b1000000", 10, "Discord · session", [1540, -320]),
        sl_post("b1000000", 11, "Sightline : déjà importés ?", [1320, -160], "/api/integrations/known",
                "={{ JSON.stringify({ source: 'pracc', ids: $json.uids }) }}"),
        code("b1000000", 12, "À récupérer (3 max)", [1540, -160], W1_PICK),
        respond("b1000000", 13, "Répondre · à récupérer", [1760, -160]),
        respond("b1000000", 14, "Répondre · reçu", [440, 80], {"ok": True}),
        code("b1000000", 15, "Préparer l'import", [440, 240], W1_PREP),
        sl_post("b1000000", 16, "Importer dans Sightline", [660, 240], "/api/integrations/import",
                "={{ JSON.stringify($json) }}", onError="continueRegularOutput"),
        respond("b1000000", 17, "Répondre · calendrier", [440, 400], {"ok": True}),
        code("b1000000", 18, "Calendrier PRACC", [440, 560], W1_CAL),
        sl_post("b1000000", 19, "Sightline : calendrier", [660, 560], "/api/integrations/calendar", "={{ JSON.stringify($json) }}"),
        # démos FACEIT d'un adversaire (/demos sur Discord, ou d'office par W6) : la page du match à ouvrir, puis ses liens
        sl_post("b1000000", 20, "Sightline : démos FACEIT", [440, 720], "/api/integrations/faceit-wanted",
                "={{ JSON.stringify({}) }}", onError="continueRegularOutput"),
        respond("b1000000", 21, "Répondre · démos FACEIT", [660, 720]),
        sl_post("b1000000", 22, "Sightline : liens FACEIT", [440, 880], "/api/integrations/faceit-links",
                "={{ JSON.stringify($json.body) }}", onError="continueRegularOutput"),
        respond("b1000000", 23, "Répondre · liens FACEIT", [660, 880]),
        code("b1000000", 24, "Alerte FACEIT (1 par jour)", [660, 1040], W1_FACEIT_ALERT),
        discord("b1000000", 25, "Discord · FACEIT", [880, 1040]),
    ], {
        "Extension PRACC": main("Étape ?"),
        "Étape ?": fan(["Hors backup"], ["Répondre · reçu", "Préparer l'import"], ["Répondre · calendrier", "Calendrier PRACC"],
                       ["Sightline : démos FACEIT"], ["Sightline : liens FACEIT"]),
        "Sightline : démos FACEIT": main("Répondre · démos FACEIT"),
        "Sightline : liens FACEIT": fan(["Répondre · liens FACEIT", "Alerte FACEIT (1 par jour)"]),
        "Alerte FACEIT (1 par jour)": main("Discord · FACEIT"),
        "Calendrier PRACC": main("Sightline : calendrier"),
        "Hors backup": main("Calme ?"),
        "Calme ?": main("Répondre · plus tard", "Trier"),
        "Trier": main("Session expirée ?"),
        "Session expirée ?": fan(["Répondre · session expirée", "Alerte (1 par jour)"], ["Sightline : déjà importés ?"]),
        "Alerte (1 par jour)": main("Discord · session"),
        "Sightline : déjà importés ?": main("À récupérer (3 max)"),
        "À récupérer (3 max)": main("Répondre · à récupérer"),
        "Préparer l'import": main("Importer dans Sightline"),
    })

    w2 = workflow("sightlineW2disc1", "W2 · Sightline → Discord", [
        node("c2000000", 1, "Sightline", "n8n-nodes-base.webhook", 2.2, [0, 0],
             {"httpMethod": "POST", "path": "sightline", "authentication": "jwtAuth", "options": {}}, CRED["hook"],
             webhookId="5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"),
        code("c2000000", 2, "Message", [220, 0], W2_MSG),
        node("c2000000", 3, "Match ?", "n8n-nodes-base.switch", 3.2, [440, 0],
             {"mode": "expression", "numberOutputs": 2, "output": "={{ $json.isMatch ? 1 : 0 }}"}),
        discord("c2000000", 4, "Discord · message", [680, -160]),
        # le débrief se calcule pour une équipe (la première du match par défaut) : on demande le nôtre
        sl_get(5, "Débrief", [680, 80],
               "/debrief{{ $('Message').first().json.our_team_id ? '?team=' + $('Message').first().json.our_team_id : '' }}"),
        sl_get(6, "Stats", [900, 80], "/stats"),
        code("c2000000", 7, "Données du match", [1120, 80], W2_DATA),
        node("c2000000", 8, "Résumé", "@n8n/n8n-nodes-langchain.chainLlm", 1.9, [1340, 80],
             {"promptType": "define", "text": "={{ $json.prompt }}",
              "messages": {"messageValues": [{"type": "SystemMessagePromptTemplate", "message": SYSTEM}]}},
             onError="continueRegularOutput"),
        node("c2000000", 11, "Claude Haiku", "@n8n/n8n-nodes-langchain.lmChatAnthropic", 1.6, [1340, 300],
             {"model": {"__rl": True, "mode": "id", "value": "claude-haiku-5-5"},
              "options": {"maxTokensToSample": 600, "temperature": 0.2,
                          # sans raisonnement : Haiku 5.5 réfléchit par défaut et épuisait les 600 jetons (résumé vide)
                          "thinkingMode": "disabled"}}, CRED["anthropic"]),
        code("c2000000", 9, "Embed", [1560, 80], W2_EMBED),
        discord("c2000000", 10, "Discord · match", [1780, 80], embed=True),
    ], {
        "Sightline": main("Message"),
        "Message": main("Match ?"),
        "Match ?": main("Discord · message", "Débrief"),
        "Débrief": main("Stats"),
        "Stats": main("Données du match"),
        "Données du match": main("Résumé"),
        "Résumé": main("Embed"),
        "Embed": main("Discord · match"),
        "Claude Haiku": {"ai_languageModel": [[{"node": "Résumé", "type": "ai_languageModel", "index": 0}]]},
    })

    # Formulaire protégé par un identifiant d'équipe (Basic Auth) ; n8n ne garde pas les exécutions (ni les fichiers de
    # 100 à 300 Mo qu'elles contiennent) : une erreur part quand même sur Discord par W0.
    w4 = workflow("sightlineW4form1", "W4 · Formulaire → Sightline", [
        node("d4000000", 1, "Formulaire", "n8n-nodes-base.formTrigger", 2.6, [0, 0],
             {"authentication": "basicAuth", "formTitle": "Envoyer une démo à Sightline",
              "formDescription": "Dépose une démo CS2 (.dem ou .dem.bz2). Elle est importée dans le dossier Formulaire, "
                                 "analysée, puis annoncée sur #sightline.",
              "formFields": {"values": [
                  {"fieldLabel": "Démo", "fieldName": "demo", "fieldType": "file", "multipleFiles": False,
                   "acceptFileTypes": ".dem,.bz2", "requiredField": True},
                  {"fieldLabel": "Adversaire", "fieldName": "opponent", "fieldType": "text", "placeholder": "Facultatif"},
              ]},
              "responseMode": "onReceived",
              # en 2.6, le chemin et le message de fin sont des options (un « path » de premier niveau est ignoré)
              "options": {"path": "import-demo", "buttonLabel": "Envoyer", "appendAttribution": False, "ignoreBots": True,
                          "respondWithOptions": {"values": {
                              "respondWith": "text",
                              "formSubmittedText": "Démo reçue. Elle est en cours d'import : l'annonce arrivera sur #sightline."}}}},
             CRED["form"], webhookId="2c7d9e4f-1a3b-4c5d-8e9f-a0b1c2d3e4f5"),
        code("d4000000", 2, "Fichier", [220, 0], W4_FILE),
        node("d4000000", 3, "Vers Sightline", "n8n-nodes-base.httpRequest", 4.2, [440, 0],
             {"method": "POST", "url": f"{SL}/api/integrations/upload", "authentication": "genericCredentialType",
              "genericAuthType": "httpHeaderAuth", "sendBody": True, "contentType": "multipart-form-data",
              "bodyParameters": {"parameters": [
                  {"parameterType": "formBinaryData", "name": "file", "inputDataFieldName": "demo"},
                  {"name": "opponent", "value": "={{ $json.opponent }}"},
              ]},
              "options": {"timeout": 600000}}, CRED["sightline"]),
    ], {"Formulaire": main("Fichier"), "Fichier": main("Vers Sightline")},
        saveDataSuccessExecution="none", saveDataErrorExecution="none")

    w5 = workflow("sightlineW5prep01", "W5 · Prép d'avant-match → Discord", [
        node("e5000000", 1, "Toutes les 15 min", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 0],
             {"rule": {"interval": [{"field": "cronExpression", "expression": "*/15 * * * *"}]}}),
        sl_post("e5000000", 2, "Sightline : à venir", [220, 0], "/api/integrations/upcoming", "={{ JSON.stringify({ hours: 24 }) }}"),
        code("e5000000", 3, "Messages de prép", [440, 0], W5_MSG),
        discord("e5000000", 4, "Discord · prép", [660, 0], embed=True),
    ], {"Toutes les 15 min": main("Sightline : à venir"), "Sightline : à venir": main("Messages de prép"),
        "Messages de prép": main("Discord · prép")})

    w6 = workflow("sightlineW6fcal01", "W6 · FACEIT → calendrier", [
        # décalé de 7 min sur W5 : la prép d'un match déplacé part dans la foulée
        node("f6000000", 1, "Toutes les 15 min", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 0],
             {"rule": {"interval": [{"field": "cronExpression", "expression": "7-59/15 * * * *"}]}}),
        sl_post("f6000000", 2, "Sightline : matchs FACEIT", [220, 0], "/api/integrations/faceit-calendar",
                "={{ JSON.stringify({}) }}", onError="continueRegularOutput"),
        code("f6000000", 3, "Horaires déplacés", [440, 0], W6_MSG),
        discord("f6000000", 4, "Discord · horaire", [660, 0]),
    ], {"Toutes les 15 min": main("Sightline : matchs FACEIT"), "Sightline : matchs FACEIT": main("Horaires déplacés"),
        "Horaires déplacés": main("Discord · horaire")})

    creds = [  # VIDES : l'utilisateur colle les valeurs dans n8n (deploy/n8n/README.md)
        {"id": "slCredExtPracc01", "name": "Extension PRACC", "type": "httpHeaderAuth",
         "data": {"name": "X-Sightline-Extension", "value": ""}},
        {"id": "slCredSightline1", "name": "Sightline", "type": "httpHeaderAuth", "data": {"name": "Authorization", "value": ""}},
        {"id": "slCredSlHook0001", "name": "Sightline webhook", "type": "jwtAuth",
         "data": {"keyType": "passphrase", "secret": "", "algorithm": "HS256"}},
        {"id": "slCredAnthropic1", "name": "Anthropic", "type": "anthropicApi",
         "data": {"apiKey": "", "url": "https://api.anthropic.com"}},
        {"id": "slCredDiscord001", "name": "Discord Sightline", "type": "discordWebhookApi", "data": {"webhookUri": ""}},
        {"id": "slCredFormBasic1", "name": "Formulaire d'import", "type": "httpBasicAuth", "data": {"user": "", "password": ""}},
    ]
    dump = lambda obj: json.dumps(obj, ensure_ascii=False, indent=2) + "\n"  # noqa: E731
    return {HERE / "workflows" / "w0-erreurs.json": dump(w0), HERE / "workflows" / "w1-pracc.json": dump(w1),
            HERE / "workflows" / "w2-discord.json": dump(w2), HERE / "workflows" / "w4-formulaire.json": dump(w4),
            HERE / "workflows" / "w5-prep.json": dump(w5), HERE / "workflows" / "w6-faceit.json": dump(w6),
            HERE / "credentials.template.json": dump(creds)}


if __name__ == "__main__":
    files = build()
    if "--check" in sys.argv:
        stale = [p.name for p, text in files.items() if not p.is_file() or p.read_text(encoding="utf-8") != text]
        if stale:
            print("À régénérer (python deploy/n8n/build_workflows.py) :", ", ".join(stale))
            sys.exit(1)
    else:
        for p, text in files.items():
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8", newline="\n")
        print("écrit :", ", ".join(p.name for p in files))
