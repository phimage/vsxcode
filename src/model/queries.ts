import { PbxModel } from "./pbxProject";
import { Isa } from "./types";

/**
 * Read-only queries over a parsed `PbxModel` (targets, build phases, Swift
 * package references). Pure and reusable from both the tree provider (which
 * holds an already-parsed model) and `ProjectEditor` (inspector edits).
 */

export interface TargetInfo {
  uuid: string;
  name: string;
  isa: string;
  productType?: string;
  productName?: string;
  /** Display names of the targets this target depends on. */
  dependencyNames: string[];
}

export interface BuildPhaseInfo {
  uuid: string;
  isa: string;
  /** Xcode-style phase name, e.g. `Sources`, `Run Script`. */
  name: string;
  fileCount: number;
}

/** Requirement kinds selectable in Xcode's package dependency editor. */
export const PACKAGE_REQUIREMENT_KINDS = [
  "upToNextMajorVersion",
  "upToNextMinorVersion",
  "exactVersion",
  "versionRange",
  "branch",
  "revision"
] as const;

export interface PackageRequirement {
  kind: string;
  /** minimumVersion / version / branch / revision, depending on `kind`. */
  value: string;
  /** maximumVersion (versionRange only). */
  value2?: string;
}

export interface PackageRefInfo {
  uuid: string;
  isa: string;
  /** Display name: package repo/directory name. */
  name: string;
  /** Remote packages only. */
  repositoryURL?: string;
  requirement?: PackageRequirement;
  /** Local packages only. */
  relativePath?: string;
}

export interface PackageProductUse {
  targetName: string;
  productName: string;
}

const PHASE_NAMES: Record<string, string> = {
  PBXSourcesBuildPhase: "Sources",
  PBXResourcesBuildPhase: "Resources",
  PBXFrameworksBuildPhase: "Frameworks",
  PBXHeadersBuildPhase: "Headers",
  PBXShellScriptBuildPhase: "Run Script",
  PBXCopyFilesBuildPhase: "Copy Files"
};

export function phaseNameForIsa(isa: string | undefined): string {
  return (isa && PHASE_NAMES[isa]) || isa || "Build Phase";
}

/** `https://github.com/jpsim/Yams.git` → `Yams`. */
export function packageNameFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const last = url.replace(/\/+$/, "").split("/").pop();
  return last ? last.replace(/\.git$/i, "") : undefined;
}

/** Human-readable requirement, as Xcode shows it: `5.0.0 – next major`. */
export function requirementSummary(req: PackageRequirement | undefined): string {
  if (!req) {
    return "";
  }
  switch (req.kind) {
    case "upToNextMajorVersion":
      return `${req.value} – next major`;
    case "upToNextMinorVersion":
      return `${req.value} – next minor`;
    case "exactVersion":
      return `exact ${req.value}`;
    case "versionRange":
      return `${req.value} – ${req.value2 ?? "?"}`;
    case "branch":
      return `branch ${req.value}`;
    case "revision":
      return `revision ${req.value.slice(0, 10)}`;
    default:
      return req.value;
  }
}

export function targetInfo(model: PbxModel, uuid: string): TargetInfo | undefined {
  const target = model.get(uuid);
  if (!target || !target.isTarget()) {
    return undefined;
  }
  const dependencyNames: string[] = [];
  for (const dep of target.getStringArray("dependencies")) {
    // PBXTargetDependency -> target (same-project) or annotation fallback.
    const depObj = model.get(dep.value);
    const depTargetUuid = depObj?.getString("target");
    const depTarget = depTargetUuid ? model.get(depTargetUuid) : undefined;
    const name = depTarget?.displayName() ?? depObj?.getString("name") ?? depObj?.annotation;
    if (name) {
      dependencyNames.push(name);
    }
  }
  return {
    uuid,
    name: target.displayName(),
    isa: target.isa ?? "",
    productType: target.getString("productType"),
    productName: target.getString("productName"),
    dependencyNames
  };
}

export function buildPhasesOf(model: PbxModel, targetUuid: string): BuildPhaseInfo[] {
  const target = model.get(targetUuid);
  if (!target) {
    return [];
  }
  const out: BuildPhaseInfo[] = [];
  for (const ref of target.getStringArray("buildPhases")) {
    const phase = model.get(ref.value);
    if (!phase) {
      continue;
    }
    out.push({
      uuid: phase.uuid,
      isa: phase.isa ?? "",
      name: phase.getString("name") ?? phase.annotation ?? phaseNameForIsa(phase.isa),
      fileCount: phase.getStringArray("files").length
    });
  }
  return out;
}

/** File-reference uuids of a phase's build files (skips product refs). */
export function phaseFileRefs(model: PbxModel, phaseUuid: string): string[] {
  const phase = model.get(phaseUuid);
  if (!phase) {
    return [];
  }
  const out: string[] = [];
  for (const file of phase.getStringArray("files")) {
    const fileRef = model.get(file.value)?.getString("fileRef");
    if (fileRef) {
      out.push(fileRef);
    }
  }
  return out;
}

export function packageRequirement(model: PbxModel, uuid: string): PackageRequirement | undefined {
  const requirement = model.get(uuid)?.entry("requirement")?.value;
  if (!requirement || requirement.kind !== "dict") {
    return undefined;
  }
  const get = (key: string): string | undefined => {
    const entry = requirement.entries.find((e) => e.key.value === key);
    return entry?.value.kind === "string" ? entry.value.value : undefined;
  };
  const kind = get("kind") ?? "";
  switch (kind) {
    case "versionRange":
      return { kind, value: get("minimumVersion") ?? "", value2: get("maximumVersion") ?? "" };
    case "exactVersion":
      return { kind, value: get("version") ?? "" };
    case "branch":
      return { kind, value: get("branch") ?? "" };
    case "revision":
      return { kind, value: get("revision") ?? "" };
    default:
      // upToNextMajorVersion / upToNextMinorVersion (and unknown kinds).
      return { kind, value: get("minimumVersion") ?? "" };
  }
}

export function packageReferences(model: PbxModel): PackageRefInfo[] {
  const project = model.project();
  if (!project) {
    return [];
  }
  const out: PackageRefInfo[] = [];
  for (const ref of project.getStringArray("packageReferences")) {
    const pkg = model.get(ref.value);
    if (!pkg) {
      continue;
    }
    if (pkg.isa === Isa.XCRemoteSwiftPackageReference) {
      const repositoryURL = pkg.getString("repositoryURL");
      out.push({
        uuid: pkg.uuid,
        isa: pkg.isa,
        name: packageNameFromUrl(repositoryURL) ?? pkg.displayName(),
        repositoryURL,
        requirement: packageRequirement(model, pkg.uuid)
      });
    } else if (pkg.isa === Isa.XCLocalSwiftPackageReference) {
      const relativePath = pkg.getString("relativePath");
      out.push({
        uuid: pkg.uuid,
        isa: pkg.isa,
        name: relativePath ? relativePath.replace(/\/+$/, "").split("/").pop() ?? relativePath : pkg.displayName(),
        relativePath
      });
    }
  }
  return out;
}

/** Which targets consume products of the given package reference. */
export function packageProductUses(model: PbxModel, packageUuid: string): PackageProductUse[] {
  const out: PackageProductUse[] = [];
  for (const target of model.targets()) {
    for (const dep of target.getStringArray("packageProductDependencies")) {
      const product = model.get(dep.value);
      if (product?.getString("package") === packageUuid) {
        out.push({
          targetName: target.displayName(),
          productName: product.getString("productName") ?? product.displayName()
        });
      }
    }
  }
  return out;
}
