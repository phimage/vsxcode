import { describe, expect, it } from "vitest";
import { PbxModel } from "../../src/model/pbxProject";
import {
  buildPhasesOf,
  packageProductUses,
  packageReferences,
  phaseFileRefs,
  requirementSummary,
  targetInfo
} from "../../src/model/queries";
import { readFixture } from "../helpers";

const sample = (): PbxModel => PbxModel.parse(readFixture("Sample.xcodeproj/project.pbxproj"));
const packages = (): PbxModel => PbxModel.parse(readFixture("Packages.xcodeproj/project.pbxproj"));

const SAMPLE_TARGET = "1A000000000000000000000E";
const YAMS_PKG = "2B0000000000000000000006";

describe("targets", () => {
  it("reads target identity and dependencies", () => {
    const info = targetInfo(sample(), SAMPLE_TARGET);
    expect(info).toMatchObject({
      name: "Sample",
      isa: "PBXNativeTarget",
      productType: "com.apple.product-type.application",
      productName: "Sample",
      dependencyNames: []
    });
    expect(targetInfo(sample(), "1A0000000000000000000005")).toBeUndefined(); // a file ref
  });

  it("lists build phases with file counts", () => {
    const phases = buildPhasesOf(sample(), SAMPLE_TARGET);
    expect(phases.map((p) => ({ name: p.name, fileCount: p.fileCount }))).toEqual([
      { name: "Sources", fileCount: 3 },
      { name: "Resources", fileCount: 1 },
      { name: "Frameworks", fileCount: 0 }
    ]);
  });

  it("maps phase build files back to file references", () => {
    const model = sample();
    const sources = buildPhasesOf(model, SAMPLE_TARGET)[0];
    const refs = phaseFileRefs(model, sources.uuid);
    expect(refs).toEqual([
      "1A0000000000000000000005",
      "1A0000000000000000000006",
      "1A0000000000000000000008"
    ]);
  });

  it("skips product-only build files (no fileRef)", () => {
    const model = packages();
    const frameworks = buildPhasesOf(model, "2B0000000000000000000004")[0];
    expect(frameworks.fileCount).toBe(1);
    expect(phaseFileRefs(model, frameworks.uuid)).toEqual([]);
  });
});

describe("packages", () => {
  it("reads remote and local package references", () => {
    const refs = packageReferences(packages());
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      uuid: YAMS_PKG,
      name: "Yams",
      repositoryURL: "https://github.com/jpsim/Yams.git",
      requirement: { kind: "upToNextMajorVersion", value: "5.0.0" }
    });
    expect(refs[1]).toMatchObject({
      isa: "XCLocalSwiftPackageReference",
      name: "LocalKit",
      relativePath: "../LocalKit"
    });
  });

  it("reports which targets use a package's products", () => {
    expect(packageProductUses(packages(), YAMS_PKG)).toEqual([
      { targetName: "PackagesApp", productName: "Yams" }
    ]);
    expect(packageProductUses(packages(), "2B0000000000000000000007")).toEqual([]);
  });

  it("summarizes requirements like Xcode", () => {
    expect(requirementSummary({ kind: "upToNextMajorVersion", value: "5.0.0" })).toBe("5.0.0 – next major");
    expect(requirementSummary({ kind: "exactVersion", value: "2.0.1" })).toBe("exact 2.0.1");
    expect(requirementSummary({ kind: "versionRange", value: "1.0.0", value2: "2.0.0" })).toBe("1.0.0 – 2.0.0");
    expect(requirementSummary({ kind: "branch", value: "main" })).toBe("branch main");
    expect(requirementSummary(undefined)).toBe("");
  });
});
