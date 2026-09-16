import * as vscode from "vscode";
import type { ResultsTree } from "./resultsTree";

/**
 * Highlights the shown matches in visible editors while the results view is visible, like the
 * Search view does. The search reads files on disk, so a document with unsaved changes at search
 * time, or edited after it, gets no highlights until the next search.
 */
export class MatchHighlights implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly stale = new Set<string>();
  private readonly applied = new Map<string, vscode.Range[]>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly tree: ResultsTree,
    private readonly isVisible: () => boolean,
  ) {
    this.subscriptions = [
      this.decoration,
      tree.onDidReset(() => this.markUnsavedStale()),
      tree.onDidChangeTreeData(() => this.update()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      // Any edit counts, also to a file whose results have not arrived yet.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0 && !this.stale.has(e.document.uri.toString())) {
          this.stale.add(e.document.uri.toString());
          if (tree.fileFor(e.document.uri)) {
            this.update();
          }
        }
      }),
    ];
  }

  dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private markUnsavedStale(): void {
    this.stale.clear();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty) {
        this.stale.add(doc.uri.toString());
      }
    }
  }

  rangesFor(uri: vscode.Uri): readonly vscode.Range[] {
    return this.applied.get(uri.toString()) ?? [];
  }

  update(): void {
    this.applied.clear();
    const visible = this.isVisible();
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = visible ? this.compute(editor.document.uri) : [];
      if (ranges.length > 0) {
        this.applied.set(editor.document.uri.toString(), ranges);
      }
      editor.setDecorations(this.decoration, ranges);
    }
  }

  private compute(uri: vscode.Uri): vscode.Range[] {
    if (this.stale.has(uri.toString())) {
      return [];
    }
    const file = this.tree.fileFor(uri);
    if (!file) {
      return [];
    }
    return file.lines.flatMap(({ line }) =>
      line.ranges.map((r) => new vscode.Range(line.lineNumber - 1, r.start, line.lineNumber - 1, r.end)),
    );
  }
}
