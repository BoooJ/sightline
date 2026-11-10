#!/usr/bin/env node
// Copie les types de l'API du site (frontend/src/shared/api/types.ts) dans l'app mobile.
// L'image Docker de l'app ne contient que mobile/ : on garde donc une copie, régénérée par `npm run sync-types`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../frontend/src/shared/api/types.ts");
const dst = path.resolve(here, "../src/api/types.ts");
const header = "// Copie de frontend/src/shared/api/types.ts (types de l'API Sightline) : ne pas modifier ici,\n"
  + "// lancer `npm run sync-types` après un changement côté site.\n"
  + "// TeamStats y est déclaré deux fois (stats de match, page équipe) : TypeScript fusionne les deux.\n"
  + "/* eslint-disable import/export */\n";
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, header + fs.readFileSync(src, "utf8"));
console.log(`types copiés → ${path.relative(process.cwd(), dst)}`);
