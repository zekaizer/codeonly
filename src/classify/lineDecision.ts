import type { Classification } from "./cLexer";

export const REASON_COMMENT_ONLY = "comment-only match";

export interface LineDecision {
  readonly include: boolean;
  readonly reason?: string;
}

const INCLUDE: LineDecision = { include: true };

/**
 * Decides whether a result line is shown, given the classification of each match on it.
 *
 * Any code match keeps the line (spec R2). Otherwise the line is excluded, with an
 * unclassifiable match taking precedence in the reason (spec R4, D1).
 */
export function decideLine(matches: readonly Classification[]): LineDecision {
  let unclassifiable: string | undefined;
  for (const m of matches) {
    if (m.kind === "code") {
      return INCLUDE;
    }
    if (m.kind === "uncertain" && unclassifiable === undefined) {
      unclassifiable = `unclassifiable: ${m.reason ?? "unknown"}`;
    }
  }
  return { include: false, reason: unclassifiable ?? REASON_COMMENT_ONLY };
}
