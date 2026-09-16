import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { FromWebview, QueryForm, SearchStatus, StatusCommand, ToWebview, ViewConfig } from "../shared/protocol";

export const QUERY_VIEW_ID = "codeonly.query";

export interface QueryViewHost {
  viewState(): { form: QueryForm; history: readonly string[]; config: ViewConfig; status: SearchStatus };
  onSearch(form: QueryForm, commit: boolean): void;
  onFormChanged(form: QueryForm): void;
  onCancel(): void;
  onCommand(command: StatusCommand): void;
}

export class QueryViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private focusPending = false;
  private readyWaiters: (() => void)[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: QueryViewHost,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    const scripts = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };
    view.webview.html = this.html(view.webview, media, scripts);
    view.webview.onDidReceiveMessage((message: FromWebview) => this.receive(message));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  /** Delivered only while the view is loaded; the full state is resent when it loads again. */
  post(message: ToWebview): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    }
  }

  /** Moves keyboard focus to the search input once the view is loaded. */
  focusInput(): void {
    if (this.view && this.ready) {
      this.post({ type: "focus" });
    } else {
      this.focusPending = true;
    }
  }

  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  private receive(message: FromWebview): void {
    switch (message.type) {
      case "ready": {
        this.ready = true;
        this.post({ type: "init", ...this.host.viewState() });
        if (this.focusPending) {
          this.focusPending = false;
          this.post({ type: "focus" });
        }
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        waiters.forEach((resolve) => resolve());
        break;
      }
      case "search":
        this.host.onSearch(message.form, message.commit);
        break;
      case "formChanged":
        this.host.onFormChanged(message.form);
        break;
      case "cancel":
        this.host.onCancel();
        break;
      case "command":
        this.host.onCommand(message.command);
        break;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri, scripts: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "search.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(scripts, "search.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Code Search</title>
</head>
<body>
<form class="query" id="query" autocomplete="off" novalidate>
  <div class="field" id="patternField">
    <input id="pattern" class="input" type="text" spellcheck="false"
      placeholder="Search code" aria-label="Search code. Lines whose matches are only in comments are hidden."
      aria-describedby="status">
    <div class="toggles" role="group" aria-label="Search options">
      <button type="button" class="toggle" id="case" role="checkbox" aria-checked="false"
        title="Match Case (Alt+C)" aria-label="Match Case"><span class="glyph" aria-hidden="true">Aa</span></button>
      <button type="button" class="toggle" id="word" role="checkbox" aria-checked="false"
        title="Match Whole Word (Alt+W)" aria-label="Match Whole Word"><span class="glyph glyph-word" aria-hidden="true">ab</span></button>
      <button type="button" class="toggle" id="regex" role="checkbox" aria-checked="false"
        title="Use Regular Expression (Alt+R)" aria-label="Use Regular Expression"><span class="glyph glyph-regex" aria-hidden="true">.*</span></button>
    </div>
  </div>
  <button type="button" class="icon-button" id="details" aria-expanded="false" aria-controls="detailsPanel"
    title="Toggle Search Details" aria-label="Toggle Search Details"><span aria-hidden="true">···</span></button>
  <div class="details" id="detailsPanel" hidden>
    <div class="field">
      <label class="prefix" for="includes" title="files to include">include</label>
      <input id="includes" class="input" type="text" spellcheck="false"
        placeholder="e.g. *.c, ./drivers/gpu" aria-label="files to include">
    </div>
    <div class="field">
      <label class="prefix" for="excludes" title="files to exclude">exclude</label>
      <input id="excludes" class="input" type="text" spellcheck="false"
        placeholder="e.g. **/tests/**" aria-label="files to exclude">
    </div>
  </div>
  <div class="status" id="status" role="status" aria-live="polite"></div>
</form>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
