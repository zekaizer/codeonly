import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileResult } from "../search/codeSearch";
import { MatchHighlights } from "../ui/matchHighlights";
import { ResultsTree } from "../ui/resultsTree";

function result(text: string): FileResult {
  const at = text.indexOf("needle");
  return {
    folder: "/ws",
    relativePath: "data/huge.json",
    absolutePath: "/ws/data/huge.json",
    filtered: false,
    lines: [{ lineNumber: 1, text, ranges: [{ start: at, end: at + 6 }] }],
    excluded: [],
  };
}

suite("results tree items", () => {
  test("file and line ids never collide", () => {
    const tree = new ResultsTree(() => "alwaysExpand");
    try {
      const line = { lineNumber: 12, text: "needle", ranges: [{ start: 0, end: 6 }] };
      tree.add({ ...result("needle"), relativePath: "x.c", absolutePath: "/ws/x.c", lines: [line] });
      tree.add({ ...result("needle"), relativePath: "x.c:12", absolutePath: "/ws/x.c:12", lines: [line] });
      const ids = tree.getChildren().flatMap((f) => [f, ...tree.getChildren(f)]).map((n) => tree.getTreeItem(n).id);
      assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
    } finally {
      tree.dispose();
    }
  });

  test("very long lines are clipped in tooltips and accessibility labels", () => {
    const tree = new ResultsTree(() => "alwaysExpand");
    try {
      tree.add(result(`${"x".repeat(200_000)}needle${"y".repeat(200_000)}`));
      const [file] = tree.getChildren();
      const [line] = tree.getChildren(file);
      const item = tree.getTreeItem(line);
      assert.ok(String(item.tooltip).length <= 600, `tooltip length ${String(item.tooltip).length}`);
      assert.ok((item.accessibilityInformation?.label.length ?? 0) <= 600);
      const label = typeof item.label === "string" ? item.label : (item.label?.label ?? "");
      assert.ok(label.includes("needle"));
    } finally {
      tree.dispose();
    }
  });
});

suite("editor highlights", () => {
  test("a document edited while the search runs gets no highlights", async () => {
    const file = path.resolve(__dirname, "../../test-fixtures/workspace/src/main.c");
    const uri = vscode.Uri.file(file);
    const tree = new ResultsTree(() => "alwaysExpand");
    const highlights = new MatchHighlights(tree, () => true);
    const editor = await vscode.window.showTextDocument(uri);
    try {
      tree.reset([]);
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), "\n"));
      tree.add({
        folder: path.dirname(file),
        relativePath: "main.c",
        absolutePath: file,
        filtered: true,
        lines: [{ lineNumber: 3, text: "static int widget_init(void)", ranges: [{ start: 11, end: 22 }] }],
        excluded: [],
      });
      tree.refresh();
      assert.deepEqual(highlights.rangesFor(uri), []);
    } finally {
      highlights.dispose();
      tree.dispose();
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });
});
