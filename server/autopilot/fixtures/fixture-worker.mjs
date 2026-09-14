import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

const argv = process.argv.slice(2).join(' ');
const isReview = argv.includes('review-verdict') || argv.includes('agenthub:review-verdict');
const isPlan = !isReview && argv.includes('Return ONLY a fenced');

const spec = {
  assumptions: ['single-user', 'disposable in-memory data'],
  acceptanceJourneys: [
    {
      action: 'submit a new todo via the add form',
      expectedResult: 'the new item appears in the todo list',
    },
    {
      action: 'open the list page',
      expectedResult: 'existing todos are shown',
    },
  ],
  nonGoals: ['authentication'],
  specDecisions: [
    { key: 'storage', decision: 'in-memory array' },
    { key: 'runtime', decision: 'static html and js' },
  ],
  qualityRubricVersion: 1,
};

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

if (!isPlan && !isReview && existsSync('app.js')) {
  const js = readFileSync('app.js', 'utf8');
  if (!js.includes('dataset.complete')) {
    const next = js.replace(
      'li.textContent = todo.title;\n    list.appendChild(li);',
      `li.textContent = todo.title;
    li.dataset.complete = todo.done ? 'true' : 'false';
    li.addEventListener('click', () => {
      todo.done = !todo.done;
      render();
    });
    list.appendChild(li);`,
    );
    if (next !== js) {
      writeFileSync('app.js', next);
      try {
        git(['config', 'user.email', 'autopilot-fixture@example.test']);
        git(['config', 'user.name', 'Autopilot Fixture']);
        git(['add', 'app.js']);
        git(['commit', '-m', 'complete a todo from the list']);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    }
  }
}

const text = isReview
  ? `<agenthub:review-verdict>\n${JSON.stringify({ verdict: 'approved', threads: [] })}\n</agenthub:review-verdict>`
  : isPlan
    ? `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``
    : 'Committed complete-todo on the fixture app.';

process.stdout.write(
  `${JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
  })}\n`,
);
process.stdout.write(`${JSON.stringify({ type: 'result', response: text })}\n`);
