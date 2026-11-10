/** Plein écran du replay (radar, panneaux et contrôles), ou sortie si déjà en plein écran. */
export function toggleFullscreen(): void {
  if (document.fullscreenElement) { void document.exitFullscreen(); return; }
  const el = document.querySelector<HTMLElement>(".replay");
  void el?.requestFullscreen?.().catch(() => { /* refusé par le navigateur */ });
}
