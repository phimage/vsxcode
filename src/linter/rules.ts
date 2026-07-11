import * as path from "path";
import { PbxModel } from "../model/pbxProject";
import { PathResolver } from "../model/pathResolver";
import { Isa, REFERENCE_ARRAY_KEYS, REFERENCE_KEYS } from "../model/types";

export type Severity = "error" | "warning";

export interface PlainDiagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** Start offset into the pbxproj source. */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

export interface LintContext {
  model: PbxModel;
  /** SOURCE_ROOT — directory containing the .xcodeproj. Omit to skip disk checks. */
  projectRoot?: string;
  /** Existence probe; defaults to a never-exists stub when omitted. */
  fileExists?: (absPath: string) => boolean;
}

function display(projectRoot: string | undefined, abs: string): string {
  if (!projectRoot) {
    return abs;
  }
  const rel = path.relative(projectRoot, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

/** Every object UUID must be defined at most once. */
export function duplicateUuidRule(model: PbxModel): PlainDiagnostic[] {
  return model.duplicateKeys.map((node) => ({
    code: "duplicate-uuid",
    severity: "error" as const,
    message: `Duplicate object UUID '${node.value}'.`,
    start: node.token.start,
    end: node.token.end
  }));
}

/** Every reference (single or in an array) must point to a defined object. */
export function brokenReferenceRule(model: PbxModel): PlainDiagnostic[] {
  const out: PlainDiagnostic[] = [];

  const rootRef = model.rootObjectNode;
  if (rootRef && !model.objects.has(rootRef.value)) {
    out.push({
      code: "broken-reference",
      severity: "error",
      message: `rootObject references unknown object '${rootRef.value}'.`,
      start: rootRef.token.start,
      end: rootRef.token.end
    });
  }

  for (const obj of model.objects.values()) {
    for (const entry of obj.dict.entries) {
      const key = entry.key.value;
      if (REFERENCE_KEYS.has(key) && entry.value.kind === "string") {
        const target = entry.value.value;
        if (!model.objects.has(target)) {
          out.push({
            code: "broken-reference",
            severity: "error",
            message: `${key} references unknown object '${target}'.`,
            start: entry.value.token.start,
            end: entry.value.token.end
          });
        }
      } else if (REFERENCE_ARRAY_KEYS.has(key)) {
        for (const item of obj.getStringArray(key)) {
          if (!model.objects.has(item.value)) {
            out.push({
              code: "broken-reference",
              severity: "error",
              message: `${key} references unknown object '${item.value}'.`,
              start: item.token.start,
              end: item.token.end
            });
          }
        }
      }
    }
  }
  return out;
}

const FILESYSTEM_ISAS = new Set<string>([Isa.PBXFileReference, Isa.PBXFileSystemSynchronizedRootGroup]);

/** File references whose resolvable path is absent on disk. */
export function missingFileRule(ctx: LintContext): PlainDiagnostic[] {
  const { model, projectRoot, fileExists } = ctx;
  if (projectRoot === undefined || !fileExists) {
    return [];
  }
  const resolver = new PathResolver(model, projectRoot);
  const out: PlainDiagnostic[] = [];
  for (const obj of model.objects.values()) {
    if (!obj.isa || !FILESYSTEM_ISAS.has(obj.isa)) {
      continue;
    }
    if (!resolver.isFilesystemNode(obj)) {
      continue;
    }
    const resolved = resolver.resolve(obj.uuid);
    if (resolved === null || fileExists(resolved)) {
      continue;
    }
    const anchor = obj.stringNode("path") ?? obj.stringNode("name");
    const token = anchor ? anchor.token : obj.keyToken;
    out.push({
      code: "missing-file",
      severity: "error",
      message: `File not found on disk: ${display(projectRoot, resolved)}`,
      start: token.start,
      end: token.end
    });
  }
  return out;
}

/** Two file references that resolve to the same on-disk path. */
export function duplicateFileRule(ctx: LintContext): PlainDiagnostic[] {
  const { model, projectRoot } = ctx;
  if (projectRoot === undefined) {
    return [];
  }
  const resolver = new PathResolver(model, projectRoot);
  const byPath = new Map<string, { start: number; end: number }[]>();
  for (const obj of model.allOfIsa(Isa.PBXFileReference)) {
    if (!resolver.isFilesystemNode(obj)) {
      continue;
    }
    const resolved = resolver.resolve(obj.uuid);
    if (resolved === null) {
      continue;
    }
    const token = (obj.stringNode("path") ?? obj.stringNode("name"))?.token ?? obj.keyToken;
    const list = byPath.get(resolved) ?? [];
    list.push({ start: token.start, end: token.end });
    byPath.set(resolved, list);
  }
  const out: PlainDiagnostic[] = [];
  for (const [resolved, tokens] of byPath) {
    if (tokens.length < 2) {
      continue;
    }
    for (const t of tokens) {
      out.push({
        code: "duplicate-file",
        severity: "warning",
        message: `${tokens.length} file references resolve to the same path: ${display(projectRoot, resolved)}`,
        start: t.start,
        end: t.end
      });
    }
  }
  return out;
}

/** Cycles in the group hierarchy (a group that transitively contains itself). */
export function circularGroupRule(model: PbxModel): PlainDiagnostic[] {
  const out: PlainDiagnostic[] = [];
  const reported = new Set<string>();
  const state = new Map<string, "visiting" | "done">();

  const groups = new Map<string, string[]>();
  for (const obj of model.objects.values()) {
    if (obj.isGroup()) {
      const childGroups = obj
        .getStringArray("children")
        .map((c) => c.value)
        .filter((uuid) => model.get(uuid)?.isGroup());
      groups.set(obj.uuid, childGroups);
    }
  }

  const visit = (uuid: string): void => {
    state.set(uuid, "visiting");
    for (const child of groups.get(uuid) ?? []) {
      const childState = state.get(child);
      if (childState === "visiting") {
        // Back edge -> cycle. Report at the child group's definition.
        if (!reported.has(child)) {
          reported.add(child);
          const node = model.get(child);
          if (node) {
            out.push({
              code: "circular-group",
              severity: "error",
              message: `Circular group reference detected at '${node.displayName()}'.`,
              start: node.keyToken.start,
              end: node.keyToken.end
            });
          }
        }
      } else if (childState === undefined) {
        visit(child);
      }
    }
    state.set(uuid, "done");
  };

  for (const uuid of groups.keys()) {
    if (!state.has(uuid)) {
      visit(uuid);
    }
  }
  return out;
}

/** The project and every target should own a build-configuration list. */
export function brokenConfigurationRule(model: PbxModel): PlainDiagnostic[] {
  const out: PlainDiagnostic[] = [];

  const check = (obj: ReturnType<PbxModel["project"]>, label: string): void => {
    if (!obj) {
      return;
    }
    const listUuid = obj.getString("buildConfigurationList");
    if (!listUuid) {
      out.push({
        code: "broken-configuration",
        severity: "warning",
        message: `${label} has no buildConfigurationList.`,
        start: obj.keyToken.start,
        end: obj.keyToken.end
      });
      return;
    }
    const list = model.get(listUuid);
    if (list && list.getStringArray("buildConfigurations").length === 0) {
      out.push({
        code: "broken-configuration",
        severity: "warning",
        message: `${label} has an empty buildConfigurationList.`,
        start: obj.keyToken.start,
        end: obj.keyToken.end
      });
    }
  };

  check(model.project(), "Project");
  for (const target of model.targets()) {
    check(target, `Target '${target.displayName()}'`);
  }
  return out;
}
