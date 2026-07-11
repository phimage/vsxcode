import * as path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectEditor } from "../../src/edit/projectEditor";
import { lint } from "../../src/linter/linter";
import { PbxModel } from "../../src/model/pbxProject";
import { PathResolver } from "../../src/model/pathResolver";
import { parse } from "../../src/parser/parser";
import { serialize } from "../../src/serializer/serializer";
import { readFixture, sampleProjectRoot } from "../helpers";

const UUID = {
  project: "1A0000000000000000000001",
  mainGroup: "1A0000000000000000000002",
  sources: "1A0000000000000000000003",
  appDelegateRef: "1A0000000000000000000005",
  mainViewRef: "1A0000000000000000000006",
  assetsRef: "1A0000000000000000000007",
  missingRef: "1A0000000000000000000008",
  target: "1A000000000000000000000E",
  sourcesPhase: "1A000000000000000000000F",
  projectDebugConfig: "1A0000000000000000000014"
};

const SOURCE = readFixture("Sample.xcodeproj/project.pbxproj");

function reparse(editor: ProjectEditor): PbxModel {
  return PbxModel.parse(editor.serialize());
}

function structuralErrors(model: PbxModel): string[] {
  return lint({ model })
    .filter((d) => d.code === "broken-reference" || d.code === "duplicate-uuid" || d.code === "circular-group")
    .map((d) => `${d.code}: ${d.message}`);
}

describe("ProjectEditor reference styles", () => {
  let editor: ProjectEditor;

  beforeEach(() => {
    editor = ProjectEditor.fromText(SOURCE, sampleProjectRoot);
  });

  it("infers <group> from siblings in the Sources group", () => {
    expect(editor.inferGroupSourceTree(UUID.sources)).toBe("<group>");
  });

  it("mimics a SOURCE_ROOT-majority sibling configuration for automatic adds", () => {
    editor.setSourceTree(UUID.appDelegateRef, "SOURCE_ROOT");
    editor.setSourceTree(UUID.mainViewRef, "SOURCE_ROOT");
    editor.setSourceTree(UUID.assetsRef, "SOURCE_ROOT");
    expect(editor.inferGroupSourceTree(UUID.sources)).toBe("SOURCE_ROOT");

    const added = editor.addFileReference(
      UUID.sources,
      path.join(sampleProjectRoot, "Sources/Extra.swift")
    );
    const model = reparse(editor);
    expect(model.get(added.uuid)?.getString("sourceTree")).toBe("SOURCE_ROOT");
    expect(model.get(added.uuid)?.getString("path")).toBe("Sources/Extra.swift");
    expect(structuralErrors(model)).toEqual([]);
  });

  it("adds SOURCE_ROOT-relative references on request (with a display name)", () => {
    const added = editor.addFileReference(
      UUID.sources,
      path.join(sampleProjectRoot, "Sources/Extra.swift"),
      "sourceRoot"
    );
    const model = reparse(editor);
    const ref = model.get(added.uuid);
    expect(ref?.getString("sourceTree")).toBe("SOURCE_ROOT");
    expect(ref?.getString("path")).toBe("Sources/Extra.swift");
    expect(ref?.getString("name")).toBe("Extra.swift");
    const resolver = new PathResolver(model, sampleProjectRoot);
    expect(resolver.resolve(added.uuid)).toBe(path.resolve(sampleProjectRoot, "Sources/Extra.swift"));
  });

  it("adds absolute references on request", () => {
    const abs = path.join(sampleProjectRoot, "Sources/Extra.swift");
    const added = editor.addFileReference(UUID.sources, abs, "absolute");
    const model = reparse(editor);
    expect(model.get(added.uuid)?.getString("sourceTree")).toBe("<absolute>");
    expect(new PathResolver(model, sampleProjectRoot).resolve(added.uuid)).toBe(abs);
  });
});

describe("ProjectEditor location edits", () => {
  let editor: ProjectEditor;

  beforeEach(() => {
    editor = ProjectEditor.fromText(SOURCE, sampleProjectRoot);
  });

  it("keeps the resolved path stable when switching sourceTree", () => {
    const before = editor.resolvePath(UUID.mainViewRef);
    expect(editor.setSourceTree(UUID.mainViewRef, "SOURCE_ROOT")).toBe(true);

    const model = reparse(editor);
    expect(model.get(UUID.mainViewRef)?.getString("sourceTree")).toBe("SOURCE_ROOT");
    expect(model.get(UUID.mainViewRef)?.getString("path")).toBe("Sources/MainView.swift");
    expect(new PathResolver(model, sampleProjectRoot).resolve(UUID.mainViewRef)).toBe(before);
    expect(structuralErrors(model)).toEqual([]);
  });

  it("round-trips back to <group>", () => {
    editor.setSourceTree(UUID.mainViewRef, "SOURCE_ROOT");
    editor.setSourceTree(UUID.mainViewRef, "<group>");
    const model = reparse(editor);
    expect(model.get(UUID.mainViewRef)?.getString("path")).toBe("MainView.swift");
  });

  it("edits the raw path", () => {
    expect(editor.setPath(UUID.mainViewRef, "Views/MainView.swift")).toBe(true);
    expect(reparse(editor).get(UUID.mainViewRef)?.getString("path")).toBe("Views/MainView.swift");
  });
});

describe("ProjectEditor target membership", () => {
  let editor: ProjectEditor;

  beforeEach(() => {
    editor = ProjectEditor.fromText(SOURCE, sampleProjectRoot);
  });

  it("reports membership per target", () => {
    const memberships = editor.membershipsFor(UUID.mainViewRef);
    expect(memberships).toEqual([{ targetUuid: UUID.target, targetName: "Sample", member: true }]);
  });

  it("removes and re-adds membership", () => {
    editor.setTargetMembership(UUID.mainViewRef, UUID.target, false);
    let model = reparse(editor);
    expect(
      model.allOfIsa("PBXBuildFile").filter((bf) => bf.getString("fileRef") === UUID.mainViewRef)
    ).toHaveLength(0);
    expect(structuralErrors(model)).toEqual([]);

    editor.setTargetMembership(UUID.mainViewRef, UUID.target, true);
    model = reparse(editor);
    const buildFiles = model
      .allOfIsa("PBXBuildFile")
      .filter((bf) => bf.getString("fileRef") === UUID.mainViewRef);
    expect(buildFiles).toHaveLength(1);
    expect(model.get(UUID.sourcesPhase)?.getStringArray("files").map((n) => n.value)).toContain(
      buildFiles[0].uuid
    );
    expect(structuralErrors(model)).toEqual([]);
  });
});

describe("ProjectEditor project properties", () => {
  let editor: ProjectEditor;

  beforeEach(() => {
    editor = ProjectEditor.fromText(SOURCE, sampleProjectRoot);
  });

  it("sets top-level project strings", () => {
    expect(editor.setProjectString("developmentRegion", "fr")).toBe(true);
    expect(reparse(editor).project()?.getString("developmentRegion")).toBe("fr");
  });

  it("sets and removes project attributes", () => {
    expect(editor.setProjectAttribute("ORGANIZATIONNAME", "ACME Inc.")).toBe(true);
    expect(editor.projectAttribute("ORGANIZATIONNAME")).toBe("ACME Inc.");
    expect(editor.projectAttribute("LastUpgradeCheck")).toBe("1500");

    editor.setProjectAttribute("ORGANIZATIONNAME", "");
    expect(editor.projectAttribute("ORGANIZATIONNAME")).toBeUndefined();

    const out = editor.serialize();
    expect(serialize(parse(out))).toBe(out);
  });

  it("rewrites known regions", () => {
    expect(editor.knownRegions()).toEqual(["en", "Base"]);
    editor.setKnownRegions(["en", "fr", "Base"]);
    const model = reparse(editor);
    expect(model.project()?.getStringArray("knownRegions").map((n) => n.value)).toEqual([
      "en",
      "fr",
      "Base"
    ]);
  });

  it("lists build configurations with their settings", () => {
    const project = editor.projectObject()!;
    const configs = editor.buildConfigurationsOf(project);
    expect(configs.map((c) => c.name)).toEqual(["Debug", "Release"]);
    expect(configs[0].settings).toEqual([{ key: "SWIFT_VERSION", value: "5.0" }]);
  });

  it("sets, replaces with arrays, and removes build settings", () => {
    editor.setBuildSetting(UUID.projectDebugConfig, "ENABLE_TESTABILITY", "YES");
    editor.setBuildSetting(UUID.projectDebugConfig, "OTHER_LDFLAGS", ["-ObjC", "-lz"]);

    const settingsNow = () => {
      const fresh = ProjectEditor.fromText(editor.serialize(), sampleProjectRoot);
      return fresh
        .buildConfigurationsOf(fresh.projectObject()!)
        .find((c) => c.uuid === UUID.projectDebugConfig)!.settings;
    };
    expect(settingsNow()).toEqual([
      { key: "ENABLE_TESTABILITY", value: "YES" },
      { key: "OTHER_LDFLAGS", value: ["-ObjC", "-lz"] },
      { key: "SWIFT_VERSION", value: "5.0" }
    ]);

    editor.setBuildSetting(UUID.projectDebugConfig, "SWIFT_VERSION", null);
    expect(settingsNow().map((s) => s.key)).toEqual(["ENABLE_TESTABILITY", "OTHER_LDFLAGS"]);
    const model = reparse(editor);

    const out = editor.serialize();
    expect(serialize(parse(out))).toBe(out);
    expect(structuralErrors(model)).toEqual([]);
  });
});
