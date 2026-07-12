import * as fs from "fs";
import * as path from "path";
import { ArrayNode, DictEntry, DictNode, TokenType } from "../parser/ast";
import { PbxModel } from "../model/pbxProject";
import { PathResolver } from "../model/pathResolver";
import { Isa, PbxObject } from "../model/types";
import { serialize } from "../serializer/serializer";
import {
  categoryForExtension,
  dictFieldIndent,
  fileTypeForExtension,
  FileCategory,
  FieldSpec,
  generateUuid,
  inlineDict,
  itemIndentFor,
  makeArray,
  makeObjectEntry,
  makeString,
  multilineDict,
  pushArrayItem,
  removeArrayItem,
  removeDictEntry,
  setDictString,
  setDictValue,
  setStringValue,
  tok
} from "./builder";

export interface AddedFile {
  uuid: string;
  name: string;
  category: FileCategory;
}

/** How a newly added reference locates its file (Xcode "Location" popup). */
export type ReferenceStyle = "automatic" | "group" | "sourceRoot" | "absolute";

/** All `sourceTree` values selectable in the Xcode file inspector. */
export const SOURCE_TREES = [
  "<group>",
  "SOURCE_ROOT",
  "<absolute>",
  "BUILT_PRODUCTS_DIR",
  "SDKROOT",
  "DEVELOPER_DIR"
] as const;

export interface TargetMembership {
  targetUuid: string;
  targetName: string;
  member: boolean;
}

export interface BuildSettingEntry {
  key: string;
  /** Arrays are surfaced as string[]; scalar settings as string. */
  value: string | string[];
}

export interface BuildConfigurationInfo {
  uuid: string;
  name: string;
  settings: BuildSettingEntry[];
}

const PHASE_FOR_CATEGORY: Record<Exclude<FileCategory, "header">, { isa: string; word: string }> = {
  source: { isa: "PBXSourcesBuildPhase", word: "Sources" },
  resource: { isa: "PBXResourcesBuildPhase", word: "Resources" },
  framework: { isa: "PBXFrameworksBuildPhase", word: "Frameworks" }
};

/**
 * In-memory, mutating editor over a single `.pbxproj`. Load, mutate, then
 * `serialize()` to obtain the new text (the caller decides how to persist it).
 * Unmodified regions keep their exact original formatting; new nodes use
 * Xcode-style formatting.
 */
export class ProjectEditor {
  private readonly used: Set<string>;

  private constructor(
    readonly pbxprojPath: string,
    readonly projectRoot: string,
    readonly model: PbxModel
  ) {
    this.used = new Set(model.objects.keys());
  }

  static load(pbxprojPath: string): ProjectEditor {
    const text = fs.readFileSync(pbxprojPath, "utf8");
    const model = PbxModel.parse(text);
    const projectRoot = path.dirname(path.dirname(pbxprojPath));
    return new ProjectEditor(pbxprojPath, projectRoot, model);
  }

  static fromText(text: string, projectRoot: string, pbxprojPath = "project.pbxproj"): ProjectEditor {
    return new ProjectEditor(pbxprojPath, projectRoot, PbxModel.parse(text));
  }

  serialize(): string {
    return serialize(this.model.document);
  }

  private resolver(): PathResolver {
    return new PathResolver(this.model, this.projectRoot);
  }

  private objectsDict(): DictNode {
    const root = this.model.document.root;
    const entry = root.kind === "dict" ? root.entries.find((e) => e.key.value === "objects") : undefined;
    if (!entry || entry.value.kind !== "dict") {
      throw new Error("Project has no objects dictionary");
    }
    return entry.value;
  }

  mainGroupUuid(): string | undefined {
    return this.model.mainGroup()?.uuid;
  }

  nativeTargets(): PbxObject[] {
    return this.model.targets().filter((t) => t.isa === Isa.PBXNativeTarget);
  }

  isGroup(uuid: string): boolean {
    return this.model.get(uuid)?.isGroup() ?? false;
  }

  displayName(uuid: string): string {
    return this.model.get(uuid)?.displayName() ?? uuid;
  }

  /** Absolute on-disk path of a node (null when not filesystem-backed). */
  resolvePath(uuid: string): string | null {
    return this.resolver().resolve(uuid);
  }

  // --- low-level mutations -------------------------------------------------

  private insertObject(uuid: string, dict: DictNode, isa: string, annotation?: string): void {
    const entry = makeObjectEntry(uuid, dict, annotation);
    const entries = this.objectsDict().entries;
    let insertAt = entries.length;
    for (let i = 0; i < entries.length; i++) {
      const value = entries[i].value;
      if (value.kind === "dict" && value.entries.find((e) => e.key.value === "isa")?.value?.kind === "string") {
        const entryIsa = (value.entries.find((e) => e.key.value === "isa")!.value as { value: string }).value;
        if (entryIsa === isa) {
          insertAt = i + 1;
        }
      }
    }
    entries.splice(insertAt, 0, entry);
  }

  private removeObjectEntry(uuid: string): void {
    const dict = this.objectsDict();
    dict.entries = dict.entries.filter((e) => e.key.value !== uuid);
  }

  private childrenArray(group: PbxObject): ArrayNode {
    const existing = group.arrayNode("children");
    if (existing) {
      return existing;
    }
    const arr = makeArray([], "\n\t\t\t\t", "\n\t\t\t");
    const entry: DictEntry = {
      key: makeString("children", "\n\t\t\t"),
      equals: tok(TokenType.Equals, "=", " "),
      value: arr,
      semicolon: tok(TokenType.Semicolon, ";", "")
    };
    const isaIdx = group.dict.entries.findIndex((e) => e.key.value === "isa");
    group.dict.entries.splice(isaIdx >= 0 ? isaIdx + 1 : 0, 0, entry);
    return arr;
  }

  private addChild(groupUuid: string, uuid: string, annotation?: string): void {
    const group = this.model.get(groupUuid);
    if (!group) {
      throw new Error(`Unknown group ${groupUuid}`);
    }
    pushArrayItem(this.childrenArray(group), uuid, annotation);
  }

  parentGroupOf(uuid: string): PbxObject | undefined {
    for (const obj of this.model.objects.values()) {
      if (obj.isGroup() && obj.getStringArray("children").some((c) => c.value === uuid)) {
        return obj;
      }
    }
    return undefined;
  }

  private buildPhases(): PbxObject[] {
    return [...this.model.objects.values()].filter((o) => !!o.isa && o.isa.endsWith("BuildPhase"));
  }

  // --- high-level operations ----------------------------------------------

  /** Creates a virtual group under `parentUuid`. Returns its UUID. */
  addGroup(parentUuid: string, name: string): string {
    const uuid = generateUuid(this.used);
    const dict = multilineDict([
      { key: "isa", value: Isa.PBXGroup },
      { key: "children", value: makeArray([], "\n\t\t\t\t", "\n\t\t\t") },
      { key: "name", value: name },
      { key: "sourceTree", value: "<group>" }
    ]);
    this.insertObject(uuid, dict, Isa.PBXGroup, name);
    this.addChild(parentUuid, uuid, name);
    return uuid;
  }

  /**
   * The `sourceTree` most used by sibling file references in a group — the
   * "mimic siblings" default Xcode applies when inserting into a folder.
   * Returns undefined when the group has no file-reference children with a
   * filesystem-resolvable source tree.
   */
  inferGroupSourceTree(groupUuid: string): string | undefined {
    const group = this.model.get(groupUuid);
    if (!group) {
      return undefined;
    }
    const counts = new Map<string, number>();
    for (const child of group.getStringArray("children")) {
      const obj = this.model.get(child.value);
      if (obj?.isa !== Isa.PBXFileReference) {
        continue;
      }
      const st = obj.getString("sourceTree") ?? "<group>";
      if (st === "<group>" || st === "SOURCE_ROOT" || st === "<absolute>") {
        counts.set(st, (counts.get(st) ?? 0) + 1);
      }
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [st, count] of counts) {
      if (count > bestCount || (count === bestCount && st === "<group>")) {
        best = st;
        bestCount = count;
      }
    }
    return best;
  }

  /** Resolves a reference style into the concrete `sourceTree` + `path` pair. */
  private locationFor(
    parentUuid: string,
    absPath: string,
    style: ReferenceStyle
  ): { sourceTree: string; refPath: string } {
    const parentDir = this.resolver().resolve(parentUuid);
    let sourceTree: string;
    switch (style) {
      case "group":
        sourceTree = parentDir ? "<group>" : "SOURCE_ROOT";
        break;
      case "sourceRoot":
        sourceTree = "SOURCE_ROOT";
        break;
      case "absolute":
        sourceTree = "<absolute>";
        break;
      default: {
        // automatic: mimic siblings, else group-relative when resolvable.
        const inferred = this.inferGroupSourceTree(parentUuid);
        sourceTree = inferred ?? (parentDir ? "<group>" : "SOURCE_ROOT");
        if (sourceTree === "<group>" && !parentDir) {
          sourceTree = "SOURCE_ROOT";
        }
        break;
      }
    }
    let refPath: string;
    if (sourceTree === "<absolute>") {
      refPath = absPath;
    } else if (sourceTree === "<group>" && parentDir) {
      refPath = path.relative(parentDir, absPath);
    } else {
      refPath = path.relative(this.projectRoot, absPath);
    }
    return { sourceTree, refPath: refPath.split(path.sep).join("/") };
  }

  /** Adds a file reference for `absPath` under `parentUuid`. */
  addFileReference(parentUuid: string, absPath: string, style: ReferenceStyle = "automatic"): AddedFile {
    const name = path.basename(absPath);
    const ext = path.extname(absPath);
    const { sourceTree, refPath } = this.locationFor(parentUuid, absPath, style);

    const fields: FieldSpec[] = [{ key: "isa", value: Isa.PBXFileReference }];
    const fileType = fileTypeForExtension(ext);
    if (fileType) {
      fields.push({ key: "lastKnownFileType", value: fileType });
    }
    if (refPath.includes("/")) {
      fields.push({ key: "name", value: name });
    }
    fields.push({ key: "path", value: refPath });
    fields.push({ key: "sourceTree", value: sourceTree });

    const uuid = generateUuid(this.used);
    this.insertObject(uuid, inlineDict(fields), Isa.PBXFileReference, name);
    this.addChild(parentUuid, uuid, name);
    return { uuid, name, category: categoryForExtension(ext) };
  }

  /** Adds a build-file linking `fileRefUuid` into `targetUuid`'s phase. */
  addToBuildPhase(fileRefUuid: string, name: string, category: FileCategory, targetUuid: string): void {
    if (category === "header") {
      return;
    }
    const phaseInfo = PHASE_FOR_CATEGORY[category];
    const target = this.model.get(targetUuid);
    if (!target) {
      return;
    }
    const phase = target
      .getStringArray("buildPhases")
      .map((v) => this.model.get(v.value))
      .find((p) => p?.isa === phaseInfo.isa);
    const filesArr = phase?.arrayNode("files");
    if (!phase || !filesArr) {
      return;
    }
    const annotation = `${name} in ${phaseInfo.word}`;
    const bfUuid = generateUuid(this.used);
    this.insertObject(
      bfUuid,
      inlineDict([
        { key: "isa", value: Isa.PBXBuildFile },
        { key: "fileRef", value: fileRefUuid, annotation: name }
      ]),
      Isa.PBXBuildFile,
      annotation
    );
    pushArrayItem(filesArr, bfUuid, annotation);
  }

  /** Removes a file/group reference (recursively for groups) plus its build files. */
  removeNode(uuid: string): void {
    const obj = this.model.get(uuid);
    if (!obj || uuid === this.mainGroupUuid()) {
      return;
    }
    if (obj.isGroup()) {
      for (const child of obj.getStringArray("children").map((c) => c.value)) {
        this.removeNode(child);
      }
    } else {
      for (const bf of this.model.allOfIsa(Isa.PBXBuildFile)) {
        if (bf.getString("fileRef") === uuid) {
          for (const phase of this.buildPhases()) {
            const filesArr = phase.arrayNode("files");
            if (filesArr) {
              removeArrayItem(filesArr, bf.uuid);
            }
          }
          this.removeObjectEntry(bf.uuid);
        }
      }
    }
    const parent = this.parentGroupOf(uuid);
    const parentArr = parent?.arrayNode("children");
    if (parentArr) {
      removeArrayItem(parentArr, uuid);
    }
    this.removeObjectEntry(uuid);
  }

  /**
   * Renames a node. Returns the on-disk path before/after (for renaming the file
   * on disk); `null` entries mean the node is not filesystem-backed.
   */
  rename(uuid: string, newName: string): { oldPath: string | null; newPath: string | null } {
    const obj = this.model.get(uuid);
    if (!obj) {
      return { oldPath: null, newPath: null };
    }
    const oldPath = this.resolver().resolve(uuid);

    const nameNode = obj.stringNode("name");
    if (nameNode) {
      setStringValue(nameNode, newName);
    } else {
      const pathNode = obj.stringNode("path");
      if (pathNode) {
        const dir = path.posix.dirname(pathNode.value);
        const newRel = dir && dir !== "." ? `${dir}/${newName}` : newName;
        setStringValue(pathNode, newRel);
      }
    }

    // Refresh the name annotation on the object's own entry.
    const entry = this.objectsDict().entries.find((e) => e.key.value === uuid);
    if (entry && entry.equals.leadingTrivia.includes("/*")) {
      entry.equals.leadingTrivia = ` /* ${newName} */ `;
    }

    const newPath = this.resolver().resolve(uuid);
    return { oldPath, newPath };
  }

  /** Moves a reference into another group (reparent only; no disk change). */
  move(uuid: string, newParentUuid: string): boolean {
    if (uuid === this.mainGroupUuid()) {
      return false;
    }
    const oldParent = this.parentGroupOf(uuid);
    const newParent = this.model.get(newParentUuid);
    if (!oldParent || !newParent || !newParent.isGroup() || oldParent.uuid === newParentUuid) {
      return false;
    }
    if (this.isDescendantOf(newParentUuid, uuid)) {
      return false; // would create a cycle
    }
    const annotation = this.model.get(uuid)?.displayName();
    const oldArr = oldParent.arrayNode("children");
    if (oldArr) {
      removeArrayItem(oldArr, uuid);
    }
    pushArrayItem(this.childrenArray(newParent), uuid, annotation);
    return true;
  }

  // --- inspector operations --------------------------------------------------

  /**
   * Changes a node's `sourceTree`, recomputing `path` so the reference keeps
   * pointing at the same on-disk location (as Xcode's Location popup does).
   */
  setSourceTree(uuid: string, newSourceTree: string): boolean {
    const obj = this.model.get(uuid);
    if (!obj) {
      return false;
    }
    const abs = this.resolver().resolve(uuid);
    setDictString(obj.dict, "sourceTree", newSourceTree);
    if (abs) {
      let newPath: string | null = null;
      if (newSourceTree === "<group>") {
        const parent = this.parentGroupOf(uuid);
        const parentDir = parent ? this.resolver().resolve(parent.uuid) : this.projectRoot;
        if (parentDir) {
          newPath = path.relative(parentDir, abs);
        }
      } else if (newSourceTree === "SOURCE_ROOT") {
        newPath = path.relative(this.projectRoot, abs);
      } else if (newSourceTree === "<absolute>") {
        newPath = abs;
      }
      if (newPath !== null) {
        setDictString(obj.dict, "path", newPath.split(path.sep).join("/"));
      }
    }
    return true;
  }

  /** Sets a node's raw `path` (empty removes the entry). */
  setPath(uuid: string, newPath: string): boolean {
    const obj = this.model.get(uuid);
    if (!obj) {
      return false;
    }
    if (newPath === "") {
      return removeDictEntry(obj.dict, "path");
    }
    setDictString(obj.dict, "path", newPath.split(path.sep).join("/"));
    return true;
  }

  /** Build files pointing at `fileRefUuid`, per target: is the file a member? */
  membershipsFor(fileRefUuid: string): TargetMembership[] {
    const buildFileUuids = new Set(
      this.model
        .allOfIsa(Isa.PBXBuildFile)
        .filter((bf) => bf.getString("fileRef") === fileRefUuid)
        .map((bf) => bf.uuid)
    );
    return this.model
      .targets()
      .filter((t) => t.isTarget())
      .map((t) => ({
        targetUuid: t.uuid,
        targetName: t.displayName(),
        member: t
          .getStringArray("buildPhases")
          .some((ph) =>
            this.model
              .get(ph.value)
              ?.getStringArray("files")
              .some((f) => buildFileUuids.has(f.value))
          )
      }));
  }

  /** Adds/removes a file's membership in one target's build phases. */
  setTargetMembership(fileRefUuid: string, targetUuid: string, member: boolean): void {
    const target = this.model.get(targetUuid);
    const ref = this.model.get(fileRefUuid);
    if (!target || !ref) {
      return;
    }
    if (member) {
      const name = ref.displayName();
      const category = categoryForExtension(path.extname(ref.getString("path") ?? name));
      this.addToBuildPhase(fileRefUuid, name, category, targetUuid);
      return;
    }
    const phases = target
      .getStringArray("buildPhases")
      .map((ph) => this.model.get(ph.value))
      .filter((p): p is PbxObject => p !== undefined);
    for (const phase of phases) {
      const filesArr = phase.arrayNode("files");
      if (!filesArr) {
        continue;
      }
      for (const fileUuid of phase.getStringArray("files").map((f) => f.value)) {
        const bf = this.model.get(fileUuid);
        if (bf?.isa === Isa.PBXBuildFile && bf.getString("fileRef") === fileRefUuid) {
          removeArrayItem(filesArr, fileUuid);
          this.removeObjectEntry(fileUuid);
        }
      }
    }
  }

  // --- project properties ----------------------------------------------------

  projectObject(): PbxObject | undefined {
    return this.model.project();
  }

  /** Sets (or inserts) a top-level string property on the PBXProject object. */
  setProjectString(key: string, value: string): boolean {
    const project = this.projectObject();
    if (!project) {
      return false;
    }
    if (value === "") {
      return removeDictEntry(project.dict, key);
    }
    setDictString(project.dict, key, value);
    return true;
  }

  /** Reads a string from the PBXProject `attributes` dictionary. */
  projectAttribute(key: string): string | undefined {
    const attrs = this.projectObject()?.entry("attributes")?.value;
    if (!attrs || attrs.kind !== "dict") {
      return undefined;
    }
    const entry = attrs.entries.find((e) => e.key.value === key);
    return entry?.value.kind === "string" ? entry.value.value : undefined;
  }

  /** Sets (or inserts / removes when empty) a PBXProject attribute. */
  setProjectAttribute(key: string, value: string): boolean {
    const project = this.projectObject();
    if (!project) {
      return false;
    }
    let attrsEntry = project.entry("attributes");
    if (!attrsEntry) {
      if (value === "") {
        return true;
      }
      const indent = dictFieldIndent(project.dict, "\n\t\t\t");
      const dict: DictNode = {
        kind: "dict",
        open: tok(TokenType.LBrace, "{", " "),
        entries: [],
        close: tok(TokenType.RBrace, "}", indent)
      };
      setDictValue(project.dict, "attributes", dict);
      attrsEntry = project.entry("attributes");
    }
    if (!attrsEntry || attrsEntry.value.kind !== "dict") {
      return false;
    }
    if (value === "") {
      removeDictEntry(attrsEntry.value, key);
      return true;
    }
    setDictString(attrsEntry.value, key, value);
    return true;
  }

  knownRegions(): string[] {
    return (this.projectObject()?.getStringArray("knownRegions") ?? []).map((n) => n.value);
  }

  setKnownRegions(regions: string[]): boolean {
    const project = this.projectObject();
    if (!project) {
      return false;
    }
    const existing = project.arrayNode("knownRegions");
    if (existing) {
      const indent = itemIndentFor(existing);
      existing.items = [];
      for (const region of regions) {
        existing.items.push({
          value: makeString(region, indent),
          comma: tok(TokenType.Comma, ",")
        });
      }
      return true;
    }
    setDictValue(project.dict, "knownRegions", makeArray(regions.map((r) => ({ value: r })), "\n\t\t\t\t", "\n\t\t\t"));
    return true;
  }

  /** Build configurations of the configuration list referenced by `owner`. */
  buildConfigurationsOf(owner: PbxObject): BuildConfigurationInfo[] {
    const listUuid = owner.getString("buildConfigurationList");
    const list = listUuid ? this.model.get(listUuid) : undefined;
    if (!list) {
      return [];
    }
    return list
      .getStringArray("buildConfigurations")
      .map((n) => this.model.get(n.value))
      .filter((c): c is PbxObject => c !== undefined)
      .map((c) => ({
        uuid: c.uuid,
        name: c.getString("name") ?? c.uuid,
        settings: this.buildSettings(c)
      }));
  }

  private buildSettings(config: PbxObject): BuildSettingEntry[] {
    const settings = config.entry("buildSettings")?.value;
    if (!settings || settings.kind !== "dict") {
      return [];
    }
    const out: BuildSettingEntry[] = [];
    for (const entry of settings.entries) {
      if (entry.value.kind === "string") {
        out.push({ key: entry.key.value, value: entry.value.value });
      } else if (entry.value.kind === "array") {
        out.push({
          key: entry.key.value,
          value: entry.value.items.filter((i) => i.value.kind === "string").map((i) => (i.value as { value: string }).value)
        });
      }
    }
    return out;
  }

  /** Sets / replaces / removes (null) one build setting on a configuration. */
  setBuildSetting(configUuid: string, key: string, value: string | string[] | null): boolean {
    const config = this.model.get(configUuid);
    if (!config || config.isa !== Isa.XCBuildConfiguration) {
      return false;
    }
    let settingsEntry = config.entry("buildSettings");
    if (!settingsEntry) {
      const indent = dictFieldIndent(config.dict, "\n\t\t\t");
      const dict: DictNode = {
        kind: "dict",
        open: tok(TokenType.LBrace, "{", " "),
        entries: [],
        close: tok(TokenType.RBrace, "}", indent)
      };
      setDictValue(config.dict, "buildSettings", dict);
      settingsEntry = config.entry("buildSettings");
    }
    if (!settingsEntry || settingsEntry.value.kind !== "dict") {
      return false;
    }
    const settings = settingsEntry.value;
    if (value === null) {
      return removeDictEntry(settings, key);
    }
    if (Array.isArray(value)) {
      const itemIndent = dictFieldIndent(settings, "\n\t\t\t\t") + "\t";
      const closeIndent = dictFieldIndent(settings, "\n\t\t\t\t");
      setDictValue(settings, key, makeArray(value.map((v) => ({ value: v })), itemIndent, closeIndent));
      return true;
    }
    setDictString(settings, key, value);
    return true;
  }

  // --- targets ----------------------------------------------------------------

  /**
   * Renames a target (and `productName` when it matched the old name). Stale
   * `/* Name *\/` annotation comments elsewhere are preserved trivia — Xcode
   * regenerates them on its next save; they have no semantic effect.
   */
  setTargetName(uuid: string, name: string): boolean {
    const target = this.model.get(uuid);
    const trimmed = name.trim();
    if (!target || !target.isTarget() || trimmed === "" || trimmed === target.getString("name")) {
      return false;
    }
    if (target.getString("productName") === target.getString("name")) {
      setDictString(target.dict, "productName", trimmed);
    }
    setDictString(target.dict, "name", trimmed);
    return true;
  }

  // --- Swift package references ------------------------------------------------

  /** Rewrites a remote package's version requirement (kind + value keys). */
  setPackageRequirement(uuid: string, kind: string, value: string, value2?: string): boolean {
    const pkg = this.model.get(uuid);
    if (!pkg || pkg.isa !== Isa.XCRemoteSwiftPackageReference) {
      return false;
    }
    let entry = pkg.entry("requirement");
    if (!entry) {
      const indent = dictFieldIndent(pkg.dict, "\n\t\t\t");
      const dict: DictNode = {
        kind: "dict",
        open: tok(TokenType.LBrace, "{", " "),
        entries: [],
        close: tok(TokenType.RBrace, "}", indent)
      };
      setDictValue(pkg.dict, "requirement", dict);
      entry = pkg.entry("requirement");
    }
    if (!entry || entry.value.kind !== "dict") {
      return false;
    }
    const dict = entry.value;
    for (const key of ["minimumVersion", "maximumVersion", "version", "branch", "revision"]) {
      removeDictEntry(dict, key);
    }
    setDictString(dict, "kind", kind);
    switch (kind) {
      case "versionRange":
        setDictString(dict, "minimumVersion", value);
        setDictString(dict, "maximumVersion", value2 ?? value);
        break;
      case "exactVersion":
        setDictString(dict, "version", value);
        break;
      case "branch":
        setDictString(dict, "branch", value);
        break;
      case "revision":
        setDictString(dict, "revision", value);
        break;
      default:
        setDictString(dict, "minimumVersion", value);
        break;
    }
    return true;
  }

  /** Sets `repositoryURL` (remote) or `relativePath` (local) on a package ref. */
  setPackageString(uuid: string, key: "repositoryURL" | "relativePath", value: string): boolean {
    const pkg = this.model.get(uuid);
    if (!pkg || value.trim() === "" || pkg.getString(key) === value.trim()) {
      return false;
    }
    setDictString(pkg.dict, key, value.trim());
    return true;
  }

  private isDescendantOf(candidate: string, ancestor: string): boolean {
    let cur: string | undefined = candidate;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === ancestor) {
        return true;
      }
      seen.add(cur);
      cur = this.parentGroupOf(cur)?.uuid;
    }
    return false;
  }
}

