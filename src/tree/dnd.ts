import * as fs from "fs";
import * as vscode from "vscode";
import { ProjectEditor } from "../edit/projectEditor";
import { EditDeps } from "../commands/edit";
import { performAdd, resolveAddFilesOptions } from "../commands/addFilesFlow";
import { PbxTreeNode } from "./nodes";

const TREE_MIME = "application/vnd.code.tree.xcodeprojectexplorer";
const URI_MIME = "text/uri-list";

interface DragPayloadItem {
  uuid: string;
  project: string;
}

/**
 * Drag & drop for the Project Navigator.
 * - Internal drops (tree → tree, same project) **move** references between groups.
 * - External drops (Explorer / desktop → tree) **add references** — matching
 *   Xcode's default "Add Reference" drop behaviour.
 */
export class PbxDragAndDropController implements vscode.TreeDragAndDropController<PbxTreeNode> {
  readonly dragMimeTypes = [TREE_MIME];
  readonly dropMimeTypes = [TREE_MIME, URI_MIME];

  constructor(private readonly deps: EditDeps) {}

  handleDrag(source: readonly PbxTreeNode[], dataTransfer: vscode.DataTransfer): void {
    const payload: DragPayloadItem[] = source
      .filter((n): n is Extract<PbxTreeNode, { kind: "group" | "file" }> => n.kind === "group" || n.kind === "file")
      .map((n) => ({ uuid: n.uuid, project: n.project.pbxprojUri.toString() }));
    if (payload.length > 0) {
      dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(payload));
    }
  }

  async handleDrop(target: PbxTreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    // Only .pbxproj nodes accept drops; workspace-level nodes do not (yet).
    if (!target || (target.kind !== "project" && target.kind !== "group" && target.kind !== "file")) {
      return;
    }
    const projectUri = target.project.pbxprojUri;
    const editor = ProjectEditor.load(projectUri.fsPath);

    let groupUuid: string | undefined;
    if (target.kind === "project") {
      groupUuid = editor.mainGroupUuid();
    } else if (target.kind === "group") {
      groupUuid = target.uuid;
    } else if (target.kind === "file") {
      groupUuid = editor.parentGroupOf(target.uuid)?.uuid ?? editor.mainGroupUuid();
    }
    if (!groupUuid) {
      return;
    }

    let changed = false;

    const internal = dataTransfer.get(TREE_MIME);
    if (internal) {
      const items = internal.value as DragPayloadItem[];
      for (const item of items) {
        if (item.project === projectUri.toString()) {
          changed = editor.move(item.uuid, groupUuid) || changed;
        }
      }
    } else {
      const external = dataTransfer.get(URI_MIME);
      if (external) {
        const raw = await external.asString();
        const paths: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) {
            continue;
          }
          let fsPath: string;
          try {
            fsPath = vscode.Uri.parse(trimmed).fsPath;
          } catch {
            continue;
          }
          if (fs.existsSync(fsPath)) {
            paths.push(fsPath);
          }
        }
        if (paths.length > 0) {
          const options = await resolveAddFilesOptions(editor, groupUuid);
          if (!options) {
            return;
          }
          const warnings = performAdd(editor, groupUuid, paths, options);
          for (const warning of warnings) {
            void vscode.window.showWarningMessage(warning);
          }
          changed = true;
        }
      }
    }

    if (changed) {
      await this.deps.saveText(projectUri, editor.serialize());
      await this.deps.refresh();
    }
  }
}
