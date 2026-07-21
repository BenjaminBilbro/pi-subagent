# AGENTS.md

Simple guidance for coding agents working in this repository.

## Repository setup

- Requirements: Node.js 22.19+ and npm
- Install dependencies:

```bash
npm install
```

- Check what would be published:

```bash
npm pack --dry-run
npm publish --dry-run --access public
```

## Local validation

- This package is a Pi extension (entry point: `index.ts`).
- Quick manual check with local package:

```bash
pi -e .
```

## Code map

- `index.ts` — extension entry point and tool registration
- `bash-guardian.js` — live POSIX process-group owner for child Bash commands
- `protocol.ts` — frame/task/receipt protocol, ledger, and process registry
- `runner.ts` — subagent process execution
- `runner-events.js` — bounded Pi JSON event parsing
- `render.ts` — TUI rendering for tool calls/results
- `types.ts` — shared types/helpers
- `skills/orchestrate-subagent-stack/` — bundled model playbook for software and web-research delegation
- `README.md` — user-facing docs

## Commit format (important)

Use the repository's existing style:

- Imperative mood
- Sentence case
- No prefix like `feat:` / `fix:` / `chore:`

Examples:

- `Add depth-limited subagent delegation`
- `Scope npm package name`
- `Add npm install option to README`

Keep commits focused (one logical change per commit).

## Release notes

- Package name is still inherited as `@mjakl/pi-subagent`; do not publish from this fork unless the maintainer confirms access to that npm scope or deliberately renames it.
- Minimum Pi API: `@earendil-works/*` 0.80.6
- For doc/code changes on npm, publish a new version (`npm version patch|minor|major`), then publish.
