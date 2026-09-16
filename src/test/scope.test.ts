import * as assert from "node:assert/strict";
import { ScopeError, type ScopedFolder, resolveScope } from "../search/scope";

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
