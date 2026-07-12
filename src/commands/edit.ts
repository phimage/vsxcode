import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectEditor } from "../edit/projectEditor";
import { FileTreeNode, GroupTreeNode, PbxTreeNode, ProjectTreeNode } from "../tree/nodes";
import { performAdd, resolveAddFilesOptions, resolveTargets } from "./addFilesFlow";

export interface EditDeps {
  /** Persist new pbxproj text (via WorkspaceEdit if open, else fs). */
  saveText(uri: vscode.Uri, text: string): Promise<void>;
  /** Re-scan / re-parse / re-lint. */
  refresh(): Promise<void>;
}

type EditableNode = ProjectTreeNode | GroupTreeNode | FileTreeNode;

function projectUriOf(node: EditableNode): vscode.Uri {
  return node.project.pbxprojUri;
}

/** Resolves the group a "container" action (new/add) should target. */
function targetGroup(editor: ProjectEditor, node: EditableNode): string | undefined {
  if (node.kind === "project") {
    return editor.mainGroupUuid();
  }
  if (node.kind === "group") {
    return node.uuid;
  }
  return editor.parentGroupOf(node.uuid)?.uuid ?? editor.mainGroupUuid();
}

export function registerEditCommands(context: vscode.ExtensionContext, deps: EditDeps): void {
  const persist = async (uri: vscode.Uri, editor: ProjectEditor): Promise<void> => {
    await deps.saveText(uri, editor.serialize());
    await deps.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("pbx.newGroup", async (node?: EditableNode) => {
      if (!node) {
        return;
      }
      const editor = ProjectEditor.load(projectUriOf(node).fsPath);
      const parent = targetGroup(editor, node);
      if (!parent) {
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: "New group name", value: "New Group" });
      if (!name) {
        return;
      }
      editor.addGroup(parent, name);
      await persist(projectUriOf(node), editor);
    }),

    vscode.commands.registerCommand("pbx.newFile", async (node?: EditableNode) => {
      if (!node) {
        return;
      }
      const editor = ProjectEditor.load(projectUriOf(node).fsPath);
      const parent = targetGroup(editor, node);
      if (!parent) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: "New file name",
        value: "NewFile.swift"
      });
      if (!name) {
        return;
      }
      const baseDir = editor.resolvePath(parent) ?? editor.projectRoot;
      const absPath = path.join(baseDir, name);
      if (fs.existsSync(absPath)) {
        void vscode.window.showWarningMessage(`A file already exists at ${absPath}; adding a reference to it.`);
      } else {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, "");
      }
      const added = editor.addFileReference(parent, absPath);
      for (const targetUuid of await resolveTargets(editor)) {
        editor.addToBuildPhase(added.uuid, added.name, added.category, targetUuid);
      }
      await persist(projectUriOf(node), editor);
      await vscode.window.showTextDocument(vscode.Uri.file(absPath), { preview: false });
    }),

    vscode.commands.registerCommand("pbx.addFiles", async (node?: EditableNode) => {
      if (!node) {
        return;
      }
      const editor = ProjectEditor.load(projectUriOf(node).fsPath);
      const parent = targetGroup(editor, node);
      if (!parent) {
        return;
      }
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: "Add to Project",
        defaultUri: vscode.Uri.file(editor.resolvePath(parent) ?? editor.projectRoot)
      });
      if (!uris || uris.length === 0) {
        return;
      }
      const options = await resolveAddFilesOptions(editor, parent);
      if (!options) {
        return;
      }
      const warnings = performAdd(editor, parent, uris.map((u) => u.fsPath), options);
      for (const warning of warnings) {
        void vscode.window.showWarningMessage(warning);
      }
      await persist(projectUriOf(node), editor);
    }),

    vscode.commands.registerCommand("pbx.rename", async (node?: GroupTreeNode | FileTreeNode) => {
      if (!node || !("uuid" in node)) {
        return;
      }
      const editor = ProjectEditor.load(projectUriOf(node).fsPath);
      const current = editor.displayName(node.uuid);
      const newName = await vscode.window.showInputBox({ prompt: "New name", value: current });
      if (!newName || newName === current) {
        return;
      }
      const { oldPath, newPath } = editor.rename(node.uuid, newName);
      if (oldPath && newPath && oldPath !== newPath && fs.existsSync(oldPath)) {
        try {
          await vscode.workspace.fs.rename(vscode.Uri.file(oldPath), vscode.Uri.file(newPath), {
            overwrite: false
          });
        } catch (err) {
          void vscode.window.showWarningMessage(
            `Renamed the reference, but could not rename the file on disk: ${(err as Error).message}`
          );
        }
      }
      await persist(projectUriOf(node), editor);
    }),

    vscode.commands.registerCommand(
      "pbx.remove",
      async (node?: GroupTreeNode | FileTreeNode, selected?: PbxTreeNode[]) => {
        const nodes = (selected && selected.length > 0 ? selected : node ? [node] : []).filter(
          (n): n is GroupTreeNode | FileTreeNode => n.kind === "group" || n.kind === "file"
        );
        if (nodes.length === 0) {
          return;
        }
        const label = nodes.length === 1 ? editorDisplay(nodes[0]) : `${nodes.length} items`;
        const choice = await vscode.window.showWarningMessage(
          `Remove ${label} from the project?`,
          { modal: true },
          "Remove Reference",
          "Also Move File to Trash"
        );
        if (!choice) {
          return;
        }
        const trash = choice === "Also Move File to Trash";

        // Group nodes by project so multi-select across projects still works.
        const byProject = new Map<string, { uri: vscode.Uri; nodes: (GroupTreeNode | FileTreeNode)[] }>();
        for (const n of nodes) {
          const key = projectUriOf(n).toString();
          const bucket = byProject.get(key) ?? { uri: projectUriOf(n), nodes: [] };
          bucket.nodes.push(n);
          byProject.set(key, bucket);
        }

        for (const { uri, nodes: group } of byProject.values()) {
          const editor = ProjectEditor.load(uri.fsPath);
          const toTrash: string[] = [];
          for (const n of group) {
            if (trash) {
              const p = editor.resolvePath(n.uuid);
              if (p && fs.existsSync(p)) {
                toTrash.push(p);
              }
            }
            editor.removeNode(n.uuid);
          }
          await persist(uri, editor);
          for (const p of toTrash) {
            try {
              await vscode.workspace.fs.delete(vscode.Uri.file(p), { useTrash: true, recursive: true });
            } catch (err) {
              void vscode.window.showWarningMessage(`Could not delete ${p}: ${(err as Error).message}`);
            }
          }
        }
      }
    )
  );
}

function editorDisplay(node: GroupTreeNode | FileTreeNode): string {
  const editor = ProjectEditor.load(node.project.pbxprojUri.fsPath);
  return editor.displayName(node.uuid);
}
