import * as vscode from "vscode";
import { PbxModel } from "../model/pbxProject";
import { PbxObject } from "../model/types";

/** Provides an outline of the `.pbxproj`: one node per isa section, objects beneath. */
export class PbxDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    let model: PbxModel;
    try {
      model = PbxModel.parse(document.getText());
    } catch {
      return [];
    }

    const sections = new Map<string, PbxObject[]>();
    for (const obj of model.objects.values()) {
      const isa = obj.isa ?? "(unknown)";
      const list = sections.get(isa) ?? [];
      list.push(obj);
      sections.set(isa, list);
    }

    const symbols: vscode.DocumentSymbol[] = [];
    for (const isa of [...sections.keys()].sort()) {
      const members = sections.get(isa)!;
      let min = Number.MAX_SAFE_INTEGER;
      let max = 0;
      const children: vscode.DocumentSymbol[] = [];
      for (const obj of members) {
        const start = obj.keyToken.start;
        const end = obj.dict.close.end;
        min = Math.min(min, start);
        max = Math.max(max, end);
        const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
        const selection = new vscode.Range(
          document.positionAt(obj.keyToken.start),
          document.positionAt(obj.keyToken.end)
        );
        children.push(
          new vscode.DocumentSymbol(
            obj.displayName(),
            obj.uuid,
            symbolKindFor(obj),
            range,
            selection
          )
        );
      }
      children.sort((a, b) => a.range.start.compareTo(b.range.start));
      const sectionRange = new vscode.Range(document.positionAt(min), document.positionAt(max));
      const section = new vscode.DocumentSymbol(
        isa,
        `${members.length}`,
        vscode.SymbolKind.Namespace,
        sectionRange,
        sectionRange
      );
      section.children = children;
      symbols.push(section);
    }
    return symbols;
  }
}

function symbolKindFor(obj: PbxObject): vscode.SymbolKind {
  if (obj.isGroup()) {
    return vscode.SymbolKind.Package;
  }
  if (obj.isTarget()) {
    return vscode.SymbolKind.Class;
  }
  switch (obj.isa) {
    case "PBXFileReference":
      return vscode.SymbolKind.File;
    case "XCBuildConfiguration":
      return vscode.SymbolKind.Constant;
    default:
      return vscode.SymbolKind.Object;
  }
}
