# ADR-0001: Deliver codeonly as a VS Code extension

Date: 2026-09-17
Status: accepted

## Context

Spec F1/F2: VS Code global search is plain ripgrep with no syntax awareness, and
a comment-excluding option has been requested since 2018 without a native
implementation. The spec's Notes leave the delivery mechanism to plan/ADR.

Candidates considered:

- A VS Code extension running in the extension host.
- An external CLI (ripgrep wrapper) invoked from a terminal or task.
- A fork or patch of VS Code's search service.

Constraints that matter: C2 keeps the search-panel flow (term → result list →
jump to file:line); R7 requires identical behaviour under Remote-SSH, WSL, and
Dev Containers, where the workspace file system lives on the remote side (F3).

## Decision

Build codeonly as a VS Code workspace extension.

## Consequences

- The extension runs on the remote side under Remote-SSH/WSL/Dev Containers, so
  it reads the same file system the user sees (satisfies R7 without extra work).
- Result presentation must be built inside the extension API (tree view,
  quick pick, or search-provider APIs); the built-in Search panel's result list
  cannot be filtered by an extension.
- A CLI would satisfy neither C2 nor R7's jump-to-location behaviour, and a
  VS Code fork is not maintainable for a single-user tool. Both are rejected.
