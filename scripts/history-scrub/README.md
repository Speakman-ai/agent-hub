# History scrub

`scrub-history.py` rewrites the repo's history to remove internal identifiers,
then scans every object in the result and fails if anything survived. It never
pushes. The identifiers are command-line arguments, so they are never written
into the repo.

Requires `git filter-repo` (`pip install --user git-filter-repo`).

## 1. Rewrite into a scratch directory

```bash
python3 scripts/history-scrub/scrub-history.py \
  --source <hub-git-url-or-bare-repo-path> \
  --workdir /tmp/history-scrub \
  --literal '<private-host>=example.com' \
  --compound '<word1>,<word2>=acme' \
  --word '<org-handle>=acme' \
  --replace-text ~/secrets-replacements.txt   # optional, keep outside the repo
```

- Clones only `main` and tags. PR refs and session branches are not carried
  over.
- Rewrites file contents, file paths, commit and tag messages, and any
  author/committer email that matches a rule. Other emails are untouched.
- Reduces `Merged-by: Agent Hub (user@host)` trailers in commit and tag
  messages to `(user)`, the format new merges write. The username stays.
- Fails if the commit count changes or any object still matches.
- `--replace-text` takes filter-repo's expressions file, parsed and applied
  by filter-repo's own code paths (`literal:`, `regex:` with `\1` groups,
  `glob:`, default `***REMOVED***`). Put every credential that ever appeared
  in history there. Unlike plain filter-repo, they also apply to paths, commit
  and tag messages, and emails, and verification checks for them.
- Binary blobs (a NUL byte in the first 8 KiB) are never rewritten, same as
  filter-repo. A match left in one fails verification so you can decide how
  to handle that file.
- Verification fails (exit 2) if the scan cannot cover the whole repo: not a
  repository root, git errors partway, or no objects.

Re-run the scan alone with `--verify-only --workdir /tmp/history-scrub` plus
the same rules and `--replace-text` file.

## 2. Publish

GitHub keeps old commits reachable by hash after a force-push, so do not
overwrite the existing public repo in place.

1. Make the existing GitHub repo **private**. This step is required: a
   renamed public repo still serves the unscrubbed history and any old
   credentials under its new name.
2. Then rename it (for example `agent-hub-archive`) to free the original
   name. Renaming is only for the name; it hides nothing on its own.
3. Create a new empty public repo under the original name.
4. From `/tmp/history-scrub`: add it as a remote, then push `main` and tags:
   `git push <new-remote> main --tags`.

## 3. Replace the Hub-hosted repo

The Hub git host mirrors `main` and tags to GitHub, non-force. Once GitHub has
the rewritten history, every mirror push from the old history is rejected, and
in all-branches mode session branches would carry old commits to GitHub. So
the Hub-hosted bare repo has to move to the rewritten history too:

1. Pause the GitHub mirror for the project.
2. Force-push `main` and tags from `/tmp/history-scrub` to the Hub origin.
3. Delete or rebase open session branches and PR refs built on the old
   history. Existing worktrees need a fresh clone.
4. Re-enable the mirror.

## 4. Rotate

Treat every credential that ever appeared in history as exposed, whether or
not the rewrite removed it, and rotate it.

## Guard

`server/no-internal-provenance.test.ts` checks the tracked tree and commit
messages for the same identifiers, stored as hashes in
`server/test/internal-tokens.ts`.
