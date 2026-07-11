import * as path from "path";
import { describe, expect, it } from "vitest";
import { PbxModel } from "../../src/model/pbxProject";
import { PathResolver } from "../../src/model/pathResolver";
import { readFixture, sampleProjectRoot } from "../helpers";

describe("PathResolver", () => {
  const model = PbxModel.parse(readFixture("Sample.xcodeproj/project.pbxproj"));
  const resolver = new PathResolver(model, sampleProjectRoot);

  it("resolves a <group> file through the group hierarchy", () => {
    expect(resolver.resolve("1A0000000000000000000005")).toBe(
      path.resolve(sampleProjectRoot, "Sources/AppDelegate.swift")
    );
  });

  it("resolves a missing file's intended path (existence is a separate check)", () => {
    expect(resolver.resolve("1A0000000000000000000008")).toBe(
      path.resolve(sampleProjectRoot, "Sources/Missing.swift")
    );
  });

  it("returns null for build-variable source trees", () => {
    // Sample.app has sourceTree = BUILT_PRODUCTS_DIR
    expect(resolver.resolve("1A0000000000000000000009")).toBeNull();
  });

  it("reports filesystem vs non-filesystem nodes", () => {
    expect(resolver.isFilesystemNode(model.get("1A0000000000000000000005")!)).toBe(true);
    expect(resolver.isFilesystemNode(model.get("1A0000000000000000000009")!)).toBe(false);
  });
});
