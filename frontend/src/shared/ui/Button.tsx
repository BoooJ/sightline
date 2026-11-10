import type { ButtonHTMLAttributes } from "react";
type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger"; size?: "sm" | "md" };
export function Button({ variant, size = "md", className = "", ...rest }: Props) {
  const cls = ["btn", variant ? `btn-${variant}` : "", size === "sm" ? "btn-sm" : "", className].join(" ");
  return <button type="button" className={cls} {...rest} />;
}
