/**
 * Concrete syntax tree (CST) for the OpenStep ASCII property list used by
 * Xcode `.pbxproj` files.
 *
 * Design goal: **exact round-trip**. Every byte of the original source is either
 * a token's own text or the leading trivia (whitespace + comments) attached to a
 * token. Serializing the tree by concatenating, in order, each token's
 * `leadingTrivia + text` reproduces the input verbatim. Comments are therefore
 * NOT modelled as nodes — they live inside trivia and are preserved for free.
 */

export enum TokenType {
  LBrace = "{",
  RBrace = "}",
  LParen = "(",
  RParen = ")",
  Equals = "=",
  Semicolon = ";",
  Comma = ",",
  String = "string",
  QuotedString = "quoted-string",
  EOF = "eof"
}

export interface Token {
  type: TokenType;
  /** Raw text of the token (for quoted strings this INCLUDES the quotes). */
  text: string;
  /** Whitespace and/or comments immediately preceding `text`. */
  leadingTrivia: string;
  /** Offset (into the source string) where `text` starts. */
  start: number;
  /** Offset where `text` ends (exclusive). */
  end: number;
}

export type ValueNode = DictNode | ArrayNode | StringNode;

export interface StringNode {
  kind: "string";
  token: Token;
  /** Decoded value (unquoted, unescaped). For barewords this equals the text. */
  value: string;
  quoted: boolean;
}

export interface DictEntry {
  key: StringNode;
  equals: Token;
  value: ValueNode;
  semicolon: Token;
}

export interface DictNode {
  kind: "dict";
  open: Token;
  entries: DictEntry[];
  close: Token;
}

export interface ArrayItem {
  value: ValueNode;
  /** Every array item in Xcode output is comma-terminated, but be lenient. */
  comma?: Token;
}

export interface ArrayNode {
  kind: "array";
  open: Token;
  items: ArrayItem[];
  close: Token;
}

export interface DocumentNode {
  kind: "document";
  root: ValueNode;
  /** The EOF token; carries any trailing whitespace as its leadingTrivia. */
  eof: Token;
}

/** Source range of a value node, spanning its first token through its last. */
export function valueRange(node: ValueNode): { start: number; end: number } {
  switch (node.kind) {
    case "string":
      return { start: node.token.start, end: node.token.end };
    case "dict":
      return { start: node.open.start, end: node.close.end };
    case "array":
      return { start: node.open.start, end: node.close.end };
  }
}
