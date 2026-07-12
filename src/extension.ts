import * as fs from "fs";
import * as vscode from "vscode";
import { registerEditCommands } from "./commands/edit";
import { registerWorkspaceEditCommands } from "./commands/workspaceEdit";
import { PbxDecorationProvider } from "./decorations/decorations";
import { toVscodeDiagnostics } from "./diagnostics/diagnostics";
import { lint } from "./linter/linter";
import { PbxInspectorViewProvider } from "./inspector/inspectorView";
import { PbxDocumentSymbolProvider } from "./providers/documentSymbols";
import { PbxDragAndDropController } from "./tree/dnd";
import { ProjectTreeProvider } from "./tree/projectTreeProvider";
import {
  FileTreeNode,
  GroupTreeNode,
  PbxTreeNode,
  ProjectTreeNode,
  WsFileRefTreeNode,
  WsGroupTreeNode
} from "./tree/nodes";
import { ProjectManager } from "./workspace/discovery";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manager = new ProjectManager();
  const treeProvider = new ProjectTreeProvider(manager);
  const decorations = new PbxDecorationProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection("pbxproj");

  // Persists new pbxproj text via a WorkspaceEdit when the file is open in an
  // editor (keeps undo history + dirty state consistent), else writes to disk.
  const saveText = async (uri: vscode.Uri, text: string): Promise<void> => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length));
      edit.replace(uri, fullRange, text);
      await vscode.workspace.applyEdit(edit);
      await open.save();
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
    }
  };

  const dnd = new PbxDragAndDropController({
    saveText,
    refresh: async () => {
      await refreshAll();
    }
  });

  const treeView = vscode.window.createTreeView("xcodeProjectExplorer", {
    treeDataProvider: treeProvider,
    dragAndDropController: dnd,
    canSelectMany: true,
    showCollapseAll: true
  });

  const inspector = new PbxInspectorViewProvider({
    saveText,
    refresh: async () => {
      await refreshAll();
    }
  });

  context.subscriptions.push(
    diagnostics,
    decorations,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.window.registerWebviewViewProvider(PbxInspectorViewProvider.viewId, inspector),
    treeView.onDidChangeSelection((e) => inspector.setNode(e.selection[0])),
    vscode.commands.registerCommand("pbx.showInspector", async (node?: PbxTreeNode) => {
      await vscode.commands.executeCommand(`${PbxInspectorViewProvider.viewId}.focus`);
      inspector.setNode(node ?? treeView.selection[0]);
    }),
    vscode.languages.registerDocumentSymbolProvider(
      { language: "pbxproj" },
      new PbxDocumentSymbolProvider()
    )
  );

  registerEditCommands(context, {
    saveText,
    refresh: async () => {
      await refreshAll();
    }
  });

  registerWorkspaceEditCommands(context, {
    saveText,
    refresh: async () => {
      await refreshAll();
    }
  });

  const refreshAll = async (): Promise<{ errors: number; warnings: number }> => {
    await manager.reload();
    treeProvider.refresh();

    diagnostics.clear();
    let errors = 0;
    let warnings = 0;
    for (const project of manager.getProjects()) {
      const plain = lint({
        model: project.model,
        projectRoot: project.projectRoot,
        fileExists: fs.existsSync
      });
      for (const d of plain) {
        if (d.severity === "error") {
          errors++;
        } else {
          warnings++;
        }
      }
      diagnostics.set(project.pbxprojUri, toVscodeDiagnostics(project.text, plain));
    }
    decorations.setMissing(treeProvider.collectMissingUris());
    inspector.refreshView();
    return { errors, warnings };
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("pbx.refresh", () => refreshAll()),

    vscode.commands.registerCommand("pbx.validateProject", async () => {
      const { errors, warnings } = await refreshAll();
      if (errors === 0 && warnings === 0) {
        void vscode.window.showInformationMessage("PBX: No project issues found.");
      } else {
        void vscode.window.showWarningMessage(
          `PBX: Validation found ${errors} error(s) and ${warnings} warning(s). See the Problems panel.`
        );
      }
    }),

    vscode.commands.registerCommand("pbx.openFile", async (node?: FileTreeNode | WsFileRefTreeNode) => {
      if (!node?.resolvedPath) {
        return;
      }
      if (!fs.existsSync(node.resolvedPath)) {
        void vscode.window.showWarningMessage(`File is missing on disk: ${node.resolvedPath}`);
        return;
      }
      if (fs.statSync(node.resolvedPath).isDirectory()) {
        // Folder references (.xcassets, .bundle, …) cannot open in a text
        // editor. Asset catalogs open via the Asset Catalog Viewer extension
        // when it is installed; otherwise clicking is a silent no-op.
        if (isAssetCatalogPath(node.resolvedPath)) {
          await openAssetCatalog(node.resolvedPath, { promptInstall: false });
        }
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(node.resolvedPath), { preview: true });
    }),

    vscode.commands.registerCommand(
      "pbx.openAssetCatalog",
      async (node?: FileTreeNode | WsFileRefTreeNode) => {
        if (node?.resolvedPath && fs.existsSync(node.resolvedPath)) {
          await openAssetCatalog(node.resolvedPath, { promptInstall: true });
        }
      }
    ),

    ...["pbx.revealInOS", "pbx.revealInOSWindows", "pbx.revealInOSLinux"].map((command) =>
      vscode.commands.registerCommand(command, async (node?: RevealableNode) => {
        const resolved = resolveForReveal(node);
        if (resolved) {
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(resolved));
        }
      })
    ),

    vscode.commands.registerCommand("pbx.revealInExplorer", async (node?: RevealableNode) => {
      const resolved = resolveForReveal(node);
      if (resolved) {
        await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(resolved));
      }
    }),

    vscode.commands.registerCommand("pbx.openProjectFile", async (node?: ProjectTreeNode) => {
      if (node?.project) {
        await vscode.window.showTextDocument(node.project.pbxprojUri, { preview: true });
      }
    })
  );

  // Re-parse + re-lint whenever a project/workspace file changes on disk or is saved.
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.xcodeproj/project.pbxproj");
  const wsWatcher = vscode.workspace.createFileSystemWatcher("**/*.xcworkspace/contents.xcworkspacedata");
  context.subscriptions.push(
    watcher,
    wsWatcher,
    watcher.onDidChange(() => void refreshAll()),
    watcher.onDidCreate(() => void refreshAll()),
    watcher.onDidDelete(() => void refreshAll()),
    wsWatcher.onDidChange(() => void refreshAll()),
    wsWatcher.onDidCreate(() => void refreshAll()),
    wsWatcher.onDidDelete(() => void refreshAll()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "pbxproj" || doc.fileName.endsWith(".xcworkspacedata")) {
        void refreshAll();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("xcodeProjectEditor.exclude")) {
        void refreshAll();
      }
    })
  );

  await refreshAll();
}

export function deactivate(): void {
  // Disposables are handled via context.subscriptions.
}

/** Third-party extension that renders `.xcassets` like Xcode does. */
const ASSET_CATALOG_EXTENSION_ID = "artemnovichkov.asset-catalog-viewer";
const ASSET_CATALOG_OPEN_COMMAND = "xcassetsViewer.openViewer";

function isAssetCatalogPath(fsPath: string): boolean {
  return /\.xcassets$/i.test(fsPath);
}

/**
 * Opens an asset catalog in the Asset Catalog Viewer extension when installed.
 * Without it: a no-op when triggered by a tree click (`promptInstall: false`),
 * or an install suggestion when invoked explicitly from the context menu.
 */
async function openAssetCatalog(fsPath: string, opts: { promptInstall: boolean }): Promise<void> {
  const uri = vscode.Uri.file(fsPath);
  if (vscode.extensions.getExtension(ASSET_CATALOG_EXTENSION_ID)) {
    await vscode.commands.executeCommand(ASSET_CATALOG_OPEN_COMMAND, uri);
    return;
  }
  if (!opts.promptInstall) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    "Viewing asset catalogs requires the Asset Catalog Viewer extension.",
    "Install",
    "Show Extension"
  );
  if (choice === "Install") {
    await vscode.commands.executeCommand(
      "workbench.extensions.installExtension",
      ASSET_CATALOG_EXTENSION_ID
    );
    await vscode.commands.executeCommand(ASSET_CATALOG_OPEN_COMMAND, uri);
  } else if (choice === "Show Extension") {
    await vscode.commands.executeCommand("extension.open", ASSET_CATALOG_EXTENSION_ID);
  }
}

type RevealableNode = FileTreeNode | GroupTreeNode | WsFileRefTreeNode | WsGroupTreeNode;

/** Filesystem path a reveal command should target, for both pbx and workspace nodes. */
function resolveForReveal(node: RevealableNode | undefined): string | null {
  switch (node?.kind) {
    case "file":
      return node.resolvedPath;
    case "group":
      return node.project.resolver.resolve(node.uuid);
    case "wsFileRef":
      return node.resolvedPath;
    case "wsGroup":
      return node.workspace.data.resolveItem(node.itemId, node.workspace.containerDir);
    default:
      return null;
  }
}
