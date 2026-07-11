import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser";
import { serialize } from "../../src/serializer/serializer";
import { readFixture } from "../helpers";

function roundtrip(src: string): string {
  return serialize(parse(src));
}

describe("round-trip fidelity", () => {
  it("reproduces the Sample project byte-for-byte", () => {
    const src = readFixture("Sample.xcodeproj/project.pbxproj");
    expect(roundtrip(src)).toBe(src);
  });

  it("reproduces the broken fixture byte-for-byte", () => {
    const src = readFixture("broken.pbxproj");
    expect(roundtrip(src)).toBe(src);
  });

  it("preserves comments, trailing whitespace and unusual spacing", () => {
    const src =
      "// header\n{\n\tobjects = {\n\t\tAAA /* a */ = { isa = X;   value = \"a b\"; };\n\t};\n}\n\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("preserves arrays with and without trailing commas", () => {
    const src = "{ list = ( a, b, c ); trailing = ( a, b, ); }";
    expect(roundtrip(src)).toBe(src);
  });

  it("preserves quoted-string escapes", () => {
    const src = '{ a = "line1\\nline2"; b = "quote\\"inside"; c = ""; }';
    expect(roundtrip(src)).toBe(src);
  });
});
