---
name: design
description: >-
  Design Studio — a singleton Claude-Design-style canvas where the agent writes
  HTML/CSS/JS files into an artifact directory that renders live in an iframe.
  Loaded automatically inside Design sessions; do not trigger it anywhere else.
  TRIGGER when: the session is in design mode (`session_mode === 'design'`), or
  the legacy Design Studio path applies (cwd IS the design artifact directory and
  the system prompt identifies you as "Design Studio").
  DO NOT TRIGGER on normal project chats, conference rooms, or anywhere a
  regular agent is active — designs are their own session type.
version: 1.1.0
---

# Design Studio

You are in a **Design session**: your only job is to build self-contained
HTML/CSS/JS prototypes that render live in the Agent Hub canvas.

## Where artifacts go (read this first)

The artifact location depends on how the session was started. The system-prompt
preamble for the turn is authoritative — follow it over this section if they
disagree.

- **Design mode (current model — `session_mode === 'design'`):** the session
  runs in an ordinary git worktree. Write every design file under the
  **`design/` subdirectory** of your working directory (the worktree root). The
  canonical entry point is **`design/index.html`**. Keeping artifacts in the
  worktree is what lets a flip to Build mode pick them up for free — same
  checkout, no copy step. This is a normal session: commit, test, and Finalize
  as usual.
- **Legacy Design Studio (`__design_studio__` singleton):** your cwd IS the
  design's artifact directory (`<dataDir>/designs/<designId>/`); write directly
  at the cwd root with entry point `index.html`, rendered via
  `/design-files/<designId>/index.html`.

In both cases the canvas reloads on each assistant turn, so the user sees your
changes as soon as the turn ends.

## Working rules

1. **Use your normal Write / Edit / Read tools.** There is no special
   protocol — just write files in the artifact location described above. Every
   assistant turn reloads the canvas, so the user sees your changes as soon as
   the turn ends.
2. **Keep the prototype self-contained.** Prefer vanilla HTML + CSS + a
   single JS file. When you need a library, pull it from one of the
   allowlisted CDNs:
   - `https://cdn.tailwindcss.com`
   - `https://unpkg.com`
     Do **not** reach for npm install, bundlers, or a build step — the iframe
     loads the files directly.
3. **One design per artifact root.** Don't create sibling designs or drop
   files outside the artifact location (the `design/` subdir in design mode, or
   the cwd in legacy Design Studio). The canvas mount is scoped to that root;
   anything outside it is unreachable from the canvas.
4. **Design sessions are single-agent.** There is no sub-agent dispatch
   block; anything of that shape leaks into the transcript unparsed. If you
   hit a wall, ask the user in prose.
5. **Respect linked-project design tokens.** The system prompt lists any
   projects linked to this design and concatenates their `DESIGN_SYSTEM.md`
   (or `SOUL.md` as a fallback). Extract colors, type scale, spacing, and
   component conventions from those docs into your layout instead of
   inventing a new language.

## File layout conventions

All paths below are relative to the artifact root — `design/` in design mode,
the cwd in legacy Design Studio (so in design mode `index.html` means
`design/index.html`):

- `index.html` — entry, mandatory.
- `styles.css` — optional; link from `index.html`.
- `app.js` — optional; link from `index.html`.
- Assets (`images/`, `icons/`) live alongside these files. Reference them
  with relative paths so the canvas loads them through the same static mount.

## When you're unsure

Ask the user. Design work is iterative — short prompts, fast feedback. Don't
burn a whole turn guessing at intent when a one-line clarification saves a
redesign.
