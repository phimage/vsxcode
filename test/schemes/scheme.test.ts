import { describe, expect, it } from "vitest";
import { XcScheme } from "../../src/schemes/scheme";
import { readFixture } from "../helpers";

const FIXTURE = "Sample.xcodeproj/xcshareddata/xcschemes/Sample.xcscheme";

describe("XcScheme", () => {
  it("rejects non-scheme XML", () => {
    expect(() => XcScheme.parse("<Workspace></Workspace>")).toThrow(/Not a scheme/);
  });

  it("reads per-action build configurations", () => {
    const scheme = XcScheme.parse(readFixture(FIXTURE));
    expect(scheme.lastUpgradeVersion).toBe("1500");
    expect(scheme.actionConfigurations()).toEqual([
      { action: "TestAction", buildConfiguration: "Debug" },
      { action: "LaunchAction", buildConfiguration: "Debug" },
      { action: "ProfileAction", buildConfiguration: "Release" },
      { action: "AnalyzeAction", buildConfiguration: "Debug" },
      { action: "ArchiveAction", buildConfiguration: "Release" }
    ]);
  });

  it("lists buildable references, deduplicated", () => {
    const refs = XcScheme.parse(readFixture(FIXTURE)).buildableReferences();
    expect(refs).toHaveLength(1); // same target referenced by Build and Launch
    expect(refs[0]).toEqual({
      blueprintName: "Sample",
      buildableName: "Sample.app",
      blueprintIdentifier: "1A000000000000000000000E",
      referencedContainer: "container:Sample.xcodeproj"
    });
  });

  it("edits an action's configuration and round-trips the rest", () => {
    const text = readFixture(FIXTURE);
    const scheme = XcScheme.parse(text);
    expect(scheme.setActionConfiguration("LaunchAction", "Debug")).toBe(false); // unchanged
    expect(scheme.setActionConfiguration("BuildAction", "Debug")).toBe(false); // no config attr
    expect(scheme.setActionConfiguration("LaunchAction", "Release")).toBe(true);
    const out = scheme.serialize();
    expect(out).not.toBe(text);
    expect(XcScheme.parse(out).actionConfigurations()).toContainEqual({
      action: "LaunchAction",
      buildConfiguration: "Release"
    });
    // Only that one attribute changed: reverting the first "Release" (the
    // LaunchAction one, document order) restores the original text.
    expect(out.replace('buildConfiguration = "Release"', 'buildConfiguration = "Debug"')).toBe(text);
  });
});
