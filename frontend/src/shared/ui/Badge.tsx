import type { ReactNode } from "react";
export function Badge({ tone, children }: { tone: "ct" | "t" | "neutral" | "ok" | "warn" | "error"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
