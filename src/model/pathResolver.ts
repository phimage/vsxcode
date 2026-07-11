import * as path from "path";
import { PbxModel } from "./pbxProject";
import { PbxObject } from "./types";

/**
 * Resolves the on-disk absolute path of a file reference or group by walking up
 * the group hierarchy and honouring each node's `sourceTree` + `path`.
 *
 * `projectRoot` is `SOURCE_ROOT` — the directory that CONTAINS the `.xcodeproj`
 * bundle (i.e. the parent of the folder holding `project.pbxproj`).
 *
 * Returns `null` when the path is not resolvable to a real filesystem location
 * (e.g. `sourceTree` is a build variable such as `SDKROOT` / `BUILT_PRODUCTS_DIR`).
 */
export class PathResolver {
  constructor(private readonly model: PbxModel, private readonly projectRoot: string) {}

  resolve(uuid: string): string | null {
    return this.resolveInner(uuid, new Set());
  }

  private resolveInner(uuid: string, visiting: Set<string>): string | null {
    if (visiting.has(uuid)) {
      return null; // cycle — reported separately by the linter
    }
    visiting.add(uuid);

    const obj = this.model.get(uuid);
    if (!obj) {
      return null;
    }

    const sourceTree = obj.getString("sourceTree") ?? "<group>";
    const ownPath = obj.getString("path");

    let base: string | null;
    switch (sourceTree) {
      case "<absolute>":
        return ownPath ?? null;
      case "SOURCE_ROOT":
        base = this.projectRoot;
        break;
      case "<group>": {
        const parentUuid = this.model.parentOf(uuid);
        base = parentUuid ? this.resolveInner(parentUuid, visiting) : this.projectRoot;
        break;
      }
      default:
        // SDKROOT, BUILT_PRODUCTS_DIR, DEVELOPER_DIR, ... — not on the filesystem.
        return null;
    }

    if (base === null) {
      return null;
    }
    return ownPath ? path.resolve(base, ownPath) : base;
  }

  /** True if `sourceTree` indicates the node lives on the local filesystem. */
  isFilesystemNode(obj: PbxObject): boolean {
    const st = obj.getString("sourceTree") ?? "<group>";
    return st === "<group>" || st === "SOURCE_ROOT" || st === "<absolute>";
  }
}
