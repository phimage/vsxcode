import { Token, TokenType } from "./ast";

export class TokenizeError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
    this.name = "TokenizeError";
  }
}

const STRUCTURAL: Record<string, TokenType> = {
  "{": TokenType.LBrace,
  "}": TokenType.RBrace,
  "(": TokenType.LParen,
  ")": TokenType.RParen,
  "=": TokenType.Equals,
  ";": TokenType.Semicolon,
  ",": TokenType.Comma
};

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/**
 * A character is a valid bareword (unquoted string) character when it is not
 * whitespace, not a structural delimiter, and not a quote. `/` IS allowed so
 * that unquoted paths like `Sources/App.swift` tokenize as one string; comment
 * detection only happens while scanning trivia (before a token begins), so a `/`
 * mid-bareword never starts a comment.
 */
function isBarewordChar(ch: string): boolean {
  if (isWhitespace(ch)) {
    return false;
  }
  if (ch === '"' || ch === "{" || ch === "}" || ch === "(" || ch === ")" || ch === "=" || ch === ";" || ch === ",") {
    return false;
  }
  return true;
}

/**
 * Tokenizes an OpenStep property list. Whitespace and comments are accumulated
 * into each token's `leadingTrivia`; the final EOF token carries any trailing
 * trivia. This guarantees a lossless round-trip.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const readTrivia = (): string => {
    const start = i;
    while (i < n) {
      const ch = src[i];
      if (isWhitespace(ch)) {
        i++;
        continue;
      }
      if (ch === "/" && src[i + 1] === "/") {
        // Line comment: run to end of line (newline stays as whitespace trivia).
        i += 2;
        while (i < n && src[i] !== "\n") {
          i++;
        }
        continue;
      }
      if (ch === "/" && src[i + 1] === "*") {
        // Block comment.
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          i++;
        }
        if (i >= n) {
          throw new TokenizeError("Unterminated block comment", start);
        }
        i += 2; // consume closing */
        continue;
      }
      break;
    }
    return src.slice(start, i);
  };

  while (i < n) {
    const leadingTrivia = readTrivia();
    if (i >= n) {
      tokens.push({ type: TokenType.EOF, text: "", leadingTrivia, start: i, end: i });
      return tokens;
    }

    const ch = src[i];
    const structural = STRUCTURAL[ch];
    if (structural) {
      tokens.push({ type: structural, text: ch, leadingTrivia, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2; // skip escaped char
          continue;
        }
        if (src[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      if (i > n || src[i - 1] !== '"') {
        throw new TokenizeError("Unterminated quoted string", start);
      }
      tokens.push({
        type: TokenType.QuotedString,
        text: src.slice(start, i),
        leadingTrivia,
        start,
        end: i
      });
      continue;
    }

    // Bareword string.
    const start = i;
    while (i < n && isBarewordChar(src[i])) {
      i += 1;
    }
    if (i === start) {
      throw new TokenizeError(`Unexpected character ${JSON.stringify(ch)}`, i);
    }
    tokens.push({
      type: TokenType.String,
      text: src.slice(start, i),
      leadingTrivia,
      start,
      end: i
    });
  }

  // Reached here only if src is empty or ended exactly at a token boundary.
  tokens.push({ type: TokenType.EOF, text: "", leadingTrivia: "", start: i, end: i });
  return tokens;
}

/** Decodes a quoted-string token text (with surrounding quotes) into its value. */
export function decodeQuoted(text: string): string {
  const inner = text.slice(1, -1);
  let out = "";
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[j + 1];
    switch (next) {
      case "n":
        out += "\n";
        j++;
        break;
      case "t":
        out += "\t";
        j++;
        break;
      case "r":
        out += "\r";
        j++;
        break;
      case '"':
        out += '"';
        j++;
        break;
      case "\\":
        out += "\\";
        j++;
        break;
      case "U": {
        const hex = inner.slice(j + 2, j + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          j += 5;
        } else {
          out += next;
          j++;
        }
        break;
      }
      default:
        out += next ?? "";
        j++;
        break;
    }
  }
  return out;
}
