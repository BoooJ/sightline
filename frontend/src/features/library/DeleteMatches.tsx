import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { MatchSummary } from "../../shared/api/types";
import { formatDate } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";

/** Confirmation de suppression d'un ou plusieurs matchs : ce qui part, ce qui reste. */
export function DeleteMatchesDialog({ matches, onClose, onDeleted }: { matches: MatchSummary[]; onClose: () => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const n = matches.length;
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      for (const m of matches) { await api.deleteDemo(m.demo_id); setDone((x) => x + 1); }
      await Promise.all([qc.invalidateQueries({ queryKey: ["matches"] }), qc.invalidateQueries({ queryKey: ["demos"] })]);
      onDeleted?.();
      onClose();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dialog panel dm-dialog" role="alertdialog" aria-label={`Supprimer ${n} match${n > 1 ? "s" : ""}`} data-testid="delete-dialog">
        <h2 className="display dm-title"><Icon name="trash" />Supprimer {n > 1 ? `${n} matchs` : "ce match"} ?</h2>
        <ul className="dm-list">
          {matches.slice(0, 8).map((m) => (
            <li key={m.id}><b>{m.team_a.name} {m.score_a}–{m.score_b} {m.team_b.name}</b><span className="st-legend">{m.map_display_name} · {formatDate(m.date ?? m.played_at)}</span></li>
          ))}
          {n > 8 && <li className="st-legend">… et {n - 8} autre{n - 8 > 1 ? "s" : ""}</li>}
        </ul>
        <div className="dm-what">
          <div><b className="neg">Supprimé</b> le fichier de démo, les rounds et le replay, l'analyse, les commentaires, dessins, signets et comms de {n > 1 ? "ces matchs" : "ce match"}, et leurs rounds dans les playlists.</div>
          <div><b className="pos">Conservé</b> les stratégies du stratbook, les autres matchs, les statistiques des autres matchs.</div>
        </div>
        <p className="st-legend">Action définitive : pour retrouver un match, il faudra réimporter sa démo.</p>
        {err && <p className="auth-error">{err}</p>}
        <div className="dm-foot">
          <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>Annuler</Button>
          <Button variant="danger" onClick={run} disabled={busy} data-testid="confirm-delete">
            {busy ? `Suppression… ${done}/${n}` : `Supprimer ${n > 1 ? `les ${n} matchs` : "le match"}`}</Button>
        </div>
      </div>
    </div>
  );
}
