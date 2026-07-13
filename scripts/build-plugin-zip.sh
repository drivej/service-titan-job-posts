#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PLUGIN_SLUG="${PLUGIN_SLUG:-service-titan-job-post}"
DIST_DIR="${DIST_DIR:-"$ROOT_DIR/dist"}"
ZIP_PATH="$DIST_DIR/$PLUGIN_SLUG.zip"
TMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/st-plugin-build.XXXXXX")"
STAGE_DIR="$TMP_PARENT/$PLUGIN_SLUG"
SERVICE_URL="${ST_SYNC_SERVICE_URL:-}"

if [ "${RELEASE_BUILD:-0}" = "1" ] && [ -z "$SERVICE_URL" ]; then
  echo "RELEASE_BUILD=1 requires ST_SYNC_SERVICE_URL." >&2
  exit 1
fi

case "$SERVICE_URL" in
  "") ;;
  https://*) ;;
  *)
    echo "ST_SYNC_SERVICE_URL must be an HTTPS URL." >&2
    exit 1
    ;;
esac

case "$SERVICE_URL" in
  *"'"*)
    echo "ST_SYNC_SERVICE_URL contains an unsupported quote character." >&2
    exit 1
    ;;
esac

cleanup() {
  rm -rf "$TMP_PARENT"
}
trap cleanup EXIT INT HUP TERM

cd "$ROOT_DIR"
mkdir -p "$STAGE_DIR" "$DIST_DIR"

copy_tracked_file() {
  source_file="$1"
  target_file="$STAGE_DIR/$source_file"
  mkdir -p "$(dirname "$target_file")"
  cp "$source_file" "$target_file"
}

for file in README.md service-titan-job-post.php uninstall.php; do
  copy_tracked_file "$file"
done

git ls-files 'admin/*' 'blocks/*' 'includes/*' | while IFS= read -r file; do
  copy_tracked_file "$file"
done

if [ -n "$SERVICE_URL" ]; then
  escaped_service_url="$(printf '%s' "$SERVICE_URL" | sed 's/[\\&|]/\\&/g')"
  sed -i.bak \
    "s|define('ST_SYNC_DEFAULT_SERVICE_URL', '');|define('ST_SYNC_DEFAULT_SERVICE_URL', '$escaped_service_url');|" \
    "$STAGE_DIR/service-titan-job-post.php"
  rm -f "$STAGE_DIR/service-titan-job-post.php.bak"
fi

rm -f "$ZIP_PATH"
(cd "$TMP_PARENT" && zip -qr "$ZIP_PATH" "$PLUGIN_SLUG")

if unzip -Z1 "$ZIP_PATH" | grep -E '/(service|sevalla|tests|node_modules)/|(^|/)\.github/|(^|/)\.env($|[./])|(^|/)\.DS_Store$' >/dev/null; then
  echo "Release zip contains development-only files." >&2
  unzip -Z1 "$ZIP_PATH" | grep -E '/(service|sevalla|tests|node_modules)/|(^|/)\.github/|(^|/)\.env($|[./])|(^|/)\.DS_Store$' >&2
  exit 1
fi

if [ "${RELEASE_BUILD:-0}" = "1" ] && ! unzip -p "$ZIP_PATH" "$PLUGIN_SLUG/service-titan-job-post.php" | grep -F "define('ST_SYNC_DEFAULT_SERVICE_URL', '$SERVICE_URL');" >/dev/null; then
  echo "Release zip does not contain the configured hosted service URL." >&2
  exit 1
fi

echo "Built $ZIP_PATH"
