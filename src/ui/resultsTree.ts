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
const REFRESH_DELAY_MS = 150;

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

  private files = new Map<string, FileNode>();
  private sorted: FileNode[] | undefined;
  private folders: readonly vscode.WorkspaceFolder[] = [];
  /** Part of every item id; bumping it makes the tree forget expansion state. */
  private generation = 0;
  private expandAll = false;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly collapseMode: () => CollapseMode) {}

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.changed.dispose();
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

  reset(folders: readonly vscode.WorkspaceFolder[]): void {
    this.files = new Map();
    this.sorted = undefined;
    this.folders = folders;
    this.generation++;
    this.expandAll = false;
    this.refresh();
  }

  add(result: FileResult): void {
    if (result.lines.length === 0) {
      return;
    }
    const node: FileNode = { kind: "file", result, lines: [] };
    node.lines = result.lines.map((line) => ({ kind: "line", file: node, line }));
    this.files.set(result.absolutePath, node);
    this.sorted = undefined;
    this.refreshTimer ??= setTimeout(() => this.refresh(), REFRESH_DELAY_MS);
  }

  /** Pushes pending changes to the view now. */
  refresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.changed.fire(undefined);
  }

  dismiss(node: ResultNode): void {
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

  getChildren(node?: ResultNode): ResultNode[] {
    if (!node) {
      return this.roots();
    }
    return node.kind === "file" ? node.lines : [];
  }

  getParent(node: ResultNode): ResultNode | undefined {
    return node.kind === "line" ? node.file : undefined;
  }

  getTreeItem(node: ResultNode): vscode.TreeItem {
    return node.kind === "file" ? this.fileItem(node) : this.lineItem(node);
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const { result } = node;
    const item = new vscode.TreeItem(vscode.Uri.file(result.absolutePath), this.collapsibleState(node));
    item.id = `${this.generation}/${result.absolutePath}`;
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
    item.id = `${this.generation}/${node.file.result.absolutePath}:${line.lineNumber}`;
    item.contextValue = "line";
    item.tooltip = `${node.file.result.relativePath}:${line.lineNumber}\n${line.text.trim()}`;
    item.accessibilityInformation = {
      label: `${line.text.trim()}, line ${line.lineNumber} in ${node.file.result.relativePath}`,
    };
    item.command = { command: "codeonly.openResult", title: "Open Result", arguments: [openArgs(node)] };
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
