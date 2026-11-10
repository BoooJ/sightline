import { router, type Href } from "expo-router";
import { StyleSheet } from "react-native";

import { useNotes } from "@/api/hooks";
import type { NoteFilter } from "@/api/types";
import { t } from "@/i18n/fr";
import { Button } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { PressableScale } from "@/ui/PressableScale";
import { Section } from "@/ui/Section";
import { EmptyState, ErrorState, Skeleton } from "@/ui/States";
import { Txt } from "@/ui/Txt";
import { color, radius } from "@/ui/theme";

import { NoteRow } from "./NoteRow";

/** Valeurs d'une nouvelle note, passées à l'éditeur par l'écran d'où l'on écrit. */
export type NoteParams = Partial<Record<"map" | "side" | "match" | "team" | "strat", string>>;

/** Ouvre l'éditeur : une note existante (id) ou une nouvelle, déjà rangée sous la carte, le match, l'adversaire… */
export function openNote(p: { id: number } | NoteParams) {
  router.push({ pathname: "/note", params: "id" in p ? { id: String(p.id) } : p } as unknown as Href);
}

/** « + Note » d'un en-tête de section ou d'écran. */
export function AddNoteButton({ draft }: { draft: NoteParams }) {
  return (
    <PressableScale onPress={() => openNote(draft)} haptic="light" hitSlop={8} accessibilityRole="button"
      accessibilityLabel={t.notes.addLabel} style={styles.add}>
      <Icon name="plus" size={18} color={color.accent} strokeWidth={2} />
      <Txt v="subhead" color={color.accent}>{t.notes.add}</Txt>
    </PressableScale>
  );
}

/** Les notes d'un contexte (une préparation, un match, une stratégie), avec « + Note » et un lien vers le Carnet. */
export function NotesSection({ label, filter, draft, empty, seeAll }: {
  label: string; filter: NoteFilter; draft: NoteParams; empty: string;
  /** lien « Toutes tes notes sur Mirage » vers le Carnet */
  seeAll?: { map: string; label: string };
}) {
  const notes = useNotes(filter);
  const now = new Date();
  const list = notes.data ?? [];
  return (
    <Section label={label} right={<AddNoteButton draft={draft} />}>
      {notes.isPending ? <Skeleton height={72} />
        : notes.isError ? <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
          : list.length === 0 ? <EmptyState text={empty} />
            : list.map((n) => <NoteRow key={n.id} note={n} now={now} onPress={() => openNote({ id: n.id })} />)}
      {seeAll ? (
        <Button kind="plain" label={seeAll.label}
          onPress={() => router.push({ pathname: "/strats", params: { view: "notes", map: seeAll.map } } as unknown as Href)} />
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  add: {
    flexDirection: "row", alignItems: "center", gap: 4, height: 32, paddingHorizontal: 10, borderRadius: radius.pill,
    backgroundColor: color.accentDim,
  },
});
