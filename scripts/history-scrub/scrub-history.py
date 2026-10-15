#!/usr/bin/env python3
"""Rewrite a repo's history to remove internal identifiers, then verify.

Runs `git filter-repo` on a fresh clone in --workdir (never on your checkout),
rewriting file contents, file paths, commit/tag messages, and author/committer
emails with the same rules. Emails that do not match a rule (noreply, personal,
agent addresses) are left exactly as they are. Commit count,
dates, and tags are preserved; hashes change.

The identifiers are passed on the command line so this script never has to
contain them:

  --literal FROM=TO     case-insensitive exact replacement, applied first
                        (e.g. a hostname -> example.com)
  --compound A,B=C      replace word A with C (case preserved) wherever it is
                        followed by word B, joined by nothing, '-', '_', spaces,
                        or a line wrap inside a comment ('A\\n * B')
  --word FROM=TO        case-preserving replacement of FROM anywhere
  --replace-text FILE   secrets, in git filter-repo's expressions format,
                        parsed and applied exactly as filter-repo does
                        (`regex:` replacements may use \\1 groups), but also
                        to paths, messages, and emails, and checked by
                        verification. Keep it outside the repo.

Binary blobs (NUL in the first 8 KiB) are never rewritten, matching
filter-repo; a match left in one fails verification for you to handle.

Only the branch named by --branch and all tags are cloned, so PR refs and
session branches never reach the rewritten repo.

Afterwards every object in the rewritten repo (blobs, trees, commits, tags)
is scanned; any surviving match fails the run with a non-zero exit.

Nothing is pushed. See README.md in this directory for the publish steps.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

SEP = rb"(?:[-_ \t]*|[ \t]*\r?\n[ \t]*(?:[*#/]+|--)?[ \t]*)"


def match_case(template: bytes, word: bytes) -> bytes:
    """Return `word` cased like `template` (UPPER, Title, camel, or lower)."""
    if template.isupper():
        return word.upper()
    if template[:1].isupper():
        return word[:1].upper() + word[1:].lower()
    return word.lower()


def load_filter_repo():
    try:
        import git_filter_repo
    except ImportError:
        sys.exit("git filter-repo is required: pip install --user git-filter-repo")
    return git_filter_repo


def parse_replace_text(path):
    """Parse an expressions file with filter-repo's own parser.

    Returns {'literals': [(bytes, bytes)], 'regexes': [(Pattern, bytes)]},
    exactly what `git filter-repo --replace-text` would use, including
    `glob:` and the ***REMOVED*** default.
    """
    return load_filter_repo().FilteringOptions.get_replace_text(path)


def is_binary(data: bytes) -> bool:
    """filter-repo's own test: a NUL byte in the first 8 KiB."""
    return b"\0" in data[:8192]


class Rules:
    def __init__(self, literals, compounds, words, secrets=None):
        self.literals = [(re.compile(re.escape(a), re.I), b) for a, b in literals]
        self.compounds = [
            (re.compile(rb"(" + re.escape(a) + rb")(" + SEP + re.escape(b) + rb")", re.I), c)
            for a, b, c in compounds
        ]
        self.words = [(re.compile(re.escape(a), re.I), b) for a, b in words]
        secrets = secrets or {"literals": [], "regexes": []}
        self.secret_literals = list(secrets["literals"])
        self.secret_regexes = list(secrets["regexes"])
        self.identifier_patterns = (
            [p for p, _ in self.literals]
            + [p for p, _ in self.compounds]
            + [p for p, _ in self.words]
        )

    @property
    def empty(self) -> bool:
        return not (self.identifier_patterns or self.secret_literals or self.secret_regexes)

    def apply(self, data: bytes) -> bytes:
        # Secrets first, with the same calls `git filter-repo --replace-text`
        # makes: bytes.replace for literals, regex.sub (so `\1` templates
        # expand) for regexes.
        for literal, replacement in self.secret_literals:
            data = data.replace(literal, replacement)
        for regex, replacement in self.secret_regexes:
            data = regex.sub(replacement, data)
        # Identifier rules: replacements come from the command line and are
        # always literal text, so use functions, never a sub() template.
        for pat, to in self.literals:
            data = pat.sub(lambda _m, to=to: to, data)
        for pat, to in self.compounds:
            data = pat.sub(lambda m, to=to: match_case(m.group(1), to) + m.group(2), data)
        for pat, to in self.words:
            data = pat.sub(lambda m, to=to: match_case(m.group(0), to), data)
        return data

    def find(self, data: bytes) -> bool:
        return (
            any(lit in data for lit, _ in self.secret_literals)
            or any(rx.search(data) for rx, _ in self.secret_regexes)
            or any(p.search(data) for p in self.identifier_patterns)
        )


def parse_pairs(values, sep=b"="):
    out = []
    for v in values or []:
        raw = v.encode()
        if sep not in raw:
            sys.exit(f"bad rule (missing '='): {v}")
        a, b = raw.split(sep, 1)
        if not a:
            sys.exit(f"bad rule (empty FROM): {v}")
        out.append((a, b))
    return out


def parse_compounds(values):
    out = []
    for a_b, c in parse_pairs(values):
        if b"," not in a_b:
            sys.exit(f"bad --compound (want A,B=C): {a_b.decode()}")
        a, b = a_b.split(b",", 1)
        out.append((a, b, c))
    return out


def run(cmd, cwd=None):
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def rewrite(args, rules: Rules, repo: Path) -> None:
    fr = load_filter_repo()

    # Secrets are applied by the callbacks (via `rules`), not filter-repo's own
    # --replace-text, so messages, paths, and emails get them too.
    options = fr.FilteringOptions.parse_args(["--force", "--quiet"])

    def blob_cb(blob, _meta):
        # Like filter-repo's --replace-text, leave binary blobs alone rather
        # than shift bytes inside them; verification still scans and reports
        # any match left in one.
        if not is_binary(blob.data):
            blob.data = rules.apply(blob.data)

    def message_cb(message):
        return rules.apply(message)

    def filename_cb(filename):
        return rules.apply(filename)

    def email_cb(email):
        return rules.apply(email)

    import os

    cwd = os.getcwd()
    os.chdir(repo)
    try:
        fr.RepoFilter(
            options,
            blob_callback=blob_cb,
            message_callback=message_cb,
            filename_callback=filename_cb,
            email_callback=email_cb,
        ).run()
    finally:
        os.chdir(cwd)


class VerifyError(Exception):
    pass


def verify(rules: Rules, repo: Path) -> int:
    """Scan every object; return the number of offending objects.

    Raises VerifyError when the scan could not cover the whole repo (not a
    repository, git failed partway, truncated output, or no objects at all),
    so an incomplete scan can never report a clean result.
    """
    if not repo.is_dir():
        raise VerifyError(f"not a directory: {repo}")
    # Without this, git walks up from a plain subdirectory and scans whatever
    # repository happens to enclose it.
    probe = subprocess.run(
        ["git", "rev-parse", "--absolute-git-dir"], cwd=repo, capture_output=True
    )
    git_dir = Path(probe.stdout.decode().strip()).resolve() if probe.returncode == 0 else None
    if git_dir not in (repo, repo / ".git"):
        raise VerifyError(f"not a git repository root: {repo}")
    proc = subprocess.Popen(
        ["git", "cat-file", "--batch-all-objects", "--batch", "--unordered"],
        cwd=repo,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdout
    bad = 0
    checked = 0
    while True:
        header = proc.stdout.readline()
        if not header:
            break
        fields = header.split()
        if len(fields) != 3:
            proc.kill()
            raise VerifyError(f"unexpected cat-file output: {header!r}")
        sha, kind, size = fields
        data = proc.stdout.read(int(size))
        if len(data) != int(size) or proc.stdout.read(1) != b"\n":
            proc.kill()
            raise VerifyError(f"truncated object {sha.decode()}")
        checked += 1
        if rules.find(data):
            bad += 1
            if bad <= 20:
                print(f"  leak: {kind.decode()} {sha.decode()}", file=sys.stderr)
    stderr = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
    if proc.wait() != 0:
        raise VerifyError(f"git cat-file exited {proc.returncode}: {stderr}")
    if checked == 0:
        raise VerifyError(f"no objects found in {repo}")
    print(f"verified {checked} objects, {bad} with matches")
    return bad


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", help="repo URL or path to clone from (required unless --verify-only)")
    p.add_argument(
        "--workdir",
        required=True,
        help="empty directory for the rewritten clone, or the repo to scan with --verify-only",
    )
    p.add_argument("--branch", default="main")
    p.add_argument("--literal", action="append")
    p.add_argument("--compound", action="append")
    p.add_argument("--word", action="append")
    p.add_argument("--replace-text")
    p.add_argument("--verify-only", action="store_true", help="scan --workdir without rewriting")
    args = p.parse_args()
    if not args.verify_only and not args.source:
        p.error("--source is required unless --verify-only")

    secrets = parse_replace_text(args.replace_text) if args.replace_text else None
    rules = Rules(
        parse_pairs(args.literal), parse_compounds(args.compound), parse_pairs(args.word), secrets
    )
    if rules.empty:
        sys.exit("no rules given (--literal / --compound / --word / --replace-text)")

    repo = Path(args.workdir).resolve()
    if not args.verify_only:
        if repo.exists() and any(repo.iterdir()):
            sys.exit(f"--workdir must be empty: {repo}")
        if shutil.which("git") is None:
            sys.exit("git not found")
        run(["git", "clone", "--no-local", "--single-branch", "--branch", args.branch, args.source, str(repo)])
        run(["git", "fetch", "--tags", "origin"], cwd=repo)
        before = subprocess.check_output(["git", "rev-list", "--count", "--all"], cwd=repo).decode().strip()
        rewrite(args, rules, repo)
        after = subprocess.check_output(["git", "rev-list", "--count", "--all"], cwd=repo).decode().strip()
        print(f"commits before={before} after={after}")
        if before != after:
            print("commit count changed; inspect before publishing", file=sys.stderr)
            return 1
    try:
        return 1 if verify(rules, repo) else 0
    except VerifyError as err:
        print(f"verification failed: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
