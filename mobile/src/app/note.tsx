import { router, useLocalSearchParams, type Href } from "expo-router";
import { useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError } from "@/api/api";
import { useMaps, useMatch, useNote, useNoteActions, useScoutTeams, useStrat } from "@/api/hooks";
import type { NoteInput, NoteT } from "@/api/types";
import { t } from "@/i18n/fr";
import { shortDate } from "@/lib/format";
import { mapLabel } from "@/lib/labels";
import { draftFromParams, NOTE_MAX, NOTE_WARN, noteMeta, type NoteDraft } from "@/lib/notes";
import { Button } from "@/ui/Button";
import { ChipRow } from "@/ui/Chip";
import { Icon } from "@/ui/Icon";
import { PressableScale, tap } from "@/ui/PressableScale";
import { Segmented } from "@/ui/Segmented";
import { EmptyState, ErrorState, Loading } from "@/ui/States";
import { TextArea } from "@/ui/TextArea";
import { Toggle } from "@/ui/Toggle";
import { Txt } from "@/ui/Txt";
import { color, radius, space, TOUCH } from "@/ui/theme";

type SideChoice = "T" | "CT" | "both";
type Links = Pick<NoteDraft, "match_id" | "team_id" | "strat_id">;

/** Retour à l'écran d'où l'on vient ; ouverte directement (lien, rechargement), la note renvoie au Carnet. */
function close() {
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: "/strats", params: { view: "notes" } } as unknown as Href);
}

/** Écrire ou relire une note. Plein écran plutôt qu'une feuille du bas : dans la PWA iOS, le clavier la recouvrirait,
 *  alors qu'ici « Annuler » et « Enregistrer » restent en haut, au-dessus du clavier. */
export default function NoteScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const id = Number(params.id) || 0;
  const q = useNote(id);
  if (!id) return <Editor note={null} draft={draftFromParams(params)} />;
  if (q.data) return q.data.mine ? <Editor key={q.data.id} note={q.data} draft={draftFromParams({})} /> : <ReadOnly note={q.data} />;
  const gone = q.error instanceof ApiError && q.error.status === 404;
  return (
    <Shell title={t.notes.title} left={<BarAction label={t.notes.close} onPress={close} />}>
      {q.isPending ? <Loading blocks={2} /> : gone ? <EmptyState text={t.notes.gone} />
        : <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
    </Shell>
  );
}

function Editor({ note, draft }: { note: NoteT | null; draft: NoteDraft }) {
  const { create, update, remove } = useNoteActions();
  const maps = useMaps().data ?? [];
  const init = {
    body: note?.body ?? "", map: note?.map ?? draft.map, side: ((note ? note.side : draft.side) ?? "both") as SideChoice,
    shared: note?.shared ?? false,
    links: {
      match_id: note ? note.match?.id ?? null : draft.match_id,
      team_id: note ? note.team?.id ?? null : draft.team_id,
      strat_id: note ? note.strat?.id ?? null : draft.strat_id,
    } as Links,
  };
  const [body, setBody] = useState(init.body);
  const [map, setMap] = useState(init.map);
  const [side, setSide] = useState<SideChoice>(init.side);
  const [shared, setShared] = useState(init.shared);
  const [links, setLinks] = useState<Links>(init.links);
  const [confirm, setConfirm] = useState<null | "delete" | "discard">(null);
  const [error, setError] = useState<string | null>(null);
  const labels = useLinkLabels(note, links);

  const text = body.trim();
  const dirty = text !== init.body.trim() || map !== init.map || side !== init.side || shared !== init.shared
    || links.match_id !== init.links.match_id || links.team_id !== init.links.team_id || links.strat_id !== init.links.strat_id;
  const busy = create.isPending || update.isPending || remove.isPending;
  const canSave = !!text && !!map && (!note || dirty) && !busy;
  const choices = maps.filter((m) => m.active_duty || m.name === map)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  async function save() {
    setError(null);
    const p: NoteInput = { map, body: text, side: side === "both" ? null : side, shared, ...links };
    try {
      if (note) await update.mutateAsync({ id: note.id, p });
      else await create.mutateAsync(p);
      tap("success");
      close();
    } catch (e) {
      // refus du serveur (texte trop long, carte inconnue…) : son message ; panne ou réseau : texte gardé, on réessaie
      setError(e instanceof ApiError && e.status < 500 ? e.message : t.notes.saveError);
    }
  }
  async function destroy() {
    if (!note) return;
    setError(null);
    try {
      await remove.mutateAsync(note.id);
      close();
    } catch (e) {
      setConfirm(null);
      setError(e instanceof ApiError && e.status < 500 ? e.message : t.notes.saveError);
    }
  }

  return (
    <Shell
      title={note ? t.notes.title : t.notes.newTitle}
      left={<BarAction label={t.notes.cancel} onPress={() => (dirty && text ? setConfirm("discard") : close())} />}
      right={<BarAction label={t.notes.save} onPress={() => void save()} disabled={!canSave} busy={busy} strong />}
    >
      {confirm === "discard" ? (
        <Confirm text={t.notes.discard} yes={t.notes.discardYes} no={t.notes.discardNo} onYes={close} onNo={() => setConfirm(null)} />
      ) : null}
      <TextArea value={body} onChangeText={setBody} placeholder={t.notes.placeholder} autoFocus={!note} maxLength={NOTE_MAX}
        accessibilityLabel={t.notes.title} />
      {body.length >= NOTE_WARN ? (
        <Txt v="dataSmall" color={color.warn} style={styles.counter}>{t.notes.counter(body.length, NOTE_MAX)}</Txt>
      ) : null}
      {error ? <Txt v="subhead" color={color.bad} accessibilityRole="alert">{error}</Txt> : null}

      <Field label={t.notes.map}>
        <ChipRow<string> value={map} onChange={setMap}
          items={choices.map((m) => ({ value: m.name, label: mapLabel(m.name, m.display_name) }))} />
        {!map ? <Txt v="caption">{t.notes.pickMap}</Txt> : null}
      </Field>
      <Field label={t.notes.side}>
        <Segmented<SideChoice> value={side} onChange={setSide}
          items={[{ value: "T", label: "T" }, { value: "CT", label: "CT" }, { value: "both", label: t.notes.bothSides }]} />
      </Field>
      {labels.length ? (
        <Field label={t.notes.links}>
          <View style={styles.links}>
            {labels.map((l) => (
              <PressableScale key={l.key} onPress={() => setLinks((x) => ({ ...x, [l.key]: null }))} haptic="select" hitSlop={4}
                accessibilityRole="button" accessibilityLabel={t.notes.removeLink(l.label)} style={styles.link}>
                <Txt v="subhead" color={color.text}>{l.label}</Txt>
                <Icon name="close" size={14} color={color.text3} strokeWidth={2} />
              </PressableScale>
            ))}
          </View>
        </Field>
      ) : null}
      <Toggle label={t.notes.share} hint={t.notes.shareHint} value={shared} onChange={setShared} />

      {note ? (
        confirm === "delete"
          ? <Confirm text={t.notes.deleteConfirm} yes={t.notes.deleteYes} no={t.notes.keep} onYes={() => void destroy()} onNo={() => setConfirm(null)} danger />
          : <Button kind="plain" icon="trash" label={t.notes.delete} onPress={() => setConfirm("delete")} />
      ) : null}
    </Shell>
  );
}

/** Libellés des rattachements : ceux de la note, sinon lus dans les données déjà chargées par l'écran d'origine. */
function useLinkLabels(note: NoteT | null, links: Links): { key: keyof Links; label: string }[] {
  const now = new Date();
  const teams = useScoutTeams().data ?? [];
  const match = useMatch(note?.match ? 0 : links.match_id ?? 0).data;
  const strat = useStrat(note?.strat ? 0 : links.strat_id ?? 0).data;
  const matchDate = note?.match?.date ?? match?.date ?? null;
  const out: { key: keyof Links; label: string }[] = [];
  if (links.team_id !== null) {
    out.push({ key: "team_id", label: t.notes.vs(note?.team?.name ?? teams.find((x) => x.id === links.team_id)?.name ?? "…") });
  }
  if (links.match_id !== null) {
    out.push({ key: "match_id", label: matchDate ? t.notes.match(shortDate(matchDate, now)) : t.notes.matchPlain });
  }
  if (links.strat_id !== null) out.push({ key: "strat_id", label: t.notes.strat(note?.strat?.name ?? strat?.name ?? "…") });
  return out;
}

function ReadOnly({ note }: { note: NoteT }) {
  return (
    <Shell title={t.notes.title} left={<BarAction label={t.notes.close} onPress={close} />}>
      <Txt v="body" selectable>{note.body}</Txt>
      <Txt v="caption">{noteMeta(note, new Date())}</Txt>
      <Txt v="callout" style={styles.readOnly}>{t.notes.readOnly(note.author)}</Txt>
    </Shell>
  );
}

function Shell({ title, left, right, children }: { title: string; left: ReactNode; right?: ReactNode; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <View style={styles.barSide}>{left}</View>
        <Txt v="headline" numberOfLines={1} accessibilityRole="header" style={styles.barTitle}>{title}</Txt>
        <View style={[styles.barSide, styles.barRight]}>{right}</View>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}>
        {children}
      </ScrollView>
    </View>
  );
}

function BarAction({ label, onPress, disabled, busy, strong }: {
  label: string; onPress: () => void; disabled?: boolean; busy?: boolean; strong?: boolean;
}) {
  return (
    <PressableScale onPress={onPress} disabled={disabled || busy} hitSlop={6} accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }} style={[styles.action, (disabled || busy) && styles.off]}>
      <Txt v={strong ? "headline" : "body"} color={strong ? color.accent : color.text2}>{label}</Txt>
    </PressableScale>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Txt v="label">{label}</Txt>
      {children}
    </View>
  );
}

/** Confirmation dans l'écran même : Alert ne fait rien sur le web. */
function Confirm({ text, yes, no, onYes, onNo, danger }: {
  text: string; yes: string; no: string; onYes: () => void; onNo: () => void; danger?: boolean;
}) {
  return (
    <View style={styles.confirm} accessibilityRole="alert">
      <Txt v="body">{text}</Txt>
      <View style={styles.confirmRow}>
        <View style={styles.flex}><Button kind="secondary" label={no} onPress={onNo} /></View>
        <View style={styles.flex}><Button kind={danger ? "danger" : "primary"} label={yes} onPress={onYes} /></View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  bar: {
    height: TOUCH + 8, flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line,
  },
  barSide: { flex: 1, flexDirection: "row" },
  barRight: { justifyContent: "flex-end" },
  barTitle: { flexShrink: 1, textAlign: "center" },
  action: { minHeight: TOUCH, minWidth: TOUCH, justifyContent: "center", paddingHorizontal: space.sm },
  off: { opacity: 0.4 },
  content: { padding: space.lg, gap: space.lg },
  counter: { alignSelf: "flex-end", marginTop: -space.sm },
  field: { gap: space.sm },
  links: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  link: {
    flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 12, borderRadius: radius.pill,
    backgroundColor: color.surface3, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  readOnly: { marginTop: space.sm },
  confirm: {
    gap: space.md, padding: space.md, borderRadius: radius.card, backgroundColor: color.surface2,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  confirmRow: { flexDirection: "row", gap: space.sm },
  flex: { flex: 1 },
});
