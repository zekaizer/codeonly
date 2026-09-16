import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type FileResult, SearchError, type SearchFolder, type SearchSummary, searchCode } from "../search/codeSearch";
import { type SearchQuery, escapeGlob } from "../search/query";
import { locateRipgrep } from "../search/ripgrep";
import {
  ScopeError,
  type ScopedFolder,
  type WorkspaceRoot,
  deepestRoot,
  resolveScope,
  searchPathFor,
} from "../search/scope";
import {
  EMPTY_FORM,
  type FormField,
  type QueryForm,
  type SearchStatus,
  type StatusCommand,
  type ToWebview,
} from "../shared/protocol";
import { makePreview } from "./preview";
import type { QueryViewHost } from "./queryView";
import type { ResultsTree } from "./resultsTree";
import * as settings from "./settings";

export const RESULTS_VIEW_ID = "codeonly.results";

const FORM_KEY = "codeonly.form";
const HISTORY_KEY = "codeonly.history";
const HISTORY_LIMIT = 50;
const PROGRESS_INTERVAL_MS = 250;

export interface ViewChannel {
  post(message: ToWebview): void;
  focusInput(): void;
}

export type HiddenLinesOutput = Pick<vscode.OutputChannel, "replace" | "show">;

interface HiddenLine {
  readonly location: string;
  readonly lineNumber: number;
  readonly reason: string;
  readonly text: string;
}

/** Owns the query, runs searches, and keeps the query view, results tree, and log in sync. */
export class SearchController implements QueryViewHost, vscode.Disposable {
  private form: QueryForm;
  private history: string[];
  private status: SearchStatus = { kind: "idle" };
  private runId = 0;
  private abort: AbortController | undefined;
  private ripgrep: { configured: string; path: string } | undefined;
  private report: string[] = [];
  private readonly contextValues: Record<string, unknown> = {};
  private queryFocused = false;
  /** The term whose results the tree shows. */
  private shownPattern: string | undefined;
  view: ViewChannel | undefined;

  constructor(
    private readonly state: vscode.Memento,
    private readonly tree: ResultsTree,
    private readonly treeView: vscode.TreeView<unknown>,
    private readonly log: vscode.LogOutputChannel,
    private readonly hiddenLines: HiddenLinesOutput,
  ) {
    this.form = { ...EMPTY_FORM, ...state.get<Partial<QueryForm>>(FORM_KEY) };
    this.history = state.get<string[]>(HISTORY_KEY, []);
    this.updateContext();
  }

  dispose(): void {
    this.abort?.abort();
  }

  currentForm(): QueryForm {
    return this.form;
  }

  currentStatus(): SearchStatus {
    return this.status;
  }

  hiddenLineReport(): readonly string[] {
    return this.report;
  }

  searchHistory(): readonly string[] {
    return this.history;
  }

  contextKeys(): Readonly<Record<string, unknown>> {
    return this.contextValues;
  }

  viewState() {
    return { form: this.form, history: this.history, config: settings.viewConfig(), status: this.status };
  }

  onSearch(form: QueryForm, commit: boolean): void {
    void this.search(form, commit);
  }

  onFormChanged(form: QueryForm): void {
    this.setForm(form, false);
  }

  onCancel(): void {
    this.abort?.abort();
  }

  onFocusChanged(focused: boolean): void {
    this.queryFocused = focused;
    this.updateContext();
  }

  onCommand(command: StatusCommand): void {
    void this.runCommand(command);
  }

  async runCommand(command: StatusCommand): Promise<void> {
    switch (command) {
      case "showHiddenLines":
        return this.showHiddenLines();
      case "openExcludeSettings":
        return vscode.commands.executeCommand("workbench.action.openSettings", "search.exclude");
      case "openMaxResultsSetting":
        return vscode.commands.executeCommand("workbench.action.openSettings", "search.maxResults");
      case "openRipgrepSetting":
        return vscode.commands.executeCommand("workbench.action.openSettings", "codeonly.ripgrepPath");
      case "showLog":
        return this.log.show(true);
      case "focusResults":
        return vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`);
    }
  }

  /** Runs `form`, replacing any running search. Resolves undefined unless the search ran to completion. */
  async search(form: QueryForm, commit: boolean, notifyView = false): Promise<SearchSummary | undefined> {
    this.setForm(form, notifyView);
    if (commit) {
      this.remember(form.pattern);
    }
    this.abort?.abort();
    this.abort = undefined;
    const id = ++this.runId;

    if (!form.pattern) {
      this.report = [];
      this.tree.reset([]);
      this.setStatus({ kind: "idle" });
      return undefined;
    }

    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
    if (folders.length === 0) {
      this.fail("Open a folder to search its code.");
      return undefined;
    }
    let scoped: ScopedFolder[];
    try {
      scoped = resolveScope(form.includes, form.excludes, workspaceRoots(), os.homedir(), usesMultiRootRules());
    } catch (e) {
      if (e instanceof ScopeError) {
        this.fail(e.message, undefined, e.field);
        return undefined;
      }
      throw e;
    }

    const rgPath = await this.findRipgrep();
    if (id !== this.runId) {
      return undefined;
    }
    if (!rgPath) {
      const configured = settings.ripgrepPath();
      this.fail(
        configured
          ? `ripgrep is not executable at "${configured}".`
          : "ripgrep was not found in this VS Code installation or on PATH.",
        "openRipgrepSetting",
      );
      return undefined;
    }

    const searchable = await existingRoots(scoped);
    if (id !== this.runId) {
      return undefined;
    }
    if (scoped.length > 0 && searchable.length === 0) {
      this.fail(`Search path not found: ${scoped[0].path}`, undefined, "includes");
      return undefined;
    }

    const abort = new AbortController();
    this.abort = abort;
    const logHidden = settings.logExcludedLines();
    const hidden: HiddenLine[] = [];
    // Nested workspace folders report the same file once per folder; count it once.
    const seen = new Set<string>();
    let hiddenLineCount = 0;
    const multiRoot = folders.length > 1;
    const names = new Map(folders.map((f) => [f.uri.fsPath, f.name]));
    const targets: SearchTarget[] = searchable.map(({ fileOnly, ...scope }) => ({
      fileOnly,
      folder: { path: scope.path, options: settings.folderOptions(vscode.Uri.file(scope.path)) },
      query: {
        pattern: form.pattern,
        isRegExp: form.isRegExp,
        isCaseSensitive: form.isCaseSensitive,
        isWordMatch: form.isWordMatch,
        includes: scope.includes,
        excludes: scope.excludes,
      },
    }));

    this.tree.reset(folders, true);
    this.shownPattern = form.pattern;
    this.setStatus({ kind: "searching", matchCount: 0, fileCount: 0 });
    const progress = setInterval(() => {
      if (id === this.runId) {
        this.setStatus({ kind: "searching", ...this.tree.counts() });
      }
    }, PROGRESS_INTERVAL_MS);

    const onResult = (found: FileResult) => {
      if (id !== this.runId || seen.has(found.absolutePath)) {
        return;
      }
      const result = relativeToWorkspace(found, folders);
      seen.add(result.absolutePath);
      hiddenLineCount += result.excluded.length;
      this.tree.add(result);
      if (logHidden) {
        const folderName = names.get(result.folder) ?? path.basename(result.folder);
        const location = multiRoot ? `${folderName}/${result.relativePath}` : result.relativePath;
        for (const e of result.excluded) {
          hidden.push({ location, lineNumber: e.lineNumber, reason: e.reason, text: e.text });
        }
      }
    };

    try {
      const maxResults = settings.maxResults();
      const summary = await vscode.window.withProgress({ location: { viewId: RESULTS_VIEW_ID } }, () =>
        searchTargets(rgPath, targets, maxResults, abort.signal, onResult, (file) => seen.has(file)),
      );
      if (id !== this.runId) {
        return undefined;
      }
      this.tree.flush();
      this.setStatus({
        kind: "done",
        ...this.tree.counts(),
        hiddenLineCount,
        limitHit: summary.limitHit,
        maxResults,
        durationMs: summary.durationMs,
        warningCount: summary.warnings.length,
        cancelled: summary.cancelled,
      });
      this.writeLog(form, summary, logHidden ? hidden : undefined);
      return summary.cancelled ? undefined : summary;
    } catch (e) {
      if (id !== this.runId) {
        return undefined;
      }
      if (!(e instanceof SearchError) || e.ripgrepFailed) {
        this.ripgrep = undefined;
      }
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof SearchError) {
        this.fail(message, undefined, errorField(e));
        this.log.warn(`Search for "${form.pattern}" failed: ${e.detail ?? message}`);
      } else {
        this.fail(`Search failed: ${message}`, "showLog");
        this.log.error(e instanceof Error ? e : message);
      }
      return undefined;
    } finally {
      clearInterval(progress);
      if (id === this.runId) {
        this.abort = undefined;
      }
    }
  }

  /** Re-runs the current query. */
  rerun(): Promise<SearchSummary | undefined> {
    return this.search(this.form, false);
  }

  clear(): void {
    this.abort?.abort();
    this.runId++;
    this.report = [];
    this.tree.reset([]);
    this.setForm({ ...this.form, pattern: "" }, true);
    this.setStatus({ kind: "idle" });
  }

  /** Called after the tree changed outside a search, e.g. a dismissed result. */
  resultsChanged(): void {
    if (this.status.kind === "done" && this.tree.isEmpty) {
      this.report = [];
      this.setStatus({ kind: "idle" });
    } else if (this.status.kind === "done") {
      this.setStatus({ ...this.status, ...this.tree.counts() });
    } else {
      this.updateContext();
    }
  }

  /**
   * Reveals the query view with its input focused, seeded from the active editor. A new seed is
   * searched right away when search-on-type is on; otherwise the old results are cleared so that
   * they are not shown under the new term.
   */
  async focusSearch(options: { seed?: boolean } = {}): Promise<void> {
    const seed = options.seed === false ? undefined : seedFromEditor(this.form.isRegExp);
    const stale = this.status.kind === "idle" || this.status.kind === "error";
    const changed = seed !== undefined && (seed !== this.form.pattern || stale);
    if (changed) {
      this.setForm({ ...this.form, pattern: seed }, true);
    }
    await vscode.commands.executeCommand("codeonly.query.focus");
    this.view?.focusInput();
    if (!changed) {
      return;
    }
    if (settings.viewConfig().searchOnType) {
      await this.search(this.form, false);
    } else {
      this.abort?.abort();
      this.runId++;
      this.report = [];
      this.tree.reset([]);
      this.setStatus({ kind: "idle" });
    }
  }

  /** Scopes the query to `uris` (Explorer selection), each relative to its workspace folder. */
  async findInFolder(uris: readonly vscode.Uri[]): Promise<void> {
    const roots = workspaceRoots();
    const scopes: string[] = [];
    for (const uri of uris) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) {
        continue;
      }
      // A selected file stands for its folder, as in the Search view.
      const stat = await fs.promises.stat(uri.fsPath).catch(() => undefined);
      const target = stat?.isFile() ? path.dirname(uri.fsPath) : uri.fsPath;
      const scope = searchPathFor(target, { name: folder.name, path: folder.uri.fsPath }, roots, usesMultiRootRules());
      if (!scope) {
        // The folder root itself: no restriction.
        scopes.length = 0;
        break;
      }
      if (!scopes.includes(scope)) {
        scopes.push(scope);
      }
    }
    if (scopes.length === 0 && uris.every((u) => !vscode.workspace.getWorkspaceFolder(u))) {
      void vscode.window.showWarningMessage("CodeOnly can only search inside a workspace folder.");
      return;
    }
    this.setForm({ ...this.form, includes: scopes.join(", "), showDetails: true }, true);
    await vscode.commands.executeCommand("codeonly.query.focus");
    this.view?.focusInput();
    if (this.form.pattern) {
      void this.search(this.form, false);
    }
  }

  /** Keeps the term of the listed results in history; typed but unsearched text is not kept. */
  rememberShown(): void {
    if (this.shownPattern !== undefined && !this.tree.isEmpty) {
      this.remember(this.shownPattern);
    }
  }

  remember(pattern: string): void {
    if (!pattern) {
      return;
    }
    this.history = [...this.history.filter((h) => h !== pattern), pattern].slice(-HISTORY_LIMIT);
    void this.state.update(HISTORY_KEY, this.history);
    this.view?.post({ type: "history", history: this.history });
  }

  configChanged(): void {
    this.view?.post({ type: "config", config: settings.viewConfig() });
  }

  private setForm(form: QueryForm, notifyView: boolean): void {
    this.form = form;
    void this.state.update(FORM_KEY, form);
    this.updateContext();
    if (notifyView) {
      this.view?.post({ type: "form", form, focus: false });
    }
  }

  private setStatus(status: SearchStatus): void {
    this.status = status;
    this.view?.post({ type: "status", status });
    this.updateTreeView();
    this.updateContext();
  }

  /** An error replaces the results: whatever is listed no longer matches the query. */
  private fail(message: string, action?: StatusCommand, field?: FormField): void {
    this.tree.reset([]);
    // The field in error has to be visible.
    if ((field === "includes" || field === "excludes") && !this.form.showDetails) {
      this.setForm({ ...this.form, showDetails: true }, true);
    }
    this.setStatus({ kind: "error", message, action, field });
  }

  private updateTreeView(): void {
    const s = this.status;
    let message: string | undefined;
    let description: string | undefined;
    switch (s.kind) {
      case "searching":
        // Old results stay listed until the new ones are shown.
        message = s.matchCount === 0 && !this.tree.showsResults ? "Searching…" : undefined;
        break;
      case "done":
        // The query view's status line may be cut off in a short pane, so the limit is repeated here.
        message =
          s.matchCount === 0
            ? s.cancelled
              ? "Search stopped."
              : "No results found."
            : s.limitHit
              ? `Only the first ${(s.maxResults ?? s.matchCount).toLocaleString()} results are shown.`
              : undefined;
        description =
          s.matchCount === 0
            ? undefined
            : `${s.matchCount.toLocaleString()} result${s.matchCount === 1 ? "" : "s"}` +
              (s.hiddenLineCount > 0 ? ` · ${s.hiddenLineCount.toLocaleString()} hidden` : "");
        break;
      case "error":
        message = s.message;
        break;
    }
    // Every message assignment counts as a tree change and restarts VS Code's refresh debounce,
    // so unchanged values are left alone.
    if (this.treeView.message !== message) {
      this.treeView.message = message;
    }
    if (this.treeView.description !== description) {
      this.treeView.description = description;
    }
  }

  /** Context keys are derived from the status and the tree only, so no code path can leave them stale. */
  private updateContext(): void {
    const values: Record<string, unknown> = {
      "codeonly.hasPattern": this.form.pattern !== "",
      "codeonly.queryFocused": this.queryFocused,
      "codeonly.state": this.status.kind,
      "codeonly.searching": this.status.kind === "searching",
      "codeonly.hasResults": !this.tree.isEmpty,
    };
    for (const [key, value] of Object.entries(values)) {
      if (this.contextValues[key] !== value) {
        this.contextValues[key] = value;
        void vscode.commands.executeCommand("setContext", key, value);
      }
    }
  }

  private async findRipgrep(): Promise<string | undefined> {
    const configured = settings.ripgrepPath();
    if (this.ripgrep?.configured === configured) {
      return this.ripgrep.path;
    }
    const found = await locateRipgrep(vscode.env.appRoot, configured || undefined);
    if (found) {
      this.ripgrep = { configured, path: found };
      this.log.info(`Using ripgrep at ${found}`);
    }
    return found;
  }

  private writeLog(form: QueryForm, summary: SearchSummary, hidden: HiddenLine[] | undefined): void {
    const flags = [form.isCaseSensitive && "case", form.isWordMatch && "word", form.isRegExp && "regex"].filter(Boolean);
    const scope = [form.includes && `include: ${form.includes}`, form.excludes && `exclude: ${form.excludes}`].filter(Boolean);
    this.log.info(
      `Searched "${form.pattern}"${flags.length ? ` [${flags.join(", ")}]` : ""}${scope.length ? ` (${scope.join("; ")})` : ""}: ` +
        `${summary.matchCount} results in ${summary.fileCount} files, ${summary.excludedLineCount} lines hidden, ` +
        `${(summary.durationMs / 1000).toFixed(2)} s${summary.limitHit ? ", result limit hit" : ""}${summary.cancelled ? ", stopped" : ""}`,
    );
    for (const w of summary.warnings) {
      this.log.warn(w);
    }
    if (!hidden) {
      this.report = [];
      return;
    }
    hidden.sort((a, b) => a.location.localeCompare(b.location) || a.lineNumber - b.lineNumber);
    this.report = hidden.map((h) => `${h.location}:${h.lineNumber}  [${h.reason}]  ${makePreview(h.text, []).label}`);
    this.hiddenLines.replace([`Hidden lines for "${form.pattern}" (${hidden.length}):`, ...this.report, ""].join("\n"));
  }

  private async showHiddenLines(): Promise<void> {
    if (settings.logExcludedLines()) {
      // Logging was turned on after this search, so its hidden lines were not recorded.
      if (this.report.length === 0 && this.status.kind === "done" && this.status.hiddenLineCount > 0) {
        await this.rerun();
      }
      this.hiddenLines.show(true);
      return;
    }
    const enable = "Enable and Search Again";
    const choice = await vscode.window.showInformationMessage(
      "Hidden lines are listed in the CodeOnly Hidden Lines output only while 'codeonly.diagnostics.logExcludedLines' is on.",
      enable,
    );
    if (choice === enable) {
      await vscode.workspace
        .getConfiguration("codeonly")
        .update("diagnostics.logExcludedLines", true, vscode.ConfigurationTarget.Global);
      await this.rerun();
      this.hiddenLines.show(true);
    }
  }
}

interface SearchTarget {
  readonly folder: SearchFolder;
  readonly query: SearchQuery;
  /** Searches one file through its folder; that folder does not own the other files below it. */
  readonly fileOnly: boolean;
}

/**
 * Keeps the roots that exist, as VS Code does. A file becomes its folder with an include for
 * just that file, since ripgrep cannot run inside a file.
 */
async function existingRoots(scoped: readonly ScopedFolder[]): Promise<(ScopedFolder & { fileOnly: boolean })[]> {
  const out: (ScopedFolder & { fileOnly: boolean })[] = [];
  for (const scope of scoped) {
    const stat = await fs.promises.stat(scope.path).catch(() => undefined);
    if (stat?.isDirectory()) {
      out.push({ ...scope, fileOnly: false });
    } else if (stat?.isFile()) {
      out.push({
        path: path.dirname(scope.path),
        includes: [escapeGlob(path.basename(scope.path))],
        excludes: scope.excludes,
        fileOnly: true,
      });
    }
  }
  return out;
}

/** Folders are searched one by one because multi-root include scoping gives each its own query. */
async function searchTargets(
  rgPath: string,
  targets: readonly SearchTarget[],
  maxResults: number | undefined,
  signal: AbortSignal,
  onResult: (result: FileResult) => void,
  skip: (absolutePath: string) => boolean,
): Promise<SearchSummary> {
  let total: SearchSummary | undefined;
  const roots = targets.filter((t) => !t.fileOnly).map((t) => t.folder.path);
  for (const { folder, query, fileOnly } of targets) {
    const remaining = maxResults === undefined ? undefined : maxResults - (total?.matchCount ?? 0);
    const summary = await searchCode({
      rgPath,
      query,
      folders: [folder],
      maxResults: remaining,
      signal,
      // A hit below a more specific searched root belongs to that root's run.
      skip: (file) => skip(file) || (!fileOnly && deepestRoot(file, roots) !== folder.path),
      onResult,
    });
    total = total ? merge(total, summary) : summary;
    if (summary.limitHit || summary.cancelled) {
      break;
    }
  }
  return (
    total ?? {
      fileCount: 0,
      lineCount: 0,
      matchCount: 0,
      excludedLineCount: 0,
      limitHit: false,
      cancelled: signal.aborted,
      durationMs: 0,
      warnings: [],
    }
  );
}

function merge(a: SearchSummary, b: SearchSummary): SearchSummary {
  return {
    fileCount: a.fileCount + b.fileCount,
    lineCount: a.lineCount + b.lineCount,
    matchCount: a.matchCount + b.matchCount,
    excludedLineCount: a.excludedLineCount + b.excludedLineCount,
    limitHit: a.limitHit || b.limitHit,
    cancelled: a.cancelled || b.cancelled,
    durationMs: a.durationMs + b.durationMs,
    warnings: [...a.warnings, ...b.warnings],
  };
}

/** The folders that can be searched: those on the extension host's file system. */
function workspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === "file")
    .map((f) => ({ name: f.name, path: f.uri.fsPath }));
}

/** VS Code applies multi-root path rules whenever a workspace file is open, even with one folder. */
function usesMultiRootRules(): boolean {
  return vscode.workspace.workspaceFile !== undefined;
}

/** The form field a search error is about, if any. */
function errorField(error: SearchError): FormField | undefined {
  if (/^(Invalid regular expression|Multi-line)/.test(error.message)) {
    return "pattern";
  }
  const glob = /error parsing glob '([^']*)'/.exec(error.detail ?? "")?.[1];
  if (glob !== undefined) {
    return glob.startsWith("!") ? "excludes" : "includes";
  }
  return undefined;
}

/** A search root below a workspace folder still names files relative to that folder. */
function relativeToWorkspace(result: FileResult, folders: readonly vscode.WorkspaceFolder[]): FileResult {
  if (folders.some((f) => f.uri.fsPath === result.folder)) {
    return result;
  }
  const owner = deepestRoot(
    result.absolutePath,
    folders.map((f) => f.uri.fsPath),
  );
  if (!owner) {
    return result;
  }
  const relativePath = path.relative(owner, result.absolutePath).split(path.sep).join("/");
  return { ...result, folder: owner, relativePath };
}

function seedFromEditor(isRegExp: boolean): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const { document, selection } = editor;
  let text: string | undefined;
  if (!selection.isEmpty) {
    text = selection.isSingleLine ? document.getText(selection) : undefined;
  } else {
    const word = document.getWordRangeAtPosition(selection.active);
    text = word ? document.getText(word) : undefined;
  }
  if (!text) {
    return undefined;
  }
  return isRegExp ? text.replace(/[\\{}*+?|^$.[\]()]/g, "\\$&") : text;
}
