# Licensing

Agent Hub is mixed-license. First-party works owned by **Ryan Speakman**
(GitHub `speakmanra`) are source-available under the
**PolyForm Noncommercial License 1.0.0**. Unverified contributions remain
under Apache License 2.0. The complete legal terms live in
[`LICENSE`](../LICENSE),
[`LICENSES/PolyForm-Noncommercial-1.0.0.txt`](../LICENSES/PolyForm-Noncommercial-1.0.0.txt),
and [`LICENSES/Apache-2.0.txt`](../LICENSES/Apache-2.0.txt),
with the project's required attribution in
[`NOTICE`](../NOTICE).

This summary is for convenience only. The license texts and the
authoritative mapping below govern. Package manifests declare
`SEE LICENSE IN LICENSE` because the distributable packages are mixed;
they are not PolyForm-only.

## Permitted without a commercial license

PolyForm Noncommercial permits noncommercial use, modification, and
distribution. It specifically permits qualifying personal research,
experimentation, study, entertainment, hobby, amateur, and religious uses
without an anticipated commercial application.

It also permits use by charitable organizations, educational institutions,
public research organizations, public safety or health organizations,
environmental protection organizations, and government institutions,
regardless of their funding.

## Commercial use

Commercial use of works covered by PolyForm Noncommercial requires a separate
commercial license from Ryan Speakman. That includes using those works as part
of a for-profit company's work, regardless of company size, and offering a
product, hosted service, or other business built on them. Contact Ryan Speakman
through
[GitHub](https://github.com/Speakman-ai/agent-hub) to discuss commercial terms.

This requirement does not apply to contributions that remain under Apache
License 2.0. Recipients keep the commercial rights Apache already grants for
those contributions. See "Unverified contributions stay under Apache-2.0"
below.

## Copyright holders and relicensing authority

**Licensor.** Ryan Speakman, the natural person who controls GitHub account
`speakmanra`, is the identified licensor. That person is the counterparty
on [CLA.md](../CLA.md) and the person who grants commercial licenses for
PolyForm-covered works.

PolyForm Noncommercial 1.0.0 in `LICENSE` is the outbound grant from
Ryan Speakman for first-party works that person has authority to license.
It is not a claim that every byte in the tree has a single proven copyright
owner.

Apache License 2.0 is a copyright license, not a copyright assignment.
Contributors retain copyright in their contributions. Changing the outbound
license of existing work to a more restrictive license requires a grant from
each copyright holder of that work. GitHub org ownership, collaborator
status, contributor lists, pull-request authors, and project-controlled
commit identities do not transfer copyright and do not prove copyright ownership.

### Chain of title the licensor claims

1. **Identified human author.** The only natural-person git Author identity in
   first-party history is GitHub account `speakmanra` (Ryan Speakman). That
   person is the licensor for this change and applies PolyForm to works they
   own.

2. **Own copyright, prospective grant.** The licensor may relicense their own
   copyright in the current tree. Previously published Apache-2.0 versions
   keep those terms; that grant is not revoked.

3. **Agent identities cannot hold or assign copyright.** Synthetic commit
   authors (`Agent Hub`, `Hub Lead Dev`, `agent-hub-release-bot`, in-session
   agent ids, and similar) are not natural persons. US copyright law requires
   human authorship (see *Thaler v. Perlmutter* and the US Copyright Office
   2025 AI report). An AI cannot be an author, cannot own copyright, and
   cannot assign it. Accepting an agent-authored commit into the repository
   is not a copyright assignment.

   For agent-produced material:
   - To the extent a human determined sufficient expressive elements
     (original human-authored text, or creative selection, arrangement, or
     modification), the identified human author claims copyright in those
     elements.
   - To the extent material is purely machine-determined, it is not
     copyrightable, and this relicense does not create exclusive rights in it.

4. **Contribution-source inventory (not a chain of title).** A 2026-08-26
   inventory of the public GitHub repository `Speakman-ai/agent-hub` found
   one human GitHub account (`speakmanra`) on the contributors list,
   collaborators list, and public pull-request authors, and no outside human
   contributor email on git Author lines (project-controlled identities
   only). That inventory is evidence of who appeared in git and GitHub
   metadata. It is not proof that the maintainer owns copyright in every
   contribution.

New code contributions intended for the commercially licensed product are
accepted only after the contributor completes the Contributor License
Agreement in [CLA.md](../CLA.md), or a copyright assignment to the licensor.
PolyForm Noncommercial is the outbound public grant. It is
not an inbound contributor agreement and does not give the licensor
commercial relicensing rights in a third-party contribution. Contributors
still retain copyright; the CLA is the sublicensable inbound grant that
makes the advertised commercial license possible for the combined work.
Maintainers must not merge such a contribution without a completed CLA or
assignment on file. See [CONTRIBUTING](../CONTRIBUTING.md).

### Authoritative license mapping

This mapping is the project's statement of which terms apply to which
material. It is not a substitute for the license texts.

| Material | Terms |
| --- | --- |
| First-party source owned by Ryan Speakman in the current tree | PolyForm Noncommercial 1.0.0 |
| Git history and releases previously distributed under Apache-2.0 | Apache License 2.0 (that grant is not revoked) |
| Unverified contributions (see below) | Apache License 2.0 |
| Third-party dependencies and vendored code | Their original licenses |

**Contribution-level inventory (2026-08-26 public GitHub repository
`Speakman-ai/agent-hub`):**

| Contribution source | Terms |
| --- | --- |
| Human GitHub account `speakmanra` (Ryan Speakman) as contributor, collaborator, and public pull-request author | PolyForm Noncommercial 1.0.0 for works that person owns |
| Named outside human contributors on the contributors list, collaborators list, public pull-request authors, or non-project-controlled git Author emails | None found |
| Synthetic commit authors (`Agent Hub`, `Hub Lead Dev`, `agent-hub-release-bot`, in-session agent ids, and similar) | Not copyright holders. Human-authored elements claimed by Ryan Speakman to the extent of original human authorship. Purely machine-determined material is not copyrightable. Unidentified human remainder stays Apache-2.0. |

**File-level rule.** A per-file `SPDX-License-Identifier` header, where
present, is authoritative for that file. Files without a header follow this
mapping. No current-tree path is presently identified as belonging solely
to a copyright holder other than Ryan Speakman. The Apache-2.0 remainder in
the current tree is therefore a residual category (unidentified human text
later committed under an agent identity, third-party material copied without
a separate license record, or an Apache-era contribution later shown to have
a different copyright holder). Recipients cannot be given a complete path
list for that residual category because it is defined by copyright holder,
not by path. If you hold copyright in a specific file, that file remains
under Apache-2.0; contact Ryan Speakman through
[GitHub](https://github.com/Speakman-ai/agent-hub) to record it.

**Distributable packages.** The workspace packages (`agent-hub`,
`agent-hub-server`, `agent-hub-client`, `agent-hub-mobile`,
`@agent-hub/shared`) contain mixed material. Their `package.json` `license`
field is `SEE LICENSE IN LICENSE`, not a PolyForm-only SPDX identifier. A
recipient of those packages must follow this mapping, not treat the package
as PolyForm-only.

### Unverified contributions stay under Apache-2.0

Any contribution whose copyright holder is not Ryan Speakman remains
under Apache License 2.0. That includes:

- an unidentified human who authored text later committed under an agent
  identity
- third-party material copied into the tree without a separate license record
- any Apache-era contribution later shown to have a different copyright holder

This relicense does not apply to those contributions. Recipients keep the
Apache-2.0 rights already granted for them. The Apache License 2.0 text is at
[`LICENSES/Apache-2.0.txt`](../LICENSES/Apache-2.0.txt).

If you hold copyright in a contribution and believe it was included without
your grant of PolyForm terms, that contribution remains under Apache-2.0.
Contact the maintainer through
[GitHub](https://github.com/Speakman-ai/agent-hub).

## Previous Apache-2.0 versions

This change is prospective. Releases and commits that Agent Hub distributed
under Apache-2.0 remain available under those terms; the new license does not
revoke rights already granted for those versions.

The Apache License 2.0 text as previously published at the repo root is kept
at [`LICENSES/Apache-2.0.txt`](../LICENSES/Apache-2.0.txt). `NOTICE` retains
the Apache-era attribution lines (`Copyright 2026 The Agent Hub Authors` and
"This product includes software developed by the Agent Hub project and its
contributors") in addition to the PolyForm required notice.

## Source-header policy

**Per-file SPDX short-form headers are optional, not required.**

The mapping in this document, the top-level `LICENSE` file, the texts in
`LICENSES/`, and the `license` field in each workspace's `package.json`
(`SEE LICENSE IN LICENSE`) establish the license for the repository. We do
not mass-add headers to existing files or rewrite history to backfill them.

For a new first-party file owned by Ryan Speakman that is likely to be
copied from the repository on its own, use the PolyForm SPDX identifier
with the file's comment syntax:

```ts
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
```

```jsx
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
```

```sh
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
```

The absence of a per-file header does not mean a file is unlicensed. Files
without a header follow the authoritative mapping above. The root `LICENSE`
is not a claim that every file is PolyForm-only.

## Notices and redistribution

Anyone distributing any part of Agent Hub must provide the PolyForm terms or
their URL and preserve every plain-text line beginning with
`Required Notice:`. The canonical required notice is present in both
`LICENSE` and `NOTICE`.

## Third-party code

Dependencies and vendored third-party code keep their own licenses. Agent
Hub's license does not relicense them. Preserve original license headers and
record the origin in `NOTICE` when vendoring third-party source.
