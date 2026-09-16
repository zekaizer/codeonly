export interface GlobMatcher {
  /** `relativePath` uses `/` separators and is relative to the searched folder. */
  (relativePath: string): boolean;
}

const PATH = "[/\\\\]";
const NO_PATH = "[^/\\\\]";
const GLOBSTAR = "**";

/**
 * Compiles globs with the semantics of VS Code's `glob.ts` (which the built-in Search view uses to
 * filter results) into a matcher that is true if any glob matches. Undefined for no globs.
 * A glob that does not compile (e.g. `[b-a]`) is dropped, as VS Code does; ripgrep reports it.
 */
export function compileGlobs(globs: readonly string[], ignoreCase: boolean): GlobMatcher | undefined {
  if (globs.length === 0) {
    return undefined;
  }
  const res: RegExp[] = [];
  for (const glob of globs) {
    try {
      res.push(new RegExp(`^(?:${toRegExp(glob)})$`, ignoreCase ? "i" : ""));
    } catch {
      // Dropped; see above.
    }
  }
  return (relativePath) => res.some((re) => re.test(relativePath));
}

function stars(count: 1 | 2, isLast = false): string {
  if (count === 1) {
    return `${NO_PATH}*?`;
  }
  // Separator, or a segment and a separator, any number of times; at the end also a trailing segment.
  return `(?:${PATH}|${NO_PATH}+${PATH}${isLast ? `|${PATH}${NO_PATH}+` : ""})*?`;
}

function toRegExp(glob: string): string {
  if (!glob) {
    return "";
  }
  const segments = splitOutside(glob, "/");
  if (segments.every((s) => s === GLOBSTAR)) {
    return ".*";
  }
  let out = "";
  let previousWasGlobstar = false;
  segments.forEach((segment, index) => {
    if (segment === GLOBSTAR) {
      if (!previousWasGlobstar) {
        out += stars(2, index === segments.length - 1);
      }
      previousWasGlobstar = true;
      return;
    }
    let inBraces = false;
    let braces = "";
    let inClass = false;
    let classBody = "";
    for (const ch of segment) {
      if (inBraces && ch !== "}") {
        braces += ch;
        continue;
      }
      // `]` first in a class is a member.
      if (inClass && (ch !== "]" || !classBody)) {
        if (ch === "-") {
          classBody += ch;
        } else if ((ch === "^" || ch === "!") && !classBody) {
          classBody += "^";
        } else if (ch !== "/") {
          classBody += escapeRegExp(ch);
        }
        continue;
      }
      switch (ch) {
        case "{":
          inBraces = true;
          break;
        case "[":
          inClass = true;
          break;
        case "}":
          out += `(?:${splitOutside(braces, ",").map(toRegExp).join("|")})`;
          inBraces = false;
          braces = "";
          break;
        case "]":
          out += `[${classBody}]`;
          inClass = false;
          classBody = "";
          break;
        case "?":
          out += NO_PATH;
          break;
        case "*":
          out += stars(1);
          break;
        default:
          out += escapeRegExp(ch);
      }
    }
    // The separator belongs to this segment unless only a trailing globstar follows.
    if (index < segments.length - 1 && (segments[index + 1] !== GLOBSTAR || index + 2 < segments.length)) {
      out += PATH;
    }
    previousWasGlobstar = false;
  });
  return out;
}

/** Splits on `separator` outside `{}` and `[]`, as VS Code's `splitGlobAware` does. */
function splitOutside(text: string, separator: string): string[] {
  const out: string[] = [];
  let inBraces = false;
  let inClass = false;
  let current = "";
  for (const ch of text) {
    if (ch === separator && !inBraces && !inClass) {
      out.push(current);
      current = "";
      continue;
    }
    if (ch === "{") {
      inBraces = true;
    } else if (ch === "}") {
      inBraces = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "]") {
      inClass = false;
    }
    current += ch;
  }
  if (current) {
    out.push(current);
  }
  return out;
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}
