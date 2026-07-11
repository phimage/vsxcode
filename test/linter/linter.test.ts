import * as path from "path";
import { describe, expect, it } from "vitest";
import { lint, PlainDiagnostic } from "../../src/linter/linter";
import { PbxModel } from "../../src/model/pbxProject";
import { readFixture, sampleProjectRoot } from "../helpers";

function byCode(diags: PlainDiagnostic[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of diags) {
    counts[d.code] = (counts[d.code] ?? 0) + 1;
  }
  return counts;
}

describe("linter — structural rules (no disk)", () => {
  const model = PbxModel.parse(readFixture("broken.pbxproj"));
  const diags = lint({ model });
  const counts = byCode(diags);

  it("detects the duplicate UUID", () => {
    expect(counts["duplicate-uuid"]).toBe(1);
  });

  it("detects broken references (array entry + fileRef)", () => {
    expect(counts["broken-reference"]).toBe(2);
  });

  it("detects the circular group", () => {
    expect(counts["circular-group"]).toBe(1);
  });

  it("detects missing/empty build-configuration lists", () => {
    // Project + target both lack a buildConfigurationList.
    expect(counts["broken-configuration"]).toBe(2);
  });
});

describe("linter — disk rules on the Sample project", () => {
  const model = PbxModel.parse(readFixture("Sample.xcodeproj/project.pbxproj"));
  const missingPath = path.resolve(sampleProjectRoot, "Sources/Missing.swift");

  const diags = lint({
    model,
    projectRoot: sampleProjectRoot,
    // Everything exists except the intentionally-missing file.
    fileExists: (p) => p !== missingPath
  });
  const counts = byCode(diags);

  it("flags exactly one missing file", () => {
    expect(counts["missing-file"] ?? 0).toBe(1);
    const missing = diags.find((d) => d.code === "missing-file");
    expect(missing?.message).toContain("Missing.swift");
  });

  it("finds no structural problems in the otherwise-clean project", () => {
    expect(counts["broken-reference"] ?? 0).toBe(0);
    expect(counts["duplicate-uuid"] ?? 0).toBe(0);
    expect(counts["duplicate-file"] ?? 0).toBe(0);
    expect(counts["circular-group"] ?? 0).toBe(0);
    expect(counts["broken-configuration"] ?? 0).toBe(0);
  });
});
