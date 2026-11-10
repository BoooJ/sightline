import { useState } from "react";
import { find3d, useMaps3d } from "./api";
import type { Map3d, Variant } from "./types";
import "./replay3d.css";

const KEY = "sightline.replay3d";
interface Saved { on: boolean; variant: Variant }

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    return { on: v.on === true, variant: v.variant === "textured" ? "textured" : "gray" };
  } catch {
    return { on: false, variant: "gray" };  // stockage refusé ou illisible
  }
}

/** Choix 2D / 3D et variante de carte, gardés dans ce navigateur ; la 3D n'existe que si la carte du match en a une. */
export function use3dView(mapName?: string) {
  const maps = useMaps3d();
  const available: Map3d | null = mapName ? find3d(maps.data ?? [], mapName) : null;
  const [saved, setSaved] = useState<Saved>(load);
  const [failed, setFailed] = useState<string | null>(null);
  // à partir de l'état du moment, jamais de celui d'un rendu passé : la vue 3D cachée (replay en 2D) peut encore changer
  // la variante (texturée en échec) avec une fonction prise quand la 3D était affichée, sans la réafficher. Écriture du
  // même choix à chaque appel de la mise à jour : sans effet de bord gênant
  const save = (change: (s: Saved) => Saved) => setSaved((s) => {
    const next = change(s);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* stockage refusé : le choix vaut pour la page */ }
    return next;
  });
  const variant: Variant = available?.variants[saved.variant] ? saved.variant : available?.variants.gray ? "gray" : "textured";
  return {
    available, variant, failed,
    on: !!available && saved.on && !failed,
    setOn: (on: boolean) => { setFailed(null); save((s) => ({ ...s, on })); },
    setVariant: (v: Variant) => save((s) => ({ ...s, variant: v })),
    fail: (reason: string) => setFailed(reason),
  };
}
export type View3d = ReturnType<typeof use3dView>;

export function Toggle3d({ view }: { view: View3d }) {
  const a = view.available;
  if (!a) return null;
  const date = a.exported_at ? new Date(a.exported_at).toLocaleDateString("fr-FR") : "?";
  return (
    <span className="r3-toggle" role="group" aria-label="Vue du replay" title={`Carte 3D : version du jeu ${a.build || "?"}, exportée le ${date}`}>
      <button type="button" className={`btn btn-sm btn-ghost ${!view.on ? "on" : ""}`} aria-pressed={!view.on}
        onClick={() => view.setOn(false)} data-testid="view-2d">2D</button>
      <button type="button" className={`btn btn-sm btn-ghost ${view.on ? "on" : ""}`} aria-pressed={view.on}
        onClick={() => view.setOn(true)} data-testid="view-3d">3D</button>
      {view.failed && <span className="r3-fail" role="status" data-testid="view3d-error">Vue 3D indisponible : {view.failed}</span>}
    </span>
  );
}
