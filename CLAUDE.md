# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                 # once; also after package.json changes
npm run compile             # tsc --noEmit + eslint + esbuild bundle → dist/extension.js
npm run watch               # esbuild watch (used by the F5 "Run Extension" launch config)
npm run check-types         # tsc --noEmit only
npm run lint                # eslint src
npm test                    # integration tests in a real VS Code host (pretest builds out/ and dist/)
xvfb-run -a npm test        # same, on a headless machine (no DISPLAY)
npm run package             # production bundle (minified, no sourcemap)
```

Run a single test file or case by filtering mocha through the test CLI:

```bash
npm run pretest && npx vscode-test --grep "activates"
```

First `npm test` downloads VS Code stable into `.vscode-test/` (gitignored). Tests use mocha's `tdd` UI (`suite`/`test`), not `describe`/`it`.

## Layout and build outputs

- `src/extension.ts` — entry point, bundled by `esbuild.mjs` into `dist/` (what VS Code loads).
- `src/test/**/*.test.ts` — compiled by `tsc` into `out/`, discovered by `.vscode-test.mjs`.
- Two outputs on purpose: `dist/` is a single CJS bundle with `vscode` external; `out/` is plain tsc output for mocha. See ADR-0002.
- TypeScript 6 does not auto-include `@types/*`; add any new `@types` package to `types` in `tsconfig.json` or it will not resolve.
- Extension ID in tests is `zekaizer.codeonly` (`publisher.name` from package.json).

## Decisions

ADRs live in `docs/adr/`. ADR-0001 fixes delivery as a VS Code extension; ADR-0002 fixes the toolchain (TypeScript 6, esbuild, npm, `@vscode/test-cli`). TypeScript 7 is blocked until typescript-eslint supports it.

## Document pipeline

Each project lives in `intent/<project-name>/` and moves through fixed stages, one file per stage:

1. `intent.md` — problem, proposed outcome, constraints, out-of-scope (produced by the `intent-capture` skill)
2. `spec.md` — confirmed facts (F), assumptions (A), requirements (R/NFR), interface contracts (IC), constraints (C), decisions (D), unverified items (U) (produced by the `spec-capture` skill)
3. plan / ADR — next stage, not yet written; goes in `docs/adr/` per the global ADR rules

Later stages cite earlier ones by ID (e.g. `R1'` traces to `P1`, `G1'`). Keep IDs stable when editing; a primed ID (`G1'`, `R1'`) marks a revised version of an earlier item.

## Project: codeonly

Spec lives in `intent/vscode-search-exclude-comments/` (the pre-naming spec ID). Goal: VS Code global search (Ctrl+Shift+F) that drops result lines whose only matches are inside comments, primarily for C codebases. Stock VS Code cannot do this (spec F1, F2), so something must be built or attached; the mechanism is undecided and belongs to the plan/ADR stage.

Decisions already fixed in `spec.md` that constrain any implementation:

- `#if 0` / `#ifdef`-disabled code must still match (C1, R3). LSP Find References is explicitly not a substitute.
- Uncertain classification excludes the line (D1, R4): a missed code match is preferred over a leftover comment match.
- Mixed lines (`foo(); /* foo */`) are included (R2).
- Search-panel flow must be preserved: term → result list → select → jump to file:line (C2, R5, IC1).
- Must work under Remote-SSH / WSL / Dev Containers (R7).
- Target scale is ~10⁵ files, kernel-tree sized (A3, NFR1'); latency bound D2 is still open (proposed 60 s).
- Out of scope: in-file Ctrl+F, string-literal exclusion, Markdown search.

Open items before kickoff: D2 (latency bound), D3 (diagnostic output channel), U3 (baseline search time measurement).
