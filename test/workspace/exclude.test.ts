import { describe, expect, it } from "vitest";
import { combineExcludeGlobs, DEFAULT_EXCLUDE } from "../../src/workspace/exclude";

describe("combineExcludeGlobs", () => {
  it("returns null for an empty (or blank-only) list", () => {
    expect(combineExcludeGlobs([])).toBeNull();
    expect(combineExcludeGlobs(["  ", ""])).toBeNull();
  });

  it("returns a single pattern unchanged", () => {
    expect(combineExcludeGlobs(["**/build/Debug/**"])).toBe("**/build/Debug/**");
  });

  it("joins multiple patterns with brace expansion", () => {
    expect(combineExcludeGlobs(["**/build/Debug/**", "**/build/Release/**"])).toBe(
      "{**/build/Debug/**,**/build/Release/**}"
    );
  });

  it("trims whitespace and drops blanks", () => {
    expect(combineExcludeGlobs(["  a/** ", "", " b/** "])).toBe("{a/**,b/**}");
  });

  it("ships defaults that exclude build/Debug and build/Release", () => {
    expect(DEFAULT_EXCLUDE).toContain("**/build/Debug/**");
    expect(DEFAULT_EXCLUDE).toContain("**/build/Release/**");
  });
});
