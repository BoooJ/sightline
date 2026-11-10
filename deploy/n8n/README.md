# n8n pour Sightline

n8n tourne sur le VPS (`~/apps/n8n`, https://n8n.example.com). Il fait tourner trois workflows (spec `docs/superpowers/specs/2026-10-22-n8n-webhooks-design.md`) :

| Workflow | Rôle |
|---|---|
| **W1 · PRACC → Sightline** | appelé toutes les 30 min par l'extension Chrome « Sightline · PRACC » (`extension/`), importe les nouveaux pracs, 3 au plus par tour. Pas d'arriéré : seuls les pracs créés après la mise en service (23/10/2026, 02:45 UTC) sont importés. Étape « calendar » : l'extension relaie aussi le calendrier PRACC (matchs ESEA, pracs réservés), que Sightline garde à jour Rien entre 05:00 et 07:30 UTC (le backup OVH gèle le disque vers 06:00) |
| **W5 · Prép d'avant-match → Discord** | toutes les 15 min, demande à Sightline les matchs, pracs et tournois qui commencent dans les 24 h (chacun rendu une seule fois) et poste la prép : heure (affichée par Discord dans le fuseau de chacun), compétition, notre historique contre l'adversaire, ses cartes dans nos démos et, pour un match FACEIT, les cartes probables (calculées par W6) |
| **W1 · étapes FACEIT** | l'extension (0.4.0, toutes les 5 min) demande `faceit-wanted` (démos FACEIT en file : `/demos` sur Discord ou d'office), relève les liens sur la page du match et les renvoie en `faceit-links` ; pas connectée à FACEIT : une alerte Discord par jour au plus |
| **W6 · FACEIT → calendrier** | toutes les 15 min (à :07, :22…), Sightline lit sur FACEIT nos matchs de championnat à venir (ESEA) : nouveau match ajouté, horaire déplacé suivi (avec un message sur Discord), match annulé retiré ; la copie PRACC du même match est écartée ; cartes probables de chaque match des 14 prochains jours (leurs cartes ESEA × les nôtres), recalculées toutes les 6 h. Notre équipe FACEIT est retrouvée par les comptes du site liés à leur Steam ID ; la clé FACEIT est celle du scouting |
| **W2 · Sightline → Discord** | reçoit les webhooks signés de Sightline et poste dans `#sightline`. Le « match analysé » est résumé par un agent Claude, qui lit le débrief et les stats |
| **W4 · Formulaire → Sightline** | page https://n8n.example.com/form/import-demo, protégée par un identifiant d'équipe : on y dépose un `.dem` (ou `.dem.bz2`), importé dans le dossier Formulaire et annoncé sur Discord. n8n ne garde ni l'exécution ni le fichier |
| **W0 · Erreurs → Discord** | signale un plantage de W1, W2 ou W4 |

Les fichiers JSON sont générés par `build_workflows.py`. Pour changer un workflow, on modifie ce script, puis on lance `python deploy/n8n/build_workflows.py`. Le code des nœuds se teste avec `node --test deploy/n8n/test/workflows.test.mjs`, celui de l'extension avec `node --test extension/test/lib.test.mjs`.

**Pourquoi une extension :** PRACC lie sa session à l'adresse IP. Utilisé depuis le serveur, le cookie est refusé (401) et PRACC ferme la session : l'utilisateur est déconnecté (testé le 23/10/2026). L'extension lit donc PRACC dans le Chrome de l'utilisateur, envoie la liste brute à W1, qui répond les pracs à récupérer ; elle suit alors la redirection de chaque démo vers le stockage et renvoie à W1 le lien signé, que Sightline télécharge. Le cookie ne quitte jamais Chrome.

## Installer ou mettre à jour

Sur le serveur, après un déploiement de Sightline :

```sh
cd ~/apps/sightline
sh deploy/n8n/install.sh                 # compose + workflows (brouillons)
sh deploy/n8n/install.sh --credentials   # première fois seulement : crée les 5 credentials vides
sh deploy/n8n/install.sh --publish       # une fois les credentials remplis
```

Le compte propriétaire de n8n doit exister avant **toute** exécution de `install.sh`, pas seulement avant `--credentials`.

Un `install.sh` sans argument réimporte les workflows en brouillons : après chaque mise à jour, relance donc `sh deploy/n8n/install.sh --publish`.

## Remplir les credentials (menu Credentials de n8n)

Ces valeurs, c'est toi qui les colles, personne d'autre.

| Credential | Où trouver la valeur |
|---|---|
| **Discord Sightline** | Discord › ton serveur › salon `#sightline` › Modifier › Intégrations › Webhooks › Nouveau webhook › Copier l'URL |
| **Sightline** | sur le site, Équipe › Accès pour n8n : crée une clé « n8n » avec les deux droits. Dans *Value*, colle la clé (avec ou sans `Bearer ` devant) |
| **Sightline webhook** | sur le site, Équipe › Webhooks sortants : ajoute `https://n8n.example.com/webhook/sightline` avec les trois événements. Colle le secret affiché dans *Secret* (type *Passphrase*, algorithme HS256) |
| **Anthropic** | ta clé d'API Anthropic |
| **Formulaire d'import** | un identifiant et un mot de passe de ton choix, à donner aux coéquipiers qui déposent des démos par le formulaire |
| **Extension PRACC** | le secret affiché par l'extension (icône › *Secret pour n8n* › Copier), dans *Value*. Le champ *Name* reste `X-Sightline-Extension` |

## Extension Chrome « Sightline · PRACC »

Sur le PC, une seule fois :
1. `chrome://extensions` › active le **Mode développeur** › **Charger l'extension non empaquetée** › dossier `extension/` du dépôt.
2. Clique sur l'icône de l'extension › *Secret pour n8n* › **Copier**, et colle-le dans le credential **Extension PRACC** de n8n.
3. Reste connecté à pracc.com dans Chrome. L'extension fait un tour toutes les 30 minutes tant que Chrome est ouvert ; le bouton *Lancer un tour maintenant* en fait un tout de suite.

Badge de l'icône : **!** rouge = session PRACC expirée (reconnecte-toi à pracc.com ; W1 le signale aussi sur Discord, une fois par jour au plus), **?** orange = erreur, le détail est dans la fenêtre de l'icône. Après une modification du dossier `extension/`, clique sur *Recharger* dans `chrome://extensions`.

## Vérifier

- **Site › Équipe › Webhooks sortants › Envoyer un test** : Discord affiche « Sightline est bien relié à n8n », et la ligne de l'envoi indique 200.
- **Extension › Lancer un tour maintenant** : « Rien de nouveau » ou « N prac(s) envoyé(s) à Sightline ».
- **n8n › Executions** : l'historique de chaque tour de W1 et de chaque message de W2.
