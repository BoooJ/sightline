import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import { clearPersisted } from "../../shared/api/persist";
import { forgetFiles3d } from "../replay3d/glbCache";
import type { AuthState } from "../../shared/api/types";
import { APP_NAME } from "../../shared/brand";
import { Button } from "../../shared/ui/Button";
import { Spinner } from "../../shared/ui/Spinner";
import "./team.css";

const Ctx = createContext<AuthState>({ user: null, setup_required: true });
export const useAuth = () => useContext(Ctx);
export const ROLE_LABEL: Record<string, string> = { owner: "Propriétaire", admin: "Administrateur", member: "Membre" };

/** Si l'équipe a des comptes et que personne n'est connecté : écran de connexion. Sinon l'application. */
export function AuthGate({ children, publicRoute }: { children: ReactNode; publicRoute: boolean }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000, retry: false });
  useEffect(() => {
    const on = () => qc.invalidateQueries({ queryKey: ["me"] });
    window.addEventListener("auth-required", on);
    return () => window.removeEventListener("auth-required", on);
  }, [qc]);
  // le serveur ne connaît plus personne (session expirée, compte retiré, déconnexion dans un autre onglet) : copies des
  // fichiers 3D de l'équipe effacées. Seulement sur sa réponse : ni sur un `me` en échec (serveur redémarré, réseau
  // coupé), ni sur un 401 isolé (un seul fichier refusé)
  const nobody = !!me.data && !me.data.user && !me.data.setup_required;
  useEffect(() => { if (nobody) void forgetFiles3d(); }, [nobody]);
  if (me.isLoading) return <div className="auth-screen"><Spinner /></div>;
  const state = me.data ?? { user: null, setup_required: false };
  if (!publicRoute && !state.user && !state.setup_required) return <LoginScreen />;
  // serveur sans compte : rien n'est accessible avant la création du compte propriétaire (avec le code d'installation)
  if (!publicRoute && !state.user && state.setup_code_required) return <SetupScreen />;
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** Déconnexion : rien de la session ni des fichiers 3D de l'équipe (cartes, bras) ne reste dans le navigateur. Les
 *  copies des fichiers 3D sont effacées en même temps que la demande au serveur, même si celle-ci échoue (2 s au plus). */
export async function signOut(qc: QueryClient): Promise<void> {
  await Promise.all([forgetFiles3d(), api.logout()]);
  qc.clear();
  clearPersisted();
  window.location.assign("/");
}

function Brand() {
  return (
    <div className="auth-brand">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="28" height="28">
        <path d="M4 18 12 4l8 14" /><path d="M8 18h8" /><circle cx="12" cy="13" r="1.6" fill="currentColor" stroke="none" />
      </svg>
      <span className="display">{APP_NAME}</span>
    </div>
  );
}

function useSubmit(fn: () => Promise<unknown>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await fn(); await qc.invalidateQueries(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return { submit, error, busy };
}

function LoginScreen() {
  const [username, setUsername] = useState(""), [password, setPassword] = useState("");
  const { submit, error, busy } = useSubmit(() => api.login(username, password));
  return (
    <div className="auth-screen">
      <form className="auth-card panel" onSubmit={submit} data-testid="login-form">
        <Brand />
        <h1 className="display">Connexion</h1>
        <p className="auth-sub">Accès réservé aux membres de l'équipe.</p>
        <label className="auth-field"><span>Identifiant</span><input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label className="auth-field"><span>Mot de passe</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !username || !password}>Se connecter</Button>
        <p className="auth-foot">Pas de compte ? Demandez un lien d'invitation à un administrateur de l'équipe.</p>
      </form>
    </div>
  );
}

function SetupScreen() {
  return (
    <div className="auth-screen">
      <div className="auth-card panel">
        <Brand />
        <h1 className="display">Installation</h1>
        <p className="auth-sub">Créez le compte propriétaire de l'équipe. Le code d'installation est écrit dans les logs
          du serveur au démarrage (<code>docker compose logs sightline</code>).</p>
        <AccountForm mode="setup" needCode />
      </div>
    </div>
  );
}

export function AccountForm({ mode, token, role, needCode }: { mode: "setup" | "register"; token?: string; role?: string | null; needCode?: boolean }) {
  const nav = useNavigate();
  const [username, setUsername] = useState(""), [name, setName] = useState(""), [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const { submit, error, busy } = useSubmit(async () => {
    const p = { username, display_name: name || username, password };
    await (mode === "setup" ? api.setup({ ...p, setup_code: code || undefined }) : api.register({ ...p, token: token! }));
    nav(mode === "setup" ? "/team" : "/");
  });
  return (
    <form className="auth-form" onSubmit={submit} data-testid={`${mode}-form`}>
      {needCode && <label className="auth-field"><span>Code d'installation</span><input autoFocus autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ex. 5B09B5FC" /></label>}
      <label className="auth-field"><span>Identifiant</span><input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ex. coach" /></label>
      <label className="auth-field"><span>Nom affiché</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Coach Alex" /></label>
      <label className="auth-field"><span>Mot de passe (8 caractères min.)</span><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy || !username || password.length < 8 || (needCode && !code)}>
        {mode === "setup" ? "Créer le compte propriétaire" : `Rejoindre l'équipe${role ? ` (${ROLE_LABEL[role]?.toLowerCase()})` : ""}`}
      </Button>
    </form>
  );
}

export function InvitePage() {
  const token = useParams().token!;
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.inviteInfo(token), retry: false });
  return (
    <div className="auth-screen">
      <div className="auth-card panel">
        <Brand />
        <h1 className="display">Invitation</h1>
        {info.isLoading ? <Spinner /> : info.data?.valid ? (<>
          <p className="auth-sub">Vous êtes invité à rejoindre l'équipe. Choisissez vos identifiants.</p>
          <AccountForm mode="register" token={token} role={info.data.role} />
        </>) : (
          <p className="auth-error">Ce lien d'invitation est invalide, déjà utilisé ou expiré. <Link to="/" className="pl-link">Retour</Link></p>
        )}
      </div>
    </div>
  );
}
