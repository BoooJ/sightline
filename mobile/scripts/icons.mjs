#!/usr/bin/env node
// Génère toutes les icônes de l'app depuis un seul dessin vectoriel (la marque de src/components/Logo.tsx) :
//   node scripts/icons.mjs
// iOS / Android (assets/images), favicon, et icônes de la version web installable (public/icons).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BG = "#0c0f12", MINT = "#2ee6a6", INK = "#eef2f5";

/** La marque : une ligne de visée qui traverse un repère. `scale` réduit la marque pour les zones de sécurité. */
function svg({ size, background = true, scale = 1, mono = false }) {
  const s = (v) => 512 + (v - 512) * scale;
  const w = (v) => v * scale;
  const ring = mono ? "#fff" : MINT, line = mono ? "#fff" : INK;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
    ${background ? `<rect width="1024" height="1024" fill="${BG}"/>` : ""}
    <circle cx="512" cy="512" r="${w(236)}" fill="none" stroke="${ring}" stroke-width="${w(52)}"/>
    <line x1="${s(150)}" y1="${s(608)}" x2="${s(874)}" y2="${s(416)}" stroke="${line}" stroke-width="${w(52)}" stroke-linecap="round"/>
    <circle cx="512" cy="512" r="${w(58)}" fill="${ring}"/>
  </svg>`;
}

const out = [
  ["assets/images/icon.png", { size: 1024 }],
  ["assets/images/splash-icon.png", { size: 512, background: false }],
  ["assets/images/favicon.png", { size: 64 }],
  ["assets/images/android-icon-foreground.png", { size: 1024, background: false, scale: 0.62 }],
  ["assets/images/android-icon-monochrome.png", { size: 1024, background: false, scale: 0.62, mono: true }],
  ["public/icons/icon-192.png", { size: 192 }],
  ["public/icons/icon-512.png", { size: 512 }],
  ["public/icons/maskable-512.png", { size: 512, scale: 0.72 }],
  ["public/icons/apple-touch-icon.png", { size: 180 }],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, o] of out) {
  await page.setViewportSize({ width: o.size, height: o.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(o)}</body></html>`);
  const dst = path.join(root, file);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await page.locator("svg").screenshot({ path: dst, omitBackground: o.background === false });
  console.log(`${file} (${o.size} px)`);
}
fs.writeFileSync(path.join(root, "assets/icon.svg"), svg({ size: 1024 }));
await browser.close();
