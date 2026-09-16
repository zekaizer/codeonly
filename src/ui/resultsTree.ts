import * as path from "node:path";
import * as vscode from "vscode";
import type { FileResult, ResultLine } from "../search/codeSearch";
import { makePreview } from "./preview";
import type { CollapseMode } from "./settings";

export interface FileNode {
  readonly kind: "file";
  readonly result: FileResult;
  lines: LineNode[];
}

export interface LineNode {
  readonly kind: "line";
  readonly file: FileNode;
  readonly line: ResultLine;
}

export type ResultNode = FileNode | LineNode;

export interface OpenResultArgs {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export interface ResultCounts {
  readonly fileCount: number;
  readonly matchCount: number;
  readonly unfilteredFileCount: number;
}

/** "auto" collapses files with more results than this, as the Search view does. */
const AUTO_COLLAPSE_THRESHOLD = 10;
/**
 * Shortest pause between the view reading the tree and the next refresh. VS Code debounces tree
 * refreshes by 200 ms and restarts that wait on every change, so shorter pauses would hold back
 * every refresh until the search ends.
 */
const MIN_REFRESH_PAUSE_MS = 300;
/**
 * The pause is this many times as long as the view took to read the tree. VS Code rereads every
 * expanded node on each refresh, so a fixed pause would let refreshes starve the search.
 */
const REFRESH_PAUSE_FACTOR = 2;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function isResultNode(value: unknown): value is ResultNode {
  const kind = (value as ResultNode | undefined)?.kind;
  return kind === "file" || kind === "line";
}

export function openArgs(node: LineNode): OpenResultArgs {
  const { line } = node;
  const range = line.ranges[0];
  return {
    path: node.file.result.absolutePath,
    line: line.lineNumber,
    start: range?.start ?? 0,
    end: range?.end ?? 0,
  };
}

export class ResultsTree implements vscode.TreeDataProvider<ResultNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ResultNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly resetEmitter = new vscode.EventEmitter<void>();
  /** Fires when the results are replaced, before the tree change event. */
  readonly onDidReset = this.resetEmitter.event;

  private files = new Map<string, FileNode>();
  private sorted: FileNode[] | undefined;
  private folders: readonly vscode.WorkspaceFolder[] = [];
  /** Part of every item id; bumping it makes the tree forget expansion state. */
  private generation = 0;
  private expandAll = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  /** Results added since the last refresh. */
  private pending = false;
  /** A refresh was pushed and the view has not read the tree since. */
  private awaitingRead = false;
  /** When the view last read the root, and when it last read anything. */
  private rootReadAt = Date.now();
  private lastReadAt = this.rootReadAt;
  /** Files as of the view's last read of the tree. */
  private shown = new Set<FileNode>();
  private shownAny = false;

  constructor(private readonly collapseMode: () => CollapseMode) {}

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.changed.dispose();
    this.resetEmitter.dispose();
  }

  get isEmpty(): boolean {
    return this.files.size === 0;
  }

  counts(): ResultCounts {
    let matchCount = 0;
    let unfilteredFileCount = 0;
    for (const f of this.files.values()) {
      for (const l of f.lines) {
        matchCount += l.line.ranges.length;
      }
      if (!f.result.filtered) {
        unfilteredFileCount++;
      }
    }
    return { fileCount: this.files.size, matchCount, unfilteredFileCount };
  }

  /** Whether the last refresh pushed to the view had results. */
  get showsResults(): boolean {
    return this.shownAny;
  }

  /** Whether the view has read the tree since `file` was added. */
  isShown(file: FileNode): boolean {
    return this.shown.has(file);
  }

  /**
   * Replaces the results. With `deferred`, the view keeps the old results until the next refresh,
   * so that a new search does not flash an empty list.
   */
  reset(folders: readonly vscode.WorkspaceFolder[], deferred = false): void {
    this.files = new Map();
    this.sorted = undefined;
    this.folders = folders;
    this.generation++;
    this.expandAll = false;
    this.resetEmitter.fire();
    if (!deferred) {
      this.refresh();
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.pending = true;
    this.awaitingRead = false;
    this.rootReadAt = this.lastReadAt = Date.now();
    this.schedule();
  }

  fileFor(uri: vscode.Uri): FileNode | undefined {
    return uri.scheme === "file" ? this.files.get(uri.fsPath) : undefined;
  }

  add(result: FileResult): void {
    if (result.lines.length === 0) {
      return;
    }
    const node: FileNode = { kind: "file", result, lines: [] };
    node.lines = result.lines.map((line) => ({ kind: "line", file: node, line }));
    this.files.set(result.absolutePath, node);
    this.sorted = undefined;
    this.pending = true;
    this.schedule();
  }

  /** Pushes pending results to the view now. */
  flush(): void {
    if (this.pending) {
      this.refresh();
    }
  }

  /** Pushes the whole tree to the view now. */
  refresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.pending = false;
    this.awaitingRead = true;
    this.shownAny = this.files.size > 0;
    this.changed.fire(undefined);
  }

  private schedule(): void {
    if (!this.pending || this.awaitingRead || this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      // The view may have read more of the tree since this was scheduled.
      if (Date.now() >= this.nextRefreshAt()) {
        this.refresh();
      } else {
        this.schedule();
      }
    }, this.nextRefreshAt() - Date.now());
  }

  /**
   * The view reads the root, then the items and children of expanded files, so the time from the
   * root read to the last read is what a refresh costs. Waiting for a hidden view is not counted.
   */
  private nextRefreshAt(): number {
    const took = this.lastReadAt - this.rootReadAt;
    return this.lastReadAt + Math.max(MIN_REFRESH_PAUSE_MS, REFRESH_PAUSE_FACTOR * took);
  }

  /**
   * Removes `node`. With `flush`, pending results are pushed in the same refresh: VS Code waits
   * only for the first refresh of a batch before it reveals an item.
   */
  dismiss(node: ResultNode, flush = false): void {
    const file = node.kind === "file" ? node : node.file;
    if (this.files.get(file.result.absolutePath) !== file) {
      return;
    }
    if (node.kind === "line") {
      file.lines = file.lines.filter((l) => l !== node);
    }
    if (node.kind === "file" || file.lines.length === 0) {
      this.files.delete(file.result.absolutePath);
      this.sorted = undefined;
      this.refresh();
    } else if (flush && this.pending) {
      this.refresh();
    } else {
      this.changed.fire(file);
    }
  }

  expandAllFiles(): void {
    this.generation++;
    this.expandAll = true;
    this.refresh();
  }

  roots(): FileNode[] {
    this.sorted ??= [...this.files.values()].sort((a, b) => this.compare(a, b));
    return this.sorted;
  }

  /** The line after or before `from` in display order, wrapping around. */
  neighbor(from: ResultNode | undefined, direction: 1 | -1): LineNode | undefined {
    const lines = this.roots().flatMap((f) => f.lines);
    if (lines.length === 0) {
      return undefined;
    }
    let index: number;
    if (!from) {
      index = direction === 1 ? 0 : lines.length - 1;
    } else if (from.kind === "file") {
      const first = lines.indexOf(from.lines[0]);
      index = direction === 1 ? first : first - 1;
    } else {
      index = lines.indexOf(from) + direction;
    }
    return lines[(index + lines.length) % lines.length];
  }

  contains(node: ResultNode): boolean {
    const file = node.kind === "file" ? node : node.file;
    return this.files.get(file.result.absolutePath) === file && (node.kind === "file" || file.lines.includes(node));
  }

  /** The line to select once `node` is dismissed: the next one after it, else the one before. */
  successor(node: ResultNode): LineNode | undefined {
    const lines = this.roots().flatMap((f) => f.lines);
    const own = node.kind === "file" ? node.lines : [node];
    const first = lines.indexOf(own[0]);
    if (first < 0) {
      return undefined;
    }
    return lines[lines.indexOf(own[own.length - 1]) + 1] ?? lines[first - 1];
  }

  /** Called by the view; each call counts as a read (see {@link nextRefreshAt}). */
  getChildren(node?: ResultNode): ResultNode[] {
    this.lastReadAt = Date.now();
    if (!node) {
      this.awaitingRead = false;
      this.rootReadAt = this.lastReadAt;
      const roots = this.roots();
      this.shown = new Set(roots);
      this.schedule();
      return roots;
    }
    return node.kind === "file" ? node.lines : [];
  }

  getParent(node: ResultNode): ResultNode | undefined {
    return node.kind === "line" ? node.file : undefined;
  }

  /** Called by the view; each call counts as a read. */
  getTreeItem(node: ResultNode): vscode.TreeItem {
    this.lastReadAt = Date.now();
    return node.kind === "file" ? this.fileItem(node) : this.lineItem(node);
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const { result } = node;
    const item = new vscode.TreeItem(vscode.Uri.file(result.absolutePath), this.collapsibleState(node));
    item.id = `f/${this.generation}/${result.absolutePath}`;
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = "file";
    const dir = path.posix.dirname(result.relativePath);
    const folderName = this.folders.length > 1 ? this.folderName(result.folder) : undefined;
    const location = [folderName, dir === "." ? undefined : dir].filter(Boolean).join("/");
    const count = node.lines.reduce((n, l) => n + l.line.ranges.length, 0);
    item.description = [location, String(count), result.filtered ? undefined : "unfiltered"].filter(Boolean).join(" · ");
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(result.absolutePath);
    tooltip.appendMarkdown(`\n\n${count} result${count === 1 ? "" : "s"}`);
    if (!result.filtered) {
      tooltip.appendMarkdown("\n\n*Unfiltered:* not a C-family file, so comment matches are not removed.");
    }
    item.tooltip = tooltip;
    return item;
  }

  private lineItem(node: LineNode): vscode.TreeItem {
    const { line } = node;
    const preview = makePreview(line.text, line.ranges);
    const item = new vscode.TreeItem(
      { label: preview.label, highlights: preview.highlights },
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `l/${this.generation}/${node.file.result.absolutePath}:${line.lineNumber}`;
    item.contextValue = "line";
    item.tooltip = `${node.file.result.relativePath}:${line.lineNumber}\n${preview.label}`;
    item.accessibilityInformation = {
      label: `${preview.label}, line ${line.lineNumber} in ${node.file.result.relativePath}`,
    };
    // vscode.open lets the tree apply the gesture: preview on click, pin on double-click, side by side with Ctrl/Alt.
    const args = openArgs(node);
    item.command = {
      command: "vscode.open",
      title: "Open Result",
      arguments: [vscode.Uri.file(args.path), { selection: new vscode.Range(args.line - 1, args.start, args.line - 1, args.end) }],
    };
    return item;
  }

  private collapsibleState(node: FileNode): vscode.TreeItemCollapsibleState {
    const { Collapsed, Expanded } = vscode.TreeItemCollapsibleState;
    if (this.expandAll) {
      return Expanded;
    }
    switch (this.collapseMode()) {
      case "alwaysCollapse":
        return Collapsed;
      case "auto":
        return node.lines.length > AUTO_COLLAPSE_THRESHOLD ? Collapsed : Expanded;
      default:
        return Expanded;
    }
  }

  private folderName(folder: string): string {
    return this.folders.find((f) => f.uri.fsPath === folder)?.name ?? path.basename(folder);
  }

  private folderIndex(folder: string): number {
    const i = this.folders.findIndex((f) => f.uri.fsPath === folder);
    return i < 0 ? this.folders.length : i;
  }

  private compare(a: FileNode, b: FileNode): number {
    return (
      this.folderIndex(a.result.folder) - this.folderIndex(b.result.folder) ||
      collator.compare(a.result.relativePath, b.result.relativePath)
    );
  }
}
