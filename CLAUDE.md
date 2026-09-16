# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                 # once; also after package.json changes
npm run compile             # tsc --noEmit + eslint + esbuild bundle → dist/extension.js
npm run watch               # esbuild watch (used by the F5 "Run Extension" launch config)
npm run check-types         # tsc --noEmit for the extension and for src/webview (DOM lib)
npm run lint                # eslint src
npm test                    # integration tests in a real VS Code host (pretest builds out/ and dist/)
xvfb-run -a npm test        # same, on a headless machine (no DISPLAY)
npm run package             # production bundle (minified, no sourcemap)
npm run vsix                # production bundle + codeonly-<version>.vsix (vsce)
```

Run a single test file or case by filtering mocha through the test CLI:

```bash
npm run pretest && npx vscode-test --grep "activates"
```

First `npm test` downloads VS Code stable into `.vscode-test/` (gitignored). Tests use mocha's `tdd` UI (`suite`/`test`), not `describe`/`it`. The test host opens `test-fixtures/workspace` as its workspace; UI tests drive the extension through the `CodeOnlyApi` returned from `activate` (`src/api.ts`).

## Layout and build outputs

- `src/extension.ts` — entry point and command wiring, bundled by `esbuild.mjs` into `dist/extension.js`.
- `src/classify/` — C comment lexer and per-line keep/hide decision. No `vscode` import.
- `src/search/` — include/exclude resolution with VS Code's query-builder rules (`scope.ts`), ripgrep location, arguments, JSON stream, and the filtering pipeline (`searchCode`). No `vscode` import, so it runs under plain Node (useful for benchmarks against `out/`).
- `src/ui/` — VS Code layer: search controller, query webview host, results tree, editor highlights, settings.
- `src/webview/` — query form script, bundled to `dist/webview/search.js`; type-checked with its own `tsconfig.json` (DOM lib) and excluded from the root one.
- `src/shared/protocol.ts` — messages between the extension and the webview.
- `media/` — webview stylesheet and activity-bar icon.
- `src/test/**/*.test.ts` — compiled by `tsc` into `out/`, discovered by `.vscode-test.mjs`. Fixtures live in `test-fixtures/workspace/` (byte-exact: BOM, CRLF, Latin-1 files).
- Two outputs on purpose: `dist/` is esbuild output (extension CJS bundle with `vscode` external, plus the webview IIFE); `out/` is plain tsc output for mocha. See ADR-0002.
- TypeScript 6 does not auto-include `@types/*`; add any new `@types` package to `types` in `tsconfig.json` or it will not resolve.
- Extension ID in tests is `zekaizer.codeonly` (`publisher.name` from package.json).

## Decisions

ADRs live in `docs/adr/`. ADR-0001 fixes delivery as a VS Code extension; ADR-0002 fixes the toolchain (TypeScript 6, esbuild, npm, `@vscode/test-cli`); ADR-0003 fixes the search backend (VS Code's bundled ripgrep plus an in-process lexical comment filter). TypeScript 7 is blocked until typescript-eslint supports it.

## Document pipeline

Each project lives in `intent/<project-name>/` and moves through fixed stages, one file per stage:

1. `intent.md` — problem, proposed outcome, constraints, out-of-scope (produced by the `intent-capture` skill)
2. `spec.md` — confirmed facts (F), assumptions (A), requirements (R/NFR), interface contracts (IC), constraints (C), decisions (D), unverified items (U) (produced by the `spec-capture` skill)
3. `plan.md` — MVP scope, kickoff decisions (PD*), pipeline, verification matrix; ADRs for qualifying decisions go in `docs/adr/`

Later stages cite earlier ones by ID (e.g. `R1'` traces to `P1`, `G1'`). Keep IDs stable when editing; a primed ID (`G1'`, `R1'`) marks a revised version of an earlier item.

## Project: codeonly

Spec lives in `intent/vscode-search-exclude-comments/` (the pre-naming spec ID). Goal: VS Code global search (Ctrl+Shift+F) that drops result lines whose only matches are inside comments, primarily for C codebases. Stock VS Code cannot do this (spec F1, F2); the MVP plan is in `plan.md` of the same directory. MVP work is integrated on the `mvp` branch; feature branches merge there.

Decisions already fixed in `spec.md` that constrain any implementation:

- `#if 0` / `#ifdef`-disabled code must still match (C1, R3). LSP Find References is explicitly not a substitute.
- Uncertain classification excludes the line (D1, R4): a missed code match is preferred over a leftover comment match.
- Mixed lines (`foo(); /* foo */`) are included (R2).
- Search-panel flow must be preserved: term → result list → select → jump to file:line (C2, R5, IC1).
- Must work under Remote-SSH / WSL / Dev Containers (R7).
- Target scale is ~10⁵ files, kernel-tree sized (A3, NFR1'); latency bound D2 is 10 s with a warm cache.
- Out of scope: in-file Ctrl+F, string-literal exclusion, Markdown search.

