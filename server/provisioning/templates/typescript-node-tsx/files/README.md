# TypeScript · Node + tsx starter

Minimal, batteries-included TypeScript starter that runs on Node.js 20+ via
`tsx`. Uses Node's built-in test runner (`node:test`) so there's no heavyweight
test framework to learn, and `tsc --noEmit` plus ESLint for type + lint gates.

## Getting started

```bash
npm install
npm test         # run the unit tests
npm run lint     # typecheck + ESLint + Prettier check
npm start -- you # -> "Hello, you!"
```

## Layout

```
src/
  index.ts       hello() — importable, and a main() that runs when invoked directly
  index.test.ts  node:test suite for hello()
tsconfig.json    strict TS config, ESM, nodenext resolution
eslint.config.mjs flat ESLint config with @typescript-eslint + prettier
.prettierrc.json Prettier rules
```

## Why this stack

- **tsx** lets you run `.ts` files directly without a build step, matching the
  ergonomics of Agent Hub's own server.
- **node:test** ships with Node 20+ so there's no runtime dep needed for tests.
- **ESLint + Prettier** are the Node ecosystem defaults; the flat config is
  pre-wired for TypeScript and compatible with Prettier.

Swap any piece as the project grows — this is a starting point, not a
straightjacket.
