#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PLUGIN_FILE="$ROOT_DIR/service-titan-job-post.php"
EXPECTED_TAG="${1:-}"

HEADER_VERSION="$(sed -n 's/^ \* Version:[[:space:]]*//p' "$PLUGIN_FILE" | head -n 1 | tr -d '[:space:]')"
CONSTANT_VERSION="$(sed -n "s/^define('ST_SYNC_VERSION', '\([^']*\)');$/\1/p" "$PLUGIN_FILE" | head -n 1)"

if ! printf '%s\n' "$HEADER_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Plugin header version is missing or invalid: $HEADER_VERSION" >&2
  exit 1
fi

if [ "$HEADER_VERSION" != "$CONSTANT_VERSION" ]; then
  echo "Plugin header version $HEADER_VERSION does not match ST_SYNC_VERSION $CONSTANT_VERSION." >&2
  exit 1
fi

if [ -n "$EXPECTED_TAG" ] && [ "$EXPECTED_TAG" != "v$HEADER_VERSION" ]; then
  echo "Release tag $EXPECTED_TAG must match plugin version v$HEADER_VERSION." >&2
  exit 1
fi

printf '%s\n' "$HEADER_VERSION"
