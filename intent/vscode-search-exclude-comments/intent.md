# Intent: vscode-search-exclude-comments
Author: Luke (Samsung S.LSI, Custom SoC Solution Group / BSP). Status: draft. Date: 2026-09-16.

## Problem
When searching for where a symbol (variable, struct, etc.) is used with VS Code global search (Ctrl+Shift+F), matches inside comments come back mixed in with code matches. Roughly half of the results are comment matches, and this happens continuously during development.

## Proposed outcome
A search for symbol usages shows only code matches.

## Affected users and systems
Myself (BSP development). VS Code global search. Target is mostly C codebases.

## Constraints
- Usages in code compiled out by `#ifdef` must be visible too — compile-result-based reference lookup (LSP Find References) is not a substitute.

## Out of scope
- In-file search (Ctrl+F)
- Excluding matches inside string literals
- Markdown vault search

## Open questions
- Exact ratio of comment matches needs measurement — Luke
