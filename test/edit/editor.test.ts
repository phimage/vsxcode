import * as path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectEditor } from "../../src/edit/projectEditor";
import { lint } from "../../src/linter/linter";
import { PbxModel } from "../../src/model/pbxProject";
import { parse } from "../../src/parser/parser";
import { serialize } from "../../src/serializer/serializer";
import { readFixture, sampleProjectRoot } from "../helpers";

const UUID = {
  mainGroup: "1A0000000000000000000002",
  sources: "1A0000000000000000000003",
  products: "1A0000000000000000000004",
  mainViewRef: "1A0000000000000000000006",
  mainViewBuildFile: "1A000000000000000000000B",
  sourcesPhase: "1A000000000000000000000F",
  target: "1A000000000000000000000E"
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

describe("ProjectEditor", () => {
  let editor: ProjectEditor;

  beforeEach(() => {
    editor = ProjectEditor.fromText(SOURCE, sampleProjectRoot);
  });

  it("serializes an unmodified project byte-for-byte", () => {
    expect(editor.serialize()).toBe(SOURCE);
  });

  it("produces stable, re-parseable output after a mutation", () => {
    editor.addGroup(UUID.mainGroup, "Utilities");
    const out = editor.serialize();
    expect(serialize(parse(out))).toBe(out); // idempotent
    expect(out).toContain("AppDelegate.swift in Sources"); // unchanged region intact
  });

  it("adds a virtual group under the main group", () => {
    const uuid = editor.addGroup(UUID.mainGroup, "Utilities");
    const model = reparse(editor);
    expect(model.get(uuid)?.isa).toBe("PBXGroup");
    expect(model.get(uuid)?.getString("name")).toBe("Utilities");
    expect(model.mainGroup()?.getStringArray("children").map((n) => n.value)).toContain(uuid);
    expect(structuralErrors(model)).toEqual([]);
  });

  it("adds a file reference and its build-file membership", () => {
    const added = editor.addFileReference(UUID.sources, path.join(sampleProjectRoot, "Sources/Extra.swift"));
    expect(added.category).toBe("source");
    editor.addToBuildPhase(added.uuid, added.name, added.category, UUID.target);

    const model = reparse(editor);
    const ref = model.get(added.uuid);
    expect(ref?.isa).toBe("PBXFileReference");
    expect(ref?.getString("path")).toBe("Extra.swift");
    expect(model.get(UUID.sources)?.getStringArray("children").map((n) => n.value)).toContain(added.uuid);

    const buildFiles = model.allOfIsa("PBXBuildFile").filter((b) => b.getString("fileRef") === added.uuid);
    expect(buildFiles).toHaveLength(1);
    expect(model.get(UUID.sourcesPhase)?.getStringArray("files").map((n) => n.value)).toContain(
      buildFiles[0].uuid
    );
    expect(structuralErrors(model)).toEqual([]);
  });

  it("removes a file reference along with its build files", () => {
    editor.removeNode(UUID.mainViewRef);
    const model = reparse(editor);

    expect(model.get(UUID.mainViewRef)).toBeUndefined();
    expect(model.get(UUID.mainViewBuildFile)).toBeUndefined();
    expect(model.get(UUID.sources)?.getStringArray("children").map((n) => n.value)).not.toContain(
      UUID.mainViewRef
    );
    expect(model.get(UUID.sourcesPhase)?.getStringArray("files").map((n) => n.value)).not.toContain(
      UUID.mainViewBuildFile
    );
    expect(structuralErrors(model)).toEqual([]);
  });

  it("renames a file reference and reports the on-disk move", () => {
    const { oldPath, newPath } = editor.rename(UUID.mainViewRef, "Renamed.swift");
    expect(oldPath).toBe(path.resolve(sampleProjectRoot, "Sources/MainView.swift"));
    expect(newPath).toBe(path.resolve(sampleProjectRoot, "Sources/Renamed.swift"));

    const model = reparse(editor);
    expect(model.get(UUID.mainViewRef)?.getString("path")).toBe("Renamed.swift");
    expect(structuralErrors(model)).toEqual([]);
  });

  it("moves a reference between groups", () => {
    expect(editor.move(UUID.mainViewRef, UUID.products)).toBe(true);
    const model = reparse(editor);
    expect(model.get(UUID.sources)?.getStringArray("children").map((n) => n.value)).not.toContain(
      UUID.mainViewRef
    );
    expect(model.get(UUID.products)?.getStringArray("children").map((n) => n.value)).toContain(
      UUID.mainViewRef
    );
    expect(structuralErrors(model)).toEqual([]);
  });

  it("refuses illegal moves (main group / into own subtree)", () => {
    expect(editor.move(UUID.mainGroup, UUID.sources)).toBe(false);
    expect(editor.move(UUID.sources, UUID.sources)).toBe(false);
  });
});
