import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { CommsSessionT } from "../../shared/api/types";
import { formatDateTime } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { useAuth } from "./auth";

const STATUS: Record<CommsSessionT["status"], string> = {
  waiting: "En attente de la démo", attached: "Calées sur le match", expired: "Aucun match trouvé", error: "Erreur",
};
/** Sans décalage calculé (pas de rounds reçus du jeu), les pistes sont à 0 s : à caler à la main dans le replay. */
const statusOf = (s: CommsSessionT) => (s.status === "attached" && !s.offset_s ? "À caler à la main" : STATUS[s.status]);

/** Comms TeamSpeak : le plugin Sightline (un coéquipier l'installe) envoie les pistes de chaque map ; Sightline les
 *  cale sur la démo et les range sous chaque joueur (pseudo TeamSpeak du compte). */
export function CommsPanel() {
  const q = useQuery({ queryKey: ["comms"], queryFn: api.commsSessions, refetchInterval: 30_000 });
  const d = q.data;
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const [key, setKey] = useState<string | null>(null); // montrée une seule fois
  const [msg, setMsg] = useState<string | null>(null);
  const makeKey = async () => {
    try {
      setKey((await api.createApiKey("Plugin TeamSpeak", ["comms"])).key); setMsg(null);
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (e) { setMsg((e as Error).message); }
  };
  const copy = (v: string) => void navigator.clipboard?.writeText(v).then(() => setMsg("Copié."), () => setMsg("Copie impossible : sélectionnez le texte."));
  return (
    <section className="panel section api-access" data-testid="comms-panel">
      <h2 className="section-title">Comms TeamSpeak</h2>
      <div className="integ-grid">
        <p className="st-legend">Un coéquipier installe le plugin Sightline dans TeamSpeak 3 et y colle une clé d'API « Envoyer les comms ». À chaque map, ses pistes (une par joueur) arrivent ici et se calent seules sur la démo, dans l'onglet Comms du replay. Chacun indique son pseudo TeamSpeak dans « Intégrations et notifications ».</p>
        <p className="st-legend">{d?.plugin
          ? <a href="/api/integrations/comms/plugin" download>Télécharger le plugin (TeamSpeak 3)</a>
          : "Le plugin n'est pas encore publié sur ce serveur."}</p>
        {isAdmin && (
          <div className="lib-tools">
            <Button size="sm" onClick={() => void makeKey()} data-testid="comms-key-create">Créer une clé pour le plugin</Button>
          </div>
        )}
        {msg && <p className="st-legend" role="status">{msg}</p>}
        {key && (
          <div className="notice" data-testid="comms-key">
            <p>Clé d'API du plugin : copiez-la maintenant, elle ne sera plus affichée.</p>
            <code className="mono">{key}</code>
            <div className="lib-tools">
              <Button size="sm" onClick={() => copy(key)}>Copier</Button>
              <Button size="sm" variant="ghost" onClick={() => setKey(null)}>Fermer</Button>
            </div>
          </div>
        )}
        {d && !d.sessions.length && <p className="st-legend">Aucune session reçue pour l'instant.</p>}
        {!!d?.sessions.length && (
          <table className="st-table">
            <thead><tr><th>Reçue</th><th>Carte</th><th>Pistes</th><th>État</th></tr></thead>
            <tbody>{d.sessions.map((s) => (
              <tr key={s.id}>
                <td>{formatDateTime(s.created_at)}</td>
                <td>{s.map}</td>
                <td className="mono">{s.tracks}</td>
                <td>{s.match_id ? <Link to={`/matches/${s.match_id}`}>{statusOf(s)}</Link> : statusOf(s)}
                  {s.error && <span className="rf-dim"> · {s.error}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
