import { Component, type ComponentType, type ErrorInfo, lazy, memo, type ReactNode, Suspense, useEffect, useState } from "react";
import { Spinner } from "../../shared/ui/Spinner";
import type { Scene3DProps } from "./Scene3D";

export const LOAD_FAILED = "la 3D n'a pas pu être chargée : rechargez la page";
export const RUN_FAILED = "la 3D s'est arrêtée sur une erreur : rechargez la page";

type Scene3DModule = { default: ComponentType<Scene3DProps> };

/** Module de la vue 3D ; s'il ne se charge pas (onglet ouvert avant un redéploiement : l'ancien fichier n'existe plus ;
 *  réseau coupé), un composant qui rend la main au radar 2D avec un message, au lieu de faire tomber toute la page. */
export function loadScene3d(load: () => Promise<Scene3DModule>): Promise<Scene3DModule> {
  return load().catch((e: unknown) => {
    console.error("Vue 3D : module non chargé", e);
    return { default: Unloaded };
  });
}

function Unloaded({ onFail }: Pick<Scene3DProps, "onFail">) {
  useEffect(() => onFail(LOAD_FAILED), []);  // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const Scene3D = lazy(() => loadScene3d(() => import("./Scene3D")));  // three.js chargé seulement à l'ouverture de la 3D

/** Erreur pendant l'affichage de la 3D (rendu, effet) : retour au radar 2D avec un message, pas de page d'erreur. */
export class Guard3d extends Component<{ onFail: (reason: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Vue 3D", error, info.componentStack);
    this.props.onFail(RUN_FAILED);
  }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Vue 3D cachée avant comme après : rien à rendre de nouveau, quels que soient l'instant et le reste (la page se rend à
 *  chaque image de la lecture). */
export const sameWhileHidden = (a: Scene3DProps, b: Scene3DProps): boolean => !a.active && !b.active;

/** Vue 3D du replay chargée à la demande, protégée de ses propres erreurs. Rien (ni three.js, ni carte) tant qu'elle n'a
 *  pas été affichée (`active`). Ensuite, quand le replay repasse en 2D, elle reste montée mais cachée : sa boucle de dessin
 *  est arrêtée (`Viewer.pause`) et elle ne se rend plus à chaque image de la lecture (`sameWhileHidden`) ; au retour en 3D,
 *  carte, textures sur le GPU, caméra et bras sont toujours là, elle reprend à l'instant courant. La page la démonte pour
 *  de bon en la quittant, en changeant de carte et après un échec (`onFail`). */
export const LazyScene3D = memo(function LazyScene3D(p: Scene3DProps) {
  const [opened, setOpened] = useState(p.active);
  if (p.active && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Guard3d onFail={p.onFail}>
      {/* module encore en chargement après un retour en 2D : pas de roue par-dessus le radar */}
      <Suspense fallback={p.active ? <div className="rp-loading"><Spinner /></div> : null}>
        <Scene3D {...p} />
      </Suspense>
    </Guard3d>
  );
}, sameWhileHidden);
