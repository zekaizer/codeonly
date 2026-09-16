import * as fs from "node:fs";
import * as path from "node:path";
import { isCFamilyFile } from "../classify/cFamily";
import { classifyRange, scanRegions } from "../classify/cLexer";
import { REASON_COMMENT_ONLY, decideLine } from "../classify/lineDecision";
import type { FolderOptions, SearchQuery } from "./query";
import { type RipgrepFile, type RipgrepLine, buildRipgrepArgs, queryErrorMessage, runRipgrep } from "./ripgrep";

/** UTF-16 column range within {@link ResultLine.text}. */
export interface ColumnRange {
  readonly start: number;
  readonly end: number;
}

export interface ResultLine {
  /** 1-based. */
  readonly lineNumber: number;
  /** Line text without its line terminator. */
  readonly text: string;
  /** Matches shown for the line: code matches in filtered files, every match otherwise. */
  readonly ranges: readonly ColumnRange[];
}

export interface ExcludedLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly reason: string;
}

export interface FileResult {
  readonly folder: string;
  /** Folder-relative path with forward slashes. */
  readonly relativePath: string;
  readonly absolutePath: string;
  /** False if the file is outside the C-family set and was listed as-is. */
  readonly filtered: boolean;
  readonly lines: readonly ResultLine[];
  readonly excluded: readonly ExcludedLine[];
}

export interface SearchFolder {
  readonly path: string;
  readonly options: FolderOptions;
}

export interface SearchRequest {
  readonly rgPath: string;
  readonly query: SearchQuery;
  readonly folders: readonly SearchFolder[];
  /** Upper bound on shown matches; undefined for no bound. */
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
  /** Called once per file that had matches, including files whose lines were all excluded. */
  readonly onResult: (result: FileResult) => void;
}

export interface SearchSummary {
  /** Files with at least one shown line. */
  readonly fileCount: number;
  readonly lineCount: number;
  readonly matchCount: number;
  readonly excludedLineCount: number;
  /** True if matches beyond {@link SearchRequest.maxResults} were dropped. */
  readonly limitHit: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  /** ripgrep diagnostics from a search that still produced results. */
  readonly warnings: readonly string[];
}

/** The search could not run, e.g. an invalid regular expression. The message is user-facing. */
export class SearchError extends Error {
  constructor(
    message: string,
    /** Diagnostic text for the log, e.g. ripgrep's stderr. */
    readonly detail?: string,
    /** The ripgrep executable could not be started; the query itself may be fine. */
    readonly ripgrepFailed = false,
  ) {
    super(message);
  }
}

const FILE_CONCURRENCY = 16;
const UNREADABLE = "unclassifiable: cannot read file";
const CHANGED = "unclassifiable: file changed during search";
const UTF16 = "unclassifiable: UTF-16 file";

/** Searches each folder with ripgrep and drops comment-only lines from C-family files. */
export async function searchCode(request: SearchRequest): Promise<SearchSummary> {
  const started = performance.now();
  const { signal, maxResults } = request;
  const stop = new AbortController();
  const forwardAbort = () => stop.abort();
  signal?.addEventListener("abort", forwardAbort);
  if (signal?.aborted) {
    stop.abort();
  }

  if (request.query.isRegExp && hasNewlineEscape(request.query.pattern)) {
    throw new SearchError("Multi-line patterns are not supported.");
  }

  let fileCount = 0;
  let lineCount = 0;
  let matchCount = 0;
  let excludedLineCount = 0;
  let limitHit = false;
  const warnings: string[] = [];
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
    stop.abort();
  };

  const emit = (result: FileResult) => {
    if (signal?.aborted || limitHit || failure) {
      return;
    }
    let lines = result.lines;
    let matches = countMatches(lines);
    if (maxResults !== undefined && matchCount + matches > maxResults) {
      lines = truncate(lines, maxResults - matchCount);
      matches = countMatches(lines);
      limitHit = true;
      stop.abort();
    }
    if (lines.length > 0) {
      fileCount++;
    }
    lineCount += lines.length;
    matchCount += matches;
    excludedLineCount += result.excluded.length;
    request.onResult(lines === result.lines ? result : { ...result, lines });
  };

  try {
    for (const folder of request.folders) {
      if (stop.signal.aborted) {
        break;
      }
      const pending = new Set<Promise<void>>();
      let sawFile = false;
      const exit = await runRipgrep(
        request.rgPath,
        buildRipgrepArgs(request.query, folder.options),
        folder.path,
        async (file) => {
          sawFile = true;
          const task = processFile(folder.path, file).then(emit).catch(fail);
          pending.add(task);
          void task.finally(() => pending.delete(task));
          if (pending.size >= FILE_CONCURRENCY) {
            await Promise.race(pending);
          }
        },
        stop.signal,
      );
      await Promise.all(pending);
      if (failure) {
        throw failure.error;
      }
      if (!exit.aborted && exit.code !== 0 && exit.code !== 1) {
        const detail = exit.stderr.trim() || `ripgrep exited with code ${exit.code}`;
        const queryError = queryErrorMessage(detail);
        if (queryError && !sawFile) {
          throw new SearchError(queryError, detail);
        }
        warnings.push(detail);
      }
    }
  } catch (e) {
    if (e instanceof SearchError) {
      throw e;
    }
    const message = e instanceof Error ? e.message : String(e);
    if ((e as NodeJS.ErrnoException).syscall?.startsWith("spawn")) {
      throw new SearchError(`Could not run ripgrep: ${message}`, message, true);
    }
    throw new SearchError(`Search failed: ${message}`, e instanceof Error ? e.stack : message);
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }

  return {
    fileCount,
    lineCount,
    matchCount,
    excludedLineCount,
    limitHit,
    cancelled: signal?.aborted ?? false,
    durationMs: performance.now() - started,
    warnings,
  };
}

/** `\n`, `\x0a`, `\x{a}`, `\u000a`, `\u{a}`, `\U0000000a`, `\012`, `\o{12}`, `\cJ`, after the backslash. */
const NEWLINE_ESCAPE = /^(?:n|x0a|x\{0*a\}|u000a|u\{0*a\}|U0000000a|U\{0*a\}|012|o\{0*12\}|cj)/i;

/**
 * Results are per line, so a pattern that must match a newline would silently find nothing.
 * Escapes inside a character class are allowed: `[^\n]` is a useful per-line pattern.
 */
function hasNewlineEscape(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\n") {
      return true;
    }
    if (ch === "\\") {
      if (!inClass && NEWLINE_ESCAPE.test(pattern.slice(i + 1, i + 12))) {
        return true;
      }
      i++;
    } else if (inClass) {
      inClass = ch !== "]";
    } else if (ch === "[") {
      inClass = true;
      // A leading `]` (after an optional `^`) is a class member.
      if (pattern[i + 1] === "^") {
        i++;
      }
      if (pattern[i + 1] === "]") {
        i++;
      }
    }
  }
  return false;
}

function countMatches(lines: readonly ResultLine[]): number {
  let n = 0;
  for (const l of lines) {
    n += l.ranges.length;
  }
  return n;
}

function truncate(lines: readonly ResultLine[], room: number): ResultLine[] {
  const kept: ResultLine[] = [];
  for (const l of lines) {
    if (room <= 0) {
      break;
    }
    kept.push(l.ranges.length <= room ? l : { ...l, ranges: l.ranges.slice(0, room) });
    room -= l.ranges.length;
  }
  return kept;
}

type Submatch = RipgrepLine["submatches"][number];

/** ripgrep sends no submatch for an empty match at the end of a last line without a terminator. */
function matchesOf(line: RipgrepLine): readonly Submatch[] {
  if (line.submatches.length > 0) {
    return line.submatches;
  }
  const end = line.bytes.length - eolLength(line.bytes);
  return [{ start: end, end }];
}

async function processFile(folder: string, file: RipgrepFile): Promise<FileResult> {
  const relativePath = file.path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const absolutePath = path.join(folder, relativePath);
  const base = { folder, relativePath, absolutePath };
  if (!isCFamilyFile(relativePath)) {
    return { ...base, filtered: false, lines: file.lines.map((l) => toResultLine(l, matchesOf(l))), excluded: [] };
  }

  // A name that is not UTF-8 can only be opened through its bytes.
  const readPath = file.rawPath
    ? Buffer.concat([Buffer.from(folder + path.sep), file.rawPath.subarray(file.rawPath.indexOf("./") === 0 ? 2 : 0)])
    : absolutePath;
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(readPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return excludeAll(base, file, code ? `${UNREADABLE} (${code})` : UNREADABLE);
  }
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return excludeAll(base, file, UTF16);
  }
  // ripgrep strips a UTF-8 BOM and reports offsets without it.
  const shift = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;

  let limit = 0;
  for (const l of file.lines) {
    for (const m of matchesOf(l)) {
      limit = Math.max(limit, shift + l.absoluteOffset + Math.max(m.end, m.start + 1));
    }
  }
  const regions = scanRegions(buf, limit);

  const lines: ResultLine[] = [];
  const excluded: ExcludedLine[] = [];
  for (const l of file.lines) {
    const at = shift + l.absoluteOffset;
    if (at + l.bytes.length > buf.length || buf.compare(l.bytes, 0, l.bytes.length, at, at + l.bytes.length) !== 0) {
      excluded.push(toExcludedLine(l, CHANGED));
      continue;
    }
    const matches = matchesOf(l);
    const lineEnd = at + l.bytes.length - eolLength(l.bytes);
    const classes = matches.map((m) => {
      if (m.end > m.start) {
        return classifyRange(regions, at + m.start, at + m.end);
      }
      // An empty match at a line end belongs to what ends there, e.g. a line comment.
      const p = at + m.start >= lineEnd && m.start > 0 ? at + m.start - 1 : at + m.start;
      return classifyRange(regions, p, p + 1);
    });
    const decision = decideLine(classes);
    if (decision.include) {
      lines.push(toResultLine(l, matches.filter((_, i) => classes[i].kind === "code")));
    } else {
      excluded.push(toExcludedLine(l, decision.reason ?? REASON_COMMENT_ONLY));
    }
  }
  return { ...base, filtered: true, lines, excluded };
}

function excludeAll(base: Pick<FileResult, "folder" | "relativePath" | "absolutePath">, file: RipgrepFile, reason: string): FileResult {
  return { ...base, filtered: true, lines: [], excluded: file.lines.map((l) => toExcludedLine(l, reason)) };
}

function toResultLine(line: RipgrepLine, submatches: readonly Submatch[]): ResultLine {
  const text = lineText(line.bytes);
  const ascii = text.length === line.bytes.length - eolLength(line.bytes);
  const column = (byteOffset: number) =>
    Math.min(text.length, ascii ? byteOffset : line.bytes.toString("utf8", 0, byteOffset).length);
  return {
    lineNumber: line.lineNumber,
    text,
    ranges: submatches.map((m) => ({ start: column(m.start), end: column(m.end) })),
  };
}

function toExcludedLine(line: RipgrepLine, reason: string): ExcludedLine {
  return { lineNumber: line.lineNumber, text: lineText(line.bytes), reason };
}

function lineText(bytes: Buffer): string {
  return bytes.toString("utf8", 0, bytes.length - eolLength(bytes));
}

function eolLength(bytes: Buffer): number {
  const n = bytes.length;
  if (n > 0 && bytes[n - 1] === 0x0a) {
    return n > 1 && bytes[n - 2] === 0x0d ? 2 : 1;
  }
  return 0;
}
