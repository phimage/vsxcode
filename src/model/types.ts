import { ArrayNode, DictEntry, DictNode, StringNode, Token, ValueNode } from "../parser/ast";

/** Common `isa` values found in `.pbxproj` objects. */
export const Isa = {
  PBXProject: "PBXProject",
  PBXGroup: "PBXGroup",
  PBXVariantGroup: "PBXVariantGroup",
  XCVersionGroup: "XCVersionGroup",
  PBXFileReference: "PBXFileReference",
  PBXFileSystemSynchronizedRootGroup: "PBXFileSystemSynchronizedRootGroup",
  PBXBuildFile: "PBXBuildFile",
  PBXNativeTarget: "PBXNativeTarget",
  PBXAggregateTarget: "PBXAggregateTarget",
  PBXLegacyTarget: "PBXLegacyTarget",
  XCConfigurationList: "XCConfigurationList",
  XCBuildConfiguration: "XCBuildConfiguration",
  XCRemoteSwiftPackageReference: "XCRemoteSwiftPackageReference",
  XCLocalSwiftPackageReference: "XCLocalSwiftPackageReference",
  XCSwiftPackageProductDependency: "XCSwiftPackageProductDependency"
} as const;

const GROUP_ISAS = new Set<string>([
  Isa.PBXGroup,
  Isa.PBXVariantGroup,
  Isa.XCVersionGroup,
  Isa.PBXFileSystemSynchronizedRootGroup
]);

const TARGET_ISAS = new Set<string>([Isa.PBXNativeTarget, Isa.PBXAggregateTarget, Isa.PBXLegacyTarget]);

/** Extracts a leading `/* ... *\/` annotation comment from trivia, if present. */
export function extractAnnotation(trivia: string): string | undefined {
  const match = /\/\*\s*(.*?)\s*\*\//s.exec(trivia);
  return match ? match[1] : undefined;
}

/** Typed, read-only view over one object in the `objects` dictionary. */
export class PbxObject {
  constructor(
    readonly uuid: string,
    /** The UUID key token (definition location, for diagnostics). */
    readonly keyToken: Token,
    /** The `=` token following the key; its trivia holds the name annotation. */
    readonly equalsToken: Token,
    readonly dict: DictNode
  ) {}

  get isa(): string | undefined {
    return this.getString("isa");
  }

  get annotation(): string | undefined {
    return extractAnnotation(this.equalsToken.leadingTrivia);
  }

  isGroup(): boolean {
    return this.isa !== undefined && GROUP_ISAS.has(this.isa);
  }

  isTarget(): boolean {
    return this.isa !== undefined && TARGET_ISAS.has(this.isa);
  }

  entry(key: string): DictEntry | undefined {
    return this.dict.entries.find((e) => e.key.value === key);
  }

  stringNode(key: string): StringNode | undefined {
    const value = this.entry(key)?.value;
    return value && value.kind === "string" ? value : undefined;
  }

  getString(key: string): string | undefined {
    return this.stringNode(key)?.value;
  }

  arrayNode(key: string): ArrayNode | undefined {
    const value = this.entry(key)?.value;
    return value && value.kind === "array" ? value : undefined;
  }

  /** Reads an array-of-strings property (e.g. `children`, `files`). */
  getStringArray(key: string): StringNode[] {
    const arr = this.arrayNode(key);
    if (!arr) {
      return [];
    }
    const out: StringNode[] = [];
    for (const item of arr.items) {
      if (item.value.kind === "string") {
        out.push(item.value);
      }
    }
    return out;
  }

  /** Best display name: `name`, then `path`, then annotation, then uuid. */
  displayName(): string {
    return this.getString("name") ?? this.getString("path") ?? this.annotation ?? this.uuid;
  }
}

/** Keys whose string values are UUID references to other objects. */
export const REFERENCE_KEYS: ReadonlySet<string> = new Set([
  "fileRef",
  "mainGroup",
  "productRefGroup",
  "productReference",
  "buildConfigurationList",
  "target",
  "targetProxy",
  "remoteRef",
  "containerPortal",
  "baseConfigurationReference",
  "productReference"
]);

/** Keys whose array values are lists of UUID references. */
export const REFERENCE_ARRAY_KEYS: ReadonlySet<string> = new Set([
  "children",
  "files",
  "buildPhases",
  "buildConfigurations",
  "targets",
  "dependencies",
  "buildRules",
  "fileSystemSynchronizedGroups",
  "packageProductDependencies",
  "packageReferences"
]);

/** True when a `sourceTree` value is resolvable to a real on-disk directory. */
export function isResolvableSourceTree(sourceTree: string | undefined): boolean {
  if (sourceTree === undefined) {
    return true; // defaults to <group>
  }
  return sourceTree === "<group>" || sourceTree === "SOURCE_ROOT" || sourceTree === "<absolute>";
}

export type { ValueNode };
