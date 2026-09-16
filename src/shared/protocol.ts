/** Query form state shared by the query view and the extension. Globs use the Search view's syntax. */
export interface QueryForm {
  readonly pattern: string;
  readonly isRegExp: boolean;
  readonly isCaseSensitive: boolean;
  readonly isWordMatch: boolean;
  readonly includes: string;
  readonly excludes: string;
  readonly showDetails: boolean;
}

export const EMPTY_FORM: QueryForm = {
  pattern: "",
  isRegExp: false,
  isCaseSensitive: false,
  isWordMatch: false,
  includes: "",
  excludes: "",
  showDetails: false,
};

export type SearchStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "searching"; readonly matchCount: number; readonly fileCount: number }
  | {
      readonly kind: "done";
      readonly matchCount: number;
      readonly fileCount: number;
      readonly hiddenLineCount: number;
      readonly unfilteredFileCount: number;
      readonly limitHit: boolean;
      readonly maxResults?: number;
      readonly durationMs: number;
      readonly warningCount: number;
      /** Stopped by the user; counts cover what was found until then. */
      readonly cancelled: boolean;
    }
  | { readonly kind: "error"; readonly message: string; readonly action?: StatusCommand };

/** Commands the query view can ask the extension to run. */
export type StatusCommand =
  | "showHiddenLines"
  | "openExcludeSettings"
  | "openMaxResultsSetting"
  | "openRipgrepSetting"
  | "showLog"
  | "focusResults";

export interface ViewConfig {
  readonly searchOnType: boolean;
  readonly debounceMs: number;
}

export type ToWebview =
  | {
      readonly type: "init";
      readonly form: QueryForm;
      readonly history: readonly string[];
      readonly config: ViewConfig;
      readonly status: SearchStatus;
    }
  | { readonly type: "form"; readonly form: QueryForm; readonly focus: boolean }
  | { readonly type: "status"; readonly status: SearchStatus }
  | { readonly type: "history"; readonly history: readonly string[] }
  | { readonly type: "config"; readonly config: ViewConfig }
  | { readonly type: "focus" };

export type FromWebview =
  | { readonly type: "ready" }
  /** `commit` marks an explicit search (Enter) whose pattern goes into history. */
  | { readonly type: "search"; readonly form: QueryForm; readonly commit: boolean }
  | { readonly type: "formChanged"; readonly form: QueryForm }
  | { readonly type: "cancel" }
  | { readonly type: "command"; readonly command: StatusCommand };
