import * as path from "path";

/**
 * Model for the `contents.xcworkspacedata` XML file inside an `.xcworkspace`
 * bundle. Pure (no `vscode` dependency) so it is unit-testable.
 *
 * The format is a small XML dialect:
 *
 * ```xml
 * <?xml version="1.0" encoding="UTF-8"?>
 * <Workspace version = "1.0">
 *    <FileRef location = "group:App/App.xcodeproj"></FileRef>
 *    <Group location = "group:Shared" name = "Shared">
 *       <FileRef location = "group:Notes.md"></FileRef>
 *    </Group>
 * </Workspace>
 * ```
 */

/** Location prefixes selectable in Xcode for workspace items. */
export const WS_LOCATION_PREFIXES = ["group", "container", "absolute", "developer", "self"] as const;

export interface XcFileRef {
  readonly kind: "fileRef";
  /** Stable within one parsed snapshot (document order); regenerated on reload. */
  readonly id: string;
  location: string;
}

export interface XcGroup {
  readonly kind: "group";
  readonly id: string;
  location: string;
  name?: string;
  readonly children: XcWorkspaceItem[];
}

export type XcWorkspaceItem = XcFileRef | XcGroup;

/** Splits `"group:App/App.xcodeproj"` into prefix and path. */
export function splitLocation(location: string): { prefix: string; path: string } {
  const idx = location.indexOf(":");
  if (idx < 0) {
    return { prefix: "group", path: location };
  }
  return { prefix: location.slice(0, idx), path: location.slice(idx + 1) };
}

/**
 * Resolves one location against the enclosing group's directory (`groupDir`)
 * and the directory containing the `.xcworkspace` bundle (`containerDir`).
 * Returns `null` for locations that cannot be resolved on the filesystem
 * (`developer:`, `self:`, unknown prefixes).
 */
export function resolveLocation(
  location: string,
  groupDir: string,
  containerDir: string
): string | null {
  const { prefix, path: p } = splitLocation(location);
  switch (prefix) {
    case "group":
      return path.resolve(groupDir, p);
    case "container":
      return path.resolve(containerDir, p);
    case "absolute":
      return path.resolve(p);
    default:
      return null;
  }
}

interface ParsedTag {
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
}

const TAG_RE =
  /<\?[^>]*\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ATTR_RE = /([\w.-]+)\s*=\s*"([^"]*)"/g;

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = entity.startsWith("#x")
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        return Number.isNaN(code) ? `&${entity};` : String.fromCodePoint(code);
      }
    }
  });
}

function encodeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Parsed, editable `contents.xcworkspacedata` document. */
export class XcWorkspaceData {
  private counter = 0;

  private constructor(
    public version: string,
    public readonly items: XcWorkspaceItem[]
  ) {}

  static empty(): XcWorkspaceData {
    return new XcWorkspaceData("1.0", []);
  }

  static parse(text: string): XcWorkspaceData {
    const data = new XcWorkspaceData("1.0", []);
    const stack: XcWorkspaceItem[][] = [data.items];
    let sawWorkspace = false;

    for (const match of text.matchAll(TAG_RE)) {
      const [full, closingSlash, name, attrText, selfSlash] = match;
      if (name === undefined) {
        continue; // XML declaration or comment
      }
      const tag: ParsedTag = {
        name,
        attrs: {},
        closing: closingSlash === "/",
        selfClosing: selfSlash === "/"
      };
      if (!tag.closing && attrText) {
        for (const attr of attrText.matchAll(ATTR_RE)) {
          tag.attrs[attr[1]] = decodeXml(attr[2]);
        }
      }

      switch (tag.name) {
        case "Workspace":
          if (tag.closing) {
            break;
          }
          sawWorkspace = true;
          data.version = tag.attrs["version"] ?? "1.0";
          break;
        case "FileRef": {
          if (tag.closing) {
            break;
          }
          const ref: XcFileRef = {
            kind: "fileRef",
            id: data.nextId(),
            location: tag.attrs["location"] ?? ""
          };
          stack[stack.length - 1].push(ref);
          break;
        }
        case "Group": {
          if (tag.closing) {
            if (stack.length > 1) {
              stack.pop();
            }
            break;
          }
          const group: XcGroup = {
            kind: "group",
            id: data.nextId(),
            location: tag.attrs["location"] ?? "",
            name: tag.attrs["name"],
            children: []
          };
          stack[stack.length - 1].push(group);
          if (!tag.selfClosing) {
            stack.push(group.children);
          }
          break;
        }
        default:
          throw new Error(`Unexpected element <${tag.name}> in workspace data: ${full.trim()}`);
      }
    }

    if (!sawWorkspace) {
      throw new Error("Not a workspace document: missing <Workspace> root element");
    }
    return data;
  }

  /** Serializes in Xcode's style: 3-space indent, attributes on their own lines. */
  serialize(): string {
    const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<Workspace", `   version = "${encodeXml(this.version)}">`];
    for (const item of this.items) {
      this.serializeItem(item, 1, lines);
    }
    lines.push("</Workspace>");
    return lines.join("\n") + "\n";
  }

  private serializeItem(item: XcWorkspaceItem, depth: number, lines: string[]): void {
    const indent = "   ".repeat(depth);
    if (item.kind === "fileRef") {
      lines.push(`${indent}<FileRef`, `${indent}   location = "${encodeXml(item.location)}">`, `${indent}</FileRef>`);
      return;
    }
    lines.push(`${indent}<Group`);
    if (item.name !== undefined) {
      lines.push(
        `${indent}   location = "${encodeXml(item.location)}"`,
        `${indent}   name = "${encodeXml(item.name)}">`
      );
    } else {
      lines.push(`${indent}   location = "${encodeXml(item.location)}">`);
    }
    for (const child of item.children) {
      this.serializeItem(child, depth + 1, lines);
    }
    lines.push(`${indent}</Group>`);
  }

  // --- lookup ----------------------------------------------------------------

  get(id: string): XcWorkspaceItem | undefined {
    return this.chainTo(id)?.at(-1);
  }

  /** Containing group of `id`, or `null` when the item sits at the root. */
  parentOf(id: string): XcGroup | null | undefined {
    const chain = this.chainTo(id);
    if (!chain) {
      return undefined;
    }
    const parent = chain.at(-2);
    return parent === undefined ? null : (parent as XcGroup);
  }

  /** Items from the root down to (and including) `id`. */
  private chainTo(id: string): XcWorkspaceItem[] | undefined {
    const walk = (items: XcWorkspaceItem[], trail: XcWorkspaceItem[]): XcWorkspaceItem[] | undefined => {
      for (const item of items) {
        const next = [...trail, item];
        if (item.id === id) {
          return next;
        }
        if (item.kind === "group") {
          const found = walk(item.children, next);
          if (found) {
            return found;
          }
        }
      }
      return undefined;
    };
    return walk(this.items, []);
  }

  /** All file references, in document order (recursing into groups). */
  allFileRefs(): XcFileRef[] {
    const out: XcFileRef[] = [];
    const walk = (items: XcWorkspaceItem[]): void => {
      for (const item of items) {
        if (item.kind === "fileRef") {
          out.push(item);
        } else {
          walk(item.children);
        }
      }
    };
    walk(this.items);
    return out;
  }

  /**
   * Absolute filesystem path of an item, or `null` when not resolvable.
   * `containerDir` is the directory containing the `.xcworkspace` bundle.
   */
  resolveItem(id: string, containerDir: string): string | null {
    const chain = this.chainTo(id);
    if (!chain) {
      return null;
    }
    let groupDir = containerDir;
    for (let i = 0; i < chain.length; i++) {
      const resolved = resolveLocation(chain[i].location, groupDir, containerDir);
      if (i === chain.length - 1) {
        return resolved;
      }
      // Children of an unresolvable group resolve against the inherited dir.
      groupDir = resolved ?? groupDir;
    }
    return null;
  }

  /** Directory that `group:` locations of children of `parentId` resolve against. */
  baseDirFor(parentId: string | null, containerDir: string): string {
    if (parentId === null) {
      return containerDir;
    }
    return this.resolveItem(parentId, containerDir) ?? containerDir;
  }

  // --- edits -----------------------------------------------------------------

  addFileRef(parentId: string | null, location: string): XcFileRef {
    const ref: XcFileRef = { kind: "fileRef", id: this.nextId(), location };
    this.childrenOf(parentId).push(ref);
    return ref;
  }

  addGroup(parentId: string | null, location: string, name?: string): XcGroup {
    const group: XcGroup = { kind: "group", id: this.nextId(), location, name, children: [] };
    this.childrenOf(parentId).push(group);
    return group;
  }

  remove(id: string): boolean {
    const parent = this.parentOf(id);
    if (parent === undefined) {
      return false;
    }
    const list = parent === null ? this.items : parent.children;
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) {
      return false;
    }
    list.splice(index, 1);
    return true;
  }

  setLocation(id: string, location: string): boolean {
    const item = this.get(id);
    if (!item || item.location === location) {
      return false;
    }
    item.location = location;
    return true;
  }

  /** Sets a group's display name; an empty name removes the attribute. */
  setName(id: string, name: string): boolean {
    const item = this.get(id);
    if (!item || item.kind !== "group") {
      return false;
    }
    const next = name.trim() === "" ? undefined : name.trim();
    if (item.name === next) {
      return false;
    }
    item.name = next;
    return true;
  }

  private childrenOf(parentId: string | null): XcWorkspaceItem[] {
    if (parentId === null) {
      return this.items;
    }
    const parent = this.get(parentId);
    if (!parent || parent.kind !== "group") {
      throw new Error(`Not a workspace group: ${parentId}`);
    }
    return parent.children;
  }

  private nextId(): string {
    return `ws${this.counter++}`;
  }
}

/** Display name of a workspace item, as shown in the navigator. */
export function wsItemDisplayName(item: XcWorkspaceItem): string {
  if (item.kind === "group" && item.name) {
    return item.name;
  }
  const p = splitLocation(item.location).path;
  const base = path.basename(p);
  return base !== "" ? base : item.kind === "group" ? "Group" : item.location;
}

/**
 * True for paths inside an `.xcodeproj` bundle, e.g. the implicit
 * `Foo.xcodeproj/project.xcworkspace/…` — those are not real workspaces.
 */
export function isInsideXcodeproj(fsPath: string): boolean {
  return fsPath
    .split(/[\\/]/)
    .some((segment, i, all) => i < all.length - 1 && segment.toLowerCase().endsWith(".xcodeproj"));
}

/**
 * Preferred location string for a new reference to `absTarget` added under a
 * group whose directory is `baseDir`: `group:`-relative when both share a
 * filesystem root, absolute otherwise (e.g. different Windows drives).
 */
export function locationFor(absTarget: string, baseDir: string): string {
  const rel = path.relative(baseDir, absTarget);
  if (rel === "" || path.isAbsolute(rel)) {
    return `absolute:${absTarget}`;
  }
  // Locations always use forward slashes, even on Windows.
  return `group:${rel.split(path.sep).join("/")}`;
}
