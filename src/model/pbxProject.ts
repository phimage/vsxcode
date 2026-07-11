import { DictNode, DocumentNode, StringNode } from "../parser/ast";
import { parse } from "../parser/parser";
import { Isa, PbxObject } from "./types";

/**
 * Semantic view over a parsed `.pbxproj`: indexes the `objects` dictionary by
 * UUID, tracks duplicates, and exposes typed lookups used by the tree and the
 * linter. Pure — no `vscode` dependency.
 */
export class PbxModel {
  readonly objects = new Map<string, PbxObject>();
  /** Duplicate object definitions (every occurrence after the first). */
  readonly duplicateKeys: StringNode[] = [];

  private readonly parents = new Map<string, string>();

  private constructor(readonly document: DocumentNode) {
    const rootDict = this.rootDict();
    const objectsEntry = rootDict?.entries.find((e) => e.key.value === "objects");
    if (objectsEntry && objectsEntry.value.kind === "dict") {
      this.indexObjects(objectsEntry.value);
    }
    this.buildParentMap();
  }

  static parse(source: string): PbxModel {
    return new PbxModel(parse(source));
  }

  private rootDict(): DictNode | undefined {
    return this.document.root.kind === "dict" ? this.document.root : undefined;
  }

  private indexObjects(objectsDict: DictNode): void {
    for (const entry of objectsDict.entries) {
      if (entry.value.kind !== "dict") {
        continue;
      }
      const uuid = entry.key.value;
      if (this.objects.has(uuid)) {
        this.duplicateKeys.push(entry.key);
        continue;
      }
      this.objects.set(uuid, new PbxObject(uuid, entry.key.token, entry.equals, entry.value));
    }
  }

  private buildParentMap(): void {
    for (const obj of this.objects.values()) {
      if (!obj.isGroup()) {
        continue;
      }
      for (const child of obj.getStringArray("children")) {
        if (!this.parents.has(child.value)) {
          this.parents.set(child.value, obj.uuid);
        }
      }
    }
  }

  /** The `rootObject` UUID from the top-level dictionary. */
  get rootObjectUuid(): string | undefined {
    const rootDict = this.rootDict();
    const entry = rootDict?.entries.find((e) => e.key.value === "rootObject");
    return entry && entry.value.kind === "string" ? entry.value.value : undefined;
  }

  /** The `rootObject` string node (for diagnostics location on a broken ref). */
  get rootObjectNode(): StringNode | undefined {
    const rootDict = this.rootDict();
    const entry = rootDict?.entries.find((e) => e.key.value === "rootObject");
    return entry && entry.value.kind === "string" ? entry.value : undefined;
  }

  project(): PbxObject | undefined {
    const root = this.rootObjectUuid;
    if (root) {
      const obj = this.objects.get(root);
      if (obj?.isa === Isa.PBXProject) {
        return obj;
      }
    }
    return this.allOfIsa(Isa.PBXProject)[0];
  }

  mainGroup(): PbxObject | undefined {
    const uuid = this.project()?.getString("mainGroup");
    return uuid ? this.objects.get(uuid) : undefined;
  }

  targets(): PbxObject[] {
    const project = this.project();
    if (!project) {
      return [];
    }
    return project
      .getStringArray("targets")
      .map((n) => this.objects.get(n.value))
      .filter((o): o is PbxObject => o !== undefined);
  }

  get(uuid: string): PbxObject | undefined {
    return this.objects.get(uuid);
  }

  parentOf(uuid: string): string | undefined {
    return this.parents.get(uuid);
  }

  allOfIsa(isa: string): PbxObject[] {
    return [...this.objects.values()].filter((o) => o.isa === isa);
  }
}
