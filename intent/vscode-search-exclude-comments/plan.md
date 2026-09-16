# plan: vscode-search-exclude-comments (MVP)
Source: spec.md. Status: draft. Date: 2026-09-17.
Kickoff decisions were delegated to the implementer by the user (2026-09-17).

## 1. MVP scope
In: R1', R2, R3, R4, R5, R7, NFR1', NFR2, IC1.
Out: R6 (Could). Comment classification uses C syntax only, applied to the C-family set in PD2.

## 2. Resolved decisions
- D2 → 10 s, warm page cache (spec D2). Basis: U3 — ripgrep alone takes 0.47 s warm / 3.5 s cold for `struct device` on an 87k-file kernel tree.
- D3 → Output panel, `CodeOnly` log channel, enabled by a setting (spec D3).
- PD1. Files outside the C-family set are listed unfiltered and marked "unfiltered". Hiding them would silently drop Kconfig, Makefile, and defconfig usages, which conflicts with the visibility goal behind C1.
- PD2. C-family set: `.c .h`, C++ (`.cc .cpp .cxx .hh .hpp .hxx .inl`), preprocessed assembly (`.S`), devicetree (`.dts .dtsi .dtso`). All of these pass through the C preprocessor, so C comment syntax is exact for them.
- PD3. Raw string literals (`R"x(...)x"`) are lexed in every C-family file: GCC accepts them in `gnu*` C modes, which the kernel uses.
- PD4. Result presentation mirrors the built-in Search view: an always-visible query form (webview view with case/word/regex toggles, include/exclude globs, history) above a native tree view of results (file icons, keyboard navigation, collapse). A quick-pick-only flow was rejected because the query is not visible while reading results.
- PD5. Search backend: VS Code's bundled ripgrep plus an in-process lexical comment filter. Recorded in ADR-0003.

## 3. Pipeline
query form → controller → ripgrep per workspace folder (`--json`) → matches grouped per file → C-family file: read raw bytes, lex up to the last match, classify each match (code / comment / uncertain) → line decision (R2, R4) → results tree; excluded lines → diagnostics log.

The search and classification modules do not import `vscode`, so they are unit-testable and benchmarkable with plain Node.

## 4. Feature branches (each merged into `mvp`)
1. `feat/comment-classifier` — lexer and line decision (R1', R2, R3, R4 at unit level).
2. `feat/search-pipeline` — ripgrep backend and filter pipeline, ADR-0003 (R1'–R4 end to end over a fixture workspace).
3. `feat/search-ui` — query form, results tree, navigation, diagnostics (R5, IC1, NFR2).
4. `chore/packaging` — README and VSIX packaging.

## 5. Verification
| ID    | Check | Result (2026-09-17) |
|-------|-------|---------------------|
| R1'   | Integration test: fixture line with the term only in a comment is absent. | pass |
| R2    | Integration test: `foo(); /* foo */` line is present. | pass |
| R3    | Integration test: code line inside `#if 0` is present. | pass |
| R4    | Integration test: lines after an unterminated `/*` are absent. | pass |
| R5    | Integration test: activating a result opens the file with the cursor on that line. | pass |
| IC1   | Integration test: result entry carries path, line number, and original line text. | pass |
| NFR2  | Integration test: excluded list holds the R1' line with reason `comment-only match`. | pass |
| NFR1' | Benchmark: three symbols on the android16-6.12 tree, warm cache, under D2. | pass: `struct device` 3.06 s, `mutex_lock` 1.71 s, `kmalloc` 1.13 s without a result limit |
| R7    | Bundled ripgrep path resolves in the installed VS Code server layout; end-to-end check over Remote-SSH by the user. | path resolves for servers 1.129–1.138; Remote-SSH check pending |
