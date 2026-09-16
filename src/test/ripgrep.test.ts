import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type FolderOptions, type SearchQuery, escapeGlob, splitGlobList } from "../search/query";
import { buildRipgrepArgs, locateRipgrep, ripgrepCandidates } from "../search/ripgrep";

const folder: FolderOptions = {
  excludes: ["**/.git"],
  useIgnoreFiles: true,
  useParentIgnoreFiles: false,
  useGlobalIgnoreFiles: false,
  followSymlinks: true,
  smartCase: false,
  ignoreGlobCase: false,
};

function query(pattern: string, overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { pattern, isRegExp: false, isCaseSensitive: false, isWordMatch: false, includes: [], excludes: [], ...overrides };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

function globs(args: string[]): string[] {
  return args.flatMap((a, i) => (a === "-g" ? [args[i + 1]] : []));
}

suite("ripgrep arguments", () => {
  test("literal search mirrors VS Code's argument set", () => {
    assert.deepEqual(buildRipgrepArgs(query("foo"), folder), [
      "--hidden",
      "--no-require-git",
      "--ignore-case",
      "-g",
      "!**/.git",
      "--no-ignore-parent",
      "--follow",
      "--crlf",
      "--fixed-strings",
      "--no-config",
      "--no-ignore-global",
      "--json",
      "--",
      "foo",
      ".",
    ]);
  });

  test("a literal starting with a dash stays after --", () => {
    const args = buildRipgrepArgs(query("--help"), folder);
    assert.deepEqual(args.slice(-3), ["--", "--help", "."]);
  });

  test("regular expression", () => {
    const args = buildRipgrepArgs(query("foo(_bar)?", { isRegExp: true }), folder);
    assert.equal(valueAfter(args, "--regexp"), "foo(_bar)?");
    assert.equal(valueAfter(args, "--engine"), "auto");
    assert.ok(!args.includes("--fixed-strings"));
    assert.deepEqual(args.slice(-2), ["--", "."]);
  });

  test("whole word adds boundaries only next to word characters", () => {
    assert.equal(valueAfter(buildRipgrepArgs(query("foo.bar", { isWordMatch: true }), folder), "--regexp"), "\\bfoo\\.bar\\b");
    assert.equal(valueAfter(buildRipgrepArgs(query("(x", { isWordMatch: true }), folder), "--regexp"), "\\(x\\b");
    assert.equal(
      valueAfter(buildRipgrepArgs(query("a|b", { isWordMatch: true, isRegExp: true }), folder), "--regexp"),
      "\\ba|b\\b",
    );
  });

  test("case sensitivity and smart case", () => {
    assert.ok(buildRipgrepArgs(query("foo", { isCaseSensitive: true }), folder).includes("--case-sensitive"));
    const smart = { ...folder, smartCase: true };
    assert.ok(buildRipgrepArgs(query("Foo"), smart).includes("--case-sensitive"));
    assert.ok(buildRipgrepArgs(query("foo"), smart).includes("--ignore-case"));
    assert.ok(buildRipgrepArgs(query("\\Sfoo", { isRegExp: true }), smart).includes("--ignore-case"));
    assert.ok(buildRipgrepArgs(query("\\Sfoo"), smart).includes("--case-sensitive"));
  });

  test("include and exclude globs follow VS Code's expansion", () => {
    const args = buildRipgrepArgs(
      query("foo", { includes: ["drivers", "drivers/**", "**/*.c", "**/*.c/**"], excludes: ["**/build", "**/build/**"] }),
      { ...folder, excludes: ["**/.git", "out", "/abs/"] },
    );
    assert.deepEqual(globs(args), [
      "!*",
      "/drivers",
      "/drivers/**",
      "**/*.c",
      "**/*.c/**",
      "!**/.git",
      "!/out",
      "!/abs",
      "!**/build",
      "!**/build/**",
    ]);
  });

  test("folder-relative includes list every parent so ripgrep can prune other directories", () => {
    const args = buildRipgrepArgs(
      query("foo", { includes: ["drivers/{gpu,media}", "drivers/{gpu,media}/**", "fs/ext4/*.c", "fs/ext4/*.c/**"] }),
      folder,
    );
    assert.deepEqual(globs(args), [
      "!*",
      "/drivers",
      "/drivers/gpu",
      "/drivers/media",
      "/drivers/gpu/**",
      "/drivers/media/**",
      "/fs",
      "/fs/ext4",
      "/fs/ext4/*.c",
      "/fs/ext4/*.c/**",
      "!**/.git",
    ]);
    assert.ok(!globs(buildRipgrepArgs(query("foo", { includes: ["**/*.c"] }), folder)).includes("!*"));
  });

  test("glob case follows the host file system", () => {
    const insensitive = buildRipgrepArgs(query("foo"), { ...folder, ignoreGlobCase: true });
    assert.deepEqual(insensitive.slice(2, 5), ["--ignore-case", "--glob-case-insensitive", "--ignore-file-case-insensitive"]);
    assert.ok(!buildRipgrepArgs(query("foo"), folder).includes("--glob-case-insensitive"));
  });

  test("ignore-file and symlink settings", () => {
    const args = buildRipgrepArgs(query("foo"), {
      ...folder,
      useIgnoreFiles: false,
      useGlobalIgnoreFiles: true,
      followSymlinks: false,
    });
    assert.ok(args.includes("--no-ignore"));
    assert.ok(!args.includes("--no-ignore-parent"));
    assert.ok(!args.includes("--no-ignore-global"));
    assert.ok(!args.includes("--follow"));
    const parent = buildRipgrepArgs(query("foo"), { ...folder, useParentIgnoreFiles: true });
    assert.ok(!parent.includes("--no-ignore-parent"));
  });

  test("glob lists split on top-level commas", () => {
    assert.deepEqual(splitGlobList(" a, {b,c}/** ,, d "), ["a", "{b,c}/**", "d"]);
    assert.deepEqual(splitGlobList("x[,]y, z"), ["x[,]y", "z"]);
    // An unclosed class keeps the rest, so ripgrep can report the bad glob.
    assert.deepEqual(splitGlobList("src/["), ["src/["]);
    assert.deepEqual(splitGlobList("*.c, build[, x"), ["*.c", "build[, x"]);
    assert.deepEqual(splitGlobList(""), []);
  });

  test("paths are escaped for use as globs", () => {
    assert.equal(escapeGlob("a,b/{c}/[d]*?"), "a[,]b/[{]c[}]/[[]d[]][*][?]");
    assert.deepEqual(splitGlobList(`./${escapeGlob("x,y")}, ./z`), ["./x[,]y", "./z"]);
  });
});

suite("ripgrep location", () => {
  test("candidates cover current and legacy VS Code layouts", () => {
    assert.deepEqual(ripgrepCandidates("/app", "linux", "x64"), [
      path.join("/app", "node_modules", "@vscode", "ripgrep-universal", "bin", "linux-x64", "rg"),
      path.join("/app", "node_modules.asar.unpacked", "@vscode", "ripgrep-universal", "bin", "linux-x64", "rg"),
      path.join("/app", "node_modules", "@vscode", "ripgrep", "bin", "rg"),
      path.join("/app", "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", "rg"),
    ]);
    assert.ok(ripgrepCandidates("/app", "win32", "arm64")[0].endsWith(path.join("win32-arm64", "rg.exe")));
  });

  test("finds the ripgrep bundled with the running VS Code", async () => {
    const found = await locateRipgrep(vscode.env.appRoot);
    assert.ok(found, "bundled ripgrep not found");
    assert.ok(found.startsWith(vscode.env.appRoot), found);
  });

  test("configured path wins and is not silently replaced", async () => {
    const found = await locateRipgrep(vscode.env.appRoot);
    assert.ok(found);
    assert.equal(await locateRipgrep("/nonexistent", found), found);
    assert.equal(await locateRipgrep(vscode.env.appRoot, "/nonexistent/rg"), undefined);
  });

  test("falls back to PATH", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeonly-path-"));
    const fake = path.join(dir, process.platform === "win32" ? "rg.exe" : "rg");
    fs.writeFileSync(fake, "");
    fs.chmodSync(fake, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${path.join(dir, "missing")}${path.delimiter}${dir}`;
    try {
      assert.equal(await locateRipgrep("/nonexistent"), fake);
    } finally {
      process.env.PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

