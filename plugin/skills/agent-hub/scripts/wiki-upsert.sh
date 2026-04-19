#!/usr/bin/env bash
# scripts/wiki-upsert.sh — create or update a wiki page from a markdown file.
#
# Usage:
#   wiki-upsert.sh <slug> <path-to-md> [--title <str>] [--category <str>] [--by <user>]
#
# Behavior:
#   Probes GET /wiki/<slug>. If the page exists, issues a PUT; otherwise POST.
#   The page title is taken (in precedence order) from: --title flag, the first
#   level-1 heading in the markdown, or the slug itself.
#
#   IMPORTANT: the server (see server/wiki.ts slugify + createPage/updatePage)
#   derives the authoritative slug from the page title. To guarantee the page
#   lives at <slug> as the caller expects, this script computes
#   slugify(effective_title) and refuses to proceed if it does not equal
#   <slug>. The caller either fixes the H1, passes --title to force a
#   slug-compatible title, or adjusts <slug>.
#
# Environment:
#   PROJECT_ID   required
#
# Exit codes:
#   0  success; server's JSON response on stdout
#   2  bad invocation, missing file, or slug/title mismatch
#   *  curl / API error

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: wiki-upsert.sh <slug> <path-to-md> [options]

Create or update a wiki page from a local markdown file. Updates if the slug
already exists; creates otherwise.

Options:
  --title <str>       page title (default: first H1 in the markdown, or slug)
  --category <str>    category (default: general). Known categories:
                      general, api-docs, architecture, conventions,
                      test-patterns, troubleshooting, onboarding
  --by <user>         updatedBy field (default: $USER or "agent")
  -h, --help          print this help

Important:
  The server derives slugs from the page title (lowercase; non [a-z0-9]
  runs → "-"; trim leading/trailing "-"). This script refuses to create
  or update unless slugify(effective_title) == <slug>. Mismatch? Either
  change the H1 in the markdown, pass --title, or use a different <slug>.

Example:
  PROJECT_ID=agent-hub wiki-upsert.sh kanban-api ./kanban-api.md \
    --category api-docs --by agent-hub-backend
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  _usage; exit 0
fi

if [[ $# -lt 2 ]]; then
  _usage >&2
  exit 2
fi

slug="$1"; shift
md_path="$1"; shift

title_override=""
category="general"
updated_by="${USER:-agent}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)    title_override="${2:-}"; shift 2 ;;
    --category) category="${2:-}"; shift 2 ;;
    --by)       updated_by="${2:-}"; shift 2 ;;
    *)
      echo "error: unknown option '$1'" >&2
      _usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi

if [[ ! -f "$md_path" ]]; then
  echo "error: markdown file not found: $md_path" >&2
  exit 2
fi

# Validate slug/title agreement, then build the JSON body. All of this runs
# in one python3 invocation so the server's slugify rules (see server/wiki.ts)
# are mirrored exactly. The server IGNORES any `slug` field in the POST body;
# we omit it here and instead fail-fast if the effective title would produce
# a different slug than the caller asked for.
body="$(
  AH_SLUG="$slug" \
  AH_TITLE="$title_override" \
  AH_MD="$md_path" \
  AH_CAT="$category" \
  AH_BY="$updated_by" \
  python3 <<'PY'
import json, os, re, sys

def slugify(title: str) -> str:
    # Must match server/wiki.ts slugify(): lowercase, non-[a-z0-9] runs -> "-",
    # trim leading/trailing "-".
    s = re.sub(r'[^a-z0-9]+', '-', title.lower())
    return s.strip('-')

with open(os.environ["AH_MD"], "r", encoding="utf-8") as fh:
    content = fh.read()
title = os.environ.get("AH_TITLE", "").strip()
title_source = "--title"
if not title:
    m = re.search(r'(?m)^#\s+(.+?)\s*$', content)
    if m:
        title = m.group(1).strip()
        title_source = "H1 in markdown"
    else:
        title = os.environ["AH_SLUG"]
        title_source = "slug (fallback)"

want_slug = os.environ["AH_SLUG"]
derived   = slugify(title)
if derived != want_slug:
    sys.stderr.write(
        "error: slug/title mismatch.\n"
        f"  passed slug:        {want_slug!r}\n"
        f"  title ({title_source}): {title!r}\n"
        f"  slugify(title) →    {derived!r}\n"
        "The server derives slugs from titles and ignores the body slug\n"
        "field. Either pass --title with a slug-compatible value, change\n"
        "the H1 in the markdown, or choose a matching slug.\n"
    )
    sys.exit(2)

payload = {
    "title":     title,
    "content":   content,
    "category":  os.environ["AH_CAT"],
    "updatedBy": os.environ["AH_BY"],
}
print(json.dumps(payload))
PY
)"

# Detect whether the page already exists — suppress ah_api's -f so 404 doesn't
# abort the probe.
probe_code="$(
  key="$(ah_resolve_key)"
  auth=()
  [[ -n "$key" ]] && auth=(-H "x-api-key: $key")
  curl -s -o /dev/null -w '%{http_code}' \
    "${auth[@]}" \
    -H 'Accept: application/json' \
    "${AGENT_HUB_URL}/api/projects/$PROJECT_ID/wiki/$slug"
)"

if [[ "$probe_code" == "200" ]]; then
  ah_api PUT "/api/projects/$PROJECT_ID/wiki/$slug" -d "$body"
else
  ah_api POST "/api/projects/$PROJECT_ID/wiki" -d "$body"
fi
