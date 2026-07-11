import { ArrayNode, DictNode, DocumentNode, StringNode, Token, ValueNode } from "../parser/ast";

function emitToken(tok: Token): string {
  return tok.leadingTrivia + tok.text;
}

function emitString(node: StringNode): string {
  return emitToken(node.token);
}

function emitDict(node: DictNode): string {
  let out = emitToken(node.open);
  for (const entry of node.entries) {
    out += emitString(entry.key);
    out += emitToken(entry.equals);
    out += emitValue(entry.value);
    out += emitToken(entry.semicolon);
  }
  out += emitToken(node.close);
  return out;
}

function emitArray(node: ArrayNode): string {
  let out = emitToken(node.open);
  for (const item of node.items) {
    out += emitValue(item.value);
    if (item.comma) {
      out += emitToken(item.comma);
    }
  }
  out += emitToken(node.close);
  return out;
}

function emitValue(node: ValueNode): string {
  switch (node.kind) {
    case "string":
      return emitString(node);
    case "dict":
      return emitDict(node);
    case "array":
      return emitArray(node);
  }
}

/**
 * Serializes a CST back to text. For an unmodified tree this is byte-exact with
 * the original source (see roundtrip tests).
 */
export function serialize(doc: DocumentNode): string {
  return emitValue(doc.root) + emitToken(doc.eof);
}
