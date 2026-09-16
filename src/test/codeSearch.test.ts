import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { REASON_COMMENT_ONLY } from "../classify/lineDecision";
import { type FileResult, type SearchRequest, SearchError, type SearchSummary, searchCode } from "../search/codeSearch";
import type { FolderOptions, SearchQuery } from "../search/query";
import { locateRipgrep } from "../search/ripgrep";

const FIXTURE = path.resolve(__dirname, "../../test-fixtures/workspace");

const options: FolderOptions = {
  excludes: ["**/.git"],
  useIgnoreFiles: true,
  useParentIgnoreFiles: false,
  useGlobalIgnoreFiles: false,
  followSymlinks: true,
  smartCase: false,
};

interface Outcome {
  readonly results: Map<string, FileResult>;
  readonly summary: SearchSummary;
}

let rgPath: string;

async function search(
  pattern: string,
  overrides: Partial<SearchQuery> = {},
  extra: Partial<Pick<SearchRequest, "maxResults" | "signal">> = {},
): Promise<Outcome> {
  const results = new Map<string, FileResult>();
  const summary = await searchCode({
    rgPath,
    query: { pattern, isRegExp: false, isCaseSensitive: true, isWordMatch: false, includes: [], excludes: [], ...overrides },
    folders: [{ path: FIXTURE, options }],
    onResult: (r) => {
      assert.ok(!results.has(r.relativePath), `duplicate result for ${r.relativePath}`);
      results.set(r.relativePath, r);
    },
    ...extra,
  });
  return { results, summary };
}

function shown(o: Outcome, rel: string): number[] {
  return (o.results.get(rel)?.lines ?? []).map((l) => l.lineNumber);
}

function hidden(o: Outcome, rel: string): [number, string][] {
  return (o.results.get(rel)?.excluded ?? []).map((l) => [l.lineNumber, l.reason]);
}

function filesWithLines(o: Outcome): string[] {
  return [...o.results.values()]
    .filter((r) => r.lines.length > 0)
    .map((r) => r.relativePath)
    .sort();
}

suite("code search pipeline", () => {
  suiteSetup(async () => {
    const found = await locateRipgrep(vscode.env.appRoot);
    assert.ok(found, "bundled ripgrep not found");
    rgPath = found;
  });

  test("comment-only lines are excluded, code and #if 0 lines kept (R1', R3)", async () => {
    const o = await search("widget_init");
    assert.deepEqual(shown(o, "src/main.c"), [3, 9]);
    assert.deepEqual(hidden(o, "src/main.c"), [
      [1, REASON_COMMENT_ONLY],
      [2, REASON_COMMENT_ONLY],
    ]);
  });

  test("mixed line is kept with only its code match highlighted (R2)", async () => {
    const o = await search("widget_count");
    assert.deepEqual(shown(o, "src/main.c"), [5, 14]);
    assert.deepEqual(hidden(o, "src/main.c"), [[12, REASON_COMMENT_ONLY]]);
    const line = o.results.get("src/main.c")!.lines[0];
    assert.equal(line.ranges.length, 1);
    assert.equal(line.ranges[0].start, line.text.indexOf("widget_count"));
  });

  test("lines after an unterminated comment are excluded (R4)", async () => {
    const o = await search("widget_broken");
    assert.deepEqual(shown(o, "src/broken.c"), [1]);
    assert.deepEqual(hidden(o, "src/broken.c"), [[3, "unclassifiable: unterminated block comment"]]);
  });

  test("apostrophe prose in #if 0 is excluded only on its own line", async () => {
    const o = await search("widget_prose");
    assert.deepEqual(shown(o, "src/prose.h"), [3]);
    assert.deepEqual(hidden(o, "src/prose.h"), [[2, "unclassifiable: unterminated character literal"]]);
  });

  test("string literal matches count as code", async () => {
    const o = await search("widget_str");
    const line = o.results.get("src/strings.c")!.lines[0];
    assert.equal(line.ranges.length, 1);
    assert.equal(line.text.slice(line.ranges[0].start, line.ranges[0].end), "widget_str");
    assert.ok(line.ranges[0].start < line.text.indexOf("/*"));
  });

  test("files outside the C family are listed unfiltered", async () => {
    const o = await search("widget_init");
    assert.deepEqual(filesWithLines(o), ["Makefile", "docs/notes.txt", "src/main.c"]);
    assert.equal(o.results.get("Makefile")!.filtered, false);
    assert.deepEqual(shown(o, "Makefile"), [1, 2]);
    assert.equal(o.results.get("src/main.c")!.filtered, true);
  });

  test("entries carry path, line number, and original text (IC1)", async () => {
    const o = await search("widget_init");
    const r = o.results.get("src/main.c")!;
    assert.equal(r.absolutePath, path.join(FIXTURE, "src", "main.c"));
    assert.equal(r.folder, FIXTURE);
    const fileLines = fs.readFileSync(r.absolutePath, "utf8").split("\n");
    for (const l of r.lines) {
      assert.equal(l.text, fileLines[l.lineNumber - 1]);
      for (const m of l.ranges) {
        assert.equal(l.text.slice(m.start, m.end), "widget_init");
      }
    }
  });

  test("UTF-8 BOM and CRLF files keep offsets aligned", async () => {
    const o = await search("widget_bom");
    assert.deepEqual(shown(o, "src/bom.c"), [2]);
    assert.deepEqual(hidden(o, "src/bom.c"), [[1, REASON_COMMENT_ONLY]]);
    assert.equal(o.results.get("src/bom.c")!.lines[0].text, "int widget_bom;");
  });

  test("non-UTF-8 bytes keep columns aligned", async () => {
    const o = await search("widget_latin");
    const line = o.results.get("src/latin1.c")!.lines[0];
    assert.equal(line.ranges.length, 1);
    assert.equal(line.text.slice(line.ranges[0].start, line.ranges[0].end), "widget_latin");
    assert.ok(line.ranges[0].start > line.text.indexOf("*/"));
  });

  test("summary counts shown and hidden lines", async () => {
    const o = await search("widget_init");
    assert.equal(o.summary.fileCount, 3);
    assert.equal(o.summary.lineCount, 5);
    assert.equal(o.summary.matchCount, 5);
    assert.equal(o.summary.excludedLineCount, 2);
    assert.equal(o.summary.limitHit, false);
    assert.equal(o.summary.cancelled, false);
  });

  test("result limit stops the search", async () => {
    const o = await search("widget_init", {}, { maxResults: 2 });
    assert.equal(o.summary.matchCount, 2);
    assert.equal(o.summary.limitHit, true);
    const total = [...o.results.values()].reduce((n, r) => n + r.lines.length, 0);
    assert.equal(total, 2);
  });

  test("include and exclude globs", async () => {
    assert.deepEqual(filesWithLines(await search("widget_init", { includes: ["./src"] })), ["src/main.c"]);
    // Same file set as the built-in Search view: a folder-relative include prunes other folders.
    assert.deepEqual(filesWithLines(await search("widget_init", { includes: ["./src", "*.txt"] })), ["src/main.c"]);
    assert.deepEqual(filesWithLines(await search("widget_init", { includes: ["./docs", "Makefile"] })), [
      "Makefile",
      "docs/notes.txt",
    ]);
    assert.deepEqual(filesWithLines(await search("widget_init", { excludes: ["*.txt", "Makefile"] })), ["src/main.c"]);
  });

  test("case-insensitive and whole-word search", async () => {
    assert.deepEqual(shown(await search("WIDGET_INIT", { isCaseSensitive: false }), "src/main.c"), [3, 9]);
    assert.deepEqual(filesWithLines(await search("widget", { isWordMatch: true })), []);
  });

  test("invalid regular expression is reported briefly, with ripgrep's text as detail", async () => {
    await assert.rejects(search("(", { isRegExp: true }), (e: unknown) => {
      assert.ok(e instanceof SearchError);
      assert.equal(e.message, "Invalid regular expression: unclosed group");
      assert.match(e.detail ?? "", /regex parse error/);
      return true;
    });
  });

  test("a newline in a regular expression is reported as unsupported", async () => {
    await assert.rejects(search("a\\nb", { isRegExp: true }), (e: unknown) => {
      assert.ok(e instanceof SearchError);
      assert.equal(e.message, "Multi-line patterns are not supported.");
      return true;
    });
    const escaped = await search("widget\\\\n", { isRegExp: true });
    assert.equal(escaped.summary.matchCount, 0);
  });

  test("query errors and ripgrep failures are told apart", async () => {
    await assert.rejects(search("(", { isRegExp: true }), (e: unknown) => e instanceof SearchError && !e.ripgrepFailed);
    await assert.rejects(
      searchCode({
        rgPath: "/nonexistent/rg",
        query: { pattern: "x", isRegExp: false, isCaseSensitive: true, isWordMatch: false, includes: [], excludes: [] },
        folders: [{ path: FIXTURE, options }],
        onResult: () => undefined,
      }),
      (e: unknown) => e instanceof SearchError && e.ripgrepFailed === true && /ripgrep/.test(e.message),
    );
  });

  test("an aborted search reports cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const o = await search("widget_init", {}, { signal: controller.signal });
    assert.equal(o.summary.cancelled, true);
    assert.equal(o.results.size, 0);
  });
});
