/**
 * Minimal XML element tree for Xcode's XML sidecar files (`.xcscheme`, …).
 * Pure (no `vscode` dependency) so it is unit-testable.
 *
 * The parser accepts the small XML subset Xcode writes (elements, attributes,
 * comments, an XML declaration — no text content, CDATA or namespaces). The
 * serializer emits Xcode's canonical style — 3-space indentation, one
 * attribute per line with ` = "value"` spacing — so files written by Xcode
 * round-trip byte-for-byte.
 */

export interface XmlElement {
  readonly name: string;
  /** Attributes in document order (order is preserved on serialize). */
  readonly attrs: [string, string][];
  readonly children: XmlElement[];
}

export function makeElement(name: string, attrs: [string, string][] = []): XmlElement {
  return { name, attrs, children: [] };
}

export function getAttr(el: XmlElement, name: string): string | undefined {
  return el.attrs.find(([key]) => key === name)?.[1];
}

/** Sets an attribute, keeping its position; new attributes append at the end. */
export function setAttr(el: XmlElement, name: string, value: string): void {
  const existing = el.attrs.find(([key]) => key === name);
  if (existing) {
    existing[1] = value;
  } else {
    el.attrs.push([name, value]);
  }
}

export function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

/** All descendants (depth-first) named `name`. */
export function findAll(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === name) {
        out.push(child);
      }
      walk(child);
    }
  };
  walk(el);
  return out;
}

const TAG_RE =
  /<\?[^>]*\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ATTR_RE = /([\w.-]+)\s*=\s*"([^"]*)"/g;

export function decodeXml(text: string): string {
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

export function encodeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class XmlDoc {
  constructor(public readonly root: XmlElement) {}

  static parse(text: string): XmlDoc {
    let root: XmlElement | undefined;
    const stack: XmlElement[] = [];

    for (const match of text.matchAll(TAG_RE)) {
      const [, closingSlash, name, attrText, selfSlash] = match;
      if (name === undefined) {
        continue; // XML declaration or comment
      }
      if (closingSlash === "/") {
        if (stack.length === 0 || stack[stack.length - 1].name !== name) {
          throw new Error(`Mismatched closing tag </${name}>`);
        }
        stack.pop();
        continue;
      }
      const attrs: [string, string][] = [];
      if (attrText) {
        for (const attr of attrText.matchAll(ATTR_RE)) {
          attrs.push([attr[1], decodeXml(attr[2])]);
        }
      }
      const el: XmlElement = { name, attrs, children: [] };
      if (stack.length === 0) {
        if (root) {
          throw new Error(`Multiple root elements: <${root.name}> and <${name}>`);
        }
        root = el;
      } else {
        stack[stack.length - 1].children.push(el);
      }
      if (selfSlash !== "/") {
        stack.push(el);
      }
    }

    if (!root) {
      throw new Error("No root element found");
    }
    if (stack.length > 0) {
      throw new Error(`Unclosed element <${stack[stack.length - 1].name}>`);
    }
    return new XmlDoc(root);
  }

  /** Serializes in Xcode's style; matches Xcode-written files byte-for-byte. */
  serialize(): string {
    const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
    serializeElement(this.root, 0, lines);
    return lines.join("\n") + "\n";
  }
}

function serializeElement(el: XmlElement, depth: number, lines: string[]): void {
  const indent = "   ".repeat(depth);
  if (el.attrs.length === 0) {
    lines.push(`${indent}<${el.name}>`);
  } else {
    lines.push(`${indent}<${el.name}`);
    el.attrs.forEach(([key, value], i) => {
      const end = i === el.attrs.length - 1 ? ">" : "";
      lines.push(`${indent}   ${key} = "${encodeXml(value)}"${end}`);
    });
  }
  for (const child of el.children) {
    serializeElement(child, depth + 1, lines);
  }
  lines.push(`${indent}</${el.name}>`);
}
