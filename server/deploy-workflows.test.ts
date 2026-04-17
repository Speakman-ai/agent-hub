import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Guards the SSM deploy workflows against regressing to the broken
 * `--parameters "commands=[...]"` shorthand form.
 *
 * Background: `jq -Rs .` encodes newlines as literal `\n` inside a JSON string.
 * The AWS CLI shorthand `--parameters` parser does NOT decode those `\n`
 * escapes — only `--cli-input-json` and `file://` inputs do. The result is
 * that the entire deploy script is delivered to SSM as a single line with
 * literal backslash-n characters, and the remote shell errors on the first
 * `(` it encounters (e.g. `_script.sh: 1: Syntax error: "(" unexpected`).
 *
 * The workaround is to serialize the parameters to a JSON file and pass it as
 * `--parameters file://…`, which DOES decode `\n` into real newlines.
 *
 * See the failed run (24585644691) that motivated this fix.
 */

const repoRoot = join(__dirname, '..');

function readWorkflow(name: string): string {
  return readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

const WORKFLOWS = ['deploy-dev.yml', 'release-prod.yml'] as const;

describe('SSM deploy workflows', () => {
  for (const wf of WORKFLOWS) {
    describe(wf, () => {
      const content = readWorkflow(wf);

      it('does not use the broken `commands=[...]` shorthand with jq -Rs', () => {
        // Matches either ordering of the broken pattern:
        //   --parameters "commands=[$(jq -Rs . <<< "$…")]"
        //   --parameters 'commands=[…jq -Rs …]'
        // Shorthand `commands=[` is the red flag — any send-command call that
        // uses it alongside a jq-serialized script will strip newlines.
        const brokenShorthand = /--parameters\s+["']?commands=\[/;
        expect(
          brokenShorthand.test(content),
          `${wf} re-introduced the SSM shorthand --parameters "commands=[...]" form, which ` +
            `does not decode \\n escapes. Use --parameters file://… with a JSON file instead.`,
        ).toBe(false);
      });

      it('passes SSM parameters via a file:// JSON document', () => {
        // Every `aws ssm send-command` in the workflow should be paired with
        // a `--parameters file://…` or `--cli-input-json` approach. We assert
        // at least one `file://` params reference exists per workflow that
        // calls send-command.
        if (/aws ssm send-command/.test(content)) {
          expect(
            /--parameters\s+["']?file:\/\//.test(content),
            `${wf} calls aws ssm send-command but does not pass --parameters via file://. ` +
              `This is required because shorthand does not honor JSON \\n escapes.`,
          ).toBe(true);
        }
      });

      it('wraps the deploy script with jq -Rs into {commands:[...]} JSON', () => {
        // Defensive: the payload must still be valid SSM input. The canonical
        // shape is `jq -Rs '{commands: [.]}'` piped to a file that --parameters
        // reads via file://.
        if (/aws ssm send-command/.test(content)) {
          expect(
            /jq\s+-Rs\s+'?\{\s*commands\s*:\s*\[\s*\.\s*\]\s*\}'?/.test(content),
            `${wf} should build SSM params with \`jq -Rs '{commands: [.]}'\` so the script ` +
              `is delivered as a single JSON string with real newlines.`,
          ).toBe(true);
        }
      });
    });
  }
});
