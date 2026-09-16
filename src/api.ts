import type * as vscode from "vscode";
import type { SearchSummary } from "./search/codeSearch";
import type { QueryForm, SearchStatus } from "./shared/protocol";

export interface ResultEntry {
  /** Opaque node accepted by the result commands (`codeonly.dismiss`, `codeonly.copyPath`, ...). */
  readonly node: unknown;
  readonly item: vscode.TreeItem;
  readonly children: readonly ResultEntry[];
}

/** Returned from `activate`. Exists for integration tests; not a stable contract. */
export interface CodeOnlyApi {
  /** Merges `form` into the current query and runs it. Resolves undefined if the search did not complete. */
  search(form?: Partial<QueryForm>): Promise<SearchSummary | undefined>;
  form(): QueryForm;
  status(): SearchStatus;
  resultTree(): Promise<ResultEntry[]>;
  /** Hidden-line lines written to the log for the last search; empty unless diagnostics are enabled. */
  hiddenLineReport(): readonly string[];
  /** Resolves once the query view's script has started. */
  queryViewReady(): Promise<void>;
}
