import {
  ArrayItem,
  ArrayNode,
  DictEntry,
  DictNode,
  DocumentNode,
  StringNode,
  Token,
  TokenType,
  ValueNode
} from "./ast";
import { decodeQuoted, tokenize } from "./tokenizer";

export class ParseError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
    this.name = "ParseError";
  }
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new ParseError(
        `Expected '${type}' but found '${tok.type}'${tok.text ? ` (${JSON.stringify(tok.text)})` : ""}`,
        tok.start
      );
    }
    return this.next();
  }

  parseDocument(): DocumentNode {
    const root = this.parseValue();
    const eof = this.expect(TokenType.EOF);
    return { kind: "document", root, eof };
  }

  private parseValue(): ValueNode {
    const tok = this.peek();
    switch (tok.type) {
      case TokenType.LBrace:
        return this.parseDict();
      case TokenType.LParen:
        return this.parseArray();
      case TokenType.String:
      case TokenType.QuotedString:
        return this.parseString();
      default:
        throw new ParseError(`Unexpected token '${tok.type}' while parsing a value`, tok.start);
    }
  }

  private parseString(): StringNode {
    const tok = this.next();
    if (tok.type === TokenType.QuotedString) {
      return { kind: "string", token: tok, value: decodeQuoted(tok.text), quoted: true };
    }
    if (tok.type === TokenType.String) {
      return { kind: "string", token: tok, value: tok.text, quoted: false };
    }
    throw new ParseError(`Expected a string but found '${tok.type}'`, tok.start);
  }

  private parseDict(): DictNode {
    const open = this.expect(TokenType.LBrace);
    const entries: DictEntry[] = [];
    while (this.peek().type !== TokenType.RBrace) {
      if (this.peek().type === TokenType.EOF) {
        throw new ParseError("Unterminated dictionary (missing '}')", this.peek().start);
      }
      const key = this.parseString();
      const equals = this.expect(TokenType.Equals);
      const value = this.parseValue();
      const semicolon = this.expect(TokenType.Semicolon);
      entries.push({ key, equals, value, semicolon });
    }
    const close = this.expect(TokenType.RBrace);
    return { kind: "dict", open, entries, close };
  }

  private parseArray(): ArrayNode {
    const open = this.expect(TokenType.LParen);
    const items: ArrayItem[] = [];
    while (this.peek().type !== TokenType.RParen) {
      if (this.peek().type === TokenType.EOF) {
        throw new ParseError("Unterminated array (missing ')')", this.peek().start);
      }
      const value = this.parseValue();
      let comma: Token | undefined;
      if (this.peek().type === TokenType.Comma) {
        comma = this.next();
      }
      items.push({ value, comma });
      if (!comma) {
        // No comma: the next token must close the array.
        break;
      }
    }
    const close = this.expect(TokenType.RParen);
    return { kind: "array", open, items, close };
  }
}

/** Parses `.pbxproj` source into a lossless CST. */
export function parse(src: string): DocumentNode {
  return new Parser(tokenize(src)).parseDocument();
}
