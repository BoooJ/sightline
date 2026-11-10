import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { formatDate } from "../../shared/format";

/** Choix d'une démo (match) pour restreindre une vue à un seul match : celles de la carte courante, ou toutes. */
export function DemoSelect({ map, value, onChange }: { map?: string; value?: string; onChange: (id?: string) => void }) {
  const matches = useQuery({ queryKey: ["matches", map ?? "", ""], queryFn: () => api.matches({ map }) });
  return (
    <label className="rf-group"><span className="rf-label">Démo</span>
      <select className="rf-select" value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} aria-label="Démo" data-testid="demo-select">
        <option value="">{map ? "Toutes les démos de la carte" : "Toutes les démos"} ({matches.data?.length ?? 0})</option>
        {matches.data?.map((m) => (
          <option key={m.id} value={m.id}>{m.team_a.name} {m.score_a}:{m.score_b} {m.team_b.name}{map ? "" : ` · ${m.map_display_name}`} · {formatDate(m.date ?? m.imported_at)}</option>
        ))}
      </select>
    </label>
  );
}
