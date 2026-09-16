# ADR-0002: Extension toolchain

Date: 2026-09-17
Status: accepted

## Context

ADR-0001 fixes a VS Code extension as the deliverable. A build, lint, and test
toolchain is needed before the first feature commit. The development machine
has Node 24, npm 11, VS Code 1.136, no display (Xvfb available), and no pnpm or
yarn.

## Decision

| Concern          | Choice                              | Note                                                   |
|------------------|-------------------------------------|--------------------------------------------------------|
| Language         | TypeScript 6.x                      | 7.x is the Go port; typescript-eslint requires `<6.1`  |
| API target       | `engines.vscode ^1.136.0`, `@types/vscode ^1.136.0` | matches the installed VS Code             |
| Bundler          | esbuild → `dist/extension.js` (CJS) | single-file bundle, `vscode` external                  |
| Package manager  | npm                                 | only one installed; lockfile committed                 |
| Lint             | eslint 10 + typescript-eslint 8     | flat config                                            |
| Tests            | `@vscode/test-cli` + mocha (tdd UI) | integration tests in a real extension host, compiled by `tsc` to `out/` |

## Consequences

- Two compile outputs: `dist/` (esbuild bundle, what VS Code loads) and `out/`
  (tsc output, what mocha loads). `npm test` builds both via `pretest`.
- Headless runs need `xvfb-run -a npm test`; the first run downloads VS Code
  stable into `.vscode-test/` (gitignored).
- TypeScript 6 no longer auto-includes `@types/*`; `tsconfig.json` lists
  `types` explicitly. Adding a new `@types` package requires adding it there.
- Upgrading to TypeScript 7 is blocked until typescript-eslint supports it.
