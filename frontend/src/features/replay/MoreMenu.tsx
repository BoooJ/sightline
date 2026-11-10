import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../shared/ui/Icon";

/** « Plus » : outils d'analyse rangés dans un menu en mode joueur. */
export function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="pl-menu-wrap" ref={ref}>
      <button type="button" className={`btn btn-sm btn-ghost ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} data-testid="more-tools">
        <Icon name="menu" />Plus</button>
      {open && <div className="pl-menu panel rp-more" role="menu">{children}</div>}
    </div>
  );
}
