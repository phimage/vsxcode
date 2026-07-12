import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { ProjectEditor } from "../../src/edit/projectEditor";
import { PbxModel } from "../../src/model/pbxProject";
import { packageReferences, packageRequirement, targetInfo } from "../../src/model/queries";
import { fixturesDir, samplePbxprojPath } from "../helpers";

const packagesPbxprojPath = path.join(fixturesDir, "Packages.xcodeproj", "project.pbxproj");

const SAMPLE_TARGET = "1A000000000000000000000E";
const YAMS_PKG = "2B0000000000000000000006";
const LOCAL_PKG = "2B0000000000000000000007";

describe("ProjectEditor.setTargetName", () => {
  it("renames the target and a matching productName", () => {
    const editor = ProjectEditor.load(samplePbxprojPath);
    expect(editor.setTargetName(SAMPLE_TARGET, "Renamed")).toBe(true);
    const model = PbxModel.parse(editor.serialize());
    expect(targetInfo(model, SAMPLE_TARGET)).toMatchObject({ name: "Renamed", productName: "Renamed" });
  });

  it("rejects no-ops, empty names and non-targets", () => {
    const editor = ProjectEditor.load(samplePbxprojPath);
    expect(editor.setTargetName(SAMPLE_TARGET, "Sample")).toBe(false);
    expect(editor.setTargetName(SAMPLE_TARGET, "  ")).toBe(false);
    expect(editor.setTargetName("1A0000000000000000000005", "X")).toBe(false);
  });
});

describe("ProjectEditor package edits", () => {
  it("changes the requirement kind and value keys", () => {
    const editor = ProjectEditor.load(packagesPbxprojPath);
    expect(editor.setPackageRequirement(YAMS_PKG, "exactVersion", "5.1.2")).toBe(true);
    const model = PbxModel.parse(editor.serialize());
    expect(packageRequirement(model, YAMS_PKG)).toEqual({ kind: "exactVersion", value: "5.1.2" });
  });

  it("writes both bounds of a version range", () => {
    const editor = ProjectEditor.load(packagesPbxprojPath);
    editor.setPackageRequirement(YAMS_PKG, "versionRange", "1.0.0", "2.0.0");
    const model = PbxModel.parse(editor.serialize());
    expect(packageRequirement(model, YAMS_PKG)).toEqual({
      kind: "versionRange",
      value: "1.0.0",
      value2: "2.0.0"
    });
  });

  it("switches to a branch requirement and back, dropping stale keys", () => {
    const editor = ProjectEditor.load(packagesPbxprojPath);
    editor.setPackageRequirement(YAMS_PKG, "branch", "main");
    editor.setPackageRequirement(YAMS_PKG, "upToNextMajorVersion", "6.0.0");
    const text = editor.serialize();
    expect(text).not.toContain("branch = main");
    expect(packageRequirement(PbxModel.parse(text), YAMS_PKG)).toEqual({
      kind: "upToNextMajorVersion",
      value: "6.0.0"
    });
  });

  it("rejects requirements on local packages", () => {
    const editor = ProjectEditor.load(packagesPbxprojPath);
    expect(editor.setPackageRequirement(LOCAL_PKG, "branch", "main")).toBe(false);
  });

  it("updates repositoryURL and relativePath", () => {
    const editor = ProjectEditor.load(packagesPbxprojPath);
    expect(editor.setPackageString(YAMS_PKG, "repositoryURL", "https://github.com/jpsim/Yams")).toBe(true);
    expect(editor.setPackageString(LOCAL_PKG, "relativePath", "../OtherKit")).toBe(true);
    expect(editor.setPackageString(LOCAL_PKG, "relativePath", "")).toBe(false);
    const refs = packageReferences(PbxModel.parse(editor.serialize()));
    expect(refs[0].repositoryURL).toBe("https://github.com/jpsim/Yams");
    expect(refs[1].relativePath).toBe("../OtherKit");
  });

  it("round-trips an unmodified project byte-for-byte", () => {
    const editor = ProjectEditor.load(packagesPbxprojPath);
    expect(editor.serialize()).toBe(fs.readFileSync(packagesPbxprojPath, "utf8"));
  });
});
