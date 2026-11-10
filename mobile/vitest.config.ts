import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests de la logique pure (src/lib, src/api) : sans React Native, donc dans Node.
// tsconfigRaw : esbuild ne sait pas lire le « extends » du tsconfig d'Expo (chemin de paquet).
export default defineConfig({
  esbuild: { tsconfigRaw: { compilerOptions: { target: "es2022", useDefineForClassFields: true } } },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
