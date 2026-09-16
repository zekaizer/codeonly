import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CodeOnlyApi, ResultEntry } from "../api";
import { EMPTY_FORM } from "../shared/protocol";

const FIXTURE = path.resolve(__dirname, "../../test-fixtures/workspace");

function labelOf(item: vscode.TreeItem): string {
  const label = item.label;
  return typeof label === "string" ? label : (label?.label ?? "");
}

function fileEntry(tree: readonly ResultEntry[], rel: string): ResultEntry {
  const entry = tree.find((e) => e.item.resourceUri?.fsPath === path.join(FIXTURE, rel));
  assert.ok(entry, `no result entry for ${rel}`);
  return entry;
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

suite("search UI", () => {
  let api: CodeOnlyApi;
  const base = { ...EMPTY_FORM, isCaseSensitive: true };

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<CodeOnlyApi>("zekaizer.codeonly");
    assert.ok(ext);
    api = await ext.activate();
    assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, FIXTURE);
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("results tree lists only code lines, grouped by file (R1', IC1)", async () => {
    const summary = await api.search({ ...base, pattern: "widget_init" });
    assert.equal(summary?.matchCount, 5);
    const tree = await api.resultTree();
    const main = fileEntry(tree, "src/main.c");
    assert.deepEqual(main.children.map((c) => labelOf(c.item)), ["static int widget_init(void)", "widget_init();"]);
    assert.equal(main.item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.equal(main.item.iconPath, vscode.ThemeIcon.File);
    const first = main.children[0].item;
    assert.equal(first.description, undefined);
    assert.match(String(first.tooltip), /src\/main\.c:3\b/);
    assert.ok(first.label && typeof first.label !== "string");
    assert.deepEqual(first.label.highlights, [[11, 22]]);
    assert.equal(api.status().kind, "done");
  });

  test("non-C files are marked unfiltered", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    const tree = await api.resultTree();
    assert.match(String(fileEntry(tree, "Makefile").item.description), /unfiltered/);
    assert.doesNotMatch(String(fileEntry(tree, "src/main.c").item.description), /unfiltered/);
  });

  test("selecting a result opens the file at that line (R5)", async () => {
    await api.search({ ...base, pattern: "widget_count" });
    const main = fileEntry(await api.resultTree(), "src/main.c");
    const command = main.children[1].item.command;
    assert.ok(command);
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    assert.equal(editor.document.uri.fsPath, path.join(FIXTURE, "src/main.c"));
    assert.equal(editor.selection.active.line, 13);
    assert.equal(editor.document.getText(editor.selection), "widget_count");
  });

  test("hidden lines are reported when diagnostics are enabled (NFR2)", async () => {
    const config = vscode.workspace.getConfiguration("codeonly");
    await config.update("diagnostics.logExcludedLines", true, vscode.ConfigurationTarget.Global);
    try {
      await api.search({ ...base, pattern: "widget_init" });
      const report = api.hiddenLineReport();
      assert.ok(
        report.some((l) => l.includes("src/main.c:1") && l.includes("comment-only match")),
        report.join("\n"),
      );
    } finally {
      await config.update("diagnostics.logExcludedLines", undefined, vscode.ConfigurationTarget.Global);
    }
    await api.search({ ...base, pattern: "widget_init" });
    assert.deepEqual(api.hiddenLineReport(), []);
  });

  test("status counts hidden and unfiltered results", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    const status = api.status();
    assert.equal(status.kind, "done");
    if (status.kind === "done") {
      assert.equal(status.matchCount, 5);
      assert.equal(status.fileCount, 3);
      assert.equal(status.hiddenLineCount, 2);
      assert.equal(status.unfilteredFileCount, 2);
    }
  });

  test("focus command runs the search for a newly seeded term", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    const doc = await vscode.workspace.openTextDocument(path.join(FIXTURE, "src/main.c"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(4, 12, 4, 12);
    await vscode.commands.executeCommand("codeonly.focusSearch");
    assert.equal(api.form().pattern, "widget_count");
    const status = api.status();
    assert.equal(status.kind, "done");
    assert.deepEqual(
      fileEntry(await api.resultTree(), "src/main.c").children.map((c) => labelOf(c.item)),
      ["return widget_count; /* widget_count */", "int total = widget_count + 1;"],
    );
  });

  test("focus command seeds the query from the selection, else the word at the cursor", async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(FIXTURE, "src/main.c"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(2, 11, 2, 22);
    await vscode.commands.executeCommand("codeonly.focusSearch");
    assert.equal(api.form().pattern, "widget_init");

    await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(4, 12, 4, 12);
    await vscode.commands.executeCommand("codeonly.focusSearch");
    assert.equal(api.form().pattern, "widget_count");
  });

  test("the focus command can keep the current term", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    const doc = await vscode.workspace.openTextDocument(path.join(FIXTURE, "src/main.c"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(4, 12, 4, 12);
    await vscode.commands.executeCommand("codeonly.focusSearch", { seed: false });
    assert.equal(api.form().pattern, "widget_init");
  });

  test("the shortcut does not reseed from inside the view, and Ctrl+Up returns to the search box", () => {
    const ext = vscode.extensions.getExtension("zekaizer.codeonly");
    const keys = (ext?.packageJSON.contributes.keybindings ?? []) as {
      command: string;
      key: string;
      when?: string;
      args?: unknown;
    }[];
    const focus = keys.filter((k) => k.command === "codeonly.focusSearch");
    // Focus inside the webview is not visible to `focusedView`; the view reports it instead.
    const inView = focus.find((k) => k.key === "ctrl+shift+alt+f" && k.args);
    assert.equal(inView?.when, "codeonly.queryFocused || focusedView == 'codeonly.results'");
    assert.deepEqual(inView?.args, { seed: false });
    const outside = focus.find((k) => k.key === "ctrl+shift+alt+f" && !k.args);
    assert.equal(outside?.when, "!codeonly.queryFocused && focusedView != 'codeonly.results'");
    const back = focus.find((k) => k.key === "ctrl+up");
    assert.equal(back?.when, "focusedView == 'codeonly.results'");
    assert.deepEqual(back?.args, { seed: false });
  });

  test("hasPattern follows the search term, and Search Again and Clear use it", async () => {
    await api.search({ ...base, pattern: "widget_count" });
    for (const entry of await api.resultTree()) {
      await vscode.commands.executeCommand("codeonly.dismiss", entry.node);
    }
    assert.equal(api.contextKeys()["codeonly.hasPattern"], true);
    await vscode.commands.executeCommand("codeonly.clear");
    assert.equal(api.contextKeys()["codeonly.hasPattern"], false);
    const ext = vscode.extensions.getExtension("zekaizer.codeonly");
    const commands = (ext?.packageJSON.contributes.commands ?? []) as { command: string; enablement?: string }[];
    assert.equal(commands.find((c) => c.command === "codeonly.rerun")?.enablement, "codeonly.hasPattern");
    assert.equal(
      commands.find((c) => c.command === "codeonly.clear")?.enablement,
      "codeonly.hasPattern || codeonly.hasResults || codeonly.state != idle",
    );
  });

  test("the hidden-lines link searches again when the lines were not recorded", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    assert.deepEqual(api.hiddenLineReport(), []);
    const config = vscode.workspace.getConfiguration("codeonly");
    await config.update("diagnostics.logExcludedLines", true, vscode.ConfigurationTarget.Global);
    try {
      await api.statusCommand("showHiddenLines");
      assert.ok(api.hiddenLineReport().some((l) => l.includes("src/main.c:1")));
    } finally {
      await config.update("diagnostics.logExcludedLines", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("opening the same result twice keeps the editor and moves focus to it", async () => {
    await api.search({ ...base, pattern: "widget_count" });
    const command = fileEntry(await api.resultTree(), "src/main.c").children[1].item.command;
    assert.ok(command);
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, true);
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, false);
  });

  test("errors point at the field they are about", async () => {
    const fieldOf = () => {
      const status = api.status();
      return status.kind === "error" ? status.field : `not an error: ${status.kind}`;
    };
    await api.search({ ...base, pattern: "(", isRegExp: true });
    assert.equal(fieldOf(), "pattern");
    await api.search({ ...base, pattern: "widget_init", isRegExp: false, includes: "{a" });
    assert.equal(fieldOf(), "includes");
    assert.equal(api.form().showDetails, true);
    await api.search({ ...base, pattern: "widget_init", includes: "", excludes: "[z" });
    assert.equal(fieldOf(), "excludes");
    await api.search({ excludes: "" });
  });

  test("query view script starts", async () => {
    await vscode.commands.executeCommand("codeonly.query.focus");
    await withTimeout(api.queryViewReady(), 15000, "query view ready");
  });

  test("find in folder scopes the query to that folder", async () => {
    await vscode.commands.executeCommand("codeonly.findInFolder", vscode.Uri.file(path.join(FIXTURE, "src")));
    assert.equal(api.form().includes, "./src");
    assert.equal(api.form().showDetails, true);
    const summary = await api.search({ pattern: "widget_init" });
    assert.equal(summary?.fileCount, 1);
    await api.search({ includes: "" });
  });

  test("an absolute path in include searches that path and keeps workspace-relative names", async () => {
    const summary = await api.search({ ...base, pattern: "widget_init", includes: path.join(FIXTURE, "src") });
    assert.equal(summary?.fileCount, 1);
    const main = fileEntry(await api.resultTree(), "src/main.c");
    assert.match(String(main.item.description), /^src\b/);
    await api.search({ includes: "" });
  });

  test("search paths that do not exist are dropped, and an error names one if none exist", async () => {
    const some = await api.search({ ...base, pattern: "widget_init", includes: "../codeonly-no-such-dir, ./src" });
    assert.equal(some?.fileCount, 1);
    assert.equal(await api.search({ ...base, pattern: "widget_init", includes: "/codeonly/no/such/dir" }), undefined);
    const status = api.status();
    assert.equal(status.kind, "error");
    if (status.kind === "error") {
      assert.equal(status.message, "Search path not found: /codeonly/no/such/dir");
      assert.equal(status.field, "includes");
    }
    await api.search({ includes: "" });
  });

  test("a file path in include searches that file", async () => {
    const summary = await api.search({ ...base, pattern: "widget_init", includes: path.join(FIXTURE, "src", "main.c") });
    assert.equal(summary?.fileCount, 1);
    assert.ok(fileEntry(await api.resultTree(), "src/main.c"));
    await api.search({ includes: "" });
  });

  test("an invalid range in an include glob is reported as a file pattern error", async () => {
    await api.search({ ...base, pattern: "widget_init", includes: "[b-a].c" });
    const status = api.status();
    assert.equal(status.kind, "error");
    if (status.kind === "error") {
      assert.match(status.message, /^Invalid file pattern/);
      assert.equal(status.field, "includes");
    }
    await api.search({ includes: "" });
  });

  test("dismiss removes a result and clear removes all", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    const main = fileEntry(await api.resultTree(), "src/main.c");
    await vscode.commands.executeCommand("codeonly.dismiss", main.children[0].node);
    assert.equal(fileEntry(await api.resultTree(), "src/main.c").children.length, 1);

    await vscode.commands.executeCommand("codeonly.dismiss", fileEntry(await api.resultTree(), "Makefile").node);
    assert.ok(!(await api.resultTree()).some((e) => e.item.resourceUri?.fsPath === path.join(FIXTURE, "Makefile")));

    await vscode.commands.executeCommand("codeonly.clear");
    assert.deepEqual(await api.resultTree(), []);
    assert.equal(api.status().kind, "idle");
  });

  test("code matches are highlighted in open editors, not comment matches", async () => {
    await vscode.commands.executeCommand("codeonly.results.focus");
    await api.search({ ...base, pattern: "widget_count" });
    const uri = vscode.Uri.file(path.join(FIXTURE, "src/main.c"));
    const editor = await vscode.window.showTextDocument(uri);
    const spans = () => api.highlightedRanges(uri).map((r) => [r.start.line, r.start.character, r.end.character]);
    assert.deepEqual(spans(), [
      [4, 8, 20],
      [13, 12, 24],
    ]);

    await editor.edit((b) => b.insert(new vscode.Position(0, 0), "\n"));
    assert.deepEqual(spans(), []);
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  test("an unsaved document gets no highlights, since the search read the file on disk", async () => {
    await vscode.commands.executeCommand("codeonly.results.focus");
    const uri = vscode.Uri.file(path.join(FIXTURE, "src/main.c"));
    const editor = await vscode.window.showTextDocument(uri);
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), "\n"));
    try {
      await api.search({ ...base, pattern: "widget_count" });
      assert.deepEqual(api.highlightedRanges(uri), []);
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });

  test("dismissing every result returns to the idle state", async () => {
    await api.search({ ...base, pattern: "widget_count" });
    for (const entry of await api.resultTree()) {
      await vscode.commands.executeCommand("codeonly.dismiss", entry.node);
    }
    assert.deepEqual(await api.resultTree(), []);
    assert.equal(api.status().kind, "idle");
    assert.equal(api.form().pattern, "widget_count");
  });

  test("status counts follow dismissals", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    await vscode.commands.executeCommand("codeonly.dismiss", fileEntry(await api.resultTree(), "Makefile").node);
    const status = api.status();
    assert.equal(status.kind, "done");
    if (status.kind === "done") {
      assert.equal(status.matchCount, 3);
      assert.equal(status.fileCount, 2);
      assert.equal(status.unfilteredFileCount, 1);
    }
  });

  test("find in folder takes every selected folder", async () => {
    const src = vscode.Uri.file(path.join(FIXTURE, "src"));
    const docs = vscode.Uri.file(path.join(FIXTURE, "docs"));
    await vscode.commands.executeCommand("codeonly.findInFolder", src, [src, docs]);
    assert.equal(api.form().includes, "./src, ./docs");
    await api.search({ includes: "" });
  });

  test("highlights follow dismissals and clear with the results", async () => {
    await vscode.commands.executeCommand("codeonly.results.focus");
    await api.search({ ...base, pattern: "widget_count" });
    const uri = vscode.Uri.file(path.join(FIXTURE, "src/main.c"));
    await vscode.window.showTextDocument(uri);
    const main = fileEntry(await api.resultTree(), "src/main.c");
    await vscode.commands.executeCommand("codeonly.dismiss", main.children[0].node);
    assert.deepEqual(
      api.highlightedRanges(uri).map((r) => r.start.line),
      [13],
    );
    await vscode.commands.executeCommand("codeonly.clear");
    assert.deepEqual(api.highlightedRanges(uri), []);
  });

  test("an invalid regular expression reports an error", async () => {
    const summary = await api.search({ ...base, pattern: "(", isRegExp: true });
    assert.equal(summary, undefined);
    assert.deepEqual(await api.resultTree(), []);
    const status = api.status();
    assert.equal(status.kind, "error");
    if (status.kind === "error") {
      assert.equal(status.message, "Invalid regular expression: missing closing parenthesis");
    }
    await api.search({ isRegExp: false });
  });

  test("superseding a running search leaves no stale searching state", async () => {
    for (const stop of [
      () => vscode.commands.executeCommand("codeonly.clear"),
      () => api.search({ pattern: "" }),
    ]) {
      const pending = api.search({ ...base, pattern: "widget" });
      await waitFor(() => api.status().kind === "searching");
      await stop();
      await pending;
      assert.equal(api.contextKeys()["codeonly.searching"], false);
      assert.equal(api.contextKeys()["codeonly.state"], "idle");
    }
    await api.search({ ...base, pattern: "widget_init" });
    assert.equal(api.contextKeys()["codeonly.searching"], false);
    assert.equal(api.contextKeys()["codeonly.hasResults"], true);
  });

  test("a search that cannot start clears the previous results", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    assert.notDeepEqual(await api.resultTree(), []);
    const config = vscode.workspace.getConfiguration("codeonly");
    await config.update("ripgrepPath", "/nonexistent/rg", vscode.ConfigurationTarget.Global);
    try {
      assert.equal(await api.search({ ...base, pattern: "widget_init" }), undefined);
      assert.equal(api.status().kind, "error");
      assert.deepEqual(await api.resultTree(), []);
      assert.equal(api.contextKeys()["codeonly.hasResults"], false);
    } finally {
      await config.update("ripgrepPath", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("an empty pattern clears the results", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    assert.notDeepEqual(await api.resultTree(), []);
    assert.equal(await api.search({ pattern: "" }), undefined);
    assert.deepEqual(await api.resultTree(), []);
    assert.equal(api.status().kind, "idle");
  });
});
