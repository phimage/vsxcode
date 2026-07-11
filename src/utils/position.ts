/** Zero-based line/character position (matching VS Code's `Position`). */
export interface LineChar {
  line: number;
  character: number;
}

/**
 * Maps byte offsets to line/character positions. Pure (no `vscode`) so it can be
 * used both by the diagnostics layer and by unit tests.
 */
export class LineMap {
  private readonly lineStarts: number[] = [0];

  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        this.lineStarts.push(i + 1);
      }
    }
  }

  positionAt(offset: number): LineChar {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo, character: clamped - this.lineStarts[lo] };
  }
}
