# spec: vscode-search-exclude-comments
Source: intent.md (confirmed in chat, 2026-09-16). Status: draft. Date: 2026-09-16.

## 1. Problem and goals
P1. When looking up symbol usages with VS Code global search (Ctrl+Shift+F), comment matches are mixed in with code matches, making usages costly to identify. (evidence: A1, A2)
G1'. A symbol-usage search shows only code matches. (resolves: P1 / verification: zero result lines whose match is comment-only)

## 2. Current structure
VS Code search panel → ripgrep text search → result list. No language-syntax awareness. (F1)

## 3. Confirmed facts
### External
F1. VS Code global search is ripgrep-based text search with no language-syntax awareness. [source: microsoft/vscode wiki "Search Issues" / current VS Code]
F2. A comment-excluding search option has been requested from 2018 (#55832) through 2024 (#225928); requests were closed as duplicates and no native implementation exists. [source: GitHub microsoft/vscode issues / checked 2026-09-16]
F3. Under Remote-SSH, WSL, and Dev Containers, workspace extensions run on the remote side and the file system is remote. [source: VS Code Remote Development docs / current VS Code]

## 4. Assumptions
A1. Roughly half of search results are comment matches. (evidence: author's impression / verification: RISK1 / if wrong: re-evaluate the value of G1')
A2. Occurs continuously during development. (evidence: author's impression / no verification needed; order of magnitude suffices)
A3. The target codebase is on the order of 10⁵ files. (evidence: "about a kernel tree" / verified 2026-09-17: android16-6.12 has 87,254 tracked files, 60,264 `.c`/`.h`)

## 5. Requirements
### Functional
R1'. WHERE the file is a C file, WHEN the user enters a search term and runs the search, THEN the system SHALL exclude from the results any line whose only matches are inside comments. (Must) — verification: place a file where the term appears only in comments, search → that line is absent from results — evidence: P1, G1', user round 1
R2. WHEN a matching line contains both code and a comment, THEN the system SHALL include that line in the results. (Must) — verification: search a line of the form `foo(); /* foo */` → included — evidence: G1'
R3. The system SHALL include code matches inside regions disabled by `#if`/`#ifdef` in the results, identically to active regions. (Must) — verification: search a code line inside an `#if 0` block → included — evidence: C1
R4. IF a line cannot be classified as comment or code, THEN the system SHALL exclude that line from the results. (Should) — verification: search lines following an unterminated `/*` → no results — evidence: D1
R5. WHEN the user selects a result entry, THEN the system SHALL open that file and move the cursor to that line. (Must) — verification: after selection, the active file and cursor line match the entry — evidence: C2
R6. WHERE the file is in a non-C language for which VS Code knows the comment syntax, the system SHALL behave identically to R1', R2, and R4. (Could) — verification: one language each (e.g. Python, Rust), comment-only match → no results — evidence: user round 2
R7. WHERE the workspace is a remote tree opened via Remote-SSH, WSL, or Dev Container, the system SHALL satisfy R1'–R5 identically to a local workspace. (Must) — verification: re-run the R1', R3, and R5 checks on at least one of the three remote kinds actually in use — evidence: user round 2, F3
### Non-functional
NFR1'. WHEN a single symbol is searched in a codebase on the order of 10⁵ files, THEN the system SHALL display results within <D2>. (Must) — verification: search three symbols in a kernel tree, measure elapsed time — evidence: A3, user rounds 1–2
NFR2. WHEN the user enables diagnostic output and runs a search, THEN the system SHALL emit each excluded line with its file path, line number, and exclusion reason in an inspectable form. (Should) — verification: enable diagnostics, search with the R1' test file → the excluded list contains that line with reason "comment-only match" — evidence: user round 3, D1

## 6. Interface contracts
IC1. Each result entry exposes the file path, line number, and the matched line's original text; the location opened on selection matches that path and line. — verifies: R1', R2, R3, R5, R7 — evidence: C2, user round 1

## 7. Constraints
C1. Usages in code compiled out by `#ifdef` must be visible too. (fixed by user / intent Constraints)
C2. Keep the search-panel flow — enter term → result list → select entry to jump to file and line. (user round 1)

## 8. Out of scope
OOS1. In-file search (Ctrl+F). (user decision, intent)
OOS2. Excluding matches inside string literals. (user decision, intent)
OOS3. Markdown vault search. (user decision, intent)

## 9. Undecided
D1. (decided) When comment classification is uncertain, a missed code match is preferable to a leftover comment match — exclude when uncertain. (user round 1)
D2. (decided) Upper bound for NFR1' is 10 s with a warm page cache. Basis: U3. (delegated to the implementer by the user, 2026-09-17)
D3. (decided) Diagnostic output goes to the Output panel (`CodeOnly` log channel), enabled by a setting. (delegated to the implementer by the user, 2026-09-17)

## 10. Unverified + next actions
(U2 closed by user answer: acceptable wait is on the order of tens of seconds)
(U1 closed 2026-09-17: whole-word, case-sensitive searches on android16-6.12; the comment-only share of matched C-family lines is 0.2–18.5 % across 12 symbols, e.g. `mutex_lock` 0.2 %, `kmalloc` 9.2 %, `rcu_read_lock` 9.9 %, `CONFIG_PM` 18.5 %. Far below A1's "roughly half"; see RISK1.)
(U3 closed 2026-09-17: ripgrep with VS Code's arguments, `struct device` on android16-6.12 — 3.5 s cold, 0.47 s warm; 12,326 files, 67,799 lines)

## 11. Discarded — wrong premises
None.

## 12. Notes
- No policy conflicts.
- Goal back-trace: P1 → G1' → R1', R2, R4 → IC1. No unmapped P or G.
- Residual risks (accepted by user, round 4): RISK1 (U1), RISK2 (U3), RISK3 (D2), RISK4 (D3).
- F1+F2: G1' cannot be met by stock VS Code — something must be built or attached. Choice of means belongs to plan/ADR.
