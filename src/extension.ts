import * as vscode from "vscode";
import type { CodeOnlyApi, ResultEntry } from "./api";
import { MatchHighlights } from "./ui/matchHighlights";
import { QUERY_VIEW_ID, QueryViewProvider } from "./ui/queryView";
import { type OpenResultArgs, type ResultNode, ResultsTree, isResultNode, openArgs } from "./ui/resultsTree";
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

  const target = (node: unknown): ResultNode | undefined =>
    isResultNode(node) ? node : treeView.selection[0];

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
    const next = tree.neighbor(treeView.selection[0], direction);
    if (next) {
      await treeView.reveal(next, { select: true, focus: false });
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
    vscode.commands.registerCommand("codeonly.openToSide", (node?: unknown) => {
      const n = target(node);
      if (n?.kind === "line") {
        return open(openArgs(n), true);
      }
      if (n?.kind === "file") {
        return open({ path: n.result.absolutePath, line: 1, start: 0, end: 0 }, true);
      }
      return undefined;
    }),
    vscode.commands.registerCommand("codeonly.dismiss", async (node?: unknown) => {
      const n = target(node);
      if (!n) {
        return;
      }
      // Like the Search view, when the selected result goes away the next one is selected and shown.
      const selected = treeView.selection[0];
      const holdsSelection = selected === n || (n.kind === "file" && selected?.kind === "line" && selected.file === n);
      const next = holdsSelection ? tree.successor(n) : undefined;
      tree.dismiss(n);
      controller.resultsChanged();
      if (next && !tree.isEmpty) {
        // The successor may belong to a file added during a search and not yet shown.
        tree.refresh();
        await treeView.reveal(next, { select: true, focus: false });
        await open(openArgs(next));
      }
    }),
    vscode.commands.registerCommand("codeonly.copy", (node?: unknown) => {
      const n = target(node);
      return copy(n?.kind === "line" ? n.line.text : n?.result.absolutePath);
    }),
    vscode.commands.registerCommand("codeonly.copyPath", (node?: unknown) => {
      const n = target(node);
      return copy(n && (n.kind === "line" ? n.file : n).result.absolutePath);
    }),
    vscode.commands.registerCommand("codeonly.copyRelativePath", (node?: unknown) => {
      const n = target(node);
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
    resultTree: async () => tree.getChildren().map(entry),
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
