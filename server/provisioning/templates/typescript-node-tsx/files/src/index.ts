/**
 * Starter entry point for the TypeScript + Node + tsx template.
 *
 * Run directly with:  npm start
 * Run tests with:     npm test
 * Run the linter:     npm run lint
 */

export function hello(name = 'world'): string {
  return `Hello, ${name}!`;
}

function main(): void {
  const [, , who] = process.argv;
  // eslint-disable-next-line no-console
  console.log(hello(who));
}

// Only run main() when invoked as an entry script, not when imported in tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
