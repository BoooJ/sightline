import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { formatDateTime } from "../../shared/format";
import { Button } from "../../shared/ui/Button";

const SCOPES: [string, string][] = [["import", "Importer des démos"], ["read", "Lire les matchs"], ["comms", "Envoyer les comms (plugin TeamSpeak)"]];
const EVENTS: [string, string][] = [["demo.imported", "Démo importée"], ["match.ready", "Match analysé"], ["demo.failed", "Échec d'import"], ["comms.ready", "Comms ajoutées"]];
const labelOf = (pairs: [string, string][], v: string) => pairs.find(([k]) => k === v)?.[1] ?? v;
const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Accès des outils externes (n8n…) : clés d'API à droits limités et webhooks sortants signés, chacun montré une seule
 *  fois, avec le journal des derniers envois. Réservé au propriétaire. */
export function ApiAccess() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: api.apiKeys });
  const hooks = useQuery({ queryKey: ["webhooks"], queryFn: api.webhooks });
  const deliveries = useQuery({ queryKey: ["webhook-deliveries"], queryFn: api.webhookDeliveries, refetchInterval: 15_000 });
  const [keyName, setKeyName] = useState("n8n");
  const [scopes, setScopes] = useState<string[]>(["import", "read"]);
  const [hookUrl, setHookUrl] = useState("");
  const [events, setEvents] = useState<string[]>(EVENTS.map(([k]) => k));
  const [shown, setShown] = useState<{ kind: "key" | "secret"; value: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null); // « key-3 », « hook-2 » : second clic pour confirmer
  const [msg, setMsg] = useState<string | null>(null);
  // la clé ou le secret s'affiche en haut du bloc, loin du formulaire des webhooks : on l'amène à l'écran
  const shownRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (shown) shownRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" }); }, [shown]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); setMsg(done ?? null); } catch (e) { setMsg((e as Error).message); }
    setConfirm(null);
    for (const k of ["api-keys", "webhooks", "webhook-deliveries"]) void qc.invalidateQueries({ queryKey: [k] });
  };
  const createKey = () => act(async () => {
    const k = await api.createApiKey(keyName.trim(), scopes);
    setShown({ kind: "key", value: k.key });
  });
  const createHook = () => act(async () => {
    const h = await api.createWebhook(hookUrl.trim(), events);
    setShown({ kind: "secret", value: h.secret });
    setHookUrl("");
  });
  const copy = (v: string) => void navigator.clipboard?.writeText(v).then(() => setMsg("Copié."), () => setMsg("Copie impossible : sélectionnez le texte."));

  return (
    <section className="panel section api-access" data-testid="api-access">
      <h2 className="section-title">Accès pour n8n et autres outils</h2>
      <div className="integ-grid">
        <p className="st-legend">Une clé d'API laisse un outil importer des démos ou lire les matchs, rien d'autre. Un webhook prévient un outil quand une démo arrive, qu'un match est analysé ou qu'un import échoue ; chaque envoi est signé avec son secret.</p>
        {msg && <p className="st-legend" role="status">{msg}</p>}
        {shown && (
          <div ref={shownRef} className="notice" data-testid={shown.kind === "key" ? "key-secret" : "hook-secret"}>
            <p>{shown.kind === "key" ? "Clé d'API : copiez-la maintenant, elle ne sera plus affichée." : "Secret du webhook : copiez-le maintenant, il ne sera plus affiché."}</p>
            <code className="mono">{shown.value}</code>
            <div className="lib-tools">
              <Button size="sm" onClick={() => copy(shown.value)}>Copier</Button>
              <Button size="sm" variant="ghost" onClick={() => setShown(null)}>Fermer</Button>
            </div>
          </div>
        )}

        <h3 className="cmp-sub" style={{ textAlign: "left" }}>Clés d'API</h3>
        <table className="st-table">
          <thead><tr><th className="sb-name">Nom</th><th className="sb-name">Clé</th><th className="sb-name">Droits</th><th>Dernière utilisation</th><th /></tr></thead>
          <tbody>
            {keys.data?.map((k) => (
              <tr key={k.id} data-testid="key-row">
                <td className="sb-name">{k.name}</td>
                <td className="sb-name mono rf-dim">{k.prefix}…</td>
                <td className="sb-name">{k.scopes.map((s) => labelOf(SCOPES, s)).join(", ")}</td>
                <td>{k.revoked ? "révoquée" : k.last_used_at ? formatDateTime(k.last_used_at) : "jamais"}</td>
                <td>{!k.revoked && (confirm === `key-${k.id}`
                  ? <Button size="sm" variant="danger" onClick={() => void act(() => api.revokeApiKey(k.id), "Clé révoquée.")}>Confirmer</Button>
                  : <Button size="sm" variant="ghost" onClick={() => setConfirm(`key-${k.id}`)}>Révoquer</Button>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void createKey(); }}>
          <label className="auth-field integ-row"><span>Nom de la nouvelle clé</span>
            <input value={keyName} onChange={(e) => setKeyName(e.target.value)} maxLength={64} aria-label="Nom de la clé" data-testid="key-name" /></label>
          {SCOPES.map(([k, l]) => (
            <label key={k} className="hm-check"><input type="checkbox" checked={scopes.includes(k)} onChange={() => setScopes(toggle(scopes, k))} />{l}</label>
          ))}
          <Button type="submit" size="sm" variant="primary" disabled={!keyName.trim() || !scopes.length}>Créer la clé</Button>
        </form>

        <h3 className="cmp-sub" style={{ textAlign: "left" }}>Webhooks sortants</h3>
        <table className="st-table">
          <thead><tr><th className="sb-name">Adresse</th><th className="sb-name">Événements</th><th>Actif</th><th /></tr></thead>
          <tbody>
            {hooks.data?.map((h) => (
              <tr key={h.id} data-testid="hook-row">
                <td className="mono">{h.url}</td>
                <td className="sb-name">
                  {EVENTS.map(([k, l]) => (
                    <label key={k} className="hm-check">
                      <input type="checkbox" checked={h.events.includes(k)} aria-label={`Webhook ${h.url} : ${l}`}
                        disabled={h.events.length === 1 && h.events.includes(k)}  // au moins un événement
                        onChange={() => void act(() => api.updateWebhook(h.id, { events: toggle(h.events, k) }))} />{l}
                    </label>
                  ))}
                </td>
                <td><input type="checkbox" checked={h.active} aria-label={`Webhook ${h.url} actif`} onChange={() => void act(() => api.updateWebhook(h.id, { active: !h.active }))} /></td>
                <td className="lib-tools">
                  <Button size="sm" variant="ghost" onClick={() => void act(() => api.testWebhook(h.id), "Test envoyé : voir les derniers envois.")}>Envoyer un test</Button>
                  {confirm === `hook-${h.id}`
                    ? <Button size="sm" variant="danger" onClick={() => void act(() => api.deleteWebhook(h.id), "Webhook supprimé.")}>Confirmer</Button>
                    : <Button size="sm" variant="ghost" onClick={() => setConfirm(`hook-${h.id}`)}>Supprimer</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void createHook(); }}>
          <label className="auth-field integ-row"><span>Adresse du webhook (https://…)</span>
            <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://n8n.example.com/webhook/sightline" aria-label="Adresse du webhook" data-testid="hook-url" /></label>
          {EVENTS.map(([k, l]) => (
            <label key={k} className="hm-check"><input type="checkbox" checked={events.includes(k)} onChange={() => setEvents(toggle(events, k))} />{l}</label>
          ))}
          <Button type="submit" size="sm" variant="primary" disabled={!hookUrl.trim() || !events.length}>Ajouter le webhook</Button>
        </form>

        {!!deliveries.data?.length && (<>
          <h3 className="cmp-sub" style={{ textAlign: "left" }}>Derniers envois</h3>
          <table className="st-table">
            <thead><tr><th className="sb-name">Événement</th><th>Essai</th><th>Réponse</th><th>Durée</th><th>Date</th></tr></thead>
            <tbody>
              {deliveries.data.map((d) => (
                <tr key={d.id} data-testid="delivery-row">
                  <td className="sb-name">{d.event}</td><td>{d.attempt}</td>
                  <td className={d.error ? "rf-dim" : ""}>{d.error ?? d.status_code}</td>
                  <td>{d.duration_ms} ms</td><td>{d.created_at ? formatDateTime(d.created_at) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>)}
      </div>
    </section>
  );
}
