#!/bin/sh
# n8n sur le serveur. À lancer depuis ~/apps/sightline après un déploiement (le dépôt y est copié) :
#   sh deploy/n8n/install.sh                compose à jour + workflows W0-W2 importés (brouillons, non publiés)
#   sh deploy/n8n/install.sh --credentials  pareil + les 5 credentials VIDES. Une seule fois : écrase ce qui a été collé
#   sh deploy/n8n/install.sh --publish      publie W0, W1, W2, W4, W5 et W6 (une fois les credentials remplis)
# n8n est arrêté pendant l'opération : une commande n8n à côté du serveur en marche doublerait la mémoire du conteneur
# (768 Mo) et la base SQLite n'aime pas deux écrivains.
set -eu
case "${1:-}" in
  ""|--credentials|--publish) ;;
  *) echo "usage: sh deploy/n8n/install.sh [--credentials | --publish]" >&2; exit 2 ;;
esac
HERE=$(cd "$(dirname "$0")" && pwd)
APP="$HOME/apps/n8n"
WORKFLOWS="sightlineW0err01 sightlineW1prac1 sightlineW2disc1 sightlineW4form1 sightlineW5prep01 sightlineW6fcal01"
mkdir -p "$APP"
cp "$HERE/compose.yaml" "$APP/compose.yaml"
[ -f "$APP/.env" ] || (umask 077 && printf 'N8N_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > "$APP/.env")
cd "$APP"
cli() { sudo docker compose run --rm --no-deps -v "$HERE:/sightline:ro" n8n "$@"; }
sudo docker compose stop n8n
trap 'sudo docker compose up -d' EXIT INT TERM # n8n repart même si une commande échoue
case "${1:-}" in
  --publish)
    for id in $WORKFLOWS; do cli publish:workflow --id="$id"; done ;;
  *)
    if [ "${1:-}" = "--credentials" ]; then cli import:credentials --input=/sightline/credentials.template.json; fi
    cli import:workflow --separate --input=/sightline/workflows ;;
esac
cli list:workflow
