#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Checking worker JavaScript syntax..."
node --check sevalla/sync.js

echo "Checking hosted service JavaScript syntax..."
find service/src service/test service/scripts -name '*.js' -print | xargs -n 1 node --check

echo "Running worker tests..."
node --test sevalla/test/sync.test.js

echo "Running hosted service tests..."
npm test --prefix service

echo "Linting PHP files..."
git ls-files '*.php' | xargs -n 1 php -l

echo "Building installable WordPress plugin zip..."
sh scripts/build-plugin-zip.sh

if [ -n "${WP_ROOT:-}" ]; then
  echo "Running WordPress integration test..."
  php tests/wordpress-integration.php
else
  echo "Skipping WordPress integration test; set WP_ROOT to a disposable WordPress install to enable it."
fi

echo "Checking staged and unstaged whitespace..."
git diff --check
git diff --cached --check

echo "Validation complete."
