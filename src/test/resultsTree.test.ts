import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileResult } from "../search/codeSearch";
import { EMPTY_FORM } from "../shared/protocol";
import { MatchHighlights } from "../ui/matchHighlights";
import { ResultsTree } from "../ui/resultsTree";
import { SearchController } from "../ui/searchController";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fileResult(i: number, lineCount = 1): FileResult {
  return {
    ...result("needle"),
    relativePath: `f${i}.c`,
    absolutePath: `/ws/f${i}.c`,
    lines: Array.from({ length: lineCount }, (_, n) => ({ lineNumber: n + 1, text: "needle", ranges: [{ start: 0, end: 6 }] })),
  };
}

suite("results tree pacing", () => {
  let tree: ResultsTree;
  let events: (unknown | undefined)[];
  let stamps: number[];
  let sub: vscode.Disposable;

  setup(() => {
    tree = new ResultsTree(() => "alwaysExpand");
    events = [];
    stamps = [];
    sub = tree.onDidChangeTreeData((e) => {
      events.push(e);
      stamps.push(Date.now());
    });
  });

  teardown(() => {
    sub.dispose();
    tree.dispose();
  });

  test("changes during a search are pushed further apart than VS Code's 200 ms tree debounce", async () => {
    const read = tree.onDidChangeTreeData(() => tree.getChildren());
    try {
      const started = Date.now();
      for (let i = 0; Date.now() - started < 1200; i++) {
        tree.add(fileResult(i));
        await sleep(20);
      }
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
      assert.ok(stamps.length >= 2, `only ${stamps.length} refreshes`);
      assert.ok(Math.min(...gaps) > 220, JSON.stringify(gaps));
    } finally {
      read.dispose();
    }
  });

  test("no refresh is pushed until the view has read the previous one", async () => {
    tree.add(fileResult(0));
    await sleep(400);
    assert.equal(stamps.length, 1);
    for (let i = 1; i < 40; i++) {
      tree.add(fileResult(i));
      await sleep(20);
    }
    assert.equal(stamps.length, 1);
    tree.getChildren();
    await sleep(400);
    assert.equal(stamps.length, 2);
  });

  test("the pause after a refresh grows with how long the view took to read it", async () => {
    tree.add(fileResult(0));
    await sleep(350);
    assert.equal(stamps.length, 1);
    const [file] = tree.getChildren();
    await sleep(500);
    tree.getChildren(file);
    const lastRead = Date.now();
    for (let i = 1; Date.now() - lastRead < 1500; i++) {
      tree.add(fileResult(i));
      await sleep(20);
    }
    assert.equal(stamps.length, 2);
    assert.ok(stamps[1] - lastRead >= 950, `${stamps[1] - lastRead} ms after the last read`);
  });

  test("flush pushes pending results at once, and nothing when none are pending", () => {
    tree.add(fileResult(0));
    tree.flush();
    assert.deepEqual(events, [undefined]);
    tree.getChildren();
    tree.flush();
    assert.deepEqual(events, [undefined]);
  });

  test("a new search keeps the old results in the view until it has results to show", async () => {
    tree.add(fileResult(0));
    tree.flush();
    tree.getChildren();
    assert.ok(tree.showsResults);
    events.length = 0;
    tree.reset([], true);
    await sleep(100);
    assert.deepEqual(events, []);
    assert.ok(tree.showsResults);
    tree.add(fileResult(1));
    tree.flush();
    assert.deepEqual(events, [undefined]);
    assert.deepEqual(
      tree.getChildren().map((f) => (f.kind === "file" ? f.result.relativePath : "")),
      ["f1.c"],
    );
  });

  test("an empty new search shows the empty list after the usual pause", async () => {
    tree.add(fileResult(0));
    tree.flush();
    tree.getChildren();
    events.length = 0;
    tree.reset([], true);
    await sleep(450);
    assert.deepEqual(events, [undefined]);
    assert.ok(!tree.showsResults);
  });

  test("the view counts as showing a file once it has read the tree after the file was added", () => {
    tree.add(fileResult(0));
    const [file] = tree.roots();
    assert.ok(!tree.isShown(file));
    tree.flush();
    assert.ok(!tree.isShown(file));
    tree.getChildren();
    assert.ok(tree.isShown(file));
  });

  test("dismissing with flush pushes pending results in the same refresh", () => {
    tree.add(fileResult(0, 2));
    tree.flush();
    const [file] = tree.getChildren();
    const [line] = tree.getChildren(file);
    tree.add(fileResult(1));
    events.length = 0;
    tree.dismiss(line, true);
    assert.deepEqual(events, [undefined]);
    assert.equal(tree.roots().length, 2);
  });

  test("dismissing a line without flush refreshes only its file", () => {
    tree.add(fileResult(0, 2));
    tree.flush();
    const [file] = tree.getChildren();
    const [line] = tree.getChildren(file);
    tree.add(fileResult(1));
    events.length = 0;
    tree.dismiss(line);
    assert.deepEqual(events, [file]);
  });
});

suite("results view status", () => {
  let messages: (string | undefined)[];
  let tree: ResultsTree;
  let controller: SearchController;

  setup(() => {
    messages = [];
    let message: string | undefined;
    const view = {
      get message() {
        return message;
      },
      set message(value: string | undefined) {
        messages.push(value);
        message = value;
      },
      description: undefined as string | undefined,
    } as unknown as vscode.TreeView<unknown>;
    const state = { get: (_k: string, d?: unknown) => d, update: async () => undefined, keys: () => [] } as unknown as vscode.Memento;
    const log = { info() {}, warn() {}, error() {}, show() {} } as unknown as vscode.LogOutputChannel;
    tree = new ResultsTree(() => "alwaysExpand");
    controller = new SearchController(state, tree, view, log);
  });

  teardown(() => {
    controller.dispose();
    tree.dispose();
  });

  test("an unchanged message is not assigned again, since each assignment delays the tree refresh", () => {
    controller.clear();
    controller.clear();
    assert.deepEqual(messages, []);
  });

  test("a search says it is searching only once the view shows no results", async () => {
    tree.add(fileResult(0));
    tree.flush();
    tree.getChildren();
    const summary = await controller.search({ ...EMPTY_FORM, pattern: "widget_init" }, false);
    assert.ok(summary && summary.matchCount > 0);
    assert.ok(!messages.includes("Searching…"), JSON.stringify(messages));
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
