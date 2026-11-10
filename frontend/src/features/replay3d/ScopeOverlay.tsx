import type { CSSProperties } from "react";
import type { ScopeKind } from "./cameras";

/** Dessin de la lunette, reproduit d'après des valeurs relevées à l'écran. Les longueurs sont des fractions de vmin
 *  (vmin = min(largeur, hauteur) de la fenêtre), le centre est celui de la vue 3D. Le cache du jeu est procédural
 *  (shader `legacy_sniper_scope`, sans paramètres lisibles) : seul l'aspect observé est repris. */
export const SCOPE_R = 0.34;                                  // rayon du disque transparent
const LENS_FROM = 0.30, LENS_FULL = 0.325;                   // flou : début, plein à partir de (plein jusqu'à SCOPE_R, où il s'arrête)
const BLUR_PX = 2.5;                                          // flou d'arrière-plan de la lentille
const OUTSIDE_ALPHA = 0.984, EDGE_PX = 1;                     // noir extérieur ; adoucissement de son bord
const RING_PX = 2, RING_ALPHA = 0.95, RING_LINER = "rgb(255 255 255 / 0.1)";  // anneau : bordure, liseré intérieur d'un pixel
const LINE_PX = 1, LINE_ALPHA = 0.9;                          // lignes qui se croisent au centre

const black = (alpha: number) => `rgb(0 0 0 / ${alpha})`;
/** `k` fois vmin, plus `px` pixels. `--r3-vmin` vaut 1 vmin entier ; il est posé sur `.r3-scope-lens` (voir plus bas). */
const vmin = (k: number, px = 0) => `calc(var(--r3-vmin) * ${k}${px ? ` + ${px}px` : ""})`;
const disc = (...stops: string[]) => `radial-gradient(circle at 50% 50%, ${stops.join(", ")})`;

/** Masque du flou : visible seulement dans la couronne intérieure (monte de LENS_FROM à LENS_FULL, plein jusqu'à SCOPE_R,
 *  puis coupé net). Il ne descend pas plus loin : le flou du noir extérieur faisait un halo clair de 4 à 6 px autour de
 *  l'anneau, alors que le relevé est noir pur jusqu'à lui. */
const BLUR_MASK = disc(`transparent ${vmin(LENS_FROM)}`, `#000 ${vmin(LENS_FULL)}`, `#000 ${vmin(SCOPE_R)}`,
  `transparent ${vmin(SCOPE_R)}`);

/** Lunette par-dessus la vue (DOM et CSS, aucune image du jeu), la même pour les snipers et pour l'AUG et le SG 553 :
 *  disque transparent entouré de noir, anneau, deux lignes d'un pixel qui se croisent au centre et s'arrêtent au bord
 *  du disque, léger flou de la lentille sur son pourtour. Ne prend aucun clic.
 *
 *  L'unité est celle de la fenêtre mais bornée à ce que la vue peut montrer : quand la vue est plus
 *  petite que le disque, le disque garde la plus petite dimension de la vue au lieu de déborder (`cqmin` se lit sur
 *  `.r3-scope`, qui est le conteneur). `kind` ne sert qu'à `data-kind` : le dessin ne change pas. */
export function ScopeOverlay({ kind }: { kind: ScopeKind }) {
  const diameter = vmin(2 * SCOPE_R);
  return (
    <div className="r3-scope" data-testid="scope" data-kind={kind} aria-hidden="true"
      style={{ pointerEvents: "none", containerType: "size" }}>
      <div className="r3-scope-lens" style={{
        "--r3-vmin": `min(100vmin, 100cqmin / ${2 * SCOPE_R})`,
        background: disc(`transparent ${vmin(SCOPE_R)}`, `${black(OUTSIDE_ALPHA)} ${vmin(SCOPE_R, EDGE_PX)}`),
      } as CSSProperties}>
        {/* le flou couvre le carré du disque, pas toute la vue (moins de pixels à flouter à chaque image) ni plus que le disque
            (il ne déborde pas sur le noir) */}
        <div className="r3-scope-blur" style={{
          width: diameter, height: diameter, backdropFilter: `blur(${BLUR_PX}px)`,
          WebkitBackdropFilter: `blur(${BLUR_PX}px)`, maskImage: BLUR_MASK, WebkitMaskImage: BLUR_MASK,
        }} />
        <div className="r3-scope-ring" style={{
          width: diameter, height: diameter, borderRadius: "50%", border: `${RING_PX}px solid ${black(RING_ALPHA)}`,
          boxShadow: `inset 0 0 0 1px ${RING_LINER}`,
        }} />
        <div className="r3-scope-line h" style={{ width: diameter, height: `${LINE_PX}px`, background: black(LINE_ALPHA) }} />
        <div className="r3-scope-line v" style={{ width: `${LINE_PX}px`, height: diameter, background: black(LINE_ALPHA) }} />
      </div>
    </div>
  );
}
