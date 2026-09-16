import * as assert from "node:assert/strict";
import { makePreview } from "../ui/preview";

function highlighted(text: string, ranges: { start: number; end: number }[]): string[] {
  const p = makePreview(text, ranges);
  return p.highlights.map(([s, e]) => p.label.slice(s, e));
}

suite("result preview", () => {
  test("leading indentation is dropped and highlights follow", () => {
    const p = makePreview("\t\tfoo(bar);", [{ start: 2, end: 5 }]);
    assert.equal(p.label, "foo(bar);");
    assert.deepEqual(p.highlights, [[0, 3]]);
  });

  test("tabs inside the line become single spaces", () => {
    const p = makePreview("a\tb", [{ start: 2, end: 3 }]);
    assert.equal(p.label, "a b");
    assert.deepEqual(p.highlights, [[2, 3]]);
  });

  test("a far match keeps some context and an ellipsis", () => {
    const text = `${"x".repeat(100)}match tail`;
    const p = makePreview(text, [{ start: 100, end: 105 }]);
    assert.ok(p.label.startsWith("…"), p.label);
    assert.ok(p.label.length < 60, p.label);
    assert.deepEqual(highlighted(text, [{ start: 100, end: 105 }]), ["match"]);
  });

  test("long lines are truncated and out-of-view highlights dropped", () => {
    const text = `a${"y".repeat(500)}zz`;
    const p = makePreview(text, [
      { start: 0, end: 1 },
      { start: 501, end: 503 },
    ]);
    assert.ok(p.label.endsWith("…"));
    assert.ok(p.label.length <= 260);
    assert.deepEqual(p.highlights, [[0, 1]]);
  });

  test("the cut never splits a surrogate pair", () => {
    const text = `${"😀".repeat(50)}match`;
    for (const start of [100, 101]) {
      const p = makePreview(text, [{ start, end: start + 5 }]);
      const body = p.label.slice(1);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(body), JSON.stringify(p.label.slice(0, 4)));
    }
  });

  test("no ranges gives the trimmed line", () => {
    assert.deepEqual(makePreview("   int x;  ", []), { label: "int x;", highlights: [] });
  });
});
