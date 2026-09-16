export interface SearchQuery {
  readonly pattern: string;
  readonly isRegExp: boolean;
  readonly isCaseSensitive: boolean;
  readonly isWordMatch: boolean;
  /** Globs in the Search view's "files to include" syntax. */
  readonly includes: readonly string[];
  /** Globs in the Search view's "files to exclude" syntax. */
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
}

/** Splits a comma-separated glob list, keeping commas inside `{}` groups. */
export function splitGlobList(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= input.length; i++) {
    const ch = input[i];
    if (ch === "{") {
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
