import * as assert from "node:assert/strict";
import { compileGlobs } from "../search/glob";

function matches(glob: string, path: string, ignoreCase = false): boolean {
  const matcher = compileGlobs([glob], ignoreCase);
  assert.ok(matcher);
  return matcher(path);
}

suite("glob matching (VS Code semantics)", () => {
  test("no globs gives no matcher", () => {
    assert.equal(compileGlobs([], false), undefined);
  });

  test("a globstar in the middle spans any number of folders", () => {
    assert.ok(matches("src/**/*.c", "src/a.c"));
    assert.ok(matches("src/**/*.c", "src/sub/deep/a.c"));
    assert.ok(!matches("src/**/*.c", "src/b.txt"));
    assert.ok(!matches("src/**/*.c", "srcx/a.c"));
    assert.ok(!matches("src/**/*.c", "lib/src/a.c"));
  });

  test("a single star stays within one folder", () => {
    assert.ok(matches("drivers/*/foo.c", "drivers/net/foo.c"));
    assert.ok(!matches("drivers/*/foo.c", "drivers/Makefile"));
    assert.ok(!matches("drivers/*/foo.c", "drivers/a/b/foo.c"));
  });

  test("leading and trailing globstars", () => {
    assert.ok(matches("**/*.c", "a.c"));
    assert.ok(matches("**/*.c", "x/y/a.c"));
    assert.ok(!matches("**/*.c", "a.cc"));
    assert.ok(matches("src/**", "src"));
    assert.ok(matches("src/**", "src/a/b"));
    assert.ok(!matches("src/**", "srcx"));
    assert.ok(matches("**/build/**", "a/build/x.o"));
    assert.ok(matches("**", "any/thing"));
  });

  test("braces, classes, and question marks", () => {
    assert.ok(matches("**/*.{c,h}", "x/a.h"));
    assert.ok(!matches("**/*.{c,h}", "x/a.s"));
    assert.ok(matches("[ab].c", "b.c"));
    assert.ok(!matches("[!ab].c", "b.c"));
    assert.ok(matches("x[,]y", "x,y"));
    assert.ok(matches("?.c", "a.c"));
    assert.ok(!matches("?.c", "/.c"));
  });

  test("literal patterns match only themselves", () => {
    assert.ok(matches("src", "src"));
    assert.ok(!matches("src", "src/a.c"));
    assert.ok(!matches(".", "a.c"));
    assert.ok(matches("a+b(c).c", "a+b(c).c"));
  });

  test("a glob that cannot be compiled is dropped, as VS Code does", () => {
    const matcher = compileGlobs(["[b-a].c", "*.c"], false);
    assert.ok(matcher);
    assert.ok(matcher("x.c"));
    const none = compileGlobs(["[b-a].c"], false);
    assert.ok(none);
    assert.ok(!none("b.c"));
  });

  test("any of several globs, optionally ignoring case", () => {
    const matcher = compileGlobs(["src/**/*.c", "**/Makefile"], false);
    assert.ok(matcher);
    assert.ok(matcher("drivers/Makefile"));
    assert.ok(!matcher("drivers/makefile"));
    assert.ok(matches("**/Makefile", "drivers/makefile", true));
  });
});
