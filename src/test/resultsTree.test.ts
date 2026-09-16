import * as assert from "node:assert/strict";
import type { FileResult } from "../search/codeSearch";
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
