import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { api } from "../../shared/api/client";
import { useMyPlayer } from "../../shared/myPlayer";
import { useUrlParams } from "../../shared/useUrlParams";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Markdown } from "./Markdown";
import "./assistant.css";

interface Msg { role: "user" | "assistant"; content: string; steps?: string[]; error?: string; usage?: { input: number; output: number } }

const STORE = "assistant-chat";
const SUGGESTIONS = [
  "Résume notre dernier match : pourquoi on a perdu ou gagné ?",
  "Sur quelle carte et quel camp perd-on le plus de rounds, et pourquoi ?",
  "Comment mes morts se répartissent-elles ? Lesquelles étaient évitables ?",
  "Comment les meilleurs joueurs de la bibliothèque jouent l'ancre A en CT sur Mirage ?",
  "Quelles tactiques T l'adversaire utilise-t-il le plus, et sur quel site ?",
  "Quels sont nos rounds eco gagnés, et qu'est-ce qui a marché ?",
];

/** Assistant IA : questions en français sur les démos de la bibliothèque, réponses appuyées sur les données
 *  (liens vers les rounds, matchs, joueurs). La clé API est saisie par le propriétaire et reste sur le serveur. */
export function AssistantPage() {
  const status = useQuery({ queryKey: ["ai-status"], queryFn: api.aiStatus });
  const [params] = useUrlParams();
  const match = params.get("match");
  const me = useMyPlayer();
  const loc = useLocation();
  const [msgs, setMsgs] = useState<Msg[]>(() => { try { return JSON.parse(localStorage.getItem(STORE) ?? "[]"); } catch { return []; } });
  const [input, setInput] = useState(params.get("q") ?? "");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(msgs.slice(-40))); } catch { /* stockage indisponible */ } }, [msgs]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const history: Msg[] = [...msgs, { role: "user", content: q }];
    setMsgs([...history, { role: "assistant", content: "", steps: [] }]);
    setInput("");
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const patch = (f: (m: Msg) => Msg) => setMsgs((ms) => [...ms.slice(0, -1), f(ms[ms.length - 1])]);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({
          messages: history.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content })),
          context: { me, match: match ? Number(match) : undefined, page: loc.pathname },
        }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        patch((m) => ({ ...m, error: d.detail ?? `Erreur ${res.status}` }));
        return;
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k: number;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, k); buf = buf.slice(k + 2);
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "text") patch((m) => ({ ...m, content: m.content + ev.text }));
          else if (ev.type === "step") patch((m) => ({ ...m, steps: [...(m.steps ?? []), ev.label] }));
          else if (ev.type === "error") patch((m) => ({ ...m, error: ev.message }));
          else if (ev.type === "done") patch((m) => ({ ...m, usage: ev.usage }));
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") patch((m) => ({ ...m, error: "Connexion interrompue." }));
      else patch((m) => ({ ...m, error: m.content ? undefined : "Arrêté." }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  if (status.isLoading) return <div className="page"><Spinner /></div>;
  const st = status.data;
  return (
    <div className="ai">
      <header className="ai-head">
        <div>
          <div className="eyebrow">Tableau de bord</div>
          <h1 className="display">Assistant</h1>
          <p className="st-legend">Posez vos questions sur les démos de la bibliothèque : l'assistant consulte les données de Sightline et cite les rounds.</p>
        </div>
        <div className="ai-head-actions">
          {st?.enabled && <span className="ai-model mono" title="Modèle utilisé">{st.models[st.model] ?? st.model}</span>}
          {msgs.length > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { abort.current?.abort(); setMsgs([]); }} data-testid="ai-new">
            <Icon name="refresh" />Nouvelle conversation</button>}
          {st?.can_configure && st.enabled && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSettings(!settings)} aria-expanded={settings}>
            <Icon name="settings" />Réglages</button>}
        </div>
      </header>

      {(!st?.enabled || settings) && <Setup status={st} onDone={() => setSettings(false)} />}

      {st?.enabled && (<>
        <div className="ai-thread" data-testid="ai-thread">
          {!msgs.length && (
            <div className="ai-empty">
              <p>Exemples de questions{match ? ` (le match ${match} est joint à la conversation)` : ""} :</p>
              <div className="ai-suggest">
                {SUGGESTIONS.map((s) => <button key={s} type="button" className="ai-chip" onClick={() => void send(s)}>{s}</button>)}
              </div>
            </div>
          )}
          {msgs.map((m, k) => (
            <div key={k} className={`ai-msg ${m.role}`} data-testid={`ai-${m.role}`}>
              {m.role === "assistant" && !!m.steps?.length && (
                <details className="ai-steps" open={busy && k === msgs.length - 1}>
                  <summary>{m.steps.length} donnée{m.steps.length > 1 ? "s" : ""} consultée{m.steps.length > 1 ? "s" : ""}</summary>
                  <ul>{m.steps.map((s, j) => <li key={j}>{s}</li>)}</ul>
                </details>
              )}
              {m.role === "user" ? <p>{m.content}</p> : m.content ? <Markdown text={m.content} /> : busy && k === msgs.length - 1 ? <p className="ai-thinking"><Spinner /> Analyse en cours…</p> : null}
              {m.error && <p className="ai-error" role="alert">{m.error}</p>}
              {m.usage && <small className="ai-usage mono" title="Jetons consommés (entrée / sortie)">{m.usage.input.toLocaleString("fr-FR")} / {m.usage.output.toLocaleString("fr-FR")} jetons</small>}
            </div>
          ))}
          <div ref={end} />
        </div>
        <form className="ai-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} placeholder="Votre question… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"
            aria-label="Question" data-testid="ai-question"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
          {busy
            ? <button type="button" className="btn" onClick={() => abort.current?.abort()} data-testid="ai-stop">Arrêter</button>
            : <button type="submit" className="btn btn-primary" disabled={!input.trim()} data-testid="ai-send">Envoyer</button>}
        </form>
      </>)}
    </div>
  );
}

function Setup({ status, onDone }: { status: Awaited<ReturnType<typeof api.aiStatus>> | undefined; onDone: () => void }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(status?.model ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!status?.can_configure) {
    return <div className="panel ai-setup"><h2>Assistant non configuré</h2><p className="st-legend">Le propriétaire de l'équipe doit d'abord enregistrer une clé API Anthropic.</p></div>;
  }
  const save = async (body: Record<string, unknown>) => {
    setSaving(true); setErr(null);
    try {
      await api.aiConfig(body);
      setKey("");
      await qc.invalidateQueries({ queryKey: ["ai-status"] });
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };
  return (
    <form className="panel ai-setup" data-testid="ai-setup" onSubmit={(e) => { e.preventDefault(); void save({ api_key: key || undefined, model }); }}>
      <h2>{status.enabled ? "Réglages de l'assistant" : "Activer l'assistant"}</h2>
      <p className="st-legend">L'assistant fonctionne avec Google Gemini ou Claude (Anthropic) : collez la clé de l'un ou de l'autre, le modèle s'adapte.
        La clé est vérifiée puis gardée sur le serveur ; elle n'est jamais réaffichée.{status.providers.length ? ` Clé enregistrée : ${status.providers.map((p) => (p === "gemini" ? "Gemini" : "Anthropic")).join(", ")}.` : ""}
        {status.source === "env" && " Une clé est déjà fournie par la variable d'environnement du serveur."}</p>
      <label className="auth-field"><span>Clé API Gemini ou Anthropic{status.enabled ? " (laisser vide pour garder l'actuelle)" : ""}</span>
        <input type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Clé Google AI Studio ou sk-ant-…" data-testid="ai-key" /></label>
      <label className="auth-field"><span>Modèle</span>
        <select className="rf-select" value={model} onChange={(e) => setModel(e.target.value)} data-testid="ai-model">
          {Object.entries(status.models).map(([id, label]) => <option key={id} value={id}
            disabled={status.providers.length > 0 && !status.providers.includes(id.startsWith("gemini") ? "gemini" : "anthropic")}>{label}</option>)}
        </select></label>
      {err && <p className="ai-error" role="alert">{err}</p>}
      <div className="ai-setup-actions">
        <button type="submit" className="btn btn-primary" disabled={saving || (!status.enabled && !key.trim())}>{saving ? "Vérification…" : "Enregistrer"}</button>
        {status.source === "app" && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void save({ clear_key: true })}>Retirer la clé</button>}
      </div>
    </form>
  );
}
