import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { formatDate } from "../format";
import { Icon, type IconName } from "./Icon";

type Item = { id: string; group: string; label: string; hint?: string; icon: IconName; to: string };

/** Pages de l'application (aussi utilisées par le menu) : la recherche rapide les retrouve par leur nom ou un synonyme. */
export const PAGES: (Omit<Item, "group" | "id"> & { words?: string })[] = [
  { label: "Tableau de bord", icon: "dashboard", to: "/dashboard", words: "accueil mon joueur stats" },
  { label: "Matchs", icon: "library", to: "/", words: "bibliothèque démos import" },
  { label: "Rounds", icon: "rounds", to: "/rounds", words: "recherche filtres tactique" },
  { label: "Moments forts", icon: "star", to: "/highlights", words: "ace clutch highlights" },
  { label: "Signets", icon: "bookmark", to: "/bookmarks", words: "bookmarks favoris" },
  { label: "Playlists", icon: "playlist", to: "/playlists" },
  { label: "Heatmaps", icon: "heat", to: "/heatmaps", words: "positions carte chaleur" },
  { label: "Grenades", icon: "grenade", to: "/grenades", words: "lineups smokes flashs utilitaires" },
  { label: "Callouts", icon: "pin", to: "/callouts", words: "lieux noms carte" },
  { label: "Joueurs", icon: "user", to: "/players", words: "stats rating" },
  { label: "Assistant IA", icon: "comment", to: "/assistant", words: "ia ai claude question chat aide analyse" },
  { label: "Apprendre un rôle", icon: "crosshair", to: "/learn", words: "rôle apprendre histoire round joueur suivre entry lurker support awp ancre" },
  { label: "Profils de rôle (expert)", icon: "crosshair", to: "/learn/expert?mode=role", words: "rôle profil entry lurker support awp ancre rotateur igl expert" },
  { label: "Apprendre un poste (expert)", icon: "crosshair", to: "/learn/expert", words: "rôle ancre anchor position apprendre entraînement progresser expert" },
  { label: "Classements", icon: "trophy", to: "/leaderboards", words: "leaderboard comparer comparaison" },
  { label: "Scouting", icon: "scout", to: "/scouting", words: "adversaires anti-strat playbook" },
  { label: "Veto", icon: "veto", to: "/veto", words: "pick ban simulation" },
  { label: "Stratbook", icon: "book", to: "/stratbook", words: "stratégies tactiques tableau" },
  { label: "Calendrier", icon: "calendar", to: "/calendar", words: "scrims matchs officiels planning" },
  { label: "Membres", icon: "team", to: "/team", words: "équipe invitation compte" },
];
const ACTIONS: Omit<Item, "group" | "id">[] = [
  { label: "Importer une démo par lien (FACEIT…)", icon: "download", to: "/?import=url" },
  { label: "Nouvelle stratégie", icon: "book", to: "/stratbook?new=1" },
  { label: "Nouvel événement au calendrier", icon: "calendar", to: "/calendar?new=1" },
];

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const matches = (hay: string, q: string) => norm(q).split(/\s+/).filter(Boolean).every((w) => norm(hay).includes(w));

/** Recherche rapide (Ctrl+K) : pages, actions, matchs, joueurs, équipes et stratégies, au clavier. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const matchesQ = useQuery({ queryKey: ["matches", "palette"], queryFn: () => api.matches(), enabled: open, staleTime: 30_000 });
  const playersQ = useQuery({ queryKey: ["players", "palette"], queryFn: () => api.players(), enabled: open, staleTime: 60_000 });
  const teamsQ = useQuery({ queryKey: ["scout-teams"], queryFn: api.scoutTeams, enabled: open, staleTime: 60_000 });
  const stratsQ = useQuery({ queryKey: ["strats", "palette"], queryFn: () => api.strats(), enabled: open, staleTime: 30_000 });
  useEffect(() => { if (open) { setQ(""); setSel(0); } }, [open]);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      ...PAGES.map((p) => ({ ...p, id: `p${p.to}`, group: "Pages", hint: p.words })),
      ...ACTIONS.map((a) => ({ ...a, id: `a${a.to}`, group: "Actions" })),
      ...(matchesQ.data ?? []).map((m) => ({ id: `m${m.id}`, group: "Matchs", icon: "library", to: `/matches/${m.id}`,
        label: `${m.team_a.name} ${m.score_a}–${m.score_b} ${m.team_b.name}`, hint: `${m.map_display_name} · ${formatDate(m.date ?? m.played_at)}` })),
      ...(playersQ.data ?? []).map((p) => ({ id: `j${p.steamid}`, group: "Joueurs", icon: "user", to: `/players/${p.steamid}`, label: p.name, hint: p.team })),
      ...(teamsQ.data ?? []).map((t) => ({ id: `e${t.id}`, group: "Équipes (scouting)", icon: "scout", to: `/scouting/${t.id}`, label: t.name })),
      ...(stratsQ.data ?? []).map((s) => ({ id: `s${s.id}`, group: "Stratégies", icon: "book", to: `/stratbook/${s.id}`, label: s.name, hint: `${s.side} · ${s.map.replace("de_", "")}` })),
    ];
    if (!q.trim()) return all.filter((i) => i.group === "Pages" || i.group === "Actions" || (i.group === "Matchs" && all.indexOf(i) < PAGES.length + ACTIONS.length + 5));
    return all.filter((i) => matches(`${i.label} ${i.hint ?? ""} ${i.group}`, q)).slice(0, 40);
  }, [q, matchesQ.data, playersQ.data, teamsQ.data, stratsQ.data]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);
  if (!open) return null;
  const go = (i: Item | undefined) => { if (!i) return; onClose(); nav(i.to); };
  let lastGroup = "";
  return (
    <div className="dialog-backdrop cp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cp panel" role="dialog" aria-label="Recherche rapide" data-testid="command-palette">
        <label className="cp-input"><Icon name="search" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Aller à une page, un match, un joueur, une stratégie…"
            aria-label="Recherche rapide" aria-controls="cp-list" data-testid="command-input"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); go(items[sel]); }
              else if (e.key === "Escape") onClose();
              e.stopPropagation();
            }} />
          <kbd>Échap</kbd>
        </label>
        <ul className="cp-list" id="cp-list" ref={listRef} role="listbox">
          {items.map((i, idx) => {
            const head = i.group !== lastGroup ? (lastGroup = i.group) : null;
            return [
              head && <li key={`h-${head}`} className="cp-group" role="presentation">{head}</li>,
              <li key={i.id} role="option" aria-selected={idx === sel} data-idx={idx} className={`cp-item ${idx === sel ? "on" : ""}`}
                onMouseEnter={() => setSel(idx)} onMouseDown={(e) => { e.preventDefault(); go(i); }}>
                <Icon name={i.icon} /><span className="cp-label">{i.label}</span>{i.hint && i.group !== "Pages" && <span className="cp-hint">{i.hint}</span>}
              </li>,
            ];
          })}
          {!items.length && <li className="cp-empty">Aucun résultat pour « {q} ».</li>}
        </ul>
        <div className="cp-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choisir</span><span><kbd>Entrée</kbd> ouvrir</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd> rechercher partout</span></div>
      </div>
    </div>
  );
}
