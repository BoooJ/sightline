import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Shape } from "../../shared/api/types";
import { Icon } from "../../shared/ui/Icon";
import { useReplayStore } from "./store";

/** État diffusé par le meneur d'une revue de groupe. */
export interface LiveState {
  match_id?: number; round?: number; tick?: number; playing?: boolean; speed?: number; shapes?: Shape[]; level?: string;
  version: number; leader: string; viewers: number; ended?: boolean;
}

const keyOf = (code: string) => `live-key-${code}`;
const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* stockage indisponible */ } },
};

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status}`);
  return r.json();
}

/** Revue synchronisée : le meneur publie round, instant, lecture, vitesse et dessins ; les participants suivent.
 *  Le code de session vient de l'URL (?live=CODE) ; le meneur garde sa clé dans sessionStorage. */
export function useLiveSession({ matchId, roundNumber, tickrate, shapes }: { matchId: number; roundNumber: number; tickrate: number; shapes: Shape[] }) {
  const [search, setSearch] = useSearchParams();
  const nav = useNavigate();
  const code = (search.get("live") ?? store.get("live-active") ?? "").toUpperCase() || null;
  const key = code ? store.get(keyOf(code)) : null;
  const role: "leader" | "follower" | null = code ? (key ? "leader" : "follower") : null;
  const [state, setState] = useState<LiveState | null>(null);
  const [detached, setDetached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveShapes, setLiveShapes] = useState<Shape[]>([]);

  // le code reste dans l'URL (lien à partager, survit aux changements de round)
  useEffect(() => {
    if (code && search.get("live") !== code) setSearch((p) => { const n = new URLSearchParams(p); n.set("live", code); return n; }, { replace: true });
  }, [code, roundNumber]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- meneur : publie l'état à chaque changement notable (au plus toutes les 250 ms en lecture)
  const last = useRef<{ round: number; tick: number; playing: boolean; speed: number; shapes: string; at: number } | null>(null);
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  useEffect(() => {
    if (role !== "leader" || !code || !key) return;
    const push = (force = false) => {
      const st = useReplayStore.getState();
      const shapes = shapesRef.current, sh = JSON.stringify(shapes);
      const prev = last.current, now = performance.now();
      // instant attendu chez les participants si rien n'a changé (lecture continue)
      const expected = prev ? prev.tick + (prev.playing ? ((now - prev.at) / 1000) * tickrate * prev.speed : 0) : -1;
      const changed = !prev || prev.round !== roundNumber || prev.playing !== st.playing || prev.speed !== st.speed || prev.shapes !== sh
        || Math.abs(expected - st.tick) > 0.4 * tickrate;
      if (!changed && !force) return;
      last.current = { round: roundNumber, tick: st.tick, playing: st.playing, speed: st.speed, shapes: sh, at: now };
      post(`/api/live/${code}/state`, { key, match_id: matchId, round: roundNumber, tick: Math.round(st.tick), playing: st.playing,
        speed: st.speed, shapes, level: st.level }).then((r) => setState((s) => (s ? { ...s, viewers: r.viewers } : s)))
        .catch((e) => setError((e as Error).message));
    };
    push(true);
    const id = window.setInterval(() => push(), 250);
    const unsub = useReplayStore.subscribe((st, prev) => { if (st.playing !== prev.playing || st.speed !== prev.speed) push(); });
    return () => { window.clearInterval(id); unsub(); };
  }, [role, code, key, matchId, roundNumber, tickrate]);

  // ---- tout le monde : abonnement (le meneur y lit le nombre de participants)
  useEffect(() => {
    if (!code) return;
    const es = new EventSource(`/api/live/${code}/events${role === "leader" ? "?leader=true" : ""}`);
    es.addEventListener("state", (ev) => {
      const st = JSON.parse((ev as MessageEvent).data) as LiveState;
      setState(st);
      if (st.ended && role === "follower") es.close();
    });
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setError("Session terminée ou introuvable"); };
    return () => es.close();
  }, [code, role]);

  // ---- participant : applique l'état du meneur
  useEffect(() => {
    if (role !== "follower" || !state || detached || state.ended) return;
    if (state.match_id && state.round && (state.match_id !== matchId || state.round !== roundNumber)) {
      nav(`/matches/${state.match_id}/replay/${state.round}?live=${code}`);
      return;
    }
    const st = useReplayStore.getState();
    if (state.speed && st.speed !== state.speed) st.setSpeed(state.speed);
    if (state.level && st.level !== state.level) st.setLevel(state.level);
    if (typeof state.tick === "number" && (!state.playing || Math.abs(st.tick - state.tick) > 0.4 * tickrate)) st.setTick(state.tick);
    if (typeof state.playing === "boolean" && st.playing !== state.playing) st.setPlaying(state.playing);
    setLiveShapes(state.shapes ?? []);
  }, [state, role, detached, matchId, roundNumber, tickrate, code, nav]);

  const start = async () => {
    setError(null);
    const st = useReplayStore.getState();
    const r = await post("/api/live", { match_id: matchId, round: roundNumber, tick: Math.round(st.tick), playing: st.playing, speed: st.speed, shapes });
    store.set(keyOf(r.code), r.key);
    store.set("live-active", r.code);
    setState(r);
    setSearch((p) => { const n = new URLSearchParams(p); n.set("live", r.code); return n; }, { replace: true });
  };
  const leave = async () => {
    if (role === "leader" && code && key) await fetch(`/api/live/${code}?key=${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
    if (code) store.del(keyOf(code));
    store.del("live-active");
    setState(null); setLiveShapes([]); setDetached(false); setError(null);
    setSearch((p) => { const n = new URLSearchParams(p); n.delete("live"); return n; }, { replace: true });
  };
  const link = code ? `${window.location.origin}/matches/${matchId}/replay/${roundNumber}?live=${code}` : "";
  return { code, role, state, detached, setDetached, error, start, leave, link, liveShapes: role === "follower" && !detached ? liveShapes : [] };
}

/** Bouton de la barre d'outils et panneau de session (lien, participants, fin). */
export function LiveButton({ live }: { live: ReturnType<typeof useLiveSession> }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (live.role === "follower") return null;
  return (
    <div className="pl-menu-wrap">
      <button type="button" className={`btn btn-sm btn-ghost ${live.role === "leader" ? "on" : ""}`} data-testid="live-button"
        title="Revue de groupe : les participants suivent votre replay en direct"
        onClick={async () => { if (!live.role) { try { await live.start(); } catch { /* erreur affichée */ } } setOpen(true); }}>
        <Icon name="live" />{live.role === "leader" ? `En direct · ${live.state?.viewers ?? 0}` : "Session de groupe"}
      </button>
      {open && live.role === "leader" && (
        <div className="pl-menu panel live-panel" role="dialog" aria-label="Session de groupe" data-testid="live-panel">
          <div className="live-row"><b>Session {live.code}</b><button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} aria-label="Fermer">✕</button></div>
          <p className="st-legend">Partagez ce lien : les participants voient votre replay (round, instant, lecture, dessins) en direct.</p>
          <div className="live-row">
            <input className="co-input" readOnly value={live.link} onFocus={(e) => e.target.select()} aria-label="Lien de la session" data-testid="live-link" />
            <button type="button" className="btn btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(live.link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* refusé */ } }}>
              {copied ? "Copié ✓" : "Copier"}</button>
          </div>
          <div className="live-row"><span className="st-legend">{live.state?.viewers ?? 0} participant{(live.state?.viewers ?? 0) > 1 ? "s" : ""} connecté{(live.state?.viewers ?? 0) > 1 ? "s" : ""}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => { void live.leave(); setOpen(false); }} data-testid="live-end">Terminer la session</button></div>
          {live.error && <p className="auth-error">{live.error}</p>}
        </div>
      )}
    </div>
  );
}

/** Bandeau des participants : qui mène, combien suivent, se détacher ou rejoindre. */
export function LiveBanner({ live }: { live: ReturnType<typeof useLiveSession> }) {
  if (live.role !== "follower") return null;
  const ended = live.state?.ended || live.error;
  return (
    <div className={`live-banner ${ended ? "ended" : ""}`} data-testid="live-banner" role="status">
      <i className="live-dot" />
      {ended ? <span>La session {live.code} est terminée.</span> : (
        <span>{live.detached ? "Détaché de" : "Vous suivez"} la session {live.code} menée par <b>{live.state?.leader ?? "…"}</b> · {live.state?.viewers ?? 0} participant{(live.state?.viewers ?? 0) > 1 ? "s" : ""}</span>
      )}
      {!ended && <button type="button" className="btn btn-sm btn-ghost" onClick={() => live.setDetached(!live.detached)}>{live.detached ? "Suivre à nouveau" : "Se détacher"}</button>}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => void live.leave()}>Quitter</button>
    </div>
  );
}
