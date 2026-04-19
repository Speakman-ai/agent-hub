#!/usr/bin/env bash
# Container pool — scaffold job entrypoint (W3).
#
# Runs inside ghcr.io/.../agent-hub/scaffold-base:* when the dispatcher
# starts a scaffolding job (spec §5.2 / Appendix A sequence diagram).
#
# Responsibilities:
#   1. Parse SCAFFOLD_SPEC (JSON env var injected by the compose template)
#   2. Copy the pre-baked template tree to /work/<name>
#   3. Rewrite package.json identity fields (name, description)
#   4. Authenticate `gh` with the GitHub App installation token passed in
#      via SCAFFOLD_GH_TOKEN (never echoed — see §3 of "Prompt
#      Construction Workflow" for the token-handling convention)
#   5. `git init && git add -A && git commit` as the bot author
#   6. `gh repo create <owner>/<repo> --push` against the user's account
#   7. Exit 0 on success. Any step failure → non-zero exit → dispatcher
#      surfaces structured ExitReason → pool_requests row marked failed.
#
# Why this is a bash script and not Node:
#   - It is pure shell orchestration of `gh` / `git` / `jq`. The logic
#     is linear: copy → tweak → push. A Node wrapper would add a runtime
#     dependency inside the image for no behavioral gain.
#   - The pool dispatcher (Node, server/container-pool/) is the one that
#     actually owns contract surface; this script is plumbing.
#
# Exit codes:
#   0  success
#   2  bad spec (missing required fields, unknown template)
#   3  template copy failed
#   4  git init/commit failed
#   5  gh auth / repo create failed
#
set -euo pipefail

log() { printf '[scaffold] %s\n' "$*"; }
fail() { printf '[scaffold] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

# --- 1. Parse SCAFFOLD_SPEC --------------------------------------------------
: "${SCAFFOLD_SPEC:?SCAFFOLD_SPEC env var is required (JSON)}"
: "${SCAFFOLD_GH_TOKEN:?SCAFFOLD_GH_TOKEN env var is required}"

# `jq -er` returns non-zero on null so missing fields fail loudly rather
# than silently becoming the literal string "null".
TEMPLATE=$(printf '%s' "$SCAFFOLD_SPEC" | jq -er '.template') \
  || fail "SCAFFOLD_SPEC missing .template" 2
NAME=$(printf '%s' "$SCAFFOLD_SPEC" | jq -er '.name') \
  || fail "SCAFFOLD_SPEC missing .name" 2
OWNER=$(printf '%s' "$SCAFFOLD_SPEC" | jq -er '.owner') \
  || fail "SCAFFOLD_SPEC missing .owner" 2
DESCRIPTION=$(printf '%s' "$SCAFFOLD_SPEC" | jq -r '.description // ""')
PRIVATE=$(printf '%s' "$SCAFFOLD_SPEC" | jq -r '.private // true')

# Name validation — GitHub repo names are [A-Za-z0-9._-]+ with length
# limits. We enforce a stricter subset (no leading dots, no ..) so we
# can use the same string as the local directory name without surprises.
if ! [[ "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$ ]]; then
  fail "invalid .name: $NAME" 2
fi
if [[ "$NAME" == *..* ]]; then
  fail "invalid .name: contains '..'" 2
fi

TEMPLATE_SRC="/scaffold/templates/$TEMPLATE"
if [[ ! -d "$TEMPLATE_SRC" ]]; then
  fail "unknown template '$TEMPLATE' (not found at $TEMPLATE_SRC)" 2
fi

log "spec ok: template=$TEMPLATE owner=$OWNER name=$NAME private=$PRIVATE"

# --- 2. Copy template to workspace ------------------------------------------
DEST="/work/$NAME"
if [[ -e "$DEST" ]]; then
  fail "destination $DEST already exists (slot not cleaned)" 3
fi

# `cp -a` preserves perms + symlinks and is measurably faster than
# `-r` on the pre-baked node_modules tree (15k+ symlinks in expo).
cp -a "$TEMPLATE_SRC" "$DEST" || fail "template copy failed" 3
log "copied template → $DEST"

# --- 3. Rewrite package.json identity ---------------------------------------
PKG_JSON="$DEST/package.json"
if [[ -f "$PKG_JSON" ]]; then
  tmp=$(mktemp)
  # `--arg` passes strings safely — no shell interpolation inside jq.
  jq --arg name "$NAME" --arg desc "$DESCRIPTION" \
     '.name = $name | (if $desc == "" then . else .description = $desc end)' \
     "$PKG_JSON" > "$tmp" && mv "$tmp" "$PKG_JSON"
  log "rewrote package.json name → $NAME"
else
  log "no package.json in template (unusual but not fatal)"
fi

# --- 3b. Post-scaffold hook: drop CLAUDE.md/AGENTS.md/workflow files ---------
#
# The dispatcher (server/container-pool/scaffold-builder) packages extra
# files to land in the tree before the initial commit. Typical payload:
# CLAUDE.md, AGENTS.md, .github/workflows/ci.yml. Paths are validated
# here (no absolute, no ..) in addition to dispatcher-side validation —
# defense in depth, since SCAFFOLD_SPEC is the wire contract across a
# process boundary.
POST_FILE_COUNT=$(printf '%s' "$SCAFFOLD_SPEC" | jq -r '.postScaffoldFiles | length // 0')
if [[ "$POST_FILE_COUNT" =~ ^[0-9]+$ ]] && (( POST_FILE_COUNT > 0 )); then
  for i in $(seq 0 $((POST_FILE_COUNT - 1))); do
    rel=$(printf '%s' "$SCAFFOLD_SPEC" | jq -er ".postScaffoldFiles[$i].path") \
      || fail "postScaffoldFiles[$i].path missing" 2
    case "$rel" in
      /*) fail "postScaffoldFiles[$i]: absolute path '$rel' rejected" 2 ;;
      *..*) fail "postScaffoldFiles[$i]: '..' traversal in '$rel' rejected" 2 ;;
    esac
    target="$DEST/$rel"
    mkdir -p "$(dirname "$target")"
    # jq -j prints raw contents without a trailing newline, preserving
    # byte-for-byte fidelity. Piping via stdin avoids arg-length limits
    # for long files and keeps embedded nulls/quotes intact.
    printf '%s' "$SCAFFOLD_SPEC" | jq -ej ".postScaffoldFiles[$i].contents" > "$target" \
      || fail "postScaffoldFiles[$i]: failed to write '$rel'" 3
    log "wrote post-scaffold file: $rel"
  done
fi

# --- 4. git init / commit ----------------------------------------------------
cd "$DEST"
git init --initial-branch=main >/dev/null || fail "git init failed" 4
git config user.email "agent-hub-bot@users.noreply.github.com"
git config user.name "agent-hub-bot"
# Default .gitignore from the template covers node_modules + build
# output; we don't touch it here. Some templates (expo blank-ts) don't
# ignore node_modules — intentional, the pre-bake IS the value prop —
# but we still want to strip it from the initial commit to keep the
# push under GitHub's recommended 1 GiB push size.
if [[ -d node_modules ]] && ! grep -qxF 'node_modules' .gitignore 2>/dev/null; then
  printf '\nnode_modules\n' >> .gitignore
  log "appended node_modules to .gitignore"
fi
git add -A || fail "git add failed" 4
git commit -m "Initial commit (scaffolded from $TEMPLATE)" >/dev/null \
  || fail "git commit failed" 4
log "initial commit created"

# --- 5. gh auth + repo create + push ----------------------------------------
# `gh auth login --with-token` reads from stdin. We pipe the token and
# immediately `unset` the env var so a subsequent `env` dump (e.g. a
# bug report) doesn't leak it. The token is still in the gh config
# under /home/node/.config/gh/hosts.yml for the remainder of the
# container's life, but the container exits in <90 s and is `docker rm
# -f`'d by the reaper.
printf '%s' "$SCAFFOLD_GH_TOKEN" | gh auth login --with-token >/dev/null \
  || fail "gh auth login failed" 5
unset SCAFFOLD_GH_TOKEN

# Visibility flag: `--public` vs `--private`. `gh repo create` rejects
# `--private=true` — it wants the literal subcommand flag. We default
# to --private (users can flip to public post-push if they want).
VIS_FLAG="--private"
if [[ "$PRIVATE" == "false" ]]; then VIS_FLAG="--public"; fi

DESC_ARG=()
if [[ -n "$DESCRIPTION" ]]; then
  DESC_ARG=(--description "$DESCRIPTION")
fi

# `--source=.` + `--push` → creates the remote, sets origin, pushes
# main in one call. Failure exits 5 so the dispatcher distinguishes
# "remote side went wrong" from earlier local failures.
gh repo create "$OWNER/$NAME" \
  "$VIS_FLAG" \
  "${DESC_ARG[@]}" \
  --source=. \
  --push \
  || fail "gh repo create/push failed" 5

log "scaffold complete: https://github.com/$OWNER/$NAME"
exit 0
