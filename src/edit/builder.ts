import * as crypto from "crypto";
import { ArrayNode, DictEntry, DictNode, StringNode, Token, TokenType, ValueNode } from "../parser/ast";

/**
 * Constructors for new CST nodes used when mutating a project. Trivia is set to
 * mirror Xcode's canonical formatting (tab indentation, inline file refs/build
 * files, multi-line groups) so additions produce readable diffs. Offsets are 0:
 * they are irrelevant to serialization and are recomputed on the next re-parse.
 */

function t(type: TokenType, text: string, leadingTrivia = ""): Token {
  return { type, text, leadingTrivia, start: 0, end: 0 };
}

/** Public token constructor (offsets are 0; only text + trivia matter). */
export function tok(type: TokenType, text: string, leadingTrivia = ""): Token {
  return t(type, text, leadingTrivia);
}

const BAREWORD_SAFE = /^[A-Za-z0-9_.\/]+$/;

/** Builds a string node, quoting + escaping when Xcode would. */
export function makeString(value: string, leadingTrivia = ""): StringNode {
  if (value.length > 0 && BAREWORD_SAFE.test(value)) {
    return { kind: "string", token: t(TokenType.String, value, leadingTrivia), value, quoted: false };
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return {
    kind: "string",
    token: t(TokenType.QuotedString, `"${escaped}"`, leadingTrivia),
    value,
    quoted: true
  };
}

/** Rewrites a string node's value in place, re-quoting as needed. */
export function setStringValue(node: StringNode, value: string): void {
  const rebuilt = makeString(value);
  node.token.text = rebuilt.token.text;
  node.token.type = rebuilt.token.type;
  node.value = value;
  node.quoted = rebuilt.quoted;
}

function setLeading(node: ValueNode, leading: string): void {
  if (node.kind === "string") {
    node.token.leadingTrivia = leading;
  } else {
    node.open.leadingTrivia = leading;
  }
}

export interface ArrayEntry {
  value: string;
  annotation?: string;
}

/** Builds an array node with the given item / close indentation. */
export function makeArray(entries: ArrayEntry[], itemIndent: string, closeIndent: string): ArrayNode {
  const items = entries.map((e) => ({
    value: makeString(e.value, itemIndent) as ValueNode,
    comma: t(TokenType.Comma, ",", e.annotation ? ` /* ${e.annotation} */` : "")
  }));
  return {
    kind: "array",
    open: t(TokenType.LParen, "(", " "),
    items,
    close: t(TokenType.RParen, ")", closeIndent)
  };
}

export interface FieldSpec {
  key: string;
  value: ValueNode | string;
  /** Comment placed between the value and its terminator: `value /* annotation *\/;` */
  annotation?: string;
}

function makeValue(value: ValueNode | string, leading: string): ValueNode {
  if (typeof value === "string") {
    return makeString(value, leading);
  }
  setLeading(value, leading);
  return value;
}

/** Builds an inline dict: `{isa = X; a = b; }` (used for file refs / build files). */
export function inlineDict(fields: FieldSpec[]): DictNode {
  const entries: DictEntry[] = fields.map((f, i) => ({
    key: makeString(f.key, i === 0 ? "" : " "),
    equals: t(TokenType.Equals, "=", " "),
    value: makeValue(f.value, " "),
    semicolon: t(TokenType.Semicolon, ";", f.annotation ? ` /* ${f.annotation} */` : "")
  }));
  return { kind: "dict", open: t(TokenType.LBrace, "{", " "), entries, close: t(TokenType.RBrace, "}", " ") };
}

const FIELD_INDENT = "\n\t\t\t";
const CLOSE_INDENT = "\n\t\t";

/** Builds a multi-line object dict indented as a top-level `objects` member. */
export function multilineDict(fields: FieldSpec[]): DictNode {
  const entries: DictEntry[] = fields.map((f) => ({
    key: makeString(f.key, FIELD_INDENT),
    equals: t(TokenType.Equals, "=", " "),
    value: makeValue(f.value, " "),
    semicolon: t(TokenType.Semicolon, ";", f.annotation ? ` /* ${f.annotation} */` : "")
  }));
  return {
    kind: "dict",
    open: t(TokenType.LBrace, "{", " "),
    entries,
    close: t(TokenType.RBrace, "}", CLOSE_INDENT)
  };
}

/** Builds a top-level `objects` entry: `UUID /* name *\/ = <dict>;`. */
export function makeObjectEntry(uuid: string, dict: DictNode, annotation?: string): DictEntry {
  return {
    key: makeString(uuid, "\n\t\t"),
    equals: t(TokenType.Equals, "=", annotation ? ` /* ${annotation} */ ` : " "),
    value: dict,
    semicolon: t(TokenType.Semicolon, ";", "")
  };
}

/** Appends a UUID (with optional annotation) as a new array item. */
export function pushArrayItem(array: ArrayNode, value: string, annotation?: string): void {
  const itemIndent = itemIndentFor(array);
  array.items.push({
    value: makeString(value, itemIndent),
    comma: t(TokenType.Comma, ",", annotation ? ` /* ${annotation} */` : "")
  });
}

/** Removes the array item(s) whose string value matches. Returns true if any removed. */
export function removeArrayItem(array: ArrayNode, value: string): boolean {
  const before = array.items.length;
  array.items = array.items.filter((it) => !(it.value.kind === "string" && it.value.value === value));
  return array.items.length !== before;
}

/** Indentation for entries added to an existing (possibly empty) dict. */
export function dictFieldIndent(dict: DictNode, fallback = " "): string {
  if (dict.entries.length > 0) {
    return dict.entries[dict.entries.length - 1].key.token.leadingTrivia || " ";
  }
  if (dict.close.leadingTrivia.includes("\n")) {
    return dict.close.leadingTrivia + "\t";
  }
  return fallback;
}

/** Insertion index keeping keys alphabetical, with `isa` pinned first. */
function sortedInsertIndex(dict: DictNode, key: string): number {
  for (let i = 0; i < dict.entries.length; i++) {
    const existing = dict.entries[i].key.value;
    if (existing === "isa") {
      continue;
    }
    if (key.localeCompare(existing) < 0) {
      return i;
    }
  }
  return dict.entries.length;
}

/** Sets (or inserts, keeping keys sorted) a value entry in a dict. */
export function setDictValue(dict: DictNode, key: string, value: ValueNode): void {
  const existing = dict.entries.find((e) => e.key.value === key);
  if (existing) {
    setLeading(value, existing.value.kind === "string" ? existing.value.token.leadingTrivia : " ");
    existing.value = value;
    return;
  }
  const indent = dictFieldIndent(dict);
  setLeading(value, " ");
  const entry: DictEntry = {
    key: makeString(key, indent),
    equals: t(TokenType.Equals, "=", " "),
    value,
    semicolon: t(TokenType.Semicolon, ";", "")
  };
  dict.entries.splice(sortedInsertIndex(dict, key), 0, entry);
}

/** Sets (or inserts) a string entry in a dict. */
export function setDictString(dict: DictNode, key: string, value: string): void {
  const existing = dict.entries.find((e) => e.key.value === key);
  if (existing && existing.value.kind === "string") {
    setStringValue(existing.value, value);
    return;
  }
  setDictValue(dict, key, makeString(value));
}

/** Removes a dict entry by key. Returns true when something was removed. */
export function removeDictEntry(dict: DictNode, key: string): boolean {
  const before = dict.entries.length;
  dict.entries = dict.entries.filter((e) => e.key.value !== key);
  return dict.entries.length !== before;
}

/** Indentation for items added to an existing (possibly empty) array. */
export function itemIndentFor(array: ArrayNode): string {
  if (array.items.length > 0) {
    const lead = array.items[0].value.kind === "string"
      ? array.items[0].value.token.leadingTrivia
      : array.items[0].value.open.leadingTrivia;
    if (lead.includes("\n")) {
      return lead;
    }
  }
  if (array.close.leadingTrivia.includes("\n")) {
    return array.close.leadingTrivia + "\t";
  }
  return "\n\t\t\t\t";
}

/** Generates a 24-char uppercase-hex UUID absent from `used`. */
export function generateUuid(used: Set<string>): string {
  let uuid: string;
  do {
    uuid = crypto.randomBytes(12).toString("hex").toUpperCase();
  } while (used.has(uuid));
  used.add(uuid);
  return uuid;
}

export type FileCategory = "source" | "resource" | "header" | "framework";

const FILE_TYPES: Record<string, string> = {
  ".swift": "sourcecode.swift",
  ".h": "sourcecode.c.h",
  ".hpp": "sourcecode.cpp.h",
  ".hh": "sourcecode.cpp.h",
  ".m": "sourcecode.c.objc",
  ".mm": "sourcecode.cpp.objcpp",
  ".c": "sourcecode.c.c",
  ".cc": "sourcecode.cpp.cpp",
  ".cpp": "sourcecode.cpp.cpp",
  ".metal": "sourcecode.metal",
  ".plist": "text.plist.xml",
  ".json": "text.json",
  ".md": "net.daringfireball.markdown",
  ".storyboard": "file.storyboard",
  ".xib": "file.xib",
  ".xcassets": "folder.assetcatalog",
  ".png": "image.png",
  ".jpg": "image.jpeg",
  ".jpeg": "image.jpeg",
  ".pdf": "image.pdf",
  ".strings": "text.plist.strings",
  ".entitlements": "text.plist.entitlements",
  ".xcconfig": "text.xcconfig",
  ".sh": "text.script.sh",
  ".html": "text.html",
  ".framework": "wrapper.framework",
  ".a": "archive.ar"
};

const SOURCE_EXTS = new Set([".swift", ".m", ".mm", ".c", ".cc", ".cpp", ".metal"]);
const HEADER_EXTS = new Set([".h", ".hpp", ".hh"]);
const FRAMEWORK_EXTS = new Set([".framework", ".a", ".dylib", ".tbd"]);

export function fileTypeForExtension(ext: string): string | undefined {
  return FILE_TYPES[ext.toLowerCase()];
}

export function categoryForExtension(ext: string): FileCategory {
  const e = ext.toLowerCase();
  if (SOURCE_EXTS.has(e)) {
    return "source";
  }
  if (HEADER_EXTS.has(e)) {
    return "header";
  }
  if (FRAMEWORK_EXTS.has(e)) {
    return "framework";
  }
  return "resource";
}
