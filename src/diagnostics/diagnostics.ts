import * as vscode from "vscode";
import { PlainDiagnostic } from "../linter/linter";
import { LineMap } from "../utils/position";

/** Converts pure offset-based diagnostics into VS Code diagnostics. */
export function toVscodeDiagnostics(text: string, plain: PlainDiagnostic[]): vscode.Diagnostic[] {
  const map = new LineMap(text);
  return plain.map((p) => {
    const s = map.positionAt(p.start);
    const e = map.positionAt(p.end);
    const range = new vscode.Range(s.line, s.character, e.line, e.character);
    const severity =
      p.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(range, p.message, severity);
    diagnostic.code = p.code;
    diagnostic.source = "pbxproj";
    return diagnostic;
  });
}
