import { useEffect, useRef, useState, type ReactNode } from "react";

/** Bouton qui ouvre un petit panneau flottant (menu, réglages d'affichage) ; se ferme au clic dehors et avec Échap. */
export function Popover({ label, button, children, align = "right", className = "", testId, panelTestId }: {
  label: string; button: ReactNode; align?: "left" | "right"; className?: string; testId?: string; panelTestId?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className={`pop-wrap ${className}`} ref={ref}>
      <button type="button" className={`btn btn-sm btn-ghost ${open ? "on" : ""}`} aria-expanded={open} aria-label={label} title={label}
        onClick={() => setOpen(!open)} data-testid={testId}>{button}</button>
      {open && <div className={`pop panel pop-${align}`} role="dialog" aria-label={label} data-testid={panelTestId}>
        {typeof children === "function" ? children(close) : children}</div>}
    </div>
  );
}
