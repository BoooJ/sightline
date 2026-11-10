import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { EdgeRoleSide, EdgeRoles } from "../../shared/api/types";

export const ECONS = [[undefined, "Tous"], ["buy", "Achat"], ["eco", "Eco"], ["vs_eco", "Contre eco"], ["pistol", "Pistol"]] as const;
export const ECON_LABEL: Record<string, string> = { all: "Tous les rounds", buy: "Achat (full / force)", eco: "Eco / semi", vs_eco: "Contre une eco", pistol: "Pistols" };

export function useRoleLabels() {
  return useQuery({ queryKey: ["role-labels"], queryFn: api.roleLabels, staleTime: Infinity }).data ?? {};
}

/** Rôle EDGE et poste par camp : « T · Pack · Outside », « CT · Ancre · A Site ». */
export function EdgeRoleBadges({ edge, compact }: { edge?: EdgeRoles | null; compact?: boolean }) {
  const labels = useRoleLabels();
  if (!edge) return null;
  if (!edge.t.role && !edge.t.poste && !edge.ct.role && !edge.ct.poste) {
    return <span className="role-badges rf-dim" title="Pas assez de rounds observés pour attribuer un rôle">—</span>;
  }
  const one = (side: "t" | "ct", s: EdgeRoleSide) => {
    if (!s.role && !s.poste) return null;
    const role = s.role ? labels[s.role] ?? s.role : null;
    return (
      <span key={side} className={`role-badge edge ${side}`} title={`${side.toUpperCase()} · ${s.rounds} rounds observés${s.map ? ` · ${s.map.replace("de_", "")}` : ""}`}>
        <b>{side.toUpperCase()}</b>{role && <span>{role}</span>}{s.poste && !compact && <em>{s.poste}</em>}
      </span>
    );
  };
  return <span className="role-badges">{one("t", edge.t)}{one("ct", edge.ct)}</span>;
}

export function RoleBadges({ roles }: { roles?: { t: string | null; ct: string | null } }) {
  const labels = useRoleLabels();
  if (!roles) return null;
  return (
    <span className="role-badges">
      {roles.t && <span className="role-badge t" title="Rôle côté T">{labels[roles.t] ?? roles.t}</span>}
      {roles.ct && <span className="role-badge ct" title="Rôle côté CT">{labels[roles.ct] ?? roles.ct}</span>}
    </span>
  );
}
