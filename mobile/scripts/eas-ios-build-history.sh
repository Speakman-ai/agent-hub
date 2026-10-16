#!/usr/bin/env bash
# Saves the project's full iOS EAS build history as page-*.json files in
# <out_dir>, one `eas build:list --json` page each. Every page is fetched
# (not just the newest), so next-app-version.mjs sees the true highest
# version. Any page that fails to fetch or parse fails the script.
#
# usage: EXPO_TOKEN=... eas-ios-build-history.sh <eas_bin> <out_dir>
set -euo pipefail

eas_bin="${1:?usage: eas-ios-build-history.sh <eas_bin> <out_dir>}"
out_dir="${2:?usage: eas-ios-build-history.sh <eas_bin> <out_dir>}"
here="$(cd "$(dirname "$0")" && pwd)"
# eas-cli caps --limit at 50.
page_size=50
# A runaway guard, far above any real history (10,000 builds).
max_pages=200

mkdir -p "$out_dir"
offset=0
pages=0
while :; do
  page="$out_dir/page-$(printf '%06d' "$offset").json"
  "$eas_bin" build:list --platform ios --limit "$page_size" --offset "$offset" \
    --json --non-interactive > "$page"
  count="$(env -u EXPO_TOKEN node "$here/next-app-version.mjs" --count "$page")"
  pages=$((pages + 1))
  if [ "$count" -lt "$page_size" ]; then
    break
  fi
  if [ "$pages" -ge "$max_pages" ]; then
    echo "EAS build history exceeded $max_pages pages; refusing to guess the app version." >&2
    exit 1
  fi
  offset=$((offset + page_size))
done
echo "Read $pages page(s) of iOS EAS build history." >&2
