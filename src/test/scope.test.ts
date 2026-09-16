import * as assert from "node:assert/strict";
import * as path from "node:path";
import { compileGlobs } from "../search/glob";
import { ScopeError, type ScopedFolder, deepestRoot, resolveScope, searchPathFor } from "../search/scope";

const HOME = "/home/me";
const single = [{ name: "ws", path: "/ws" }];
const multi = [
  { name: "a", path: "/root/a" },
  { name: "b", path: "/root/b" },
];

function scope(includes: string, excludes = "", roots = single): ScopedFolder[] {
  return resolveScope(includes, excludes, roots, HOME);
}

suite("search scope (VS Code include/exclude semantics)", () => {
  test("no patterns searches every root", () => {
    assert.deepEqual(scope("", "", multi), [
      { path: "/root/a", includes: [], excludes: [] },
      { path: "/root/b", includes: [], excludes: [] },
    ]);
  });

  test("plain globs match at any depth in every root", () => {
    assert.deepEqual(scope("*.c, drivers/", "", multi), [
      { path: "/root/a", includes: ["**/*.c/**", "**/*.c", "**/drivers/**", "**/drivers"], excludes: [] },
      { path: "/root/b", includes: ["**/*.c/**", "**/*.c", "**/drivers/**", "**/drivers"], excludes: [] },
    ]);
  });

  test("a glob starting with a dot is an extension", () => {
    assert.deepEqual(scope(".c", ".o"), [{ path: "/ws", includes: ["**/*.c/**", "**/*.c"], excludes: ["**/*.o/**", "**/*.o"] }]);
  });

  test("./path is relative to the single root, with its glob part kept", () => {
    assert.deepEqual(scope("./src"), [{ path: "/ws", includes: ["src", "src/**"], excludes: [] }]);
    assert.deepEqual(scope("./src/**/*.c"), [{ path: "/ws", includes: ["src/**/*.c", "src/**/*.c/**"], excludes: [] }]);
    assert.deepEqual(scope(".\\src\\"), [{ path: "/ws", includes: ["src", "src/**"], excludes: [] }]);
    assert.deepEqual(scope("./*.c"), [{ path: "/ws", includes: ["*.c", "*.c/**"], excludes: [] }]);
    assert.deepEqual(scope("./"), [{ path: "/ws", includes: [], excludes: [] }]);
  });

  test("search paths are combined with plain globs", () => {
    assert.deepEqual(scope("./src, *.txt"), [{ path: "/ws", includes: ["src", "src/**", "**/*.txt/**", "**/*.txt"], excludes: [] }]);
  });

  test("absolute, home, and parent paths become search roots", () => {
    assert.deepEqual(scope("/ws/src/"), [{ path: "/ws/src", includes: [], excludes: [] }]);
    assert.deepEqual(scope("~/proj"), [{ path: "/home/me/proj", includes: [], excludes: [] }]);
    assert.deepEqual(scope("../other/lib"), [{ path: "/other/lib", includes: [], excludes: [] }]);
    assert.deepEqual(scope("/ws/src/*.c"), [{ path: "/ws/src", includes: ["*.c", "*.c/**"], excludes: [] }]);
  });

  test("in a multi-root workspace ./<name> limits the search to that folder", () => {
    assert.deepEqual(scope("./a/src, *.c", "", multi), [
      { path: "/root/a", includes: ["src", "src/**", "**/*.c/**", "**/*.c"], excludes: [] },
    ]);
    assert.deepEqual(scope("./b", "", multi), [{ path: "/root/b", includes: [], excludes: [] }]);
    assert.deepEqual(scope("./a/x, ./a/y", "", multi), [
      { path: "/root/a", includes: ["x", "x/**", "y", "y/**"], excludes: [] },
    ]);
    assert.deepEqual(scope("./", "", multi).length, 2);
  });

  test("a lone dot is kept as a literal pattern, as VS Code does", () => {
    assert.deepEqual(scope("."), [{ path: "/ws", includes: [".", "./**"], excludes: [] }]);
    assert.deepEqual(scope("", "."), [{ path: "/ws", includes: [], excludes: [".", "./**"] }]);
    assert.deepEqual(scope("./."), scope("."));
  });

  test("an unknown folder name is an error", () => {
    assert.throws(() => scope("./nope/src", "", multi), (e: unknown) => e instanceof ScopeError && /nope/.test(e.message));
  });

  test("excluded search paths apply to their own root only", () => {
    assert.deepEqual(scope("", "./src", single), [{ path: "/ws", includes: [], excludes: ["src", "src/**"] }]);
    assert.deepEqual(scope("", "./a", multi), [{ path: "/root/b", includes: [], excludes: [] }]);
    assert.deepEqual(scope("", "./a/gen, *.o", multi), [
      { path: "/root/a", includes: [], excludes: ["gen", "gen/**", "**/*.o/**", "**/*.o"] },
      { path: "/root/b", includes: [], excludes: ["**/*.o/**", "**/*.o"] },
    ]);
  });

  test("an excluded absolute path is ignored unless it is a searched root", () => {
    assert.deepEqual(scope("", "/ws/src"), [{ path: "/ws", includes: [], excludes: [] }]);
    assert.deepEqual(scope("/ws/src", "/ws/src"), []);
  });

  test("commas inside groups and classes do not split", () => {
    assert.deepEqual(scope("{a,b}.c, ./x[,]y"), [
      { path: "/ws", includes: ["x[,]y", "x[,]y/**", "**/{a,b}.c/**", "**/{a,b}.c"], excludes: [] },
    ]);
  });
});

suite("search path for an Explorer selection", () => {
  test("single root: a relative path with glob characters escaped", () => {
    assert.equal(searchPathFor("/ws/src/a,b", single[0], single), "./src/a[,]b");
    assert.equal(searchPathFor("/ws", single[0], single), "");
  });

  test("multi-root: prefixed with the folder name", () => {
    assert.equal(searchPathFor("/root/a/src", multi[0], multi), "./a/src");
    assert.equal(searchPathFor("/root/b", multi[1], multi), "./b");
  });

  test("multi-root folders with the same name are named by absolute path", () => {
    const roots = [
      { name: "drivers", path: "/a/drivers" },
      { name: "drivers", path: "/b/drivers" },
    ];
    const gpu = searchPathFor("/a/drivers/gpu", roots[0], roots);
    assert.equal(gpu, "/a/drivers/gpu");
    assert.deepEqual(resolveScope(gpu, "", roots, HOME), [{ path: "/a/drivers/gpu", includes: [], excludes: [] }]);
    const whole = searchPathFor("/b/drivers", roots[1], roots);
    assert.deepEqual(resolveScope(whole, "", roots, HOME), [{ path: "/b/drivers", includes: [], excludes: [] }]);
  });

  test("multi-root folder names with glob characters fall back to an absolute path that still resolves", () => {
    const odd = { name: "a[1]", path: "/root/a[1]" };
    const roots = [odd, multi[1]];
    const text = searchPathFor("/root/a[1]/src", odd, roots);
    assert.equal(text, "/root/a[[]1[]]/src");
    const [scoped] = resolveScope(text, "", roots, HOME);
    const matcher = compileGlobs(scoped.includes, false);
    assert.ok(matcher);
    assert.ok(matcher(path.posix.relative(scoped.path, "/root/a[1]/src/x.c")));
    assert.ok(!matcher(path.posix.relative(scoped.path, "/root/a[1]/lib/x.c")));
  });

  test("scope errors name the field they come from", () => {
    assert.throws(() => resolveScope("", "./nope", multi, HOME), (e: unknown) => e instanceof ScopeError && e.field === "excludes");
    assert.throws(() => resolveScope("./nope", "", multi, HOME), (e: unknown) => e instanceof ScopeError && e.field === "includes");
  });
});

suite("owning search root", () => {
  test("a file belongs to the deepest searched root that contains it", () => {
    const roots = ["/w/a", "/w/a/b", "/w/c"];
    assert.equal(deepestRoot("/w/a/b/x.c", roots), "/w/a/b");
    assert.equal(deepestRoot("/w/a/x.c", roots), "/w/a");
    assert.equal(deepestRoot("/w/ab/x.c", roots), undefined);
    assert.equal(deepestRoot("/w/c/d/x.c", roots), "/w/c");
  });
});
