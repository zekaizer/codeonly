# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

Pre-implementation workspace. There is no source code, build system, test runner, or git repository yet. The only content is the spec pipeline under `intent/`. Do not invent build or test commands; add them here once a toolchain exists.

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
