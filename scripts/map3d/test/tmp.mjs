import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Dossier temporaire supprimé à la fin du test (t.after), même en cas d'échec : les tests ne laissent rien dans %TEMP%. */
export function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}
