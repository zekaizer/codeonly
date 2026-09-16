import * as assert from "node:assert/strict";
import { classifyRange, scanRegions, type Classification, type MatchKind } from "../classify/cLexer";
import { isCFamilyFile } from "../classify/cFamily";
import { REASON_COMMENT_ONLY, decideLine } from "../classify/lineDecision";

function classifyAll(src: string, term: string): Classification[] {
  const buf = Buffer.from(src, "utf8");
  const needle = Buffer.from(term, "utf8");
  const offsets: number[] = [];
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) {
    offsets.push(i);
  }
  const last = offsets.length > 0 ? offsets[offsets.length - 1] + needle.length : 0;
  const regions = scanRegions(buf, last);
  return offsets.map((i) => classifyRange(regions, i, i + needle.length));
}

function kindsOf(src: string, term: string): MatchKind[] {
  return classifyAll(src, term).map((c) => c.kind);
}

suite("C lexer", () => {
  test("plain code is code", () => {
    assert.deepEqual(kindsOf("int foo = bar(foo);\n", "foo"), ["code", "code"]);
  });

  test("line comment", () => {
    assert.deepEqual(kindsOf("x = 1; // foo\nfoo();\n", "foo"), ["comment", "code"]);
  });

  test("block comment, single and multi-line", () => {
    assert.deepEqual(kindsOf("/* foo */ foo;\n/*\n * foo\n */\nfoo\n", "foo"), [
      "comment",
      "code",
      "comment",
      "code",
    ]);
  });

  test("mixed line keeps both kinds (R2)", () => {
    assert.deepEqual(kindsOf("foo(); /* foo */\n", "foo"), ["code", "comment"]);
  });

  test("comment openers inside comments do not nest", () => {
    assert.deepEqual(kindsOf("/* // */ foo\n// /* \nfoo\n", "foo"), ["code", "code"]);
  });

  test("division and stray */ are code", () => {
    assert.deepEqual(kindsOf("a = b / c; foo */ foo\n", "foo"), ["code", "code"]);
  });

  test("string literals are code and hide comment openers", () => {
    assert.deepEqual(kindsOf('s = "/* foo"; foo; "//" foo\n', "foo"), ["code", "code", "code"]);
  });

  test("escaped quote does not end a string", () => {
    assert.deepEqual(kindsOf('s = "a\\"/* foo"; foo\n', "foo"), ["code", "code"]);
  });

  test("char literal quote does not start a string", () => {
    assert.deepEqual(kindsOf("c = '\"'; foo /* foo */\n", "foo"), ["code", "comment"]);
    assert.deepEqual(kindsOf("c = L'x'; foo\n", "foo"), ["code"]);
  });

  test("line splice in a string continues the string", () => {
    assert.deepEqual(kindsOf('s = "abc\\\n/* foo"; foo\n', "foo"), ["code", "code"]);
  });

  test("line splice continues a line comment", () => {
    assert.deepEqual(kindsOf("// a \\\nfoo\nfoo\n", "foo"), ["comment", "code"]);
    assert.deepEqual(kindsOf("// a \\\r\nfoo\r\nfoo\r\n", "foo"), ["comment", "code"]);
    assert.deepEqual(kindsOf("// a \\  \nfoo\nfoo\n", "foo"), ["comment", "code"]);
  });

  test("code in #if 0 is code (R3)", () => {
    assert.deepEqual(kindsOf("#if 0\nfoo();\n#endif\n#ifdef BAR\nfoo();\n#endif\n", "foo"), ["code", "code"]);
  });

  test("unterminated block comment is uncertain to EOF (R4)", () => {
    const got = classifyAll("foo();\n/* start\nfoo();\nfoo\n", "foo");
    assert.deepEqual(
      got.map((c) => c.kind),
      ["code", "uncertain", "uncertain"],
    );
    assert.equal(got[1].reason, "unterminated block comment");
  });

  test("unterminated literal is uncertain to end of line only", () => {
    const got = classifyAll('s = "abc foo\nfoo();\n', "foo");
    assert.deepEqual(
      got.map((c) => c.kind),
      ["uncertain", "code"],
    );
    assert.equal(got[0].reason, "unterminated string literal");
  });

  test("apostrophe in #if 0 prose does not open a comment", () => {
    const src = "#if 0\ndon't call foo /* here\nfoo();\n#endif\n";
    const got = classifyAll(src, "foo");
    assert.deepEqual(
      got.map((c) => c.kind),
      ["uncertain", "code"],
    );
    assert.equal(got[0].reason, "unterminated character literal");
  });

  test("digit separators do not open a char literal", () => {
    assert.deepEqual(kindsOf("x = 1'000'000; foo /* foo */\n", "foo"), ["code", "comment"]);
    assert.deepEqual(kindsOf("the 80's foo /* foo */\n", "foo"), ["code", "comment"]);
    assert.deepEqual(kindsOf("x = 0x1p-3; foo /* foo */\n", "foo"), ["code", "comment"]);
  });

  test("raw string literals hide quotes and comment openers", () => {
    assert.deepEqual(kindsOf('s = R"x(/* foo )" " )x"; foo // foo\n', "foo"), ["code", "code", "comment"]);
    assert.deepEqual(kindsOf('s = u8R"(foo)"; foo // foo\n', "foo"), ["code", "code", "comment"]);
  });

  test("identifier ending in R is not a raw string prefix", () => {
    assert.deepEqual(kindsOf('BAR"(" /* foo */ foo\n', "foo"), ["comment", "code"]);
  });

  test("unterminated raw string is uncertain to EOF", () => {
    const got = classifyAll('s = R"(foo\nfoo\n', "foo");
    assert.deepEqual(
      got.map((c) => c.kind),
      ["uncertain", "uncertain"],
    );
    assert.equal(got[0].reason, "unterminated raw string literal");
  });

  test("multi-byte text inside comments", () => {
    assert.deepEqual(kindsOf("/* 한글 foo */ foo // é foo\n", "foo"), ["comment", "code", "comment"]);
  });

  test("scan limit still completes a region that starts before it", () => {
    const buf = Buffer.from("x; /* a\nfoo */ foo\n");
    const regions = scanRegions(buf, 4);
    assert.equal(regions.length, 1);
    assert.equal(regions[0].kind, "comment");
    assert.equal(buf.toString("latin1", regions[0].end - 2, regions[0].end), "*/");
  });

  test("a range touching code bytes is code", () => {
    const buf = Buffer.from("foo/* x */");
    const regions = scanRegions(buf);
    assert.equal(classifyRange(regions, 2, 5).kind, "code");
    assert.equal(classifyRange(regions, 3, 10).kind, "comment");
  });

  test("an empty range takes the kind at its position", () => {
    const buf = Buffer.from("a /* x */");
    const regions = scanRegions(buf);
    assert.equal(classifyRange(regions, 0, 0).kind, "code");
    assert.equal(classifyRange(regions, 4, 4).kind, "comment");
  });
});

suite("line decision", () => {
  const code: Classification = { kind: "code" };
  const comment: Classification = { kind: "comment" };
  const uncertain: Classification = { kind: "uncertain", reason: "unterminated block comment" };

  test("any code match keeps the line (R2)", () => {
    assert.deepEqual(decideLine([comment, code]), { include: true });
    assert.deepEqual(decideLine([uncertain, code]), { include: true });
  });

  test("comment-only line is excluded (R1')", () => {
    assert.deepEqual(decideLine([comment, comment]), { include: false, reason: REASON_COMMENT_ONLY });
  });

  test("uncertain without code is excluded (R4)", () => {
    assert.deepEqual(decideLine([comment, uncertain]), {
      include: false,
      reason: "unclassifiable: unterminated block comment",
    });
  });
});

suite("C-family files", () => {
  test("C, C++, preprocessed assembly, and devicetree are C-family", () => {
    for (const name of ["a.c", "a.h", "a.cc", "a.cpp", "a.cxx", "a.hh", "a.hpp", "a.hxx", "a.inl", "a.S", "a.dts", "a.dtsi", "a.dtso"]) {
      assert.equal(isCFamilyFile(`dir/${name}`), true, name);
    }
  });

  test("other files are not", () => {
    for (const name of ["a.s", "Makefile", "Kconfig", "a.py", "a.rs", "a.md", "c", "a.c.orig", ".c"]) {
      assert.equal(isCFamilyFile(`dir/${name}`), false, name);
    }
  });
});
