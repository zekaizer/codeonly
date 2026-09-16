import {
  EMPTY_FORM,
  type FromWebview,
  type QueryForm,
  type SearchStatus,
  type StatusCommand,
  type ToWebview,
  type ViewConfig,
} from "../shared/protocol";

interface VsCodeApi {
  postMessage(message: FromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing #${id}`);
  }
  return el as T;
}

const formEl = element<HTMLFormElement>("query");
const pattern = element<HTMLInputElement>("pattern");
const patternField = element<HTMLDivElement>("patternField");
const includes = element<HTMLInputElement>("includes");
const excludes = element<HTMLInputElement>("excludes");
const caseToggle = element<HTMLButtonElement>("case");
const wordToggle = element<HTMLButtonElement>("word");
const regexToggle = element<HTMLButtonElement>("regex");
const detailsButton = element<HTMLButtonElement>("details");
const detailsPanel = element<HTMLDivElement>("detailsPanel");
const statusEl = element<HTMLDivElement>("status");

const HISTORY_LIMIT = 50;

let config: ViewConfig = { searchOnType: true, debounceMs: 300 };
let history: string[] = [];
/** Index into `history` while browsing it with the arrow keys; -1 when editing. */
let historyIndex = -1;
let draft = "";
let debounce: ReturnType<typeof setTimeout> | undefined;

render(((vscode.getState() as { form?: QueryForm } | undefined)?.form) ?? EMPTY_FORM);

function isChecked(button: HTMLButtonElement): boolean {
  return button.getAttribute("aria-checked") === "true";
}

function setChecked(button: HTMLButtonElement, checked: boolean): void {
  button.setAttribute("aria-checked", String(checked));
}

function readForm(): QueryForm {
  return {
    pattern: pattern.value,
    isCaseSensitive: isChecked(caseToggle),
    isWordMatch: isChecked(wordToggle),
    isRegExp: isChecked(regexToggle),
    includes: includes.value,
    excludes: excludes.value,
    showDetails: detailsPanel.hidden === false,
  };
}

function setValue(input: HTMLInputElement, value: string): void {
  if (input.value !== value) {
    input.value = value;
  }
}

function render(form: QueryForm): void {
  setValue(pattern, form.pattern);
  setValue(includes, form.includes);
  setValue(excludes, form.excludes);
  setChecked(caseToggle, form.isCaseSensitive);
  setChecked(wordToggle, form.isWordMatch);
  setChecked(regexToggle, form.isRegExp);
  showDetails(form.showDetails);
  vscode.setState({ form });
}

function showDetails(show: boolean): void {
  detailsPanel.hidden = !show;
  detailsButton.setAttribute("aria-expanded", String(show));
}

function post(message: FromWebview): void {
  vscode.postMessage(message);
}

function stateChanged(): QueryForm {
  const form = readForm();
  vscode.setState({ form });
  return form;
}

function searchNow(commit: boolean): void {
  clearTimeout(debounce);
  debounce = undefined;
  const form = stateChanged();
  if (commit && form.pattern) {
    history = [...history.filter((h) => h !== form.pattern), form.pattern].slice(-HISTORY_LIMIT);
    historyIndex = -1;
  }
  post({ type: "search", form, commit });
}

function edited(): void {
  const form = stateChanged();
  post({ type: "formChanged", form });
  clearTimeout(debounce);
  debounce = config.searchOnType ? setTimeout(() => searchNow(false), config.debounceMs) : undefined;
}

function toggle(button: HTMLButtonElement): void {
  setChecked(button, !isChecked(button));
  if (pattern.value) {
    searchNow(false);
  } else {
    post({ type: "formChanged", form: stateChanged() });
  }
}

function browseHistory(direction: -1 | 1): void {
  if (history.length === 0) {
    return;
  }
  if (historyIndex === -1) {
    if (direction === 1) {
      return;
    }
    draft = pattern.value;
    historyIndex = history.length;
  }
  const next = historyIndex + direction;
  if (next < 0) {
    return;
  }
  if (next >= history.length) {
    historyIndex = -1;
    pattern.value = draft;
  } else {
    historyIndex = next;
    pattern.value = history[next];
  }
  pattern.setSelectionRange(pattern.value.length, pattern.value.length);
  edited();
}

function focusPattern(): void {
  pattern.focus();
  pattern.select();
}

for (const input of [pattern, includes, excludes]) {
  input.addEventListener("input", () => {
    if (input === pattern) {
      historyIndex = -1;
    }
    edited();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      searchNow(true);
    } else if (e.key === "Escape") {
      post({ type: "cancel" });
    }
  });
}

pattern.addEventListener("keydown", (e) => {
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    browseHistory(-1);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    browseHistory(1);
  }
});

caseToggle.addEventListener("click", () => toggle(caseToggle));
wordToggle.addEventListener("click", () => toggle(wordToggle));
regexToggle.addEventListener("click", () => toggle(regexToggle));

detailsButton.addEventListener("click", () => {
  const show = detailsPanel.hidden !== false;
  showDetails(show);
  post({ type: "formChanged", form: stateChanged() });
  if (show) {
    includes.focus();
  }
});

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  searchNow(true);
});

document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
    return;
  }
  const button = e.code === "KeyC" ? caseToggle : e.code === "KeyW" ? wordToggle : e.code === "KeyR" ? regexToggle : undefined;
  if (button) {
    e.preventDefault();
    toggle(button);
  }
});

statusEl.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>("[data-command]");
  if (link) {
    e.preventDefault();
    post({ type: "command", command: link.dataset.command as StatusCommand });
  }
});

statusEl.addEventListener("keydown", (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>("[data-command]");
  if (link && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    post({ type: "command", command: link.dataset.command as StatusCommand });
  }
});

window.addEventListener("focus", () => {
  if (!document.activeElement || document.activeElement === document.body) {
    focusPattern();
  }
});

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      config = message.config;
      history = [...message.history];
      render(message.form);
      renderStatus(message.status);
      break;
    case "form":
      render(message.form);
      if (message.focus) {
        focusPattern();
      }
      break;
    case "status":
      renderStatus(message.status);
      break;
    case "history":
      history = [...message.history];
      break;
    case "config":
      config = message.config;
      break;
    case "focus":
      focusPattern();
      break;
  }
});

const numberFormat = new Intl.NumberFormat();

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${numberFormat.format(n)} ${n === 1 ? singular : plural}`;
}

function text(parent: HTMLElement, value: string): void {
  parent.append(document.createTextNode(value));
}

function link(parent: HTMLElement, label: string, command: StatusCommand, title?: string): void {
  const a = document.createElement("a");
  a.textContent = label;
  a.dataset.command = command;
  a.tabIndex = 0;
  a.setAttribute("role", "button");
  if (title) {
    a.title = title;
  }
  parent.append(a);
}

function line(): HTMLDivElement {
  const div = document.createElement("div");
  statusEl.append(div);
  return div;
}

function renderStatus(status: SearchStatus): void {
  statusEl.replaceChildren();
  statusEl.classList.toggle("error", status.kind === "error");
  patternField.classList.toggle("error", status.kind === "error");
  statusEl.title = "";
  switch (status.kind) {
    case "idle":
      break;
    case "searching": {
      const first = line();
      text(first, status.matchCount > 0 ? `Searching… ${count(status.matchCount, "result")} so far` : "Searching…");
      break;
    }
    case "done": {
      const first = line();
      if (status.cancelled) {
        text(first, "Search stopped. ");
      }
      text(
        first,
        status.matchCount === 0
          ? "No results found."
          : `${count(status.matchCount, "result")} in ${count(status.fileCount, "file")}`,
      );
      if (status.hiddenLineCount > 0) {
        text(first, " · ");
        link(
          first,
          `${count(status.hiddenLineCount, "comment-only line")} hidden`,
          "showHiddenLines",
          "Show the hidden lines and why they were hidden",
        );
      }
      if (status.unfilteredFileCount > 0) {
        const span = document.createElement("span");
        span.textContent = ` · ${count(status.unfilteredFileCount, "file")} unfiltered`;
        span.title = "Files outside the C family are listed without comment filtering.";
        first.append(span);
      }
      if (status.warningCount > 0) {
        text(first, " · ");
        link(first, count(status.warningCount, "warning"), "showLog");
      }
      if (status.limitHit) {
        const second = line();
        text(second, `Only the first ${count(status.maxResults ?? 0, "result")} are shown. `);
        link(second, "Change limit", "openMaxResultsSetting");
      }
      if (status.matchCount === 0 && !status.cancelled) {
        const second = line();
        text(second, "Check your ");
        link(second, "exclude settings", "openExcludeSettings");
        text(second, " and ignore files.");
      }
      statusEl.title = `${(status.durationMs / 1000).toFixed(2)} s`;
      break;
    }
    case "error": {
      const first = line();
      text(first, status.message);
      if (status.action === "openRipgrepSetting") {
        text(first, " ");
        link(first, "Configure", "openRipgrepSetting");
      } else if (status.action === "showLog") {
        text(first, " ");
        link(first, "Show log", "showLog");
      }
      break;
    }
  }
}

post({ type: "ready" });
