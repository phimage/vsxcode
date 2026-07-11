import * as vscode from "vscode";

/**
 * Decorates tree nodes (and file-explorer entries) for referenced files that are
 * missing on disk, with a red badge + tooltip. The set of missing URIs is
 * refreshed after each lint pass.
 */
export class PbxDecorationProvider implements vscode.FileDecorationProvider {
  private missing = new Set<string>();

  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  setMissing(uris: vscode.Uri[]): void {
    const next = new Set(uris.map((u) => u.toString()));
    // Fire for the union of previous + new so cleared decorations refresh too.
    const changed: vscode.Uri[] = [];
    for (const key of new Set([...this.missing, ...next])) {
      if (this.missing.has(key) !== next.has(key)) {
        changed.push(vscode.Uri.parse(key));
      }
    }
    this.missing = next;
    if (changed.length > 0) {
      this.emitter.fire(changed);
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.missing.has(uri.toString())) {
      return {
        badge: "!",
        color: new vscode.ThemeColor("list.errorForeground"),
        tooltip: "File is referenced by the project but missing on disk"
      };
    }
    return undefined;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
