import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { Bookmark } from "../../shared/api/types";
import { formatDate } from "../../shared/format";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import "./bookmarks.css";

/** Signets : les instants mis de côté dans les replays (touche S ou bouton « Signet »), regroupés par match. */
export function BookmarksPage() {
  const q = useQuery({ queryKey: ["bookmarks", "all"], queryFn: () => api.bookmarks() });
  const groups = new Map<number, { match: NonNullable<Bookmark["match"]>; items: Bookmark[] }>();
  for (const b of q.data ?? []) {
    if (!b.match) continue;
    const g = groups.get(b.match.id) ?? { match: b.match, items: [] };
    g.items.push(b); groups.set(b.match.id, g);
  }
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Matchs</div><h1 className="display">Signets <span className="lib-count mono">{q.data?.length ?? 0}</span></h1></div>
      </div>
      {q.isLoading ? <Spinner /> : !groups.size ? (
        <section className="panel section"><EmptyState icon="bookmark" title="Aucun signet">Dans un replay, appuyez sur S (ou « Signet ») pour garder un instant de côté et le retrouver ici.</EmptyState></section>
      ) : [...groups.values()].map((g) => (
        <section key={g.match.id} className="panel section bm-group" data-testid="bookmark-group">
          <header className="bm-head">
            <Link to={`/matches/${g.match.id}`} className="pl-link"><b>{g.match.team_a.name} {g.match.score_a}–{g.match.score_b} {g.match.team_b.name}</b></Link>
            <span className="st-legend">{g.match.map_display_name} · {formatDate(g.match.date ?? g.match.played_at)}</span>
          </header>
          <ul className="bm-list">
            {[...g.items].sort((a, b) => a.round_number - b.round_number || a.tick - b.tick).map((b) => <Row key={b.id} b={b} matchId={g.match.id} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Row({ b, matchId }: { b: Bookmark; matchId: number }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["bookmarks"] });
  return (
    <li data-testid="bookmark-row">
      <Icon name="bookmark" />
      <span className="mono bm-round">R{b.round_number}</span>
      <input className="bm-label" defaultValue={b.label} aria-label="Nom du signet" placeholder="Sans titre"
        onBlur={async (e) => { if (e.target.value !== b.label) { await api.renameBookmark(b.id, e.target.value); refresh(); } }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      <Link className="btn btn-sm" to={`/matches/${matchId}/replay/${b.round_number}?t=${b.tick}`}><Icon name="play" />Revoir</Link>
      <button type="button" className="btn btn-sm btn-ghost" aria-label="Supprimer le signet" onClick={async () => { await api.deleteBookmark(b.id); refresh(); }}><Icon name="trash" /></button>
    </li>
  );
}
