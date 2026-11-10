import { useSearchParams } from "react-router-dom";

export type UrlPatch = Record<string, string | undefined | null>;

/** Paramètres d'URL servant de filtres. `set` applique plusieurs clés en une seule navigation : enchaîner deux
 *  setSearchParams dans le même événement fait perdre le premier (chaque appel repart de l'URL du rendu courant). */
export function useUrlParams() {
  const [params, setParams] = useSearchParams();
  const set = (patch: UrlPatch | string, value?: string | null) => {
    const p: UrlPatch = typeof patch === "string" ? { [patch]: value } : patch;
    setParams((cur) => {
      const n = new URLSearchParams(cur);
      for (const [k, v] of Object.entries(p)) { if (v) n.set(k, v); else n.delete(k); }
      return n;
    }, { replace: true });
  };
  return [params, set] as const;
}
