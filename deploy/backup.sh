#!/bin/sh
# Sauvegarde quotidienne de Sightline (cron : 15 4 * * *).
# - base SQLite : copie cohérente via l'API de sauvegarde SQLite (sûre même pendant une écriture) ;
# - pistes audio des comms ;
# Les fichiers de démos ne sont pas copiés (volumineux, et toutes les données analysées sont dans la base).
# Rotation : 14 jours. Restauration : voir README (section Sauvegardes).
set -eu
DEST="${HOME}/backups/sightline"
APP="${HOME}/apps/sightline"
TS=$(date +%Y-%m-%d-%H%M)
mkdir -p "$DEST"
cd "$APP"

sudo docker compose exec -T sightline python -c "
import sqlite3
src = sqlite3.connect('/app/data/skybox.db')
dst = sqlite3.connect('/app/data/.backup.db')
src.backup(dst)
dst.close()
src.close()
"
sudo docker compose cp sightline:/app/data/.backup.db "$DEST/skybox-$TS.db"
sudo docker compose exec -T sightline rm -f /app/data/.backup.db
sudo chown "$(id -u):$(id -g)" "$DEST/skybox-$TS.db"
gzip -f "$DEST/skybox-$TS.db"

VOL=$(sudo docker volume inspect sightline_sightline-data -f '{{.Mountpoint}}')
if sudo test -d "$VOL/audio"; then
  sudo tar -czf "$DEST/audio-$TS.tar.gz" -C "$VOL" audio
  sudo chown "$(id -u):$(id -g)" "$DEST/audio-$TS.tar.gz"
fi

find "$DEST" -name 'skybox-*.db.gz' -mtime +14 -delete
find "$DEST" -name 'audio-*.tar.gz' -mtime +14 -delete
echo "$(date -Is) sauvegarde OK : $(ls -1 "$DEST" | wc -l) fichiers, $(du -sh "$DEST" | cut -f1)"
