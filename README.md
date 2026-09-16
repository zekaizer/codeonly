# CodeOnly Search

Search your workspace and see only the lines where a symbol is used in code.
Lines whose matches are all inside comments are hidden, so doc comments and
remarks no longer bury the real usages. Made for C codebases such as the
Linux kernel.

- `foo(); /* foo */` is shown, and only the code match is highlighted.
- `/* foo is set up here */` and `// see foo` are hidden.
- Code inside `#if 0` or a disabled `#ifdef` block is still found.
- A line that cannot be classified with confidence, such as text after an
  unterminated `/*`, is hidden.

## Installation

1. Get the `codeonly-<version>.vsix` file.
2. In VS Code, open the Command Palette and run
   **Extensions: Install from VSIX...**, then pick the file.
   From a terminal: `code --install-extension codeonly-<version>.vsix`.

When you work over Remote-SSH, WSL, or in a Dev Container, install it from a
window connected to that remote so that it runs next to your files.

## Searching

Open **CodeOnly Search** from the activity bar, or press
`Ctrl+Shift+Alt+F` (`Cmd+Shift+Alt+F` on macOS). The search box is filled
with the editor selection, or with the word under the cursor.

Results appear as you type, grouped by file. The line under the search box
tells you how many results were found and how many comment-only lines were
hidden.

| In the search box | |
|---|---|
| `Enter` | Search now and remember the term |
| `Up` / `Down` | Previous / next remembered term |
| `Alt+C` / `Alt+W` / `Alt+R` | Match Case / Match Whole Word / Use Regular Expression |
| `Ctrl+Down` | Move to the results |
| `Esc` | Stop the search |
| `···` button | Show the *include* and *exclude* boxes |

The *include* and *exclude* boxes take the same patterns as VS Code's Search
view, for example `*.c, ./drivers/gpu` or `**/tests/**`. You can also
right-click a folder in the Explorer and choose
**Find Code in Folder (Exclude Comments)...**.

| In the results | |
|---|---|
| Click, or `Enter` | Open the file with the match selected |
| `Ctrl+Enter` | Open to the side |
| `Delete` | Dismiss the result |
| `Ctrl+C` | Copy the line, or the path of a file |

While results are shown, the matches are also highlighted in open editors.
**CodeOnly: Go to Next Result** and **CodeOnly: Go to Previous Result** are in
the Command Palette; you can bind keys to them in Keyboard Shortcuts.

## Which files are filtered

Comments are recognised in files that use C comment syntax:
`.c .h .cc .cpp .cxx .hh .hpp .hxx .inl .S .dts .dtsi .dtso`.

Matches in other files, such as `Makefile` or `Kconfig`, are listed as they
are and marked *unfiltered*, so you do not lose usages there.

Text inside string literals counts as code.

## Settings

CodeOnly Search follows your existing search settings, including
`search.exclude`, `files.exclude`, `search.useIgnoreFiles`,
`search.followSymlinks`, `search.smartCase`, `search.maxResults`,
`search.searchOnType`, and `search.collapseResults`.

| Setting | Default | |
|---|---|---|
| `codeonly.diagnostics.logExcludedLines` | off | List every hidden line, and why it was hidden, in the **CodeOnly** output |
| `codeonly.ripgrepPath` | empty | Path to a `rg` executable to use instead of the one that comes with VS Code |

## Troubleshooting

**A line I expected is missing.** Click *comment-only lines hidden* under the
search box. It turns on `codeonly.diagnostics.logExcludedLines` if needed and
shows each hidden line with its reason in the **CodeOnly** output.

**"ripgrep was not found".** CodeOnly Search uses the search engine that comes
with VS Code. If it cannot be found, install
[ripgrep](https://github.com/BurntSushi/ripgrep) and either put `rg` on your
`PATH` or set `codeonly.ripgrepPath`.

**Only the first results are shown.** Searches stop at `search.maxResults`
(20,000 by default). Narrow the search, or raise the limit.

## Known limitations

- Only C comment syntax is recognised.
- A regular expression cannot match across lines.
- Files are read as UTF-8 or plain bytes; `files.encoding` is not applied.
  Matches in UTF-16 encoded C files are hidden.
- Only folders on disk can be searched, not virtual workspaces.
