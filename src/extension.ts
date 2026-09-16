import * as vscode from "vscode";
import type { CodeOnlyApi, ResultEntry } from "./api";
import { MatchHighlights } from "./ui/matchHighlights";
import { QUERY_VIEW_ID, QueryViewProvider } from "./ui/queryView";
import {
  type LineNode,
  type OpenResultArgs,
  type ResultNode,
  ResultsTree,
  isResultNode,
  openArgs,
} from "./ui/resultsTree";
import { RESULTS_VIEW_ID, SearchController } from "./ui/searchController";
import * as settings from "./ui/settings";

export function activate(context: vscode.ExtensionContext): CodeOnlyApi {
  const log = vscode.window.createOutputChannel("CodeOnly", { log: true });
  const tree = new ResultsTree(settings.collapseMode);
  const treeView = vscode.window.createTreeView<ResultNode>(RESULTS_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const highlights = new MatchHighlights(tree, () => treeView.visible);
  const controller = new SearchController(context.workspaceState, tree, treeView, log);
  const queryView = new QueryViewProvider(context.extensionUri, controller);
  controller.view = queryView;

  let lastSelected: ResultNode | undefined;
  // While VS Code rebuilds the tree it reports no selection, so the last one is kept.
  const selected = (): ResultNode | undefined =>
    treeView.selection[0] ?? (lastSelected && tree.contains(lastSelected) ? lastSelected : undefined);
  // A row passes itself, or undefined if VS Code could not resolve it; a key binding or the
  // Command Palette passes nothing and means the selection.
  const target = (args: unknown[]): ResultNode | undefined =>
    args.length === 0 ? selected() : isResultNode(args[0]) ? args[0] : undefined;

  const reveal = async (node: LineNode) => {
    lastSelected = node;
    try {
      await treeView.reveal(node, { select: true, focus: false });
    } catch {
      // VS Code cannot resolve the item when a refresh starts meanwhile; the editor still opens.
    }
  };

  const open = async (args: OpenResultArgs, sideBySide = false) => {
    const line = args.line - 1;
    const uri = vscode.Uri.file(args.path);
    // Like a click in the tree, reveal the file where it is already visible.
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(line, args.start, line, args.end),
      preview: !sideBySide,
      preserveFocus: !sideBySide,
      viewColumn: sideBySide ? vscode.ViewColumn.Beside : visible?.viewColumn,
    });
    controller.rememberShown();
  };

  const step = async (direction: 1 | -1) => {
    const next = tree.neighbor(selected(), direction);
    if (next) {
      // The view can only select a result it has read.
      if (!tree.isShown(next.file)) {
        tree.flush();
      }
      await reveal(next);
      await open(openArgs(next));
    }
  };

  const copy = async (text: string | undefined) => {
    if (text !== undefined) {
      await vscode.env.clipboard.writeText(text);
    }
  };

  context.subscriptions.push(
    log,
    tree,
    treeView,
    highlights,
    controller,
    treeView.onDidChangeVisibility(() => highlights.update()),
    // Opening a result is the Search view's cue to keep the term in history.
    treeView.onDidChangeSelection((e) => {
      lastSelected = e.selection[0] ?? lastSelected;
      if (e.selection.some((node) => node.kind === "line")) {
        controller.rememberShown();
      }
    }),
    vscode.window.registerWebviewViewProvider(QUERY_VIEW_ID, queryView),
    vscode.commands.registerCommand("codeonly.focusSearch", (options?: { seed?: boolean }) =>
      controller.focusSearch(options),
    ),
    vscode.commands.registerCommand("codeonly.findInFolder", (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const uris = selected?.length ? selected : uri ? [uri] : [];
      return uris.length > 0 ? controller.findInFolder(uris) : undefined;
    }),
    vscode.commands.registerCommand("codeonly.rerun", () => controller.rerun()),
    vscode.commands.registerCommand("codeonly.cancel", () => controller.onCancel()),
    vscode.commands.registerCommand("codeonly.clear", () => controller.clear()),
    vscode.commands.registerCommand("codeonly.expandAll", () => tree.expandAllFiles()),
    vscode.commands.registerCommand("codeonly.showLog", () => log.show(true)),
    vscode.commands.registerCommand("codeonly.nextResult", () => step(1)),
    vscode.commands.registerCommand("codeonly.previousResult", () => step(-1)),
    vscode.commands.registerCommand("codeonly.openToSide", (...args: unknown[]) => {
      const n = target(args);
      if (n?.kind === "line") {
        return open(openArgs(n), true);
      }
      if (n?.kind === "file") {
        return open({ path: n.result.absolutePath, line: 1, start: 0, end: 0 }, true);
      }
      return undefined;
    }),
    vscode.commands.registerCommand("codeonly.dismiss", async (...args: unknown[]) => {
      const n = target(args);
      if (!n) {
        return;
      }
      // Like the Search view, when the selected result goes away the next one is selected and shown.
      const current = selected();
      const holdsSelection = current === n || (n.kind === "file" && current?.kind === "line" && current.file === n);
      const next = holdsSelection ? tree.successor(n) : undefined;
      tree.dismiss(n, next !== undefined && !tree.isShown(next.file));
      controller.resultsChanged();
      if (next && !tree.isEmpty) {
        await reveal(next);
        // The reveal waits for the refresh; a new search may have replaced the results meanwhile.
        if (tree.contains(next)) {
          await open(openArgs(next));
        }
      }
      // The Search view returns focus to its results after a removal.
      await vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("codeonly.copy", (...args: unknown[]) => {
      const n = target(args);
      return copy(n?.kind === "line" ? n.line.text : n?.result.absolutePath);
    }),
    vscode.commands.registerCommand("codeonly.copyPath", (...args: unknown[]) => {
      const n = target(args);
      return copy(n && (n.kind === "line" ? n.file : n).result.absolutePath);
    }),
    vscode.commands.registerCommand("codeonly.copyRelativePath", (...args: unknown[]) => {
      const n = target(args);
      return copy(n && (n.kind === "line" ? n.file : n).result.relativePath);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("search.searchOnType") || e.affectsConfiguration("search.searchOnTypeDebouncePeriod")) {
        controller.configChanged();
      }
      if (e.affectsConfiguration("search.collapseResults")) {
        tree.refresh();
      }
    }),
  );

  const entry = (node: ResultNode): ResultEntry => ({
    node,
    item: tree.getTreeItem(node),
    children: tree.getChildren(node).map(entry),
  });

  return {
    search: (form) => controller.search({ ...controller.currentForm(), ...form }, false, true),
    form: () => controller.currentForm(),
    status: () => controller.currentStatus(),
    resultTree: async () => tree.roots().map(entry),
    hiddenLineReport: () => controller.hiddenLineReport(),
    highlightedRanges: (uri) => highlights.rangesFor(uri),
    editForm: (form) => controller.onFormChanged({ ...controller.currentForm(), ...form }),
    history: () => controller.searchHistory(),
    statusCommand: (command) => controller.runCommand(command),
    contextKeys: () => controller.contextKeys(),
    queryViewReady: () => queryView.whenReady(),
  };
}

export function deactivate(): void {}
