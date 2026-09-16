import * as path from "node:path";
import { escapeGlob, splitGlobList } from "./query";

export interface WorkspaceRoot {
  readonly name: string;
  readonly path: string;
}

/** One ripgrep run: a root directory and globs relative to it. */
export interface ScopedFolder {
  readonly path: string;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
}

/** The include or exclude text names something that does not exist. The message is user-facing. */
export class ScopeError extends Error {
  constructor(
    message: string,
    readonly field: "includes" | "excludes" = "includes",
  ) {
    super(message);
  }
}

/** Characters that make VS Code's include parser treat a path segment as a glob. */
const GLOB_CHARS = /[*?[\]{}(),]/;

/**
 * Include text that selects `target` (an Explorer selection inside `root`). With multi-root rules
 * `./<name>` names the folder, unless another folder has the same name; then the absolute path is
 * used, as the Search view does. `multiRoot` is true whenever a workspace file is open, even with
 * a single folder, because VS Code decides it that way.
 */
export function searchPathFor(
  target: string,
  root: WorkspaceRoot,
  roots: readonly WorkspaceRoot[],
  multiRoot = roots.length > 1,
): string {
  const rel = toSlash(path.relative(root.path, target));
  if (!multiRoot) {
    return rel ? `./${escapeGlob(rel)}` : "";
  }
  if (roots.filter((r) => r.name === root.name).length > 1) {
    return escapeGlob(toSlash(target));
  }
  const name = escapeGlob(root.name);
  return rel ? `./${name}/${escapeGlob(rel)}` : `./${name}`;
}

interface SearchPath {
  readonly root: string;
  /** Undefined for the whole root. */
  patterns?: string[];
}

interface Parsed {
  readonly searchPaths: SearchPath[];
  readonly globs: string[];
}

/**
 * Turns the Search view's "files to include/exclude" text into ripgrep runs, following VS Code's
 * query builder: paths (`./x`, `../x`, `~/x`, absolute) choose what to search, other entries are
 * globs matched at any depth. With multi-root rules (`multiRoot`, see {@link searchPathFor})
 * `./<folder>/...` selects that folder.
 *
 * @throws ScopeError if `./<name>` names no folder of a multi-root workspace.
 */
export function resolveScope(
  includes: string,
  excludes: string,
  roots: readonly WorkspaceRoot[],
  homedir: string,
  multiRoot = roots.length > 1,
): ScopedFolder[] {
  const included = parse(includes, roots, homedir, multiRoot, "includes");
  const excluded = parse(excludes, roots, homedir, multiRoot, "excludes");
  const targets: SearchPath[] =
    included.searchPaths.length > 0 ? included.searchPaths : roots.map((r) => ({ root: r.path }));
  const out: ScopedFolder[] = [];
  for (const target of targets) {
    // Like VS Code, an excluded path only counts when it is exactly a searched root.
    const skip = excluded.searchPaths.find((sp) => samePath(sp.root, target.root));
    if (skip && !skip.patterns) {
      continue;
    }
    out.push({
      path: target.root,
      includes: [...(target.patterns ?? []), ...included.globs],
      excludes: [...(skip?.patterns ?? []), ...excluded.globs],
    });
  }
  return out;
}

/** The longest of `roots` that contains `file`, which is how VS Code assigns a hit to a folder. */
export function deepestRoot(file: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    if (isInside(root, file) && (best === undefined || root.length > best.length)) {
      best = root;
    }
  }
  return best;
}

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function parse(
  text: string,
  roots: readonly WorkspaceRoot[],
  homedir: string,
  multiRoot: boolean,
  field: ScopeError["field"],
): Parsed {
  const items = splitGlobList(toSlash(text)).map((p) => p.replace(/^~($|\/)/, `${toSlash(homedir)}$1`));
  const globs: string[] = [];
  const byRoot = new Map<string, SearchPath>();
  const add = (root: string, combined: string | undefined) => {
    const patterns = combined ? (combined.endsWith("**") ? [combined] : [combined, `${combined}/**`]) : undefined;
    const existing = byRoot.get(root);
    if (!existing) {
      byRoot.set(root, { root, patterns });
    } else if (patterns) {
      existing.patterns = [...(existing.patterns ?? []), ...patterns];
    }
  };
  for (const item of items) {
    const named = escapedFolderPrefix(item, roots, multiRoot);
    if (named) {
      add(named.root, named.rest ? normalizePattern(named.rest) : undefined);
      continue;
    }
    if (!isSearchPath(item)) {
      let glob = item.replace(/\/+$/, "");
      if (glob.startsWith(".")) {
        glob = `*${glob}`;
      }
      globs.push(...[`**/${glob}/**`, `**/${glob}`].map((g) => g.replace(/\*\*\/\*\*/g, "**")));
      continue;
    }
    const { pathPortion, globPortion } = splitPathAndGlob(item);
    const glob = globPortion === undefined ? undefined : normalizePattern(globPortion);
    for (const { root, pattern } of expandSearchPath(pathPortion, roots, multiRoot, field)) {
      add(root, pattern && glob ? `${pattern}/${glob}` : pattern || glob);
    }
  }
  return { searchPaths: [...byRoot.values()], globs };
}

/**
 * A folder written with glob characters escaped: `./<name>/rest` (multi-root) or its absolute
 * path. VS Code's parser would split such text at the first glob character and search from a
 * parent folder, so it is matched to the folder first. The longest match wins.
 */
function escapedFolderPrefix(
  item: string,
  roots: readonly WorkspaceRoot[],
  multiRoot: boolean,
): { root: string; rest: string } | undefined {
  let best: { root: string; rest: string; length: number } | undefined;
  for (const root of roots) {
    const prefixes: string[] = [];
    if (multiRoot && GLOB_CHARS.test(root.name)) {
      prefixes.push(`./${escapeGlob(root.name)}`);
    }
    if (GLOB_CHARS.test(root.path)) {
      prefixes.push(escapeGlob(toSlash(root.path)));
    }
    for (const prefix of prefixes) {
      const rest = item === prefix || item === `${prefix}/` ? "" : item.startsWith(`${prefix}/`) ? item.slice(prefix.length + 1) : undefined;
      if (rest !== undefined && (!best || prefix.length > best.length)) {
        best = { root: root.path, rest, length: prefix.length };
      }
    }
  }
  return best && { root: best.root, rest: best.rest };
}

function isSearchPath(item: string): boolean {
  return path.isAbsolute(item) || /^\.\.?(\/|$)/.test(item);
}

/** Splits at the last separator before the first glob character, as VS Code does. */
function splitPathAndGlob(item: string): { pathPortion: string; globPortion?: string } {
  const glob = /[*{}()[\]?]/.exec(item);
  if (glob) {
    const separator = /\/[^/]*$/.exec(item.slice(0, glob.index));
    if (separator) {
      let pathPortion = item.slice(0, separator.index);
      if (!pathPortion.includes("/")) {
        pathPortion += "/";
      }
      return { pathPortion, globPortion: item.slice(separator.index + 1) };
    }
  }
  return { pathPortion: item };
}

function expandSearchPath(
  item: string,
  roots: readonly WorkspaceRoot[],
  multiRoot: boolean,
  field: ScopeError["field"],
): { root: string; pattern?: string }[] {
  if (path.isAbsolute(item)) {
    return [{ root: trimSeparators(path.normalize(item)) }];
  }
  if (!multiRoot) {
    const [folder] = roots;
    if (!folder) {
      return [];
    }
    if (item === ".." || item.startsWith("../")) {
      return [{ root: trimSeparators(path.resolve(folder.path, item)) }];
    }
    return [{ root: folder.path, pattern: normalizePattern(item) }];
  }
  if (item === "./") {
    return [];
  }
  const rest = item.replace(/^\.\//, "");
  const matches = roots.flatMap((folder) => {
    const m = new RegExp(`^${escapeRegExp(folder.name)}(?:/(.*)|$)`).exec(rest);
    return m ? [{ root: folder.path, pattern: m[1] ? normalizePattern(m[1]) : undefined }] : [];
  });
  if (matches.length === 0) {
    throw new ScopeError(`Workspace folder does not exist: ${rest.replace(/\/+$/, "")}`, field);
  }
  return matches;
}

function toSlash(text: string): string {
  return text.replace(/\\/g, "/");
}

function normalizePattern(pattern: string): string {
  return toSlash(pattern).replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Drops trailing separators, but keeps a file-system root such as `/` or `C:\\`. */
function trimSeparators(p: string): string {
  if (path.parse(p).root === p) {
    return p;
  }
  return p.replace(/[\\/]+$/, "");
}

function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}
