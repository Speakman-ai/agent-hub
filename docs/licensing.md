# Licensing

Agent Hub is open source under the **Apache License 2.0**. The full text lives
in [`LICENSE`](../LICENSE) at the repo root, with attribution in
[`NOTICE`](../NOTICE).

Apache-2.0 was chosen for maximum adoption and reach: it is permissive, grants
an explicit patent license, and is compatible with the open-core model where a
separate enterprise layer may be licensed differently later.

## Source-header policy

**Per-file SPDX short-form headers are OPTIONAL, not required.**

The top-level `LICENSE` file plus the `license` field in every `package.json`
already establish the license for the whole repository, which is what GitHub's
license detector and downstream consumers key off of. We do **not** mass-add
headers to existing files and we do **not** rewrite git history to backfill
them.

If you want to mark a specific new file (for example, one you expect to be
copied out of the repo on its own), add the SPDX short-form header as the first
line, using the file's comment syntax:

```ts
// SPDX-License-Identifier: Apache-2.0
```

```jsx
// SPDX-License-Identifier: Apache-2.0
```

```sh
# SPDX-License-Identifier: Apache-2.0
```

Rules:

- Use the exact SPDX identifier `Apache-2.0` — no other spelling.
- The header is a courtesy marker; its absence never means a file is
  unlicensed. Everything in this repo is covered by the root `LICENSE`.
- Do not add a full copyright/boilerplate block to each file. The identifier
  line is enough; the canonical text stays in `LICENSE`.
- Never run a codemod that rewrites headers across the tree or amends past
  commits to insert them.

## Third-party code

Dependencies keep their own licenses (declared in their own `package.json` /
`node_modules`). Apache-2.0 does not relicense them. When vendoring third-party
source directly into the tree, preserve its original license header and record
the origin in `NOTICE`.
