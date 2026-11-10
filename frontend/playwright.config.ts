import { defineConfig } from "@playwright/test";
const py = process.platform === "win32" ? ".venv\\Scripts\\python" : ".venv/bin/python";
export default defineConfig({
  testDir: "e2e",
  workers: 1, fullyParallel: false, // une seule base partagée ; le test d'équipe (verrouillage) passe en dernier
  use: { baseURL: "http://localhost:5173" },
  webServer: [
    // base remise à zéro à chaque lancement (le test d'équipe crée un compte, qui verrouille l'API)
    { command: `${py} -c "import shutil; shutil.rmtree('../data-e2e', ignore_errors=True)" && ${py} scripts/seed_fixture.py && ${py} -m uvicorn app.main:get_app --factory --port 8000`, cwd: "../backend",
      url: "http://127.0.0.1:8000/api/health", reuseExistingServer: false, timeout: 180_000,  // semis de la base : ≈ 58 s sur le PC de l'équipe
      env: { SKYBOX_DATA_DIR: "../data-e2e", SKYBOX_CONFIG: "../data-e2e/config.toml" } },
    { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: false, timeout: 180_000 },
  ],
});
