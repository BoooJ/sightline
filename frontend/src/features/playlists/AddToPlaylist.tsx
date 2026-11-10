import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import "./playlists.css";

/** Bouton « Ajouter à une playlist » avec menu : playlists existantes ou création à la volée.
 *  `roundIds` : rounds précis ; `matchIds` : matchs entiers (tous leurs rounds, dans l'ordre). */
export function AddToPlaylist({ roundIds = [], matchIds = [], onDone, size, variant = "primary" }: {
  roundIds?: number[]; matchIds?: number[]; onDone?: (msg: string) => void; size?: "sm"; variant?: "primary" | "ghost";
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const lists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists, enabled: open });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const add = async (id: number, label: string) => {
    const r = await api.addToPlaylist(id, { rounds: roundIds, matches: matchIds });
    qc.invalidateQueries({ queryKey: ["playlists"] });
    qc.invalidateQueries({ queryKey: ["playlist", id] });
    setOpen(false);
    const skipped = roundIds.length && r.added < roundIds.length ? ` (${roundIds.length - r.added} déjà présent(s))` : "";
    onDone?.(`${r.added} round(s) ajouté(s) à « ${label} »${skipped}.`);
  };
  const create = async () => {
    const v = name.trim();
    if (!v) return;
    const p = await api.createPlaylist(v);
    setName("");
    await add(p.id, p.name);
  };
  return (
    <div className="pl-menu-wrap" ref={ref}>
      <Button size={size} variant={variant} disabled={!roundIds.length && !matchIds.length} onClick={() => setOpen(!open)} data-testid="add-to-playlist">
        <Icon name="playlist" />Ajouter à une playlist
      </Button>
      {open && (
        <div className="pl-menu panel" role="menu">
          {lists.data?.map((p) => (
            <button key={p.id} type="button" role="menuitem" onClick={() => add(p.id, p.name)}>
              <span>{p.name}</span><span className="mono">{p.count}</span>
            </button>
          ))}
          {lists.data?.length === 0 && <div className="pl-menu-empty">Aucune playlist.</div>}
          <form className="pl-menu-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <input placeholder="Nouvelle playlist…" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nom de la nouvelle playlist" />
            <Button size="sm" type="submit" disabled={!name.trim()}>Créer</Button>
          </form>
        </div>
      )}
    </div>
  );
}
