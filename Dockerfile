# Image de production : frontend compilé + backend FastAPI qui le sert.
# Le backend calcule ses chemins depuis son emplacement (ROOT = dossier parent de backend/) :
# on conserve donc l'arborescence du dépôt sous /app (backend/, maps/, frontend/dist/, mobile/dist/).

FROM node:24-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# App mobile, version web (Expo) : servie par le backend sous /app/
FROM node:24-slim AS mobile
WORKDIR /mobile
# Metro garde tout le graphe en mémoire : plafond explicite sur le petit serveur
ENV NODE_OPTIONS=--max-old-space-size=1536 EXPO_NO_TELEMETRY=1 CI=1
COPY mobile/package.json mobile/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY mobile/ ./
RUN npx expo export -p web

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    SKYBOX_DATA_DIR=/app/data SKYBOX_CONFIG=/app/data/config.toml
WORKDIR /app
# bsdtar : extraction des archives .rar d'HLTV (import par lien)
RUN apt-get update && apt-get install -y --no-install-recommends libarchive-tools && rm -rf /var/lib/apt/lists/*
COPY backend/pyproject.toml backend/pyproject.toml
# Dépendances seules (pas d'installation du package : le code doit rester sous /app/backend).
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('backend/pyproject.toml','rb'))['project']['dependencies']))" > /tmp/req.txt \
    && pip install --no-cache-dir -r /tmp/req.txt && rm /tmp/req.txt
COPY backend/alembic.ini backend/alembic.ini
COPY backend/alembic backend/alembic
COPY backend/app backend/app
COPY maps maps
COPY --from=web /web/dist frontend/dist
COPY --from=mobile /mobile/dist mobile/dist
RUN useradd --create-home --uid 10001 app && mkdir -p /app/data && chown app:app /app/data
USER app
WORKDIR /app/backend
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:get_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
