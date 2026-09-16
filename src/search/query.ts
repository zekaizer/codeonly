export interface SearchQuery {
  readonly pattern: string;
  readonly isRegExp: boolean;
  readonly isCaseSensitive: boolean;
  readonly isWordMatch: boolean;
  /** Globs relative to the searched folder, as produced by `resolveScope`. */
  readonly includes: readonly string[];
  /** Globs relative to the searched folder, as produced by `resolveScope`. */
  readonly excludes: readonly string[];
}

/** Per-workspace-folder search settings, read from `search.*` and `files.exclude`. */
export interface FolderOptions {
  /** Enabled `files.exclude` and `search.exclude` keys. */
  readonly excludes: readonly string[];
  readonly useIgnoreFiles: boolean;
  readonly useParentIgnoreFiles: boolean;
  readonly useGlobalIgnoreFiles: boolean;
  readonly followSymlinks: boolean;
  readonly smartCase: boolean;
  /** Match globs and ignore files case-insensitively, for case-insensitive file systems. */
  readonly ignoreGlobCase: boolean;
}

/** Escapes glob syntax in a literal path, so that it can go into a glob list. */
export function escapeGlob(path: string): string {
  return path.replace(/[,{}[\]*?]/g, "[$&]");
}

/** Splits a comma-separated glob list, keeping commas inside `{}` groups and `[]` classes. */
export function splitGlobList(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let classStart = -1;
  let start = 0;
  for (let i = 0; i <= input.length; i++) {
    const ch = input[i];
    if (classStart >= 0) {
      // A `]` first in the class (after an optional `!` or `^`) is a member, as in `[]]`.
      const first = /[!^]/.test(input[classStart + 1] ?? "") ? classStart + 2 : classStart + 1;
      if (ch === "]" && i > first) {
        classStart = -1;
      }
    } else if (ch === "[") {
      classStart = i;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
    } else if (i === input.length || (ch === "," && depth === 0)) {
      const item = input.slice(start, i).trim();
      if (item) {
        out.push(item);
      }
      start = i + 1;
    }
  }
  return out;
}
