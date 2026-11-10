/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Polices utilisées dès le premier rendu : annoncées dans la page d'entrée pour partir en même temps que le CSS
 *  (sinon le navigateur ne les découvre qu'après avoir lu la feuille de style : un aller-retour réseau de plus). */
const PRELOAD_FONTS = [/inter-latin-400-normal.*\.woff2$/, /inter-latin-600-normal.*\.woff2$/, /saira-latin-wdth-normal.*\.woff2$/];
function preloadFonts(): Plugin {
  return {
    name: "preload-fonts",
    enforce: "post",
    transformIndexHtml(_html, ctx) {
      const names = Object.keys(ctx.bundle ?? {}).filter((f) => PRELOAD_FONTS.some((re) => re.test(f)));
      return names.map((href) => ({ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: `/${href}` }, injectTo: "head" }));
    },
  };
}

// Ports choisis par start.ps1 : plusieurs copies du projet peuvent tourner en même temps.
const API = `http://127.0.0.1:${process.env.SIGHTLINE_API_PORT ?? 8000}`;

export default defineConfig({
  plugins: [react(), preloadFonts()],
  server: {
    port: Number(process.env.SIGHTLINE_WEB_PORT ?? 5173),
    strictPort: true, // pas de port de repli silencieux : le site parlerait à l'API d'une autre copie
    proxy: { "/api": API, "/maps": API },
  },
  build: {
    rollupOptions: {
      output: {
        // bibliothèques à part : elles changent rarement, le navigateur les garde d'un déploiement à l'autre
        manualChunks: { vendor: ["react", "react-dom", "react-router-dom", "@tanstack/react-query", "zustand", "@msgpack/msgpack"] },
      },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
