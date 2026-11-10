/**
 * Worker du ragdoll : le moteur (ragdollEngine.ts) hors du fil principal (aucune physique sur le fil du rendu : PC de
 * l'équipe à puce graphique intégrée). Messages : RagdollIn → RagdollOut (une réponse pour chaque mort ; aucune pour
 * `def`, `unmap` et une `map` réussie) ; les tampons de la trajectoire sont transférés, pas copiés. Lancé par ragdolls.ts (`spawnRagdollWorker`), via `new Worker(new URL(...), { type: "module" })` (Vite).
 * Types du DOM seulement (pas de lib « webworker » : elle entrerait en conflit avec celle du DOM dans tsconfig).
 */
import { RagdollEngine, type RagdollIn, type RagdollOut } from "./ragdollEngine";

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<RagdollIn>) => void) | null;
  postMessage(m: RagdollOut, transfer: Transferable[]): void;
};
const engine = new RagdollEngine();
scope.onmessage = (e) => {
  const out = engine.handle(e.data);
  if (out) scope.postMessage(out, out.track ? [out.track.p.buffer, out.track.q.buffer] : []);
};
