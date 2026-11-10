import { type ReactNode, useSyncExternalStore } from "react";
import { type EdgeInsets, SafeAreaInsetsContext } from "react-native-safe-area-context";

const ZERO: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let current = ZERO;

/** Relit env(safe-area-inset-*) sur l'élément témoin ; vrai si les marges ont changé. */
function measure(probe: HTMLElement): boolean {
  const s = getComputedStyle(probe);
  const next = { top: parseFloat(s.paddingTop) || 0, right: parseFloat(s.paddingRight) || 0,
    bottom: parseFloat(s.paddingBottom) || 0, left: parseFloat(s.paddingLeft) || 0 };
  if (next.top === current.top && next.right === current.right && next.bottom === current.bottom && next.left === current.left) {
    return false;
  }
  current = next;
  return true;
}

function subscribe(onChange: () => void) {
  const probe = document.createElement("div");
  // la transition du padding signale un changement de env() (barre d'état, rotation) que resize ne voit pas toujours
  probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;"
    + "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);"
    + "transition:padding 0.05s";
  document.body.appendChild(probe);
  const update = () => { if (measure(probe)) onChange(); };
  update();
  probe.addEventListener("transitionend", update);
  addEventListener("resize", update);
  return () => {
    probe.removeEventListener("transitionend", update);
    removeEventListener("resize", update);
    probe.remove();
  };
}

/** Sur le web, expo-router ne fournit que des marges nulles : l'app installée sur l'écran d'accueil d'un iPhone passait
 *  sous l'heure et la barre d'accueil. Ici, les vraies marges de l'écran, lues dans le CSS. */
export function SafeAreaInsets({ children }: { children: ReactNode }) {
  const insets = useSyncExternalStore(subscribe, () => current, () => ZERO);
  return <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>;
}
