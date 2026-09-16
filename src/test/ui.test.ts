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

  test("an invalid regular expression reports an error", async () => {
    const summary = await api.search({ ...base, pattern: "(", isRegExp: true });
    assert.equal(summary, undefined);
    assert.deepEqual(await api.resultTree(), []);
    const status = api.status();
    assert.equal(status.kind, "error");
    if (status.kind === "error") {
      assert.equal(status.message, "Invalid regular expression: unclosed group");
    }
    await api.search({ isRegExp: false });
  });

  test("an empty pattern clears the results", async () => {
    await api.search({ ...base, pattern: "widget_init" });
    assert.notDeepEqual(await api.resultTree(), []);
    assert.equal(await api.search({ pattern: "" }), undefined);
    assert.deepEqual(await api.resultTree(), []);
    assert.equal(api.status().kind, "idle");
  });
});
