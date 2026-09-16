import * as path from "node:path";

// Case-sensitive: `.S` is preprocessed assembly, `.s` is not. See plan PD2.
const C_FAMILY_EXTENSIONS = new Set([
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hh",
  ".hpp",
  ".hxx",
  ".inl",
  ".S",
  ".dts",
  ".dtsi",
  ".dtso",
]);

/** True if comments in `fileName` follow C syntax and the file is filtered by the C lexer. */
export function isCFamilyFile(fileName: string): boolean {
  return C_FAMILY_EXTENSIONS.has(path.extname(fileName));
}
