import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { Button } from "../../shared/ui/Button";
import { useAuth } from "./auth";
import "../../shared/notifications/notifications.css";

/** Intégrations (comme la page Settings › Integrations d'EDGE, pour ce qui est atteignable) : alertes Discord (match prêt,
 *  commentaires, rapports), adresse publique pour les liens, SteamID lié au compte. */
export function Integrations() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isOwner = user?.role === "owner"; // l'URL du webhook contient son jeton : le propriétaire seul la voit
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const [webhook, setWebhook] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [on, setOn] = useState(true);
  const [steam, setSteam] = useState(user?.steamid ?? "");
  const [ts, setTs] = useState(user?.ts_nickname ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (settings.data) { setWebhook(settings.data.discord_webhook ?? ""); setPublicUrl(settings.data.public_url ?? ""); setOn(settings.data.notify_discord !== false); } }, [settings.data]);
  const save = async () => {
    try { await api.saveSettings({ discord_webhook: webhook.trim(), public_url: publicUrl.trim(), notify_discord: on }); qc.invalidateQueries({ queryKey: ["settings"] }); setMsg("Réglages enregistrés."); }
    catch (e) { setMsg((e as Error).message); }
  };
  const test = async () => { try { await api.testNotification(); setMsg("Notification de test envoyée (cloche, et Discord si le webhook est valide)."); } catch (e) { setMsg((e as Error).message); } };
  const saveSteam = async () => { try { await api.updateMe({ steamid: steam.trim() || null }); qc.invalidateQueries({ queryKey: ["me"] }); setMsg("SteamID enregistré."); } catch (e) { setMsg((e as Error).message); } };
  const saveTs = async () => { try { await api.updateMe({ ts_nickname: ts.trim() || null }); qc.invalidateQueries({ queryKey: ["me"] }); setMsg("Pseudo TeamSpeak enregistré."); } catch (e) { setMsg((e as Error).message); } };
  return (
    <section className="panel section" data-testid="integrations">
      <h2 className="section-title">Intégrations et notifications</h2>
      <div className="integ-grid">
        <p className="st-legend">L'équipe est prévenue dans l'appli (cloche en bas du menu) quand une démo est prête, qu'un commentaire ou un rapport de préparation est publié. Avec un webhook Discord, les mêmes alertes partent dans un salon.</p>
        {isOwner ? (
          <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label className="auth-field integ-row"><span>Webhook Discord</span><input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://discord.com/api/webhooks/…" aria-label="Webhook Discord" data-testid="integ-webhook" /></label>
            <label className="auth-field integ-row"><span>Adresse publique du site (pour les liens dans Discord)</span><input value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://…" aria-label="Adresse publique" /></label>
            <label className="hm-check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />Envoyer les alertes sur Discord</label>
            <div className="lib-tools"><Button type="submit" size="sm" variant="primary" data-testid="integ-save">Enregistrer</Button><Button size="sm" variant="ghost" onClick={() => void test()} disabled={!settings.data?.discord_webhook}>Envoyer un test</Button></div>
          </form>
        ) : <p className="st-legend">Seul le propriétaire de l'équipe modifie le webhook Discord.</p>}
        {user && (
          <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void saveSteam(); }}>
            <label className="auth-field integ-row"><span>Mon SteamID64 (tableau de bord, « mon rôle » et « mes stats » dans la bibliothèque)</span><input value={steam} onChange={(e) => setSteam(e.target.value)} placeholder="7656119…" aria-label="SteamID64" inputMode="numeric" data-testid="integ-steam" /></label>
            <Button type="submit" size="sm" disabled={steam.trim() === (user.steamid ?? "")}>Enregistrer le SteamID</Button>
          </form>
        )}
        {user && (
          <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void saveTs(); }}>
            <label className="auth-field integ-row"><span>Mon pseudo TeamSpeak (range mes comms sous mon joueur)</span><input value={ts} onChange={(e) => setTs(e.target.value)} placeholder="tel qu'il apparaît dans TeamSpeak" aria-label="Pseudo TeamSpeak" maxLength={64} data-testid="integ-ts" /></label>
            <Button type="submit" size="sm" disabled={ts.trim() === (user.ts_nickname ?? "")}>Enregistrer le pseudo</Button>
          </form>
        )}
        <p className="st-legend">L'import automatique des matchs matchmaking (sharecode) demande un bot Steam connecté au jeu : non proposé. Les démos s'importent par fichier, par dossier ou par lien ; les matchs FACEIT / ESEA via le scouting FACEIT.</p>
        {msg && <p className="st-legend">{msg}</p>}
      </div>
    </section>
  );
}
