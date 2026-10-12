#!/usr/bin/env bash
# Install a pinned Muse Code (Meta) CLI binary.
#
# Usage: install-muse.sh <version> [dest]
#   version  release id from the muse channel manifest, e.g. 1.4.6-R6000.1
#   dest     install path (default: $HOME/.local/bin/muse, matching museBin)
#
# Meta's install.sh drops a launcher that downloads the binary on first run
# and then self-updates hourly. A server image wants the opposite: one
# verified binary that never changes under a running session. So this reads
# the release manifest, picks the Linux artifact for this CPU, and checks the
# manifest's sha256 before installing.
set -euo pipefail

version="${1:?usage: install-muse.sh <version> [dest]}"
dest="${2:-$HOME/.local/bin/muse}"
base="https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${version}"
ua="muse-code/launcher-3"

case "$(uname -m)" in
  x86_64 | amd64) artifact=x86_linux ;;
  aarch64 | arm64) artifact=aarch64_linux ;;
  *)
    echo "install-muse: no Muse build for $(uname -m); skipping" >&2
    exit 0
    ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --proto '=https' -A "$ua" -o "$work/manifest.json" "${base}&file=manifest.json"
url="$(jq -r --arg a "$artifact" '.artifacts[$a].url // empty' "$work/manifest.json")"
sum="$(jq -r --arg a "$artifact" '.artifacts[$a].checksum // empty' "$work/manifest.json")"
if [[ -z "$url" || -z "$sum" ]]; then
  echo "install-muse: manifest for $version has no $artifact artifact" >&2
  exit 1
fi
case "$url" in
  https://lookaside.facebook.com/*) ;;
  *)
    echo "install-muse: refusing artifact URL outside lookaside.facebook.com: $url" >&2
    exit 1
    ;;
esac

curl -fsSL --proto '=https' -A "$ua" -o "$work/muse" "$url"
echo "$sum  $work/muse" | sha256sum -c - >/dev/null
chmod 0755 "$work/muse"
mkdir -p "$(dirname "$dest")"
mv "$work/muse" "$dest"
"$dest" --version
