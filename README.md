# CodeOnly Search

Workspace search for VS Code that hides result lines whose matches are only
inside comments. Built for C codebases such as the Linux kernel, where a
symbol search otherwise returns doc comments and commented-out code mixed in
with real usages.

- `foo(); /* foo */` is kept, and only the code match is highlighted.
- `/* foo is set up here */` and `// see foo` are hidden.
- Code inside `#if 0` / disabled `#ifdef` blocks is still found: the
  preprocessor is not evaluated.
- When a line cannot be classified (for example after an unterminated `/*`),
  it is hidden rather than shown.

## Install

```sh
npm install
npm run vsix          # builds codeonly-<version>.vsix
```

In VS Code, run **Extensions: Install from VSIX...** and pick the file. In a
Remote-SSH, WSL, or Dev Container window the extension installs on the remote
side, where the files are.

## Use

Open the **CodeOnly Search** view in the activity bar, or press
`Ctrl+Shift+Alt+F` (`Cmd+Shift+Alt+F` on macOS). The search input is seeded
with the editor selection, or with the word at the cursor.

| In the search input | |
|---|---|
| `Enter` | Search now and add the term to history |
| `Up` / `Down` | Browse search history |
| `Alt+C` / `Alt+W` / `Alt+R` | Match case / whole word / regular expression |
| `Esc` | Stop a running search |
| `···` | Show *include* / *exclude* globs (same syntax as the Search view) |

| In the results | |
|---|---|
| Click / `Enter` | Open the file with the match selected |
| `Ctrl+Enter` | Open to the side |
| `Delete` | Dismiss the result |
| `Ctrl+C` | Copy the line (or the path, on a file) |

The status line shows how many comment-only lines were hidden; click it to
see them. **Find Code in Folder (Exclude Comments)...** in the Explorer
context menu scopes the search to a folder. **CodeOnly: Go to Next/Previous
Result** have no default keys; bind them in Keyboard Shortcuts if you want.

## What is filtered

Comment filtering applies to files that use C comment syntax:
`.c .h .cc .cpp .cxx .hh .hpp .hxx .inl .S .dts .dtsi .dtso`.
Other files (Makefile, Kconfig, ...) are listed as-is and marked
*unfiltered*, so usages there are not lost.

String literals count as code. Raw string literals, digit separators, and
backslash line continuations are handled.

## Settings

The search reads the built-in search settings: `search.exclude`,
`files.exclude`, `search.useIgnoreFiles`, `search.useParentIgnoreFiles`,
`search.useGlobalIgnoreFiles`, `search.followSymlinks`, `search.smartCase`,
`search.maxResults`, `search.searchOnType`,
`search.searchOnTypeDebouncePeriod`, and `search.collapseResults`.

| Setting | Default | |
|---|---|---|
| `codeonly.diagnostics.logExcludedLines` | `false` | Write every hidden line and the reason to the **CodeOnly** output channel |
| `codeonly.ripgrepPath` | `""` | `rg` to use instead of the one bundled with VS Code (machine setting) |

## How it works

The extension runs the ripgrep binary that ships with VS Code (or VS Code
Server), with the same arguments as the built-in search plus `--json`. For
each C-family file with matches it lexes the file up to the last match and
classifies every match as code, comment, or unclassifiable. See
[ADR-0003](docs/adr/0003-search-backend.md).

On an 87k-file kernel tree with a warm cache, a search for `struct device`
(12k files, 67k lines) completes in about 3 s end to end; with the default
20,000-result limit, typical searches finish in about 1 s.

## Limitations

- Only C comment syntax is known. Other languages are not filtered.
- Multi-line regular expressions are not supported.
- Files are read as bytes; `files.encoding` is not applied, and UTF-16 files
  are reported as unclassifiable.
- Only `file` workspace folders are searched (no virtual file systems).

## Development

See [CLAUDE.md](CLAUDE.md) for build and test commands.
