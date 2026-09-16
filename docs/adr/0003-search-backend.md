# ADR-0003: Search backend — bundled ripgrep with a lexical comment filter

Date: 2026-09-17
Status: accepted

## Context

The extension (ADR-0001) needs workspace text search at kernel-tree scale
(NFR1', D2: 10 s warm) and must classify each match as code or comment
(R1'–R4), including under Remote-SSH, WSL, and Dev Containers (R7).

The stable extension API has no text-search function: `findTextInFiles` and
`TextSearchProvider` are proposed APIs and cannot be used by an installed
extension.

Search candidates: the ripgrep binary that ships with VS Code; bundling
`@vscode/ripgrep` in the VSIX; a Node file walker with JavaScript regexes.

Classification candidates: a hand-written lexer; tree-sitter; clangd or
another compile-based index (ruled out by C1, since `#ifdef`-disabled code
must match).

## Decision

- Run the ripgrep binary bundled with VS Code (or VS Code Server), found under
  `vscode.env.appRoot`. A machine-scoped setting overrides it; `PATH` is the
  last fallback.
- Pass the same ripgrep arguments VS Code's own text search uses, derived from
  `search.*` and `files.exclude`, plus `--json`.
- Classify matches in-process with a byte-level C lexer over the raw file,
  scanning only up to the last match. Preprocessor conditionals are not
  evaluated.

## Consequences

- The VSIX carries no native binary, so one package works locally and
  remotely, and the ripgrep version follows VS Code.
- The bundled path is internal and has already moved once (1.138:
  `@vscode/ripgrep/bin` → `@vscode/ripgrep-universal/bin/<platform>-<arch>`).
  Another move needs a new candidate path; the setting and `PATH` fallback
  keep the extension usable until then.
- The searched file set and match semantics match the built-in Search view.
- C-family files with matches are read twice (ripgrep, then the lexer).
  Measured on an 87k-file kernel tree, warm cache: `struct device` (12k files,
  67k lines) in 3.1 s end to end, within D2.
- Classification ignores build configuration (R3) and needs no grammar
  dependency, but only knows C comment syntax; R6 stays open.
- Offsets are bytes. A UTF-8 BOM is compensated. UTF-16 files, and lines whose
  bytes changed after ripgrep read them, are excluded as unclassifiable (D1).
  `files.encoding` is not passed to ripgrep, so other encodings are searched as
  raw bytes.
