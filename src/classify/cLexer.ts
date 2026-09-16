export type RegionKind = "comment" | "uncertain";

/** A non-code byte range `[start, end)`. Everything outside regions is code; string literals are code (spec OOS2). */
export interface Region {
  readonly start: number;
  readonly end: number;
  readonly kind: RegionKind;
  readonly reason?: string;
}

export type MatchKind = "code" | "comment" | "uncertain";

export interface Classification {
  readonly kind: MatchKind;
  readonly reason?: string;
}

const TAB = 0x09;
const NL = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const LPAREN = 0x28;
const RPAREN = 0x29;
const STAR = 0x2a;
const PLUS = 0x2b;
const MINUS = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const BACKSLASH = 0x5c;

const OTHER = 0;
const IDENT_START = 1;
const DIGIT = 2;

const CHAR_CLASS = (() => {
  const t = new Uint8Array(256);
  for (let c = 0; c < 256; c++) {
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x24 || c >= 0x80) {
      t[c] = IDENT_START;
    } else if (c >= 0x30 && c <= 0x39) {
      t[c] = DIGIT;
    }
  }
  return t;
})();

const RAW_DELIMITER_MAX = 16;

const CODE: Classification = { kind: "code" };
const COMMENT: Classification = { kind: "comment" };

/**
 * Lexes C-family source bytes and returns its comment and unclassifiable regions, sorted and non-overlapping.
 *
 * Preprocessor conditionals are not evaluated, so `#if 0` bodies are lexed as code (spec R3).
 * Lexing stops at the first token boundary at or after `limit`; a region that starts before
 * `limit` is still returned whole.
 */
export function scanRegions(src: Uint8Array, limit: number = src.length): Region[] {
  const regions: Region[] = [];
  const n = src.length;
  const stop = Math.min(limit, n);
  let i = 0;
  while (i < stop) {
    const c = src[i];
    if (c === SLASH && i + 1 < n) {
      const next = src[i + 1];
      if (next === STAR) {
        const close = findBlockCommentClose(src, i + 2);
        if (close < 0) {
          regions.push({ start: i, end: n, kind: "uncertain", reason: "unterminated block comment" });
          return regions;
        }
        regions.push({ start: i, end: close + 2, kind: "comment" });
        i = close + 2;
        continue;
      }
      if (next === SLASH) {
        const end = lineCommentEnd(src, i + 2);
        regions.push({ start: i, end, kind: "comment" });
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (c === DQUOTE || c === SQUOTE) {
      i = scanQuoted(src, i, regions);
      continue;
    }
    const cls = CHAR_CLASS[c];
    if (cls === IDENT_START) {
      let j = i + 1;
      while (j < n && CHAR_CLASS[src[j]] !== OTHER) {
        j++;
      }
      i = j < n && src[j] === DQUOTE && isRawPrefix(src, i, j) ? scanRawString(src, i, j, regions) : j;
      continue;
    }
    if (cls === DIGIT || (c === DOT && i + 1 < n && CHAR_CLASS[src[i + 1]] === DIGIT)) {
      i = scanPpNumber(src, i);
      continue;
    }
    i++;
  }
  return regions;
}

/**
 * Classifies the byte range `[start, end)` against `regions` from {@link scanRegions}.
 *
 * A range with any code byte is code. An empty range is classified by the byte at `start`.
 */
export function classifyRange(regions: readonly Region[], start: number, end: number): Classification {
  const stop = end > start ? end : start + 1;
  let lo = 0;
  let hi = regions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (regions[mid].end <= start) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  let pos = start;
  let uncertain: Region | undefined;
  for (let k = lo; pos < stop; k++) {
    const r = regions[k];
    if (r === undefined || r.start > pos) {
      return CODE;
    }
    if (r.kind === "uncertain" && uncertain === undefined) {
      uncertain = r;
    }
    pos = r.end;
  }
  return uncertain ? { kind: "uncertain", reason: uncertain.reason } : COMMENT;
}

function findBlockCommentClose(src: Uint8Array, from: number): number {
  let k = src.indexOf(STAR, from);
  while (k >= 0 && k + 1 < src.length) {
    if (src[k + 1] === SLASH) {
      return k;
    }
    k = src.indexOf(STAR, k + 1);
  }
  return -1;
}

/** Returns the offset of the newline ending a line comment, honouring line splices. */
function lineCommentEnd(src: Uint8Array, from: number): number {
  let k = from;
  for (;;) {
    const nl = src.indexOf(NL, k);
    if (nl < 0) {
      return src.length;
    }
    if (!endsWithSplice(src, from, nl)) {
      return nl;
    }
    k = nl + 1;
  }
}

/** Backslash, then optional blanks (GCC extension) and CR, directly before the newline at `nl`. */
function endsWithSplice(src: Uint8Array, lo: number, nl: number): boolean {
  let k = nl - 1;
  if (k >= lo && src[k] === CR) {
    k--;
  }
  while (k >= lo && (src[k] === SPACE || src[k] === TAB)) {
    k--;
  }
  return k >= lo && src[k] === BACKSLASH;
}

/** Returns the offset after the newline if the backslash at `k` starts a line splice, else -1. */
function spliceEnd(src: Uint8Array, k: number): number {
  const n = src.length;
  let j = k + 1;
  while (j < n && (src[j] === SPACE || src[j] === TAB)) {
    j++;
  }
  if (j < n && src[j] === CR) {
    j++;
  }
  return j < n && src[j] === NL ? j + 1 : -1;
}

/** An unescaped newline ends an unterminated literal, as GCC does in skipped groups. */
function scanQuoted(src: Uint8Array, start: number, regions: Region[]): number {
  const n = src.length;
  const quote = src[start];
  let j = start + 1;
  while (j < n) {
    const c = src[j];
    if (c === quote) {
      return j + 1;
    }
    if (c === BACKSLASH) {
      const spliced = spliceEnd(src, j);
      j = spliced >= 0 ? spliced : j + 2;
      continue;
    }
    if (c === NL) {
      break;
    }
    j++;
  }
  const end = Math.min(j, n);
  const what = quote === DQUOTE ? "string" : "character";
  regions.push({ start, end, kind: "uncertain", reason: `unterminated ${what} literal` });
  return end;
}

/** `R`, `LR`, `uR`, `UR`, `u8R`. */
function isRawPrefix(src: Uint8Array, start: number, end: number): boolean {
  if (src[end - 1] !== 0x52) {
    return false;
  }
  switch (end - start) {
    case 1:
      return true;
    case 2:
      return src[start] === 0x4c || src[start] === 0x75 || src[start] === 0x55;
    case 3:
      return src[start] === 0x75 && src[start + 1] === 0x38;
    default:
      return false;
  }
}

/** An invalid delimiter makes the literal an ordinary string, matching GCC's recovery. */
function scanRawString(src: Uint8Array, start: number, quote: number, regions: Region[]): number {
  const n = src.length;
  let k = quote + 1;
  while (k < n && k - quote - 1 < RAW_DELIMITER_MAX && isDelimiterChar(src[k])) {
    k++;
  }
  if (k >= n || src[k] !== LPAREN) {
    return scanQuoted(src, quote, regions);
  }
  const delimiter = src.subarray(quote + 1, k);
  for (let p = src.indexOf(RPAREN, k + 1); p >= 0; p = src.indexOf(RPAREN, p + 1)) {
    const q = p + 1 + delimiter.length;
    if (q < n && src[q] === DQUOTE && bytesEqualAt(src, p + 1, delimiter)) {
      return q + 1;
    }
  }
  regions.push({ start, end: n, kind: "uncertain", reason: "unterminated raw string literal" });
  return n;
}

function isDelimiterChar(c: number): boolean {
  return c > SPACE && c < 0x7f && c !== LPAREN && c !== RPAREN && c !== BACKSLASH;
}

function bytesEqualAt(src: Uint8Array, at: number, bytes: Uint8Array): boolean {
  for (let k = 0; k < bytes.length; k++) {
    if (src[at + k] !== bytes[k]) {
      return false;
    }
  }
  return true;
}

/** pp-number, including C23 digit separators so that `1'000` or `80's` does not open a character literal. */
function scanPpNumber(src: Uint8Array, start: number): number {
  const n = src.length;
  let j = start + 1;
  while (j < n) {
    const c = src[j];
    if ((c === 0x65 || c === 0x45 || c === 0x70 || c === 0x50) && j + 1 < n && (src[j + 1] === PLUS || src[j + 1] === MINUS)) {
      j += 2;
    } else if (CHAR_CLASS[c] !== OTHER || c === DOT) {
      j++;
    } else if (c === SQUOTE && j + 1 < n && CHAR_CLASS[src[j + 1]] !== OTHER) {
      j += 2;
    } else {
      break;
    }
  }
  return j;
}
