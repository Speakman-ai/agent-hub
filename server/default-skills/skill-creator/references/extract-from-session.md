# Extract a skill from a session transcript

This is the **"Turn this session into a skill"** flow (Skill Builder Phase 4).
Instead of interviewing a user from scratch, you are handed a *finished
session's transcript* and asked to mine a reusable skill out of the real work.
The host boots you with the transcript embedded in the kickoff prompt and the
source session id bound. Implements **"extract, don't invent"** — a procedure
someone actually did generalizes better than one you imagine.

## What you are doing differently

The normal loop (capture → interview → draft → confirm → save) still applies,
but the **first two phases come mostly from the transcript, not the user.** You
read the work that happened and reconstruct the interview answers from it. You
only ask the user the handful of things the transcript leaves genuinely
ambiguous.

## What to mine for

Read the whole transcript and look for the signal that a reusable capability is
hiding in it:

- **Repeated context.** Facts, conventions, file paths, gotchas, or
  environment details the user had to explain more than once because the agent
  kept missing them. Repetition is the loudest signal that something belongs in
  a skill — it is exactly the context you want loaded automatically next time.
- **Stable procedures.** A sequence of steps that was followed to reach a
  result and is likely to recur: a setup walkthrough, a specific query/API call
  shape, a release or review checklist, a data-massaging recipe.
- **Trigger phrases.** How the user actually asked for the thing, in their own
  words. These become the heart of the pushy `description` — use the real
  phrasing, not a sanitized paraphrase.
- **Success criteria.** What "done/correct" looked like in the transcript. Keep
  it for the eval loop (Phase 3) even though extraction itself does not run
  evals.

## When NOT to make a skill

If the transcript is a one-off with nothing generalizable — pure debugging of a
single incident, a question answered once, throwaway exploration — **say so and
stop.** Do not fabricate a skill to have an output. A bad skill that
over-triggers is worse than no skill: it pollutes every future agent's context.
Tell the user what you looked for and why nothing repeatable surfaced.

## The flow

1. **Extract the candidate in one sentence.** State the capability you see and
   name the repeated context/procedure it came from ("you re-explained the
   staging deploy steps three times — that's the skill"). This grounds the user
   in *why* this is worth capturing.
2. **Reconstruct the interview from the transcript.** Pull capability, triggers,
   inputs/outputs, and success criteria out of what you read. Only ask the user
   the one or two genuinely ambiguous things (slug name, category) — use an
   `agenthub:ask` picker for those enumerable choices.
3. **Draft a lean `SKILL.md`** with your normal authoring rules: pushy
   `description` (what + when, real trigger phrases, a "DO NOT TRIGGER on…"
   clause), body well under 500 lines, explain-the-why over ALL-CAPS,
   progressive disclosure of deep material to `references/`. Show the draft for
   review before saving — walk the user through the `description` specifically.
4. **Save on confirmation** via the Phase 1 write API
   (`POST /api/projects/$PROJECT_ID/skills`, or `PUT …/skills/:id` to update an
   existing slug) through `ah-api.sh`. Same response handling as the normal save
   step (201/200 saved, 409 duplicate/shadow, 400 validation).
5. **Offer to test it.** Suggest the Phase 3 eval loop (with-skill vs. baseline)
   so the user sees the extracted skill actually changes behavior before relying
   on it, and refine the `description` if it under- or over-fires.

## Truncated transcripts

Very long sessions are trimmed (head + tail kept, middle dropped) before they
reach you; the prompt flags this when it happens. Extract from what is present.
If a procedure looks cut off at the trim boundary, ask the user for the missing
steps rather than guessing them into the skill.
