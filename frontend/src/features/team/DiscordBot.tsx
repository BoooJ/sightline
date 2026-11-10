import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { Button } from "../../shared/ui/Button";

/** Bot Discord de l'équipe : la commande /demos met en file des démos FACEIT d'un adversaire (2 le sont aussi d'office
 *  pour chaque nouveau match FACEIT), qu'un PC avec Chrome connecté à FACEIT et l'extension Sightline récupère. Discord
 *  appelle Sightline à l'adresse affichée ; le jeton du bot ne sert qu'à enregistrer la commande et n'est jamais réaffiché. */
export function DiscordBot() {
  const qc = useQueryClient();
  const conf = useQuery({ queryKey: ["discord"], queryFn: api.discordConfig, refetchInterval: 30_000 });
  const [edit, setEdit] = useState<{ app_id: string; public_key: string; bot_token: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const d = conf.data;
  const f = edit ?? { app_id: d?.app_id ?? "", public_key: d?.public_key ?? "", bot_token: "" };
  const set = (k: keyof typeof f, v: string) => setEdit({ ...f, [k]: v });
  const save = async () => {
    try {
      const r = await api.saveDiscordConfig({ app_id: f.app_id.trim(), public_key: f.public_key.trim(), bot_token: f.bot_token.trim() || undefined });
      setMsg(r.registered ? "Commande /demos enregistrée sur Discord." : r.error ?? "Enregistré : ajoutez le jeton du bot pour enregistrer la commande /demos.");
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ["discord"] });
    } catch (e) { setMsg((e as Error).message); }
  };
  const copy = (v: string) => void navigator.clipboard?.writeText(v).then(() => setMsg("Copié."), () => setMsg("Copie impossible : sélectionnez le texte."));

  return (
    <section className="panel section api-access" data-testid="discord-bot">
      <h2 className="section-title">Bot Discord</h2>
      <div className="integ-grid">
        <p className="st-legend">Sur Discord, <code>/demos</code> met en file des démos FACEIT d'un adversaire (le prochain par défaut) ; 2 démos le sont aussi d'office pour chaque nouveau match FACEIT. Un PC avec Chrome connecté à FACEIT et l'extension Sightline les récupère dans les 5 minutes, puis le serveur les télécharge et les analyse.</p>
        {d && (
          <p className="st-legend" data-testid="faceit-queue">
            {d.queue.waiting} en attente d'un PC · {d.queue.running} en cours · {d.queue.done} importée{d.queue.done > 1 ? "s" : ""} · {(d.disk_free / 1e9).toFixed(1)} Go libres sur le serveur
          </p>
        )}
        {msg && <p className="st-legend" role="status">{msg}</p>}
        <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="auth-field integ-row"><span>ID de l'application (Application ID)</span>
            <input value={f.app_id} onChange={(e) => set("app_id", e.target.value)} inputMode="numeric" aria-label="ID de l'application" data-testid="discord-app-id" /></label>
          <label className="auth-field integ-row"><span>Clé publique (Public Key)</span>
            <input value={f.public_key} onChange={(e) => set("public_key", e.target.value)} spellCheck={false} aria-label="Clé publique" className="mono" /></label>
          {/* new-password : Chrome ignore « off » sur un champ mot de passe et y collait le mot de passe Sightline */}
          <label className="auth-field integ-row"><span>Jeton du bot (onglet Bot › Reset Token){d?.has_token ? " : déjà enregistré" : ""}</span>
            <input type="password" value={f.bot_token} onChange={(e) => set("bot_token", e.target.value)} autoComplete="new-password"
              placeholder={d?.has_token ? "laisser vide pour le garder" : ""} aria-label="Jeton du bot" /></label>
          <Button type="submit" size="sm" variant="primary" disabled={!f.app_id.trim() || !f.public_key.trim()}>Enregistrer</Button>
        </form>
        {d?.app_id && (<>
          <p className="st-legend">Adresse à coller dans le portail Discord (General Information › Interactions Endpoint URL) :</p>
          <div className="lib-tools"><code className="mono" data-testid="discord-endpoint">{d.endpoint}</code>
            <Button size="sm" variant="ghost" onClick={() => copy(d.endpoint)}>Copier</Button></div>
          {d.invite && <p className="st-legend"><a href={d.invite} target="_blank" rel="noreferrer">Inviter le bot sur le serveur Discord</a></p>}
        </>)}
      </div>
    </section>
  );
}
