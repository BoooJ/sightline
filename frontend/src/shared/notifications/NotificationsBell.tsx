import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { NotificationT } from "../api/types";
import { formatDate } from "../format";
import { Icon } from "../ui/Icon";
import "./notifications.css";

const SEEN_KEY = "sl-notif-seen";
const HIDDEN_KEY = "sl-notif-hidden";
const KIND_ICON: Record<string, "upload" | "comment" | "print" | "live"> = { match_ready: "upload", comment: "comment", prep_report: "print", test: "live" };

/** Notifications effacées dans ce navigateur : toutes jusqu'à `upTo` (« Tout effacer »), plus celles de `ids`. */
type Hidden = { upTo: number; ids: number[] };
function readHidden(): Hidden {
  try {
    const h = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "null");
    return { upTo: Number(h?.upTo) || 0, ids: Array.isArray(h?.ids) ? h.ids.filter(Number.isFinite) : [] };
  } catch { return { upTo: 0, ids: [] }; }
}

/** Cloche de notifications d'équipe (match prêt, commentaire, rapport de préparation) : liste, non-lus, lien direct ;
 *  mise à jour instantanée par SSE. Les repères « vu » et « effacé » sont gardés dans le navigateur : effacer une
 *  notification ne la retire pas aux coéquipiers. */
export function NotificationsBell() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications"], queryFn: () => api.notifications(), refetchInterval: 120_000 });
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<number>(() => { try { return Number(localStorage.getItem(SEEN_KEY) ?? 0); } catch { return 0; } });
  const [hidden, setHiddenState] = useState<Hidden>(readHidden);
  const setHidden = (h: Hidden) => { setHiddenState(h); try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(h)); } catch { /* stockage indisponible */ } };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("notification", () => qc.invalidateQueries({ queryKey: ["notifications"] }));
    return () => es.close();
  }, [qc]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const all: NotificationT[] = q.data ?? [];
  const list = all.filter((n) => n.id > hidden.upTo && !hidden.ids.includes(n.id));
  const unread = list.filter((n) => n.id > seen).length;
  // la liste des effacées ne garde que les notifications encore servies : elle ne grossit pas au fil des mois
  const dismiss = (id: number) => setHidden({ upTo: hidden.upTo, ids: [...hidden.ids.filter((x) => all.some((n) => n.id === x)), id] });
  const clearAll = () => setHidden({ upTo: Math.max(hidden.upTo, all[0]?.id ?? 0), ids: [] });
  const markSeen = () => { const top = list[0]?.id ?? seen; setSeen(top); try { localStorage.setItem(SEEN_KEY, String(top)); } catch { /* stockage indisponible */ } };
  return (
    <div className="nb-wrap" ref={ref}>
      <button type="button" className={`btn btn-sm btn-ghost nb-btn ${open ? "on" : ""}`} onClick={() => { setOpen(!open); if (!open) markSeen(); }}
        aria-label={unread ? `Notifications (${unread} non lue${unread > 1 ? "s" : ""})` : "Notifications"} aria-expanded={open} data-testid="notif-bell">
        <Icon name="live" />{unread > 0 && <span className="nb-count" data-testid="notif-count">{unread}</span>}
      </button>
      {open && (
        <div className="pl-menu panel nb-menu" role="menu" data-testid="notif-menu">
          <div className="nb-head"><span className="rf-label">Notifications</span>
            <span className="nb-actions">
              {list.length > 0 && <button type="button" className="pl-link nb-clear" onClick={clearAll} data-testid="notif-clear">Tout effacer</button>}
              <Link className="pl-link" to="/team" onClick={() => setOpen(false)}>Réglages</Link>
            </span>
          </div>
          {!list.length && <p className="cm-empty">Aucune notification. Vous serez prévenu quand une démo est prête, qu'un commentaire ou un rapport est publié.</p>}
          {list.slice(0, 30).map((n) => (
            <div key={n.id} className="nb-row">
              <Link to={n.link || "/"} className={`nb-item ${n.id > seen ? "new" : ""}`} role="menuitem" onClick={() => setOpen(false)} data-testid="notif-item">
                <Icon name={KIND_ICON[n.kind] ?? "live"} size={14} />
                <span className="nb-text"><b>{n.title}</b>{n.body && <small>{n.body}</small>}<small className="rf-dim">{formatDate(n.created_at)}</small></span>
              </Link>
              <button type="button" className="nb-x" onClick={() => dismiss(n.id)} aria-label={`Effacer « ${n.title} »`} title="Effacer"
                data-testid="notif-dismiss"><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
