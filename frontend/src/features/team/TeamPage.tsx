import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { NewInvite } from "../../shared/api/types";
import { formatDate } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { AccountForm, ROLE_LABEL, useAuth } from "./auth";
import { Integrations } from "./Integrations";
import { ApiAccess } from "./ApiAccess";
import { DiscordBot } from "./DiscordBot";
import { CommsPanel } from "./CommsPanel";
import "../match/match.css";
import "./team.css";

export function TeamPage() {
  const auth = useAuth();
  if (auth.setup_required) {
    return (
      <div className="page">
        <div className="lib-head"><div><div className="eyebrow">Équipe</div><h1 className="display">Créer l'espace d'équipe</h1></div></div>
        <section className="panel section team-setup">
          <p>L'application est actuellement <b>ouverte</b> sur cet ordinateur (à distance, rien n'est accessible sans compte).
            Créez le compte <b>propriétaire</b> pour la protéger, puis invitez vos coéquipiers par lien.</p>
          <AccountForm mode="setup" />
        </section>
      </div>
    );
  }
  return <Team />;
}

function Team() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const isOwner = user?.role === "owner"; // clés et secrets : le propriétaire seul
  const members = useQuery({ queryKey: ["members"], queryFn: api.members });
  const invites = useQuery({ queryKey: ["invites"], queryFn: api.invites, enabled: isAdmin });
  const [created, setCreated] = useState<NewInvite | null>(null);
  const [inviteRole, setInviteRole] = useState("member");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); }
    qc.invalidateQueries({ queryKey: ["members"] }); qc.invalidateQueries({ queryKey: ["invites"] });
  };
  const link = created ? `${window.location.origin}${created.path}` : "";
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Équipe</div><h1 className="display">Membres <span className="lib-count mono">{members.data?.length ?? 0}</span></h1></div>
      </div>
      {err && <div className="notice" onClick={() => setErr(null)}>{err}</div>}
      <div className="team-grid">
        <section className="panel section">
          <h2 className="section-title">Membres</h2>
          <table className="st-table">
            <thead><tr><th className="sb-name">Nom</th><th className="sb-name">Identifiant</th><th className="sb-name">Rôle</th><th>Depuis</th><th /></tr></thead>
            <tbody>
              {members.data?.map((m) => (
                <tr key={m.id} data-testid="member-row">
                  <td className="sb-name"><span className="team-avatar">{m.display_name.slice(0, 1).toUpperCase()}</span>{m.display_name}{m.id === user?.id && <span className="team-you">vous</span>}</td>
                  <td className="sb-name mono rf-dim">{m.username}</td>
                  <td className="sb-name">
                    {isAdmin && m.id !== user?.id && (user?.role === "owner" || m.role !== "owner") ? (
                      <select className="rf-select team-role" value={m.role} aria-label={`Rôle de ${m.display_name}`} onChange={(e) => act(() => api.setRole(m.id, e.target.value))}>
                        {(user?.role === "owner" ? ["owner", "admin", "member"] : ["admin", "member"]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    ) : <span className={`team-badge ${m.role}`}>{ROLE_LABEL[m.role]}</span>}
                  </td>
                  <td className="mono rf-dim">{formatDate(m.created_at)}</td>
                  <td>{isAdmin && m.id !== user?.id && (user?.role === "owner" || m.role !== "owner") &&
                    <Button size="sm" variant="ghost" title="Retirer de l'équipe" aria-label={`Retirer ${m.display_name}`} onClick={() => act(() => api.removeMember(m.id))}><Icon name="trash" /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {isAdmin && (
          <section className="panel section">
            <h2 className="section-title">Inviter</h2>
            <div className="team-invite">
              <select className="rf-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} aria-label="Rôle de l'invité">
                <option value="member">Membre</option><option value="admin">Administrateur</option>
              </select>
              <Button variant="primary" onClick={() => act(async () => { setCopied(false); setCreated(await api.createInvite(inviteRole)); })}>Créer un lien</Button>
            </div>
            {created && (
              <div className="team-link">
                <code className="mono" data-testid="invite-link">{link}</code>
                <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* refusé */ } }}>{copied ? "Copié ✓" : "Copier"}</Button>
                <p className="st-legend">Lien à usage unique, valable 7 jours. Envoyez-le à votre coéquipier.</p>
              </div>
            )}
            {!!invites.data?.length && (<>
              <h3 className="cmp-sub" style={{ textAlign: "left" }}>Invitations en attente</h3>
              <ul className="gr-occ">
                {invites.data.map((i) => (
                  <li key={i.id}><span>{ROLE_LABEL[i.role]} <small>expire le {formatDate(i.expires_at)}</small></span>
                    <Button size="sm" variant="ghost" onClick={() => act(() => api.revokeInvite(i.id))}>Révoquer</Button></li>
                ))}
              </ul>
            </>)}
          </section>
        )}

        <Profile />
        <Integrations />
        {isOwner && <ApiAccess />}
        {isOwner && <DiscordBot />}
        <CommsPanel />
      </div>
    </div>
  );
}

function Profile() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState(user?.display_name ?? "");
  const [cur, setCur] = useState(""), [next, setNext] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!user) return null;
  const save = async (p: Parameters<typeof api.updateMe>[0], ok: string) => {
    try { await api.updateMe(p); setMsg(ok); setCur(""); setNext(""); qc.invalidateQueries({ queryKey: ["me"] }); qc.invalidateQueries({ queryKey: ["members"] }); }
    catch (e) { setMsg((e as Error).message); }
  };
  return (
    <section className="panel section">
      <h2 className="section-title">Mon profil</h2>
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void save({ display_name: name }, "Nom mis à jour."); }}>
        <label className="auth-field"><span>Nom affiché</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <Button type="submit" size="sm" disabled={!name.trim() || name === user.display_name}>Enregistrer</Button>
      </form>
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void save({ current_password: cur, new_password: next }, "Mot de passe changé."); }}>
        <label className="auth-field"><span>Mot de passe actuel</span><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label className="auth-field"><span>Nouveau mot de passe</span><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <Button type="submit" size="sm" disabled={!cur || next.length < 8}>Changer le mot de passe</Button>
      </form>
      {msg && <p className="st-legend">{msg}</p>}
    </section>
  );
}
