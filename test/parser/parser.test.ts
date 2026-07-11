import { describe, expect, it } from "vitest";
import { PbxModel } from "../../src/model/pbxProject";
import { readFixture } from "../helpers";

describe("PbxModel structural parsing", () => {
  const model = PbxModel.parse(readFixture("Sample.xcodeproj/project.pbxproj"));

  it("finds the rootObject and PBXProject", () => {
    expect(model.rootObjectUuid).toBe("1A0000000000000000000001");
    expect(model.project()?.isa).toBe("PBXProject");
  });

  it("resolves the main group and its children", () => {
    const main = model.mainGroup();
    expect(main?.uuid).toBe("1A0000000000000000000002");
    expect(main?.getStringArray("children").map((n) => n.value)).toEqual([
      "1A0000000000000000000003",
      "1A0000000000000000000004"
    ]);
  });

  it("lists targets by name", () => {
    const targets = model.targets();
    expect(targets).toHaveLength(1);
    expect(targets[0].displayName()).toBe("Sample");
  });

  it("indexes all file references", () => {
    expect(model.allOfIsa("PBXFileReference")).toHaveLength(5);
    expect(model.duplicateKeys).toHaveLength(0);
  });

  it("extracts the name annotation after a UUID", () => {
    const appDelegate = model.get("1A0000000000000000000005");
    expect(appDelegate?.annotation).toBe("AppDelegate.swift");
  });

  it("decodes quoted string values", () => {
    const target = model.targets()[0];
    expect(target.getString("productType")).toBe("com.apple.product-type.application");
  });
});
