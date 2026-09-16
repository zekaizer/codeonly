import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { FolderOptions, SearchQuery } from "./query";

/**
 * Builds ripgrep arguments equivalent to the ones VS Code's text search passes, plus `--json`.
 * ripgrep must run with the workspace folder as its working directory.
 */
export function buildRipgrepArgs(query: SearchQuery, options: FolderOptions): string[] {
  const args = ["--hidden", "--no-require-git"];
  args.push(isCaseSensitive(query, options.smartCase) ? "--case-sensitive" : "--ignore-case");
  if (options.ignoreGlobCase) {
    args.push("--glob-case-insensitive", "--ignore-file-case-insensitive");
  }
  const includes = unique(query.includes.flatMap(expandSearchGlob));
  const rooted = includes.filter((g) => !g.startsWith("**"));
  if (rooted.length > 0) {
    // Exclude everything, then re-include each folder on the way down, as VS Code does.
    args.push("-g", "!*");
    for (const glob of unique(rooted.flatMap(expandBraces).flatMap(pathPrefixes))) {
      args.push("-g", anchorGlob(glob));
    }
  }
  for (const glob of includes.filter((g) => g.startsWith("**"))) {
    args.push("-g", glob);
  }
  for (const glob of options.excludes) {
    args.push("-g", `!${anchorGlob(trimTrailingSlashes(glob.replace(/\\/g, "/")))}`);
  }
  for (const glob of unique(query.excludes.flatMap(expandSearchGlob))) {
    args.push("-g", `!${anchorGlob(glob)}`);
  }
  if (!options.useIgnoreFiles) {
    args.push("--no-ignore");
  } else if (!options.useParentIgnoreFiles) {
    args.push("--no-ignore-parent");
  }
  if (options.followSymlinks) {
    args.push("--follow");
  }
  args.push("--crlf");
  if (query.isRegExp) {
    args.push("--engine", "auto");
  }
  let literal: string | undefined;
  if (query.isWordMatch) {
    args.push("--regexp", wholeWordRegExp(query.pattern, query.isRegExp));
  } else if (query.isRegExp) {
    args.push("--regexp", query.pattern);
  } else {
    args.push("--fixed-strings");
    literal = query.pattern;
  }
  args.push("--no-config");
  if (!options.useGlobalIgnoreFiles) {
    args.push("--no-ignore-global");
  }
  // A literal goes after `--` so that a leading dash is not parsed as a flag.
  args.push("--json", "--");
  if (literal !== undefined) {
    args.push(literal);
  }
  args.push(".");
  return args;
}

function isCaseSensitive(query: SearchQuery, smartCase: boolean): boolean {
  if (query.isCaseSensitive) {
    return true;
  }
  if (!smartCase) {
    return false;
  }
  const text = query.isRegExp ? query.pattern.replace(/\\./g, "") : query.pattern;
  return text.toLowerCase() !== text;
}

function wholeWordRegExp(pattern: string, isRegExp: boolean): string {
  let source = isRegExp ? pattern : pattern.replace(/[\\{}*+?|^$.[\]()]/g, "\\$&");
  if (!/\B/.test(source.charAt(0))) {
    source = `\\b${source}`;
  }
  if (!/\B/.test(source.charAt(source.length - 1))) {
    source = `${source}\\b`;
  }
  return source;
}

/** Folder-relative globs need a leading `/` to be anchored by ripgrep. */
function anchorGlob(glob: string): string {
  return glob.startsWith("**") || glob.startsWith("/") ? glob : `/${glob}`;
}

/**
 * Expands a Search view glob into folder-relative globs: `./dir` and `/dir` stay relative to the
 * folder, anything else matches at any depth. Each also matches everything below it.
 */
function expandSearchGlob(input: string): string[] {
  const glob = trimTrailingSlashes(input.replace(/\\/g, "/"));
  if (glob.startsWith("./") || glob === "." || glob.startsWith("/")) {
    const rel = glob.replace(/^\.?\/*/, "");
    return rel ? [rel, `${rel}/**`] : [];
  }
  return [`**/${glob}`, `**/${glob}/**`].map((g) => g.replace(/\*\*\/\*\*/g, "**"));
}

/** `a/b/c` → `a`, `a/b`, `a/b/c`, splitting only outside `{}` and `[]`. */
function pathPrefixes(glob: string): string[] {
  const parts = splitOutsideGroups(glob, "/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Expands `{a,b}` groups, as VS Code does before listing include prefixes. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open < 0) {
    return [glob];
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length && close < 0; i++) {
    if (glob[i] === "{") {
      depth++;
    } else if (glob[i] === "}" && --depth === 0) {
      close = i;
    }
  }
  if (close < 0) {
    return [glob];
  }
  const head = glob.slice(0, open);
  const alternatives = splitOutsideGroups(glob.slice(open + 1, close), ",");
  const tails = expandBraces(glob.slice(close + 1));
  return (alternatives.length > 0 ? alternatives : [""]).flatMap((a) => tails.map((t) => head + a + t));
}

function splitOutsideGroups(text: string, separator: string): string[] {
  const out: string[] = [];
  let braces = 0;
  let brackets = false;
  let current = "";
  for (const ch of text) {
    if (ch === separator && braces === 0 && !brackets) {
      out.push(current);
      current = "";
      continue;
    }
    if (ch === "{") {
      braces++;
    } else if (ch === "}" && braces > 0) {
      braces--;
    } else if (ch === "[") {
      brackets = true;
    } else if (ch === "]") {
      brackets = false;
    }
    current += ch;
  }
  if (current) {
    out.push(current);
  }
  return out;
}

function trimTrailingSlashes(glob: string): string {
  return glob.length > 1 ? glob.replace(/\/+$/, "") : glob;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/** Known locations of the ripgrep binary inside a VS Code or VS Code Server install. */
export function ripgrepCandidates(appRoot: string, platform: string, arch: string): string[] {
  const exe = platform === "win32" ? "rg.exe" : "rg";
  return [
    path.join(appRoot, "node_modules", "@vscode", "ripgrep-universal", "bin", `${platform}-${arch}`, exe),
    path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep-universal", "bin", `${platform}-${arch}`, exe),
    path.join(appRoot, "node_modules", "@vscode", "ripgrep", "bin", exe),
    path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exe),
  ];
}

/**
 * Resolves the ripgrep executable: `configured` if given (no fallback when it is unusable),
 * else the copy bundled with VS Code under `appRoot`, else the first one on `PATH`.
 */
export async function locateRipgrep(appRoot: string, configured?: string): Promise<string | undefined> {
  if (configured) {
    const expanded = configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;
    return (await isExecutableFile(expanded)) ? expanded : undefined;
  }
  for (const candidate of ripgrepCandidates(appRoot, process.platform, process.arch)) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = dir && path.join(dir, exe);
    if (candidate && (await isExecutableFile(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) {
      return false;
    }
    await fs.promises.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface RipgrepLine {
  /** 1-based. */
  readonly lineNumber: number;
  /** Byte offset of the line in ripgrep's decoded stream (after a stripped BOM). */
  readonly absoluteOffset: number;
  /** Line bytes including the terminator. */
  readonly bytes: Buffer;
  /** Byte offsets within {@link bytes}, in ascending order. */
  readonly submatches: readonly { readonly start: number; readonly end: number }[];
}

export interface RipgrepFile {
  /** Path as printed by ripgrep, relative to the working directory. */
  readonly path: string;
  readonly lines: RipgrepLine[];
}

export interface RipgrepExit {
  readonly code: number | null;
  readonly stderr: string;
  readonly aborted: boolean;
}

type RgData = { text: string } | { bytes: string };

interface RgMessage {
  type: string;
  data: {
    path?: RgData;
    lines?: RgData;
    line_number?: number;
    absolute_offset?: number;
    submatches?: { start: number; end: number }[];
  };
}

const STDERR_LIMIT = 64 * 1024;

/** Reduces ripgrep's stderr to one user-facing sentence. */
export function summarizeRipgrepError(stderr: string): string {
  if (/regex parse error/.test(stderr)) {
    const reason = /^error: (.+)$/m.exec(stderr)?.[1];
    return reason ? `Invalid regular expression: ${reason}` : "Invalid regular expression.";
  }
  if (/the literal "\\n" is not allowed/.test(stderr)) {
    return "Multi-line patterns are not supported.";
  }
  const first = stderr.split("\n").find((l) => l.trim()) ?? "";
  return first.replace(/^rg: /, "").trim() || "ripgrep failed.";
}

/**
 * Runs ripgrep with `--json` output and calls `onFile` once per file with matches, in output order.
 * `onFile` is awaited before more output is read. Aborting kills the process and resolves normally.
 */
export async function runRipgrep(
  rgPath: string,
  args: readonly string[],
  cwd: string,
  onFile: (file: RipgrepFile) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RipgrepExit> {
  const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) {
      stderr += chunk;
    }
  });
  const kill = () => child.kill();
  signal?.addEventListener("abort", kill);
  try {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let current: RipgrepFile | undefined;
    for await (const line of lines) {
      const message = parseMessage(line);
      if (message?.type === "begin") {
        current = { path: decodeData(message.data.path), lines: [] };
      } else if (message?.type === "match") {
        current ??= { path: decodeData(message.data.path), lines: [] };
        current.lines.push(toLine(message));
      } else if (message?.type === "end") {
        if (current && current.lines.length > 0 && !signal?.aborted) {
          await onFile(current);
        }
        current = undefined;
      }
    }
    const code = await exited;
    return { code, stderr, aborted: signal?.aborted ?? false };
  } catch (e) {
    child.kill();
    throw e;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

function parseMessage(line: string): RgMessage | undefined {
  if (!line) {
    return undefined;
  }
  try {
    return JSON.parse(line) as RgMessage;
  } catch {
    return undefined;
  }
}

function decodeData(data: RgData | undefined): string {
  if (!data) {
    return "";
  }
  return "text" in data ? data.text : Buffer.from(data.bytes, "base64").toString("utf8");
}

function toLine(message: RgMessage): RipgrepLine {
  const { lines, line_number, absolute_offset, submatches } = message.data;
  const bytes = !lines ? Buffer.alloc(0) : "text" in lines ? Buffer.from(lines.text, "utf8") : Buffer.from(lines.bytes, "base64");
  return {
    lineNumber: line_number ?? 0,
    absoluteOffset: absolute_offset ?? 0,
    bytes,
    submatches: (submatches ?? []).map((m) => ({ start: m.start, end: m.end })),
  };
}
