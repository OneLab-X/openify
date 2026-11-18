#!/usr/bin/env bash
# Shopkit installer (SPEC §5): checks Docker, writes .env with fresh secrets, starts the stack.
set -euo pipefail
cd "$(dirname "$0")/.."

red() { printf '\033[31m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

command -v docker >/dev/null || { red "Docker is not installed: https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { red "Docker Compose v2 is required (docker compose …)."; exit 1; }
docker info >/dev/null 2>&1 || { red "Docker is not running."; exit 1; }
command -v openssl >/dev/null || { red "openssl is required to generate secrets."; exit 1; }

if [[ -f .env ]]; then
  bold ".env already exists; keeping it (delete it to regenerate secrets)."
else
  DOMAIN="${SHOPKIT_DOMAIN:-}"
  EMAIL="${SHOPKIT_ACME_EMAIL:-}"
  if [[ -z "$DOMAIN" && -t 0 ]]; then read -rp "Public domain (blank for localhost): " DOMAIN; fi
  DOMAIN="${DOMAIN:-localhost}"
  if [[ "$DOMAIN" != "localhost" && -z "$EMAIL" && -t 0 ]]; then read -rp "Email for TLS certificates: " EMAIL; fi
  EMAIL="${EMAIL:-admin@example.com}"
  # Non-default ports (e.g. another web server already uses 80/443): SHOPKIT_HTTPS_PORT=8443.
  HTTPS_PORT="${SHOPKIT_HTTPS_PORT:-443}"
  HTTP_PORT="${SHOPKIT_HTTP_PORT:-80}"
  URL_PORT=""; [[ "$HTTPS_PORT" != "443" ]] && URL_PORT=":${HTTPS_PORT}"

  umask 077
  cat > .env <<ENV
PUBLIC_URL=https://${DOMAIN}${URL_PORT}
SITE_ADDRESS=${DOMAIN}
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}
ACME_EMAIL=${EMAIL}
SHOPKIT_MASTER_KEY=$(openssl rand -base64 32)
SHOPKIT_MASTER_KEY_VERSION=1
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
REVALIDATE_SECRET=$(openssl rand -hex 24)
ENV
  echo
  red "IMPORTANT: back up .env now. Losing SHOPKIT_MASTER_KEY makes stored provider secrets unrecoverable."
  echo
fi

# Prebuilt images when published; otherwise build locally.
docker compose pull --ignore-buildable --quiet 2>/dev/null || true
docker compose up -d --build --wait

URL="$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)"
echo
bold "Shopkit is running at ${URL}"
echo "Open ${URL}/admin/setup and paste the setup token from:"
echo "  docker compose logs api | grep 'setup token'"
