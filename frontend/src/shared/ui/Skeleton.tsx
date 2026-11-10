/** Squelette de chargement : des lignes grisées qui scintillent, à la place d'une roue d'attente, pour que la page
 *  garde sa forme pendant que les données arrivent. */
export function Skeleton({ rows = 8, header = false, className = "" }: { rows?: number; header?: boolean; className?: string }) {
  const widths = [92, 78, 85, 70, 88, 76, 83, 69, 90, 74, 80, 86];
  return (
    <div className={`skel ${className}`} role="status" aria-live="polite" aria-label="Chargement…" data-testid="skeleton">
      {header && <div className="skel-head"><i style={{ width: "34%" }} /><i style={{ width: "18%" }} /></div>}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row"><i className="skel-dot" /><i style={{ width: `${widths[i % widths.length]}%` }} /></div>
      ))}
    </div>
  );
}
