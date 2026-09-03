#!/usr/bin/env bash
# install-chromedriver.sh — install the chromedriver that matches an installed
# Chrome / Chromium build, from Google's Chrome for Testing (CfT) distribution.
#
# Shared by both container images so they can't drift apart:
#   - server/finalize/runner/Dockerfile  (Google Chrome stable, amd64)
#   - server/Dockerfile                  (Playwright's pinned Chromium)
#
# Usage:
#   install-chromedriver.sh <chrome-version> [--print-url] [--dest <dir>]
#
#   <chrome-version>  Full four-part version of the browser already installed
#                     (e.g. `google-chrome --version | grep -oE '[0-9]+(\.[0-9]+){3}'`
#                     or playwright-core's browsers.json `browserVersion`).
#   --print-url       Resolve and print the download URL, don't install.
#   --dest <dir>      Install directory (default /usr/local/bin).
#
# Resolution ladder (chromedriver only drives its own major, so every rung is
# pinned to the browser's major line — a cross-major install would "succeed"
# and then refuse every session with "This version of ChromeDriver only
# supports Chrome version N"):
#   1. Exact version:      <CFT_BASE>/<version>/linux64/chromedriver-linux64.zip
#   2. Same major.minor.build, newest patch — CfT does not publish a driver for
#      every browser patch, and Playwright's Chromium is a dev-channel snapshot
#      whose exact patch may be absent:
#                          latest-patch-versions-per-build-with-downloads.json
#   3. Fail loudly. Never fall back to a different major.
#
# CfT publishes Linux drivers for x86-64 only; on any other architecture this
# script prints a notice and exits 0 so multi-arch builds (arm64 dev images)
# keep working — they simply ship without chromedriver, matching the absence
# of Google Chrome there.
#
# Endpoint docs: https://googlechromelabs.github.io/chrome-for-testing/
set -euo pipefail

CFT_BASE="${CFT_BASE:-https://storage.googleapis.com/chrome-for-testing-public}"
CFT_ENDPOINTS="${CFT_ENDPOINTS:-https://googlechromelabs.github.io/chrome-for-testing}"
ARCH="${INSTALL_CHROMEDRIVER_ARCH:-$(uname -m)}"

version=""
print_url=0
dest=/usr/local/bin

while [ $# -gt 0 ]; do
  case "$1" in
    --print-url) print_url=1 ;;
    --dest)
      shift
      dest="${1:?--dest needs a directory}"
      ;;
    -h | --help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    -*)
      echo "install-chromedriver: unknown option $1" >&2
      exit 2
      ;;
    *)
      if [ -n "$version" ]; then
        echo "install-chromedriver: unexpected argument $1" >&2
        exit 2
      fi
      version="$1"
      ;;
  esac
  shift
done

if [ -z "$version" ]; then
  echo "install-chromedriver: missing <chrome-version>" >&2
  exit 2
fi
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "install-chromedriver: '$version' is not a four-part Chrome version (major.minor.build.patch)" >&2
  exit 2
fi

case "$ARCH" in
  x86_64 | amd64) ;;
  *)
    echo "install-chromedriver: Chrome for Testing ships no linux/$ARCH chromedriver; skipping (browser automation here must use a bundled driver)" >&2
    exit 0
    ;;
esac

major="${version%%.*}"
build="${version%.*}"

resolve_url() {
  local exact="$CFT_BASE/$version/linux64/chromedriver-linux64.zip"
  if curl -fsSIL -o /dev/null "$exact" 2>/dev/null; then
    echo "$exact"
    return 0
  fi
  echo "install-chromedriver: no chromedriver published for exact $version; looking for the newest patch of build $build" >&2
  local fallback
  fallback="$(curl -fsSL "$CFT_ENDPOINTS/latest-patch-versions-per-build-with-downloads.json" \
    | jq -r --arg b "$build" '.builds[$b].downloads.chromedriver[]? | select(.platform == "linux64") | .url')"
  if [ -n "$fallback" ]; then
    echo "$fallback"
    return 0
  fi
  echo "install-chromedriver: no chromedriver for build $build (major $major) on Chrome for Testing; refusing to install a different major" >&2
  return 1
}

url="$(resolve_url)"
if [ "$print_url" = 1 ]; then
  echo "$url"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/chromedriver.zip" "$url"
unzip -q "$tmp/chromedriver.zip" -d "$tmp"
install -m 0755 "$tmp/chromedriver-linux64/chromedriver" "$dest/chromedriver"

installed="$("$dest/chromedriver" --version)"
installed_major="$(echo "$installed" | grep -oE '[0-9]+(\.[0-9]+){3}' | head -n1 | cut -d. -f1)"
if [ "$installed_major" != "$major" ]; then
  echo "install-chromedriver: installed '$installed' does not match browser major $major" >&2
  rm -f "$dest/chromedriver"
  exit 1
fi
echo "install-chromedriver: $installed (browser $version) -> $dest/chromedriver"
