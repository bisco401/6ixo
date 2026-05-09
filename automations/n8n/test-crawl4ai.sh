#!/usr/bin/env sh
set -eu

CRAWL4AI_BASE_URL="${CRAWL4AI_BASE_URL:-http://127.0.0.1:11235}"

if command -v curl >/dev/null 2>&1; then
  curl -fsS "$CRAWL4AI_BASE_URL/health"
else
  wget -qO- "$CRAWL4AI_BASE_URL/health"
fi

printf '\n'
