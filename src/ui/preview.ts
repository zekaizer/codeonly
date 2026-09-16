import type { ColumnRange } from "../search/codeSearch";

export interface Preview {
  readonly label: string;
  /** `[start, end)` offsets into {@link label}. */
  readonly highlights: [number, number][];
}

const ELLIPSIS = "…";
/** A first match further than this from the indentation is shown with only {@link CONTEXT_BEFORE} characters before it. */
const MAX_LEAD = 40;
const CONTEXT_BEFORE = 20;
const MAX_LENGTH = 250;

/** Builds a one-line tree label for a result line, keeping the first match visible. */
export function makePreview(text: string, ranges: readonly ColumnRange[]): Preview {
  const lead = text.length - text.trimStart().length;
  const trimmedEnd = text.trimEnd().length;
  let start = lead;
  const first = ranges.length > 0 ? ranges[0].start : lead;
  if (first - lead > MAX_LEAD) {
    start = first - CONTEXT_BEFORE;
    if (isLowSurrogate(text.charCodeAt(start))) {
      start--;
    }
  }
  let end = Math.max(start, trimmedEnd);
  let suffix = "";
  if (end - start > MAX_LENGTH) {
    end = start + MAX_LENGTH;
    if (isHighSurrogate(text.charCodeAt(end - 1))) {
      end--;
    }
    suffix = ELLIPSIS;
  }
  const prefix = start > lead ? ELLIPSIS : "";
  const shift = prefix.length - start;
  const highlights: [number, number][] = [];
  for (const r of ranges) {
    const s = Math.max(r.start, start);
    const e = Math.min(r.end, end);
    if (e > s) {
      highlights.push([s + shift, e + shift]);
    }
  }
  return { label: prefix + text.slice(start, end).replace(/\t/g, " ") + suffix, highlights };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
