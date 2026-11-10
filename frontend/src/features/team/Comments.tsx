import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { MatchComment, Shape } from "../../shared/api/types";
import { formatDate } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { useAuth } from "./auth";
import "./team.css";

const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

export function useComments(matchId: number) {
  return useQuery({ queryKey: ["comments", matchId], queryFn: () => api.comments(matchId) });
}

/** Commentaires d'équipe. Dans le replay (`round` fourni) : ceux du round, ancrés à l'instant courant, cliquables. */
export function Comments({ matchId, round, onJump, currentShapes = [] }: {
  matchId: number;
  round?: { number: number; tick: number; startTick: number; tickrate: number };
  onJump?: (tick: number, shapes: Shape[]) => void;
  /** dessins visibles à l'instant courant, joignables au commentaire */
  currentShapes?: Shape[];
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const list = useComments(matchId);
  const [text, setText] = useState("");
  const [atTime, setAtTime] = useState(true);
  const [personal, setPersonal] = useState(false);
  const [withDrawing, setWithDrawing] = useState(true);
  const rows = (list.data ?? []).filter((c) => !round || c.round_number === round.number);
  const refresh = () => qc.invalidateQueries({ queryKey: ["comments", matchId] });
  const post = async () => {
    const body = text.trim();
    if (!body) return;
    await api.addComment(matchId, { body, round_number: round?.number ?? null, tick: round && atTime ? Math.round(round.tick) : null,
      private: personal, shapes: round && withDrawing && currentShapes.length ? currentShapes : undefined });
    setText(""); refresh();
  };
  const canDelete = (c: MatchComment) => !user || c.author_id === user.id || user.role !== "member";
  const time = (c: MatchComment) => (round && c.tick != null ? clock((c.tick - round.startTick) / round.tickrate) : null);
  return (
    <div className="cm" data-testid="comments">
      <ul className="cm-list">
        {rows.map((c) => (
          <li key={c.id} className="cm-item" data-testid="comment">
            <div className="cm-head">
              <span className="team-avatar">{c.author.slice(0, 1).toUpperCase()}</span>
              <b>{c.author}</b>
              {round ? (time(c) && <button type="button" className="cm-time mono" onClick={() => onJump?.(c.tick!, c.shapes ?? [])}
                title={c.shapes?.length ? "Aller à cet instant et afficher le dessin joint" : "Aller à cet instant"}>{time(c)}</button>)
                : c.round_number != null && <Link className="cm-time mono" to={`/matches/${matchId}/replay/${c.round_number}${c.tick != null ? `?t=${c.tick}` : ""}`}>R{c.round_number}</Link>}
              {c.private && <span className="cm-badge" title="Visible par vous seulement">perso</span>}
              {!!c.shapes?.length && <span className="cm-badge draw" title="Dessin joint">dessin</span>}
              <small>{formatDate(c.created_at)}</small>
              {canDelete(c) && <button type="button" className="cm-del" aria-label="Supprimer le commentaire" onClick={async () => { await api.deleteComment(c.id); refresh(); }}><Icon name="trash" size={13} /></button>}
            </div>
            <p>{c.body}</p>
          </li>
        ))}
        {!rows.length && <li className="cm-empty">{round ? "Aucun commentaire sur ce round." : "Aucun commentaire sur ce match."}</li>}
      </ul>
      <form className="cm-form" onSubmit={(e) => { e.preventDefault(); void post(); }}>
        <textarea placeholder={round ? "Commenter ce round…" : "Commenter le match…"} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void post(); }} aria-label="Nouveau commentaire" />
        <div className="cm-actions">
          <div className="cm-opts">
            {round && <label className="hm-check"><input type="checkbox" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} />À {clock((round.tick - round.startTick) / round.tickrate)}</label>}
            {round && currentShapes.length > 0 && <label className="hm-check"><input type="checkbox" checked={withDrawing} onChange={(e) => setWithDrawing(e.target.checked)} />Joindre le dessin ({currentShapes.length})</label>}
            <label className="hm-check" title="Visible par vous seulement"><input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />Personnel</label>
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={!text.trim()}>Publier</Button>
        </div>
      </form>
    </div>
  );
}
