import Database from 'better-sqlite3';
import {
  collectSessionShellCommands,
  extractSessionRanTests,
  headPathLookupFromFiles,
  shellCommandFromPayload,
  tokenizeShell,
  sessionRanTestPaths,
  type SessionShellCommand,
} from './session-ran-tests.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clampPayload } from '../session-events-store.js';

const ROOT = '/work/session-abc';

const HEAD_FILES = [
  'package.json',
  'server/package.json',
  'server/finalize/test-inventory.ts',
  'server/finalize/test-inventory.test.ts',
  'server/finalize/session-ran-tests.test.ts',
  'server/routes/sessions.test.ts',
  'client/src/utils/humanCron.test.ts',
  'client/src/App.test.tsx',
  'e2e/tests/login.spec.ts',
  'e2e/tests/kanban/board.spec.ts',
  'cypress/e2e/checkout.cy.ts',
  'cypress/e2e/cart.cy.ts',
  'py/tests/test_api.py',
  'py/tests/unit/test_models.py',
  'spec/models/user_spec.rb',
  'spec/requests/api_spec.rb',
  'go/pkg/store/store.go',
  'go/pkg/store/store_test.go',
  'go/cmd/main.go',
  'client/package.json',
  // Identical relative test paths in different packages of a pnpm workspace.
  'pnpm-workspace.yaml',
  'src/x.test.ts',
  'pkgs/a/package.json',
  'pkgs/a/src/x.test.ts',
  'pkgs/b/package.json',
  'pkgs/b/src/x.test.ts',
];

const exists = headPathLookupFromFiles(HEAD_FILES);

function run(commands: Array<string | SessionShellCommand>) {
  return extractSessionRanTests(
    commands.map((c) => (typeof c === 'string' ? { command: c } : c)),
    { repoRoot: ROOT, exists },
  ).map((r) => `${r.kind}:${r.path}`);
}

describe('extractSessionRanTests', () => {
  const cases: Array<[string, string | Array<string | SessionShellCommand>, string[]]> = [
    // vitest
    [
      'vitest via npx in a cd prefix',
      'cd server && npx vitest run finalize/test-inventory.test.ts',
      ['file:server/finalize/test-inventory.test.ts'],
    ],
    [
      'absolute cd into the worktree',
      `cd ${ROOT}/server && npx vitest finalize/test-inventory.test.ts 2>&1 | tail -40`,
      ['file:server/finalize/test-inventory.test.ts'],
    ],
    [
      'vitest with a directory arg',
      'cd server && npx vitest run finalize',
      ['dir:server/finalize'],
    ],
    ['vitest name filter adds nothing', 'cd server && npx vitest run -t "parses junit"', []],
    [
      'vitest substring filter that is not a path',
      'cd server && npx vitest run session-events',
      [],
    ],
    ['vitest bare suite run', 'cd server && npx vitest run', []],
    ['vitest "." is the bare suite', 'cd server && npx vitest run .', []],
    [
      'vitest related takes source files',
      'cd server && npx vitest related finalize/test-inventory.ts',
      [],
    ],
    [
      'node_modules bin with env prefix and timeout',
      'cd client && CI=1 timeout 600 ./node_modules/.bin/vitest run src/App.test.tsx src/utils/humanCron.test.ts',
      ['file:client/src/App.test.tsx', 'file:client/src/utils/humanCron.test.ts'],
    ],
    [
      'vitest --root bounds discovery and does not rebase filters',
      'npx vitest run --root client src/App.test.tsx',
      [],
    ],
    [
      'repo-relative path from the root',
      'npx vitest run server/routes/sessions.test.ts',
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'file that does not exist at head',
      'cd server && npx vitest run finalize/deleted.test.ts',
      [],
    ],
    [
      '--reporter value is not a path',
      'cd server && npx vitest run --reporter verbose finalize/session-ran-tests.test.ts',
      ['file:server/finalize/session-ran-tests.test.ts'],
    ],
    ['glob args add nothing', 'cd server && npx vitest run "finalize/*.test.ts"', []],
    [
      'expanded args add nothing',
      'cd server && npx vitest run $FILE "$(git diff --name-only)"',
      [],
    ],
    // npm / pnpm / yarn wrappers
    [
      'npm test -- file',
      'cd server && npm test -- routes/sessions.test.ts',
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'npm run test script with a name filter',
      'npm run test:server -- -t "foo" server/routes/sessions.test.ts',
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'npm --prefix',
      'npm --prefix server test -- routes/sessions.test.ts',
      ['file:server/routes/sessions.test.ts'],
    ],
    ['npm run non-test script', 'npm run lint -- server/routes/sessions.test.ts', []],
    [
      'pnpm exec vitest',
      'pnpm -C client exec vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'pnpm vitest bin',
      'cd client && pnpm vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'yarn --cwd jest',
      'yarn --cwd client jest src/App.test.tsx --coverage',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'yarn test script',
      'cd client && yarn test src/utils/humanCron.test.ts',
      ['file:client/src/utils/humanCron.test.ts'],
    ],
    // jest
    [
      'jest with a name filter value',
      'npx jest -t "renders" client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'jest --findRelatedTests adds nothing',
      'npx jest --findRelatedTests client/src/App.test.tsx',
      [],
    ],
    // pytest
    [
      'pytest node ids',
      'cd py && pytest tests/test_api.py::TestApi::test_get -x -k "get"',
      ['file:py/tests/test_api.py'],
    ],
    ['python -m pytest dir', 'python3 -m pytest py/tests/unit -q', ['dir:py/tests/unit']],
    ['uv run pytest', 'uv run pytest py/tests/test_api.py', ['file:py/tests/test_api.py']],
    ['pytest -k only', 'pytest -k test_api', []],
    // go
    ['go test package dir', 'cd go && go test -run TestStore ./pkg/store/', ['dir:go/pkg/store']],
    ['go test recursive pattern', 'cd go && go test -v -count=1 ./pkg/...', ['dir:go/pkg']],
    ['go test ./... is the bare suite', 'cd go && go test ./...', []],
    ['go test -C', 'go test -C go ./pkg/store', ['dir:go/pkg/store']],
    [
      'go test file args keep only test files',
      'cd go/pkg/store && go test store_test.go store.go',
      ['file:go/pkg/store/store_test.go'],
    ],
    // rspec
    [
      'bundle exec rspec with line numbers',
      "bundle exec rspec spec/models/user_spec.rb:42 'spec/requests/api_spec.rb[1:2]'",
      ['file:spec/models/user_spec.rb', 'file:spec/requests/api_spec.rb'],
    ],
    [
      'bin/rspec with an example filter',
      'bin/rspec -e "creates a user" spec/models',
      ['dir:spec/models'],
    ],
    // playwright
    [
      'playwright test file:line',
      'npx playwright test e2e/tests/login.spec.ts:12 --workers 2',
      ['file:e2e/tests/login.spec.ts'],
    ],
    ['playwright grep adds nothing', 'npx playwright test -g "login"', []],
    [
      'playwright from the e2e dir',
      'cd e2e && npx playwright test tests/kanban --workers 1',
      ['dir:e2e/tests/kanban'],
    ],
    [
      'playwright show-report is not a run',
      'npx playwright show-report e2e/tests/login.spec.ts',
      [],
    ],
    // cypress
    [
      'cypress run --spec list',
      'npx cypress run --spec cypress/e2e/checkout.cy.ts,cypress/e2e/cart.cy.ts --browser chrome',
      ['file:cypress/e2e/cart.cy.ts', 'file:cypress/e2e/checkout.cy.ts'],
    ],
    ['cypress --spec= glob adds nothing', 'npx cypress run --spec="cypress/e2e/**/*.cy.ts"', []],
    ['cypress open adds nothing', 'npx cypress open --spec cypress/e2e/cart.cy.ts', []],
    // shell shapes
    [
      'bash -lc wrapper (codex)',
      `/bin/bash -lc 'cd server && npx vitest run routes/sessions.test.ts'`,
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'bg.sh start runs in the worktree root',
      'cd client && bg.sh start --label "tests" npx vitest run server/routes/sessions.test.ts',
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'subshell cd does not leak',
      '(cd server && npx vitest run routes/sessions.test.ts) && npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx', 'file:server/routes/sessions.test.ts'],
    ],
    [
      'several commands joined by ; and ||',
      'cd server; npx vitest run routes/sessions.test.ts || echo failed',
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'multi-line script',
      'cd server\nnpx vitest run \\\n  routes/sessions.test.ts',
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'here-document body is data, not commands',
      "cat <<'EOF'\nnpx vitest run server/routes/sessions.test.ts\nEOF",
      [],
    ],
    [
      'commands after a here-document still count',
      'cat > notes.txt <<EOF\nnpx vitest run server/routes/sessions.test.ts\nEOF\nnpx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      '<<- here-document with a tab-indented delimiter',
      'cat <<-EOF\n\tnpx vitest run server/routes/sessions.test.ts\n\tEOF\nnpx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'two here-documents on one line',
      'cat <<A <<B\nnpx vitest run server/routes/sessions.test.ts\nA\nnpx jest client/src/App.test.tsx\nB\nnpx vitest run client/src/utils/humanCron.test.ts',
      ['file:client/src/utils/humanCron.test.ts'],
    ],
    [
      'unterminated here-document is unparseable',
      'npx vitest run client/src/App.test.tsx\ncat <<EOF\nnpx vitest run server/routes/sessions.test.ts',
      [],
    ],
    [
      'here-string is not a here-document',
      'cat <<< hi && npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'env -C moves only its child',
      'env -C client npx vitest run src/App.test.tsx; npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'env -C cwd does not escape the wrapper',
      'env -C client true; npx vitest run src/App.test.tsx',
      [],
    ],
    [
      'env -C cwd does not carry into the next command',
      ['env -C client true', 'npx vitest run src/App.test.tsx'],
      [],
    ],
    ['trailing && has no right operand', 'npx vitest run client/src/App.test.tsx &&', []],
    ['trailing || has no right operand', 'npx vitest run client/src/App.test.tsx ||', []],
    ['trailing pipe has no right operand', 'npx vitest run client/src/App.test.tsx |', []],
    ['leading operator', '&& npx vitest run client/src/App.test.tsx', []],
    ['leading semicolon', '; npx vitest run client/src/App.test.tsx', []],
    ['doubled operator', 'npx vitest run client/src/App.test.tsx && && echo ok', []],
    ['pipe straight after ||', 'npx vitest run client/src/App.test.tsx || | cat', []],
    ['unmatched open paren', '(npx vitest run client/src/App.test.tsx', []],
    ['unmatched close paren', 'npx vitest run client/src/App.test.tsx)', []],
    ['empty subshell', '() && npx vitest run client/src/App.test.tsx', []],
    ['word after a closing paren', '(cd client) npx vitest run src/App.test.tsx', []],
    ['paren inside a command', 'npx vitest run client/src/App.test.tsx (x)', []],
    ['case terminator outside case', 'npx vitest run client/src/App.test.tsx;;', []],
    ['redirection with no target at the end', 'npx vitest run client/src/App.test.tsx >', []],
    ['redirection followed by an operator', 'npx vitest run client/src/App.test.tsx > ; echo', []],
    ['two redirections in a row', 'npx vitest run client/src/App.test.tsx > > log', []],
    [
      'unterminated command substitution',
      'echo $(date && npx vitest run client/src/App.test.tsx',
      [],
    ],
    [
      'unterminated parameter expansion',
      'echo ${HOME && npx vitest run client/src/App.test.tsx',
      [],
    ],
    ['unterminated backtick', 'echo `date && npx vitest run client/src/App.test.tsx', []],
    ['if compound', 'if true; then npx vitest run client/src/App.test.tsx; fi', []],
    ['for loop', 'for f in a; do npx vitest run client/src/App.test.tsx; done', []],
    ['brace group', '{ npx vitest run client/src/App.test.tsx; }', []],
    ['negated pipeline', '! npx vitest run client/src/App.test.tsx', []],
    ['malformed script inside bash -c', "bash -c 'npx vitest run client/src/App.test.tsx &&'", []],
    [
      'malformed script inside bg.sh start',
      "bg.sh start 'npx vitest run client/src/App.test.tsx |'",
      [],
    ],
    [
      '&& continued on the next line',
      'npx vitest run client/src/App.test.tsx &&\n  echo done',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'pipe and fd redirection',
      'npx vitest run client/src/App.test.tsx 2>&1 | tee log',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'redirections and background',
      'npx vitest run client/src/App.test.tsx > log 2>&1 &',
      ['file:client/src/App.test.tsx'],
    ],
    [
      '&> and >| redirections',
      'npx vitest run client/src/App.test.tsx &> log; echo hi >| other',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'parameter expansion elsewhere',
      'echo ${HOME:-a b} && npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'redirected subshell',
      '(cd client && npx vitest run src/App.test.tsx) > out.log',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'subshell ending with a separator',
      '(npx vitest run client/src/App.test.tsx;)',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'here-document continued with &&',
      'cat <<EOF &&\nnpx vitest run server/routes/sessions.test.ts\nEOF\nnpx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['cd with too many arguments fails', 'cd client server && npx vitest run src/App.test.tsx', []],
    [
      'cd in a pipeline stays in its subshell',
      'cd client | cat; npx vitest run src/App.test.tsx',
      [],
    ],
    [
      'root still resolves after a piped cd',
      'cd client | cat; npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'cd in a background job stays in its subshell',
      'cd client & wait; npx vitest run src/App.test.tsx',
      [],
    ],
    [
      'pipeline ending in cd before &&',
      'echo hi | cd client && npx vitest run src/App.test.tsx',
      [],
    ],
    ['cd in a subshell stays there', '(cd client); npx vitest run src/App.test.tsx', []],
    [
      'cd under timeout runs in a child',
      'timeout 5 cd client; npx vitest run src/App.test.tsx',
      [],
    ],
    ['cd under nohup runs in a child', 'nohup cd client; npx vitest run src/App.test.tsx', []],
    [
      'cd under bundle exec runs in a child',
      'bundle exec cd client; npx vitest run src/App.test.tsx',
      [],
    ],
    [
      'command cd runs in the current shell',
      'command cd client && npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'cd on the right of || may not have run',
      'npx vitest run x || cd client; npx vitest run src/App.test.tsx',
      [],
    ],
    ['cd after a command that may fail', 'false && cd client; npx vitest run src/App.test.tsx', []],
    [
      '|| after a cd that cannot fail never runs',
      'cd client || cd server; npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      '|| right side is skipped when the left cannot fail',
      'true || npx vitest run client/src/App.test.tsx',
      [],
    ],
    [
      'cd to a dir missing at head makes the cwd unknown',
      'cd nope; npx vitest run client/src/App.test.tsx',
      [],
    ],
    ['popd makes the cwd unknown', 'pushd client && popd; npx vitest run src/App.test.tsx', []],
    [
      'piped cd does not carry into the next command',
      ['cd client | cat', 'npx vitest run src/App.test.tsx'],
      [],
    ],
    [
      'background cd does not carry into the next command',
      ['cd client &', 'npx vitest run src/App.test.tsx'],
      [],
    ],
    [
      'subshell cd does not carry into the next command',
      ['(cd client)', 'npx vitest run src/App.test.tsx'],
      [],
    ],
    [
      'uncertain cd carries as unknown',
      ['npx vitest run x || cd client', 'npx vitest run client/src/App.test.tsx'],
      [],
    ],
    [
      'unparseable command leaves the cwd unknown',
      ['cd client; if true; then cd ..; fi', 'npx vitest run src/App.test.tsx'],
      [],
    ],
    [
      'absolute cd recovers an unknown cwd',
      ['cd "$DIR"', 'cd /work/session-abc && npx vitest run client/src/App.test.tsx'],
      ['file:client/src/App.test.tsx'],
    ],
    [
      'bare cd goes home, which resets to the root next command',
      ['cd', 'npx vitest run client/src/App.test.tsx'],
      ['file:client/src/App.test.tsx'],
    ],
    ['command -v only describes', 'command -v vitest client/src/App.test.tsx', []],
    ['command -V only describes', 'command -V npx vitest run client/src/App.test.tsx', []],
    [
      'command -p runs',
      'command -p npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['bash -n only checks syntax', "bash -n -c 'npx vitest run client/src/App.test.tsx'", []],
    ['bash -nc only checks syntax', "bash -nc 'npx vitest run client/src/App.test.tsx'", []],
    ['sh -e is an unmodeled mode', "sh -ec 'npx vitest run client/src/App.test.tsx'", []],
    [
      'bash without -c runs a script file',
      'bash run-tests.sh npx vitest run client/src/App.test.tsx',
      [],
    ],
    [
      'bash -x -c runs',
      "bash -x -c 'npx vitest run client/src/App.test.tsx'",
      ['file:client/src/App.test.tsx'],
    ],
    ['env -S is unmodeled', "env -S 'npx vitest run client/src/App.test.tsx'", []],
    [
      'nice -n runs',
      'nice -n 5 npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'timeout with an unknown option',
      'timeout --bogus 60 npx vitest run client/src/App.test.tsx',
      [],
    ],
    ['npx with an unknown option', 'npx --bogus vitest run client/src/App.test.tsx', []],
    ['npm with an unmodeled option', 'npm --ignore-scripts test -- client/src/App.test.tsx', []],
    [
      'npm run with an unmodeled option before --',
      'npm run test --dry-run -- client/src/App.test.tsx',
      [],
    ],
    ['pnpm -r runs in other packages', 'pnpm -r test src/App.test.tsx', []],
    ['pnpm --filter runs in other packages', 'pnpm --filter client test src/App.test.tsx', []],
    ['yarn workspace runs elsewhere', 'yarn workspace client test src/App.test.tsx', []],
    ['npm -w is unmodeled', 'npm -w client test -- src/App.test.tsx', []],
    ['npm -w with a package name', 'npm -w @acme/web test -- src/App.test.tsx', []],
    ['vitest --help', 'npx vitest --help client/src/App.test.tsx', []],
    ['vitest --standalone', 'npx vitest --standalone client/src/App.test.tsx', []],
    ['jest --listTests', 'npx jest --listTests client/src/App.test.tsx', []],
    ['pytest --collect-only', 'pytest --collect-only py/tests/test_api.py', []],
    ['pytest --co', 'python -m pytest --co py/tests/test_api.py', []],
    [
      'python -X option before -m pytest',
      'python -X dev -m pytest py/tests/test_api.py',
      ['file:py/tests/test_api.py'],
    ],
    ['python -c is not a pytest run', "python -c 'import pytest' py/tests/test_api.py", []],
    ['rspec --dry-run', 'bundle exec rspec --dry-run spec/models', []],
    ['playwright --list', 'npx playwright test --list e2e/tests/login.spec.ts', []],
    ['go test -c only compiles', 'cd go && go test -c ./pkg/store', []],
    ['go test -list only lists', 'cd go && go test -list . ./pkg/store', []],
    ['package script --help', 'npm test -- --help client/src/App.test.tsx', []],
    ['exit ends the script', 'exit 0; npx vitest run client/src/App.test.tsx', []],
    ['bare exit ends the script', 'exit\nnpx vitest run client/src/App.test.tsx', []],
    ['exit after a cd that cannot fail', 'cd client && exit; npx vitest run src/App.test.tsx', []],
    [
      'exit inside bash -c ends the inner script',
      "bash -c 'exit 0; npx vitest run client/src/App.test.tsx'",
      [],
    ],
    [
      'exit inside bash -c leaves the outer script running',
      "bash -c 'exit 0'; npx vitest run client/src/App.test.tsx",
      ['file:client/src/App.test.tsx'],
    ],
    [
      'exit inside a subshell ends only the subshell',
      '(exit 1); npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'exit in a pipeline ends only its element',
      'exit 0 | cat; npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['false || exit always exits', 'false || exit 1; npx vitest run client/src/App.test.tsx', []],
    ['true && exit always exits', 'true && exit; npx vitest run client/src/App.test.tsx', []],
    [
      'a runner || exit may continue',
      'npx vitest run x || exit 1; npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'exec replaces the shell',
      'exec npx vitest run client/src/App.test.tsx; npx vitest run server/routes/sessions.test.ts',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'bare exec only redirects',
      'exec > log 2>&1; npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'a shell that exited leaves the next cwd unknown',
      ['cd client; exit', 'npx vitest run src/App.test.tsx'],
      [],
    ],
    [
      'a shell that may have exited leaves the next cwd unknown',
      ['cd client && npx vitest run x || exit 1', 'npx vitest run src/App.test.tsx'],
      [],
    ],
    ['eval rejects the script', 'eval "npx vitest run client/src/App.test.tsx"', []],
    ['source rejects the script', 'source env.sh && npx vitest run client/src/App.test.tsx', []],
    ['dot rejects the script', '. env.sh && npx vitest run client/src/App.test.tsx', []],
    ['set -e rejects the script', 'set -e; npx vitest run client/src/App.test.tsx', []],
    [
      'set -euo pipefail rejects the script',
      'set -euo pipefail; npx vitest run client/src/App.test.tsx',
      [],
    ],
    [
      'set -x is modeled',
      'set -x; npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'set -o pipefail is modeled',
      'set -o pipefail; npx vitest run client/src/App.test.tsx | tail',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'trap rejects the script',
      "trap 'cd client' EXIT; npx vitest run client/src/App.test.tsx",
      [],
    ],
    ['alias rejects the script', 'alias npx=echo; npx vitest run client/src/App.test.tsx', []],
    ['return rejects the script', 'return 0; npx vitest run client/src/App.test.tsx', []],
    [
      'export CDPATH rejects the script',
      'export CDPATH=client; cd src && npx vitest run App.test.tsx',
      [],
    ],
    [
      'HOME prefix on cd rejects the script',
      'HOME=/work/session-abc/client cd && npx vitest run src/App.test.tsx',
      [],
    ],
    ['kill 0 rejects the script', 'kill 0; npx vitest run client/src/App.test.tsx', []],
    [
      'kill of an expansion rejects the script',
      'kill $$; npx vitest run client/src/App.test.tsx',
      [],
    ],
    [
      'kill of a pid is inert',
      'kill -9 1234; npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'builtin cd is cd',
      'builtin cd client && npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'time -p cd is cd',
      'time -p cd client && npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['pytest --log-file value is not a test', 'pytest --log-file package.json', []],
    [
      'pytest --log-file= value is not a test',
      'pytest --log-file=package.json py/tests/test_api.py',
      ['file:py/tests/test_api.py'],
    ],
    ['pytest unknown option', 'pytest --bogus package.json py/tests/test_api.py', []],
    ['pytest bool cluster', 'pytest -xvs py/tests/test_api.py', ['file:py/tests/test_api.py']],
    [
      'pytest attached short value',
      'pytest -kfoo py/tests/test_api.py',
      ['file:py/tests/test_api.py'],
    ],
    ['pytest cluster ending in a value option', 'pytest -xk test_api py/tests', ['dir:py/tests']],
    ['pytest cluster with an unknown letter', 'pytest -xz py/tests/test_api.py', []],
    ['pytest --cov takes the next word', 'pytest --cov py/tests/test_api.py', []],
    [
      'pytest --cov before another option',
      'pytest --cov --cov-report=term py/tests/test_api.py',
      ['file:py/tests/test_api.py'],
    ],
    [
      'vitest --config value is not a test',
      'cd server && npx vitest run --config package.json',
      [],
    ],
    [
      'vitest --outputFile.junit value',
      'npx vitest run --outputFile.junit package.json client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'vitest unknown option',
      'npx vitest run --bogus server/package.json client/src/App.test.tsx',
      [],
    ],
    ['vitest source file is not a test', 'npx vitest run server/finalize/test-inventory.ts', []],
    ['vitest package.json is not a test', 'npx vitest run package.json', []],
    ['jest --outputFile value is not a test', 'npx jest --outputFile package.json', []],
    [
      'jest --bail=1 keeps the file',
      'npx jest --bail=1 client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['playwright --output value is not a test', 'npx playwright test --output package.json', []],
    ['playwright unknown option', 'npx playwright test --bogus e2e/tests/login.spec.ts', []],
    ['rspec --out value is not a test', 'rspec --out package.json', []],
    [
      'rspec -r value then a spec',
      'rspec -r spec_helper spec/models/user_spec.rb',
      ['file:spec/models/user_spec.rb'],
    ],
    [
      'go -coverprofile value is not a package',
      'cd go && go test -coverprofile ../package.json ./pkg/store',
      ['dir:go/pkg/store'],
    ],
    ['go unknown flag', 'cd go && go test -bogus ./pkg/store', []],
    [
      'go double-dash flag and flags after packages',
      'cd go && go test --count=1 ./pkg/store -run TestStore -v',
      ['dir:go/pkg/store'],
    ],
    ['cypress --config-file value is not a spec', 'npx cypress run --config-file package.json', []],
    ['cypress --spec of a non-spec file', 'npx cypress run --spec package.json', []],
    [
      'cypress --project moves the spec root',
      'npx cypress run --project e2e --spec cypress/e2e/cart.cy.ts',
      [],
    ],
    ['script --outputFile value is not a test', 'npm test -- --outputFile package.json', []],
    ['script unknown option', 'npm test -- --bogus client/src/App.test.tsx', []],
    [
      'npm option value before -- is not a test',
      'npm test --loglevel package.json -- client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['npm unknown option before --', 'npm test --bogus -- client/src/App.test.tsx', []],
    [
      'npm positional without --',
      'npm test client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'npm run vitest splits npm options from the runner',
      'npm run vitest --silent -- run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['npm test -w after the script', 'npm test -w pkgs/a -- src/x.test.ts', []],
    ['npm -w before the script', 'npm -w pkgs/a test -- src/x.test.ts', []],
    ['npm -w after a positional', 'npm test src/x.test.ts -w pkgs/a', []],
    ['npm --workspaces', 'npm test --workspaces -- src/x.test.ts', []],
    ['npx -w', 'npx -w pkgs/a vitest run src/x.test.ts', []],
    [
      'npm script runs at the package root, not the cwd',
      'cd pkgs/a/src && npm test -- src/x.test.ts',
      ['file:pkgs/a/src/x.test.ts'],
    ],
    [
      'npm --prefix names the package folder',
      'npm --prefix pkgs/b test -- src/x.test.ts',
      ['file:pkgs/b/src/x.test.ts'],
    ],
    [
      'npm --prefix after the script',
      'npm test --prefix pkgs/b -- src/x.test.ts',
      ['file:pkgs/b/src/x.test.ts'],
    ],
    [
      'npm exec runs in the cwd despite --prefix',
      'npm --prefix pkgs/b exec vitest run src/x.test.ts',
      ['file:src/x.test.ts'],
    ],
    [
      'pnpm -w exec runs at the workspace root',
      'cd pkgs/a && pnpm -w exec vitest run src/x.test.ts',
      ['file:src/x.test.ts'],
    ],
    [
      'pnpm exec runs in the package',
      'cd pkgs/a && pnpm exec vitest run src/x.test.ts',
      ['file:pkgs/a/src/x.test.ts'],
    ],
    [
      'pnpm exec runs in the cwd below the package root',
      'cd pkgs/a/src && pnpm exec vitest run x.test.ts',
      ['file:pkgs/a/src/x.test.ts'],
    ],
    [
      'pnpm test runs at the package root',
      'cd pkgs/a/src && pnpm test src/x.test.ts',
      ['file:pkgs/a/src/x.test.ts'],
    ],
    [
      'pnpm -w test runs the root package',
      'cd pkgs/a && pnpm -w test src/x.test.ts',
      ['file:src/x.test.ts'],
    ],
    [
      'pnpm -C picks the package',
      'pnpm -C pkgs/b test src/x.test.ts',
      ['file:pkgs/b/src/x.test.ts'],
    ],
    [
      'pnpm bin-or-script below the package root is ambiguous',
      'cd pkgs/a/src && pnpm vitest run x.test.ts',
      [],
    ],
    [
      'pnpm bin-or-script at the package root',
      'cd pkgs/a && pnpm vitest run src/x.test.ts',
      ['file:pkgs/a/src/x.test.ts'],
    ],
    [
      'yarn script runs at the package root',
      'cd pkgs/b && yarn test src/x.test.ts',
      ['file:pkgs/b/src/x.test.ts'],
    ],
    [
      'yarn colon script may live in another workspace',
      'cd pkgs/b && yarn test:unit src/x.test.ts',
      [],
    ],
    [
      'yarn --cwd picks the package',
      'yarn --cwd pkgs/a test src/x.test.ts',
      ['file:pkgs/a/src/x.test.ts'],
    ],
    ['hatch run is unmodeled', 'hatch run pytest py/tests/test_api.py', []],
    ['script --root needs the runner to apply', 'npm test -- --root pkgs/a src/x.test.ts', []],
    ['script -r needs the runner to apply', 'npm test -- -r pkgs/a src/x.test.ts', []],
    ['uv run --package is unmodeled', 'uv run --package api pytest py/tests/test_api.py', []],
    [
      'uv run --directory moves the cwd',
      'uv run --directory py pytest tests/test_api.py',
      ['file:py/tests/test_api.py'],
    ],
    ['vitest --dir is unmodeled', 'npx vitest run --dir client client/src/App.test.tsx', []],
    ['vitest --dir= is unmodeled', 'npx vitest run --dir=client client/src/App.test.tsx', []],
    [
      'vitest --root keeps a cwd-relative path inside it',
      'npx vitest run --root client client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'vitest -r keeps a cwd-relative path inside it',
      'npx vitest run -r client client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'vitest --root excludes paths outside it',
      'npx vitest run --root server client/src/App.test.tsx',
      [],
    ],
    [
      'vitest --root resolves against the cwd',
      'cd client && npx vitest run --root . src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['vitest --root equal to the filter is a bare run', 'npx vitest run --root client client', []],
    [
      'vitest repeated --root is order-dependent',
      'npx vitest run --root client --root server client/src/App.test.tsx',
      [],
    ],
    [
      'vitest --root and --dir together',
      'npx vitest run --root client --dir src client/src/App.test.tsx',
      [],
    ],
    ['vitest --project is unmodeled', 'npx vitest run --project web client/src/App.test.tsx', []],
    ['vitest --shard is unmodeled', 'npx vitest run --shard 1/3 client/src/App.test.tsx', []],
    [
      'vitest --exclude is unmodeled',
      'npx vitest run --exclude "**/App*" client/src/App.test.tsx',
      [],
    ],
    ['jest --rootDir is unmodeled', 'npx jest --rootDir client client/src/App.test.tsx', []],
    ['jest --roots is unmodeled', 'npx jest --roots client client/src/App.test.tsx', []],
    [
      'jest --testPathIgnorePatterns is unmodeled',
      'npx jest --testPathIgnorePatterns App client/src/App.test.tsx',
      [],
    ],
    [
      'jest --selectProjects is unmodeled',
      'npx jest --selectProjects web client/src/App.test.tsx',
      [],
    ],
    ['pytest --lf is unmodeled', 'pytest --lf py/tests/test_api.py', []],
    [
      'pytest --deselect is unmodeled',
      'pytest --deselect py/tests/test_api.py py/tests/test_api.py',
      [],
    ],
    ['pytest --ignore is unmodeled', 'pytest --ignore py/tests py/tests/test_api.py', []],
    ['pytest --sw is unmodeled', 'pytest --sw py/tests/test_api.py', []],
    ['rspec --only-failures is unmodeled', 'rspec --only-failures spec/models/user_spec.rb', []],
    ['rspec --pattern is unmodeled', 'rspec --pattern "**/*_x.rb" spec/models', []],
    ['rspec --options file is unmodeled', 'rspec -O .rspec-ci spec/models/user_spec.rb', []],
    [
      'playwright --project is unmodeled',
      'npx playwright test --project chromium e2e/tests/login.spec.ts',
      [],
    ],
    [
      'playwright --shard is unmodeled',
      'npx playwright test --shard 1/2 e2e/tests/login.spec.ts',
      [],
    ],
    [
      'playwright --last-failed is unmodeled',
      'npx playwright test --last-failed e2e/tests/login.spec.ts',
      [],
    ],
    ['go repeated -C is order-dependent', 'go test -C go -C go/pkg ./store', []],
    ['script -v means version for some runners', 'npm test -- -v client/src/App.test.tsx', []],
    ['script --shard is unmodeled', 'npm test -- --shard 1/2 client/src/App.test.tsx', []],
    [
      'expanded option may change the mode',
      'OPTS=--help; npx vitest $OPTS client/src/App.test.tsx',
      [],
    ],
    ['expanded option value', 'npx vitest run --reporter $R client/src/App.test.tsx', []],
    ['expanded word after the test path', 'npx vitest run client/src/App.test.tsx $EXTRA', []],
    ['expansion in the runner position', 'npx $RUNNER run client/src/App.test.tsx', []],
    ['expansion in a wrapper option', 'env $X npx vitest run client/src/App.test.tsx', []],
    ['expansion in a timeout duration', 'timeout $T npx vitest run client/src/App.test.tsx', []],
    ['expansion in npm script args', 'npm test -- $ARGS client/src/App.test.tsx', []],
    ['expansion in a pytest argument', 'python -m pytest $PYTEST_ARGS py/tests/test_api.py', []],
    ['expansion in go test flags', 'cd go && go test $GOFLAGS ./pkg/store', []],
    [
      'expansion in a cypress option',
      'npx cypress run --browser $B --spec cypress/e2e/cart.cy.ts',
      [],
    ],
    [
      'leading assignment with an expansion still runs',
      'FOO=$BAR npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'expanded option before a static path',
      'OPTS=--help; npx vitest $OPTS client/src/App.test.tsx',
      [],
    ],
    [
      'quoted expansion before a static path',
      'npx vitest run "$FILTER" client/src/App.test.tsx',
      [],
    ],
    ['expanded option value', 'npx vitest run --reporter $R client/src/App.test.tsx', []],
    ['expanded name-filter value', 'npx vitest run -t "$NAME" client/src/App.test.tsx', []],
    ['expanded option inside a word', 'npx vitest run --reporter=$R client/src/App.test.tsx', []],
    ['command substitution argument', 'npx vitest run $(cat list.txt) client/src/App.test.tsx', []],
    ['backtick argument', 'npx vitest run `cat list.txt` client/src/App.test.tsx', []],
    ['parameter expansion with a default', 'npx vitest run ${EXTRA:-} client/src/App.test.tsx', []],
    ['expansion in a wrapper option', 'timeout $T npx vitest run client/src/App.test.tsx', []],
    [
      'expansion in a package-manager script argument',
      'npm test -- $ARGS client/src/App.test.tsx',
      [],
    ],
    ['expansion in pytest arguments', 'pytest $PYTEST_ADDOPTS py/tests/test_api.py', []],
    ['expansion in go test arguments', 'cd go && go test $GOFLAGS ./pkg/store', []],
    ['expansion inside bash -c', "bash -c 'npx vitest run $F client/src/App.test.tsx'", []],
    [
      'set with an expansion rejects the script',
      'set $FLAGS; npx vitest run client/src/App.test.tsx',
      [],
    ],
    ['unquoted glob argument', 'npx vitest run client/src/*.test.tsx client/src/App.test.tsx', []],
    ['unquoted brace argument', 'npx vitest run client/src/{App,Other}.test.tsx', []],
    [
      'quoted glob is a literal filter',
      'npx vitest run "client/src/*.test.tsx" client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'expansion in an inert builtin is fine',
      'echo $HOME && npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'expanded env assignment prefix is fine',
      'CI=$CI npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'quoted tilde is a literal directory',
      ["cd '~'", 'npx vitest run client/src/App.test.tsx'],
      [],
    ],
    ['unquoted rspec id is a glob', 'rspec spec/requests/api_spec.rb[1:2]', []],
    [
      'go -args forwards unmodeled test-binary flags',
      'cd go && go test ./pkg/store -args -test.list .',
      [],
    ],
    [
      'go --args forwards unmodeled test-binary flags',
      'cd go && go test ./pkg/store --args -test.v',
      [],
    ],
    [
      'go test without -args still selects the package',
      'cd go && go test ./pkg/store',
      ['dir:go/pkg/store'],
    ],
    ['go -args alone', 'cd go && go test ./pkg/store -args', []],
    [
      'go -exec runs the binary through another program',
      'cd go && go test -exec echo ./pkg/store',
      [],
    ],
    ['-- inside vitest arguments', 'npx vitest run -- client/src/App.test.tsx', []],
    ['-- inside pytest arguments', 'pytest -- py/tests/test_api.py', []],
    ['-- inside go test arguments', 'cd go && go test -- ./pkg/store', []],
    ['pytest -o can inject addopts', 'pytest -o addopts=--co py/tests/test_api.py', []],
    [
      'pytest --override-ini can inject addopts',
      'pytest --override-ini=addopts=--co py/tests/test_api.py',
      [],
    ],
    [
      'cypress --config can change specPattern',
      'npx cypress run --config specPattern=x --spec cypress/e2e/cart.cy.ts',
      [],
    ],
    [
      'cypress --config-file is fine',
      'npx cypress run --config-file cypress.ci.ts --spec cypress/e2e/cart.cy.ts',
      ['file:cypress/e2e/cart.cy.ts'],
    ],
    [
      'PYTEST_ADDOPTS prefix injects options',
      'PYTEST_ADDOPTS=--co pytest py/tests/test_api.py',
      [],
    ],
    ['GOFLAGS prefix injects options', 'cd go && GOFLAGS=-list=. go test ./pkg/store', []],
    ['SPEC_OPTS prefix injects options', 'SPEC_OPTS=--dry-run rspec spec/models/user_spec.rb', []],
    [
      'npm_config prefix injects npm options',
      'npm_config_prefix=pkgs/b npm test -- src/x.test.ts',
      [],
    ],
    [
      'env with an option-injecting variable',
      'env PYTEST_ADDOPTS=--co pytest py/tests/test_api.py',
      [],
    ],
    [
      'exported option-injecting variable rejects the script',
      'export PYTEST_ADDOPTS=--co; pytest py/tests/test_api.py',
      [],
    ],
    [
      'bare option-injecting assignment rejects the script',
      'PYTEST_ADDOPTS=--co; pytest py/tests/test_api.py',
      [],
    ],
    [
      'unrelated env prefix is fine',
      'CI=1 NODE_OPTIONS=--max-old-space-size=4096 npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'setup command before a cd chain',
      'git status --short && cd client && npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'build before a cd chain',
      'npm run build && cd client && npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      '|| after a cd that cannot fail never runs before &&',
      'cd client || cd server && npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      '|| alternatives before && make the cwd ambiguous',
      'cd nope || cd client && npx vitest run src/App.test.tsx',
      [],
    ],
    [
      '; rejoins the success and failure paths',
      'git status && cd client; npx vitest run src/App.test.tsx',
      [],
    ],
    [
      'the carried cwd rejoins both paths',
      ['git status && cd client && true', 'npx vitest run src/App.test.tsx'],
      [],
    ],
    [
      'failure branch of || keeps its own cwd',
      'cd client && false || npx vitest run src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      '&& after a certain cd chain carries over ;',
      'cd client && cd src; npx vitest run App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'uncertain cd keeps the old cwd on failure',
      'cd nope || npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'expanded cd target leaves the cwd unknown after ;',
      'cd "$X"; npx vitest run client/src/App.test.tsx',
      [],
    ],
    [
      'expanded cd target leaves the cwd unknown',
      ['cd "$X"', 'npx vitest run client/src/App.test.tsx'],
      [],
    ],
    [
      'a runner after a cd chain inside ||',
      'git status && cd client && npx vitest run src/App.test.tsx || echo failed',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'a failing setup step skips the chain',
      'false && cd client && npx vitest run src/App.test.tsx',
      [],
    ],
    [
      'cd with too many arguments always fails',
      'cd client server || npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'subshell chain keeps its own cwd',
      'git status && (cd client && npx vitest run src/App.test.tsx)',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'exit on the success branch leaves the failure branch running',
      'git status && exit; npx vitest run client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'jest --bail is a flag before a test path',
      'npx jest --bail client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'jest -b is a flag before a test path',
      'npx jest -b client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'rspec --fail-fast is a flag before a spec',
      'rspec --fail-fast spec/models/user_spec.rb',
      ['file:spec/models/user_spec.rb'],
    ],
    [
      'rspec --fail-fast=2 keeps the spec',
      'rspec --fail-fast=2 spec/models/user_spec.rb',
      ['file:spec/models/user_spec.rb'],
    ],
    ['rspec --profile takes the next word', 'rspec --profile spec/models/user_spec.rb', []],
    ['vitest -u takes the next word as its type', 'npx vitest run -u client/src/App.test.tsx', []],
    [
      'vitest -u before another option',
      'npx vitest run -u --reporter dot client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'vitest --bail takes a count',
      'npx vitest run --bail 1 client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'vitest --browser takes a name',
      'npx vitest run --browser chromium client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'jest --bail is boolean',
      'npx jest --bail client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['jest -b is boolean', 'npx jest -b client/src/App.test.tsx', ['file:client/src/App.test.tsx']],
    [
      'vitest --bail takes a value',
      'npx vitest run --bail 1 client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    ['vitest -u takes an optional value', 'npx vitest run -u client/src/App.test.tsx', []],
    [
      'vitest -u before another option',
      'npx vitest run -u --silent=passed-only client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'vitest --browser takes a value',
      'npx vitest run --browser chromium client/src/App.test.tsx',
      ['file:client/src/App.test.tsx'],
    ],
    [
      'rspec --fail-fast takes no separate value',
      'rspec --fail-fast spec/models/user_spec.rb',
      ['file:spec/models/user_spec.rb'],
    ],
    [
      'rspec --fail-fast=N',
      'rspec --fail-fast=3 spec/models/user_spec.rb',
      ['file:spec/models/user_spec.rb'],
    ],
    ['rspec -p takes the next word', 'rspec -p spec/models/user_spec.rb', []],
    [
      'playwright --debug takes an optional value',
      'npx playwright test --debug e2e/tests/login.spec.ts',
      [],
    ],
    [
      'playwright --debug=cli',
      'npx playwright test --debug=cli e2e/tests/login.spec.ts',
      ['file:e2e/tests/login.spec.ts'],
    ],
    [
      'playwright --test-list is unmodeled',
      'npx playwright test --test-list tests.txt e2e/tests/login.spec.ts',
      [],
    ],
    [
      'playwright --browser no longer exists',
      'npx playwright test --browser chromium e2e/tests/login.spec.ts',
      [],
    ],
    [
      'cypress --record before --spec',
      'npx cypress run --record --spec cypress/e2e/cart.cy.ts',
      ['file:cypress/e2e/cart.cy.ts'],
    ],
    [
      'cypress --record false',
      'npx cypress run --record false --spec cypress/e2e/cart.cy.ts',
      ['file:cypress/e2e/cart.cy.ts'],
    ],
    [
      'cypress --expose takes a value',
      'npx cypress run --expose a=1 --spec cypress/e2e/cart.cy.ts',
      ['file:cypress/e2e/cart.cy.ts'],
    ],
    ['not a test runner', 'cat server/routes/sessions.test.ts | head', []],
    ['unterminated quote is unparseable', `npx vitest run "server/routes/sessions.test.ts`, []],
    ['path escaping the repo', 'npx vitest run ../other/foo.test.ts /etc/passwd', []],
    [
      'absolute path inside the repo',
      `npx vitest run ${ROOT}/server/routes/sessions.test.ts`,
      ['file:server/routes/sessions.test.ts'],
    ],
    // cwd carried across commands
    [
      'cd persists into the next command',
      ['cd server', 'npx vitest run routes/sessions.test.ts'],
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'leaving the repo resets to the root next command',
      ['cd /tmp', 'npx vitest run server/routes/sessions.test.ts'],
      ['file:server/routes/sessions.test.ts'],
    ],
    [
      'engine-reported cwd',
      [{ command: 'npx vitest run src/App.test.tsx', cwd: `${ROOT}/client` }],
      ['file:client/src/App.test.tsx'],
    ],
    [
      'dedupes across commands',
      [
        'cd server && npx vitest run routes/sessions.test.ts',
        'npx vitest run server/routes/sessions.test.ts:10',
      ],
      ['file:server/routes/sessions.test.ts'],
    ],
  ];

  it.each(cases)('%s', (_name, commands, expected) => {
    expect(run(Array.isArray(commands) ? commands : [commands])).toEqual(expected);
  });

  it('records the runner of the first command naming a path', () => {
    const out = extractSessionRanTests(
      [{ command: 'pytest py/tests/test_api.py' }, { command: 'npm test -- py/tests/test_api.py' }],
      { repoRoot: ROOT, exists },
    );
    expect(out).toEqual([{ path: 'py/tests/test_api.py', kind: 'file', runner: 'pytest' }]);
  });
});

describe('tokenizeShell', () => {
  it('drops redirections and their targets', () => {
    const words = tokenizeShell('npx vitest run a.test.ts > out.log 2>&1 &>/dev/null')!
      .filter((t) => t.kind === 'word')
      .map((t) => (t as { value: string }).value);
    expect(words).toEqual(['npx', 'vitest', 'run', 'a.test.ts']);
  });
});

describe('shellCommandFromPayload', () => {
  it('reads Claude, Cursor and Gemini shapes', () => {
    expect(
      shellCommandFromPayload(
        JSON.stringify({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } }),
      ),
    ).toEqual({ command: 'ls' });
    expect(
      shellCommandFromPayload(
        JSON.stringify({
          type: 'tool_use',
          tool: 'Bash',
          input: { command: 'ls', workingDirectory: '/w/x' },
        }),
      ),
    ).toEqual({ command: 'ls', cwd: '/w/x' });
    expect(
      shellCommandFromPayload(
        JSON.stringify({
          type: 'tool_use',
          tool: 'run_shell_command',
          input: { command: 'ls', directory: 'x' },
        }),
      ),
    ).toEqual({ command: 'ls', cwd: 'x' });
  });

  it('skips non-shell tools, malformed rows and truncated payloads', () => {
    expect(
      shellCommandFromPayload(
        JSON.stringify({ type: 'tool_use', tool: 'Read', input: { file_path: 'a' } }),
      ),
    ).toBeNull();
    expect(shellCommandFromPayload('{not json')).toBeNull();
    const huge = JSON.stringify({
      type: 'tool_use',
      tool: 'Bash',
      input: { command: `npx vitest run ${'x'.repeat(200_000)}` },
    });
    expect(shellCommandFromPayload(clampPayload(huge))).toBeNull();
  });
});

describe('collectSessionShellCommands', () => {
  it('joins tool_use events through messages.session_id in order', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_kind TEXT NOT NULL, parent_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL);
    `);
    const msg = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
    msg.run('m2', 's1', 'assistant', '', '2026-10-21 10:05:00');
    msg.run('m1', 's1', 'assistant', '', '2026-10-21 10:00:00');
    msg.run('other', 's2', 'assistant', '', '2026-10-21 10:00:00');
    const ev = db.prepare(
      'INSERT INTO session_events (parent_kind, parent_id, seq, event_type, payload) VALUES (?, ?, ?, ?, ?)',
    );
    const bash = (command: string) =>
      JSON.stringify({ type: 'tool_use', tool: 'Bash', input: { command } });
    ev.run('message', 'm2', 1, 'tool_use', bash('third'));
    ev.run('message', 'm1', 2, 'tool_use', bash('second'));
    ev.run('message', 'm1', 1, 'tool_use', bash('first'));
    ev.run('message', 'm1', 3, 'tool_result', JSON.stringify({ type: 'tool_result', output: 'x' }));
    ev.run('message', 'm1', 4, 'tool_use', clampPayload(bash(`npx vitest ${'y'.repeat(100_000)}`)));
    ev.run('message', 'other', 1, 'tool_use', bash('other session'));
    ev.run('heartbeat', 'm1', 9, 'tool_use', bash('heartbeat'));
    expect(collectSessionShellCommands(db, 's1').map((c) => c.command)).toEqual([
      'first',
      'second',
      'third',
    ]);
    db.close();
  });
});

describe('sessionRanTestPaths', () => {
  it('keeps only paths committed at HEAD, not untracked worktree files', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ran-tests-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
      git('init', '-q');
      fs.mkdirSync(path.join(repo, 'server'));
      fs.writeFileSync(path.join(repo, 'server/a.test.ts'), '');
      git('add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
      fs.writeFileSync(path.join(repo, 'server/untracked.test.ts'), '');

      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE session_events (parent_kind TEXT, parent_id TEXT, seq INTEGER, event_type TEXT, payload TEXT);
      `);
      db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run('m1', 's1', '2026-10-21 10:00:00');
      db.prepare('INSERT INTO session_events VALUES (?, ?, ?, ?, ?)').run(
        'message',
        'm1',
        1,
        'tool_use',
        JSON.stringify({
          type: 'tool_use',
          tool: 'Bash',
          input: { command: 'cd server && npx vitest run a.test.ts untracked.test.ts' },
        }),
      );
      expect(await sessionRanTestPaths({ db, sessionId: 's1', repoRoot: repo })).toEqual([
        { path: 'server/a.test.ts', kind: 'file', runner: 'vitest' },
      ]);
      db.close();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
