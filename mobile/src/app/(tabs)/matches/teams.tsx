import { router } from "expo-router";

import { useScoutTeams } from "@/api/hooks";
import { t } from "@/i18n/fr";
import { ListGroup, ListRow } from "@/ui/ListRow";
import { Screen } from "@/ui/Screen";
import { EmptyState, ErrorState, Loading } from "@/ui/States";

/** Choisir l'équipe adverse quand le calendrier ne permet pas de la retrouver. */
export default function Teams() {
  const teams = useScoutTeams();
  const list = [...(teams.data ?? [])].sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name));
  return (
    <Screen title={t.matches.teamsTitle} subtitle={t.matches.teamsLead} back>
      {teams.isPending ? <Loading /> : teams.isError ? <ErrorState error={teams.error} onRetry={() => void teams.refetch()} />
        : list.length === 0 ? <EmptyState text={t.prep.noData} /> : (
          <ListGroup>
            {list.map((team) => (
              <ListRow key={team.id} title={team.name}
                subtitle={`${t.common.matches(team.matches)}${team.map_list?.length ? ` · ${team.map_list.map((m) => m.display_name).join(", ")}` : ""}`}
                onPress={() => router.replace({ pathname: "/matches/prep/[teamId]", params: { teamId: String(team.id), map: team.map_list?.[0]?.map ?? "" } })} />
            ))}
          </ListGroup>
        )}
    </Screen>
  );
}
