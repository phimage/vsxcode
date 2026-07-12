import * as fs from "fs";
import * as vscode from "vscode";
import { PbxTreeNode, ProjectTreeNode, WsFileRefTreeNode, WsGroupTreeNode, WorkspaceTreeNode } from "../tree/nodes";
import { LoadedWorkspace } from "../workspace/discovery";
import { locationFor, wsItemDisplayName, XcWorkspaceData } from "../xcworkspace/workspaceData";
import { EditDeps } from "./edit";

type WsContainerNode = WorkspaceTreeNode | WsGroupTreeNode;
type WsItemNode = WsGroupTreeNode | WsFileRefTreeNode;

/** Re-parses the workspace document from disk so edits apply to fresh text. */
function loadData(workspace: LoadedWorkspace): XcWorkspaceData {
  return XcWorkspaceData.parse(fs.readFileSync(workspace.dataUri.fsPath, "utf8"));
}

/** Group id the edit targets: the group itself, or root for the workspace node. */
function targetParent(node: WsContainerNode): string | null {
  return node.kind === "wsGroup" ? node.itemId : null;
}

export function registerWorkspaceEditCommands(
  context: vscode.ExtensionContext,
  deps: EditDeps
): void {
  const persist = async (workspace: LoadedWorkspace, data: XcWorkspaceData): Promise<void> => {
    await deps.saveText(workspace.dataUri, data.serialize());
    await deps.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("pbx.openWorkspaceFile", async (node?: WorkspaceTreeNode) => {
      if (node?.workspace) {
        await vscode.window.showTextDocument(node.workspace.dataUri, { preview: true });
      }
    }),

    vscode.commands.registerCommand("pbx.wsNewGroup", async (node?: WsContainerNode) => {
      if (!node) {
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: "New group name", value: "New Group" });
      if (!name) {
        return;
      }
      const data = loadData(node.workspace);
      data.addGroup(targetParent(node), "container:", name);
      await persist(node.workspace, data);
    }),

    vscode.commands.registerCommand("pbx.wsAddFiles", async (node?: WsContainerNode) => {
      if (!node) {
        return;
      }
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: "Add to Workspace",
        defaultUri: vscode.Uri.file(node.workspace.containerDir)
      });
      if (!uris || uris.length === 0) {
        return;
      }
      const data = loadData(node.workspace);
      const parent = targetParent(node);
      const baseDir = data.baseDirFor(parent, node.workspace.containerDir);
      for (const uri of uris) {
        data.addFileRef(parent, locationFor(uri.fsPath, baseDir));
      }
      await persist(node.workspace, data);
    }),

    vscode.commands.registerCommand("pbx.wsRename", async (node?: WsGroupTreeNode) => {
      if (!node || node.kind !== "wsGroup") {
        return;
      }
      const data = loadData(node.workspace);
      const item = data.get(node.itemId);
      if (!item) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: "New group name",
        value: wsItemDisplayName(item)
      });
      if (!newName || !data.setName(node.itemId, newName)) {
        return;
      }
      await persist(node.workspace, data);
    }),

    vscode.commands.registerCommand(
      "pbx.wsRemove",
      async (node?: WsItemNode | ProjectTreeNode, selected?: PbxTreeNode[]) => {
        const nodes = (selected && selected.length > 0 ? selected : node ? [node] : []).filter(
          (n): n is WsItemNode | (ProjectTreeNode & { wsRef: NonNullable<ProjectTreeNode["wsRef"]> }) =>
            n.kind === "wsGroup" || n.kind === "wsFileRef" || (n.kind === "project" && n.wsRef !== undefined)
        );
        if (nodes.length === 0) {
          return;
        }
        const label =
          nodes.length === 1 ? displayOf(nodes[0]) : `${nodes.length} items`;
        const choice = await vscode.window.showWarningMessage(
          `Remove ${label} from the workspace? Files on disk are not touched.`,
          { modal: true },
          "Remove Reference"
        );
        if (!choice) {
          return;
        }
        // Group by workspace so multi-select across workspaces still works.
        const byWorkspace = new Map<string, { workspace: LoadedWorkspace; ids: string[] }>();
        for (const n of nodes) {
          const workspace = n.kind === "project" ? n.wsRef.workspace : n.workspace;
          const itemId = n.kind === "project" ? n.wsRef.itemId : n.itemId;
          const key = workspace.dataUri.toString();
          const bucket = byWorkspace.get(key) ?? { workspace, ids: [] };
          bucket.ids.push(itemId);
          byWorkspace.set(key, bucket);
        }
        for (const { workspace, ids } of byWorkspace.values()) {
          const data = loadData(workspace);
          let changed = false;
          for (const id of ids) {
            changed = data.remove(id) || changed;
          }
          if (changed) {
            await persist(workspace, data);
          }
        }
      }
    )
  );
}

function displayOf(node: WsItemNode | ProjectTreeNode): string {
  if (node.kind === "project") {
    return node.project.name;
  }
  const item = node.workspace.data.get(node.itemId);
  return item ? wsItemDisplayName(item) : "item";
}
