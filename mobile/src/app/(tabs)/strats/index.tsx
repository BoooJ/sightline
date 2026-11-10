import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useMaps, useNotes, useStrats } from "@/api/hooks";
import type { MapMeta, StratSummary } from "@/api/types";
import { AddNoteButton, openNote } from "@/components/NotesSection";
import { NoteRow } from "@/components/NoteRow";
import { t } from "@/i18n/fr";
import { mapLabel, STRAT_TYPE_LABEL } from "@/lib/labels";
import { filterNotes, groupNotesByMap } from "@/lib/notes";
import { filterStrats, groupByMap, mapsOf, type SideFilter } from "@/lib/strats";
import { SideTag } from "@/ui/Badges";
import { Button } from "@/ui/Button";
import { ChipRow } from "@/ui/Chip";
import { ListGroup, ListRow } from "@/ui/ListRow";
import { Screen } from "@/ui/Screen";
import { Section } from "@/ui/Section";
import { Segmented } from "@/ui/Segmented";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { space } from "@/ui/theme";

const ALL = "all";
type CarnetView = "strats" | "notes";

function summary(s: StratSummary): string {
  return [STRAT_TYPE_LABEL[s.type], s.counts.positions ? t.strats.players(s.counts.positions) : null,
    s.counts.grenades ? t.strats.grenades(s.counts.grenades) : null].filter(Boolean).join(" · ");
}

/** Le Carnet : les stratégies de l'équipe (lues, on les écrit sur le site) et mes notes, par carte et par côté.
 *  La vue et la carte passent par l'adresse (`?view=notes&map=`), pour y arriver depuis la préparation ou un bilan. */
export default function Carnet() {
  const params = useLocalSearchParams<{ view?: string; map?: string }>();
  const view: CarnetView = params.view === "notes" ? "notes" : "strats";
  const maps = useMaps().data ?? [];
  const [side, setSide] = useState<SideFilter>("all");
  // la carte vit dans l'adresse : un lien « Toutes tes notes sur Mirage » la change même si l'onglet est déjà ouvert
  const map = params.map || ALL;
  const setMap = (m: string) => router.setParams({ map: m === ALL ? "" : m });
  const name = (m: string) => mapLabel(m, maps.find((x) => x.name === m)?.display_name);
  const draft = { ...(map !== ALL ? { map } : {}), ...(side !== "all" ? { side } : {}) };

  return (
    <Screen title={t.strats.title} subtitle={t.strats.lead} right={view === "notes" ? <AddNoteButton draft={draft} /> : undefined}>
      <View style={styles.filters}>
        <Segmented<CarnetView> value={view} onChange={(v) => router.setParams({ view: v })}
          items={[{ value: "strats", label: t.strats.views.strats }, { value: "notes", label: t.strats.views.notes }]} />
      </View>
      {view === "notes"
        ? <NotesView maps={maps} map={map} side={side} setMap={setMap} setSide={setSide} name={name} />
        : <StratsView map={map} side={side} setMap={setMap} setSide={setSide} name={name} />}
    </Screen>
  );
}

interface Filters {
  map: string; side: SideFilter; setMap: (m: string) => void; setSide: (s: SideFilter) => void; name: (m: string) => string;
}

function FilterBar({ mapItems, map, side, setMap, setSide, name }: Filters & { mapItems: string[] }) {
  return (
    <View style={styles.filters}>
      <ChipRow<string> value={map} onChange={setMap}
        items={[{ value: ALL, label: t.strats.allMaps }, ...mapItems.map((m) => ({ value: m, label: name(m) }))]} />
      <Segmented<SideFilter> value={side} onChange={setSide}
        items={[{ value: "all", label: t.strats.allSides }, { value: "T", label: "T" }, { value: "CT", label: "CT" }]} />
    </View>
  );
}

function StratsView(f: Filters) {
  const strats = useStrats();
  const list = strats.data ?? [];
  const shown = filterStrats(list, f.map === ALL ? null : f.map, f.side);
  if (strats.isPending) return <Loading />;
  if (strats.isError) return <ErrorState error={strats.error} onRetry={() => void strats.refetch()} />;
  if (list.length === 0) return <EmptyState text={t.strats.empty} />;
  return (
    <>
      <FilterBar {...f} mapItems={mapsOf(list)} />
      {shown.length === 0 ? (
        <EmptyState text={t.strats.emptyFilter(f.side === "all" ? null : f.side, f.map === ALL ? null : f.name(f.map))} />
      ) : groupByMap(shown).map((g) => (
        <Section key={g.map} label={f.name(g.map)}>
          <ListGroup>
            {g.items.map((s) => (
              <ListRow key={s.id} leading={<SideTag side={s.side} />} title={s.name} subtitle={summary(s)}
                onPress={() => router.push({ pathname: "/strats/[id]", params: { id: String(s.id) } })} />
            ))}
          </ListGroup>
        </Section>
      ))}
    </>
  );
}

function NotesView({ maps, ...f }: Filters & { maps: MapMeta[] }) {
  const notes = useNotes({});
  const list = notes.data ?? [];
  const now = new Date();
  // les cartes du pool, même sans note, pour pouvoir écrire sur une carte qui n'a encore rien ; puis celles des notes
  const pool = maps.filter((m) => m.active_duty).sort((a, b) => a.display_name.localeCompare(b.display_name)).map((m) => m.name);
  const mapItems = [...pool, ...[...new Set(list.map((n) => n.map))].filter((m) => !pool.includes(m))];
  const shown = filterNotes(list, f.map === ALL ? null : f.map, f.side);
  const mapName = f.map === ALL ? null : f.name(f.map);
  const draft = { ...(f.map !== ALL ? { map: f.map } : {}), ...(f.side !== "all" ? { side: f.side } : {}) };
  const open = (id: number) => openNote({ id });
  return (
    <>
      <FilterBar {...f} mapItems={mapItems} />
      {notes.isPending ? <Loading />
        : notes.isError ? <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
          : shown.length === 0 ? (
            <View style={styles.empty}>
              <EmptyState text={f.side !== "all" && list.length ? t.notes.emptySide(f.side, mapName) : t.notes.empty(mapName)} />
              <Button label={t.notes.addLabel} icon="plus" onPress={() => openNote(draft)} />
            </View>
          ) : f.map !== ALL ? (
            <View style={styles.list}>{shown.map((n) => <NoteRow key={n.id} note={n} now={now} onPress={() => open(n.id)} />)}</View>
          ) : groupNotesByMap(shown).map((g) => (
            <Section key={g.map} label={f.name(g.map)}>
              {g.items.map((n) => <NoteRow key={n.id} note={n} now={now} onPress={() => open(n.id)} />)}
            </Section>
          ))}
    </>
  );
}

const styles = StyleSheet.create({
  filters: { gap: space.md, marginTop: space.md },
  empty: { gap: space.md, marginTop: space.lg },
  list: { gap: space.sm, marginTop: space.lg },
});
