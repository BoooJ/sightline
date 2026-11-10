// src/shared/ui/Icon.tsx — icônes SVG originales, trait 1.6px, 24x24
const PATHS: Record<string, string> = {
  upload: "M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  play: "M8 5v14l11-7z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  prev: "M6 6v12M18 6l-9 6 9 6z",
  next: "M18 6v12M6 6l9 6-9 6z",
  skull: "M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4 3 5v3h8v-3c1.8-1 3-2.6 3-5a7 7 0 0 0-7-7zM9.5 11h.01M14.5 11h.01M10 18v2M14 18v2",
  bomb: "M10 8a7 7 0 1 0 6 3.5M14 6l2-2 2 2-2 2M16 4l1-1",
  defuse: "M4 20l7-7M14 4l6 6-3 3-6-6zM9 15l-2-2",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  layers: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  back: "M15 6l-6 6 6 6",
  library: "M4 5h6v14H4zM14 5h6v6h-6zM14 15h6v4h-6z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  playlist: "M4 6h12M4 12h12M4 18h8M17 15v6l5-3z",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  rounds: "M4 5h16M4 10h16M4 15h10M4 20h6",
  grenade: "M12 9a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM10 9V6h4v3M14 6l3-3M9 13h6",
  heat: "M12 3c3 4 6 6.5 6 11a6 6 0 0 1-12 0c0-2.5 1.2-4.2 3-6 0 2 1 3 2 3.5C11 9 11 6 12 3z",
  team: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  comment: "M4 5h16v11H9l-5 4z",
  share: "M15 5l5 5-5 5M20 10H10a6 6 0 0 0-6 6v2",
  scout: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-6-6M7 10h6M10 7v6",
  veto: "M4 5h16v14H4zM9 9l6 6M15 9l-6 6",
  voice: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  mute: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  dashboard: "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 8h6V4h-6z",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6L6 18",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  fit: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M9 9h6v6H9z",
  download: "M12 4v11m0 0-4-4m4 4 4-4M5 19h14",
  book: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10",
  print: "M7 9V4h10v5M7 17H5v-6h14v6h-2M7 14h10v6H7z",
  pin: "M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 13v4M8 20h8M10 17h4v3h-4z",
  live: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14",
  bookmark: "M6 3h12v18l-6-4.5L6 21z",
  plus: "M12 5v14M5 12h14",
  crosshair: "M12 3v4M12 17v4M3 12h4M17 12h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.9 3.7M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  pen: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4",
};
export type IconName = keyof typeof PATHS;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const filled = name === "play" || name === "pause";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
