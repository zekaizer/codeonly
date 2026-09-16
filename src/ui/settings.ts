import * as vscode from "vscode";
import type { FolderOptions } from "../search/query";
import type { ViewConfig } from "../shared/protocol";

export type CollapseMode = "auto" | "alwaysCollapse" | "alwaysExpand";

/** Mirrors how the built-in Search view reads its settings for a folder. */
export function folderOptions(uri: vscode.Uri): FolderOptions {
  const search = vscode.workspace.getConfiguration("search", uri);
  const files = vscode.workspace.getConfiguration("files", uri);
  const excludes = new Set([...enabledKeys(files.get("exclude")), ...enabledKeys(search.get("exclude"))]);
  return {
    excludes: [...excludes],
    useIgnoreFiles: search.get<boolean>("useIgnoreFiles", true),
    useParentIgnoreFiles: search.get<boolean>("useParentIgnoreFiles", false),
    useGlobalIgnoreFiles: search.get<boolean>("useGlobalIgnoreFiles", false),
    followSymlinks: search.get<boolean>("followSymlinks", true),
    smartCase: search.get<boolean>("smartCase", false),
    // VS Code decides this by the client OS; the file system's case rules are those of this host.
    ignoreGlobCase: process.platform !== "linux",
  };
}

// `{ "when": ... }` sibling clauses are not supported by ripgrep globs and are skipped.
function enabledKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, enabled]) => key && enabled === true)
    .map(([key]) => key);
}

export function maxResults(): number | undefined {
  const value = vscode.workspace.getConfiguration("search").get<number | null>("maxResults", 20000);
  return typeof value === "number" && value > 0 ? value : undefined;
}

export function viewConfig(): ViewConfig {
  const search = vscode.workspace.getConfiguration("search");
  return {
    searchOnType: search.get<boolean>("searchOnType", true),
    debounceMs: search.get<number>("searchOnTypeDebouncePeriod", 300),
  };
}

export function collapseMode(): CollapseMode {
  const value = vscode.workspace.getConfiguration("search").get<string>("collapseResults", "alwaysExpand");
  return value === "auto" || value === "alwaysCollapse" ? value : "alwaysExpand";
}

export function ripgrepPath(): string {
  return vscode.workspace.getConfiguration("codeonly").get<string>("ripgrepPath", "").trim();
}

export function logExcludedLines(): boolean {
  return vscode.workspace.getConfiguration("codeonly").get<boolean>("diagnostics.logExcludedLines", false);
}
