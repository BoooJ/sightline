import { Fragment, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";

export type Codewords = { re: RegExp; defs: Map<string, string> } | null;

/** Lexique de l'équipe (annonces du mémo) prêt à repérer dans un texte : « Limace », « Doublette », « LDLC »… */
export function useCodewords(): Codewords {
  const q = useQuery({ queryKey: ["memo"], queryFn: api.memo, staleTime: 60_000 });
  return useMemo(() => {
    const words = (q.data ?? []).filter((e) => e.kind === "codeword" && e.title.trim().length > 1);
    if (!words.length) return null;
    const defs = new Map(words.map((w) => [w.title.trim().toLowerCase(), w.body]));
    const alt = [...defs.keys()].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // sans lookbehind (Safari < 16.4) : le caractère qui précède est capturé à part, l'annonce est le 2e groupe
    return { re: new RegExp(`(^|[^\\p{L}\\d])(${alt.join("|")})(?![\\p{L}\\d])`, "giu"), defs };
  }, [q.data]);
}

/** Texte d'une stratégie : les annonces du lexique sont soulignées, leur définition au survol. */
export function Rich({ text, words }: { text: string; words: Codewords }) {
  if (!words) return <>{text}</>;
  // split avec deux groupes : [texte, frontière, annonce, texte, frontière, annonce, …]
  const parts = text.split(words.re);
  return (
    <>
      {parts.map((p, i) => (i % 3 === 2
        ? <abbr key={i} className="sb-cw" title={words.defs.get(p.toLowerCase())}>{p}</abbr>
        : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}
