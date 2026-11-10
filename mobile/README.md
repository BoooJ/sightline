# Sightline mobile

App mobile qui accompagne Sightline pour un joueur : préparer le prochain adversaire, lire son bilan après le match,
garder les grenades d'une carte sous les yeux à côté du clavier, suivre sa progression.
Conception : `docs/superpowers/specs/2026-10-19-app-mobile-design.md`.

```bash
npm install
npx expo start          # Expo Go sur l'iPhone (QR code)
npm run web             # version web en local (http://localhost:8081/app)
npm test                # logique pure (vitest)
npm run typecheck && npm run lint
npm run export:web      # version web servie par le backend sous /app/
npm run sync-types      # recopie les types de l'API depuis frontend/
```

Serveur : `https://sightline.example.com` par défaut (`EXPO_PUBLIC_API_URL` pour un backend local).
« Essayer la démo » fonctionne sans compte, avec des matchs pro publics embarqués (`src/demo/`).

## APK Android

Compilé gratuitement par EAS (profil `preview` de `eas.json`), avec un compte Expo :

```bash
npx eas-cli@latest login                                   # une fois
npx eas-cli@latest build -p android --profile preview      # la 1re fois, accepte la création du projet EAS
```

Le lien de téléchargement de l'APK s'affiche à la fin de la compilation (et sur expo.dev).
