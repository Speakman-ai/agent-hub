# Licensing

Agent Hub is source-available under the **PolyForm Noncommercial License
1.0.0**, granted by **Ryan Speakman** (GitHub `speakmanra`). The complete legal
terms live in [`LICENSE`](../LICENSE) and
[`LICENSES/PolyForm-Noncommercial-1.0.0.txt`](../LICENSES/PolyForm-Noncommercial-1.0.0.txt),
with the project's required attribution in [`NOTICE`](../NOTICE).

This summary is for convenience only. The license text governs.

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

Commercial use of Agent Hub requires a separate commercial license from
Ryan Speakman. That includes using Agent Hub as part of a for-profit company's
work, regardless of company size, and offering a product, hosted service, or
other business built on it. Contact Ryan Speakman through
[GitHub](https://github.com/Speakman-ai/agent-hub) to discuss commercial terms.

## Licensor and relicensing authority

**Licensor.** Ryan Speakman, the natural person who controls GitHub account
`speakmanra`, is the identified licensor. That person is the counterparty on
[CLA.md](../CLA.md) and the person who grants commercial licenses.

PolyForm Noncommercial is the outbound public grant. It is not an inbound
contributor agreement, and it does not by itself give the Licensor commercial
relicensing rights in a third-party contribution — contributors retain
copyright in their contributions.

To keep the advertised commercial license possible for the combined work, new
code contributions are accepted only after the contributor completes the
[Contributor License Agreement](../CLA.md), or a written copyright assignment
to the Licensor. The CLA is the sublicensable inbound grant that lets the
Licensor offer both the public noncommercial license and a separate commercial
license. Maintainers must not merge a contribution that adds or changes
copyrightable material without a completed CLA or assignment on file. See
[CONTRIBUTING](../CONTRIBUTING.md).

An AI system cannot be an author, cannot hold copyright, and cannot complete
the CLA (see _Thaler v. Perlmutter_ and the US Copyright Office 2025 AI
report). Where a contribution was produced with an AI agent, the human
copyright holder of any original human-authored elements completes the CLA;
purely machine-determined material is not copyrightable.

## Source-header policy

**Per-file SPDX short-form headers are optional, not required.**

The top-level `LICENSE` file, the text in `LICENSES/`, and the `license` field
in each workspace's `package.json` (`PolyForm-Noncommercial-1.0.0`) establish
the license for the repository. We do not mass-add headers to existing files or
rewrite history to backfill them.

For a new file that is likely to be copied from the repository on its own, you
may add the PolyForm SPDX identifier with the file's comment syntax:

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
without a header are covered by the top-level `LICENSE`.

## Notices and redistribution

Anyone distributing any part of Agent Hub must provide the PolyForm terms or
their URL and preserve every plain-text line beginning with `Required Notice:`.
The canonical required notice is present in both `LICENSE` and `NOTICE`.

## Third-party code

Dependencies and vendored third-party code keep their own licenses. Agent Hub's
license does not relicense them. Preserve original license headers and record
the origin in `NOTICE` when vendoring third-party source.
