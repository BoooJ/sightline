import { Icon, type IconName } from "./Icon";
import type { ReactNode } from "react";
export function EmptyState({ title, children, icon = "search" }: { title: string; children?: ReactNode; icon?: IconName }) {
  return <div className="empty"><span className="empty-icon" aria-hidden="true"><Icon name={icon} size={22} /></span><h3>{title}</h3>{children != null && <p>{children}</p>}</div>;
}
