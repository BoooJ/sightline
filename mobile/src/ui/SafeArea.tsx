import type { ReactNode } from "react";

/** iOS et Android : expo-router fournit déjà les vraies marges de sécurité (voir SafeArea.web). */
export function SafeAreaInsets({ children }: { children: ReactNode }) {
  return children;
}
