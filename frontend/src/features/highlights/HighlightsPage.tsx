import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { Highlight } from "../../shared/api/types";
import { formatDate, weaponLabel } from "../../shared/format";
import { useUrlParams } from "../../shared/useUrlParams";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Skeleton } from "../../shared/ui/Skeleton";
import { DemoSelect } from "../library/DemoSelect";
import { AddToPlaylist } from "../playlists/AddToPlaylist";
import "./highlights.css";

/** Liste de moments forts (lien vers le replay, sélection pour une playlist). Réutilisée dans l'analyse d'un match. */
export function HighlightList({ items, selectable, compact }: { items: Highlight[]; selectable?: boolean; compact?: boolean }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const key = (h: Highlight) => `${h.round_id}-${h.type}-${h.tick}-${h.player}`;
  const roundIds = [...new Set(items.filter((h) => sel.has(key(h))).map((h) => h.round_id))];
  const toggle = (h: Highlight) => { const s = new Set(sel); if (s.has(key(h))) s.delete(key(h)); else s.add(key(h)); setSel(s); };
  return (
    <div className="hl">
      {selectable && (
        <div className="hl-bar">
          <label className="hm-check"><input type="checkbox" checked={items.length > 0 && sel.size === items.length}
            onChange={(e) => setSel(e.target.checked ? new Set(items.map(key)) : new Set())} />Tout sélectionner</label>
          <span className="st-legend">{sel.size} sélectionné{sel.size > 1 ? "s" : ""} · {roundIds.length} round{roundIds.length > 1 ? "s" : ""}</span>
          {roundIds.length > 0 && <AddToPlaylist roundIds={roundIds} size="sm" onDone={(m) => { setNotice(m); setSel(new Set()); }} />}
          {notice && <span className="st-legend hl-notice">{notice}</span>}
        </div>
      )}
      <ul className={`hl-list ${compact ? "compact" : ""}`} data-testid="highlight-list">
        {items.map((h) => (
          <li key={key(h)} className={`hl-item hl-${h.type}`}>
            {selectable && <input type="checkbox" aria-label={`Sélectionner ${h.label} de ${h.player_name}`} checked={sel.has(key(h))} onChange={() => toggle(h)} />}
            <span className="hl-badge">{h.label}</span>
            <span className="hl-who"><b>{h.player_name}</b>{h.team && <span className="an-team"> {h.team}</span>}</span>
            <span className="hl-detail">{h.detail && /^[a-z0-9_]+$/.test(h.detail) ? weaponLabel(h.detail) : h.detail}</span>
            {!compact && <span className="hl-where mono">{h.map.replace("de_", "")} · R{h.round}{h.played_at ? ` · ${formatDate(h.played_at)}` : ""}</span>}
            {compact && <span className="hl-where mono">R{h.round}</span>}
            <Link className="btn btn-sm btn-ghost" to={`/matches/${h.match_id}/replay/${h.round}?t=${Math.max(0, h.tick - 192)}`} aria-label="Voir dans le replay"><Icon name="play" /></Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HighlightsPage() {
  const [params, set] = useUrlParams();
  const types = (params.get("type") ?? "").split(",").filter(Boolean);
  const map = params.get("map") ?? undefined, match = params.get("match") ?? undefined, player = params.get("player") ?? undefined;
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const labels = useQuery({ queryKey: ["highlight-types"], queryFn: api.highlightTypes, staleTime: Infinity });
  const players = useQuery({ queryKey: ["players", "hl"], queryFn: () => api.players({}) });
  const q = useQuery({ queryKey: ["highlights", types.join(","), map, match, player],
    queryFn: () => api.highlights({ type: types.join(",") || undefined, map, match, player }), placeholderData: (prev) => prev });
  const toggleType = (t: string) => set("type", (types.includes(t) ? types.filter((x) => x !== t) : [...types, t]).join(",") || undefined);
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Matchs</div><h1 className="display">Moments forts <span className="lib-count mono">{q.data?.total ?? 0}</span></h1></div>
      </div>
      <div className="lib-filters hl-filters">
        <div className="map-pills" role="group" aria-label="Type de moment">
          <button type="button" className={`pill ${!types.length ? "on" : ""}`} onClick={() => set("type")}>Tous</button>
          {Object.entries(labels.data ?? {}).map(([k, l]) => <button key={k} type="button" className={`pill ${types.includes(k) ? "on" : ""}`} onClick={() => toggleType(k)}>{l}</button>)}
        </div>
        <div className="hl-selects">
          <label className="rf-group"><span className="rf-label">Carte</span>
            <select className="rf-select" value={map ?? ""} onChange={(e) => set({ map: e.target.value || undefined, match: undefined })}>
              <option value="">Toutes</option>{maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}
            </select></label>
          {map && <DemoSelect map={map} value={match} onChange={(v) => set("match", v)} />}
          <label className="rf-group"><span className="rf-label">Joueur</span>
            <select className="rf-select" value={player ?? ""} onChange={(e) => set("player", e.target.value || undefined)} data-testid="hl-player">
              <option value="">Tous</option>{[...(players.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}
            </select></label>
        </div>
      </div>
      {q.isLoading ? <Skeleton rows={10} /> : !q.data?.items.length ? (
        <section className="panel section"><EmptyState icon="star" title="Aucun moment fort">Aucun moment ne correspond à ces filtres.</EmptyState></section>
      ) : (
        <section className="panel section"><HighlightList items={q.data.items} selectable /></section>
      )}
    </div>
  );
}
