#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PLUGIN_SLUG="${PLUGIN_SLUG:-service-titan-job-post}"
DIST_DIR="${DIST_DIR:-"$ROOT_DIR/dist"}"
ZIP_PATH="$DIST_DIR/$PLUGIN_SLUG.zip"
TMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/st-plugin-build.XXXXXX")"
STAGE_DIR="$TMP_PARENT/$PLUGIN_SLUG"

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

rm -f "$ZIP_PATH"
(cd "$TMP_PARENT" && zip -qr "$ZIP_PATH" "$PLUGIN_SLUG")

if unzip -Z1 "$ZIP_PATH" | grep -E '/(service|sevalla|tests|node_modules)/|(^|/)\.github/|(^|/)\.env($|[./])|(^|/)\.DS_Store$' >/dev/null; then
  echo "Release zip contains development-only files." >&2
  unzip -Z1 "$ZIP_PATH" | grep -E '/(service|sevalla|tests|node_modules)/|(^|/)\.github/|(^|/)\.env($|[./])|(^|/)\.DS_Store$' >&2
  exit 1
fi

echo "Built $ZIP_PATH"
